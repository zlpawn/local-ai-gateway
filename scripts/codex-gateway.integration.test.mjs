import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`Gateway exited before health check: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The gateway has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Gateway health check timed out.");
}

async function startGateway(t, config, extraEnv = {}) {
  const reservation = http.createServer();
  const gatewayPort = await listen(reservation);
  await closeServer(reservation);

  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-gateway-integration-"));
  const configPath = path.join(tempDir, "gateway.config.json");
  const resolvedConfig = typeof config === "function"
    ? await config(tempDir)
    : config;
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    ...resolvedConfig,
  }));

  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_NO_OPEN: "1",
      GATEWAY_PORT: String(gatewayPort),
      CLAUDE_3P_SYNC_DISABLED: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    await stopChild(gateway);
    await rm(tempDir, { recursive: true, force: true });
  });
  await waitForHealth(gatewayPort, gateway);
  return { gatewayPort, tempDir };
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(predicate(), true, message);
}

function codexRequest(port, body, signal) {
  return responsesRequest(port, "/codex/v1/responses", body, "dummy", signal);
}

function responsesRequest(port, pathname, body, apiKey, signal) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("Codex cancellation aborts the active Chat upstream request", async (t) => {
  let upstreamClosed = false;
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');
    });
    response.on("close", () => {
      upstreamClosed = true;
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const { gatewayPort } = await startGateway(t, {
    clients: {
      codex: {
        endpoints: [{
          name: "chat",
          type: "openai-chat",
          base_url: `http://127.0.0.1:${upstreamPort}/chat/completions`,
          api_key: "env:TEST_CHAT_KEY",
          models: ["chat-model"],
        }],
      },
    },
  }, { TEST_CHAT_KEY: "test" });

  const controller = new AbortController();
  const request = codexRequest(gatewayPort, {
    model: "chat-model",
    input: "Start and wait.",
    stream: true,
  }, controller.signal).then((response) => response.text());
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(request, /abort/i);

  await waitUntil(
    () => upstreamClosed,
    "client cancellation should close the configured Chat upstream",
  );
});

test("Codex cancellation destroys the active Grok Node HTTP request", async (t) => {
  let upstreamClosed = false;
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');
    });
    response.on("close", () => {
      upstreamClosed = true;
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const { gatewayPort } = await startGateway(t, async (tempDir) => {
    const authPath = path.join(tempDir, "grok-auth.json");
    await writeFile(authPath, JSON.stringify({
      "https://auth.x.ai": {
        key: "test-session",
        user_id: "test-user",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    }));
    return {
      clients: {
        codex: {
          endpoints: [{
            name: "grok",
            type: "grok",
            base_url: `http://127.0.0.1:${upstreamPort}`,
            auth_path: authPath,
            agent_id_path: path.join(tempDir, "agent-id"),
            proxy: "",
            models: ["grok-build"],
          }],
        },
      },
    };
  });

  const controller = new AbortController();
  const request = codexRequest(gatewayPort, {
    model: "grok-build",
    input: "Start and wait.",
    stream: true,
  }, controller.signal).then((response) => response.text());
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(request, /abort/i);

  await waitUntil(
    () => upstreamClosed,
    "client cancellation should close the Grok Node HTTP upstream",
  );
});

test("translated Chat stream failures emit response.failed and close without retry", async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((request, response) => {
    upstreamRequests += 1;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');
      response.end("data: {not-json}\n\n");
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const { gatewayPort } = await startGateway(t, {
    clients: {
      codex: {
        endpoints: [{
          name: "chat",
          type: "openai-chat",
          base_url: `http://127.0.0.1:${upstreamPort}/chat/completions`,
          api_key: "env:TEST_CHAT_KEY",
          models: ["chat-model"],
        }],
      },
    },
  }, { TEST_CHAT_KEY: "test" });

  const response = await codexRequest(gatewayPort, {
    model: "chat-model",
    input: "Trigger a malformed stream.",
    stream: true,
  });
  const streamText = await response.text();

  assert.equal(response.status, 200);
  assert.match(streamText, /event: response\.failed/);
  assert.match(streamText, /"code":"upstream_protocol_error"/);
  assert.doesNotMatch(streamText, /event: response\.completed/);
  assert.equal(upstreamRequests, 1);
});

test("translated Chat pre-header errors preserve upstream status and JSON", async (t) => {
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { type: "rate_limit_error", message: "slow down" },
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const { gatewayPort } = await startGateway(t, {
    clients: {
      codex: {
        endpoints: [{
          name: "chat",
          type: "openai-chat",
          base_url: `http://127.0.0.1:${upstreamPort}/chat/completions`,
          api_key: "env:TEST_CHAT_KEY",
          models: ["chat-model"],
        }],
      },
    },
  }, { TEST_CHAT_KEY: "test" });

  const response = await codexRequest(gatewayPort, {
    model: "chat-model",
    input: "Rate limit me.",
    stream: true,
  });

  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    error: { type: "rate_limit_error", message: "slow down" },
  });
});

test("non-Codex Responses preserves configured-key credential precedence", async (t) => {
  const authorizations = [];
  const upstream = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    request.resume();
    request.on("end", () => {
      if (request.headers.authorization === "Bearer client-key") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({
          error: { type: "authentication_error", message: "client key rejected" },
        }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "resp_fallback",
        object: "response",
        status: "completed",
        model: "responses-model",
        output: [],
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const { gatewayPort } = await startGateway(t, {
    clients: {
      unknown: {
        endpoints: [{
          name: "responses",
          type: "openai-responses",
          base_url: `http://127.0.0.1:${upstreamPort}/responses`,
          api_key: "env:TEST_RESPONSES_KEY",
          models: ["responses-model"],
        }],
      },
    },
  }, { TEST_RESPONSES_KEY: "configured-key" });

  const response = await responsesRequest(
    gatewayPort,
    "/v1/responses",
    { model: "responses-model", input: "Hello", stream: false },
    "client-key",
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, "resp_fallback");
  assert.deepEqual(authorizations, ["Bearer configured-key"]);
});

test("Codex Responses does not retry after an upstream authentication response", async (t) => {
  const authorizations = [];
  const upstream = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    request.resume();
    request.on("end", () => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { type: "authentication_error", message: "configured key rejected" },
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const { gatewayPort } = await startGateway(t, {
    clients: {
      codex: {
        endpoints: [{
          name: "responses",
          type: "openai-responses",
          base_url: `http://127.0.0.1:${upstreamPort}/responses`,
          api_key: "env:TEST_RESPONSES_KEY",
          models: ["responses-model"],
        }],
      },
    },
  }, { TEST_RESPONSES_KEY: "configured-key" });

  const response = await codexRequest(gatewayPort, {
    model: "responses-model",
    input: "Hello",
    stream: false,
  });

  assert.equal(response.status, 401);
  assert.deepEqual(authorizations, ["Bearer configured-key"]);
});

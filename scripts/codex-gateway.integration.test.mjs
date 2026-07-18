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

const IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const MATRIX_TOOLS = [
  {
    type: "function",
    name: "shell_command",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    type: "function",
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

function matrixRequestBody(model) {
  return {
    model,
    stream: true,
    tools: MATRIX_TOOLS,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Inspect the image and run tools." },
        { type: "input_image", image_url: IMAGE_DATA_URL },
      ],
    }],
  };
}

function writeSse(response, events) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  response.end();
}

function writeChatSse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

async function startMatrixUpstream(t, scenario) {
  let capturedRequest = null;
  const upstream = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      capturedRequest = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      };

      if (scenario.chatChunks) {
        writeChatSse(response, scenario.chatChunks);
        return;
      }

      writeSse(response, scenario.upstreamEvents || []);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  return {
    upstreamPort,
    getCapturedRequest() {
      return capturedRequest;
    },
  };
}

async function startMatrixGateway(t, {
  providerType,
  upstreamPort,
  publicModel = "public-model",
  upstreamModel = "upstream-model",
  grokAuth = false,
}) {
  const baseEndpoint = {
    name: providerType,
    type: providerType,
    models: [publicModel],
    model_mapping: { [publicModel]: upstreamModel },
    capabilities: {
      input_modalities: ["text", "image"],
      reasoning: true,
      tools: true,
    },
  };

  if (providerType === "openai-chat") {
    baseEndpoint.base_url = `http://127.0.0.1:${upstreamPort}/chat/completions`;
    baseEndpoint.api_key = "env:TEST_MATRIX_KEY";
  } else if (providerType === "openai-responses") {
    baseEndpoint.base_url = `http://127.0.0.1:${upstreamPort}/responses`;
    baseEndpoint.api_key = "env:TEST_MATRIX_KEY";
  } else if (providerType === "grok") {
    baseEndpoint.base_url = `http://127.0.0.1:${upstreamPort}`;
    baseEndpoint.proxy = "";
  }

  if (grokAuth || providerType === "grok") {
    return startGateway(t, async (tempDir) => {
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
              ...baseEndpoint,
              auth_path: authPath,
              agent_id_path: path.join(tempDir, "agent-id"),
            }],
          },
        },
      };
    });
  }

  return startGateway(t, {
    clients: {
      codex: {
        endpoints: [baseEndpoint],
      },
    },
  }, { TEST_MATRIX_KEY: "matrix-key" });
}

const providerMatrixScenarios = [
  {
    name: "native Responses preserves function events",
    providerType: "openai-responses",
    upstreamEvents: [
      ["response.created", {
        type: "response.created",
        response: { id: "resp_native", status: "in_progress" },
      }],
      ["response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "fc_native",
          type: "function_call",
          call_id: "call_native",
          name: "shell_command",
          arguments: "{\"command\":\"ls\"}",
        },
      }],
      ["response.completed", {
        type: "response.completed",
        response: {
          id: "resp_native",
          status: "completed",
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        },
      }],
    ],
    expectedPatterns: [
      /"type":"function_call"/,
      /"call_id":"call_native"/,
      /event: response\.completed/,
    ],
  },
  {
    name: "Chat preserves image input and parallel tool output",
    providerType: "openai-chat",
    chatChunks: [
      {
        choices: [{
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_0",
                function: {
                  name: "shell_command",
                  arguments: "{\"command\":\"ls\"}",
                },
              },
              {
                index: 1,
                id: "call_1",
                function: {
                  name: "read_file",
                  arguments: "{\"path\":\"README.md\"}",
                },
              },
            ],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ],
    expectedPatterns: [
      /"call_id":"call_0"/,
      /"call_id":"call_1"/,
      /event: response\.completed/,
    ],
  },
  {
    name: "Grok Responses uses the native Responses backend",
    providerType: "grok",
    grokAuth: true,
    upstreamEvents: [
      ["response.output_text.delta", {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "Grok OK",
      }],
      ["response.completed", {
        type: "response.completed",
        response: { id: "resp_grok", status: "completed" },
      }],
    ],
    expectedPatterns: [
      /Grok OK/,
      /event: response\.completed/,
    ],
  },
];

for (const scenario of providerMatrixScenarios) {
  test(`Codex provider matrix: ${scenario.name}`, async (t) => {
    const { upstreamPort, getCapturedRequest } = await startMatrixUpstream(t, scenario);
    const { gatewayPort } = await startMatrixGateway(t, {
      providerType: scenario.providerType,
      upstreamPort,
      grokAuth: scenario.grokAuth,
    });

    const response = await codexRequest(
      gatewayPort,
      matrixRequestBody("public-model"),
    );
    const responseText = await response.text();
    const capturedRequest = getCapturedRequest();

    assert.equal(response.status, 200, responseText);
    for (const pattern of scenario.expectedPatterns) {
      assert.match(responseText, pattern);
    }
    assert.equal(capturedRequest?.body?.model, "upstream-model");

    if (scenario.providerType === "openai-chat") {
      assert.equal(
        capturedRequest.body.messages[0].content.some(
          (part) => part.type === "image_url",
        ),
        true,
      );
      assert.equal(
        capturedRequest.body.messages[0].content.some(
          (part) => part.type === "text" && String(part.text).includes("Inspect the image"),
        ),
        true,
      );
      assert.equal(Array.isArray(capturedRequest.body.tools), true);
      assert.equal(capturedRequest.body.tools.length >= 2, true);
    }
  });
}

test("Codex Chat non-streaming preserves reasoning, tools, and usage", async (t) => {
  let capturedBody = null;
  const upstream = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      capturedBody = JSON.parse(raw);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl_matrix",
        object: "chat.completion",
        model: capturedBody.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "done",
            reasoning_content: "checking files",
            tool_calls: [{
              id: "call_shell",
              type: "function",
              function: {
                name: "shell_command",
                arguments: "{\"command\":\"ls\"}",
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
        },
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const { gatewayPort } = await startMatrixGateway(t, {
    providerType: "openai-chat",
    upstreamPort,
    publicModel: "chat-public",
    upstreamModel: "chat-upstream",
  });

  const response = await codexRequest(gatewayPort, {
    model: "chat-public",
    stream: false,
    tools: MATRIX_TOOLS,
    input: "List files.",
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(capturedBody.model, "chat-upstream");
  assert.equal(payload.status, "completed");
  assert.equal(
    payload.output.some((item) => item.type === "reasoning"),
    true,
  );
  assert.equal(
    payload.output.some((item) => (
      item.type === "function_call" && item.call_id === "call_shell"
    )),
    true,
  );
  assert.equal(payload.usage?.input_tokens, 11);
  assert.equal(payload.usage?.output_tokens, 7);
  assert.equal(payload.usage?.total_tokens, 18);
});

test("Codex Grok Chat non-streaming preserves reasoning and tools from forced SSE", async (t) => {
  let capturedBody = null;
  const upstream = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      capturedBody = JSON.parse(raw);
      // Grok proxy always forces stream:true and returns Chat Completions SSE.
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunks = [
        {
          id: "chatcmpl_grok_chat",
          created: 1_700_000_000,
          model: "upstream-model",
          choices: [{
            index: 0,
            delta: { reasoning_content: "checking files" },
          }],
        },
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_shell",
                type: "function",
                function: { name: "shell_command", arguments: "{\"command\":" },
              }],
            },
          }],
        },
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: "\"ls\"}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: {
            prompt_tokens: 9,
            completion_tokens: 4,
            total_tokens: 13,
          },
        },
      ];
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
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
            name: "grok-chat",
            type: "grok",
            base_url: `http://127.0.0.1:${upstreamPort}`,
            auth_path: authPath,
            agent_id_path: path.join(tempDir, "agent-id"),
            proxy: "",
            // Public ID is independent; upstream ID must remain a known chat backend
            // so grokBackendFor() selects /chat/completions.
            models: ["public-grok-chat"],
            model_mapping: { "public-grok-chat": "grok-build" },
            capabilities: {
              input_modalities: ["text", "image"],
              reasoning: true,
              tools: true,
            },
          }],
        },
      },
    };
  });

  const response = await codexRequest(gatewayPort, {
    model: "public-grok-chat",
    stream: false,
    tools: MATRIX_TOOLS,
    input: "List files.",
  });
  const payload = await response.json();

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(capturedBody?.stream, true);
  assert.equal(capturedBody?.model, "grok-build");
  assert.equal(payload.status, "completed");
  assert.equal(
    payload.output.some((item) => item.type === "reasoning"),
    true,
  );
  assert.equal(
    payload.output.some((item) => (
      item.type === "function_call"
      && item.call_id === "call_shell"
      && item.arguments === "{\"command\":\"ls\"}"
    )),
    true,
  );
  assert.equal(payload.usage?.input_tokens, 9);
  assert.equal(payload.usage?.output_tokens, 4);
  assert.equal(payload.usage?.total_tokens, 13);
});

const failureCases = [
  { status: 401, expectedType: "authentication_error", message: "bad key" },
  { status: 429, expectedType: "rate_limit_error", message: "slow down" },
  { status: 500, expectedType: "upstream_error", message: "boom" },
];

for (const failureCase of failureCases) {
  test(`Codex Chat pre-header ${failureCase.status} preserves upstream JSON`, async (t) => {
    const upstream = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(failureCase.status, { "content-type": "application/json" });
        response.end(JSON.stringify({
          error: {
            type: failureCase.expectedType,
            message: failureCase.message,
          },
        }));
      });
    });
    const upstreamPort = await listen(upstream);
    t.after(() => closeServer(upstream));

    const { gatewayPort } = await startMatrixGateway(t, {
      providerType: "openai-chat",
      upstreamPort,
      publicModel: "chat-public",
      upstreamModel: "chat-upstream",
    });

    const response = await codexRequest(gatewayPort, {
      model: "chat-public",
      input: "Fail me.",
      stream: true,
    });

    assert.equal(response.status, failureCase.status);
    assert.deepEqual(await response.json(), {
      error: {
        type: failureCase.expectedType,
        message: failureCase.message,
      },
    });
  });
}

test("translated Chat premature SSE close ends with response.failed", async (t) => {
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      response.end();
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const { gatewayPort } = await startMatrixGateway(t, {
    providerType: "openai-chat",
    upstreamPort,
    publicModel: "chat-public",
    upstreamModel: "chat-upstream",
  });

  const response = await codexRequest(gatewayPort, {
    model: "chat-public",
    input: "Close early.",
    stream: true,
  });
  const streamText = await response.text();

  assert.equal(response.status, 200);
  assert.match(streamText, /event: response\.failed/);
  assert.doesNotMatch(streamText, /event: response\.completed/);
});

test("native Responses premature SSE close synthesizes response.failed", async (t) => {
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_native_cut","status":"in_progress"}}\n\n',
      );
      response.write(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      );
      response.end();
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const { gatewayPort } = await startMatrixGateway(t, {
    providerType: "openai-responses",
    upstreamPort,
    publicModel: "responses-public",
    upstreamModel: "responses-upstream",
  });

  const response = await codexRequest(gatewayPort, {
    model: "responses-public",
    input: "Close early.",
    stream: true,
  });
  const streamText = await response.text();

  assert.equal(response.status, 200);
  assert.match(streamText, /event: response\.created/);
  assert.match(streamText, /event: response\.failed/);
  assert.match(streamText, /"code":"upstream_stream_closed"/);
  assert.match(streamText, /"id":"resp_native_cut"/);
  assert.doesNotMatch(streamText, /event: response\.completed/);
});

test("Grok Responses premature SSE close synthesizes response.failed", async (t) => {
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_grok_cut","status":"in_progress"}}\n\n',
      );
      response.end();
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const { gatewayPort } = await startMatrixGateway(t, {
    providerType: "grok",
    upstreamPort,
    publicModel: "grok-4.5",
    upstreamModel: "grok-4.5",
    grokAuth: true,
  });

  const response = await codexRequest(gatewayPort, {
    model: "grok-4.5",
    input: "Close early.",
    stream: true,
  });
  const streamText = await response.text();

  assert.equal(response.status, 200);
  assert.match(streamText, /event: response\.failed/);
  assert.match(streamText, /"code":"upstream_stream_closed"/);
  assert.doesNotMatch(streamText, /event: response\.completed/);
});

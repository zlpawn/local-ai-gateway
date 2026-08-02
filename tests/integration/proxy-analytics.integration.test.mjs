import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("proxy configuration is persisted, used by outbound requests, and usage is queryable", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gateway-proxy-analytics-"));
  const gatewayPort = await reservePort();
  let proxyConnects = 0;

  const proxy = http.createServer();
  proxy.on("connect", (_request, socket) => {
    proxyConnects += 1;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () => {
      socket.end(
        "HTTP/1.1 200 OK\r\n"
        + "Content-Type: application/json\r\n"
        + "Connection: close\r\n"
        + "\r\n"
        + JSON.stringify({
          id: "chatcmpl_proxy",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "via proxy" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        }),
      );
    });
  });
  const proxyPort = await listen(proxy);

  const configPath = path.join(tempDir, "gateway.config.json");
  const secretsPath = path.join(tempDir, "gateway.secrets.json");
  await writeFile(configPath, JSON.stringify({
    server: {
      host: "127.0.0.1",
      port: gatewayPort,
      proxy: {
        enabled: true,
        protocol: "http",
        host: "127.0.0.1",
        port: proxyPort,
        username: "",
        password: "",
      },
    },
    clients: {
      codex: {
        endpoints: [{
          id: "ep_proxy_chat",
          name: "proxy-chat",
          type: "openai-chat",
          base_url: "http://proxy-target.invalid/v1",
          models: ["proxy-model"],
          model_mapping: {},
        }],
      },
    },
  }));
  await writeFile(secretsPath, JSON.stringify({ api_keys: { ep_proxy_chat: "test-key" } }));

  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_SECRETS_FILE: secretsPath,
      GATEWAY_NO_OPEN: "1",
      CLAUDE_3P_SYNC_DISABLED: "1",
      CLAUDE_CODE_SYNC_DISABLED: "1",
      CODEX_WRITE_MODEL_CATALOG_DISABLED: "1",
      LOG_FILE: path.join(tempDir, "gateway.log"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  t.after(async () => {
    gateway.kill();
    await once(gateway, "exit").catch(() => {});
    await closeServer(proxy);
    await rm(tempDir, { recursive: true, force: true });
  });
  await waitForHealth(gateway, gatewayPort);

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/codex/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer client-key", "content-type": "application/json" },
    body: JSON.stringify({
      model: "proxy-model",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(proxyConnects, 1);

  const usage = await fetch(
    `http://127.0.0.1:${gatewayPort}/v1/analytics/token-usage?range=1h&granularity=minute`,
  ).then((result) => result.json());
  assert.equal(usage.summary.total_requests, 1);
  assert.equal(usage.summary.total_tokens, 13);
  assert.equal(usage.purpose_breakdown[0].purpose, "chat");

  const invalidTest = await fetch(`http://127.0.0.1:${gatewayPort}/v1/config/proxy/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      proxy: { enabled: true, protocol: "http", host: "127.0.0.1", port: 1 },
    }),
  }).then((result) => result.json());
  assert.equal(invalidTest.success, false);

  const saveResult = await fetch(`http://127.0.0.1:${gatewayPort}/v1/config/proxy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      protocol: "http",
      host: "127.0.0.1",
      port: 7897,
      username: "",
      password: "",
    }),
  }).then((result) => result.json());
  assert.equal(saveResult.success, true);
  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.server.proxy.port, 7897);
});

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function waitForHealth(child, port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`gateway exited before health check (${child.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("gateway health check timed out");
}

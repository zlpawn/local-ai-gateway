import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");

async function waitForGateway(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`gateway on port ${port} did not become healthy within ${timeoutMs}ms`);
}

async function freePort() {
  const probe = http.createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const p = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return p;
}

async function startGateway(t, { clients, secrets = { api_keys: {} }, upstreamHandler }) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gw-deeptutor-emb-"));
  const upstream = http.createServer(upstreamHandler);
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const gatewayPort = await freePort();

  const configPath = path.join(tempDir, "gateway.config.json");
  const secretsPath = path.join(tempDir, "gateway.secrets.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients,
  }));
  await writeFile(secretsPath, JSON.stringify(secrets));

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
    await new Promise((resolve) => upstream.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  await once(gateway, "spawn");
  await waitForGateway(gatewayPort);
  return { gatewayPort, upstreamPort };
}

test("DeepTutor LLM and emb model lists are separated", async (t) => {
  const { gatewayPort } = await startGateway(t, {
    clients: {
      deeptutor: {
        endpoints: [
          {
            id: "ep_chat",
            name: "chat-node",
            type: "openai-chat",
            base_url: "http://127.0.0.1:9/v1",
            models: ["claude-opus-5"],
            model_mapping: {},
          },
          {
            id: "ep_emb",
            name: "emb-node",
            purpose: "embedding",
            type: "openai-chat",
            base_url: "http://127.0.0.1:9/v1",
            enabled: true,
            is_default: true,
            models: ["text-embedding-3-large"],
            embedding_model: "text-embedding-3-large",
            model_mapping: {},
          },
        ],
      },
    },
    upstreamHandler: (_req, res) => {
      res.writeHead(404);
      res.end("unused");
    },
  });

  const llm = await fetch(`http://127.0.0.1:${gatewayPort}/deeptutor/models`);
  const llmJson = await llm.json();
  assert.equal(llm.status, 200);
  assert.deepEqual(llmJson.data.map((m) => m.id), ["claude-opus-5"]);

  const emb = await fetch(`http://127.0.0.1:${gatewayPort}/deeptutor/emb/models`);
  const embJson = await emb.json();
  assert.equal(emb.status, 200);
  assert.deepEqual(embJson.data.map((m) => m.id), ["text-embedding-3-large"]);

  const embV1 = await fetch(`http://127.0.0.1:${gatewayPort}/deeptutor/emb/v1/models`);
  assert.equal(embV1.status, 200);
});

test("DeepTutor emb base URL serves embeddings and rejects chat; chat ignores emb defaults", async (t) => {
  let hitPath = null;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gw-deeptutor-emb2-"));
  const upstream = http.createServer((req, res) => {
    hitPath = req.url;
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      const body = JSON.parse(data || "{}");
      if (req.url?.includes("/embeddings")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
          model: body.model,
          usage: { prompt_tokens: 2, total_tokens: 2 },
        }));
        return;
      }
      if (req.url?.includes("/chat/completions")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion",
          model: body.model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          }],
        }));
        return;
      }
      res.writeHead(404);
      res.end("unexpected");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const gatewayPort = await freePort();
  const configPath = path.join(tempDir, "gateway.config.json");
  const secretsPath = path.join(tempDir, "gateway.secrets.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients: {
      deeptutor: {
        endpoints: [
          {
            id: "ep_emb",
            name: "emb-node",
            purpose: "embedding",
            type: "openai-chat",
            base_url: `http://127.0.0.1:${upstreamPort}/v1`,
            enabled: true,
            is_default: true,
            models: ["text-embedding-3-large"],
            embedding_model: "text-embedding-3-large",
            model_mapping: {},
          },
          {
            id: "ep_chat",
            name: "chat-node",
            type: "openai-chat",
            base_url: `http://127.0.0.1:${upstreamPort}/v1`,
            is_default: true,
            models: ["claude-opus-5"],
            model_mapping: {},
          },
        ],
      },
    },
  }));
  await writeFile(secretsPath, JSON.stringify({
    api_keys: {
      ep_emb: "emb-key",
      ep_chat: "chat-key",
    },
  }));

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
    await new Promise((resolve) => upstream.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  await once(gateway, "spawn");
  await waitForGateway(gatewayPort);

  const embRes = await fetch(`http://127.0.0.1:${gatewayPort}/deeptutor/emb/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "hello", model: "text-embedding-3-large" }),
  });
  const embJson = await embRes.json();
  assert.equal(embRes.status, 200);
  assert.deepEqual(embJson.data[0].embedding, [0.1, 0.2, 0.3]);
  assert.match(String(hitPath || ""), /\/embeddings$/);

  const chatOnEmb = await fetch(`http://127.0.0.1:${gatewayPort}/deeptutor/emb/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(chatOnEmb.status, 404);

  hitPath = null;
  const chatRes = await fetch(`http://127.0.0.1:${gatewayPort}/deeptutor/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const chatJson = await chatRes.json();
  assert.equal(chatRes.status, 200, JSON.stringify(chatJson));
  assert.equal(chatJson.choices[0].message.content, "ok");
  assert.match(String(hitPath || ""), /\/chat\/completions$/);
});

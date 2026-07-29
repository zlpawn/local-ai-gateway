import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("selectDefaultEmbeddingEndpoint fallback and forwarding logic", async () => {
  // Start a mock upstream embedding server
  let receivedBody = null;
  let receivedAuth = null;
  const upstreamServer = http.createServer((req, res) => {
    receivedAuth = req.headers["authorization"];
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      receivedBody = JSON.parse(data || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
        model: receivedBody.model,
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }));
    });
  });

  await new Promise((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
  const port = upstreamServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  try {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify({
        input: "hello world",
        model: "text-embedding-3-small",
      }),
    });

    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.object, "list");
    assert.deepEqual(json.data[0].embedding, [0.1, 0.2, 0.3]);
    assert.equal(receivedAuth, "Bearer test-key");
    assert.equal(receivedBody.model, "text-embedding-3-small");
    assert.equal(receivedBody.input, "hello world");
  } finally {
    await new Promise((resolve) => upstreamServer.close(resolve));
  }
});

// 等待 gateway 监听就绪:轮询 /health 直到 200 或超时
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

test("endpoint_id query param selects the matching embedding endpoint by id", async (t) => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gw-embed-id-"));

  // mock 上游:按请求的 model 区分返回不同向量,用以区分命中了哪个节点
  // (base_url 拼接会给路径加 /v1/embeddings,故不依赖 URL 路径区分)
  const upstream = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      const body = JSON.parse(data || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      // text-embedding-3-large (ep_TARGET) -> [0.4,0.5,0.6];其它 -> [0.1,0.2,0.3]
      const vec = body.model === "text-embedding-3-large" ? [0.4, 0.5, 0.6] : [0.1, 0.2, 0.3];
      res.end(JSON.stringify({
        object: "list",
        data: [{ object: "embedding", embedding: vec, index: 0 }],
        model: body.model,
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  const gatewayPort = await freePort();

  const configPath = path.join(tempDir, "gateway.config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients: {
      codex: {
        endpoints: [
          {
            id: "ep_DEFAULT",
            name: "default-node",
            purpose: "embedding",
            type: "openai-chat",
            base_url: "http://127.0.0.1:" + upstreamPort + "/v1",
            enabled: true,
            is_default: true,
            models: ["text-embedding-3-small"],
            model_mapping: {},
            embedding_model: "text-embedding-3-small",
            dimensions: 256
          },
          {
            id: "ep_TARGET",
            name: "target-node",
            purpose: "embedding",
            type: "openai-chat",
            base_url: "http://127.0.0.1:" + upstreamPort + "/v1",
            enabled: true,
            is_default: false,
            models: ["text-embedding-3-large"],
            model_mapping: {},
            embedding_model: "text-embedding-3-large",
            dimensions: 1024
          }
        ]
      }
    }
  }));
  await writeFile(path.join(tempDir, "gateway.secrets.json"), JSON.stringify({ api_keys: {} }));

  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_SECRETS_FILE: path.join(tempDir, "gateway.secrets.json"),
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

  const res = await fetch("http://127.0.0.1:" + gatewayPort + "/v1/embeddings?endpoint_id=ep_TARGET", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Client": "codex",
    },
    body: JSON.stringify({
      input: "hello",
      model: "text-embedding-3-large",
    }),
  });

  const json = await res.json();
  assert.equal(res.status, 200);
  // 命中 ep_TARGET -> 上游 /target/embeddings -> [0.4, 0.5, 0.6]
  assert.deepEqual(json.data[0].embedding, [0.4, 0.5, 0.6]);
});

test("endpoint_id not matching returns 404 without cross-client fallback", async (t) => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gw-embed-404-"));

  const upstream = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [{ object: "embedding", embedding: [0.9, 0.9, 0.9], index: 0 }],
        model: "m",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  const gatewayPort = await freePort();

  const configPath = path.join(tempDir, "gateway.config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients: {
      codex: {
        endpoints: [{
          id: "ep_A", name: "codex-emb", purpose: "embedding", type: "openai-chat",
          base_url: "http://127.0.0.1:" + upstreamPort + "/codex",
          enabled: true, is_default: true, models: ["m"], model_mapping: {}, embedding_model: "m"
        }]
      },
      desktop: {
        endpoints: [{
          id: "ep_DESKTOP", name: "desktop-emb", purpose: "embedding", type: "openai-chat",
          base_url: "http://127.0.0.1:" + upstreamPort + "/desktop",
          enabled: true, is_default: true, models: ["m2"], model_mapping: {}, embedding_model: "m2"
        }]
      }
    }
  }));
  await writeFile(path.join(tempDir, "gateway.secrets.json"), JSON.stringify({ api_keys: {} }));

  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_SECRETS_FILE: path.join(tempDir, "gateway.secrets.json"),
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

  const res = await fetch("http://127.0.0.1:" + gatewayPort + "/v1/embeddings?endpoint_id=ep_MISSING", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gateway-Client": "codex" },
    body: JSON.stringify({ input: "hello", model: "m" }),
  });

  const json = await res.json();
  assert.equal(res.status, 404);
  assert.match(json.error.message, /ep_MISSING/);
});


test("selects embedding endpoint by requested model instead of always using default", async (t) => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gw-embed-model-"));

  const upstream = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      const body = JSON.parse(data || "{}");
      const isTarget = req.url?.includes("/target/");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [{ object: "embedding", embedding: isTarget ? [0.4, 0.5, 0.6] : [0.1, 0.2, 0.3], index: 0 }],
        model: body.model,
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const gatewayPort = await freePort();
  const configPath = path.join(tempDir, "gateway.config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients: {
      deeptutor: {
        endpoints: [
          {
            id: "ep_default",
            name: "default-emb",
            purpose: "embedding",
            type: "openai-chat",
            base_url: "http://127.0.0.1:" + upstreamPort + "/default/v1",
            enabled: true,
            is_default: true,
            models: ["text-embedding-3-small"],
            embedding_model: "text-embedding-3-small",
            model_mapping: {},
          },
          {
            id: "ep_target",
            name: "target-emb",
            purpose: "embedding",
            type: "openai-chat",
            base_url: "http://127.0.0.1:" + upstreamPort + "/target/v1",
            enabled: true,
            is_default: false,
            models: ["text-embedding-3-large"],
            embedding_model: "text-embedding-3-large",
            model_mapping: {},
          },
        ],
      },
    },
  }));
  await writeFile(path.join(tempDir, "gateway.secrets.json"), JSON.stringify({ api_keys: { ep_default: "k1", ep_target: "k2" } }));

  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_SECRETS_FILE: path.join(tempDir, "gateway.secrets.json"),
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

  const res = await fetch("http://127.0.0.1:" + gatewayPort + "/deeptutor/emb", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "hello", model: "text-embedding-3-large" }),
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.deepEqual(json.data[0].embedding, [0.4, 0.5, 0.6]);
});

test("versioned embedding base_url appends /embeddings not /v1/embeddings", async (t) => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gw-embed-v3-"));
  let hitUrl = null;
  const upstream = http.createServer((req, res) => {
    hitUrl = req.url;
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [{ object: "embedding", embedding: [1, 2, 3], index: 0 }],
        model: "doubao-embedding-vision",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const gatewayPort = await freePort();
  const configPath = path.join(tempDir, "gateway.config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients: {
      deeptutor: {
        endpoints: [{
          id: "ep_v3",
          name: "volc",
          purpose: "embedding",
          type: "openai-chat",
          base_url: "http://127.0.0.1:" + upstreamPort + "/api/plan/v3",
          enabled: true,
          is_default: true,
          models: ["doubao-embedding-vision"],
          embedding_model: "doubao-embedding-vision",
          model_mapping: {},
        }],
      },
    },
  }));
  await writeFile(path.join(tempDir, "gateway.secrets.json"), JSON.stringify({ api_keys: { ep_v3: "k" } }));
  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_SECRETS_FILE: path.join(tempDir, "gateway.secrets.json"),
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
  const res = await fetch("http://127.0.0.1:" + gatewayPort + "/deeptutor/emb", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "hello", model: "doubao-embedding-vision" }),
  });
  assert.equal(res.status, 200);
  assert.equal(hitUrl, "/api/plan/v3/embeddings");
});

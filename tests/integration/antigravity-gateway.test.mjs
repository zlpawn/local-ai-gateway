import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");

import { encodeGenerateContentResponse } from "../../lib/antigravity/proto-codec.mjs";

// ── Mock upstream helpers ──

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => {
    server.close((err) => err ? resolve() : resolve());
    server.closeAllConnections?.();
  });
}

// Mock REST server for loadCodeAssist.
function createMockRestServer(project = "test-project-42") {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cloudaicompanionProject: project }));
    });
  });
}

// Build a canned gRPC response: one GenerateContentResponse frame with text.
function makeGrpcResponse(text, opts = {}) {
  const payload = {
    response: {
      candidates: [{
        content: { role: "model", parts: [{ text }] },
        ...(opts.finishReason ? { finishReason: opts.finishReason } : {}),
      }],
      ...(opts.usageMetadata ? { usageMetadata: opts.usageMetadata } : {}),
    },
  };
  const buf = encodeGenerateContentResponse(payload);
  const frame = Buffer.alloc(5);
  frame.writeUInt32BE(buf.length, 1);
  return Buffer.concat([frame, buf]);
}

// Build a gRPC error frame (no data, trailers with grpc-status != 0).
function makeGrpcError(statusCode, message) {
  return { statusCode, message };
}

// Mock gRPC server (plain HTTP/2, no TLS).
function createMockGrpcServer(responder) {
  return http2.createServer((req, res) => {
    // Read the request body (gRPC frame)
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const result = responder(req.url);
      if (result && result.statusCode !== undefined) {
        // Error response
        res.writeHead(200, {
          "content-type": "application/grpc",
          "grpc-status": String(result.statusCode),
          "grpc-message": encodeURIComponent(result.message || "error"),
        });
        res.end();
        return;
      }
      // Success response
      const frame = result || makeGrpcResponse("mock response", { finishReason: "STOP" });
      res.writeHead(200, { "content-type": "application/grpc" });
      res.write(frame);
      res.end(); // ends with trailers: grpc-status: 0 (default)
    });
  });
}

// ── Gateway lifecycle helpers (mirrors codex-gateway.test.mjs) ──

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Gateway exited: ${child.exitCode}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Gateway health check timed out.");
}

async function waitForLogEvent(logPath, event, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const entries = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const match = entries.find((entry) => entry.event === event);
      if (match) return match;
    } catch {
      // The async logger may not have created or flushed the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for log event: ${event}`);
}

async function startGateway(t, { grpcPort, restPort, tempDir }) {
  // Reserve a port for the gateway
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const gatewayPort = reservation.address().port;
  await closeServer(reservation);

  // Write config with an antigravity endpoint
  const configPath = path.join(tempDir, "gateway.config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients: {
      codex: {
        endpoints: [{
          id: "ep_antigravity",
          name: "Antigravity",
          type: "antigravity",
          models: ["gemini-pro-agent", "gemini-3-flash"],
          model_mapping: {},
          capabilities: { input_modalities: ["text"], reasoning: true, tools: true },
        }],
      },
    },
  }));

  // Write fake antigravity secrets (long-expiry token, no refresh needed)
  const secretsPath = path.join(tempDir, "antigravity.secrets.json");
  const logPath = path.join(tempDir, "gateway.log");
  await writeFile(secretsPath, JSON.stringify({
    client_id: "test-client-id",
    client_secret: "test-client-secret",
    access_token: "fake-access-token",
    refresh_token: "fake-refresh-token",
    expires_at: Math.floor(Date.now() / 1000) + 999999,
    account_id: "test@example.com",
  }));

  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_NO_OPEN: "1",
      CLAUDE_3P_SYNC_DISABLED: "1",
      LOG_FILE: logPath,
      // Point antigravity at mock servers
      ANTIGRAVITY_GRPC_HOST: "127.0.0.1",
      ANTIGRAVITY_GRPC_PORT: String(grpcPort),
      ANTIGRAVITY_GRPC_INSECURE: "1",
      ANTIGRAVITY_REST_BASE_URL: `http://127.0.0.1:${restPort}/v1internal`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    await stopChild(child);
  });

  await waitForHealth(gatewayPort, child);
  return { gatewayPort, child, logPath };
}

// ── Tests ──

test("non-streaming /v1/responses routes through antigravity gRPC", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "antigravity-int-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const restServer = createMockRestServer("proj-mock");
  const restPort = await listen(restServer);
  t.after(() => closeServer(restServer));

  const grpcServer = createMockGrpcServer(() =>
    makeGrpcResponse("Hello from mock!", { finishReason: "STOP", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }),
  );
  const grpcPort = await listen(grpcServer);
  t.after(() => closeServer(grpcServer));

  const { gatewayPort, logPath } = await startGateway(t, { grpcPort, restPort, tempDir });

  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer dummy",
      "x-gateway-client": "codex",
    },
    body: JSON.stringify({
      model: "gemini-pro-agent",
      stream: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Say hi" }] }],
      instructions: "Be concise.",
    }),
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "completed");
  assert.equal(data.model, "gemini-pro-agent");
  assert.equal(data.output_text, "Hello from mock!");
  assert.equal(data.usage.input_tokens, 10);
  assert.equal(data.usage.output_tokens, 5);
});

test("streaming /v1/responses routes through antigravity gRPC", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "antigravity-int-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const restServer = createMockRestServer();
  const restPort = await listen(restServer);
  t.after(() => closeServer(restServer));

  const grpcServer = createMockGrpcServer(() =>
    makeGrpcResponse("Streaming mock!", { finishReason: "STOP" }),
  );
  const grpcPort = await listen(grpcServer);
  t.after(() => closeServer(grpcServer));

  const { gatewayPort, logPath } = await startGateway(t, { grpcPort, restPort, tempDir });

  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer dummy",
      "x-gateway-client": "codex",
    },
    body: JSON.stringify({
      model: "gemini-3-flash",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Say hi" }] }],
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");

  const text = await res.text();
  assert.ok(text.includes("response.created"));
  assert.ok(text.includes("response.output_text.delta"));
  assert.ok(text.includes("Streaming mock!"));
  assert.ok(text.includes("response.completed"));

  const logEntry = await waitForLogEvent(logPath, "antigravity_stream_complete");
  assert.equal(logEntry.status, 200);
  assert.equal(logEntry.model, "gemini-3-flash");
  assert.equal(logEntry.client, "codex");
});

test("gRPC upstream error returns 502", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "antigravity-int-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const restServer = createMockRestServer();
  const restPort = await listen(restServer);
  t.after(() => closeServer(restServer));

  const grpcServer = createMockGrpcServer(() => makeGrpcError(13, "INTERNAL"));
  const grpcPort = await listen(grpcServer);
  t.after(() => closeServer(grpcServer));

  const { gatewayPort } = await startGateway(t, { grpcPort, restPort, tempDir });

  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer dummy",
      "x-gateway-client": "codex",
    },
    body: JSON.stringify({
      model: "gemini-pro-agent",
      stream: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Say hi" }] }],
    }),
  });

  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.error.type, "antigravity_error");
});

test("streaming gRPC upstream error emits a failed event and failure log", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "antigravity-int-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const restServer = createMockRestServer();
  const restPort = await listen(restServer);
  t.after(() => closeServer(restServer));

  const grpcServer = createMockGrpcServer(() => makeGrpcError(13, "INTERNAL"));
  const grpcPort = await listen(grpcServer);
  t.after(() => closeServer(grpcServer));

  const { gatewayPort, logPath } = await startGateway(t, { grpcPort, restPort, tempDir });

  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer dummy",
      "x-gateway-client": "codex",
    },
    body: JSON.stringify({
      model: "gemini-3-flash",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Say hi" }] }],
    }),
  });

  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes("response.failed"));
  assert.ok(text.includes("gRPC error: status=13 message=INTERNAL"));

  const logEntry = await waitForLogEvent(logPath, "antigravity_stream_failed");
  assert.equal(logEntry.level, "error");
  assert.equal(logEntry.client, "codex");
  assert.match(logEntry.message, /gRPC error: status=13 message=INTERNAL/);
});

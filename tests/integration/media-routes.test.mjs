import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const GATEWAY_PORT = 8788;

test("media routes return a specific 404 when the selected client has no media endpoint", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gateway-media-routes-"));
  const configPath = path.join(tempDir, "gateway.config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: GATEWAY_PORT },
    clients: { codex: { endpoints: [] } },
  }));
  await writeFile(path.join(tempDir, "gateway.secrets.json"), JSON.stringify({ api_keys: {} }));

  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: testGatewayEnv(tempDir, configPath),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    gateway.kill();
    await once(gateway, "exit").catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  });
  await waitForHealth(gateway);

  const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/media/image`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gateway-client": "codex" },
    body: JSON.stringify({ prompt: "A test image" }),
  });
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.type, "media_endpoint_not_found");
});

test("Codex media routes never use the caller bearer token as subscription credentials", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gateway-media-codex-auth-"));
  const configPath = path.join(tempDir, "gateway.config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: GATEWAY_PORT },
    clients: {
      codex: {
        endpoints: [{
          id: "codex-image",
          name: "Codex image",
          purpose: "image_generation",
          provider: "codex-subscription",
        }],
      },
    },
  }));
  await writeFile(path.join(tempDir, "gateway.secrets.json"), JSON.stringify({ api_keys: {} }));

  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: testGatewayEnv(tempDir, configPath, { CODEX_HOME: path.join(tempDir, "missing-codex-auth") }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    gateway.kill();
    await once(gateway, "exit").catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  });
  await waitForHealth(gateway);

  const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/media/image`, {
    method: "POST",
    headers: {
      authorization: "Bearer local-gateway-secret",
      "content-type": "application/json",
      "x-gateway-client": "codex",
    },
    body: JSON.stringify({ prompt: "A test image" }),
  });
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.error.message, /Codex subscription auth not found/);
  assert.doesNotMatch(body.error.message, /local-gateway-secret/);
});

test("failed media generation is recorded in history without changing the error response", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gateway-media-failure-history-"));
  const configPath = path.join(tempDir, "gateway.config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: GATEWAY_PORT },
    clients: {
      codex: {
        endpoints: [{
          id: "grok-image",
          name: "Grok image",
          purpose: "image_generation",
          provider: "grok-subscription",
        }, {
          id: "grok-video",
          name: "Grok video",
          purpose: "video_generation",
          provider: "grok-subscription",
        }, {
          id: "huoshan-tts",
          name: "Huoshan TTS",
          purpose: "audio_tts",
          provider: "huoshan-agentplan",
        }],
      },
    },
  }));
  await writeFile(path.join(tempDir, "gateway.secrets.json"), JSON.stringify({ api_keys: {} }));

  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: testGatewayEnv(tempDir, configPath, { GROK_AUTH_PATH: path.join(tempDir, "missing-grok-auth.json") }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    gateway.kill();
    await once(gateway, "exit").catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  });
  await waitForHealth(gateway);

  const failed = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/media/image`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gateway-client": "codex" },
    body: JSON.stringify({ prompt: "A failed image" }),
  });
  const failedBody = await failed.json();
  const failedVideo = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/media/video`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gateway-client": "codex" },
    body: JSON.stringify({ prompt: "A failed video" }),
  });
  const failedVideoBody = await failedVideo.json();
  const failedTts = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/media/tts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gateway-client": "codex" },
    body: JSON.stringify({ text: "A failed TTS request" }),
  });
  const failedTtsBody = await failedTts.json();
  const history = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/media/history?media_type=image`, {
    headers: { "x-gateway-client": "codex" },
  }).then((response) => response.json());
  const videoHistory = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/media/history?media_type=video`, {
    headers: { "x-gateway-client": "codex" },
  }).then((response) => response.json());
  const ttsHistory = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/media/history?media_type=tts`, {
    headers: { "x-gateway-client": "codex" },
  }).then((response) => response.json());

  assert.equal(failed.status, 500);
  assert.match(failedBody.error.message, /Grok auth not found/);
  assert.equal(failedVideo.status, 500);
  assert.match(failedVideoBody.error.message, /Grok auth not found/);
  assert.equal(failedTts.status, 500);
  assert.match(failedTtsBody.error.message, /Huoshan API Key not found/);
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].status, "failed");
  assert.match(history.entries[0].error, /Grok auth not found/);
  assert.equal(videoHistory.entries.length, 1);
  assert.equal(videoHistory.entries[0].status, "failed");
  assert.match(videoHistory.entries[0].error, /Grok auth not found/);
  assert.equal(ttsHistory.entries.length, 1);
  assert.equal(ttsHistory.entries[0].status, "failed");
  assert.match(ttsHistory.entries[0].error, /Huoshan API Key not found/);
});

test.skip("POST /v1/media/image generates an image through its configured provider");
test.skip("POST /v1/media/video creates an asynchronous video task");
test.skip("GET /v1/media/tasks/:id polls and persists a completed video");
test.skip("POST /v1/media/tts synthesizes and persists audio");
test.skip("GET and DELETE /v1/media/history list and remove history entries");

function testGatewayEnv(tempDir, configPath, overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: "test",
    GATEWAY_PORT: String(GATEWAY_PORT),
    GATEWAY_CONFIG_FILE: configPath,
    GATEWAY_SECRETS_FILE: path.join(tempDir, "gateway.secrets.json"),
    GATEWAY_NO_OPEN: "1",
    CLAUDE_3P_SYNC_DISABLED: "1",
    CLAUDE_CODE_SYNC_DISABLED: "1",
    CODEX_WRITE_MODEL_CATALOG_DISABLED: "1",
    LOG_FILE: path.join(tempDir, "gateway.log"),
    ...overrides,
  };
}

async function waitForHealth(child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`gateway exited before health check (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/health`);
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("gateway health check timed out");
}

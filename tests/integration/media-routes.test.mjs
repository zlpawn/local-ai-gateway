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

test.skip("POST /v1/media/image generates an image through its configured provider");
test.skip("POST /v1/media/video creates an asynchronous video task");
test.skip("GET /v1/media/tasks/:id polls and persists a completed video");
test.skip("POST /v1/media/tts synthesizes and persists audio");
test.skip("GET and DELETE /v1/media/history list and remove history entries");

function testGatewayEnv(tempDir, configPath) {
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

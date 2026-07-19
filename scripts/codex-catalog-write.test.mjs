import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Gateway health check timed out.");
}

test("saving config rewrites the Codex model catalog file", async (t) => {
  const reservation = http.createServer();
  const gatewayPort = await listen(reservation);
  await closeServer(reservation);

  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-catalog-write-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const configPath = path.join(tempDir, "gateway.config.json");
  const secretsPath = path.join(tempDir, "gateway.secrets.json");
  const catalogPath = path.join(tempDir, "gateway-model-catalog.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients: {
      codex: {
        endpoints: [{
          id: "ep_chat",
          name: "chat",
          type: "openai-chat",
          base_url: "https://example.invalid/chat/completions",
          api_key: "env:TEST_KEY",
          models: ["third-party-a"],
        }],
      },
    },
  }));

  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_SECRETS_FILE: secretsPath,
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_NO_OPEN: "1",
      CLAUDE_3P_SYNC_DISABLED: "1",
      CODEX_MODEL_CATALOG_PATH: catalogPath,
      CODEX_MODELS_LIVE_DISABLED: "1",
      TEST_KEY: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (gateway.exitCode == null) {
      const exited = once(gateway, "exit");
      gateway.kill();
      await exited;
    }
  });
  await waitForHealth(gatewayPort, gateway);

  const before = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.equal(
    before.models.some((model) => model.slug === "third-party-a"),
    true,
  );

  const save = await fetch(`http://127.0.0.1:${gatewayPort}/v1/config/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      server: { host: "127.0.0.1", port: gatewayPort },
      clients: {
        codex: {
          endpoints: [{
            id: "ep_chat",
            name: "chat",
            type: "openai-chat",
            base_url: "https://example.invalid/chat/completions",
            api_key: "env:TEST_KEY",
            models: ["third-party-b"],
          }],
        },
      },
    }),
  });
  assert.equal(save.status, 200);
  const payload = await save.json();
  assert.equal(payload.success, true);
  assert.equal(payload.codex_model_catalog?.exists, true);
  assert.equal(
    String(payload.codex_model_catalog?.path || "").replaceAll("\\", "/"),
    catalogPath.replaceAll("\\", "/"),
  );

  const after = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.equal(
    after.models.some((model) => model.slug === "third-party-b"),
    true,
  );
  assert.equal(
    after.models.some((model) => model.slug === "third-party-a"),
    false,
  );

  const savedConfig = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(savedConfig.clients.codex.endpoints[0].api_key, undefined);
  const savedSecrets = JSON.parse(await readFile(secretsPath, "utf8"));
  assert.equal(savedSecrets.api_keys.ep_chat, "env:TEST_KEY");

  const configApi = await fetch(`http://127.0.0.1:${gatewayPort}/v1/config`);
  assert.equal(configApi.status, 200);
  const configPayload = await configApi.json();
  assert.equal(configPayload.clients.codex.endpoints[0].api_key, undefined);
  assert.equal(configPayload.clients.codex.endpoints[0].has_api_key, true);
  assert.equal(configPayload.codex_model_catalog?.exists, true);
  assert.match(
    String(configPayload.codex_model_catalog?.path_posix || ""),
    /gateway-model-catalog\.json$/,
  );
});

test("saving duplicate public model ids returns conflict suggestions", async (t) => {
  const reservation = http.createServer();
  const gatewayPort = await listen(reservation);
  await closeServer(reservation);
  const tempDir = await mkdtemp(path.join(tmpdir(), "gateway-conflict-save-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const configPath = path.join(tempDir, "gateway.config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients: { desktop: { endpoints: [] }, codex: { endpoints: [] } },
  }));
  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_SECRETS_FILE: path.join(tempDir, "gateway.secrets.json"),
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_NO_OPEN: "1",
      CLAUDE_3P_SYNC_DISABLED: "1",
      CODEX_WRITE_MODEL_CATALOG_DISABLED: "1",
      CODEX_MODELS_LIVE_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (gateway.exitCode == null) {
      const exited = once(gateway, "exit");
      gateway.kill();
      await exited;
    }
  });
  await waitForHealth(gatewayPort, gateway);

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/config/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      server: { host: "127.0.0.1", port: gatewayPort },
      clients: {
        desktop: {
          endpoints: [
            {
              id: "ep_ark",
              name: "Volcengine",
              models: ["glm-5.2"],
              model_mapping: { "claude-opus-4-7": "glm-5.2" },
            },
            {
              id: "ep_husky",
              name: "Husky API",
              models: ["minimax-m3"],
              model_mapping: { "claude-opus-4-7": "minimax-m3" },
            },
          ],
        },
      },
    }),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  const issue = payload.error.issues.find((item) => item.code === "duplicate_public_model");
  assert.equal(issue.model_id, "claude-opus-4-7");
  assert.deepEqual(
    issue.occurrences.map((item) => item.suggestion),
    ["claude-opus-4-7", "claude-opus-4-6"],
  );
});

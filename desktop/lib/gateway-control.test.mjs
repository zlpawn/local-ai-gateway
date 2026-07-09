import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  buildGatewayEnvironment,
  getGatewayPort,
  isPortFree,
  maskConfigSecrets,
  readDotEnvFile,
  readJsonFile,
} from "./gateway-control.mjs";

test("getGatewayPort prefers environment, then .env, then config, then default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-control-"));
  await fs.writeFile(path.join(root, ".env"), "GATEWAY_PORT=9010\n", "utf8");
  await fs.writeFile(path.join(root, "gateway.config.json"), JSON.stringify({ server: { port: 9020 } }), "utf8");

  assert.equal(await getGatewayPort(root, { GATEWAY_PORT: "9001" }), 9001);
  assert.equal(await getGatewayPort(root, {}), 9010);

  await fs.writeFile(path.join(root, ".env"), "PORT=9011\n", "utf8");
  assert.equal(await getGatewayPort(root, {}), 9011);

  await fs.rm(path.join(root, ".env"));
  assert.equal(await getGatewayPort(root, {}), 9020);

  await fs.rm(path.join(root, "gateway.config.json"));
  assert.equal(await getGatewayPort(root, {}), 8787);
});

test("readJsonFile returns parsed json and a helpful error state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-control-"));
  const file = path.join(root, "config.json");

  await fs.writeFile(file, "{\"ok\":true}", "utf8");
  assert.deepEqual(await readJsonFile(file), { ok: true });

  await fs.writeFile(file, "{bad", "utf8");
  await assert.rejects(() => readJsonFile(file), /Invalid JSON/);
});

test("maskConfigSecrets hides direct API keys without hiding env variable names", () => {
  const masked = maskConfigSecrets({
    providers: {
      direct: { api_key: "secret-value", api_key_env: "OPENROUTER_API_KEY" },
      nested: { headers: { Authorization: "Bearer abc", "x-api-key": "xyz" } },
    },
  });

  assert.equal(masked.providers.direct.api_key, "********");
  assert.equal(masked.providers.direct.api_key_env, "OPENROUTER_API_KEY");
  assert.equal(masked.providers.nested.headers.Authorization, "********");
  assert.equal(masked.providers.nested.headers["x-api-key"], "********");
});

test("buildGatewayEnvironment points server paths at the app root", () => {
  const root = path.resolve("D:/example gateway");
  const env = buildGatewayEnvironment(root, { EXISTING: "1" }, root);

  assert.equal(env.EXISTING, "1");
  assert.equal(env.GATEWAY_CONFIG_FILE, path.join(root, "gateway.config.json"));
  assert.equal(env.LOG_FILE, path.join(root, "gateway.log"));
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("readDotEnvFile parses simple key values and ignores comments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-control-"));
  const file = path.join(root, ".env");
  await fs.writeFile(file, "A=1\n# ignored\nB=\"two\"\nC='three'\n", "utf8");

  assert.deepEqual(await readDotEnvFile(file), {
    A: "1",
    B: "two",
    C: "three",
  });
});

test("isPortFree reports a busy localhost port", async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(19888, "127.0.0.1", resolve);
  });

  try {
    assert.equal(await isPortFree(19888), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

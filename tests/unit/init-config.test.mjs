import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  initializeConfig,
  loadEnvironmentFile,
  resolveUserPath,
} from "../../lib/cli/init-config.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("initialization creates .env from the example once", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "gateway-init-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await writeFile(path.join(rootDir, ".env.example"), "GATEWAY_PORT=8787\n");
  await writeFile(path.join(rootDir, "gateway.config.example.json"), "{}\n");

  assert.deepEqual(await initializeConfig(rootDir), {
    created: [".env", "gateway.config.json"],
    existing: [],
  });
  assert.equal(await readFile(path.join(rootDir, ".env"), "utf8"), "GATEWAY_PORT=8787\n");

  await writeFile(path.join(rootDir, ".env"), "KEEP_ME=1\n");
  assert.deepEqual(await initializeConfig(rootDir), {
    created: [],
    existing: [".env", "gateway.config.json"],
  });
  assert.equal(await readFile(path.join(rootDir, ".env"), "utf8"), "KEEP_ME=1\n");
});

test("initialization creates a public gateway config in a separate data directory", async (t) => {
  const packageDir = await mkdtemp(path.join(os.tmpdir(), "gateway-package-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "gateway-data-"));
  t.after(() => rm(packageDir, { recursive: true, force: true }));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const publicConfig = JSON.stringify({
    server: { host: "127.0.0.1", port: 8787 },
    clients: {
      code: { endpoints: [] },
      desktop: { endpoints: [] },
      codex: { endpoints: [] },
    },
  }, null, 2);
  await writeFile(path.join(packageDir, ".env.example"), "GATEWAY_PORT=8787\n");
  await writeFile(path.join(packageDir, "gateway.config.example.json"), `${publicConfig}\n`);

  assert.deepEqual(await initializeConfig(packageDir, dataDir), {
    created: [".env", "gateway.config.json"],
    existing: [],
  });
  assert.equal(await readFile(path.join(dataDir, "gateway.config.json"), "utf8"), `${publicConfig}\n`);
});

test("initialization never overwrites an existing gateway config", async (t) => {
  const packageDir = await mkdtemp(path.join(os.tmpdir(), "gateway-package-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "gateway-data-"));
  t.after(() => rm(packageDir, { recursive: true, force: true }));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(packageDir, ".env.example"), "GATEWAY_PORT=8787\n");
  await writeFile(path.join(packageDir, "gateway.config.example.json"), "{}\n");
  await writeFile(path.join(dataDir, "gateway.config.json"), "{\"keep\":true}\n");

  assert.deepEqual(await initializeConfig(packageDir, dataDir), {
    created: [".env"],
    existing: ["gateway.config.json"],
  });
  assert.equal(
    await readFile(path.join(dataDir, "gateway.config.json"), "utf8"),
    "{\"keep\":true}\n",
  );
});

test("the packaged gateway config template contains no private endpoints or credentials", async () => {
  const template = JSON.parse(
    await readFile(path.join(projectRoot, "gateway.config.example.json"), "utf8"),
  );
  assert.deepEqual(template, {
    server: { host: "127.0.0.1", port: 8787 },
    clients: {
      code: { endpoints: [] },
      desktop: { endpoints: [] },
      codex: { endpoints: [] },
    },
  });
});

test("environment loading fills missing values without overriding the caller", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "gateway-env-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const envPath = path.join(rootDir, ".env");
  await writeFile(envPath, [
    "# comment",
    "GATEWAY_PORT=8788",
    "QUOTED_VALUE=\"safe value\"",
    "",
  ].join("\n"));
  const env = { GATEWAY_PORT: "9000" };

  assert.deepEqual(await loadEnvironmentFile(envPath, env), {
    GATEWAY_PORT: "9000",
    QUOTED_VALUE: "safe value",
  });
});

test("relative user configuration paths resolve under the user data directory", () => {
  assert.equal(
    resolveUserPath("D:\\Users\\person\\.local-ai-gateway", "gateway.config.json"),
    path.resolve("D:\\Users\\person\\.local-ai-gateway", "gateway.config.json"),
  );
  assert.equal(
    resolveUserPath("D:\\Users\\person\\.local-ai-gateway", "E:\\shared\\gateway.json"),
    path.resolve("E:\\shared\\gateway.json"),
  );
});

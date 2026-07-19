import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeConfig } from "../../lib/cli/init-config.mjs";

test("initialization creates .env from the example once", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "gateway-init-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await writeFile(path.join(rootDir, ".env.example"), "GATEWAY_PORT=8787\n");

  assert.deepEqual(await initializeConfig(rootDir), { created: [".env"], existing: [] });
  assert.equal(await readFile(path.join(rootDir, ".env"), "utf8"), "GATEWAY_PORT=8787\n");

  await writeFile(path.join(rootDir, ".env"), "KEEP_ME=1\n");
  assert.deepEqual(await initializeConfig(rootDir), { created: [], existing: [".env"] });
  assert.equal(await readFile(path.join(rootDir, ".env"), "utf8"), "KEEP_ME=1\n");
});

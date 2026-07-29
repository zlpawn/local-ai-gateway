import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDoctor } from "../../../../lib/clis/shrimp/domain/doctor-service.mjs";

test("doctor reports missing secrets and closed port", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shrimp-doctor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "gateway.config.json");
  const secretsPath = path.join(dir, "gateway.secrets.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 8799 },
    clients: {
      code: {
        endpoints: [{
          id: "ep_test",
          name: "ark",
          type: "openai-chat",
          base_url: "https://example.com/v1/chat/completions",
          models: ["m1"],
          enabled: true,
        }],
      },
      desktop: { endpoints: [] },
      codex: { endpoints: [] },
      deeptutor: { endpoints: [] },
    },
  }, null, 2));
  await writeFile(secretsPath, JSON.stringify({ api_keys: {} }, null, 2));

  const report = await runDoctor({
    configPath,
    secretsPath,
    host: "127.0.0.1",
    port: 8799,
  });
  assert.equal(report.config.valid, true);
  assert.equal(report.endpoints[0].key_state, "missing");
  assert.equal(report.runtime.listening, false);
  assert.ok(report.recommendations.some((r) => String(r.command).includes("secret set")));
  assert.ok(report.recommendations.some((r) => r.command === "start"));
});
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getModelSlots,
  setModelSlots,
  snippetForClient,
  writeCodexCatalog,
} from "../../../../lib/clis/shrimp/domain/apply-service.mjs";

async function tempState() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shrimp-apply-"));
  const configPath = path.join(dir, "gateway.config.json");
  const secretsPath = path.join(dir, "gateway.secrets.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 8787 },
    clients: {
      code: {
        endpoints: [{
          id: "ep_code",
          name: "ark",
          type: "openai-chat",
          base_url: "https://example.com/v1/chat/completions",
          models: ["glm-5.2", "deepseek-v4-pro"],
          is_default: true,
          enabled: true,
        }],
        model_slots: {},
      },
      desktop: { endpoints: [] },
      codex: {
        endpoints: [{
          id: "ep_codex",
          name: "openrouter",
          type: "openai-chat",
          base_url: "https://example.com/v1/chat/completions",
          models: ["glm-5.2"],
          expose_models: true,
          enabled: true,
        }],
      },
      deeptutor: { endpoints: [] },
    },
  }, null, 2));
  await writeFile(secretsPath, JSON.stringify({ api_keys: {} }, null, 2));
  return { dir, configPath, secretsPath };
}

test("set and get model slots", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  setModelSlots({
    ...ctx,
    slots: { sonnet: "glm-5.2", opus: "deepseek-v4-pro" },
  });
  const got = getModelSlots(ctx);
  assert.equal(got.slots.sonnet, "glm-5.2");
  assert.equal(got.slots.opus, "deepseek-v4-pro");
});

test("codex snippet includes catalog path and codex base url", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  const snippet = snippetForClient({ ...ctx, client: "codex" });
  assert.match(snippet.snippet, /model_provider = "custom"/);
  assert.match(snippet.snippet, /\/codex\/v1/);
});

test("writeCodexCatalog creates file", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  const out = path.join(ctx.dir, "catalog.json");
  const result = writeCodexCatalog({ ...ctx, outputPath: out });
  assert.equal(result.path, out);
  const text = await readFile(out, "utf8");
  assert.match(text, /"source": "shrimp"/);
});
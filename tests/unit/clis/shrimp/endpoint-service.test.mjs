import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addEndpoint, listEndpoints, removeEndpoint } from "../../../../lib/clis/shrimp/domain/endpoint-service.mjs";

async function tempState() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shrimp-endpoint-"));
  const configPath = path.join(dir, "gateway.config.json");
  const secretsPath = path.join(dir, "gateway.secrets.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 8787 },
    clients: {
      code: { endpoints: [] },
      desktop: { endpoints: [] },
      codex: { endpoints: [] },
      deeptutor: { endpoints: [] },
    },
  }, null, 2));
  await writeFile(secretsPath, JSON.stringify({ api_keys: {} }, null, 2));
  return { dir, configPath, secretsPath };
}

test("add endpoint writes config and secret state", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));

  const added = addEndpoint({
    ...ctx,
    client: "code",
    name: "openrouter",
    type: "openai-chat",
    base_url: "https://openrouter.ai/api/v1/chat/completions",
    models: "glm-5.2",
    api_key: "sk-test-123",
  });
  assert.equal(added.endpoint.client, "code");
  assert.equal(added.endpoint.secret_state, "stored");
  assert.match(added.endpoint.id, /^ep_/);

  const listed = listEndpoints({ ...ctx, client: "code" });
  assert.equal(listed.count, 1);

  const secrets = JSON.parse(await readFile(ctx.secretsPath, "utf8"));
  assert.equal(secrets.api_keys[added.endpoint.id], "sk-test-123");
});

test("add endpoint rejects missing base_url", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  assert.throws(
    () => addEndpoint({
      ...ctx,
      client: "code",
      name: "x",
      type: "openai-chat",
    }),
    (err) => err.code === "missing_fields",
  );
});

test("dry-run add does not write endpoint", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  addEndpoint({
    ...ctx,
    client: "code",
    name: "openrouter",
    type: "openai-chat",
    base_url: "https://example.com/v1/chat/completions",
    dryRun: true,
  });
  const listed = listEndpoints({ ...ctx, client: "code" });
  assert.equal(listed.count, 0);
});

test("remove requires yes", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  const added = addEndpoint({
    ...ctx,
    client: "code",
    name: "openrouter",
    type: "openai-chat",
    base_url: "https://example.com/v1/chat/completions",
  });
  assert.throws(
    () => removeEndpoint({ ...ctx, id: added.endpoint.id }),
    (err) => err.code === "confirmation_required",
  );
  removeEndpoint({ ...ctx, id: added.endpoint.id, yes: true });
  assert.equal(listEndpoints({ ...ctx, client: "code" }).count, 0);
});
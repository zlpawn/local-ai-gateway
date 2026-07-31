import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addEndpoint } from "../../../../lib/clis/shrimp/domain/endpoint-service.mjs";
import { addClient, copyClient, getClient, removeClient } from "../../../../lib/clis/shrimp/domain/client-service.mjs";

async function tempState() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shrimp-copy-"));
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

test("replace copy clones endpoints and secrets with new ids", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  const source = addEndpoint({
    ...ctx,
    client: "codex",
    name: "ark",
    type: "openai-chat",
    base_url: "https://example.com/v1/chat/completions",
    api_key: "sk-codex",
  });
  const result = copyClient({
    ...ctx,
    from: "codex",
    to: "deeptutor",
    mode: "replace",
  });
  assert.equal(result.copied, 1);
  const target = getClient({ ...ctx, client: "deeptutor" });
  assert.equal(target.endpoint_count, 1);
  assert.notEqual(target.endpoints[0].id, source.endpoint.id);
});

test("fill-empty no-ops when target has endpoints", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  addEndpoint({
    ...ctx,
    client: "codex",
    name: "ark",
    type: "openai-chat",
    base_url: "https://example.com/v1/chat/completions",
  });
  addEndpoint({
    ...ctx,
    client: "deeptutor",
    name: "existing",
    type: "openai-chat",
    base_url: "https://example.com/v1/chat/completions",
  });
  const result = copyClient({
    ...ctx,
    from: "codex",
    to: "deeptutor",
    mode: "fill-empty",
  });
  assert.equal(result.copied, 0);
  assert.equal(getClient({ ...ctx, client: "deeptutor" }).endpoint_count, 1);
});

test("merge keeps target endpoints and appends clones", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  addEndpoint({
    ...ctx,
    client: "codex",
    name: "ark",
    type: "openai-chat",
    base_url: "https://example.com/v1/chat/completions",
  });
  addEndpoint({
    ...ctx,
    client: "deeptutor",
    name: "existing",
    type: "openai-chat",
    base_url: "https://example.com/v2/chat/completions",
  });
  const result = copyClient({
    ...ctx,
    from: "codex",
    to: "deeptutor",
    mode: "merge",
  });
  assert.equal(result.copied, 1);
  assert.equal(getClient({ ...ctx, client: "deeptutor" }).endpoint_count, 2);
});
test("addClient creates an empty client group when no copyFrom is given", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  const result = addClient({ ...ctx, client: "my-agent" });
  assert.equal(result.created, true);
  const target = getClient({ ...ctx, client: "my-agent" });
  assert.equal(target.endpoint_count, 0);
});

test("addClient seeds from another client when copyFrom is given", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  addEndpoint({
    ...ctx,
    client: "codex",
    name: "ark",
    type: "openai-chat",
    base_url: "https://example.com/v1/chat/completions",
    api_key: "sk-codex",
  });
  const result = addClient({ ...ctx, client: "clone", copyFrom: "codex", mode: "replace" });
  assert.equal(result.copied, 1);
  const target = getClient({ ...ctx, client: "clone" });
  assert.equal(target.endpoint_count, 1);
  assert.notEqual(target.endpoints[0].id, getClient({ ...ctx, client: "codex" }).endpoints[0].id);
});

test("removeClient deletes a custom group and its endpoint secrets", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  addClient({ ...ctx, client: "temp", copyFrom: "codex", mode: "replace" });
  assert.ok(getClient({ ...ctx, client: "temp" }));
  const result = removeClient({ ...ctx, client: "temp", yes: true });
  assert.equal(result.removed, "temp");
  assert.throws(() => getClient({ ...ctx, client: "temp" }), /Client not found: temp/);
});

test("removeClient refuses to run without explicit confirmation", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  addClient({ ...ctx, client: "temp" });
  assert.throws(
    () => removeClient({ ...ctx, client: "temp" }),
    (err) => err?.code === "confirmation_required",
  );
  // Still present after a refused removal.
  assert.ok(getClient({ ...ctx, client: "temp" }));
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addEndpoint } from "../../../../lib/clis/shrimp/domain/endpoint-service.mjs";
import { getSecret, listSecrets, setSecret } from "../../../../lib/clis/shrimp/domain/secret-service.mjs";
import { redactSecrets } from "../../../../lib/clis/shrimp/protocol.mjs";

async function tempState() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shrimp-secret-"));
  const configPath = path.join(dir, "gateway.config.json");
  const secretsPath = path.join(dir, "gateway.secrets.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 8787 },
    clients: { code: { endpoints: [] }, desktop: { endpoints: [] }, codex: { endpoints: [] }, deeptutor: { endpoints: [] } },
  }, null, 2));
  await writeFile(secretsPath, JSON.stringify({ api_keys: {} }, null, 2));
  return { dir, configPath, secretsPath };
}

test("set literal key writes file but get returns stored", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  const ep = addEndpoint({
    ...ctx,
    client: "code",
    name: "ark",
    type: "openai-chat",
    base_url: "https://example.com/v1/chat/completions",
  });
  const result = setSecret({
    ...ctx,
    endpointId: ep.endpoint.id,
    apiKey: "sk-secret",
  });
  assert.equal(result.state, "stored");
  const got = getSecret({ ...ctx, endpointId: ep.endpoint.id });
  assert.equal(got.state, "stored");
  const file = JSON.parse(await readFile(ctx.secretsPath, "utf8"));
  assert.equal(file.api_keys[ep.endpoint.id], "sk-secret");
  assert.equal(redactSecrets({ api_key: "sk-secret" }).api_key, "***");
});

test("set env ref returns env state", async (t) => {
  const ctx = await tempState();
  t.after(() => rm(ctx.dir, { recursive: true, force: true }));
  const ep = addEndpoint({
    ...ctx,
    client: "code",
    name: "ark",
    type: "openai-chat",
    base_url: "https://example.com/v1/chat/completions",
  });
  setSecret({
    ...ctx,
    endpointId: ep.endpoint.id,
    apiKeyEnv: "ARK_API_KEY",
  });
  const listed = listSecrets({ ...ctx, client: "code" });
  assert.equal(listed.items[0].state, "env:ARK_API_KEY");
});
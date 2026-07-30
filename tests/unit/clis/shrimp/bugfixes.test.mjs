import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGlobalFlags } from "../../../../lib/clis/shrimp/parse-args.mjs";
import { updateEndpoint, addEndpoint } from "../../../../lib/clis/shrimp/domain/endpoint-service.mjs";

test("bugfix: parseGlobalFlags preserves trailing -y flag for subcommands", () => {
  const argv = ["cli-tool", "install", "npx", "-y", "@foo/bar"];
  const { flags, rest } = parseGlobalFlags(argv);
  assert.equal(flags.yes, false);
  assert.deepEqual(rest, ["cli-tool", "install", "npx", "-y", "@foo/bar"]);
});

test("bugfix: updateEndpoint handles is_default=false", async (t) => {
  const tmpConfig = path.join(os.tmpdir(), `cfg-${Date.now()}.json`);
  const tmpSecrets = path.join(os.tmpdir(), `sec-${Date.now()}.json`);
  t.after(() => {
    fs.rmSync(tmpConfig, { force: true });
    fs.rmSync(tmpSecrets, { force: true });
  });

  const created = addEndpoint({
    configPath: tmpConfig,
    secretsPath: tmpSecrets,
    client: "code",
    name: "ep1",
    type: "openai-chat",
    base_url: "https://api.openai.com",
    is_default: true,
  });

  assert.equal(created.endpoint.is_default, true);

  const updated = updateEndpoint({
    configPath: tmpConfig,
    secretsPath: tmpSecrets,
    id: created.endpoint.id,
    is_default: false,
  });

  assert.equal(updated.endpoint.is_default, false);
});
test("bugfix: invalid json in model_mapping throws CliError validation", () => {
  const tmpConfig = path.join(os.tmpdir(), `cfg-${Date.now()}.json`);
  const tmpSecrets = path.join(os.tmpdir(), `sec-${Date.now()}.json`);
  assert.throws(() => {
    addEndpoint({
      configPath: tmpConfig,
      secretsPath: tmpSecrets,
      client: "code",
      name: "ep1",
      type: "openai-chat",
      base_url: "https://api.openai.com",
      model_mapping: "{invalid_json}",
    });
  }, (err) => err.code === "invalid_json" && err.type === "validation");
});

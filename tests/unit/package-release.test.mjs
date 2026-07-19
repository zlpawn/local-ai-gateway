import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("npm package metadata exposes only public release files", async () => {
  const pkg = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

  assert.equal(pkg.main, undefined);
  assert.equal(pkg.bin["local-ai-gateway"], "bin/cli.js");
  assert.equal(pkg.publishConfig.access, "public");
  assert.equal(pkg.repository.url, "git+https://github.com/zlpawn/local-ai-gateway.git");
  assert.ok(pkg.files.includes("gateway.config.example.json"));
  assert.ok(!pkg.files.includes("gateway.config.json"));
  assert.ok(!pkg.files.includes("models.json"));
});

test("public package attribution does not expose a local user alias", async () => {
  const license = await readFile(path.join(projectRoot, "LICENSE"), "utf8");
  assert.doesNotMatch(license, /\bxtea\b/i);
  assert.match(license, /Local AI Gateway contributors/);
});

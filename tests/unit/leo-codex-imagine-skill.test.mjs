import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseCliArgs, slugifyPrompt, formatDateYYYYMMDDHHmmss, generateSemanticFilename } from "../../lib/skills/leo-codex-imagine/scripts/leo_codex_imagine.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("leo-codex-imagine SKILL.md exists with correct name", () => {
  const skillPath = path.join(ROOT, "lib", "skills", "leo-codex-imagine", "SKILL.md");
  const content = fs.readFileSync(skillPath, "utf8");
  assert.match(content, /name: leo-codex-imagine/);
  assert.match(content, /\/v1\/media\/image/);
});

test("leo-codex-imagine script is valid ESM", () => {
  const scriptPath = path.join(ROOT, "lib", "skills", "leo-codex-imagine", "scripts", "leo_codex_imagine.mjs");
  assert.ok(fs.existsSync(scriptPath));
});

test("leo-codex-imagine parseCliArgs parser", () => {
  const parsed = parseCliArgs(["--prompt", "test image", "--aspect-ratio", "16:9", "--quality", "high"]);
  assert.equal(parsed.prompt, "test image");
  assert.equal(parsed.aspectRatio, "16:9");
  assert.equal(parsed.quality, "high");
});

test("leo-codex-imagine filename generator", () => {
  const slug = slugifyPrompt("赛博朋克城市");
  const filename = generateSemanticFilename("test", "png", "codex");
  assert.ok(filename.startsWith("codex_test_"));
  assert.ok(filename.endsWith(".png"));
});

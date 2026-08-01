import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseCliArgs, slugifyPrompt, generateSemanticFilename } from "../../lib/skills/leo-antigravity-imagine/scripts/leo_antigravity_imagine.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("leo-antigravity-imagine SKILL.md exists with correct name", () => {
  const skillPath = path.join(ROOT, "lib", "skills", "leo-antigravity-imagine", "SKILL.md");
  const content = fs.readFileSync(skillPath, "utf8");
  assert.match(content, /name: leo-antigravity-imagine/);
  assert.match(content, /\/v1\/media\/image/);
});

test("leo-antigravity-imagine script is valid ESM", () => {
  const scriptPath = path.join(ROOT, "lib", "skills", "leo-antigravity-imagine", "scripts", "leo_antigravity_imagine.mjs");
  assert.ok(fs.existsSync(scriptPath));
});

test("leo-antigravity-imagine parseCliArgs parser", () => {
  const parsed = parseCliArgs(["--prompt", "gemini image", "--images", "/a.jpg,/b.jpg", "--aspect-ratio", "9:16"]);
  assert.equal(parsed.prompt, "gemini image");
  assert.equal(parsed.imagePaths, "/a.jpg,/b.jpg");
  assert.equal(parsed.aspectRatio, "9:16");
});

test("leo-antigravity-imagine filename generator", () => {
  const filename = generateSemanticFilename("test", "png", "antigravity");
  assert.ok(filename.startsWith("antigravity_test_"));
  assert.ok(filename.endsWith(".png"));
});

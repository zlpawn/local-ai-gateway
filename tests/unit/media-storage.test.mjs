import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  slugifyPrompt,
  generateSemanticFilename,
  ensureOutputDir,
} from "../../lib/media/storage.mjs";

test("slugifyPrompt lowercases and replaces non-word chars", () => {
  assert.equal(slugifyPrompt("Hello World!"), "hello_world");
  assert.equal(slugifyPrompt("赛博朋克夜景"), "赛博朋克夜景");
  assert.equal(slugifyPrompt(""), "media");
});

test("slugifyPrompt truncates to maxLength", () => {
  assert.ok(slugifyPrompt("a".repeat(50), 35).length <= 35);
});

test("generateSemanticFilename includes provider prefix and timestamp", () => {
  const filename = generateSemanticFilename("cyberpunk city", "jpg", "grok");
  assert.match(filename, /^grok_cyberpunk_city_\d{14}\.jpg$/);
});

test("generateSemanticFilename respects explicit filename", () => {
  assert.equal(generateSemanticFilename("test", "jpg", "grok", "custom.png"), "custom.png");
});

test("ensureOutputDir creates directory if missing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-storage-"));
  try {
    assert.equal(ensureOutputDir("image", root), path.join(root, "images"));
    assert.ok(existsSync(path.join(root, "images")));
    assert.equal(ensureOutputDir("video", root), path.join(root, "videos"));
    assert.ok(existsSync(path.join(root, "videos")));
    assert.equal(ensureOutputDir("audio", root), path.join(root, "audios"));
    assert.ok(existsSync(path.join(root, "audios")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

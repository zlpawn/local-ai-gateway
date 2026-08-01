import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeMediaReferenceImages } from "../../lib/media/request-normalizer.mjs";

test("normalizeMediaReferenceImages reads up to three local image paths into canonical base64 inputs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-reference-images-"));
  try {
    const png = path.join(root, "reference.png");
    const jpg = path.join(root, "reference.jpg");
    writeFileSync(png, Buffer.from("png-reference"));
    writeFileSync(jpg, Buffer.from("jpg-reference"));

    const result = normalizeMediaReferenceImages({ image_paths: [png, path.relative(process.cwd(), jpg)] });

    assert.deepEqual(result.imageB64List, [Buffer.from("png-reference").toString("base64"), Buffer.from("jpg-reference").toString("base64")]);
    assert.deepEqual(result.imageMimeTypes, ["image/png", "image/jpeg"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeMediaReferenceImages rejects missing, non-image, and over-limit paths", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-reference-invalid-"));
  try {
    const text = path.join(root, "not-an-image.txt");
    const png = path.join(root, "one.png");
    writeFileSync(text, "not an image");
    writeFileSync(png, "image");

    assert.throws(() => normalizeMediaReferenceImages({ image_paths: [path.join(root, "missing.png")] }), /does not exist/);
    assert.throws(() => normalizeMediaReferenceImages({ image_paths: [text] }), /supported image file/);
    assert.throws(() => normalizeMediaReferenceImages({ image_paths: [png, png, png, png] }), /at most 3/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

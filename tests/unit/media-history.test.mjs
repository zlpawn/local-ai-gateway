import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadHistory, addHistoryEntry, deleteHistoryEntry, listHistory } from "../../lib/media/history.mjs";

test("loadHistory returns empty entries for missing file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-history-"));
  try {
    assert.deepEqual(loadHistory(root).entries, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("addHistoryEntry persists and returns entry with id", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-history-"));
  try {
    const entry = addHistoryEntry(root, {
      media_type: "image", endpoint_name: "test", provider: "grok-subscription",
      model: "m1", prompt: "test prompt", file_path: "/tmp/test.jpg",
      file_size: 1000, status: "completed",
    });
    assert.ok(entry.id);
    assert.equal(entry.media_type, "image");
    assert.equal(loadHistory(root).entries.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("listHistory filters by media_type", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-history-"));
  try {
    addHistoryEntry(root, { media_type: "image", prompt: "a", status: "completed" });
    addHistoryEntry(root, { media_type: "video", prompt: "b", status: "completed" });
    addHistoryEntry(root, { media_type: "image", prompt: "c", status: "completed" });
    assert.equal(listHistory(root, "image").length, 2);
    assert.equal(listHistory(root, "video").length, 1);
    assert.equal(listHistory(root).length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("deleteHistoryEntry removes entry", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-history-"));
  try {
    const e = addHistoryEntry(root, { media_type: "image", prompt: "a", status: "completed" });
    assert.equal(loadHistory(root).entries.length, 1);
    deleteHistoryEntry(root, e.id);
    assert.equal(loadHistory(root).entries.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("history prunes at 200 entries", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-history-"));
  try {
    for (let i = 0; i < 205; i++) {
      addHistoryEntry(root, { media_type: "image", prompt: `p${i}`, status: "completed" });
    }
    assert.equal(loadHistory(root).entries.length, 200);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

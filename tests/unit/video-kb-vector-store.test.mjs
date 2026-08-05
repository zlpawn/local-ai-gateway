import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createVectorStore } from "../../lib/video-kb/vector-store.mjs";

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lancedb-"));
}

// These tests require Python lancedb installed.
// They are skipped if lancedb is not available.
async function isLanceDbAvailable() {
  try {
    const { execSync } = await import("node:child_process");
    execSync("python3 -c 'import lancedb'", { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const hasLanceDb = await isLanceDbAvailable();
const skipIfNoLanceDb = hasLanceDb ? test : test.skip;

skipIfNoLanceDb("vector-store: ensure table and upsert chunks", async () => {
  const dir = tmpDir();
  try {
    const store = createVectorStore({ dbPath: dir });
    await store.ensureTable(3);

    const chunks = [
      {
        chunk_id: "chunk-001",
        video_id: "vid001",
        video_url: "https://example.com/v1",
        video_title: "Test Video",
        chunk_index: 0,
        start_seconds: 0,
        end_seconds: 60,
        text: "This is a test about cooking",
        segment_ids: ["S1", "S2"],
        language: "en",
        created_at: Date.now(),
        vector: [1.0, 0.0, 0.0],
      },
      {
        chunk_id: "chunk-002",
        video_id: "vid001",
        video_url: "https://example.com/v1",
        video_title: "Test Video",
        chunk_index: 1,
        start_seconds: 60,
        end_seconds: 120,
        text: "This is about programming",
        segment_ids: ["S3", "S4"],
        language: "en",
        created_at: Date.now(),
        vector: [0.0, 1.0, 0.0],
      },
    ];

    const result = await store.upsertChunks(chunks, { dim: 3 });
    assert.ok(result.ok);
    assert.equal(result.count, 2);

    const stats = await store.getStats();
    assert.equal(stats.total_chunks, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

skipIfNoLanceDb("vector-store: search returns similar chunks", async () => {
  const dir = tmpDir();
  try {
    // Mock embedding function
    const mockEmbed = async (text) => {
      if (text.toLowerCase().includes("cooking")) return [1.0, 0.0, 0.0];
      if (text.toLowerCase().includes("programming")) return [0.0, 1.0, 0.0];
      return [0.5, 0.5, 0.0];
    };

    const store = createVectorStore({ dbPath: dir, embeddingFn: mockEmbed });
    await store.ensureTable(3);

    await store.upsertChunks([
      {
        chunk_id: "c1", video_id: "v1", video_url: "u1", video_title: "Cooking Show",
        chunk_index: 0, start_seconds: 0, end_seconds: 60,
        text: "cooking pasta recipe", segment_ids: ["s1"], language: "en",
        created_at: Date.now(), vector: [1, 0, 0],
      },
      {
        chunk_id: "c2", video_id: "v1", video_url: "u1", video_title: "Cooking Show",
        chunk_index: 1, start_seconds: 60, end_seconds: 120,
        text: "programming in python", segment_ids: ["s2"], language: "en",
        created_at: Date.now(), vector: [0, 1, 0],
      },
    ], { dim: 3 });

    const results = await store.search("how to cook", { topK: 1 });
    assert.equal(results.length, 1);
    assert.ok(results[0].text.includes("cooking"));
    assert.equal(results[0].video_title, "Cooking Show");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

skipIfNoLanceDb("vector-store: list and delete videos", async () => {
  const dir = tmpDir();
  try {
    const store = createVectorStore({ dbPath: dir });
    await store.ensureTable(3);

    await store.upsertChunks([
      {
        chunk_id: "c1", video_id: "v1", video_url: "u1", video_title: "Video 1",
        chunk_index: 0, start_seconds: 0, end_seconds: 60,
        text: "content 1", segment_ids: ["s1"], language: "en",
        created_at: Date.now(), vector: [1, 0, 0],
      },
      {
        chunk_id: "c2", video_id: "v2", video_url: "u2", video_title: "Video 2",
        chunk_index: 0, start_seconds: 0, end_seconds: 30,
        text: "content 2", segment_ids: ["s2"], language: "en",
        created_at: Date.now(), vector: [0, 1, 0],
      },
    ], { dim: 3 });

    const videos = await store.listVideos();
    assert.equal(videos.length, 2);

    await store.deleteByVideo("v1");
    const videosAfter = await store.listVideos();
    assert.equal(videosAfter.length, 1);
    assert.equal(videosAfter[0].video_id, "v2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vector-store: createVectorStore returns all expected methods", () => {
  const store = createVectorStore({ dbPath: "/tmp/test" });
  assert.equal(typeof store.ensureTable, "function");
  assert.equal(typeof store.upsertChunks, "function");
  assert.equal(typeof store.search, "function");
  assert.equal(typeof store.deleteByVideo, "function");
  assert.equal(typeof store.listVideos, "function");
  assert.equal(typeof store.getVideo, "function");
  assert.equal(typeof store.getStats, "function");
});

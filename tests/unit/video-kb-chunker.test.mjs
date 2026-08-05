import assert from "node:assert/strict";
import test from "node:test";
import { chunkByTimeWindow, chunkBySemantic, chunkTranscript } from "../../lib/video-kb/chunker.mjs";

function makeSegments(count, textPerSeg = "Hello world this is a test segment.", segDuration = 10) {
  return Array.from({ length: count }, (_, i) => ({
    segment_id: `ASR-S${String(i + 1).padStart(4, "0")}`,
    start_seconds: i * segDuration,
    end_seconds: (i + 1) * segDuration,
    text: `${textPerSeg} ${i + 1}`,
  }));
}

test("time-window: empty segments returns empty", () => {
  assert.deepEqual(chunkByTimeWindow([]), []);
});

test("time-window: single segment produces one chunk", () => {
  const segs = makeSegments(1);
  const chunks = chunkByTimeWindow(segs, { targetSeconds: 60 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].segment_ids.length, 1);
  assert.equal(chunks[0].chunk_id, "chunk-001");
});

test("time-window: aggregates segments up to targetSeconds", () => {
  // 6 segments x 10s = 60s, target=60 -> one chunk
  const segs = makeSegments(6);
  const chunks = chunkByTimeWindow(segs, { targetSeconds: 60, maxSeconds: 90, overlapSeconds: 0 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].segment_ids.length, 6);
});

test("time-window: splits when exceeding maxSeconds", () => {
  // 10 segments x 10s = 100s, target=50, max=60 -> multiple chunks
  const segs = makeSegments(10);
  const chunks = chunkByTimeWindow(segs, { targetSeconds: 50, maxSeconds: 60, overlapSeconds: 0 });
  assert.ok(chunks.length >= 2, `expected >= 2 chunks, got ${chunks.length}`);
  for (const c of chunks) {
    const duration = c.end_seconds - c.start_seconds;
    assert.ok(duration <= 70, `chunk duration ${duration} should be near maxSeconds`);
  }
});

test("time-window: overlap causes next chunk to start earlier", () => {
  const segs = makeSegments(10);
  const chunksNoOverlap = chunkByTimeWindow(segs, { targetSeconds: 30, maxSeconds: 40, overlapSeconds: 0 });
  const chunksWithOverlap = chunkByTimeWindow(segs, { targetSeconds: 30, maxSeconds: 40, overlapSeconds: 10 });
  assert.ok(chunksWithOverlap.length >= 2);
  // With overlap, chunks may share segments - the next chunk starts within the previous chunk's time
  if (chunksWithOverlap.length >= 2) {
    assert.ok(chunksWithOverlap[1].start_seconds <= chunksWithOverlap[0].end_seconds,
      "next chunk should start within previous chunk's end (overlap)");
  }
  // Without overlap, next chunk should start after previous ends
  if (chunksNoOverlap.length >= 2) {
    assert.ok(chunksNoOverlap[1].start_seconds >= chunksNoOverlap[0].end_seconds,
      "without overlap, next chunk starts after previous ends");
  }
});

test("time-window: short trailing chunk merges into previous", () => {
  // 6 segments x 10s = 60s (one chunk at target=60), then 1 tiny segment
  const segs = makeSegments(6);
  segs.push({
    segment_id: "ASR-S0007",
    start_seconds: 60,
    end_seconds: 62,
    text: "Hi",
  });
  const chunks = chunkByTimeWindow(segs, { targetSeconds: 60, maxSeconds: 90, overlapSeconds: 0, minTokens: 10 });
  // The tiny segment should merge into the first chunk
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].segment_ids.includes("ASR-S0007"));
});

test("time-window: never splits within a segment", () => {
  const segs = makeSegments(10, "A complete sentence that is reasonably long.", 15);
  const chunks = chunkByTimeWindow(segs, { targetSeconds: 40, maxSeconds: 50, overlapSeconds: 5 });
  for (const chunk of chunks) {
    for (const segId of chunk.segment_ids) {
      const seg = segs.find((s) => s.segment_id === segId);
      assert.ok(seg, `segment ${segId} should exist`);
      assert.ok(chunk.start_seconds <= seg.start_seconds, "chunk start should be <= segment start");
      assert.ok(chunk.end_seconds >= seg.end_seconds, "chunk end should be >= segment end");
    }
  }
});

test("semantic: without embeddingFn falls back to time-window", async () => {
  const segs = makeSegments(6);
  const chunks = await chunkBySemantic(segs, {});
  assert.ok(chunks.length >= 1);
});

test("semantic: with mock embeddingFn detects topic boundary", async () => {
  const segs = [
    ...makeSegments(3, "Cooking pasta with tomato sauce and basil", 10),
    ...makeSegments(3, "Programming in JavaScript and Python languages", 10),
  ];

  // Mock: cooking -> [1,0,0], programming -> [0,1,0]
  const mockEmbedFn = async (text) => {
    if (text.toLowerCase().includes("cooking")) return [1, 0, 0];
    return [0, 1, 0];
  };

  const chunks = await chunkBySemantic(segs, {
    embeddingFn: mockEmbedFn,
    threshold: 0.8,
    minSegments: 1,
    minTokens: 1,
    maxSegments: 20,
    maxSegments: 20,
  });
  assert.ok(chunks.length >= 2, `expected >= 2 chunks, got ${chunks.length}`);
  assert.ok(chunks[0].text.includes("Cooking"), "first chunk should be about cooking");
  assert.ok(chunks[1].text.includes("Programming"), "second chunk should be about programming");
});

test("chunkTranscript: dispatches to correct strategy", async () => {
  const segs = makeSegments(6);
  const twChunks = await chunkTranscript(segs, { strategy: "time-window", targetSeconds: 60 });
  assert.ok(twChunks.length >= 1);

  const semChunks = await chunkTranscript(segs, { strategy: "semantic" });
  assert.ok(semChunks.length >= 1);
});

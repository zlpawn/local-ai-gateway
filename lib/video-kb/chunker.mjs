/**
 * Transcript chunker: split transcript segments into retrieval-friendly chunks.
 *
 * Two strategies:
 * 1. time-window: aggregate segments by target time duration, respecting
 *    sentence boundaries, with overlap for retrieval continuity.
 * 2. semantic: use embeddings to detect topic shifts and split at those points.
 */

/**
 * Chunk transcript segments using time-window strategy.
 *
 * Rules:
 * - Segments are the atomic unit; never split within a segment.
 * - Accumulate consecutive segments until total duration >= targetSeconds.
 * - Force-split if duration would exceed maxSeconds.
 * - With overlapSeconds > 0, the next chunk starts from the last segment(s)
 *   that fall within the overlap window, so adjacent chunks share context.
 * - Trailing chunks that are too short merge into the previous chunk.
 */
export function chunkByTimeWindow(segments, {
  targetSeconds = 60,
  maxSeconds = 90,
  overlapSeconds = 5,
  minTokens = 50,
} = {}) {
  if (!segments || segments.length === 0) return [];

  const chunks = [];
  let i = 0;

  while (i < segments.length) {
    // Start a new chunk with segments[i]
    const startIdx = i;
    let endIdx = i;
    let chunkStart = segments[i].start_seconds;

    // Accumulate segments
    while (endIdx + 1 < segments.length) {
      const nextEnd = segments[endIdx + 1].end_seconds;
      const duration = nextEnd - chunkStart;
      if (duration > maxSeconds) break;
      endIdx++;
      if (duration >= targetSeconds) break;
    }

    const chunkSegments = segments.slice(startIdx, endIdx + 1);
    const text = chunkSegments.map((s) => s.text).join(" ");
    const tokenEstimate = estimateTokens(text);

    // If too short and there's a previous chunk, merge into it
    if (tokenEstimate < minTokens && chunks.length > 0 && endIdx + 1 >= segments.length) {
      const prev = chunks[chunks.length - 1];
      prev.text += " " + text;
      prev.end_seconds = chunkSegments[chunkSegments.length - 1].end_seconds;
      prev.segment_ids.push(...chunkSegments.map((s) => s.segment_id));
      break; // we've consumed all segments
    }

    chunks.push({
      chunk_id: `chunk-${String(chunks.length + 1).padStart(3, "0")}`,
      start_seconds: chunkSegments[0].start_seconds,
      end_seconds: chunkSegments[chunkSegments.length - 1].end_seconds,
      text,
      segment_ids: chunkSegments.map((s) => s.segment_id),
    });

    // Determine where the next chunk starts
    if (overlapSeconds > 0 && endIdx + 1 < segments.length && chunkSegments.length > 1) {
      // Find the earliest segment whose start is within the overlap window
      const overlapThreshold = chunks[chunks.length - 1].end_seconds - overlapSeconds;
      let nextStart = endIdx;
      while (nextStart > startIdx && segments[nextStart - 1].start_seconds >= overlapThreshold) {
        nextStart--;
      }
      i = nextStart;
    } else {
      i = endIdx + 1;
    }
  }

  return chunks;
}

/**
 * Chunk using semantic boundary detection.
 * Uses embeddings to compute similarity between consecutive segments.
 * When similarity drops below threshold (topic shift), a new chunk begins.
 */
export async function chunkBySemantic(segments, {
  embeddingFn = null,
  threshold = 0.65,
  minSegments = 2,
  maxSegments = 20,
  minTokens = 50,
} = {}) {
  if (!segments || segments.length === 0) return [];
  if (!embeddingFn) return chunkByTimeWindow(segments);

  // Compute embeddings for each segment
  const embeddings = [];
  for (const seg of segments) {
    if (!seg.text || seg.text.trim().length === 0) {
      embeddings.push(null);
      continue;
    }
    try {
      embeddings.push(await embeddingFn(seg.text));
    } catch {
      embeddings.push(null);
    }
  }

  // Compute similarity between consecutive segments
  const similarities = [];
  for (let i = 1; i < segments.length; i++) {
    if (!embeddings[i] || !embeddings[i - 1]) {
      similarities.push(0);
    } else {
      similarities.push(cosineSimilarity(embeddings[i - 1], embeddings[i]));
    }
  }

  // Find boundary points
  const boundaries = [0];
  let lastBoundary = 0;

  for (let i = 0; i < similarities.length; i++) {
    const segCount = (i + 1) - lastBoundary;
    const isBoundary = similarities[i] < threshold;
    const isTooLong = segCount >= maxSegments;

    if ((isBoundary || isTooLong) && segCount >= minSegments) {
      boundaries.push(i + 1);
      lastBoundary = i + 1;
    }
  }
  boundaries.push(segments.length);

  // Build chunks
  const chunks = [];
  for (let b = 0; b < boundaries.length - 1; b++) {
    const start = boundaries[b];
    const end = boundaries[b + 1];
    const chunkSegments = segments.slice(start, end);
    const text = chunkSegments.map((s) => s.text).join(" ");

    if (estimateTokens(text) < minTokens && chunks.length > 0) {
      const prev = chunks[chunks.length - 1];
      prev.text += " " + text;
      prev.end_seconds = chunkSegments[chunkSegments.length - 1].end_seconds;
      prev.segment_ids.push(...chunkSegments.map((s) => s.segment_id));
      continue;
    }

    chunks.push({
      chunk_id: `chunk-${String(chunks.length + 1).padStart(3, "0")}`,
      start_seconds: chunkSegments[0].start_seconds,
      end_seconds: chunkSegments[chunkSegments.length - 1].end_seconds,
      text,
      segment_ids: chunkSegments.map((s) => s.segment_id),
    });
  }

  return chunks;
}

/**
 * Main entry point - dispatches to the selected strategy.
 */
export async function chunkTranscript(segments, opts = {}) {
  const strategy = opts.strategy || "time-window";
  if (strategy === "semantic") {
    return chunkBySemantic(segments, opts);
  }
  return chunkByTimeWindow(segments, opts);
}

// --- helpers ---

function estimateTokens(text) {
  return Math.ceil(text.length / 3);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

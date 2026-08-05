/**
 * Video knowledge base pipeline - node-graph architecture.
 *
 * Each pipeline node is an independent unit with:
 *   { id, label, run(ctx, { signal, onProgress }) -> partial result }
 *
 * The pipeline executes nodes sequentially (by default), passing accumulated
 * context from one to the next. Nodes can be added, removed, or reordered
 * without modifying the pipeline core - it's data-driven.
 *
 * Built-in nodes: fetch_info, download_audio, download_video, transcribe,
 *                 chunk, vectorize
 *
 * The pipeline reports progress via onSteps() so the UI can show a
 * step-by-step progress panel with current/ completed/ pending states.
 */

import { fetchVideoInfo, downloadVideo, videoIdFromUrl } from "./downloader.mjs";
import { transcribe } from "./transcriber.mjs";
import { chunkTranscript } from "./chunker.mjs";
import { createVectorStore } from "./vector-store.mjs";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";

// --- Pipeline node registry ---
// Each node: { id, label, run(ctx, deps) -> Promise<partial> }
// ctx accumulates results from all previous nodes.

const DEFAULT_NODES = [
  {
    id: "fetch_info",
    label: "获取视频信息",
    weight: 0.05,
    async run(ctx, { signal }) {
      const info = await fetchVideoInfo(ctx.url, { cookieFile: ctx.cookieFile });
      return { info, videoId: videoIdFromUrl(ctx.url) };
    },
  },
  {
    id: "download_audio",
    label: "下载音轨",
    weight: 0.15,
    async run(ctx, { signal, onProgress }) {
      const audioDir = path.join(ctx.outputDir, "audio");
      const result = await downloadVideo(ctx.url, {
        cookieFile: ctx.cookieFile,
        outputDir: audioDir,
        audioOnly: true,
        signal,
        onProgress: (frac, msg) => onProgress(frac, msg),
      });
      return { audioPath: result.audioPath, audioInfo: result.info };
    },
  },
  {
    id: "download_video",
    label: "下载视频素材",
    weight: 0.10,
    async run(ctx, { signal, onProgress }) {
      // Skip if user doesn't want to keep the original video
      if (ctx.keepVideo === false) return { videoPath: null };
      const videoDir = path.join(ctx.outputDir, "video");
      const result = await downloadVideo(ctx.url, {
        cookieFile: ctx.cookieFile,
        outputDir: videoDir,
        audioOnly: false,
        signal,
        onProgress: (frac, msg) => onProgress(frac, msg),
      });
      return { videoPath: result.videoPath };
    },
  },
  {
    id: "transcribe",
    label: "语音转录",
    weight: 0.50,
    async run(ctx, { signal, onProgress }) {
      if (!ctx.audioPath) throw new Error("No audio file to transcribe");
      const transcriptDir = path.join(ctx.outputDir, "transcript");
      const result = await transcribe(ctx.audioPath, {
        tool: ctx.whisperTool,
        modelSize: ctx.whisperModel,
        language: ctx.language,
        outputDir: transcriptDir,
        signal,
        onProgress: (frac, msg) => onProgress(frac, msg),
      });
      return {
        segments: result.transcriptJson,
        transcriptTxt: result.transcriptTxt,
        transcriptTxtPath: result.transcriptTxtPath,
        srtPath: result.srtPath,
        detectedLanguage: result.detectedLanguage,
      };
    },
  },
  {
    id: "chunk",
    label: "文本分块",
    weight: 0.05,
    async run(ctx, { signal }) {
      if (!ctx.segments || ctx.segments.length === 0) {
        throw new Error("No transcript segments to chunk");
      }
      const chunks = await chunkTranscript(ctx.segments, {
        strategy: ctx.chunkStrategy || "time-window",
        embeddingFn: ctx.chunkStrategy === "semantic" ? ctx.embeddingFn : null,
        targetSeconds: ctx.chunkTargetSeconds || 60,
        maxSeconds: ctx.chunkMaxSeconds || 90,
        overlapSeconds: ctx.chunkOverlapSeconds || 5,
        threshold: ctx.chunkThreshold || 0.65,
      });
      return { chunks };
    },
  },
  {
    id: "vectorize",
    label: "向量化入库",
    weight: 0.15,
    async run(ctx, { signal, onProgress }) {
      if (!ctx.chunks || ctx.chunks.length === 0) {
        throw new Error("No chunks to vectorize");
      }
      const store = createVectorStore({
        dbPath: ctx.lanceDbPath,
        embeddingFn: ctx.embeddingFn,
      });

      // Determine embedding dimension from first chunk
      const firstVector = await ctx.embeddingFn(ctx.chunks[0].text);
      const dim = firstVector.length;
      await store.ensureTable(dim);

      // Build records with vectors
      const records = [];
      for (let i = 0; i < ctx.chunks.length; i++) {
        if (signal?.aborted) throw new Error("Vectorization cancelled");
        const chunk = ctx.chunks[i];
        const vector = i === 0 ? firstVector : await ctx.embeddingFn(chunk.text);
        records.push({
          chunk_id: chunk.chunk_id,
          video_id: ctx.videoId,
          video_url: ctx.url,
          video_title: ctx.info?.title || "untitled",
          chunk_index: i,
          start_seconds: chunk.start_seconds,
          end_seconds: chunk.end_seconds,
          text: chunk.text,
          segment_ids: chunk.segment_ids,
          language: ctx.detectedLanguage || "",
          created_at: Date.now(),
          vector,
        });
        if (onProgress) onProgress((i + 1) / ctx.chunks.length, `向量化 ${i + 1}/${ctx.chunks.length}`);
      }

      await store.upsertChunks(records, { dim });
      return { chunkCount: records.length, vectorDim: dim };
    },
  },
];

/**
 * Run the video KB pipeline.
 *
 * @param {object} payload - Pipeline configuration
 * @param {object} runtime - { signal, onProgress, onSteps }
 * @returns {Promise<object>} - Pipeline result summary
 */
export async function runVideoKbPipeline(payload, { signal, onProgress, onSteps } = {}) {
  const ctx = { ...payload };

  // Resolve output directory
  if (!ctx.outputDir) {
    throw new Error("outputDir is required");
  }
  if (!fs.existsSync(ctx.outputDir)) {
    fs.mkdirSync(ctx.outputDir, { recursive: true });
  }

  // Build step list for UI
  const nodes = ctx.customNodes || DEFAULT_NODES;
  const steps = nodes.map((node) => ({
    id: node.id,
    label: node.label,
    status: "pending",
    progress: 0,
    message: "",
  }));

  const reportSteps = (currentNodeId = null) => {
    onSteps?.(steps, currentNodeId);
  };
  reportSteps(steps[0]?.id || null);

  let cumulativeWeight = 0;
  const totalWeight = nodes.reduce((sum, n) => sum + n.weight, 1);

  // Execute nodes sequentially
  for (let i = 0; i < nodes.length; i++) {
    if (signal?.aborted) throw new Error("Pipeline cancelled");

    const node = nodes[i];
    steps[i].status = "running";
    reportSteps(node.id);

    const nodeStartWeight = cumulativeWeight;
    const nodeEndWeight = cumulativeWeight + node.weight;

    try {
      const nodeResult = await node.run(ctx, {
        signal,
        onProgress: (frac, msg) => {
          steps[i].progress = frac;
          steps[i].message = msg || "";
          const overallProgress = nodeStartWeight + frac * node.weight;
          onProgress?.(overallProgress / totalWeight, `${node.label}: ${msg || ""}`);
          reportSteps(node.id);
        },
      });

      // Merge node result into context
      Object.assign(ctx, nodeResult);
      steps[i].status = "done";
      steps[i].progress = 1;
      cumulativeWeight = nodeEndWeight;
      onProgress?.(cumulativeWeight / totalWeight, `${node.label} 完成`);
      reportSteps(nodes[i + 1]?.id || null);
    } catch (err) {
      steps[i].status = "failed";
      steps[i].message = err instanceof Error ? err.message : String(err);
      reportSteps(node.id);
      throw err;
    }
  }

  // Return summary
  return {
    video_id: ctx.videoId,
    title: ctx.info?.title || "untitled",
    duration: ctx.info?.duration || 0,
    uploader: ctx.info?.uploader || "",
    url: ctx.url,
    chunk_count: ctx.chunkCount || 0,
    detected_language: ctx.detectedLanguage || "",
    transcript_path: ctx.transcriptTxtPath || null,
    srt_path: ctx.srtPath || null,
    audio_path: ctx.audioPath || null,
    video_path: ctx.videoPath || null,
    info_path: ctx.info?.originalInfo ? path.join(ctx.outputDir, "audio", `${ctx.videoId}.info.json`) : null,
  };
}

/**
 * Get the default pipeline node definitions (for UI display).
 */
export function getPipelineNodes() {
  return DEFAULT_NODES.map((n) => ({ id: n.id, label: n.label, weight: n.weight }));
}

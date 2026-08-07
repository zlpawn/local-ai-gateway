/**
 * Video knowledge base pipeline - node-graph architecture.
 *
 * Built-in nodes:
 *   fetch_info, agent_reach_get, download_audio, download_video,
 *   transcribe, summarize, chunk, vectorize
 *
 * Users can select which steps to run. The pipeline validates dependencies
 * and only executes selected nodes.
 */

import { fetchVideoInfo, downloadVideo, videoIdFromUrl } from "./downloader.mjs";
import { transcribe } from "./transcriber.mjs";
import { chunkTranscript } from "./chunker.mjs";
import { createVectorStore } from "./vector-store.mjs";
import { createMetaStore } from "./meta-store.mjs";
import { generateVideoSummary, buildRuleSummary } from "./summarizer.mjs";
import { fetchContent } from "../content-reach/fetcher.mjs";
import { detectAgentReach } from "../content-reach/detector.mjs";
import path from "node:path";
import fs from "node:fs";

const NODE_DEFS = [
  {
    id: "fetch_info",
    label: "获取视频信息",
    weight: 0.05,
    defaultEnabled: true,
    requires: [],
    async run(ctx) {
      const info = await fetchVideoInfo(ctx.url, { cookieFile: ctx.cookieFile });
      const videoId = ctx.videoId || videoIdFromUrl(ctx.url);
      return {
        info,
        videoId,
        sourceTitle: info?.title || "untitled",
        displayTitle: ctx.displayTitle || info?.title || "untitled",
      };
    },
  },
  {
    id: "agent_reach_get",
    label: "Agent Reach 内容获取",
    weight: 0.08,
    defaultEnabled: false,
    requires: [],
    async run(ctx, { onProgress }) {
      const detection = await detectAgentReach();
      if (!detection?.installed) {
        onProgress?.(1, "Agent Reach 未安装，跳过");
        return { agentReachUsed: false };
      }
      onProgress?.(0.2, "正在获取内容...");
      try {
        const result = await fetchContent(ctx.url, { cookieFile: ctx.cookieFile });
        const text = String(result?.text || result?.content || result?.markdown || "").trim();
        if (!text) {
          onProgress?.(1, "未获取到可用正文");
          return { agentReachUsed: false };
        }
        const segments = textToSegments(text);
        onProgress?.(1, `获取成功，约 ${segments.length} 段`);
        return {
          agentReachUsed: true,
          skipDownload: ctx.selectedSteps?.includes("download_audio") || ctx.selectedSteps?.includes("download_video")
            ? false
            : true,
          skipTranscribe: true,
          segments,
          transcriptTxt: text,
          detectedLanguage: result?.language || ctx.detectedLanguage || "",
          sourceTitle: ctx.sourceTitle || result?.title || ctx.info?.title || "untitled",
          displayTitle: ctx.displayTitle || result?.title || ctx.info?.title || "untitled",
          info: ctx.info || {
            title: result?.title || "untitled",
            duration: 0,
            uploader: result?.author || "",
            url: ctx.url,
          },
        };
      } catch (err) {
        onProgress?.(1, `获取失败: ${err instanceof Error ? err.message : String(err)}`);
        return { agentReachUsed: false };
      }
    },
  },
  {
    id: "download_audio",
    label: "下载音轨",
    weight: 0.15,
    defaultEnabled: true,
    requires: [],
    async run(ctx, { signal, onProgress }) {
      if (ctx.skipDownload && ctx.segments?.length) {
        onProgress?.(1, "已有文本内容，跳过下载");
        return { audioPath: null, audioInfo: null };
      }
      const audioDir = path.join(ctx.outputDir, "audio");
      const result = await downloadVideo(ctx.url, {
        cookieFile: ctx.cookieFile,
        outputDir: audioDir,
        audioOnly: true,
        signal,
        onProgress: (frac, msg) => onProgress?.(frac, msg),
      });
      return {
        audioPath: result.audioPath,
        audioInfo: result.info,
        info: ctx.info || result.info,
        sourceTitle: ctx.sourceTitle || result.info?.title || "untitled",
        displayTitle: ctx.displayTitle || result.info?.title || "untitled",
        videoId: ctx.videoId || videoIdFromUrl(ctx.url),
      };
    },
  },
  {
    id: "download_video",
    label: "下载视频素材",
    weight: 0.10,
    defaultEnabled: true,
    requires: [],
    async run(ctx, { signal, onProgress }) {
      if (ctx.keepVideo === false) {
        onProgress?.(1, "用户选择不保留视频");
        return { videoPath: null };
      }
      if (ctx.skipDownload && !ctx.selectedSteps?.includes("download_video")) {
        return { videoPath: null };
      }
      const videoDir = path.join(ctx.outputDir, "video");
      const result = await downloadVideo(ctx.url, {
        cookieFile: ctx.cookieFile,
        outputDir: videoDir,
        audioOnly: false,
        signal,
        onProgress: (frac, msg) => onProgress?.(frac, msg),
      });
      return {
        videoPath: result.videoPath,
        info: ctx.info || result.info,
        sourceTitle: ctx.sourceTitle || result.info?.title || "untitled",
        displayTitle: ctx.displayTitle || result.info?.title || "untitled",
      };
    },
  },
  {
    id: "transcribe",
    label: "语音转录",
    weight: 0.42,
    defaultEnabled: true,
    requires: ["download_audio|agent_reach_get"],
    async run(ctx, { signal, onProgress }) {
      if (ctx.skipTranscribe && ctx.segments?.length) {
        onProgress?.(1, "使用已有文本内容");
        return {};
      }
      if (!ctx.audioPath) throw new Error("没有可转录的音频，请勾选“下载音轨”或“Agent Reach 内容获取”");
      const transcriptDir = path.join(ctx.outputDir, "transcript");
      const result = await transcribe(ctx.audioPath, {
        tool: ctx.whisperTool,
        modelSize: ctx.whisperModel,
        language: ctx.language,
        outputDir: transcriptDir,
        signal,
        onProgress: (frac, msg) => onProgress?.(frac, msg),
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
    id: "summarize",
    label: "生成摘要",
    weight: 0.08,
    defaultEnabled: true,
    requires: ["transcribe|agent_reach_get"],
    async run(ctx, { signal, onProgress }) {
      const transcript = String(
        ctx.transcriptTxt
        || (Array.isArray(ctx.segments) ? ctx.segments.map((s) => s.text).join("\n") : "")
        || "",
      ).trim();
      if (!transcript) throw new Error("没有可用于摘要的文本内容");

      onProgress?.(0.15, "生成摘要中...");
      let summary;
      if (typeof ctx.summaryFn === "function") {
        summary = await ctx.summaryFn({
          title: ctx.displayTitle || ctx.sourceTitle || ctx.info?.title || "untitled",
          transcript,
          description: ctx.info?.description || "",
          signal,
        });
      } else if (ctx.summaryModel) {
        summary = await generateVideoSummary({
          title: ctx.displayTitle || ctx.sourceTitle || ctx.info?.title || "untitled",
          transcript,
          description: ctx.info?.description || "",
          client: ctx.summaryClient || "code",
          model: ctx.summaryModel,
          listenPort: ctx.listenPort || 8787,
          signal,
        });
      } else {
        summary = buildRuleSummary({
          title: ctx.displayTitle || ctx.sourceTitle || ctx.info?.title || "untitled",
          transcript,
          description: ctx.info?.description || "",
        });
      }
      onProgress?.(1, "摘要完成");
      return {
        summaryShort: summary.summary_short || "",
        summaryFull: summary.summary_full || "",
        keyPoints: summary.key_points || [],
        topics: summary.topics || [],
        summarySource: summary.source || "llm",
      };
    },
  },
  {
    id: "chunk",
    label: "文本分块",
    weight: 0.05,
    defaultEnabled: true,
    requires: ["transcribe|agent_reach_get"],
    async run(ctx) {
      if (!ctx.segments || ctx.segments.length === 0) {
        throw new Error("没有可分块的转写内容");
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
    defaultEnabled: true,
    requires: ["chunk"],
    async run(ctx, { signal, onProgress }) {
      if (!ctx.chunks || ctx.chunks.length === 0) {
        throw new Error("没有可向量化的分块");
      }
      if (typeof ctx.embeddingFn !== "function") {
        throw new Error("缺少 embeddingFn，无法向量化");
      }

      const store = createVectorStore({
        dbPath: ctx.lanceDbPath,
        embeddingFn: ctx.embeddingFn,
      });

      console.error("[video-kb] vectorize: calling embeddingFn for first chunk, chunks:", ctx.chunks.length);
      const firstVector = await ctx.embeddingFn(ctx.chunks[0].text);
      const dim = firstVector.length;
      console.error("[video-kb] vectorize: embedding dim:", dim);
      await store.ensureTable(dim);

      const title = ctx.displayTitle || ctx.sourceTitle || ctx.info?.title || "untitled";
      const records = [];
      for (let i = 0; i < ctx.chunks.length; i++) {
        if (signal?.aborted) throw new Error("Vectorization cancelled");
        const chunk = ctx.chunks[i];
        const vector = i === 0 ? firstVector : await ctx.embeddingFn(chunk.text);
        if (i % 10 === 0) console.error("[video-kb] vectorize: processed", i + 1, "/", ctx.chunks.length);
        records.push({
          chunk_id: chunk.chunk_id,
          video_id: ctx.videoId,
          video_url: ctx.url,
          video_title: title,
          chunk_index: i,
          start_seconds: chunk.start_seconds,
          end_seconds: chunk.end_seconds,
          text: chunk.text,
          segment_ids: chunk.segment_ids,
          language: ctx.detectedLanguage || "",
          created_at: Date.now(),
          vector,
        });
        onProgress?.((i + 1) / ctx.chunks.length, `向量化 ${i + 1}/${ctx.chunks.length}`);
      }

      console.error("[video-kb] vectorize: upserting", records.length, "records");
      await store.upsertChunks(records, { dim });
      return { chunkCount: records.length, vectorDim: dim };
    },
  },
];

const NODE_MAP = new Map(NODE_DEFS.map((node) => [node.id, node]));

function textToSegments(text) {
  const sentences = String(text || "")
    .split(/[\u3002\uff01\uff1f.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const segments = [];
  const avgCharsPerSecond = 4;
  let currentTime = 0;
  for (let i = 0; i < sentences.length; i++) {
    const duration = Math.max(2, sentences[i].length / avgCharsPerSecond);
    segments.push({
      segment_id: `ASR-S${String(i + 1).padStart(4, "0")}`,
      start_seconds: currentTime,
      end_seconds: currentTime + duration,
      text: sentences[i],
    });
    currentTime += duration;
  }
  return segments;
}

function uniqueSteps(steps) {
  const seen = new Set();
  const out = [];
  for (const step of steps || []) {
    const id = String(step || "").trim();
    if (!id || seen.has(id) || !NODE_MAP.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function getDefaultSelectedSteps() {
  return NODE_DEFS.filter((n) => n.defaultEnabled).map((n) => n.id);
}

export function getPipelineNodes() {
  return NODE_DEFS.map((n) => ({
    id: n.id,
    label: n.label,
    weight: n.weight,
    default_enabled: n.defaultEnabled,
    requires: n.requires,
  }));
}

export function resolveSelectedSteps(inputSteps) {
  if (!Array.isArray(inputSteps) || inputSteps.length === 0) {
    return getDefaultSelectedSteps();
  }
  return uniqueSteps(inputSteps);
}

export function validateSelectedSteps(selectedSteps, payload = {}) {
  const steps = resolveSelectedSteps(selectedSteps);
  const set = new Set(steps);
  const issues = [];

  if (steps.length === 0) issues.push("至少选择一个导入步骤");

  for (const id of steps) {
    const node = NODE_MAP.get(id);
    if (!node) {
      issues.push(`未知步骤: ${id}`);
      continue;
    }
    for (const req of node.requires || []) {
      const options = String(req).split("|").map((s) => s.trim()).filter(Boolean);
      if (options.length === 0) continue;
      const ok = options.some((opt) => set.has(opt));
      if (!ok) {
        const labels = options.map((opt) => NODE_MAP.get(opt)?.label || opt).join(" 或 ");
        issues.push(`步骤“${node.label}”依赖: ${labels}`);
      }
    }
  }

  if (set.has("transcribe") && !set.has("download_audio") && !set.has("agent_reach_get")) {
    issues.push("语音转录需要“下载音轨”或“Agent Reach 内容获取”");
  }
  if ((set.has("summarize") || set.has("chunk") || set.has("vectorize"))
    && !set.has("transcribe")
    && !set.has("agent_reach_get")) {
    issues.push("摘要/分块/向量化需要文本来源：请勾选“语音转录”或“Agent Reach 内容获取”");
  }
  if (set.has("vectorize") && !set.has("chunk")) {
    issues.push("向量化入库需要“文本分块”");
  }
  if (set.has("transcribe") && !payload.whisperTool) {
    issues.push("已勾选语音转录，但未选择 Whisper 工具");
  }
  if (set.has("transcribe") && !payload.whisperModel) {
    issues.push("已勾选语音转录，但未选择 Whisper 模型");
  }
  if (set.has("vectorize") && !payload.embeddingEndpointId && typeof payload.embeddingFn !== "function") {
    issues.push("已勾选向量化入库，但未配置 Embedding 节点");
  }
  if (set.has("summarize") && !payload.summaryModel && typeof payload.summaryFn !== "function") {
    // allow rule fallback, but prefer warning-free path when model missing
  }

  return issues;
}

function resolveNodes(selectedSteps, customNodes = null) {
  const steps = resolveSelectedSteps(selectedSteps);
  if (Array.isArray(customNodes) && customNodes.length > 0) {
    const map = new Map(customNodes.map((node) => [node.id, node]));
    return steps.map((id) => map.get(id) || NODE_MAP.get(id)).filter(Boolean);
  }
  return steps.map((id) => NODE_MAP.get(id)).filter(Boolean);
}

function collectAssets(ctx) {
  return {
    audio_path: ctx.audioPath || null,
    video_path: ctx.videoPath || null,
    transcript_path: ctx.transcriptTxtPath || null,
    srt_path: ctx.srtPath || null,
  };
}

function persistMetadata(ctx, stepsDone) {
  if (!ctx.metaDbPath || !ctx.videoId) return null;
  const store = createMetaStore({ dbPath: ctx.metaDbPath });
  try {
    return store.upsertVideo({
      video_id: ctx.videoId,
      video_url: ctx.url,
      source_title: ctx.sourceTitle || ctx.info?.title || "untitled",
      display_title: ctx.displayTitle || ctx.sourceTitle || ctx.info?.title || "untitled",
      uploader: ctx.info?.uploader || "",
      duration: Number(ctx.info?.duration || 0),
      language: ctx.detectedLanguage || "",
      summary_short: ctx.summaryShort || "",
      summary_full: ctx.summaryFull || "",
      key_points: ctx.keyPoints || [],
      topics: ctx.topics || [],
      steps_done: stepsDone,
      assets: collectAssets(ctx),
      chunk_count: Number(ctx.chunkCount || 0),
      vector_dim: Number(ctx.vectorDim || 0),
      status: "ready",
    });
  } finally {
    store.close();
  }
}

export async function runVideoKbPipeline(payload, { signal, onProgress, onSteps } = {}) {
  const ctx = { ...payload };
  ctx.selectedSteps = resolveSelectedSteps(payload.selectedSteps || payload.steps || payload.enabled_steps);
  const issues = validateSelectedSteps(ctx.selectedSteps, ctx);
  if (issues.length) {
    throw new Error(issues.join("；"));
  }

  if (!ctx.outputDir) throw new Error("outputDir is required");
  if (!fs.existsSync(ctx.outputDir)) {
    fs.mkdirSync(ctx.outputDir, { recursive: true });
  }

  // Keep compatibility with older keepVideo semantics.
  if (ctx.keepVideo === false) {
    ctx.selectedSteps = ctx.selectedSteps.filter((id) => id !== "download_video");
  }

  const nodes = resolveNodes(ctx.selectedSteps, ctx.customNodes);
  console.error("[video-kb] pipeline start, nodes:", nodes.map((n) => n.id).join(","));
  console.error("[video-kb] outputDir:", ctx.outputDir);
  console.error("[video-kb] whisperTool:", ctx.whisperTool, "whisperModel:", ctx.whisperModel);

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
  const totalWeight = nodes.reduce((sum, n) => sum + (n.weight || 0), 0) || 1;

  for (let i = 0; i < nodes.length; i++) {
    if (signal?.aborted) throw new Error("Pipeline cancelled");
    const node = nodes[i];
    steps[i].status = "running";
    console.log(`[video-kb] pipeline: starting node "${node.id}"`);
    reportSteps(node.id);

    const nodeStartWeight = cumulativeWeight;
    const nodeEndWeight = cumulativeWeight + (node.weight || 0);

    try {
      console.error("[video-kb] node start:", node.id);
      const nodeResult = await node.run(ctx, {
        signal,
        onProgress: (frac, msg) => {
          const safeFrac = Math.max(0, Math.min(1, Number(frac) || 0));
          steps[i].progress = safeFrac;
          steps[i].message = msg || "";
          const overallProgress = nodeStartWeight + safeFrac * (node.weight || 0);
          onProgress?.(overallProgress / totalWeight, `${node.label}: ${msg || ""}`);
          reportSteps(node.id);
        },
      });

      Object.assign(ctx, nodeResult || {});
      steps[i].status = "done";
      steps[i].progress = 1;
      cumulativeWeight = nodeEndWeight;
      console.error("[video-kb] node done:", node.id, "result keys:", Object.keys(nodeResult || {}));
      console.log(`[video-kb] pipeline: completed node "${node.id}"`);
      onProgress?.(cumulativeWeight / totalWeight, `${node.label} 完成`);
      reportSteps(nodes[i + 1]?.id || null);
    } catch (err) {
      steps[i].status = "failed";
      steps[i].message = err instanceof Error ? err.message : String(err);
      console.error("[video-kb] node FAILED:", node.id, "error:", steps[i].message);
      console.log(`[video-kb] pipeline: failed node "${node.id}":`, steps[i].message);
      reportSteps(node.id);
      throw err;
    }
  }

  const doneStepIds = steps.filter((s) => s.status === "done").map((s) => s.id);
  let meta = null;
  try {
    meta = persistMetadata(ctx, doneStepIds);
  } catch (err) {
    console.error("[video-kb] persist metadata failed:", err instanceof Error ? err.message : String(err));
  }

  return {
    video_id: ctx.videoId,
    title: ctx.displayTitle || ctx.sourceTitle || ctx.info?.title || "untitled",
    source_title: ctx.sourceTitle || ctx.info?.title || "untitled",
    duration: ctx.info?.duration || 0,
    uploader: ctx.info?.uploader || "",
    url: ctx.url,
    chunk_count: ctx.chunkCount || 0,
    vector_dim: ctx.vectorDim || 0,
    detected_language: ctx.detectedLanguage || "",
    summary_short: ctx.summaryShort || meta?.summary_short || "",
    summary_full: ctx.summaryFull || meta?.summary_full || "",
    key_points: ctx.keyPoints || meta?.key_points || [],
    topics: ctx.topics || meta?.topics || [],
    steps_done: doneStepIds,
    transcript_path: ctx.transcriptTxtPath || null,
    srt_path: ctx.srtPath || null,
    audio_path: ctx.audioPath || null,
    video_path: ctx.videoPath || null,
    info_path: ctx.info?.originalInfo ? path.join(ctx.outputDir, "audio", `${ctx.videoId}.info.json`) : null,
  };
}

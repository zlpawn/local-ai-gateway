import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMetaStore } from "../../lib/video-kb/meta-store.mjs";
import {
  getDefaultSelectedSteps,
  resolveSelectedSteps,
  validateSelectedSteps,
  runVideoKbPipeline,
} from "../../lib/video-kb/pipeline.mjs";
import { buildRuleSummary, normalizeSummaryResult } from "../../lib/video-kb/summarizer.mjs";

function tmpDir(prefix = "video-kb-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("meta-store: upsert/list/update title and summary", () => {
  const dir = tmpDir("video-meta-");
  const dbPath = path.join(dir, "meta.sqlite");
  try {
    const store = createMetaStore({ dbPath });
    const created = store.upsertVideo({
      video_id: "v1",
      video_url: "https://example.com/v1",
      source_title: "5秒短视频",
      display_title: "5秒短视频",
      summary_short: "旧摘要",
      chunk_count: 2,
    });
    assert.equal(created.display_title, "5秒短视频");
    assert.equal(store.listVideos().length, 1);

    const renamed = store.updateTitle("v1", "西湖雨景");
    assert.equal(renamed.display_title, "西湖雨景");
    assert.equal(renamed.source_title, "5秒短视频");

    const summarized = store.updateSummary("v1", {
      summary_short: "雨中西湖的短记录",
      summary_full: "视频记录了西湖雨景与氛围。",
      key_points: ["西湖", "雨景"],
      topics: ["旅行"],
    });
    assert.equal(summarized.summary_short, "雨中西湖的短记录");
    assert.deepEqual(summarized.key_points, ["西湖", "雨景"]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: default steps and validation", () => {
  const defaults = getDefaultSelectedSteps();
  assert.ok(defaults.includes("fetch_info"));
  assert.ok(defaults.includes("summarize"));
  assert.ok(defaults.includes("vectorize"));
  assert.ok(!defaults.includes("agent_reach_get"));

  const selected = resolveSelectedSteps(["download_audio", "download_video", "download_audio"]);
  assert.deepEqual(selected, ["download_audio", "download_video"]);

  const ok = validateSelectedSteps(["fetch_info", "download_audio", "download_video"], {});
  assert.deepEqual(ok, []);

  const bad = validateSelectedSteps(["summarize"], {});
  assert.ok(bad.some((msg) => msg.includes("摘要")));
});

test("summarizer: rule fallback and normalize", () => {
  const rule = buildRuleSummary({
    title: "测试标题",
    transcript: "今天讲解了向量数据库的基础概念。接着演示了如何做视频摘要。",
  });
  assert.ok(rule.summary_short.length > 0);
  assert.ok(rule.summary_full.length > 0);

  const normalized = normalizeSummaryResult({
    summary_short: "短摘要",
    summary_full: "完整摘要",
    key_points: ["A", "B"],
    topics: ["C"],
  });
  assert.equal(normalized.summary_short, "短摘要");
  assert.deepEqual(normalized.key_points, ["A", "B"]);
});

test("pipeline: selected steps only download audio/video", async () => {
  const dir = tmpDir("video-pipe-");
  try {
    const calls = [];
    const customNodes = [
      {
        id: "fetch_info",
        label: "获取视频信息",
        weight: 0.2,
        async run() {
          calls.push("fetch_info");
          return {
            videoId: "demo1",
            info: { title: "demo title", duration: 12, uploader: "u" },
            sourceTitle: "demo title",
            displayTitle: "demo title",
          };
        },
      },
      {
        id: "download_audio",
        label: "下载音轨",
        weight: 0.4,
        async run() {
          calls.push("download_audio");
          return { audioPath: path.join(dir, "a.m4a") };
        },
      },
      {
        id: "download_video",
        label: "下载视频素材",
        weight: 0.4,
        async run() {
          calls.push("download_video");
          return { videoPath: path.join(dir, "v.mp4") };
        },
      },
      {
        id: "transcribe",
        label: "语音转录",
        weight: 1,
        async run() {
          calls.push("transcribe");
          return {};
        },
      },
    ];

    const result = await runVideoKbPipeline({
      url: "https://example.com/x",
      outputDir: dir,
      metaDbPath: path.join(dir, "meta.sqlite"),
      selectedSteps: ["fetch_info", "download_audio", "download_video"],
      customNodes,
    });

    assert.deepEqual(calls, ["fetch_info", "download_audio", "download_video"]);
    assert.equal(result.title, "demo title");
    assert.deepEqual(result.steps_done, ["fetch_info", "download_audio", "download_video"]);

    const store = createMetaStore({ dbPath: path.join(dir, "meta.sqlite") });
    const videos = store.listVideos();
    assert.equal(videos.length, 1);
    assert.equal(videos[0].display_title, "demo title");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

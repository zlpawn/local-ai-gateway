import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runVideoKbPipeline } from "../../lib/video-kb/pipeline.mjs";
import { createMetaStore } from "../../lib/video-kb/meta-store.mjs";

function tmpDir(prefix = "video-kb-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("pipeline failure message includes step tip", async () => {
  const dir = tmpDir("video-fail-");
  try {
    const customNodes = [
      {
        id: "fetch_info",
        label: "获取视频信息",
        weight: 1,
        async run() {
          throw new Error("yt-dlp info fetch failed (exit 1): HTTP Error 403: Forbidden cookie required");
        },
      },
    ];

    let failedStep = null;
    await assert.rejects(
      () => runVideoKbPipeline({
        url: "https://example.com/x",
        outputDir: dir,
        selectedSteps: ["fetch_info"],
        customNodes,
      }, {
        onSteps(steps) {
          failedStep = steps.find((s) => s.status === "failed") || failedStep;
        },
      }),
      (err) => {
        assert.match(String(err.message), /获取视频信息失败/);
        assert.match(String(err.message), /Cookie|cookie|登录/);
        return true;
      },
    );
    assert.ok(failedStep);
    assert.equal(failedStep.id, "fetch_info");
    assert.match(failedStep.message, /获取视频信息失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline respects displayTitle override", async () => {
  const dir = tmpDir("video-title-");
  try {
    const customNodes = [
      {
        id: "fetch_info",
        label: "获取视频信息",
        weight: 1,
        async run(ctx) {
          return {
            videoId: "v-title",
            info: { title: "源站标题", duration: 3, uploader: "u" },
            sourceTitle: "源站标题",
            displayTitle: ctx.displayTitle || "源站标题",
          };
        },
      },
    ];
    const result = await runVideoKbPipeline({
      url: "https://example.com/x",
      outputDir: dir,
      metaDbPath: path.join(dir, "meta.sqlite"),
      selectedSteps: ["fetch_info"],
      displayTitle: "我的自定义标题",
      customNodes,
    });
    assert.equal(result.title, "我的自定义标题");
    const store = createMetaStore({ dbPath: path.join(dir, "meta.sqlite") });
    const video = store.getVideo("v-title");
    assert.equal(video.display_title, "我的自定义标题");
    assert.equal(video.source_title, "源站标题");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

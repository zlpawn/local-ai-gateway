# Ingest 流水线规范

将视频转化为统一中间表示，供后续方法论提炼消费。一期只处理视频，但 schema 为后续文档/文章扩展留口。

## 1. 平台与工具探测

探测操作系统（仅 `windows` 或 `macos`）和基础媒体工具：

- `ffmpeg` / `ffprobe`：所有输入必需
- `yt-dlp`：URL 输入必需
- ASR 工具：`whisper-ctranslate2` 或 `mlx_whisper`（macOS Apple Silicon 优先）
- OCR 工具：`tesseract` 或 PaddleOCR（可选，用于 PPT 文字提取）

缺少必需工具时停止并报告缺项，不进入后续步骤。具体探测命令和路径规则参见 `leo-video-to-karpathy-wiki` 的 [platform-runtime.md](../../leo-video-to-karpathy-wiki/references/platform-runtime.md)。

运行 Manifest 的 schema 参见 `leo-video-to-karpathy-wiki` 的 [cleanup-policy.md](../../leo-video-to-karpathy-wiki/references/cleanup-policy.md)，包含 `run_id`、`status`、`temp_root`、`permanent_assets`、`temporary_files` 等字段。

## 2. 获取与归档源视频

1. 本地文件：按字节复制到临时目录并校验。
2. URL：使用 `yt-dlp --no-playlist` 下载，保留实际下载产物的扩展名。额外保存 `.info.json` 记录来源 URL、extractor、format ID、编码和下载时间。
3. 不修改扩展名；仅当用户明确要求时才转码。

## 3. ASR 转写

按平台选择 ASR 后端，先对短片段做能力测试再处理完整视频：

- Windows NVIDIA：CUDA 能力测试通过后使用 `whisper-ctranslate2 --device cuda`
- Windows 无 CUDA：`whisper-ctranslate2 --device cpu`
- macOS Apple Silicon：优先 `mlx_whisper`，失败回退 `whisper-ctranslate2 --device cpu`
- macOS Intel：`whisper-ctranslate2 --device cpu`

指定语言参数以提高准确率：中文课程使用 `--language zh`，英文课程使用 `--language en`，中英混合课程使用 `--language zh`（中文为主，英文术语穿插）。不指定时依赖 ASR 工具自动检测，但课程视频建议显式指定。

所有候选均失败则在运行 Manifest 中记录 `asr_status: failed` 并停止流水线（无 transcript 则无法提炼方法论），不得伪造字幕。

输出统一 Segment Schema（字段名与第 6 节统一中间表示一致）：

```json
{
  "id": "ASR-S0001",
  "start": 0.0,
  "end": 4.2,
  "text": "..."
}
```

验证：id 唯一，时间戳单调且位于视频时长内。

## 4. 确定性抽帧与 Slide 级去重

### 4.1 固定采样

- 起点 `00:00.000`
- 无条件提取首帧和结束前最后一个可解码帧
- 视频短于 2 小时：每 30.0 秒保底取样；否则每 45.0 秒
- 场景阈值：`select='gt(scene,0.3)'`

### 4.2 Slide 级去重（关键差异）

课程视频的 PPT 会长时间静止，固定间隔采样会产生大量近似帧。`leo-video-to-karpathy-wiki` 的 pHash 去重（汉明距离 <= 6、时间差 <= 2s）不足以处理这种情况，因为同一张 slide 停留 30 秒以上时，固定间隔会反复抽到同一张。

本 skill 在 pHash 去重基础上增加 slide 级聚类：

1. 对每个候选帧计算 pHash。
2. 新帧始终与当前 slide 组的代表帧比较 pHash 汉明距离（不与组内其他帧比较，避免链式合并）。距离 <= 6 则归入该组；否则以此帧为起点开启新组。
3. 每个 slide 组只保留一个代表帧：选择该组中场景变化最大或时间最早的帧。
4. 代表帧的 `slide_hash` 字段记录该组的 pHash 特征值。
5. 组内其他帧保留在临时目录但不进入视觉审计，不作为证据帧候选。

pHash 依赖不可用时禁用去重（`dedup_status: disabled_dependency_missing`），不使用未定义算法。

### 4.3 无 PPT 场景处理

部分课程视频为纯口述（talking-head）或白板书写，没有 PPT 幻灯片。此时：

- 场景检测（`gt(scene,0.3)`）产生的候选帧极少或为零，属于正常情况。
- `visual_evidence.frames` 为空数组，`visual_audit_status` 设为 `not_applicable`。
- 不影响后续流程：transcript 是主要信息源，visual_evidence 是补充。方法论提炼完全依赖 ASR 文本。
- 白板书写类视频如果场景变化频繁（讲者不断书写），可降低场景阈值至 `0.15` 增加采样密度，但仍使用 slide 级去重。

### 4.4 视觉审计

对每个代表帧执行 OCR（PaddleOCR / Tesseract）或模型图像理解，提取 PPT 上的文字。`visual_audit_status` 取值规则：`complete`（OCR 成功）、`blocked`（OCR 工具不可用，仍可继续）、`not_applicable`（无 PPT，见 4.3 节）、`failed`（工具可用但执行异常）。`asr_status` 同理：`complete`（转写成功）、`failed`（全部后端失败，流水线停止）。

## 5. 多视频合并

当输入为多个视频（如同一课程的 3 个述职视频）时：

1. 为每个视频独立执行第 2 节（获取归档）、第 3 节（ASR 转写）、第 4 节（抽帧去重视觉审计）。
2. 合并所有视频的 transcript segments，合并时 segment 的 `id` 加视频前缀保持唯一（如 `V1-ASR-S0001`、`V2-ASR-S0001`）。
3. 合并所有视频的 visual_evidence frames，frame 的 `id` 同理加视频前缀。
4. metadata 中记录 `video_count` 和每个视频的独立时长。
5. 不确定项合并为一个 `uncertain_items` 列表。

## 6. 统一中间表示

Ingest 层最终输出（单视频或多视频合并后），供方法论提炼消费：

```json
{
  "source": {
    "type": "video",
    "uris": ["https://video1...", "https://video2...", "https://video3..."],
    "metadata": {
      "video_count": 3,
      "duration_seconds": [580.2, 620.5, 523.8],
      "asr_tool": "mlx_whisper",
      "asr_model": "medium",
      "asr_device": "metal",
      "ocr_tool": "tesseract",
      "sampling_interval_seconds": 30.0,
      "scene_threshold": 0.3,
      "dedup_algorithm": "pHash + slide_clustering",
      "dedup_hamming_threshold": 6,
      "visual_audit_status": "complete",
      "asr_status": "complete"
    }
  },
  "transcript": {
    "segments": [
      {
        "id": "ASR-S0001",
        "start": 0.0,
        "end": 5.2,
        "text": "今天我们来讲结构化表达..."
      }
    ]
  },
  "visual_evidence": {
    "frames": [
      {
        "id": "FRAME-0001",
        "timestamp": 120.5,
        "ocr_text": "结构化表达三要素：结论先行、以上统下、归类分组",
        "slide_hash": "a1b2c3d4e5f6",
        "slide_group_size": 8
      }
    ]
  },
  "uncertain_items": [
    {
      "type": "asr",
      "ref": "ASR-S0035",
      "timestamp": "08:32.000",
      "description": "该片段有背景噪音，转写可能不准确"
    },
    {
      "type": "ocr",
      "ref": "FRAME-0012",
      "description": "PPT 右下角文字模糊，仅辨识出'...指标'"
    }
  ]
}
```

`slide_group_size` 记录该代表帧代表的原始帧数量，用于评估该 slide 停留时长。

## 7. 完成标准

- 源视频存在、大小大于 0、`ffprobe` 可读
- URL 输入有 `.info.json`
- transcript segments 非空、时间戳有效
- 候选帧已执行 slide 级去重，每个 slide 组有且仅有一个代表帧
- 统一中间表示 JSON 可解析、字段完整
- 模糊内容（OCR 识别不清的 PPT 文字、ASR 不确定的片段）进入 `uncertain_items`

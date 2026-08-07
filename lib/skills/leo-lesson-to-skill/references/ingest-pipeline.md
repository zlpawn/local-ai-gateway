# Ingest 流水线规范

将视频转化为统一中间表示，供后续方法论提炼消费。一期只处理视频，但 schema 为后续文档/文章扩展留口。

## 1. 平台与工具探测

探测操作系统（仅 `windows` 或 `macos`）和基础媒体工具：

- `ffmpeg` / `ffprobe`：所有输入必需
- `yt-dlp`：URL 输入必需
- ASR 工具：`whisper-ctranslate2` 或 `mlx_whisper`（macOS Apple Silicon 优先）
- OCR 工具：`tesseract` 或 PaddleOCR（可选，用于 PPT 文字提取）

缺少必需工具时停止并报告缺项，不进入后续步骤。具体探测命令和路径规则参见 `leo-video-to-karpathy-wiki` 的 [platform-runtime.md](../../leo-video-to-karpathy-wiki/references/platform-runtime.md)。

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

所有候选均失败则标记 `asr_status: failed`，不得伪造字幕。

输出统一 Segment Schema：

```json
{
  "segment_id": "ASR-S0001",
  "start_seconds": 0.0,
  "end_seconds": 4.2,
  "text": "..."
}
```

验证：segment_id 唯一，时间戳单调且位于视频时长内。

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
2. 不受时间差限制，只要 pHash 汉明距离 <= 6 就归为同一 slide 组。
3. 每个 slide 组只保留一个代表帧：选择该组中场景变化最大或时间最早的帧。
4. 代表帧的 `slide_hash` 字段记录该组的 pHash 特征值。
5. 组内其他帧不删除（审计可能需要），但不进入视觉审计，不作为证据帧候选。

pHash 依赖不可用时禁用去重（`dedup_status: disabled_dependency_missing`），不使用未定义算法。

### 4.3 视觉审计

对每个代表帧执行 OCR（PaddleOCR / Tesseract）或模型图像理解，提取 PPT 上的文字。OCR 不可用时 `visual_audit_status: blocked`，仍可继续（字幕是主要信息源，PPT 是补充）。

## 5. 统一中间表示

Ingest 层最终输出，供方法论提炼消费：

```json
{
  "source": {
    "type": "video",
    "uri": "https://...",
    "metadata": {
      "duration_seconds": 1724.5,
      "asr_tool": "mlx_whisper",
      "asr_model": "medium",
      "asr_device": "metal",
      "ocr_tool": "tesseract",
      "sampling_interval_seconds": 30.0,
      "scene_threshold": 0.3,
      "dedup_algorithm": "pHash + slide_clustering",
      "dedup_hamming_threshold": 6,
      "visual_audit_status": "complete"
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
  }
}
```

`slide_group_size` 记录该代表帧代表的原始帧数量，用于评估该 slide 停留时长。

## 6. 完成标准

- 源视频存在、大小大于 0、`ffprobe` 可读
- URL 输入有 `.info.json`
- transcript segments 非空、时间戳有效
- 候选帧已执行 slide 级去重，每个 slide 组有且仅有一个代表帧
- 统一中间表示 JSON 可解析、字段完整
- 模糊内容（OCR 识别不清的 PPT 文字、ASR 不确定的片段）进入 `uncertain_items`

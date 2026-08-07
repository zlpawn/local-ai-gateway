# Ingest Pipeline

Transform video into a unified intermediate representation for methodology extraction. Supports single or multiple videos.

## 1. Platform and Tool Detection

Detect OS (`windows` or `macos` only) and media tools:

- `ffmpeg` / `ffprobe`: required for all inputs
- `yt-dlp`: required for URL inputs
- ASR: `whisper-ctranslate2` or `mlx_whisper` (macOS Apple Silicon preferred)
- OCR: `tesseract` or PaddleOCR (optional, for PPT text)

Stop and report missing required tools. For detection commands, path rules, and temp directory conventions, read [platform-runtime.md](platform-runtime.md).

For run Manifest schema and cleanup rules, read [cleanup-policy.md](cleanup-policy.md).

## 2. Acquire and Archive Source Video

1. Local file: byte-copy to temp dir, verify.
2. URL: `yt-dlp --no-playlist` download, keep actual extension. Save `.info.json` (URL, extractor, format ID, codec, download time).
3. Do not change extension. Transcode only if user explicitly requests.

## 3. ASR Transcription

Test ASR backend on a short clip before processing full video:

- Windows NVIDIA: `whisper-ctranslate2 --device cuda` (only after CUDA test passes)
- Windows no CUDA: `whisper-ctranslate2 --device cpu`
- macOS Apple Silicon: prefer `mlx_whisper`, fall back to `whisper-ctranslate2 --device cpu`
- macOS Intel: `whisper-ctranslate2 --device cpu`

Specify language: `--language zh` for Chinese, `--language en` for English, `--language zh` for mixed (Chinese-dominant).

If all backends fail: record `asr_status: failed` in Manifest and stop pipeline (no transcript = no methodology). Never fabricate subtitles.

Output unified segment schema (field names match IR in section 6):

```json
{ "id": "ASR-S0001", "start": 0.0, "end": 4.2, "text": "..." }
```

Validate: id unique, timestamps monotonic and within video duration.

## 4. Frame Extraction and Slide-Level Dedup

### 4.1 Sampling

- Start at `00:00.000`
- Always extract first frame and last decodable frame
- Video < 2h: sample every 30.0s; otherwise every 45.0s
- Scene threshold: `select='gt(scene,0.3)'`

### 4.2 Slide-Level Dedup

Course videos have long-static PPTs. Standard pHash dedup (Hamming distance <= 6, time diff <= 2s) is insufficient.

Slide clustering algorithm:

1. Compute pHash for each candidate frame.
2. Compare new frame's pHash against the current slide group's representative frame only (not other frames in the group, to avoid chain merging). Distance <= 6: join group. Otherwise: start new group with this frame.
3. One representative per group: pick the earliest or highest-scene-change frame.
4. Representative's `slide_hash` = group pHash signature.
5. Non-representative frames stay in temp dir but skip visual audit.

If pHash unavailable: disable dedup (`dedup_status: disabled_dependency_missing`). Do not use undefined algorithms.

### 4.3 No-PPT Scenario

Some videos are talking-head or whiteboard only:

- Scene detection yields few or zero candidate frames. Normal.
- `visual_evidence.frames` = empty array, `visual_audit_status` = `not_applicable`.
- Pipeline continues: transcript is the primary source, visual is supplementary.
- For whiteboard videos with frequent changes, lower scene threshold to `0.15`.

### 4.4 Visual Audit

Run OCR on each representative frame. `visual_audit_status` enum: `complete` (OCR succeeded), `blocked` (OCR tool unavailable, continue), `not_applicable` (no PPT, see 4.3), `failed` (tool available but execution error). `asr_status` enum: `complete` (success), `failed` (all backends failed, pipeline stops).

## 5. Multi-Video Merge

For multiple videos (e.g., 3 videos from one course):

1. Run sections 2-4 independently per video.
2. Merge transcript segments. Prefix `id` with video index: `V1-ASR-S0001`, `V2-ASR-S0001`.
3. Merge visual_evidence frames. Prefix `id` similarly.
4. Record `video_count` and per-video durations in metadata.
5. Merge uncertain_items into one list.

## 6. Unified Intermediate Representation

```json
{
  "source": {
    "type": "video",
    "uris": ["https://video1...", "https://video2..."],
    "metadata": {
      "video_count": 3,
      "duration_seconds": [580.2, 620.5, 523.8],
      "asr_tool": "mlx_whisper",
      "asr_model": "medium",
      "asr_device": "metal",
      "asr_status": "complete",
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
      { "id": "V1-ASR-S0001", "start": 0.0, "end": 5.2, "text": "..." }
    ]
  },
  "visual_evidence": {
    "frames": [
      {
        "id": "V1-FRAME-0001", "timestamp": 120.5,
        "ocr_text": "结构化表达三要素：结论先行、以上统下、归类分组",
        "slide_hash": "a1b2c3d4e5f6", "slide_group_size": 8
      }
    ]
  },
  "uncertain_items": [
    { "type": "asr", "ref": "V1-ASR-S0035", "timestamp": "08:32.000", "description": "背景噪音，转写可能不准确" },
    { "type": "ocr", "ref": "V1-FRAME-0012", "description": "PPT 右下角文字模糊，仅辨识出'...指标'" }
  ]
}
```

## 7. Completion Criteria

- Source video exists, size > 0, `ffprobe` readable
- URL inputs have `.info.json`
- Transcript segments non-empty, timestamps valid
- Slide-level dedup executed, one representative per group
- IR valid JSON, all fields present
- Uncertain content in `uncertain_items`, not omitted

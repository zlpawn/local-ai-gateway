# 全时间轴覆盖审计账本规范 (Coverage-Complete Audit Schema Reference)

## 校验命名与完成标准 (Audit Naming & Metrics)

本 Skill 拒绝无法证明的绝对性化承诺，采用科学可校验的 **全时间轴覆盖审计 (Coverage-Complete Audit)**。

必须满足以下完成标准：
1. **时间轴覆盖率** = 100%（从 `00:00.000` 连续无缝覆盖至视频结束时间 `END`）。
   - **判定依据**：所有 `coverage_windows` 的并集必须无缝覆盖整个视频时长，不得存在任何空隙。
2. **候选帧审计率** = 100%。
3. **视觉审计状态**：`visual_audit_status` 必须为 `"complete"` | `"blocked"` | `"failed"`。
   - `"complete"` → `overall_status: "complete"`
   - `"blocked"` → `overall_status: "partial"`，仅允许声明“音频完全覆盖，视觉审计受阻部分完成”
   - `"failed"` → `overall_status: "failed"`，不得声明任务完成
4. **未确认项显式公开**：发音不清、板书模糊或有歧义的内容，必须显式列出，严禁隐瞒或脑补。

---

## 审计账本生成与冻结流程 (Draft to Freeze Pattern)

1. **步骤 6（草稿阶段）**：在专属临时目录 `temp_root` 中生成 `audit.draft.json` 与 `audit.draft.md`。
2. **步骤 8（终稿冻结）**：完成证据帧提升（移动至 `evidence_frames/`）、更新路径和引用后，将最终账本一次性写入 `raw/audits/` 并登记入 `permanent_assets`。**写入后不得再修改 Layer 1 资产**。

---

## JSON 账本 Schema

```json
{
  "audit_version": "2.0",
  "video_source": "raw/assets/2026-07-26-任务调度系统/source.mp4",
  "duration_seconds": 1724.5,
  "overall_status": "complete",
  "visual_audit_status": "complete",
  "coverage_complete": true,
  "extraction_config": {
    "platform": "windows",
    "os_version": "<detected-version>",
    "cpu_architecture": "x86_64",
    "ffmpeg_version": "<detected-version>",
    "asr_tool": "whisper-ctranslate2",
    "asr_tool_version": "<detected-version>",
    "asr_model": "medium",
    "asr_device": "cuda",
    "ocr_tool": "tesseract",
    "ocr_tool_version": "<detected-version>",
    "sampling_interval_seconds": 30.0,
    "scene_threshold": 0.3,
    "dedup_algorithm": "pHash",
    "dedup_implementation": "<library-and-version>",
    "dedup_hamming_threshold": 6,
    "dedup_window_seconds": 2.0,
    "tail_frame_included": true
  },
  "coverage_windows": [
    {
      "window_id": "WIN-0001",
      "start_seconds": 0.0,
      "end_seconds": 30.0,
      "asr_segment_ids": ["ASR-S0001", "ASR-S0002"],
      "frame_ids": ["FRAME-0001"],
      "audio_reviewed": true,
      "visual_reviewed": true,
      "status": "complete"
    }
  ],
  "frames": [
    {
      "frame_id": "FRAME-0058",
      "timestamp_seconds": 258.25,
      "candidate_path_at_review": "C:/Users/example/AppData/Local/Temp/video-to-karpathy-wiki/RUN_EXAMPLE/candidate_frames/frame_000418_250.jpg",
      "evidence_path": "D:/Knowledge/raw/assets/2026-07-26-任务调度系统/evidence_frames/frame_000418_250.jpg",
      "sha256": "<computed-sha256>",
      "ocr_text": "Data Store as Message Queue",
      "review_status": "complete",
      "used_as_evidence": true,
      "evidence_for": ["FACT-0017", "BLUEPRINT-0003"],
      "promoted": true,
      "retention": "permanent"
    }
  ],
  "segments": [
    {
      "segment_id": "ASR-S0042",
      "start_time": "04:15.200",
      "end_time": "04:22.800",
      "asr_text": "在数据库上实现队列的语义...",
      "associated_frame_ids": ["FRAME-0058"],
      "extracted_facts": ["讲述了 Data Store as MQ 的概念"],
      "uncertainties": []
    }
  ],
  "unconfirmed_items": [
    {
      "timestamp": "12:45.100",
      "description": "讲者在白板左下角简写的缩写字迹模糊，疑为 KSQL"
    }
  ]
}
```

未提升帧必须保留审核时的路径和哈希，但明确标记其生命周期：

```json
{
  "candidate_path_at_review": "/private/var/folders/.../candidate_frames/frame_000500_000.jpg",
  "sha256": "<computed-sha256>",
  "review_status": "complete",
  "used_as_evidence": false,
  "promoted": false,
  "retention": "temporary",
  "evidence_path": null
}
```

冻结账本中的 `candidate_path_at_review` 只是审核溯源记录，清理后可能不再存在，不得把它当作永久资源链接。

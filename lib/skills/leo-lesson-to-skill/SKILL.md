---
name: leo-lesson-to-skill
description: "将课程或教学视频中的方法论内化为可执行的新 skill。当用户说'把这个视频转成 skill''把这个课程方法论用起来'时使用。自动提炼方法论框架、生成 leo- 前缀的可执行 skill 并自测验证，让用户下次遇到相关场景直接调用 skill + 大模型完成工作。一期支持视频，后续扩展文档文章。"
---

# Leo Lesson to Skill

Turn course video methodology into a reusable, executable skill. The output is a new `leo-` skill the user can invoke next time, not a wiki or notes.

## Required Inputs

Require both:

- A video source: single or multiple URLs / local file paths.
- A target scenario: the specific work context the skill should serve (e.g., 年终述职, 项目周报, 问题分析).

If the course covers multiple scenarios, present the list and let the user pick one. One skill serves one scenario dimension.

## Non-Negotiable Rules

1. The output is a skill, not a wiki, summary, or knowledge base page.
2. Extract methodology faithfully: frameworks, steps, principles, and checkpoints from the speaker's own words. Do not invent content the speaker did not say.
3. Tag three layers explicitly in the generated skill: `📌 【讲者原话】` (faithful, with source refs), `🛠️ 【执行模板】` (meta-skill derived, not speaker's words), `✍️ 【模型发挥】` (model-generated content).
4. Lock the methodology skeleton (step sequence, checkpoints, anti-patterns). Free the content filling (wording, adaptation) for the model.
5. One scenario per skill. Do not mix 述职 and 汇报 into one skill.
6. Auto-test before delivery. The course's own methodology is the acceptance standard. Max 3 rounds of rework.
7. The generated skill must be self-contained, not depend on or reference this skill or any other skill.

## Workflow

### Step 1: Ingest and Analyze

Read [ingest-pipeline.md](references/ingest-pipeline.md) for the full pipeline.

1. Detect OS and media tools (ffmpeg, ffprobe, yt-dlp). Stop if missing.
2. Download or copy source video(s) to a temp directory. Save `.info.json` for URLs.
3. Run ASR with language parameter (`--language zh` for Chinese courses). Generate structured transcript (id, start, end, text).
4. Extract frames with slide-level dedup (one representative frame per slide). Read [ingest-pipeline.md](references/ingest-pipeline.md) section 4.2 for the dedup algorithm.
5. Run OCR on representative frames to extract PPT text.
6. Assemble unified intermediate representation (transcript + visual_evidence + uncertain_items).
7. For multiple videos: run steps 2-6 per video, merge into one IR with prefixed IDs.

Completion criterion: IR is valid JSON, transcript non-empty, uncertain items collected.

### Step 2: Extract Methodology

Read [methodology-extraction.md](references/methodology-extraction.md).

1. From the IR, identify: frameworks, steps, principles, checkpoints, scenarios, templates, anti-patterns.
2. Tag every item with source_refs (ASR segment ID or Frame ID).
3. Move unclear content to `uncertain_items`. Do not guess.
4. If multiple scenarios found, present list to user. Extract only the chosen scenario's methodology.

Completion criterion: every framework/step/principle has at least one source_refs. No invented content.

### Step 3: Design and Generate Skill

Read [skill-generation.md](references/skill-generation.md).

1. Determine skill type: prefer 执行型 (user drops info, skill produces output). Fall back to 指南型 only if methodology has no clear step sequence.
2. Name the skill: English kebab-case, `leo-` prefix. Name reflects scenario, not course name.
3. Design workflow skeleton: derive step sequence from methodology. Each step has input, action, output, checkpoint.
4. Generate SKILL.md (frontmatter + workflow + references).
5. Generate references/ files: framework (faithful), templates (meta-skill derived, tagged), checklist.
6. Generate `agents/openai.yaml`.

Completion criterion: skill files generated, three-layer tags present, no untagged speaker content mixed with derived content.

### Step 4: Auto-Test

Read [auto-test.md](references/auto-test.md).

1. Generate 1-2 mock scenarios from the methodology.
2. Run the generated skill against mock input.
3. Validate against methodology checklist: structure complete? Checkpoints passed? Anti-patterns avoided? Three-layer isolated?
4. If failed: locate root cause, fix one issue, retest. Max 3 rounds.
5. Present results to user for confirmation.

Completion criterion: at least 1 mock scenario passes all checklist items, or 3 rounds exhausted with clear issue list.

### Step 5: Deliver and Register

1. Copy generated skill to `~/.agents/skills/`.
2. Report: skill name, path, test results, usage example.
3. Clean temp files per [cleanup-policy.md](references/cleanup-policy.md). Require user authorization.

Completion criterion: skill installed and usable, user knows how to invoke, temp files handled.

## Generated Skill Structure

Example for a 述职 (performance review) scenario:

```
leo-performance-review/
  SKILL.md
  agents/
    openai.yaml
  references/
    述职框架.md
    述职模板.md
    检查清单.md
```

## Intermediate Representation Schema

The IR is Ingest output and methodology extraction input. Supports multi-source for future expansion:

```json
{
  "source": { "type": "video", "uris": ["..."], "metadata": {} },
  "transcript": { "segments": [{"id": "ASR-S0001", "start": 0.0, "end": 5.2, "text": "..."}] },
  "visual_evidence": { "frames": [{"id": "FRAME-0001", "timestamp": 120.5, "ocr_text": "...", "slide_hash": "..."}] },
  "uncertain_items": [{"type": "asr", "ref": "ASR-S0035", "description": "..."}]
}
```

Future document ingest: change `source.type` to `article` / `pdf` / `tweet`, replace transcript with document text, put images in `visual_evidence`. Core extraction and generation logic unchanged.

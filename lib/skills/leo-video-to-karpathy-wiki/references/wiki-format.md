# Karpathy LLM Wiki 格式标准 (Wiki Format Reference)

## 一、 知识库三层分层架构

1. **Layer 1 (Raw Store / 原始资产层)**：
   - 路径：`raw/assets/YYYY-MM-DD-主题/source.<ext>`（本地文件保留输入容器；URL 保存实际下载/合并容器，严禁仅重命名扩展名）
   - URL 输入额外保存来源 `.info.json`，用于记录 URL、extractor、format ID、编码和下载时间
   - 路径：`raw/assets/YYYY-MM-DD-主题/evidence_frames/`（存储 Wiki、账本引用的精选证据帧，命名如 `frame_000418_250.jpg`）
   - 路径：`raw/transcripts/YYYY-MM-DD-主题.transcript.json`（结构化带精确时间戳的 ASR 数据，含 `segment_id`, `start`, `end`, `text`）
   - 路径：`raw/transcripts/YYYY-MM-DD-主题.transcript.txt`（纯文本，方便阅读）
   - 路径：`raw/audits/YYYY-MM-DD-主题.audit.json` / `audit.md`（全时间轴覆盖审计账本）
   - **规则**：草稿不得直接写成 Layer 1 最终文件；通过同目录临时文件校验并原子发布后，最终资产永久保留，严禁修改或删除。

2. **Layer 2 (Wiki Page / 知识呈现层)**：
   - 路径：`系统设计/YYYYMMDD_主题.md`（或 `技术专题/YYYYMMDD_主题.md`）
   - **规则**：高信息密度、第一性原理、明确三层事实隔离（原视频事实/合理推导/延伸实现）。

3. **Layer 3 (Maintenance / 索引日志层)**：
   - 路径：`index.md`（全库 Wiki 导航）与 `log.md`（版本运维日志）

---

## 二、 YAML Frontmatter 标准模板

```yaml
---
title: 中文主题名称
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: system
tags: [系统设计, 架构, 领域标签]
aliases: [English Title, YYYYMMDD_主题]
---
```

---

## 三、 文档三大板块结构标准

### 1. 🎯 基于证据的忠实蓝图重建 (Evidence-Backed Blueprint)
用 ASCII/Text 代码框忠实重建讲者在原视频白板上书写的英文关键词、推理逻辑链条与架构拓扑。
- **规则**：只还原有 Frame ID 或 Segment ID 支持的内容；模糊字符统一保留 `[?]`；不补充讲者未展示的节点。严禁在存在未确认项时宣称“1:1”还原。

### 2. 核心内容三层隔离标注（杜绝 AI 幻觉）
- 必须使用显式块引用，严格区分：
  - `📌 【原视频事实】`：包含时间戳与 Segment ID 证据（如 `ASR-S0042 [04:15.200-04:22.800]` 或 `FRAME-0058 [04:18.000]`）。
  - `💡 【合理推导】`：基于讲者原意推导，显式标注“推导”。
  - `🛠️ 【延伸工程实现】`：Agent 补充的生产级代码或 SQL，严禁称为讲者原方案。

### 3. 图片引用语法
正文统一使用相对 Markdown 图片路径引用证据帧：
`![图1：网络架构](../raw/assets/YYYY-MM-DD-主题/evidence_frames/frame_000418_250.jpg)`
*(注意：正文中请勿并列写 Obsidian Wikilink，避免部分渲染器重复展示两张相同图片)*

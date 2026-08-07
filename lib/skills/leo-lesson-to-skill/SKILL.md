---
name: leo-lesson-to-skill
description: "将课程或教学视频中的方法论内化为可执行的新 skill。当用户说'把这个视频转成 skill''把这个课程方法论用起来'时使用。自动提炼方法论框架、生成 leo- 前缀的可执行 skill 并自测验证，让用户下次遇到相关场景直接调用 skill + 大模型完成工作。一期支持视频，后续扩展文档文章。"
---

# Leo Lesson to Skill

将课程视频中的方法论内化为可执行的新 skill，让用户从"学过"变成"能用起来"。

## 解决什么问题

用户学完一门课程（结构化表达、述职技巧、项目管理方法论等），知道框架但实际工作时想不起来用、不会用。这个 skill 把课程视频里的方法论提炼出来，自动生成一个可执行的 `leo-` skill。下次用户遇到相关场景，直接调用生成的 skill + 大模型就能完成工作。

## 与其他 skill 的区别

- `leo-video-to-karpathy-wiki`：视频 -> 知识 Wiki，目的是归档可查，重审计。止步于"记下来"。
- `leo-internalize-knowledge`：文档 -> 知识库页面，目的是内化沉淀。
- 本 skill：课程视频 -> 可执行 skill，目的是"把方法论变成能调用的能力"。重点是生成一个下次能用的 skill，不是写笔记。

## 核心原则

1. **执行优先**：生成的 skill 要能帮用户直接干活，不只是给框架。锁方法论骨架（流程/步骤/检查点），放开内容填充（措辞/适配）给大模型。
2. **忠实搬运框架**：讲者的框架、步骤、原则原样提取，不脑补。meta-skill 在框架之上构建的执行模板和工作流，在生成的 skill 中标注为"meta-skill 加工"，不冒充讲者原话。
3. **一个维度一个 skill**：述职是一个 skill，汇报是另一个 skill。一个课程如果覆盖多个场景，先确认用户要哪个方向，不要混在一个 skill 里。生成的 skill 支持目录拆分模块，内容不全部堆在 SKILL.md 里。
4. **自动测试**：生成完必须自测，用课程自身的方法论当验收标准。不合格回炉，最多 3 轮。

## 四步流水线

### 步骤 1：Ingest 与分析

获取视频、转写、抽帧、提炼方法论。按需读取并遵守 [ingest-pipeline.md](references/ingest-pipeline.md)。

1. 探测操作系统和基础媒体工具（ffmpeg、ffprobe、yt-dlp），缺少必需工具时停止并报告。
2. 确定输入源（单个或多个 URL / 本地文件），创建运行 Manifest 和临时目录。多视频输入时为每个视频独立执行步骤 3-7，最终合并为一份统一中间表示。
3. 下载或复制源视频到临时目录，URL 输入额外保存 `.info.json`。
4. 执行 ASR 转写（中文课程需指定语言参数），生成结构化 transcript（含 id、时间戳、文本）。
5. 执行确定性抽帧，使用 slide 级去重（同一张幻灯片只保留一个代表帧）。
6. 对代表帧执行视觉审计（OCR 提取 PPT 文字）。
7. 将 ASR + 视觉证据合成统一中间表示。
8. 从统一中间表示中提炼方法论：框架、步骤、原则、检查点、场景模板。按需读取并遵守 [methodology-extraction.md](references/methodology-extraction.md)。

完成标准：统一中间表示完整可解析，方法论提炼覆盖视频中所有可辨识的方法论内容，模糊内容进入 `uncertain_items`。

### 步骤 2：Skill 设计

根据提炼出的方法论，设计 skill 的结构和形态。

1. 判断 skill 类型：优先执行型（用户丢料就能出活），方法论本身没有明确流程时回退指南型（框架 + 检查点）。
2. 确定 skill 命名：英文 kebab-case，`leo-` 前缀，中文 description。
3. 设计工作流骨架：从方法论推导出用户使用这个 skill 时的步骤序列，每步有明确输入输出和检查点。
4. 设计模块拆分：SKILL.md 写入口和总流程，references/ 按模块放框架、模板、检查清单。
5. 划分三层内容：讲者原样框架（忠实搬运）、meta-skill 加工的执行模板（标注）、大模型自由发挥区（标注）。

完成标准：skill 目录结构、命名、工作流骨架、模块拆分方案已确定，三层内容边界清晰。

### 步骤 3：Skill 生成与自测

写文件并自动测试。按需读取并遵守 [skill-generation.md](references/skill-generation.md) 和 [auto-test.md](references/auto-test.md)。

1. 生成 SKILL.md：包含中文 description、工作流骨架、使用说明。锁死方法论骨架，放开内容填充。
2. 生成 references/ 下的分模块文件：框架、模板、检查清单等。
3. 自动测试：
   - 根据方法论生成 1-2 个模拟场景和 mock 输入。
   - 用生成的 skill 跑 mock 输入，产出结果。
   - 用方法论框架做 checklist 验收：结构是否完整？每步是否满足检查点？有没有跑偏？
   - 不合格则定位问题、回炉调整 skill 内容，重测。最多 3 轮。
4. 测试通过后，展示生成的 skill 结构和测试结果摘要给用户确认。

完成标准：skill 文件全部生成，自测通过或已达 3 轮上限（标记问题让用户介入）。

### 步骤 4：交付与注册

1. 将生成的 skill 复制到 `~/.agents/skills/` 目录（Codex skill 的 single source of truth）。如果是在项目中开发，同时提交到项目的 `lib/skills/` 目录。
2. 本地生成的 skill 不需要写入 `.skill-lock.json`（该文件仅用于外部安装的 skill 注册）。
3. 报告：skill 名称、路径、测试结果、使用方式示例。
4. 清理临时文件（遵循 leo-video-to-karpathy-wiki 的 cleanup-policy 规范，需用户授权）。

完成标准：skill 已安装可用，用户知道怎么调用，临时文件已处理。

## 生成的 skill 长什么样

以述职场景为例：

```
leo-performance-review/
  SKILL.md              # 中文 description + 工作流骨架（锁死方法论流程）
  references/
    述职框架.md          # 讲者原样框架（忠实搬运）
    述职模板.md          # 各场景模板（meta-skill 加工，标注）
    检查清单.md          # 方法论验收 checklist
```

SKILL.md 内部结构：
- frontmatter（name + 中文 description）
- 使用场景说明
- 工作流步骤（锁死的方法论骨架，每步有输入/输出/检查点）
- references 引用

## 扩展性设计

统一中间表示是 Ingest 层的输出、后续所有步骤的输入。一期只有视频 ingest，但 schema 已为后续扩展留口：

```json
{
  "source": {
    "type": "video",
    "uri": "...",
    "metadata": {}
  },
  "transcript": {
    "segments": [
      {"id": "ASR-S0001", "start": 0.0, "end": 5.2, "text": "..."}
    ]
  },
  "visual_evidence": {
    "frames": [
      {"id": "FRAME-0001", "timestamp": 120.5, "ocr_text": "...", "slide_hash": "..."}
    ]
  }
}
```

后续扩展文档 ingest 时，`source.type` 换成 `article` / `pdf` / `tweet`，`transcript` 换成文档正文，`visual_evidence` 放文档中的图片/图表，核心的提炼和生成逻辑不动。

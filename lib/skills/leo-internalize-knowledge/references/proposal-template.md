# Knowledge Proposal Template

Write the proposal into `proposal/knowledge-proposal.md` and present its high-signal contents to the user. Preserve the source language unless the user requests another language.

```markdown
# 知识内化提案：<source title>

状态：READY | BLOCKED
目标知识库：<root>
验证模式：none | light | targeted

## 1. 来源与读取完整性

- 来源、作者/组织、时间、版本
- 读取方式与范围
- 文本、表格、代码、图片、白板、嵌入资源、附件统计
- 未读取或读取不完整的内容

## 2. 文档结构

<完整层级大纲，标出 load-bearing 部分>

## 3. 核心主张

<业务问题、约束、架构、机制、演进因果、指标、边界>

## 4. 核心图片理解

### 核心图片 1：<name>

- <3-6 条专业理解>

来源块：<anchor>
重要性：load-bearing
读取状态：complete
理解置信度：high | medium | low
知识去向：<page roles>

## 5. 文本与图片交叉验证

<一致、补充、冲突、缺失>

## 6. 工程判断

### 原作者明确主张
<faithful claims>

### 知识化综合
<cross-section synthesis>

### Agent 工程评估
<合理性、缺失条件、风险、可改进点、面试追问>

## 7. 一手资料比对

<仅记录有价值的选择性验证；无则说明未执行及原因>

## 8. 建议新增页面

| 页面 | 角色 | 核心问题 | 主要来源 | 关键链接 |
|---|---|---|---|---|

## 9. 建议更新页面

| 现有页面 | 更新内容 | 原因 |
|---|---|---|

## 10. 明确不创建

<避免重复、粒度过细或证据不足的页面及原因>

## 11. 内容覆盖矩阵

<every source section>

## 12. 媒体覆盖矩阵

<every discovered media item>

## 13. 缺口、冲突与不确定性

<blocking and non-blocking gaps>

## 14. 待确认的入库动作

<exact files/pages/assets to create or update>
```

## Page Design Heuristics

Use as few pages as necessary, but enough to preserve reusable conceptual boundaries.

- `source`: faithful snapshot, metadata, anchors, and local media references.
- `system`: end-to-end problem, architecture, evolution, operations, and trade-offs.
- `concept`: reusable mechanism independent of the source project.
- `method`: repeatable engineering process or evaluation method.
- `query`: a durable question with a synthesized answer.
- `comparison`: alternatives with explicit dimensions and conditions.

Do not create every role mechanically. Follow the target root's vocabulary and templates.

## Explanation Quality

Interview-ready content should cover:

1. Context and constraints
2. Why the earlier approach failed
3. Decision and architecture
4. Key mechanisms and difficult trade-offs
5. Evidence and results with conditions
6. Boundaries, risks, and next steps

Newcomer-facing sharing should define terms and establish prerequisites, but remain technically precise. Explain causal evolution rather than listing versions. Avoid analogy unless requested.

The final knowledge should read as a compact executable model of the topic, not a chapter-by-chapter abstract. A reader should be able to derive why each design decision follows from its constraints and where that conclusion stops applying.

# 浅色高对比度 SVG 渲染规范 (Light-Theme SVG Style Reference)

## 规范覆盖指示 (Style Rule Notice)

本规范定义专属浅色主题 (Light-Theme) 渲染样式。若当前工作区安装了默认暗色背景的渲染工具（如 `baoyu-diagram`），必须覆盖其背景与颜色参数，遵循本规范输出浅色 SVG。

---

## 浅色配色设计系统

* **画布背景 (Canvas Background)**：纯白 `#FFFFFF` 或 极浅灰 `#FAFAFA`
* **节点描边 (Node Border)**：深灰 `#333333` 或 语义高对比度色彩 (2px)
* **主标题文字 (Title)**：`font-size="20"` `font-weight="bold"` `fill="#111111"`
* **节点正文文字 (Body)**：`font-size="14"` `fill="#222222"`（绝对禁止小于 12px 的模糊小字）
* **语义节点填充 (Node Fill)**：
  * 客户端/接入层：浅蓝 `#E3F2FD` (Stroke `#1976D2`)
  * 数据存储/数据库：浅绿 `#E8F5E9` (Stroke `#388E3C`)
  * 队列/处理节点：浅紫 `#F3E5F5` (Stroke `#7B1FA2`)
  * 错误/警示节点：浅红 `#FFEBEE` (Stroke `#D32F2F`)

---

## SVG 渲染要点与检验

1. 必须使用标准 XML/SVG 结构，设置 `viewBox="0 0 1000 600"` 并自适应宽度 `width="100%"`。
2. 所有节点文字必须居中对齐或有明确 Padding，禁止文本重叠或越出节点边框。
3. 箭头与连接线必须使用高对比度颜色 (`#555555`) 并带有 `marker-end` 箭头标示。

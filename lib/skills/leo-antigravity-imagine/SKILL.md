---
name: leo-antigravity-imagine
description: 通过网关 Antigravity 订阅节点调用 Google Gemini 图片生成能力（gemini-3.1-flash-image），进行文生图和参考图生成。
---

# Antigravity Imagine Skill (网关 Antigravity 订阅图片生成)

## 使用场景
当用户表达以下意图时触发：
- "用 Antigravity 生成图片" / "用 Gemini 画一张图" / "用 Google 生成图片"
- "参考这张图生成" / "基于这张图改风格"

## 依赖与前提条件
1. **鉴权凭证**: 本技能不接收也不存储任何 API Key。网关路由 `/v1/media/image` 会自动读取 `antigravity.secrets.json` 中的 OAuth token（含自动刷新）。
   - 若运行时提示鉴权失败，请到网关配置面板「接入 Antigravity 订阅」迷你工具完成登录。
2. **网关运行**: 本技能脚本调用 `http://127.0.0.1:8787/v1/media/image`，需要网关正在运行。
3. **节点配置**: 需在网关配置面板为某个 client 添加 `purpose=image_generation`、`provider=antigravity` 的节点。

## 脚本调度路径
- Antigravity: `node ~/.gemini/config/skills/leo-antigravity-imagine/scripts/leo_antigravity_imagine.mjs`
- Claude: `node ~/.claude/skills/leo-antigravity-imagine/scripts/leo_antigravity_imagine.mjs`
- Codex: `node ~/.codex/skills/leo-antigravity-imagine/scripts/leo_antigravity_imagine.mjs`
- 中央库: `node ~/.agents/skills/leo-antigravity-imagine/scripts/leo_antigravity_imagine.mjs`

## 命令行参数与用法示例

### 1. 文生图 (Text to Image)
```bash
node ~/.agents/skills/leo-antigravity-imagine/scripts/leo_antigravity_imagine.mjs --prompt "赛博朋克风的未来城市夜景" --aspect-ratio "16:9"
```

### 2. 参考图生成 (Reference Image Generation, 最多 3 张)
```bash
node ~/.agents/skills/leo-antigravity-imagine/scripts/leo_antigravity_imagine.mjs --prompt "保持人物特征，转为水彩画风格" --images "/path/face.jpg,/path/style.jpg"
```

### 3. 指定画面比例
```bash
node ~/.agents/skills/leo-antigravity-imagine/scripts/leo_antigravity_imagine.mjs --prompt "竖屏壁纸" --aspect-ratio "9:16"
```

### 4. 预检模式 (--dry-run)
```bash
node ~/.agents/skills/leo-antigravity-imagine/scripts/leo_antigravity_imagine.mjs --prompt "测试" --dry-run
```

## 参数说明
| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--prompt` | 图片描述提示词（必填） | - |
| `--images` | 参考图路径，逗号分隔（最多 3 张） | - |
| `--image-name` | 自定义输出文件名 | 自动生成 |
| `--aspect-ratio` | 画面比例 (1:1/2:3/3:2/3:4/4:3/9:16/16:9) | auto |
| `--output-dir` | 输出目录 | ./images |
| `--filename` | 自定义文件名 | 自动生成 |
| `--endpoint-id` | 指定节点 ID | 默认节点 |
| `--dry-run` | 预检模式，不实际生成 | false |

## 输出目录与文件命名
- 默认存储在 `./images/` 目录下，文件名格式：`antigravity_<提示词缩写>_<YYYYMMDDHHmmss>.png`

## Agent 回传与渲染规则
脚本成功后输出 Markdown 图片链接，Agent 必须将其原样包含在回复中：
```
![Generated Image](/absolute/path/to/image.png)
```

## 异常处理
- **鉴权失败 / 503 Capacity Exhausted**: 提示用户 Google 云端负载过高，稍后重试，或到网关配置面板确认 Antigravity 订阅登录状态。
- **节点未配置**: 提示用户添加 `purpose=image_generation`、`provider=antigravity` 的节点。

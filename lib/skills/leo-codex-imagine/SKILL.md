---
name: leo-codex-imagine
description: 通过网关 Codex 订阅节点调用 ChatGPT 内置图片生成能力（gpt-image），进行文生图和参考图编辑。
---

# Codex Imagine Skill (网关 Codex 订阅图片生成)

## 使用场景
当用户表达以下意图时触发：
- "用 Codex 画一张图" / "用 ChatGPT 生成图片" / "用 Codex 生成一张..."
- "基于这张图修改" / "参考这张图生成"

## 依赖与前提条件
1. **鉴权凭证**: 本技能不接收也不存储任何 API Key。网关路由 `/v1/media/image` 会自动读取本机 `~/.codex/auth.json` 的 Codex 订阅登录态。
   - 若运行时提示鉴权失败，请到网关配置面板「接入 Codex 订阅」迷你工具确认登录状态。
2. **网关运行**: 本技能脚本调用 `http://127.0.0.1:8787/v1/media/image`，需要网关正在运行。
3. **节点配置**: 需在网关配置面板为某个 client 添加 `purpose=image_generation`、`provider=codex-subscription` 的节点。

## 脚本调度路径
- Antigravity: `node ~/.gemini/config/skills/leo-codex-imagine/scripts/leo_codex_imagine.mjs`
- Claude: `node ~/.claude/skills/leo-codex-imagine/scripts/leo_codex_imagine.mjs`
- Codex: `node ~/.codex/skills/leo-codex-imagine/scripts/leo_codex_imagine.mjs`
- 中央库: `node ~/.agents/skills/leo-codex-imagine/scripts/leo_codex_imagine.mjs`

## 命令行参数与用法示例

### 1. 文生图 (Text to Image)
```bash
node ~/.agents/skills/leo-codex-imagine/scripts/leo_codex_imagine.mjs --prompt "赛博朋克风的未来城市夜景，霓虹灯光" --aspect-ratio "16:9"
```

### 2. 参考图编辑 (Image Edit)
```bash
node ~/.agents/skills/leo-codex-imagine/scripts/leo_codex_imagine.mjs --prompt "给图中的猫咪戴上一顶海盗帽" --images "/path/cat.jpg"
```

### 3. 指定尺寸与质量
```bash
node ~/.agents/skills/leo-codex-imagine/scripts/leo_codex_imagine.mjs --prompt "高清产品图" --size 1024x1024 --quality high
```

### 4. 预检模式 (--dry-run)
```bash
node ~/.agents/skills/leo-codex-imagine/scripts/leo_codex_imagine.mjs --prompt "测试" --dry-run
```

## 参数说明
| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--prompt` | 图片描述提示词（必填） | - |
| `--images` / `--image` | 参考图路径，逗号分隔 | - |
| `--aspect-ratio` | 画面比例 | auto |
| `--size` | 图片尺寸 | auto |
| `--quality` | 质量 (low/medium/high) | medium |
| `--output-dir` | 输出目录 | ./images |
| `--filename` | 自定义文件名 | 自动生成 |
| `--endpoint-id` | 指定节点 ID | 默认节点 |
| `--dry-run` | 预检模式，不实际生成 | false |

## 输出目录与文件命名
- 默认存储在 `./images/` 目录下，文件名格式：`codex_<提示词缩写>_<YYYYMMDDHHmmss>.png`

## Agent 回传与渲染规则
脚本成功后输出 Markdown 图片链接，Agent 必须将其原样包含在回复中：
```
![Generated Image](/absolute/path/to/image.png)
```

## 异常处理
- **鉴权失败**: 提示用户到网关配置面板确认 Codex 订阅登录状态。
- **节点未配置**: 提示用户添加 `purpose=image_generation`、`provider=codex-subscription` 的节点。

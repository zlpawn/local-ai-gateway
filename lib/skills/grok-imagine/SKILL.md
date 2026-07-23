---
name: grok-imagine
description: 使用用户的 Grok 订阅凭证，进行文生图、图生图（修改图）、文生视频、图生视频及多参考图动图生成。
---

# Grok Imagine Multi-Modal Skill

## 使用场景
当用户表达以下意图或在聊天中使用指令时触发：
- **文生图**: "用 Grok 画一张..." / "帮我生成一张图片" / "/imagine prompt: ..."
- **图生图 / 修改图**: "修改这张图片" / "基于这张图画一个..." / "给图中人物换个背景"
- **文生视频 / 图生视频**: "做一段视频" / "把这张图片变成动图" / "/imagine_video"
- **多参考图动图合成**: "用这几张图片合成一个动画视频"

## 依赖与前提条件
1. **鉴权凭证**: 本技能自动读取本地 Grok 登录凭证 `~/.grok/auth.json`。
   - 若运行时提示 `[401 Unauthorized]` 或 `凭证未找到`，请提示用户先在系统终端执行 `grok` 命令完成官方账号登录与授权。
2. **执行环境**: 本技能包含标准 Node.js ES Module 脚本 `scripts/grok_imagine.mjs`。

## 脚本位置与调度规范 (跨平台通用)
Agent 在调用本技能时，请统一使用技能目录下的相对路径执行脚本（支持 macOS / Windows / Linux）：
- **调度命令 (推荐)**: `node scripts/grok_imagine.mjs`

## 命令行参数与用法示例

### 1. 文生图 (Text to Image)
```bash
node scripts/grok_imagine.mjs --prompt "赛博朋克风的未来城市夜景，霓虹灯光" --aspect-ratio "16:9"
```

### 2. 图生图 / 修改图片 (Image Edit)
```bash
node scripts/grok_imagine.mjs --prompt "给图中的猫咪戴上一顶海盗帽" --image "/absolute/path/to/cat.jpg"
```

### 3. 文生视频 / 首帧图生视频 (Text/Image to Video)
```bash
node scripts/grok_imagine.mjs --type video --prompt "海浪拍打沙滩，夕阳余晖" --duration 6 --aspect-ratio "16:9"
```

### 4. 多参考图生成视频 / 动图 (Multi-Image Reference Video)
支持传入多张图片路径（逗号分隔）：
```bash
node scripts/grok_imagine.mjs --type video --prompt "多图连贯过渡动画" --images "/path/img1.jpg,/path/img2.jpg" --duration 10
```

## 输出目录与文件命名
1. **默认存储路径**：
   - **图片**: 当前工作区的 `./images/` 目录下（如 `./images/grok_cyberpunk_city_20260723150412.jpg`）。
   - **视频**: 当前工作区的 `./videos/` 目录下（如 `./videos/grok_sea_waves_20260723150530.mp4`）。
2. **格式规约**：语义化提示词缩写 + `YYYYMMDDHHmmss` 时间戳，自动保持文件防重与可读性。

## Agent 回传与渲染规则 (必须执行)
1. **标准输出解析**: 脚本执行成功后会在控制台输出包含 Markdown 的文本段落。
2. **回传要求**: Agent **必须将控制台输出的原始 Markdown 语法块直接包含在回复给用户的 Message 中**：
   - 图片格式：`![Generated Image](file:///absolute/path/to/image.jpg)`
   - 视频格式：`<video src="file:///absolute/path/to/video.mp4" controls width="100%"></video>`
   这样用户的 AI 客户端界面才能直接预览渲染生成的图片与视频媒体！

## 异常处理与诊断指引
- **401 Unauthorized / Token Missing**: 告知用户 `~/.grok/auth.json` 凭证缺失或过期，请运行 `grok` 命令重连。
- **422 Unprocessable Entity**: 检查提示词或传入的图片路径是否存在。
- **Video Poll Timeout**: 提示用户网络波动，可使用返回的 Request ID 继续跟踪。

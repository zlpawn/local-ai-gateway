---
name: grok-imagine
description: 使用用户的 Grok 订阅凭证，进行文生图、图生图（修改图）、文生视频、图生视频及多参考图动图生成。
---

# Grok Imagine Multi-Modal Skill

## 使用场景
当用户表达以下意图或在聊天中使用指令时触发：
- "用 Grok 画一张..." / "帮我生成一张图片" / "修改这张图片" (图生图)
- "做一段视频" / "把这张图片变成动图" (图生视频)
- "/imagine prompt: ..." 或 `/imagine_video`

## 规则与命令

该技能包含底层执行脚本 `scripts/grok_imagine.mjs`，可以通过 Node.js 执行：

1. **文生图**: `node scripts/grok_imagine.mjs --prompt "..." --aspect-ratio "16:9"`
2. **图生图**: `node scripts/grok_imagine.mjs --prompt "..." --image "/path/to/img.png"`
3. **生视频 (自定义时长)**: `node scripts/grok_imagine.mjs --type video --prompt "..." --duration 6 --aspect-ratio "16:9"`
4. **单图/多图参考生视频 (多参考图合成动图)**: `node scripts/grok_imagine.mjs --type video --prompt "..." --images "/path/img1.png,/path/img2.png" --duration 10`

## 执行流程

1. **自动凭证解析**：自动读取用户本地 `~/.grok/auth.json` 中的 SuperGrok 订阅 Token 鉴权。
2. **API 调用**：
   - 图片生成：调用 `POST https://cli-chat-proxy.grok.com/v1/images/generations`。
   - 视频生成：调用 `POST https://cli-chat-proxy.grok.com/v1/videos/generations` 并自动异步轮询至完成。
3. **本地产物存储**：将图片保存为 `.jpg`/`.png`，将视频保存为 `.mp4` 至当前工作区目录或 `images/`/`videos/` 文件夹。
4. **输出渲染**：控制台输出绝对路径及 Markdown 预览语法（如 `![Generated Image](file:///...)`）。

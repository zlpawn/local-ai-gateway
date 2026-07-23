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

### 1. 文生图 (Text to Image)
```bash
node scripts/grok_imagine.mjs --prompt "赛博朋克风的未来城市夜景" --aspect-ratio "16:9"
```

### 2. 图生图 / 修改图片 (Image Edit)
```bash
node scripts/grok_imagine.mjs --prompt "给图中的猫咪戴上一顶海盗帽" --image "/path/to/cat.png"
```

### 3. 文生视频 / 图生视频 (Image to Video)
```bash
node scripts/grok_imagine.mjs --type video --prompt "海浪拍打沙滩，夕阳余晖" --duration 6 --aspect-ratio "16:9"
# 或传入首帧图片：
node scripts/grok_imagine.mjs --type video --prompt "画面缓缓放大" --image "/path/to/start.png"
```

## 执行流程

1. **自动凭证解析**：自动读取用户本地 `~/.grok/auth.json` 中的 SuperGrok 订阅 Token 鉴权。
2. **API 调用**：
   - 图片生成：调用 `POST https://cli-chat-proxy.grok.com/v1/images/generations`。
   - 视频生成：调用 `POST https://cli-chat-proxy.grok.com/v1/videos/generations` 并自动异步轮询至完成。
3. **本地产物存储**：将图片保存为 `.jpg`/`.png`，将视频保存为 `.mp4` 至当前工作区目录或 `images/`/`videos/` 文件夹。
4. **输出渲染**：控制台输出绝对路径及 Markdown 预览语法（如 `![Generated Image](file:///...)`）。

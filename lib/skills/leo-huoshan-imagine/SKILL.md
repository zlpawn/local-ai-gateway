---
name: leo-huoshan-imagine
description: 使用火山引擎方舟 ARK_API_KEY 调用豆包 Seedance 2.0 进行文生视频 / 图生视频，并通过 Seed TTS 2.0 进行文本转语音。
---

# Huoshan Imagine Skill (火山引擎视频生成 + 文本转语音)

## 使用场景
当用户表达以下意图或在聊天中使用指令时触发：
- **文生视频**: "用火山生成一段视频" / "做个视频" / "生成赛博朋克夜景视频"
- **图生视频 (首帧)**: "把这张图片变成视频" / "基于这张首帧生成动态视频"
- **多参考图生视频**: "用这几张图生成连贯视频"（第一张为首帧，其余为参考图）
- **任务恢复**: "查询之前的视频任务" / "下载那个还没完成的视频"
- **文本转语音**: "把这段文字转成语音" / "生成一段配音" / "朗读这段文本"

## 依赖与前提条件
1. **鉴权凭证**: 本技能自动读取 `ARK_API_KEY`（优先级：`--api-key` 参数 > 环境变量 `ARK_API_KEY` > `gateway.secrets.json` 中的 `arkApiKey`）。
   - 若运行时提示 `未找到 ARK_API_KEY`，请在 `.env` 或 `gateway.secrets.json` 中配置火山方舟 API Key。
   - 需在火山方舟控制台开通 Doubao Seedance 2.0 系列模型。
2. **执行环境**: 本技能包含标准 Node.js ES Module 脚本 `scripts/leo_huoshan_imagine.mjs`，零运行时依赖（仅用 Node 内置 `fetch` + 系统 `curl` 回退下载）。

## 🤖 大模型工具调用与参数规范 (LLM Call Constraints)
大模型 (Codex / Claude / Antigravity) 在构造 Shell 命令或工具调用参数时，**必须严格遵守以下类型规约**：
1. **纯整数格式 (Strict Integer Format)**：
   - 所有数值型参数（如视频时长 `--duration 5`、系统工具超时 `yield_time_ms: 300000`、`session_id` 等），**严禁写入带小数点的浮点数（例如禁止写 `5.0`, `300000.0`）**！
   - 必须使用纯整数字面量（Strict Integer），否则部分宿主客户端（如 Codex Rust 后端）会因 JSON 反序列化失败而中断。
2. **绝对路径规约**：
   - 图片与输出目录路径如果包含空格，必须使用双引号包裹，如 `--image "/path with space/scene.jpg"`。
3. **视频任务为异步长任务**：
   - 视频生成耗时较长（数十秒到数分钟），调用时 `yield_time_ms` 应设置足够大（建议 `300000` 即 5 分钟起步），避免宿主因超时中断轮询。

## 脚本调度路径 (推荐绝对/主路径)
为了避免 Agent 在不同工作区 (CWD) 执行命令时找不到相对路径，请优先使用以下兼容展开路径唤起脚本：
- **通用挂载路径 (首选)**:
  - Antigravity: `node ~/.gemini/config/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs`
  - Claude: `node ~/.claude/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs`
  - Codex: `node ~/.codex/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs`
  - 中央库: `node ~/.agents/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs`

## 命令行参数与用法示例

### 1. 文生视频 (Text to Video)
```bash
node ~/.agents/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs video --prompt "赛博朋克夜景，霓虹雨夜" --ratio 16:9 --duration 5
```

### 2. 图生视频 - 首帧 (Image to Video)
```bash
node ~/.agents/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs video --prompt "镜头缓缓推进，画面由静转动" --image scene.jpg
```

### 3. 多参考图生视频 (Multi-Image Reference Video)
第一张图作为首帧，后续图片作为参考图：
```bash
node ~/.agents/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs video --prompt "多图连贯过渡" --images "/path/img1.jpg,/path/img2.jpg" --duration 8
```

### 4. 指定输出规格 (Resolution / Ratio / Watermark)
```bash
node ~/.agents/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs video --prompt "4k 高清风景" --resolution 1080p --ratio 16:9 --duration 10 --watermark
```

### 5. 预检模式 (--dry-run) 与帮助 (--help)
```bash
# 查看完整 CLI 参数帮助
node ~/.agents/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs --help

# 预检参数与凭证，打印 Payload 但不扣费、不创建任务
node ~/.agents/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs video --prompt "测试" --dry-run
```

### 6. 任务恢复与进度补抓 (--check-status)
视频生成是异步任务，若因网络波动或宿主超时中断，可从报错信息中复制任务 ID 恢复查询并下载：
```bash
node ~/.agents/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs --check-status "cgt-2026xxxx"
```

### 7. 文本转语音 (Text to Speech)
```bash
node ~/.agents/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs tts --text "你好，这是火山引擎语音合成。" --voice zh_female_qingxin
```
指定音频格式与语速：
```bash
node ~/.agents/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs tts --text "快速朗读这段文本" --voice zh_female_qingxin --encoding mp3 --speed-ratio 1.5
```

## 视频输出规格参考 (Seedance 2.0 系列)
| 模型 | 模型 ID | 分辨率 | 时长 |
|------|---------|--------|------|
| Seedance 2.0 | `doubao-seedance-2-0-260128` | 480p/720p/1080p/4k | 4~15 秒 |
| Seedance 2.0 Fast | `doubao-seedance-2-0-fast-260128` | 480p/720p | 4~15 秒 |
| Seedance 2.0 Mini | `doubao-seedance-2-0-mini-260615` | 480p/720p | 4~15 秒 |

宽高比支持：`16:9` / `9:16` / `1:1` / `4:3` / `3:4` / `21:9` / `adaptive`

## 输出目录与文件命名
1. **默认存储路径**:
   - **视频**: 当前工作区的 `./videos/` 目录下。
   - **语音**: 当前工作区的 `./audios/` 目录下。
2. **格式规约**: `volcano_<提示词缩写>_<YYYYMMDDHHmmss>.<ext>`，例如视频 `volcano_cyberpunk_night_20260731203015.mp4`、语音 `volcano_nihao_shijie_20260731203015.mp3`，自动防重且可读。

## Agent 回传与渲染规则 (必须执行)
1. **标准输出解析**: 脚本执行成功后会在控制台输出包含 Markdown 的文本段落。
2. **回传要求**: Agent **必须将控制台输出的原始 Markdown 语法块直接包含在回复给用户的 Message 中**（兼容 Codex / Antigravity / Claude 界面直接预览与点击播放）：
   - 视频格式：`![Generated Video](/absolute/path/to/video.mp4)` 以及 `[▶️ 播放视频](file:///absolute/path/to/video.mp4)`
   - 语音格式：`🔊 [播放语音](file:///absolute/path/to/audio.mp3)`
   这样用户的 AI 客户端界面才能直接渲染预览与一键拉起播放器！

## 异常处理与恢复指引
- **未找到 ARK_API_KEY**: 告知用户在 `.env` 或 `gateway.secrets.json` 中配置 `ARK_API_KEY`，并在方舟控制台开通 Seedance 2.0 模型。
- **创建视频任务失败 (HTTP 4xx)**: 检查提示词、模型 ID、分辨率/时长参数是否在该模型支持范围内。
- **轮询超时**: 脚本会将任务 ID 附带在错误信息中，Agent 应告知用户并自动调用 `--check-status "<task_id>"` 进行轮询恢复。
- **任务失败 (status=failed)**: 检查 `error.message`，常见原因为图片审核未通过、参数越界。

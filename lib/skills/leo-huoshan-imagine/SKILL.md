---
name: leo-huoshan-imagine
description: 使用网关 huoshan-agentplan 节点凭证调用豆包 Seedance 2.0 进行文生视频 / 图生视频、Seedream 进行文生图 / 图文生图，并通过 Seed TTS 2.0 进行文本转语音。
---

# Huoshan Imagine Skill (火山引擎视频 / 图片生成 + 文本转语音)

## 使用场景
当用户表达以下意图或在聊天中使用指令时触发：
- **文生视频**: "用火山生成一段视频" / "做个视频" / "生成赛博朋克夜景视频"
- **图生视频 (首帧)**: "把这张图片变成视频" / "基于这张首帧生成动态视频"
- **多参考图生视频**: "用这几张图生成连贯视频"（第一张为首帧，其余为参考图）
- **任务恢复**: "查询之前的视频任务" / "下载那个还没完成的视频"
- **文本转语音**: "把这段文字转成语音" / "生成一段配音" / "朗读这段文本"
- **文生图**: "用火山生成一张图" / "画一张赛博朋克夜景"
- **图文生图 / 多图融合**: "基于这张图改风格" / "把这几张图融合成一张"

## 依赖与前提条件
1. **鉴权凭证**: 本技能不接收也不存储 API Key。运行时自动从网关 `gateway.secrets.json` 读取名为 `huoshan-agentplan` 的节点 key。
   - 默认复用 Codex 客户端下 `huoshan-agentplan` 节点已配置的 key，无需额外配置。
   - 若运行时提示未找到 key，请在网关配置面板为 `huoshan-agentplan` 节点配置 API Key。
   - 需在火山方舟控制台开通 Doubao Seedance 2.0、Seedream、Seed TTS 2.0 相关模型。
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
node ~/.agents/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs video --prompt "镜头1：雨夜霓虹街道中景，行人撑伞缓慢走过；镜头2：镜头缓慢推近到积水倒影特写，霓虹灯光闪烁；电影质感，冷蓝紫调，无字幕无水印" --ratio 16:9 --duration 5
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

### 7. 文生图 (Text to Image)
```bash
node ~/.agents/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs image --prompt "赛博朋克夜景，霓虹雨夜" --size 2K --output-format png
```

### 8. 图文生图 / 多图融合 (Image to Image)
基于参考图 URL 编辑或融合：
```bash
node ~/.agents/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs image --prompt "把图片风格转为水彩画" --image-urls "https://example.com/scene.png"
```

### 9. 文本转语音 (Text to Speech)
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


## 视频提示词指南 (Seedance 2.0)

来源：火山文档 [Doubao Seedance 2.0 系列提示词指南](https://www.volcengine.com/docs/82379/2222480)。Agent 在调用 `video` 前**必须**按本指南改写/补全用户 prompt，不要直接把松散口语丢给模型。

### 1. 先选任务类型（基础公式）

| 任务 | 含义 | 推荐句式 |
|------|------|----------|
| 多模态参考 | 从素材提取主体/风格/动作/音效，生成新视频 | `参考图片N中的主体N，生成...` / `参考视频N中的动作/运镜/风格/音效，生成...` / `参考音频N中的音色，生成...` |
| 编辑视频 | 在原视频上局部/全局修改，未提及部分默认不变 | 增加：`<元素特征> + <出现时机> + <出现位置>`；修改：`严格编辑视频N，将其中的原特征修改为新特征`；删除：点明删除对象，并强调保留对象 |
| 延长视频 | 在时间上续写，保持风格/主体/叙事一致 | `向前/向后延长视频N，生成...`；轨道补全：`视频1 + 过渡描述 + 接视频2 + ...` |

注意：
- 编辑/延长任务直接写 `视频N`，**不要**写 `参考视频N`（否则会被误判成参考任务）。
- 组合任务可用：`参考图片/视频N的[维度]，严格编辑视频X，[具体编辑内容]`。

### 2. 进阶公式（工程型指令）

Seedance 2.0 同时读文字 + 图/视频/音频，内部拆成**空间层**（画面里有什么）和**时间层**（如何随时间变化）。好 prompt 应是工程指令，不是纯文案形容：

**精准主体 + 动作细节 + 场景环境 + 光影色调 + 镜头运镜 + 视觉风格 + 画质 + 约束条件**

#### 2.1 定义主体
- 多主体时先定义：`将图片1中穿红色连衣裙、戴草帽的女人定义为主体1`。
- 后续全程用同一标签（如 `主体1` / `警察` / `小偷`），不要省略。
- 未定义时每次绑定：`张三@图片1`。
- 描述简洁、避免矛盾特征；复杂空间关系优先靠参考图表达。

#### 2.2 分镜时序（优先）
按事件顺序写镜头，不要只写一句笼统剧情：

```text
镜头1：街巷侧拍，男人缓慢起跑，带有急促的呼吸感。
镜头2：男人撞翻水果摊，镜头快速摇动并给到男人惊恐的特写。
镜头3：男人翻过矮墙消失，镜头缓慢拉远定格在空荡的街道。
```

每个镜头建议包含：
1. 运镜/切换方式（全景缓慢推近、固定机位、切至…）
2. 主体动作与表情
3. 位置或空间变化
4. 音频信息（音效/人声/BGM）

不要强行写精确秒数（如 `0-3秒`），模型对精确时间不稳定。

#### 2.3 动作描述
- 写到肢体部位 + 幅度/速度/力度：缓慢抬手、快速转头、用力蹬地。
- 优先低缓连续小动作；少用狂奔/大跳/剧烈翻滚。
- 补动作过渡：借着转身惯性顺势抬手。
- 情绪外化，不用抽象词：
  - 悲伤：低头、肩微颤、眼眶泛红、攥紧衣角
  - 紧张：看表、敲桌、呼吸急促、眼神闪躲
  - 愤怒：双拳紧握、下颌紧绷、胸口起伏

#### 2.4 运镜
- 直接用标准术语：中景、特写、全景、缓慢推镜、平稳横移、固定镜头。
- **一个镜头只指定 1 种运镜**，不要同时推拉摇移。

#### 2.5 画质 / 风格 / 约束（强烈建议常驻）
- 画质：高清，细节丰富，电影质感，色彩自然，光影柔和
- 风格：赛博朋克冷蓝紫、复古胶片、日系清新、2D日漫、3D国漫
- 约束模板（按需叠加）：
  - `保持无字幕` / `避免生成任何文字或字幕`
  - `不要生成Logo`
  - `不要生成水印`
  - `人物面部稳定不变形，动作自然流畅，无卡顿无闪烁`

### 3. 素材配置策略
通常把素材分成 4 种角色，推荐总量 **4-5 个**，不要堆满上限：
- 角色锚定：1-2 张（面部特写 + 全身）
- 场景定调：1 张
- 运镜参考：1 段视频
- 节奏氛围：1 段音频

人物参考优先「大头照 + 全身照」；**不要**用人物多视图/三视图（易 ID 漂移、双胞胎）。

### 4. 文字 / 台词 / 音频
- 常用字优先，少用生僻字/特殊符号。
- 可指定文字颜色、风格、出现时机、位置；广告语/字幕/气泡都支持。
- 台词语言统一，避免中英混用（专有名词除外）。
- 中文发音不准时，可用同音常用字替换（如 `螭龙山` -> `吃龙山`）。
- 音色不准时，补充音色特征描述，并让台词语气接近参考音频。

### 5. 常见问题与规避
| 问题 | 规避 |
|------|------|
| 人物 ID 漂移/换脸 | 独立人脸特写 + 全身妆造；重要素材写在 prompt 前面；清晰主体绑定 |
| 意外字幕 | 加 `保持无字幕`；先清素材文字；优先横屏再裁竖屏 |
| Logo/水印 | 加 `不要生成Logo/水印` |
| 风格漂移 | 明确写 `2D日漫风格` 等；参考图先转成目标风格 |
| 双胞胎 | 明确每人对应哪张图；加“禁止同款分身”约束；不用三视图 |
| 参考人物 >4 | 先分组出图（每组<=4人），再图生视频 |
| 特效不符合预期 | 用参考视频定义特效，而不是纯文字描述 |
| 延长衔接跳变 | 后期对齐关键帧；续写尽量在切镜处收尾 |
| 多次延长画质劣化 | 控制续写次数；可用白模视频中转；优先高清参考图 |

### 6. Agent 写 prompt 的执行清单
1. 判断任务：参考 / 编辑 / 延长 / 组合。
2. 定义全部主体，并与图片/视频编号绑定。
3. 改写成 2-4 个镜头的时序描述。
4. 补运镜、光影、风格、画质。
5. 默认追加约束：无字幕、无水印、人物不变形、动作流畅。
6. 再调用 `video` 命令；用户只给一句话时，也要先扩写再生成。


## 输出目录与文件命名
1. **默认存储路径**:
   - **视频**: 当前工作区的 `./videos/` 目录下。
   - **语音**: 当前工作区的 `./audios/` 目录下。
   - **图片**: 当前工作区的 `./images/` 目录下。
2. **格式规约**: `volcano_<提示词缩写>_<YYYYMMDDHHmmss>.<ext>`，例如视频 `volcano_cyberpunk_night_20260731203015.mp4`、语音 `volcano_nihao_shijie_20260731203015.mp3`，自动防重且可读。

## Agent 回传与渲染规则 (必须执行)
1. **标准输出解析**: 脚本执行成功后会在控制台输出包含 Markdown 的文本段落。
2. **回传要求**: Agent **必须将控制台输出的原始 Markdown 语法块直接包含在回复给用户的 Message 中**（兼容 Codex / Antigravity / Claude 界面直接预览与点击播放）：
   - 视频格式：`![Generated Video](/absolute/path/to/video.mp4)` 以及 `[▶️ 播放视频](file:///absolute/path/to/video.mp4)`
   - 语音格式：`🔊 [播放语音](file:///absolute/path/to/audio.mp3)`
   - 图片格式：`![Generated Image](/absolute/path/to/image.png)`
   这样用户的 AI 客户端界面才能直接渲染预览与一键拉起播放器！

## 异常处理与恢复指引
- **未找到 API Key**: 告知用户在网关配置面板为 `huoshan-agentplan` 节点配置 API Key；并确认方舟控制台已开通 Seedance / Seedream / Seed TTS 模型。
- **创建视频任务失败 (HTTP 4xx)**: 检查提示词、模型 ID、分辨率/时长参数是否在该模型支持范围内。
- **轮询超时**: 脚本会将任务 ID 附带在错误信息中，Agent 应告知用户并自动调用 `--check-status "<task_id>"` 进行轮询恢复。
- **任务失败 (status=failed)**: 检查 `error.message`，常见原因为图片审核未通过、参数越界。

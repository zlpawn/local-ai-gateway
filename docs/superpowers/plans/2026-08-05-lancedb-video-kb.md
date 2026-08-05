# LanceDB 视频知识库实现计划

> **目标:** 为 Shrimp 网关新增 LanceDB 向量数据库能力,构建"视频 URL -> yt-dlp 下载 -> Whisper 转录 -> 向量化 -> LanceDB 存储 -> 语义检索"完整管线。配套独立可用的 cookie 导出工具与 skill。

## 已有基础设施(复用)

- `forwardOpenAIEmbeddings`(server.js:691):已支持 `endpoint_id` 精确匹配 + 默认兜底,转发到配置好的 embedding 节点。视频知识库向量化直接复用。
- `selectEmbeddingEndpoints` / `selectDefaultEmbeddingEndpoint`(lib/config/gateway-config-store.mjs:187):枚举 embedding 节点,前端下拉数据源。
- `lib/media/`(storage.mjs / history.mjs):媒体文件下载、历史记录、原子写入模式。视频原始素材保存复用这套。
- `MEDIA_VIDEO_TASKS = new Map()`(server.js:236):现有视频生成任务轮询,内存态、非持久。这是要被通用任务队列取代的旧模式。
- `lib/skills/` 目录 + `managed-catalog.json`:skill 组织方式,每个 skill 有 `SKILL.md` + `scripts/` + `agents/openai.yaml`。
- `lib/skills/leo-video-to-karpathy-wiki/references/platform-runtime.md`:已有跨平台 yt-dlp / Whisper 探测规范,ASR 工具选择逻辑直接参考。
- `lib/analytics/db.mjs`:SQLite 用 `node:sqlite` 原生模块,WAL 模式。任务队列持久化沿用同一模式。

## 设计原则

- 任务队列是通用基础设施,不只为视频知识库服务;后续图片/视频/TTS 生成迁移过来。
- cookie 工具 skill 完全独立,可脱离网关使用(纯脚本 + SKILL.md,不 import 网关代码)。
- Whisper 工具运行时探测,面板下拉选择,不写死。
- 依赖缺失优先提示 `uv tool install`,其次 brew/scoop/winget。
- 原始视频和音频保留,用户可查看和删除。
- LanceDB 数据存项目数据目录(与 gateway.db 同级)。

## 模块总览

```
lib/
├── task-queue/                    # 通用后台任务队列(新基础设施)
│   ├── queue.mjs                  # 任务调度器:提交/轮询/取消/重试
│   ├── store.mjs                  # SQLite 持久化:任务状态/进度/结果
│   └── handler-registry.mjs       # 插件式 handler 注册接口
├── video-kb/                      # 视频知识库管线
│   ├── downloader.mjs             # yt-dlp 封装:下载音轨/视频 + cookie
│   ├── transcriber.mjs            # Whisper 封装:工具探测 + 转录
│   ├── chunker.mjs                # 转录文本分块(时间窗口 + 句子边界)
│   ├── vector-store.mjs           # LanceDB 封装:建表/写入/检索
│   ├── pipeline.mjs               # 编排器:下载->转录->分块->向量化->入库
│   └── handler.mjs                # 任务队列 handler 注册(对接 pipeline)
├── cookie-extractor/              # Cookie 抓取工具(网关面板用)
│   └── index.mjs                  # 读浏览器 SQLite + 解密 + 导出 Netscape
└── skills/
    └── leo-cookie-exporter/       # 独立 skill(可脱离网关)
        ├── SKILL.md
        ├── scripts/
        │   └── export_cookies.py  # 跨平台 cookie 导出脚本
        └── agents/
            └── openai.yaml
```

server.js 改动:
- 新增任务队列 REST 路由(`/v1/tasks/...`)
- 新增视频知识库 REST 路由(`/v1/video-kb/...`)
- 新增 cookie 导出路由(`/v1/cookies/...`)
- 任务队列初始化和 handler 注册(启动时)

---

## Task 1: 通用后台任务队列

**目标:** SQLite 持久化、插件式 handler、可扩展的异步任务系统。这是后续所有慢操作的基础。

**文件:**
- 创建 `lib/task-queue/store.mjs`
- 创建 `lib/task-queue/queue.mjs`
- 创建 `lib/task-queue/handler-registry.mjs`
- 修改 `server.js`:初始化队列 + REST 路由
- 测试 `tests/unit/task-queue.test.mjs`

### 1.1 store.mjs - SQLite 持久层

复用 `node:sqlite` 原生模块,与 lib/analytics/db.mjs 同模式。WAL 模式。

表设计:
```
tasks(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,        -- pending|running|succeeded|failed|cancelled
  payload TEXT NOT NULL,       -- JSON
  result TEXT,                 -- JSON
  error TEXT,
  progress REAL DEFAULT 0,
  progress_message TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  retries INTEGER DEFAULT 0
)
```

接口:
- `createTaskStore({ dbPath })` -> `{ insert, update, get, list, cancel, delete }`
- `insert(task)` -> 新建 pending 任务,返回 id
- `update(id, { status, progress, progressMessage, result, error })` -> 原子更新
- `get(id)` -> 查询单个任务
- `list({ type, status, limit, offset })` -> 分页列表
- `cancel(id)` -> pending 直接取消;running 设 cancel_requested 标记(用单独列或 status 中间态)
- `delete(id)` -> 删除记录(仅允许终态)

### 1.2 handler-registry.mjs - 插件注册

handler 接口:
```js
{
  type: "video_kb",
  async run(payload, { signal, onProgress }) -> result
}
```
- `onProgress(fraction, message)` 上报进度
- `signal`: AbortSignal,handler 应定期检查并优雅中止

接口:
- `createHandlerRegistry()` -> `{ register(type, handler), get(type), list() }`

### 1.3 queue.mjs - 调度器

- 并发控制:默认 2 个并发槽(可配置,环境变量 `TASK_QUEUE_CONCURRENCY`)
- 轮询 pending 任务,分配 handler 执行
- 失败重试:最多 `retries` 次,指数退避(默认 1 次,backoff 2s/4s)
- 进度上报:通过 onProgress 回调写入 store
- 优雅关闭:处理中的任务标记为 pending,下次启动恢复

接口:
- `createTaskQueue({ store, registry, concurrency })` -> `{ submit, get, list, cancel, shutdown, start }`
- `submit(type, payload)` -> 插入 pending 任务,触发调度
- `get(id)` / `list(filter)` -> 代理 store
- `cancel(id)` -> 代理 store,同时 abort 运行中的 handler
- `shutdown()` -> 停止调度,等待运行中任务或标记中断
- `start()` -> 恢复 pending 任务执行(启动时调用)

### 1.4 REST 路由(server.js)

```
POST   /v1/tasks                  # 提交任务 { type, payload } -> { task_id, status }
GET    /v1/tasks                  # 列表 ?type=&status=&limit=&offset=
GET    /v1/tasks/:id              # 查询单个任务状态/进度/结果
POST   /v1/tasks/:id/cancel       # 取消任务
DELETE /v1/tasks/:id              # 删除任务记录(仅终态)
```

### 1.5 测试要点

- 提交任务后立即返回 pending,异步执行后变 succeeded
- handler 不存在时返回 400
- 并发限制生效(2 个槽满时第 3 个排队)
- 进度上报正确写入
- 取消 pending 立即生效,取消 running 后 handler 收到 abort
- 进程重启后 pending 任务恢复执行

---

## Task 2: Cookie 抓取工具(网关集成)

**目标:** 从本地浏览器 SQLite cookie 库读取 + 解密,导出 Netscape 格式 `cookies.txt`,供 yt-dlp 使用。

**文件:**
- 创建 `lib/cookie-extractor/index.mjs`
- 修改 `server.js`:cookie 路由
- 测试 `tests/unit/cookie-extractor.test.mjs`

### 2.1 技术方案

浏览器 cookie 存储位置:
- Chrome (macOS): `~/Library/Application Support/Google/Chrome/Default/Cookies`
- Chrome (Windows): `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Cookies`
- Chrome (Linux): `~/.config/google-chrome/Default/Cookies`
- Edge: 同 Chrome 路径,替换 `Google\Chrome` -> `Microsoft\Edge`
- Brave: `~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies`
- Firefox: `~/Library/Application Support/Firefox/Profiles/<profile>/cookies.sqlite`(不加密)

加密方案:
- Chrome v10+ (macOS): AES-128-CBC,密钥从 Keychain 取 "Chrome Safe Storage" -> PBKDF2 派生
- Chrome v10+ (Windows): AES-256-GCM,密钥用 DPAPI 解密(存在 `Local State` JSON)
- Chrome v10+ (Linux): AES-128-CBC,密钥从 gnome-keyring/kwallet 或固定字符串 "peanuts"
- Firefox: 明文,直接读

实现策略(纯 Node,不依赖第三方 npm 包):
- macOS: `security find-generic-password -wa "Chrome"` 取 Keychain 密钥 -> `node:crypto` PBKDF2 派生 -> AES-128-CBC 解密
- Windows: 读 `Local State` JSON 的 `os_crypt.encrypted_key`,Base64 解码去前缀,`child_process` 调 PowerShell DPAPI 或 `win-dpapi` npm 包解密主密钥,再 AES-256-GCM 解密 cookie
- Linux: `secretstore` 工具或固定 fallback "peanuts"
- Firefox: `node:sqlite` 直接读明文

输出 Netscape 格式:
```
# Netscape HTTP Cookie File
.domain.com    TRUE    /    FALSE    1234567890    name    value
```

### 2.2 接口

```js
export function detectBrowsers() -> [{ id, name, browser, profilePath, cookieDbPath }]
export async function extractCookies({ browser, domain, outputPath }) -> { file_path, count, domains }
export async function listCookieDomains({ browser }) -> string[]
```

### 2.3 REST 路由

```
GET    /v1/cookies/browsers              # 探测已安装浏览器
GET    /v1/cookies/domains?browser=chrome # 列出域名
POST   /v1/cookies/export                # { browser, domain?, output_path? } -> { file_path, count }
```

### 2.4 安全考量

- 只读本地文件,不触碰网络,零封号风险
- 浏览器运行时 cookie DB 可能被锁(SQLite WAL):复制临时副本再读
- 解密密钥操作仅在本机内存中进行,不落盘不日志
- 输出文件权限 0o600

---

## Task 3: Cookie 导出 Skill(独立)

**目标:** 完全独立、可脱离网关使用的 skill,给大模型用。纯 Python 脚本 + SKILL.md,不 import 网关任何代码。

**文件:**
- 创建 `lib/skills/leo-cookie-exporter/SKILL.md`
- 创建 `lib/skills/leo-cookie-exporter/scripts/export_cookies.py`
- 创建 `lib/skills/leo-cookie-exporter/agents/openai.yaml`
- 修改 `lib/skills/managed-catalog.json`:注册新 skill

### 3.1 SKILL.md 要点

- name: `cookie-exporter`
- description: 导出本地浏览器 cookie 为 Netscape 格式 cookies.txt,供 yt-dlp 等工具下载需要登录的视频时使用。支持 Chrome、Edge、Brave、Firefox。
- 工作流程:探测浏览器 -> 用户选浏览器/Profile -> 选域名(或全部) -> 调 export_cookies.py -> 返回路径 + 使用建议
- 依赖:Python 3.8+,pycryptodome(Chrome 解密),Firefox 无需额外依赖
- 跨平台:macOS Keychain / Windows DPAPI / Linux keyring / Firefox 明文

### 3.2 export_cookies.py

独立 Python 脚本,功能与 Task 2 的 `lib/cookie-extractor/index.mjs` 对等:
```
python export_cookies.py --browser chrome --domain youtube.com -o cookies.txt
python export_cookies.py --browser firefox --list-domains
python export_cookies.py --browser chrome --all
```
- 自动探测浏览器路径
- Chrome 解密用 pycryptodome
- 输出 Netscape 格式

### 3.3 managed-catalog.json 新增条目

```json
{
  "id": "leo-cookie-exporter",
  "name": "leo-cookie-exporter",
  "title": "Cookie Exporter",
  "summary": "导出本地浏览器 cookie 为 Netscape 格式 cookies.txt,供 yt-dlp 下载登录视频使用。",
  "category": "download",
  "categoryLabel": "下载采集",
  "icon": "🍪",
  "featured": false,
  "tags": ["cookie", "yt-dlp", "download"],
  "requiresDaemon": false,
  "promoted": true,
  "managed": true
}
```

---

## Task 4: 视频下载模块

**目标:** yt-dlp 封装,支持 cookie.txt,下载音轨(转录用)和视频(保留原始素材)。

**文件:**
- 创建 `lib/video-kb/downloader.mjs`
- 测试 `tests/unit/video-kb-downloader.test.mjs`

### 4.1 接口

```js
export function detectYtDlp() -> { path, version } | null
export function getYtDlpInstallHint() -> { command, platform }
export async function fetchVideoInfo(url, { cookieFile }) -> { title, duration, uploader, ... }
export async function downloadVideo(url, {
  cookieFile,        // cookies.txt 路径(可选)
  outputDir,         // 输出目录
  audioOnly = false, // true: 仅音轨(转录用);false: 完整视频(保留素材)
  signal,            // AbortSignal
  onProgress,        // (fraction, message) => void
}) -> {
  videoPath, audioPath, infoPath, info,
}
```

### 4.2 实现

- `child_process.spawn` 调 yt-dlp(需要流式读取 stderr 进度)
- `--no-playlist`:单视频,不展开播放列表(后续增强)
- `--cookies <file>`:挂 cookie
- `--write-info-json`:保留元数据
- `--newline`:每行进度一个换行,便于解析
- 音轨:`-f bestaudio --extract-audio --audio-format wav`(Whisper 需要 wav/mp3)
- 视频:`-f bestvideo+bestaudio --merge-output-format mp4`
- 进度解析:yt-dlp stderr 输出 `[download] xx.x%`,正则提取百分比

### 4.3 安装提示优先级

```
1. uv tool install yt-dlp  (uv 可用时,跨平台)
2. pip install yt-dlp       (uv 不可用)
3. brew install yt-dlp      (macOS,无 pip)
4. scoop install yt-dlp     (Windows,无 pip)
5. winget install yt-dlp    (Windows,无 scoop)
```

---

## Task 5: Whisper 转录模块

**目标:** 运行时探测 Whisper 类工具,面板可选,转录音轨为带时间戳文本。

**文件:**
- 创建 `lib/video-kb/transcriber.mjs`
- 测试 `tests/unit/video-kb-transcriber.test.mjs`

### 5.1 接口

```js
export function detectWhisperTools() -> [{
  id, name, path, platform, version,
}]
export function getWhisperModelSizes() -> [{
  id, name, sizeMB, speedHint, guide,
}]
export function getInstallHint(toolId) -> { command, platform }
export async function transcribe(audioPath, {
  tool, modelSize, language, outputDir, signal, onProgress,
}) -> {
  transcriptJson,   // [{ segment_id, start_seconds, end_seconds, text }]
  transcriptTxt, srtPath, detectedLanguage,
}
```

### 5.2 工具探测逻辑

参考 `leo-video-to-karpathy-wiki/references/platform-runtime.md`:
- macOS Apple Silicon:优先 `mlx_whisper`(Metal 加速),其次 `whisper-ctranslate2 --device cpu`
- macOS Intel:`whisper-ctranslate2 --device cpu`
- Windows NVIDIA:`whisper-ctranslate2 --device cuda`(先做 CUDA 能力测试)
- Windows 无 CUDA:`whisper-ctranslate2 --device cpu`
- Linux:`faster-whisper` 或 `whisper`

探测方式:`which` / `where` 检查命令存在,再 `--help` 确认参数兼容。
不假设命令存在即代表后端可用,短片段能力测试。

### 5.3 输出统一化

统一转换为:
```json
[{ "segment_id": "ASR-S0001", "start_seconds": 0.0, "end_seconds": 4.2, "text": "..." }]
```

- `mlx_whisper --output-format json`:解析 JSON
- `whisper-ctranslate2 --output_format json`:解析 JSON
- `faster-whisper`:Python API 输出,脚本封装
- `whisper`:同上

### 5.4 模型大小引导

| 模型 | 大小 | 速度 | 准确率 | 引导文案 |
|------|------|------|--------|----------|
| tiny | 75MB | 极快 | 低 | 适合快速预览,准确率较低,短视频可用 |
| base | 145MB | 快 | 中 | 日常对话基本够用,速度和准确率平衡 |
| small | 480MB | 中 | 较高 | 推荐默认,大多数场景准确率好 |
| medium | 1.5GB | 慢 | 高 | 准确率高,长视频或专业内容推荐 |
| large-v3 | 3GB | 很慢 | 最高 | 最高准确率,适合重要内容,需要好硬件 |

---

## Task 6: 文本分块模块

**目标:** 将转录文本按时间窗口分块,对齐句子边界,每块带时间戳区间。

**文件:**
- 创建 `lib/video-kb/chunker.mjs`
- 测试 `tests/unit/video-kb-chunker.test.mjs`

### 6.1 接口

```js
export function chunkTranscript(segments, {
  targetSeconds = 60,
  maxSeconds = 90,
  overlapSeconds = 5,
  minTokens = 50,
}) -> [{
  chunk_id, start_seconds, end_seconds, text, segment_ids,
}]
```

### 6.2 策略

- 累加连续 segment 直到达到 `targetSeconds`
- 不在 segment 中间断开(尊重句子边界)
- 超过 `maxSeconds` 时强制切分
- 相邻块有 `overlapSeconds` 重叠(最后一个 segment 共享)
- 过短块(< minTokens)合并到前一块
- 每块记录时间戳区间,供检索结果跳转

---

## Task 7: LanceDB 向量存储 + 检索

**目标:** LanceDB 封装,存储向量 + 元数据,提供语义检索。

**文件:**
- 创建 `lib/video-kb/vector-store.mjs`
- 测试 `tests/unit/video-kb-vector-store.test.mjs`

### 7.1 依赖策略

LanceDB 有 Node.js SDK:`@lancedb/lancedb`。添加到 dependencies。

如果 `@lancedb/lancedb` 存在原生依赖问题,fallback 方案:
- LanceDB 核心是 Rust + Arrow,有 Python SDK(pip install lancedb)
- Node 端通过 `child_process` 调 Python lancedb 脚本(类似 Whisper 封装)
- 优先尝试 npm 包,失败则 fallback Python

### 7.2 接口

```js
export function createVectorStore({ dbPath, embeddingFn }) -> {
  ensureTable,      // 确保 table 存在
  upsertChunks,     // 写入分块向量
  search,           // 语义检索
  deleteByVideo,    // 按视频删除
  listVideos,       // 列出已索引的视频
  getStats,         // 统计信息
}
// embeddingFn: (text) => Promise<number[]>
// 复用网关 embedding 节点,通过 forwardOpenAIEmbeddings
```

### 7.3 表结构 (LanceDB)

```
table: video_kb
columns:
  - chunk_id: string
  - video_id: string         (视频唯一标识,URL hash)
  - video_url: string
  - video_title: string
  - chunk_index: int32
  - start_seconds: float32
  - end_seconds: float32
  - text: string
  - segment_ids: string[]
  - vector: fixed_size_list<float32>[dim]  (embedding 维度)
  - language: string
  - created_at: int64
```

### 7.4 embedding 集成

```js
// 复用网关 embedding 节点
async function gatewayEmbed(text, endpointId) {
  const res = await fetch(`http://127.0.0.1:${LISTEN_PORT}/v1/embeddings?endpoint_id=${endpointId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, model: "text-embedding" }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}
```

### 7.5 检索接口

```js
search(query, {
  endpointId,       // embedding 节点(向量化 query)
  topK = 5,
  videoId,          // 限定某视频(可选)
  threshold = 0.5,
}) -> [{
  chunk_id, video_id, video_title, video_url,
  start_seconds, end_seconds, text, score,
}]
```

---

## Task 8: 管线编排 + 任务 handler

**目标:** 将下载->转录->分块->向量化->入库串成完整管线,作为任务队列的 handler。

**文件:**
- 创建 `lib/video-kb/pipeline.mjs`
- 创建 `lib/video-kb/handler.mjs`
- 修改 `server.js`:注册 handler + REST 路由
- 测试 `tests/integration/video-kb-pipeline.test.mjs`

### 8.1 pipeline.mjs

```js
export async function runVideoKbPipeline(payload, { signal, onProgress }) {
  // payload: { url, cookieFile?, whisperTool, whisperModel, language,
  //            embeddingEndpointId, chunkOptions? }
  // 步骤:
  // 1. onProgress(0.0, "获取视频信息")    -> fetchVideoInfo
  // 2. onProgress(0.05, "下载音轨")       -> downloadVideo(audioOnly=true)
  // 3. onProgress(0.15, "下载视频素材")   -> downloadVideo(audioOnly=false)
  // 4. onProgress(0.25, "语音转录")       -> transcribe (最慢,占 0.25-0.75)
  // 5. onProgress(0.75, "文本分块")       -> chunkTranscript
  // 6. onProgress(0.80, "向量化")         -> 批量 embed + upsertChunks (0.80-0.95)
  // 7. onProgress(1.0, "完成")            -> 返回结果摘要
  // 返回: { video_id, title, duration, chunk_count, transcript_path, video_path, audio_path }
  // 每步检查 signal.aborted,优雅中止
}
```

### 8.2 handler.mjs

```js
import { runVideoKbPipeline } from "./pipeline.mjs";
export const videoKbHandler = {
  type: "video_kb",
  async run(payload, { signal, onProgress }) {
    return runVideoKbPipeline(payload, { signal, onProgress });
  },
};
// server.js 启动时: taskQueueRegistry.register(videoKbHandler.type, videoKbHandler);
```

### 8.3 REST 路由

```
# 视频知识库(提交即创建后台任务)
POST   /v1/video-kb/ingest              # { url, cookie_file?, whisper_tool, whisper_model, language, embedding_endpoint_id } -> { task_id }
GET    /v1/video-kb/videos              # 列出已索引视频
GET    /v1/video-kb/videos/:id          # 视频详情(含 chunks 概要)
DELETE /v1/video-kb/videos/:id          # 删除视频及其所有 chunks + 原始素材
POST   /v1/video-kb/search              # { query, embedding_endpoint_id, top_k?, video_id? } -> [{ chunk_id, video_title, start_seconds, text, score }]

# 工具探测(面板用)
GET    /v1/video-kb/tools/whisper       # 探测已安装 Whisper 工具
GET    /v1/video-kb/tools/whisper/models # 模型大小选项 + 引导
GET    /v1/video-kb/tools/yt-dlp        # 探测 yt-dlp
GET    /v1/video-kb/tools/embedding-endpoints # 可用 embedding 节点列表

# 素材访问
GET    /v1/video-kb/assets/:video_id/:type # type=video|audio|transcript,流式返回文件
```

---

## Task 9: 前端面板集成

**目标:** 在 Web 配置面板新增"视频知识库"入口,包含导入、检索、素材管理。

**文件:**
- 修改 `desktop/config-panel.html`(或对应的 esbuild 入口)
- 修改 `desktop/` 下相关 JS/CSS

### 9.1 面板结构

新增 nav 项 "视频知识库"(icon: 📺),包含子区:

**导入区:** URL 输入框、Cookie 文件选择(下拉:已导出的 cookies.txt / 无 / 手动上传)、Whisper 工具下拉(自动探测,显示已安装;未安装显示安装命令)、模型大小下拉(带引导文案)、语言选择(自动检测 / 中文 / English / ...)、Embedding 节点下拉、"开始导入"按钮 -> 提交任务,显示任务进度条

**任务区:** 当前任务进度(进度条 + 状态文字 + 当前步骤)、历史任务列表(成功/失败/取消)

**检索区:** 查询输入框、Embedding 节点下拉(默认与导入一致)、Top K 滑块(1-20)、搜索按钮、结果列表(每条显示视频标题、时间戳区间、文本片段、相似度分数,时间戳可点击)

**素材管理区:** 已索引视频列表(标题、URL、时长、chunk 数、创建时间),每条可查看原始视频/音频/转录文本、删除(含向量数据)

**Cookie 工具区(小工具):** 浏览器选择(自动探测已安装)、域名选择(从浏览器读取域名列表)、导出按钮 -> 生成 cookies.txt,显示路径

### 9.2 复用现有 UI 体系

- CSS 变量:`--bg-color` / `--surface` / `--surface-hover` / `--border-color` / `--text-primary` / `--text-secondary` / `--brand-primary` / `--input-bg` / `--radius-md` / `--font-mono`
- 组件类:`.btn` / `.btn-primary` / `.form-group` / `.badge` / `.section-header`
- 暗色/亮色双主题
- 参考"小工具"tab 的实现模式(embedding playground)

---

## 实施顺序

按依赖关系排序,每个 Task 可独立测试和提交:

1. **Task 1** - 通用任务队列(无依赖,基础设施)
2. **Task 2** - Cookie 抓取工具(无依赖,网关集成)
3. **Task 3** - Cookie 导出 skill(无依赖,独立脚本)
4. **Task 4** - 视频下载模块(依赖 Task 1 的队列接口定义)
5. **Task 5** - Whisper 转录模块(无依赖)
6. **Task 6** - 文本分块模块(无依赖)
7. **Task 7** - LanceDB 向量存储(依赖 embedding 链路理解)
8. **Task 8** - 管线编排(依赖 Task 1/4/5/6/7)
9. **Task 9** - 前端面板(依赖 Task 8 的 REST API)

Task 1/2/3 可并行;Task 4/5/6/7 可并行;Task 8 依赖前四者;Task 9 依赖 8。

---

## 测试策略

### 单元测试
- `tests/unit/task-queue.test.mjs`:任务提交/状态转换/并发/重试/取消
- `tests/unit/cookie-extractor.test.mjs`:Netscape 格式输出/域名过滤/多浏览器探测 mock
- `tests/unit/video-kb-downloader.test.mjs`:yt-dlp 命令构造/进度解析(mock spawn)
- `tests/unit/video-kb-transcriber.test.mjs`:工具探测/输出统一化(mock spawn)
- `tests/unit/video-kb-chunker.test.mjs`:分块策略/边界条件/重叠
- `tests/unit/video-kb-vector-store.test.mjs`:CRUD/检索(临时 LanceDB)

### 集成测试
- `tests/integration/video-kb-pipeline.test.mjs`:完整管线(mock yt-dlp + whisper)
- `tests/integration/task-queue-rest.test.mjs`:REST 路由端到端

### 测试约束
- mock 外部命令(yt-dlp / whisper),不在 CI 跑真实下载和转录
- LanceDB 测试用临时目录,测完清理
- cookie 测试不触碰真实浏览器(用构造的 SQLite 测试库)

---

## 依赖变更

### package.json

```json
{
  "dependencies": {
    "@lancedb/lancedb": "^0.x"
  }
}
```

如果 `@lancedb/lancedb` 有原生依赖兼容性问题,使用 Python fallback 方案(Task 7 详述),不新增 npm 依赖。

### 外部工具(用户需安装,网关探测 + 引导)

| 工具 | 用途 | 安装优先级 |
|------|------|-----------|
| yt-dlp | 视频下载 | `uv tool install yt-dlp` > `pip` > `brew`/`scoop` |
| mlx_whisper | macOS 转录 | `uv tool install mlx-whisper` |
| whisper-ctranslate2 | 跨平台转录 | `uv tool install whisper-ctranslate2` |
| faster-whisper | Linux 转录 | `uv tool install faster-whisper` |
| ffmpeg/ffprobe | 音视频处理 | `brew install ffmpeg` / `scoop install ffmpeg` |

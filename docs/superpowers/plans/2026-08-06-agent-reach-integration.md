# Agent Reach 集成实现计划

> **目标:** 将 Agent Reach 作为网关的通用内容获取层集成。视频知识库管线优先通过 Agent Reach 获取字幕/文本,拿不到时 fallback 到 yt-dlp + Whisper。同时为后续其他内容类型(小红书图文、GitHub 源码等)预留底层能力。

## 设计原则

- Agent Reach 是外部 CLI 工具,不 import、不改源码
- 底层 `lib/content-reach/` 是通用内容获取模块,不绑定视频场景
- 视频知识库面板不改名,用户感知不变
- 没装 Agent Reach 时:提示安装 + fallback 到纯 yt-dlp
- 装了 Agent Reach 时:优先用 `agent-reach get` 拿字幕,跳过下载和转录

## 模块结构

```
lib/
├── content-reach/                 # 通用内容获取层(新)
│   ├── detector.mjs               # 探测 agent-reach 安装状态、版本、已安装渠道
│   ├── fetcher.mjs                 # 调 agent-reach get 拿内容,返回统一格式
│   └── installer.mjs               # 安装引导:uv tool install + agent-reach install --env=auto
├── video-kb/                      # 视频知识库(已有,改动)
│   ├── pipeline.mjs               # 加 agent_reach_get 节点(有字幕跳过下载+转录)
│   └── ...                        # 其他文件不变
```

## Task 1: 通用内容获取模块

**文件:**
- 创建 `lib/content-reach/detector.mjs`
- 创建 `lib/content-reach/fetcher.mjs`
- 创建 `lib/content-reach/installer.mjs`
- 测试 `tests/unit/content-reach.test.mjs`

### 1.1 detector.mjs

```js
export function detectAgentReach() -> { installed: boolean, path: string, version: string } | null
// 执行 `agent-reach --version`,检测是否安装

export async function getDoctorReport() -> {
  channels: [{ name, status, backend, auth_required }]
}
// 执行 `agent-reach doctor --json`,返回已安装渠道及状态

export async function getInstalledChannels() -> string[]
// 从 doctor 报告提取已安装的渠道名列表
```

### 1.2 fetcher.mjs

```js
export async function fetchContent(url, { signal } = {}) -> {
  title: string,
  text: string,
  source: string,       // 平台名 (youtube, bilibili, ...)
  url: string,
  type: string,         // "transcript" | "article" | "post" | "code"
  metadata: object,     // 平台特定元数据
} | null
// 尝试 agent-reach get <url> --json
// 遍历已安装渠道,找到能处理该 URL 的渠道
// 返回统一格式的内容,或 null(无法获取)
```

### 1.3 installer.mjs

```js
export function getInstallHint() -> { steps: string[], command: string }
// 返回安装步骤和命令

export async function installAgentReach({ onProgress }) -> { success: boolean, message: string }
// 执行 uv tool install + agent-reach install --env=auto
// 作为后台任务运行,通过 onProgress 上报进度

export async function installChannels(channels, { onProgress }) -> { success: boolean }
// 执行 agent-reach install --channels=<channels>
```

## Task 2: 视频知识库管线集成

**文件:**
- 修改 `lib/video-kb/pipeline.mjs`
- 修改 `lib/video-kb/handler.mjs`

### 2.1 pipeline.mjs 改动

在 `fetch_info` 节点后、`download_audio` 节点前,插入新节点 `agent_reach_get`:

```js
{
  id: "agent_reach_get",
  label: "获取内容",
  weight: 0.10,
  async run(ctx, { signal, onProgress }) {
    // 尝试通过 agent-reach 获取字幕
    const content = await fetchContent(ctx.url, { signal });
    if (content && content.text) {
      // 有字幕,跳过下载和转录
      return {
        segments: textToSegments(content.text),
        transcriptTxt: content.text,
        detectedLanguage: content.metadata?.language || "",
        skipDownload: true,
        skipTranscribe: true,
        contentTitle: content.title,
      };
    }
    // 没有字幕,走正常下载+转录流程
    return { skipDownload: false, skipTranscribe: false };
  },
}
```

`download_audio` 和 `download_video` 节点检查 `ctx.skipDownload`,为 true 时跳过。
`transcribe` 节点检查 `ctx.skipTranscribe`,为 true 时跳过(直接用 agent-reach 拿到的文本)。

### 2.2 textToSegments 辅助函数

Agent Reach 返回的是纯文本,没有时间戳。需要按句子分割成 segments:

```js
function textToSegments(text) {
  // 按句号/问号/感叹号/换行分割
  // 每个 segment 估算时间戳(按平均语速分配)
  // 返回 [{ segment_id, start_seconds, end_seconds, text }]
}
```

## Task 3: server.js 路由

**文件:**
- 修改 `server.js`

### 新增路由:

```
GET  /v1/video-kb/tools/agent-reach           # 探测 agent-reach 状态 + 已安装渠道
POST /v1/video-kb/tools/agent-reach/install   # 安装 agent-reach (后台任务)
POST /v1/video-kb/tools/agent-reach/channels  # 安装额外渠道 (后台任务)
```

## Task 4: 前端面板

**文件:**
- 修改 `desktop/src/modules/video-kb.ts`

### 改动:

1. 导入面板新增 Agent Reach 状态区域:
   - 已安装:显示绿色状态 + 已安装渠道列表
   - 未安装:显示安装按钮,点击后作为后台任务执行安装
   - 安装中:显示进度

2. 导入流程不变,用户还是输入 URL 点导入,底层自动判断是否走 Agent Reach

## 实施顺序

1. **Task 1** - 通用内容获取模块(无依赖)
2. **Task 2** - 管线集成(依赖 Task 1)
3. **Task 3** - server.js 路由(依赖 Task 1)
4. **Task 4** - 前端面板(依赖 Task 3)

## 测试策略

- `tests/unit/content-reach.test.mjs`: detector/fetcher mock 测试
- 管线测试:有 Agent Reach 字幕时跳过下载+转录
- 没装 Agent Reach 时 fallback 正常

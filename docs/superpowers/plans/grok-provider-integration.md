# Plan: 把 Grok 订阅转发接入现有本地网关

## 目标
让 `D:\agent-transfer\server.js` 这个已存在的 Node.js 网关,把客户端发来的标准 OpenAI / Anthropic 请求,转发到 Grok CLI 的聊天代理 `https://cli-chat-proxy.grok.com/v1`,用本地 `grok login` 的会话 JWT(`~/.grok/auth.json`)鉴权,消耗用户的 SuperGrok 订阅额度,而不是付费 API Key。Grok 作为现有 `anthropic` / `openai-chat` / `openai-responses` 之外的新 provider 类型接入。

## 已确认的协议(来源:grok CLI 源码 `D:\Java Project\grok-build` + 本机 `~/.grok/`)
- 基址 `https://cli-chat-proxy.grok.com/v1`(常量 `CLI_CHAT_PROXY_BASE_URL_DEFAULT`,`xai-grok-shell/src/agent/config.rs:46`)。
- 两种后端,由模型 `api_backend` 决定:
  - `grok-build` → `POST /chat/completions`,标准 OpenAI chat body,补 `{stream:true, stream_options:{include_usage:true}}`(`xai-grok-sampler/src/client.rs:263` `StreamingChatRequest`)。
  - `grok-4.5`、`grok-composer-2.5-fast` → `POST /responses`,标准 OpenAI Responses body,补 `include:["reasoning_encrypted_content"]`(`client.rs:1095-1147`)。
  - 两者返回的都是**标准 OpenAI SSE** → 现有 `consumeSse` + 各路 stream 翻译器已能直接处理。
- 请求头(伪装全集,`client.rs:58-70, 451-495, 2195`):`Authorization: Bearer <jwt>`、`X-XAI-Token-Auth: xai-grok-cli`、`x-grok-model-override: <model>`、`x-grok-conv-id/req-id/session-id/agent-id`、`x-grok-client-version`、`x-grok-client-identifier`、`User-Agent: <product>/<ver> (<os>; <arch>)`、`accept: text/event-stream`。
- 凭证:`~/.grok/auth.json` 是 `{ "<scope>": { key, refresh_token, expires_at, user_id, ... } }`,scope = `https://auth.x.ai::<client_id>`。取**第一条 entry 的 `key`**(不能写死 README 里的 `accounts.x.ai/sign-in` 路径,与本机不符)。CLI 用 `bearer_resolver` 每请求取新 token → 网关**每请求重读 auth.json** 即可吃到 CLI 后台刷新,v1 不自实现 OIDC 刷新。
- 连通性:`cli-chat-proxy.grok.com` 被 GFW 屏蔽;本机 7897 端口在监听(Clash/Mihomo 混合口)。网关需给 grok 请求单独挂 undici `ProxyAgent` 走 `http://127.0.0.1:7897`,**不全局化**,不干扰 Ark 等国内可达的 provider。
- 上游永远 `stream:true`(绝大多数模型只支持流式,README 明确)。客户端要非流式时,网关把 SSE 聚合成单条 JSON 返回。

## 原提示词里**不需要**的三件事(直连代理时不存在)
- 私有协议双向翻译 → 实为标准 OpenAI。
- ANSI / agent 状态流清洗 → 线路响应是干净 SSE,ANSI 只在 TUI 渲染层。
- 虚拟工作区 Mock → 代理是无状态聊天端点,workspace 是 CLI 本地的事,不随请求校验。

## 设计:新 provider 类型 `grok`

### 配置(`gateway.config.json`,在现有 client 桶如 `desktop` 下加 endpoint)
```json
{
  "name": "grok-subscription",
  "type": "grok",
  "base_url": "https://cli-chat-proxy.grok.com/v1",
  "auth_path": "~/.grok/auth.json",
  "agent_id_path": "~/.grok/agent_id",
  "proxy": "http://127.0.0.1:7897",
  "max_concurrency": 1,
  "client_version": "0.2.101",
  "models": ["grok-4.5", "grok-build", "grok-composer-2.5-fast"],
  "model_mapping": { "claude-opus-4-8": "grok-4.5", "grok": "grok-4.5" },
  "is_default": false
}
```
模型→后端映射:启动时 `loadGrokModelCatalog()` 读 `~/.grok/models_cache.json`,失败则回退硬编码(grok-4.5=responses, grok-build=chat, grok-composer-2.5-fast=responses)。

### `server.js` 代码改动
1. **`loadGrokModelCatalog()`**:读 `~/.grok/models_cache.json` → `Map<model, {api_backend, reasoning_effort, context_window}>`。
2. **`readGrokToken(authPath)`**:读 auth.json,返回首条 entry 的 `{key, user_id, expires_at}`。每请求重读(不缓存)。过期 → 抛清晰 401 "请运行 `grok` 刷新登录"。
3. **`grokHeaders(provider, model, token, authInfo)`**:组装伪装头全集。conv-id/req-id/session-id 每请求 `randomUUID()`;agent-id 读 `~/.grok/agent_id`(没有则生成并稳定化);user-id 取 auth.json;client-version 取 config/`~/.grok/version.json`;UA = `grok-cli/<ver> (<os>; <arch>)`。
4. **并发守卫 `grokSemaphore`**:按 provider 的小型 promise 队列,上限 `max_concurrency`(默认 1)。fetch 前 acquire,finally 里 release。防多标签页并发触发风控(原提示词第 4 点)。
5. **`fetchGrok(provider, endpointPath, body, clientReq)`**:
   - 解析 token + 头,body 强制 `stream:true`,
   - acquire 信号量,
   - `fetch(url,{method,headers,body,dispatcher:grokProxyAgent})` + `AbortController` 超时,
   - finally release。
   - `grokProxyAgent`:undici `ProxyAgent(provider.proxy)`,按 proxy URL 缓存;无 proxy 则 undefined。
6. **路由接入**:
   - `resolveConfiguredModel` 的 allowedTypes 列表里加 `"grok"`(在 `forwardOpenAIChatCompletions` / `forwardOpenAIResponses` / `forwardAnthropicMessages` 三处)。
   - `hasConfiguredApiKey(ep)`:grok 类型当 `readGrokToken()` 成功即视为已配置(类比 `"official"`)。
   - 每个转发器加 `route?.provider?.type === "grok"` 分支:按模型解析后端 → 用**现有**翻译器把入站 body 转成后端形状(chat↔responses↔anthropic)→ 调 `fetchGrok("/chat/completions" | "/responses", ...)` → 用**现有** stream 翻译器回吐(响应是标准 OpenAI SSE),非流式则聚合。
   - 因上游就是标准 OpenAI,响应侧几乎复用 `streamOpenAIChatAsAnthropicMessages` 等,新流式代码极少。
7. **模型发现**:grok endpoint 的 `models` 已会自动并入 `EXPOSED_MODELS`(server.js:50-59)→ 出现在 `/v1/models`。可选:`modelDiscovery` 里给 grok 模型标 `owned_by:"xai"`。

### 连通性(代理)
- Node 内置 `undici` 的 `ProxyAgent`(`import { ProxyAgent } from "undici"`),按 proxy URL 缓存,仅 grok fetch 传 `dispatcher`。其他 provider 不受影响。
- 默认 `http://127.0.0.1:7897`,可用 `GROK_PROXY` env 或 provider `proxy` 字段覆盖;留空则直连(适用海外/TUN 用户)。

## 分阶段交付
- **阶段 1**:grok provider 类型 + `readGrokToken` + `grokHeaders` + `fetchGrok` + 在 `forwardOpenAIChatCompletions` 接 `/chat/completions` 后端(grok-build)。跑通一次真实请求。
- **阶段 2**:`/responses` 后端(grok-4.5)在三个转发器接入 + 复用 stream 翻译 + 非流式聚合 + 代理 + 信号量。
- **阶段 3(后续可选)**:OIDC refresh_token 自动刷新;config-panel UI 加 grok;`reasoning_effort` 透传。

## 验证
- `node --check server.js`。
- 启动网关,经本地 Clash 代理,`curl http://127.0.0.1:8787/v1/chat/completions` 用 `grok-4.5`(流式 + 非流式),确认 token 正常流出且与直连 grok 一致。
- `/v1/models` 列出 grok 模型。
- 回归:Ark 等其他 provider 仍正常。

## 涉及文件
- `D:\agent-transfer\server.js`(新函数 + 路由分支)。
- `D:\agent-transfer\gateway.config.json`(加 grok endpoint)。
- (后续可选)`D:\agent-transfer\desktop\config-panel.html`(grok UI)。

## 风险 / 待确认
- Token 过期:用户久未运行 `grok` 会 401;v1 给清晰错误,阶段 3 加自动刷新。
- 代理端口(7897):实现时用 PowerShell 复核系统代理/Clash;反正可配置。
- `x-grok-client-identifier` / UA product 串:暂用 `grok-cli` + `~/.grok/version.json` 的版本;若代理拒绝再据二进制微调。
- 风控:全头伪装 + 并发上限(默认 1)已足;可调。

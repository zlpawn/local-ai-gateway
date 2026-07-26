# Antigravity v1internal 上游集成技术方案

> 分支:`feat/antigravity-v1internal`  worktree:`.worktrees/antigravity-v1internal`
> 目标读者:负责实施的模型 / 工程师。本文提供架构、模块契约、关键实现值与实施步骤,可直接照做。
> 接力执行:先读第 17 节(协作约定)与第 18 节(实施进度),确认当前 Phase 后从下一阶段继续。

## 1. 目标

在 local-ai-gateway 单进程内集成 Google Antigravity 订阅提供的 Gemini 模型,使 Codex 能在模型列表中选用并实际调用,使用用户的 Antigravity 订阅额度,无需独立 API key。

## 2. 约束

- 不修改 Antigravity 应用(app.asar、language_server),不依赖本机正在运行的 Antigravity 进程
- 不使用 MITM 代理
- 单进程:全部逻辑以 Node.js ESM 模块形式集成进现有 gateway,不引入额外常驻进程
- 复用现有 Codex `/v1/responses` 适配层与 `writeCodexModelCatalog` 机制
- 仅支持 Google 官方 Gemini 模型;不支持 Antigravity 经 Vertex 的 Claude / GPT-OSS
- 代码独立隔离:antigravity 集成代码独立自包含,与既有 gateway 逻辑解耦,可独立移除,不影响老逻辑(详见 2.1)

### 2.1 隔离与兼容性原则

核心原则:antigravity 集成代码必须独立自包含,与既有 gateway 逻辑解耦,做到可独立移除、出问题可干净回滚、对老逻辑零影响。这是整个集成的硬约束,优先级高于功能完整性。

落实点:

1. 模块独立:全部新逻辑放在新增的 `lib/antigravity/` 目录,自包含;不反向依赖 `lib/codex/` 内部实现,仅在 `/v1/responses` 出口处复用已导出的 `ResponsesWriter` 等公开组件。

2. server.js 最小增量、分支式扩展:只新增分支,不改既有分支。具体:`endpoint.type` 分发处新增 `'antigravity'` 分支转交 `lib/antigravity/`;`writeCodexModelCatalog` 内新增对 `type === 'antigravity'` 的处理。不修改任何既有 type 的处理路径与既有 catalog 写入逻辑。

3. 不污染全局状态:token / project / session 缓存由 antigravity 模块自管(模块级闭包或独立 store),不写入 gateway 共享运行时状态。

4. 配置可选:`clients.codex.endpoints[]` 不含 `type === 'antigravity'` 时,gateway 行为与当前完全一致;不引入任何新的必需环境变量或启动参数。

5. 错误隔离:antigravity 请求失败按现有错误响应格式返回,不抛未捕获异常导致 gateway 崩溃;antigravity 故障不影响其他 endpoint 正常服务。

6. 依赖隔离:不引入新 npm 运行时依赖,仅用 Node 内置模块 + 现有 `https-proxy-agent`。

7. 测试独立:新增 `tests/unit/antigravity-*.test.mjs`、`tests/integration/antigravity-gateway.test.mjs`、`tests/e2e/antigravity-e2e.mjs`,不混入现有 codex 测试套件。

8. 回滚简单:出问题时,移除 `lib/antigravity/` + 撤销 server.js 的几行分发/catalog 增量 + 删除对应 endpoint 配置,即可完全回退,既有逻辑零影响。

## 3. 总体架构

新增 endpoint `type = 'antigravity'`。请求流:

```
Codex -> POST /v1/responses (server.js:835)
  -> 按 endpoint.type 路由 (server.js:4653)
  -> lib/antigravity/index.mjs
       -> ensureFreshToken (oauth + token-store)
       -> loadCodeAssist (拿 cloudaicompanionProject,缓存)
       -> request-builder: Codex responses -> v1internal generateContent body
       -> upstream: POST cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
       -> response-streamer: v1internal SSE -> Codex responses 事件
       -> ResponsesWriter (复用 lib/codex/responses-writer.mjs)
```

鉴权链:OAuth 浏览器登录 -> access_token + refresh_token 持久化 -> loadCodeAssist 拿 project -> generateContent 带 project / sessionId。

## 4. 模块划分

### 4.1 新增 `lib/antigravity/`

| 文件 | 职责 |
|---|---|
| constants.mjs | OAuth client/secret、endpoint URL、scope、redirect port、刷新提前量 |
| oauth.mjs | buildAuthUrl / exchangeCode / refreshToken / ensureFreshToken / getUserInfo |
| oauth-callback-server.mjs | 本地 HTTP server 接收 OAuth callback |
| token-store.mjs | token 持久化 + account_id 读取 |
| session-id.mjs | FNV-1a(account_id) -> sessionId |
| upstream.mjs | call_v1_internal:loadCodeAssist / onboardUser / generateContent / streamGenerateContent,含 403 重试 |
| request-builder.mjs | Codex responses -> v1internal 请求体(含 systemInstruction 注入、字段排序) |
| response-streamer.mjs | v1internal SSE 解析 -> Codex responses 事件流 |
| system-prompt.mjs | 内嵌 antigravity identity system prompt(从 AG wrapper.rs 提取) |
| models.mjs | antigravity model enum <-> catalog 显示名映射 |
| index.mjs | 适配器主入口,编排上述模块 |

### 4.2 修改文件

- `server.js:835` 附近:`/v1/responses` 处理中,`endpoint.type === 'antigravity'` 时转交 `lib/antigravity/index.mjs`
- `server.js:4653` 附近:路由白名单加入 `'antigravity'`
- `server.js:6207` `writeCodexModelCatalog`:把 antigravity endpoint 的模型写入 catalog
- `lib/codex/model-catalog.mjs`:支持读取 type=antigravity 的 endpoint 模型
- `gateway.config.example.json`:增加 antigravity endpoint 示例
- `package.json`:无新运行时依赖(仅 Node 内置 + 现有 https-proxy-agent)

## 5. 模块接口契约

```
// constants.mjs
export const OAUTH_CLIENT_ID
export const OAUTH_CLIENT_SECRET
export const AUTH_URL            // accounts.google.com/o/oauth2/v2/auth
export const TOKEN_URL           // oauth2.googleapis.com/token
export const USERINFO_URL        // googleapis.com/oauth2/v2/userinfo
export const SCOPES              // 字符串数组
export const V1INTERNAL_BASE_URLS // [prod, daily, sandbox]
export const REDIRECT_PORT       // 本地 callback 端口,默认 8080
export const TOKEN_REFRESH_SKEW_SECONDS // 900

// oauth.mjs
export function buildAuthUrl(redirectUri, state) -> string
export async function exchangeCode(code, redirectUri) -> TokenResponse
export async function refreshToken(refreshToken) -> TokenResponse
export async function ensureFreshToken(store) -> { access_token, expires_at }
export async function getUserInfo(accessToken) -> { email, name, ... }

// token-store.mjs
export class TokenStore { load(); save(token); getAccountId(); }

// session-id.mjs
export function deriveSessionId(accountId) -> string  // FNV-1a 32bit hex

// upstream.mjs
export async function loadCodeAssist(accessToken) -> { cloudaicompanionProject, ... }
export async function onboardUser(accessToken) -> any
export async function generateContent(accessToken, project, sessionId, body, { stream }) -> Response | AsyncIterator

// request-builder.mjs
export function buildGenerateContentRequest(codexReq, { project, sessionId, account }) -> v1internalBody

// response-streamer.mjs
export async function* streamResponses(v1internalSse, { model }) -> yields Codex response events

// index.mjs
export async function handleAntigravityResponses(req, res, { endpoint, writer })
```

## 6. OAuth 契约(确切值)

- `AUTH_URL` = `https://accounts.google.com/o/oauth2/v2/auth`
- `TOKEN_URL` = `https://oauth2.googleapis.com/token`
- `USERINFO_URL` = `https://www.googleapis.com/oauth2/v2/userinfo`
- `CLIENT_ID` / `CLIENT_SECRET`:Antigravity 应用自带的公开 OAuth client 凭据,从 AG-Manager `src-tauri/src/modules/oauth.rs:6-9` 提取(实际值不写入本文档,避免触发 secret 扫描)
- `SCOPES`(空格连接):
  - `openid`
  - `https://www.googleapis.com/auth/cloud-platform`
  - `https://www.googleapis.com/auth/userinfo.email`
  - `https://www.googleapis.com/auth/userinfo.profile`
  - `https://www.googleapis.com/auth/cclog`
  - `https://www.googleapis.com/auth/experimentsandconfigs`
- auth url 参数:`response_type=code`、`access_type=offline`、`prompt=consent`、`include_granted_scopes=true`、`state=<随机>`
- `redirect_uri` = `http://localhost:{REDIRECT_PORT}/callback`
- exchange:`POST TOKEN_URL`,body `grant_type=authorization_code` + code + redirect_uri + client_id + client_secret
- refresh:`POST TOKEN_URL`,body `grant_type=refresh_token` + refresh_token + client_id + client_secret
- 提前刷新:`expires_at - 900s` 即触发 refresh;refresh 失败 -> 标记需重新 OAuth

参考:AG `src-tauri/src/modules/oauth.rs:329-560`、`oauth_server.rs`。

## 7. v1internal 上游契约

BASE URL(fallback 顺序,AG `upstream/client.rs:64-69`):

- prod:`https://cloudcode-pa.googleapis.com/v1internal`
- daily:`https://daily-cloudcode-pa.googleapis.com/v1internal`
- sandbox:`https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal`

方法(均 `POST {base}:<method>`):

- `:loadCodeAssist` -> 返回 `cloudaicompanionProject`(首次 / 缓存失效时调)
- `:onboardUser`(若 loadCodeAssist 提示未 onboard,先调它再重试)
- `:generateContent`(非流式)
- `:streamGenerateContent?alt=sse`(流式)

Headers:

- `Authorization: Bearer {access_token}`
- `x-goog-user-project: {cloudaicompanionProject}`(从 body.project 提取注入)
- `x-vscode-sessionid: {sessionId}`
- `Content-Type: application/json`

行为:

- `streamGenerateContent` 用 chunked 传输仿真(AG `client.rs:419`)
- 403 且带 `x-goog-user-project` -> 移除该 header 重试一次(AG `client.rs:461-518`)
- 5xx / 网络错误 -> 切下一个 BASE URL

参考:AG `src-tauri/src/proxy/upstream/client.rs:300-560`。

## 8. 请求体构造

外层结构(AG `wrapper.rs` wrap_request_v2,字段顺序影响上游缓存,稳定前缀在前):

```
{
  request: {
    systemInstruction: { parts: [{ text }] },      // instructions + antigravity identity(~17.5K)
    tools: { functionDeclarations: [...] },         // Codex tools 扁平化 + 按 name 排序
    toolConfig: { ... },
    generationConfig: { temperature, maxOutputTokens, topP, thinkingConfig: { thinkingBudget } },
    sessionId: 'fnv1a-hex',                         // FNV-1a(account_id)
    contents: [ { role, parts } ]                   // Codex input[] 映射
  },
  project: 'cloudaicompanion-project-id',
  userAgent: 'antigravity',                         // 动态仿真,见 wrapper.rs:780
  requestId: '<uuid>'
}
```

字段映射(`request_transform.md`):

- Codex `instructions` -> sanitize(清动态值)-> + antigravity identity -> `systemInstruction.parts[].text`
- Codex `input[]` message -> `contents[role=user/model].parts[text / inlineData]`
- Codex `function_call` -> `contents[role=model].parts[functionCall:{name,args,id}]`
- Codex `function_call_output` -> `contents[role=user].parts[functionResponse:{name,response,id}]`
- Codex `tools[]` -> flatten namespace -> sort by name -> clean schema -> `functionDeclarations`
- `temperature` / `max_tokens` / `top_p` -> `generationConfig`
- `thinking` -> `generationConfig.thinkingConfig.thinkingBudget`

systemInstruction 中的 antigravity identity:从 AG `wrapper.rs` 提取,逐字复刻(约 17.5K tokens)。这是请求被 Google 后端识别为 Antigravity 的关键,必须 1:1,缺一字段即被拒或行为异常。抽成 `system-prompt.mjs` 常量。

参考:AG `src-tauri/src/proxy/mappers/gemini/wrapper.rs`、`request_transform.md`、`proxy/common/session.rs`(derive_session_id)。

## 9. 响应流转

`streamGenerateContent?alt=sse` 返回 SSE,每行 `data: <json>`:

```
{ candidates: [{ content: { role, parts: [{ text }, { functionCall: { name, args, id } }] }, finishReason }], usageMetadata }
```

转 Codex responses 事件(复用 `lib/codex/responses-writer.mjs`):

- text part -> `response.output_text.delta`
- functionCall -> `response.function_call_arguments.delta` / `response.output_item.added`
- `finishReason=STOP` -> `response.completed`
- `usageMetadata` -> usage 统计

参考:AG `proxy/mappers/gemini/collector.rs`、`lib/codex/responses-writer.mjs`、`responses-collector.mjs`。

## 10. 模型目录集成

目标:Codex 模型列表显示 Antigravity 的 Gemini 模型。

- `writeCodexModelCatalog`(`server.js:6207`)遍历 `clients.codex.endpoints`,对 `type === 'antigravity'` 的 endpoint 取其 `models` 字段
- 写入 `~/.codex/gateway-model-catalog.json`(`CODEX_MODEL_CATALOG_PATH`,`server.js:141`),带 `capabilities`
- 模型名 <-> v1internal model 字段映射在 `models.mjs`
- 可选增强:首次启动调 v1internal `GetAvailableModels` 动态拉取并缓存(参考 AG `upstream/client.rs:552 fetch_available_models`)

## 11. 配置设计

`gateway.config.json` 的 `clients.codex.endpoints[]` 新增:

```
{
  id: 'ep_antigravity',
  name: 'antigravity-subscription',
  type: 'antigravity',
  auth: 'oauth',
  token_path: '~/.codex/antigravity-token.json',
  models: ['gemini-3-pro', 'gemini-3-flash'],
  model_mapping: {},
  capabilities: { input_modalities: ['text', 'image'], reasoning: true, tools: true },
  is_default: false
}
```

OAuth 登录由 CLI(`bin/cli.js`)触发:启动 `oauth-callback-server`,打开浏览器,拿 token 存 `token_path`。

## 12. 关键风险与对策

1. systemInstruction 17.5K prompt 对齐:从 AG `wrapper.rs` 逐字提取,抽常量 + 单测比对哈希
2. sessionId 算法:FNV-1a,用 AG test vector(`oauth.rs:725` 附近测试)验证
3. v1internal 黑盒错误(401/403/400):详细日志 + 与 AG 实际请求抓包对比
4. token / session 过期:access_token ~1h,refresh;Antigravity session 可能每天过期。`ensureFreshToken` + 401 自动 refresh 重试一次,仍失败提示重新 OAuth
5. 首次 onboard:`loadCodeAssist` 可能返回需 onboard -> 自动调 `onboardUser` 后重试
6. 403 + `x-goog-user-project`:移除 header 重试(AG `client.rs:461`)
7. Google 协议变更(长期):v1internal 是内部 API。模块化隔离,变更只动 `upstream` / `request-builder`;关注 AG-Manager 上游更新

## 13. 实施步骤

Phase 1 - OAuth 与 token

- 实现 `constants` / `oauth` / `oauth-callback-server` / `token-store`
- CLI 触发登录,拿 token 存盘,`getUserInfo` 拿 email 算 account_id
- 验证:token 能调通 `loadCodeAssist` 拿到 project

Phase 2 - 单次 generateContent

- 实现 `session-id` / `upstream`,`request-builder` 最小版(硬编码一个 prompt,先不接 tools)
- 调 `generateContent`(非流式)拿到一次文本
- 验证:返回 Gemini 文本

Phase 3 - 流式与 responses 转换

- `request-builder` 完整版(tools / contents 映射)+ `response-streamer`
- 接 `streamGenerateContent`,转 Codex responses SSE
- 验证:Codex 收到流式输出与 tool call

Phase 4 - 路由与模型目录集成

- `server.js` 注册 antigravity type 路由 + 白名单
- `writeCodexModelCatalog` 注入 antigravity 模型
- 验证:Codex 列表显示模型,选用后端到端跑通

Phase 5 - 测试与健壮性

- 单测 + 集成 + e2e + 错误处理(token 过期、403、onboard)

## 14. 测试策略

- 单元:`session-id.mjs` 用 AG test vector;`request-builder` 用固定 Codex 请求比对输出;`response-streamer` 用录制 SSE 比对事件
- 集成:`tests/integration/antigravity-gateway.test.mjs`,mock upstream
- e2e:`tests/e2e/antigravity-e2e.mjs`,真实 OAuth(需 token),跑一次 Codex `/v1/responses`
- 参考现有模式:`tests/unit/codex-chat-request-adapter.test.mjs`、`codex-responses-writer.test.mjs`

## 15. 参考代码定位

AG-Manager 源码:`D:/Java Project/antigravity-manager-ref`

- OAuth:`src-tauri/src/modules/oauth.rs`、`oauth_server.rs`
- 上游调用:`src-tauri/src/proxy/upstream/client.rs`
- 请求体构造:`src-tauri/src/proxy/mappers/gemini/wrapper.rs`(72.9KB,核心)
- 协议映射说明书:`request_transform.md`
- session:`src-tauri/src/proxy/common/session.rs`

gateway 对接点:

- `/v1/responses` 入口:`server.js:835`
- type 路由:`server.js:4653`
- 模型目录:`server.js:6207`、`lib/codex/model-catalog.mjs`
- 适配器模式参考:`lib/codex/`(`responses-writer.mjs`、`chat-request-adapter.mjs`、`responses-collector.mjs`)

## 16. 附录:已知数据点

- OAuth client_id / secret:见第 6 节
- cloudaicompanionProject 示例:`concrete-vortex-1jlsj`(实际值由 `loadCodeAssist` 返回)
- 本机 Antigravity language_server 端口 6046/6045:本方案不依赖,仅背景
- Antigravity 应用自带的 token 在 Windows Credential Manager `gemini:antigravity`:本方案用独立 `token_path` 存储,互不冲突
## 17. 协作与接力约定

本方案支持多模型接力实施,遵循以下约定:

1. 分支隔离:所有代码改动只在 `feat/antigravity-v1internal` 分支进行,不修改 `main`,不向 `main` 合并或推送(除非用户明确指示)。worktree 路径 `.worktrees/antigravity-v1internal`。

2. 阶段同步:每完成一个 Phase(见第 13 节),执行者必须更新第 18 节"实施进度",记录:新增/修改文件清单、验证结果、偏离方案的设计决策与原因、下一阶段起点与注意事项;随后 commit + push 到当前分支。

3. 接力执行:新模型接手时,先读第 17、18 节,确认当前 Phase 与已完成内容,从下一 Phase 继续,不重做已完成阶段。

4. commit 规范:每个 Phase 提交信息以 `phase N:` 开头,便于追溯。

5. 遵守隔离:接力实施仍须遵守第 2.1 节,对 server.js 等既有文件只做增量分支式扩展。

## 18. 实施进度

| Phase | 状态 | 完成内容 | 验证 | 备注 |
|---|---|---|---|---|
| 0 - 准备 | 已完成 | 方案文档、worktree、分支 `feat/antigravity-v1internal` | commit 1e78a59 已 push | main 已合并(c95db7c),desktop 已废弃 |
| 1 - OAuth 与 token | 进行中 | | | 起点:lib/antigravity/ 的 OAuth + token-store + session-id + CLI login |
| 2 - 单次 generateContent | 未开始 | | | |
| 3 - 流式与转换 | 未开始 | | | |
| 4 - 路由与目录 | 未开始 | | | |
| 5 - 测试与健壮性 | 未开始 | | | |

当前接力起点:**Phase 1**。

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
       -> grpc.mjs: gRPC PredictionService/GenerateContent (daily-cloudcode-pa.googleapis.com)
       -> response-streamer: v1internal gRPC -> Codex responses 事件
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
    systemInstruction: { role:"user", parts:[{text:identity},{text:instructions}] },  // 短 identity stub(~330字符) + 保留的 Codex instructions
    tools: { functionDeclarations: [...] },         // Codex tools 扁平化 + 按 name 排序
    toolConfig: { ... },
    generationConfig: { temperature, maxOutputTokens, topP, thinkingConfig: { thinkingBudget } },
    sessionId: '<64位FNV十进制有符号串>',                  // FNV-64(account_id),见 session-id.mjs
    contents: [ { role, parts } ]                   // Codex input[] 映射
  },
  project: 'cloudaicompanion-project-id',
  model: 'gemini-3-pro',
  userAgent: 'antigravity',
  requestType: 'agent',
  requestId: 'agent/antigravity/<sid前8位>/<消息数>',
  enabledCreditTypes: ['GOOGLE_ONE_AI']
}
```

字段映射(`request_transform.md`):

- Codex `instructions` -> 原样保留(不 sanitize,对齐 AG openai/request.rs:1102)-> 前置 antigravity identity -> `systemInstruction.parts[].text`
- Codex `input[]` message -> `contents[role=user/model].parts[text / inlineData]`
- Codex `function_call` -> `contents[role=model].parts[functionCall:{name,args,id}]`
- Codex `function_call_output` -> `contents[role=user].parts[functionResponse:{name,response,id}]`
- Codex `tools[]` -> flatten namespace -> sort by name -> clean schema -> `functionDeclarations`
- `temperature` / `max_tokens` / `top_p` -> `generationConfig`
- `thinking` -> `generationConfig.thinkingConfig.thinkingBudget`

antigravity identity(修正):AG `wrapper.rs:694-702` 实为**短 stub**(~330字符,4行:"You are Antigravity...**Proactiveness**"),**非 17.5K**。所谓"~17,500 tokens"是 AG `openai/request.rs:1240` 对**组装后 systemInstruction 整块**(identity + 保留的调用方 instructions)规模的描述,以调用方 instructions 为主。Codex `instructions` 按 `openai/request.rs:1102` 逐字保留,不覆盖不摘要。identity 抽成 `system-prompt.mjs` 常量,与 `wrapper.rs` 1:1。

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

gateway.config.json 的 clients.codex.endpoints[] 新增(仅声明模型与能力,不含凭据):

{
  id: 'ep_antigravity',
  name: 'antigravity-subscription',
  type: 'antigravity',
  models: ['gemini-3-pro', 'gemini-3-flash'],
  model_mapping: {},
  capabilities: { input_modalities: ['text','image'], reasoning: true, tools: true },
  is_default: false
}

凭据存储(独立文件,与历史 secrets 完全隔离,零改 prepareState):

- 文件:`antigravity.secrets.json`,与 `gateway.secrets.json` 同目录(即 `path.dirname(GATEWAY_CONFIG_FILE)`);可用环境变量 `ANTIGRAVITY_SECRETS_FILE` 覆盖
- 格式(JSON 风格与 `gateway.secrets.json` 一致:2 空格缩进、双引号、下划线命名):
  {
    "client_id": "...apps.googleuser.test",
    "client_secret": "FAKESEC-...",
    "access_token": "ya29...",
    "refresh_token": "1//...",
    "expires_at": 1758900000,
    "account_id": "you@gmail.com"
  }
- `client_id` / `client_secret`:登录前手填一次(从 AG-Manager `src-tauri/src/modules/oauth.rs:6-9` 取值)
- `access_token` / `refresh_token` / `expires_at` / `account_id`:OAuth 登录后 gateway 自动写入;token 刷新时只更新这几个字段(原子写,不动 client 凭据)
- 加入 `.gitignore`(与 `gateway.secrets.json` 并列),不进 git、不触发 secret 扫描
- 不复用 `gateway.secrets.json` 的 prepareState 保存机制(该机制重建 secrets 时只保留 `api_keys`,会擦掉 antigravity 顶层字段);antigravity 模块自管读写,与历史 secrets 零交互

OAuth 登录由 CLI(`bin/cli.js`)触发:启动 `oauth-callback-server`,打开浏览器,拿 token 写入 `antigravity.secrets.json`。

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
| 1 - OAuth 与 token | 已完成(代码) | lib/antigravity/: constants.mjs, token-store.mjs, oauth.mjs, oauth-callback-server.mjs, cli.mjs, index.mjs;gateway-service.mjs 接入 antigravity 子命令;.gitignore 加 antigravity.secrets.json | token-store 8 测试 + cli 3 测试全过;全量 node --check 通过 | 端到端 OAuth 登录验证待用户填 client_id/secret 后执行 `local-ai-gateway antigravity login`;sessionId 算法修正见下 |
| 2 - 单次 generateContent | 已完成(代码) | lib/antigravity/: session-id.mjs(64位 FNV,BigInt)、upstream.mjs(call_v1_internal/loadCodeAssist/generateContent/streamGenerateContent,端点 fallback+403降级+完整指纹 headers)、request-builder.mjs(Phase 2 最小版,单轮文本无 tools/identity) | session-id 4 测试(含空串=offset basis 精确 vector)+ upstream 8 测试全过;全部 23 测试通过;全量 node --check 干净 | generateContent 端到端验证待 Phase 4 路由打通(identity 已在 Phase 3 修正为短 stub,见下);loadCodeAssist 端到端验证待用户 login 后执行 |
| 3 - 流式与转换 | 已完成(代码) | lib/antigravity/: system-prompt.mjs(antigravity identity 短 stub 1:1)、request-builder.mjs 完整版(instructions 保留+identity 前置、input[]->contents 角色映射、function_call/output->functionCall/Response 含 call_id->name 预扫描、tools->functionDeclarations 排序、generationConfig 映射、外层 project/model/userAgent/requestType/requestId/enabledCreditTypes、内层字段顺序稳定前缀在前)、response-streamer.mjs(v1internal SSE 解 response 包裹->Codex responses 事件,复用 ResponsesWriter);index.mjs 导出更新 | system-prompt 3 测试 + request-builder 10 测试 + response-streamer 5 测试全过;全部 41 antigravity 测试通过;全量 165 测试通过;全量 node --check 干净 | **关键修正见下**:identity 非 17.5K,实为 ~330 字符 stub;新增 `scripts/antigravity-smoke.mjs` 可直接验证 Phase 1-3 链路(见第 19 节);Codex 列表级端到端待 Phase 4 |
| 4 - 路由与目录 | 未开始 | | | |
| 5 - 测试与健壮性 | 未开始 | | | |

> Phase 1 偏离记录:方案原写"验证 token 调通 loadCodeAssist",实际 Phase 1 用 getUserInfo 验证 token 有效(更轻量);loadCodeAssist 完整实现移到 Phase 2(随 upstream 一起)。
>
> sessionId 算法修正(Phase 2 已落实):AG `proxy/common/session.rs` 实为 **64 位 FNV**,非 32 位 hex。offset basis `0xCBF29CE484222325`(i64 有符号 `-3750763034362895579`),prime `1099511628211`,每字节先 `wrapping_mul` 后 `xor`,输出十进制有符号字符串。第 5/8 节的"FNV-1a / fnv1a-hex"描述已在 Phase 3 更正。
>
> Phase 3 偏离记录(重要):方案原称 antigravity identity "~17.5K tokens,必须 1:1",经核实 **AG `wrapper.rs:694-702` 实为 ~330 字符短 stub**(4 行:"You are Antigravity...**Proactiveness**")。所谓 ~17,500 tokens 是 AG `openai/request.rs:1240` 对**组装后 systemInstruction 整块**(identity + 保留的调用方 instructions)规模的描述,以调用方 instructions 为主。Codex `instructions` 按 `openai/request.rs:1102` 逐字保留、不覆盖不摘要。本阶段 identity 抽成 `system-prompt.mjs` 与 wrapper.rs 1:1。
>
> Phase 3 其他实现决策:(1) 模型/工具名保持原样,**未**做 AG 的 `local_shell_call`->`shell` 重命名(我们同时控制声明与调用,名称一致即可;如 Google 后端要求保留名,Phase 5 再加);(2) thinking 签名(thoughtSignature)暂不注入,仅当 Codex 显式带 `thinking.budget_tokens` 时设 `thinkingConfig.thinkingBudget`;gemini-3 thinking 模型的 functionCall 签名需求留待 Phase 5;(3) response-streamer 假设 functionCall 在单帧内完整(Gemini 常见行为),跨帧分片累积留待 Phase 5;(4) requestId 用 AG `openai/request.rs:1253` 格式 `agent/antigravity/<sid前8位>/<消息数>`(非 wrapper.rs 的 `agent/<ts>/<hex>`,因输入是 Codex/OpenAI 形态)。
>
> **gRPC 切换(2026-07-27,重要)**:REST `v1internal:streamGenerateContent` 对订阅用户返回 403 SERVICE_DISABLED(cloudaicompanion 项目未启用 Cloud Code Private API,`gcpManaged: false`)。官方 Antigravity IDE 实际使用 gRPC(`google.internal.cloud.code.v1internal.PredictionService/GenerateContent`),不走 REST。已从 IDE `language_server` 二进制提取完整 proto 定义,确认服务输入类型是 `v1internal.GenerateContentRequest`(包装器:project/request/model/userAgent/requestType/enabledCreditTypes),而非扁平的 `aiplatform.master.GenerateContentRequest`。
>
> 新增 `lib/antigravity/proto-codec.mjs`(手写 protobuf 编解码,零外部依赖)和 `lib/antigravity/grpc.mjs`(HTTP/2 gRPC 传输,支持 HTTP CONNECT 代理隧道)。`response-streamer.mjs` 重构为共享 `processResponseData()`,新增 `streamGrpcResponses()` 入口。`loadCodeAssist` 保持 REST(该端点不受 API 启用限制)。smoke test 已切换到 gRPC 路径并验证通过(gemini-pro-agent + gemini-3-flash)。
>
> 代理注意:Node.js `http2.connect` 不读 `http_proxy`/`https_proxy` 环境变量,`grpc.mjs` 手动通过 HTTP CONNECT 建立隧道。无代理环境自动直连。
>
**Phase 4 已完成(2026-07-27)**:server.js 路由 + 模型目录集成已完成。新增 `proxyAntigravityResponse()` 函数(server.js),在 `forwardResolvedCodexResponse` 中添加 `antigravity` 分支(流式 + 非流式)。`model-catalog.mjs` 和 `config-validation.mjs` 已添加 `antigravity` 到支持类型。`hasConfiguredApiKey` 对 antigravity 类型返回 true(OAuth 鉴权,无 API key)。`gateway.config.json` 已添加 antigravity 端点(models: gemini-pro-agent, gemini-3-flash, gemini-3-flash-agent)。

端到端验证通过(gateway 端口 8789):
- 非流式:POST /v1/responses + x-gateway-client: codex + model=gemini-pro-agent -> 200 JSON,response.output_text + usage
- 流式:同上 + stream=true -> SSE 事件链 created->output_item.added->text.delta->output_item.done->completed

**Phase 5 已完成(2026-07-27)**:测试与健壮性。

新增测试:
- `tests/unit/antigravity-grpc-streamer.test.mjs`(6 测试):gRPC 响应流处理(text/functionCall/thought/terminal finish/raw frames)
- `tests/unit/antigravity-proto-codec.test.mjs` 扩展(13 测试):编码/解码 round-trip、多 candidate、traceId、functionCall 解码、空输入边界
- `tests/integration/antigravity-gateway.test.mjs`(3 测试):mock gRPC + REST 服务器,验证非流式/流式/gRPC 错误 502

可测试性改造(生产代码最小改动):
- `grpc.mjs`:`ANTIGRAVITY_GRPC_HOST`/`ANTIGRAVITY_GRPC_PORT`/`ANTIGRAVITY_GRPC_INSECURE` 环境变量,支持 mock 服务器
- `constants.mjs`:`ANTIGRAVITY_REST_BASE_URL` 环境变量,支持 mock loadCodeAssist
- gRPC 客户端同时检查 response headers 和 trailers 中的 grpc-status(修复无数据错误响应的检测)

测试统计:188 单元测试 + 3 antigravity 集成测试 + 28 其他集成测试,全部通过。smoke test 真实 API 验证通过。

集成方案不再需要改动。所有 5 个 Phase 已完成。

> 本机状态(2026-07-27):`antigravity.secrets.json` 已在本机 worktree 预填好 client_id/secret(取自 AG `oauth.rs:6-7`),但该文件 .gitignore 不进 git,**换台机器需重新创建**(见第 19.1 节)。本机尚未执行 `antigravity login`(无 token),待用户在测试机上登录。

## 19. 测试指南(换台机器验证)

本节供在另一台机器(或另一模型)上验证当前 Phase 1-3 成果。Phase 4(server.js 路由 + catalog)未完成前,Codex 列表里还选不到 antigravity 模型,但 OAuth + v1internal 上游链路已可独立验证。

### 19.1 环境准备

1. 拉代码并切到特性分支:

```
git clone https://github.com/zlpawn/local-ai-gateway.git
cd local-ai-gateway
git checkout feat/antigravity-v1internal
```

2. 安装依赖(仅需 `https-proxy-agent`,其余用 Node 内置模块;Node >= 18,推荐 20+):

```
npm install
```

3. 在仓库根目录创建凭据文件 `antigravity.secrets.json`(与 `gateway.secrets.json` 同级;已 .gitignore,不进 git)。内容为 Antigravity 应用自带的公开 OAuth 凭据(client_id / client_secret):

```json
{
  "client_id": "<client_id,见下>",
  "client_secret": "<client_secret,见下>"
}
```

**实际值不写入本文档,避免触发 GitHub secret 扫描**(与第 6 节约定一致)。取值方式任选其一:(a) 从本机已填好的 worktree `antigravity.secrets.json` 拷贝到测试机;(b) 查 AG-Manager 开源仓库 `src-tauri/src/modules/oauth.rs:6-7`(`CLIENT_ID` / `CLIENT_SECRET` 两个常量)。client_id 形如 `数字-xxx.apps.googleuser.test`,client_secret 形如 `FAKESEC-...`。

### 19.2 测试 1:OAuth 登录(Phase 1,已可测)

```
node bin/cli.js antigravity login
```

浏览器自动打开 Google 授权页 -> 用**订阅了 Antigravity 的 Google 账号**登录并同意 -> 回调服务在 `http://localhost:8080/callback` 接收 code -> token 写回 `antigravity.secrets.json`。

验证:

```
node bin/cli.js antigravity status
```

应看到 `client_id: (set)`、`access_token: (set)`、`refresh_token: (set)`、`account_id: 你的邮箱`。

### 19.3 测试 2:v1internal 冒烟测试(Phase 2+3,已可测)

```
node scripts/antigravity-smoke.mjs                    # 默认 gemini-3-pro-preview
node scripts/antigravity-smoke.mjs gemini-3-flash     # 换模型
node scripts/antigravity-smoke.mjs gemini-2.5-flash
```

该脚本验证完整链路:OAuth refresh -> `loadCodeAssist`(拿 cloudaicompanionProject)-> `buildGenerateContentRequest`(Codex 请求 -> v1internal body)-> `streamGenerateContent` -> `streamResponses`(实时打印模型文本)。

成功标志:控制台打印出模型回复文本 + `[smoke] DONE - v1internal path works end-to-end.`。

可用模型名(v1internal 上游实际名,见 AG `model_mapping.rs:84-86`):`gemini-3-pro-preview`、`gemini-3-flash`、`gemini-2.5-flash`。注意 AG 会把 `gemini-3-pro` 映射成 `gemini-3-pro-preview`,冒烟脚本直接用上游名;Phase 4 的 catalog 会做这层映射。

### 19.4 当前可测 vs 待 Phase 4

- **已可测(Phase 1-3)**:OAuth 登录、token 刷新、`loadCodeAssist`、`generateContent`/`streamGenerateContent`、请求体构造(identity + instructions + contents + tools)、响应流转(SSE -> Codex 事件)。测试 1、2 现在就能跑。
- **待 Phase 4(未做)**:`server.js:835` 把 `/v1/responses` 在 `endpoint.type==='antigravity'` 时转交 `lib/antigravity/index.mjs`;`server.js:4653` 路由白名单加 `'antigravity'`;`server.js:6207` `writeCodexModelCatalog` 写入 antigravity 模型;`gateway.config.json` 加 antigravity endpoint 示例。Phase 4 完成后才能在 Codex 模型列表选到并用这些模型。届时用 8789 端口跑网关:

```
GATEWAY_PORT=8789 node bin/cli.js start
```

### 19.5 排错要点

- `[smoke] No token`:`antigravity.secrets.json` 没有 refresh_token,先跑 19.2 登录。
- `loadCodeAssist failed (401)`:token 过期且 refresh 失败,重新 `antigravity login`。
- `loadCodeAssist returned no cloudaicompanionProject (account may be ineligible)`:该 Google 账号无有效 Antigravity 订阅,换订阅账号登录。
- `generateContent/streamGenerateContent failed (400)`:请求体结构问题。重点核对:(a) `systemInstruction` 是否含 antigravity identity(`system-prompt.mjs`);(b) 内层字段顺序 systemInstruction->tools->toolConfig->generationConfig->sessionId->contents;(c) `model` 是否用上游名(`gemini-3-pro-preview` 而非 `gemini-3-pro`)。对照 AG `openai/request.rs`。
- `403` 且带 `x-goog-user-project`:`upstream.mjs` 已实现降级重试(移除该 header 重试一次);仍 403 多为账号配额/订阅问题。
- thinking 模型(`gemini-3-pro-preview`)带 functionCall 时若报缺 `thoughtSignature`:Phase 3 暂未注入 thinking 签名(见第 18 节 Phase 3 偏离记录),Phase 5 处理。纯文本对话不受影响。
- `redirect_uri_mismatch`:确认 `constants.mjs` 的 `REDIRECT_PORT=8080`、`REDIRECT_PATH=/callback` 未被改动(AG `oauth.rs:725` 测试佐证这是 client 注册地址)。

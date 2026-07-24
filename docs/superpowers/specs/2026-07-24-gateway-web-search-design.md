# Gateway Web Search Design

> Status: stream + config panel implemented
> Branch: `codex/gateway-web-search`
> Worktree: `.worktrees/gateway-web-search`
> Date: 2026-07-24

## 1. Goal

给 Local AI Gateway 增加**网关侧联网搜索能力**。

当第三方模型（例如 Ark 上的 `glm-5.2`）本身没有 hosted `web_search` 时，网关：

1. 注入一个标准 function tool：`web_search`
2. 在模型发起 tool call 后，由网关本地执行搜索
3. 把搜索结果写回对话，再继续请求上游模型

本期首发接入 **Tavily**，但搜索 provider 必须可扩展，后续可接 Brave / Perplexity / 其他。

## 2. Non-goals

本期明确不做：

- 不改 official GPT / chatgpt-codex 的 hosted `web_search` 执行路径
- 不做自动“看见问题就搜索”；只在模型主动 tool call 时执行
- 不做 `web_fetch` / crawl / multi-hop research agent
- 不把搜索结果强制塞进最终答案格式；最终回答仍由上游模型生成
- 不在本期做完整 config UI（可先 env / secrets / config JSON 可用）

## 3. Background: why some models can search and some cannot

联网搜索不是模型权重自带的能力，而是**运行时工具链路**：

| 路径 | 谁提供搜索 | 谁执行搜索 |
| --- | --- | --- |
| Official GPT / Codex subscription | OpenAI hosted tool `web_search` | OpenAI 后端 |
| Grok CLI / SuperGrok | Grok 自带 `web_search` / backend search | xAI 后端 |
| 第三方 GLM / DeepSeek / MiniMax 等 | 默认无 hosted search | 无，除非网关补 |

因此：

- 走 official GPT 时，模型“看起来会联网”，是因为 OpenAI 后端执行了 hosted tool
- 走 `glm-5.2` 时，上游通常只支持普通 function tools，不会替你搜网页
- 本功能就是：把“hosted search”降级成“gateway-owned function tool + local executor”

### 3.1 Official GPT path (unchanged)

现状：

- Codex Desktop 在 custom provider 场景下，经常不在 request body 里声明 hosted tools
- 网关在 **official 路径**上会注入 `{ "type": "web_search" }`
- 这个 tool 仍然由 OpenAI 后端执行，不是网关本地搜索

本期结论：

- official 路径继续只做“补声明”
- **不**把 official 的 `web_search` 改成网关执行
- 避免和 OpenAI hosted tool 语义冲突

### 3.2 Protocol conversion stays independent

网关已有协议转换：

- Responses <-> Chat Completions
- Anthropic Messages <-> Chat Completions
- Grok Responses / Chat 适配

本期搜索能力建立在转换之后：

```text
client protocol
  -> normalize / promote tools
  -> inject gateway web_search (if eligible)
  -> convert to upstream protocol
  -> call upstream model
  -> if model calls web_search:
       gateway executes provider
       append tool result
       call upstream again
  -> convert response back to client protocol
```

搜索执行层不关心客户端是 Codex / Claude Desktop / Claude Code / OpenAI Chat。

## 4. Product shape: capability nodes

联网搜索与视觉兜底一样，属于**能力节点**，不是普通聊天 endpoint。

### 4.1 Endpoint purposes

| purpose | 含义 | 是否进入 /v1/models |
| --- | --- | --- |
| （空 / 普通） | 聊天上游 | 是 |
| `vision_fallback` | 图片能力兜底 | 否 |
| `web_search` | 联网搜索能力节点 | 否 |

规则：

1. 用户配置 `purpose: "web_search"` 节点后，搜索能力才启用
2. 未配置搜索节点时，网关不注入、不执行搜索
3. 搜索节点不作为聊天模型暴露给客户端
4. 一个 client 可配置多个搜索节点，但只能有一个 default
5. 默认选 default 节点；未来可按 provider / model 路由扩展

### 4.2 Example config

```json
{
  "clients": {
    "codex": {
      "endpoints": [
        {
          "id": "ep_chat_default",
          "name": "huoshan-codingplan",
          "type": "openai-responses",
          "base_url": "https://ark.cn-beijing.volces.com/api/coding/v3",
          "models": ["glm-5.2", "minimax-m3"],
          "is_default": true
        },
        {
          "id": "ep_search_tavily",
          "name": "tavily-search",
          "purpose": "web_search",
          "provider": "tavily",
          "is_default": true,
          "enabled": true,
          "options": {
            "search_depth": "basic",
            "max_results": 5,
            "topic": "general",
            "include_answer": false,
            "include_raw_content": false,
            "country": "china"
          }
        },
        {
          "id": "ep_search_brave",
          "name": "brave-search",
          "purpose": "web_search",
          "provider": "brave",
          "is_default": false,
          "enabled": true,
          "options": {
            "count": 5,
            "search_lang": "zh-hans",
            "country": "CN"
          }
        }
      ]
    }
  }
}
```

Secrets:

```json
{
  "api_keys": {
    "ep_search_tavily": "env:TAVILY_API_KEY",
    "ep_search_brave": "env:BRAVE_API_KEY"
  }
}
```

### 4.3 Validation rules

- 同一 client 下 `purpose=web_search && is_default=true` 最多 1 个
- `purpose=web_search` 节点必须声明 `provider`
- provider 必须是已注册 provider id（本期：`tavily`）
- 没有 default 且存在多个启用节点时：启动/保存时报 warning，运行时拒绝选择（或取第一个启用节点；实现时优先严格）
- 搜索节点不参与 `expose_models` / model slot / official model merge

## 5. Tool contract

网关对模型暴露统一 function tool，不直接暴露 Tavily / Brave 细节。

### 5.1 Tool definition

```json
{
  "type": "function",
  "name": "web_search",
  "description": "Search the live web for up-to-date information. Use for current events, facts that may have changed, documentation lookups, and questions requiring citations.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search query. Prefer the user's language when appropriate."
      },
      "max_results": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10,
        "description": "Optional result count override."
      },
      "time_range": {
        "type": "string",
        "enum": ["day", "week", "month", "year"],
        "description": "Optional recency filter."
      }
    },
    "required": ["query"],
    "additionalProperties": false
  }
}
```

说明：

- tool 名固定 `web_search`，跨 provider 稳定
- 模型只看到统一 schema
- provider 专有参数放在搜索节点 `options`，不塞进 tool schema
- 若客户端已自带同名 `web_search` / `websearch` function，则不重复注入，也不接管执行（避免和客户端本地工具冲突）

### 5.2 Normalized search result

所有 provider adapter 输出同一结构：

```json
{
  "provider": "tavily",
  "query": "2026 年黄金价格走势",
  "answer": null,
  "results": [
    {
      "title": "...",
      "url": "https://...",
      "snippet": "...",
      "published_at": null,
      "score": 0.91
    }
  ],
  "raw_error": null
}
```

回传给模型时，建议压缩成可读 JSON / Markdown，例如：

```text
Web search results for: 2026 年黄金价格走势
Provider: tavily

1. title
   url
   snippet

2. ...
```

错误也返回给模型（tool result 里说明失败原因），让模型决定是否换 query 或直接回答。

## 6. When search runs

### 6.1 Injection timing

在第三方请求进入上游前：

1. resolve route / model
2. promote client tools（如 Codex `additional_tools`）
3. 若 client 已配置 enabled web_search 节点
4. 且当前不是 official GPT hosted path
5. 且 body.tools 中没有冲突的 web_search
6. 则注入 gateway `web_search` function tool

默认每次请求都注入（不是“每个会话只注入一次”）。

原因：

- HTTP 网关是无状态请求边界
- Desktop / CLI 每次 turn 都会重新带 tools
- 与 official 路径“缺了就补 web_search”一致

### 6.2 Execution timing

搜索只在模型真正 tool call 时执行：

```text
user message
  -> model may answer directly (no search)
  -> or model emits tool_call web_search
       -> gateway executes search provider
       -> append tool result
       -> model continues
```

不会：

- 对每条用户消息强制搜索
- 根据关键词启发式自动搜
- 在模型没要求时预取网页

### 6.3 Tool loop

一期：

- 单 turn 最多 `N` 次 gateway-owned tool 执行（默认 3）
- 支持并行 tool calls：若一次返回多个 `web_search`，可串行执行后一并回填
- 超过上限则停止循环，把已有结果/错误回给客户端或返回明确错误
- 只拦截 gateway-owned `web_search`
- 其他 tool calls（shell / read_file / 客户端自定义 tools）原样回传客户端，不由网关执行

## 7. Client coverage

一期覆盖所有已有客户端入口：

| Client / route | Request shape | Inject | Execute loop |
| --- | --- | --- | --- |
| Codex Desktop / CLI | `/codex/v1/responses` | yes | yes |
| OpenAI Responses clients | `/v1/responses` | yes | yes |
| OpenAI Chat clients | `/v1/chat/completions` | yes | yes |
| Claude Desktop / Claude Code | `/v1/messages` | yes | yes |
| Grok via gateway | 上述任一 | yes* | yes* |

\* 若 Grok 上游本身已有 backend search / 自带 web_search，需要避免双重注入。规则：

- 仅当当前 route 没有 native hosted search 时注入
- Grok 若已声明/支持 backend search，可配置跳过

official GPT:

- 仍走现有 hosted inject
- 不进入 gateway search executor

## 8. Provider architecture

### 8.1 Module layout

```text
lib/web-search/
  index.mjs                 # select node, inject tool, execute tool calls
  types.mjs                 # shared shapes / constants
  tool-def.mjs              # web_search function schema
  normalize.mjs             # provider result -> model-facing text/json
  providers/
    registry.mjs            # provider id -> adapter
    tavily.mjs              # Tavily adapter (phase 1)
    # brave.mjs             # future
    # perplexity.mjs        # future
```

server.js 只负责：

- 在请求路径调用 `maybeInjectGatewayWebSearch`
- 在上游返回后调用 `maybeExecuteGatewayWebSearchLoop`

### 8.2 Provider adapter interface

```js
/**
 * @typedef {Object} WebSearchRequest
 * @property {string} query
 * @property {number} [max_results]
 * @property {"day"|"week"|"month"|"year"} [time_range]
 * @property {object} options   // node.options
 * @property {string} apiKey
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} WebSearchAdapter
 * @property {string} id
 * @property {(req: WebSearchRequest) => Promise<NormalizedWebSearchResult>} search
 */
```

注册表：

```js
export const WEB_SEARCH_PROVIDERS = {
  tavily: tavilyAdapter,
  // brave: braveAdapter,
};
```

新增 provider 只需：

1. 实现 adapter
2. 注册到 registry
3. 增加节点 `provider` 校验白名单
4. 加 unit test + 可选 live smoke

### 8.3 Tavily protocol (phase 1)

官方文档：

- API 总览: https://docs.tavily.com/documentation/api-reference/introduction
- Search: https://docs.tavily.com/documentation/api-reference/endpoint/search
- Credits: https://docs.tavily.com/documentation/api-credits
- Docs index (llms.txt): https://docs.tavily.com/llms.txt

Base URL:

```text
https://api.tavily.com
```

Auth:

```text
Authorization: Bearer <TAVILY_API_KEY>
```

可选 header（后期可接，一期可不做）：

| Header | 用途 |
| --- | --- |
| `X-Project-ID` | 同一 API key 下按项目统计用量 |
| `X-Session-Id` | 把同一会话/任务的多次搜索串起来 |
| `X-Human-Id` | 匿名终端用户标识（Tavily 侧会再 hash） |

Endpoint:

```text
POST https://api.tavily.com/search
Authorization: Bearer <TAVILY_API_KEY>
Content-Type: application/json
```

Request mapping:

| Gateway field | Tavily field | Default |
| --- | --- | --- |
| `query` | `query` | required |
| `options.search_depth` | `search_depth` | `basic` |
| `max_results` / `options.max_results` | `max_results` | `5` |
| `options.topic` | `topic` | `general` |
| `time_range` / `options.time_range` | `time_range` | omit |
| `options.include_answer` | `include_answer` | `false` |
| `options.include_raw_content` | `include_raw_content` | `false` |
| `options.include_images` | `include_images` | `false` |
| `options.country` | `country` | optional (`china` for CN boost) |
| `options.include_domains` | `include_domains` | optional |
| `options.exclude_domains` | `exclude_domains` | optional |

Recommended phase-1 defaults for Chinese queries:

```json
{
  "search_depth": "basic",
  "max_results": 5,
  "topic": "general",
  "include_answer": false,
  "include_raw_content": false,
  "country": "china"
}
```

Cost notes (Tavily):

- free: 1000 credits / month
- basic/fast/ultra-fast search: 1 credit
- advanced search: 2 credits
- pay-as-you-go roughly $0.008 / credit
- monthly plans roughly $0.0075 ~ $0.005 / credit

Response mapping:

```text
tavily.results[].title   -> result.title
tavily.results[].url     -> result.url
tavily.results[].content -> result.snippet
tavily.results[].score   -> result.score
tavily.answer            -> answer (if requested)
```

不在一期默认开启：

- `include_raw_content`（贵、token 大）
- `include_images`
- Tavily Research / Crawl / Map

可选后续：

- `extract` 作为第二个 tool `web_fetch`（另开设计）

## 9. Request path details

### 9.1 Responses path (Codex primary)

```text
forwardResolvedCodexResponse
  promoteAdditionalTools
  maybeInjectGatewayWebSearch
  convert / fetch upstream
  if gateway-owned tool calls present:
    execute tools
    append function_call + function_call_output to input
    re-fetch upstream (loop)
  return final response / stream
```

Streaming 策略（一期建议）：

- **保守实现**：gateway tool loop 期间先不把中间 tool call 流给客户端；等最终答案再流/返回
- 原因：客户端若看到 tool call 却收不到匹配 result，容易状态错乱
- 日志中完整记录 tool call / latency / provider / result count

后续可升级为：

- 发出 `function_call` 事件
- 本地执行
- 再发最终 message

### 9.2 Chat Completions path

```text
inject tools[].function web_search
call upstream
if finish_reason=tool_calls and name=web_search:
  execute
  append assistant tool_calls + role=tool messages
  call again
```

### 9.3 Anthropic Messages path

```text
inject tools[] web_search (Anthropic tool schema)
call upstream
if stop_reason=tool_use and name=web_search:
  execute
  append assistant tool_use + user tool_result
  call again
```

### 9.4 Interaction with existing adapters

- `responsesRequestToChat` 不能接收 hosted `{type:"web_search"}`
- 所以 gateway 注入的是 **function tool**，不是 hosted tool
- 这样 Chat / Anthropic / Responses 都能统一承载

## 10. Eligibility rules

注入并执行 gateway search，当且仅当：

1. 当前 client 配置了至少一个 `purpose=web_search` 且 `enabled !== false` 的节点
2. 能选出 default / 唯一启用节点
3. 节点 provider 已注册，且 secrets 中有可用 API key
4. 当前请求不是 official Codex/OpenAI hosted model path
5. 请求 tools 中不存在冲突的 web_search/websearch
6. 环境变量未禁用：`GATEWAY_WEB_SEARCH_DISABLED=1` 可总开关关闭

可选 env：

```env
GATEWAY_WEB_SEARCH_DISABLED=0
GATEWAY_WEB_SEARCH_MAX_LOOPS=3
TAVILY_API_KEY=tvly-...
```

## 11. Logging & observability

每次搜索记录：

```json
{
  "event": "gateway_web_search",
  "request_id": "...",
  "client": "codex",
  "chat_model": "glm-5.2",
  "search_endpoint_id": "ep_search_tavily",
  "provider": "tavily",
  "query": "...",
  "max_results": 5,
  "result_count": 5,
  "latency_ms": 842,
  "ok": true,
  "error": null
}
```

不在普通 info 日志中打印完整 snippet（避免日志膨胀 / 敏感内容）；debug 可截断保存。

## 12. Testing plan

### 12.1 Unit

- tool schema 稳定
- inject 条件：有节点才注入 / 冲突不注入 / official 不注入
- select default web_search node
- Tavily request mapping
- Tavily response normalize
- tool loop stop conditions
- Anthropic / Chat / Responses tool-result 回填 shape

### 12.2 Integration

- mock Tavily + mock upstream chat model
- 场景：
  1. 模型直接回答，不搜
  2. 模型调用一次 web_search 后回答
  3. 搜索失败，模型仍能收到错误 tool result
  4. 未配置搜索节点时行为不变

### 12.3 Manual live smoke

```bash
# 配置 Tavily 节点与 key 后
curl .../v1/responses \
  -d '{"model":"glm-5.2","input":"今天上海天气怎么样？请搜索后回答","tools":[]}'
```

用同一 query 对比未来 Brave / Tavily 节点效果。

## 13. Implementation phases

### Phase 0 — design / branch (this doc)

- [x] branch + worktree
- [x] design doc

### Phase 1 — core plumbing

- [x] `lib/web-search/*` skeleton
- [x] config validation for `purpose=web_search`
- [x] secrets / provider registry
- [x] inject helper
- [x] Tavily adapter
- [x] Responses non-stream loop first（Codex 主路径 / openai-chat translated path）

### Phase 2 — multi-protocol

- [x] Chat Completions loop (non-stream + stream-final)
- [x] Anthropic Messages loop (non-stream + stream-final)
- [x] stream-safe final response behavior

### Phase 3 — productization

- [x] config panel：新增“联网搜索节点”
- [ ] doctor / validate 提示缺 key
- [ ] docs: README + providers recipe
- [ ] optional second provider (Brave) behind same interface

## 14. Open questions (resolved for now)

| Question | Decision |
| --- | --- |
| official GPT 要不要网关本地搜？ | 不要，继续 OpenAI hosted |
| 是否自动搜索？ | 否，仅模型 tool call |
| 多搜索节点？ | 允许，单个 default |
| 客户端覆盖？ | Codex / Claude / OpenAI / Grok-via-gateway 都做 |
| 一期几个搜索上游？ | 1 个：Tavily |
| 注入时机？ | 每次第三方请求前，若配置了搜索节点 |
| 执行时机？ | 模型调用 `web_search` 时 |
| 中文优化？ | Tavily `country=china` 可作为节点默认 option |

## 15. Acceptance criteria

1. 未配置 web_search 节点时，行为与现在完全一致
2. 配置 Tavily 节点后，`glm-5.2` 可通过 tool call 完成联网问答
3. official GPT 路径不被改坏
4. 新增 Brave 时无需改 tool schema，只需加 adapter + 节点
5. 单元测试覆盖 inject / normalize / loop 关键分支

## 16. Tavily quick reference

```http
POST /search
Host: api.tavily.com
Authorization: Bearer tvly-xxx
Content-Type: application/json

{
  "query": "2026 年 Vue 3 最新特性",
  "search_depth": "basic",
  "max_results": 5,
  "topic": "general",
  "country": "china",
  "include_answer": false,
  "include_raw_content": false
}
```

Successful response (shape):

```json
{
  "query": "...",
  "answer": null,
  "results": [
    {
      "title": "...",
      "url": "https://...",
      "content": "...",
      "score": 0.9
    }
  ],
  "response_time": 1.23
}
```


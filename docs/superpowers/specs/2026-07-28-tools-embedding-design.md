# Tools Tab: Text Embedding Design

> Status: design
> Branch: `codex/tools-embedding`
> Worktree: `.worktrees/codex-tools-embedding`
> Date: 2026-07-28

## 1. Goal

在配置面板新增一个「小工具」tab,与「预置技能」平级,作为容纳多个小工具的容器。
本期实现第一个工具:文本向量化。

用户可以在页面上:
- 选择已配置的向量模型(先选 client,再选该 client 下的 embedding 节点与模型)
- 自定义输入维度(默认读节点 dimensions,可选覆盖)
- 对单段文本生成向量并查看;对两段文本计算余弦相似度

## 2. Non-goals

本期明确不做:

- 不做批量向量化 / 导出 JSON(生产灌库场景)
- 不做向量存储 / 检索 / 向量库对接
- 不做除文本向量化之外的其他工具(容器结构预留,但只填第一个工具)
- 不改动现有 embedding 节点配置 UI(代理节点 tab 下的节点编辑器保持不变)
- 不改动跨 client 兜底等现有 `/v1/embeddings` 行为(仅在显式传 endpoint_id 时新增精确匹配分支)

## 3. Background: 现有 embedding 能力

Gateway 已有完整的 embedding 转发能力,无需从零搭建:

- **配置结构**:每个 client(`code`/`desktop`/`codex`)的 `endpoints[]` 里可有 `purpose:"embedding"` 节点,字段含 `id` / `name` / `base_url` / `embedding_model` / `models[]` / `model_mapping` / `dimensions` / `is_default` / `enabled`。
- **服务端路由**:`POST /v1/embeddings` -> `forwardOpenAIEmbeddings`(server.js ~465 行)。
  - 用 `selectDefaultEmbeddingEndpoint` 取该 client 的默认 embedding 节点
  - 找不到则跨 client 兜底(codex -> code -> desktop)
  - 复用 base_url 拼接(`/v1/embeddings` 路径补全)、model_mapping、dimensions 注入(请求体没带 dimensions 时才注入节点值)、api_key 解析、上游转发
- **前端已有** embedding 节点编辑器(代理节点 tab 下),带模型选择与维度输入。
- **client 路由**:`getRequestContext` 通过 URL 路径前缀(`/codex/v1/embeddings`)或请求头 `X-Gateway-Client` 指定 client。

## 4. 架构与数据流

```
选 client -> 读该 client 的 embedding 节点列表
  (来自 /v1/config 的 config.clients[client].endpoints,过滤 purpose==='embedding' && enabled!==false)
  -> 选节点(显示:节点名 · embedding_model · dimensions 维)
  -> 选模型(所选节点的 models[];空则用 embedding_model)
  -> 输入文本(单段 / 两段切换)
  -> [可选] 勾「自定义维度」覆盖 dimensions
  -> 调用 POST /v1/embeddings?endpoint_id=<id>
     头 X-Gateway-Client: <client>
     体: { model, input, ...(覆盖时) dimensions }
  -> 服务端按 endpoint_id 精确定位节点,复用现有转发逻辑
  -> 返回向量数组
  -> 前端展示向量 + 元信息
  -> 两段模式:前端算余弦相似度,主输出分数,向量作可展开详情
```

相似度计算纯前端,不加服务端逻辑。

## 5. 服务端改动(server.js)

只改 `forwardOpenAIEmbeddings`,加 endpoint_id 精确匹配分支。

### 5.1 逻辑

1. 从查询参数读 endpoint_id:`context.url.searchParams.get("endpoint_id")`。
2. **传了 endpoint_id**:
   - 在当前 client 的 endpoints 里用 `selectEmbeddingEndpoints` 过滤后,按 `ep.id === endpoint_id` 精确匹配。
   - 匹配到:用该节点,后续全部复用现有逻辑(base_url 拼接 / model_mapping / dimensions 注入 / api_key 解析 / 上游转发)。
   - 匹配不到:`404`,错误信息 `Embedding endpoint '<id>' not found for client '<client>'.`。
   - **不走跨 client 兜底**:用户显式选了就该尊重选择,不隐式回退。
3. **没传 endpoint_id**:完全保持现有逻辑(`selectDefaultEmbeddingEndpoint` + 跨 client 兜底)。零行为变化。

### 5.2 兼容性保证

- endpoint_id 是可选查询参数,不传时走原路径,现有所有调用方(Claude Code / Desktop / Codex / 会话同步等)零感知。
- dimensions 覆盖已天然支持:请求体带了 `dimensions` 就用请求体的,服务端只在请求体没带时才注入节点配置值。前端勾「自定义维度」后把值塞进请求体即可,服务端零改动。

### 5.3 不改 lib

`selectEmbeddingEndpoints` / `selectDefaultEmbeddingEndpoint`(lib/config/gateway-config-store.mjs)已有,直接复用,不改。

## 6. 前端 UI(desktop/config-panel.html)

### 6.1 导航

侧边栏「系统扩展」分组下新增 nav 项「小工具」,图标用工具类 svg,`switchTab('tools')` 切到 `section-tools`。

### 6.2 两层视图

**视图 A - 工具卡片列表(默认)**:
- 网格布局,每张卡片显示工具图标 + 名称 + 一句话描述。
- 目前一张:「文本向量化」卡片。点卡片进入工具详情。
- `switchTab('tools')` 时回到卡片列表(退出工具详情)。

**视图 B - 文本向量化工具详情**:
- 顶部返回按钮,回到卡片列表。
- 左右两栏布局:

**左:输入区**
- Client 选择(select:code / desktop / codex)
- 节点选择(select:该 client 的 embedding 节点;option 显示「节点名 · embedding_model · dimensions 维」;无节点时显示空状态提示「该 client 未配置向量节点,请到代理节点 tab 添加 purpose=embedding 的节点」)
- 模型选择(select:所选节点的 `models[]`;列表为空则用 `embedding_model` 作默认且 select 禁用)
- 维度:默认显示节点的 `dimensions`(只读);一个 checkbox「自定义维度」,勾上后变 number input(min=1),值带进请求体
- 模式切换(segmented control):「单段文本」/「两段文本(相似度)」
- 文本输入:单段模式一个 textarea;两段模式两个 textarea(A / B),各带标签
- 「向量化」按钮(btn-primary),请求中禁用并显示 spinner

**右:结果区**
- 单段模式:
  - 向量数组(可折叠,默认展开前 8 项 + 「...共 X 维」,点击展开全部;带复制按钮)
  - 元信息:模型、维度、token(prompt_tokens)、耗时
- 两段模式:
  - 相似度分数(大号突出,4 位小数)
  - 公式展示:「余弦相似度 = (A·B) / (‖A‖ × ‖B‖)」
  - 一行说明:「对两段文本分别向量化后计算两个向量的余弦值,范围 -1 到 1,越接近 1 越相似。」
  - 两个向量作可展开详情(同单段的折叠展示)
- 错误:红色提示框,显示上游返回的错误信息(message 字段)

### 6.3 请求细节

- URL:`POST /v1/embeddings?endpoint_id=<节点id>`
- 头:`X-Gateway-Client: <client>`、`Content-Type: application/json`
- 体:`{ model: <模型>, input: <文本或文本数组>, ...(自定义维度时) dimensions: <number> }`
- 两段模式:发两次请求(分别向量化 A 和 B),各自带相同 endpoint_id / client / model / dimensions,保证可比性。
- 用 `performance.now()` 测耗时(单段模式;两段模式分别展示 A、B 两次请求的耗时)。

### 6.4 状态管理

新增工具内部状态(不污染现有 config 状态):
- `toolsView`: `'cards' | 'embedding'` (当前视图)
- `embedState`: `{ client, endpointId, model, customDims: bool, dimensions, mode: 'single'|'similarity', textA, textB, result, loading, error }`

client / 节点 / 模型选择变化时,重置结果区。

## 7. 相似度算法(纯前端)

```
cosine = dot(A, B) / (norm(A) * norm(B))
dot    = Σ a_i * b_i
norm   = √(Σ a_i²)
```

- 结果四舍五入到 4 位小数。
- 若任一向量模长为 0,显示提示「向量模长为 0,无法计算相似度」,不展示分数。
- 算法与公式在结果区同步展示,让用户清楚分数来源。

## 8. 错误处理

- **无 embedding 节点**:select 为空,提示去代理节点 tab 配置。不发请求。
- **endpoint_id 不匹配**:服务端 404,前端错误框展示 message。
- **上游错误**(模型不支持 dimensions 参数等):透传上游状态码与错误体,前端错误框展示 message。
- **网络错误**:前端 catch,错误框展示「请求失败: <err.message>」。
- **零向量**:前端拦截,提示无法计算相似度。

## 9. 测试

### 9.1 服务端(扩展 tests/unit/embeddings-endpoint.test.mjs)

- 传 `endpoint_id` 且匹配:用指定节点转发,验证 base_url / model_mapping / dimensions 注入正确。
- 传 `endpoint_id` 不匹配:返回 404,错误信息含 endpoint_id。
- 传 `endpoint_id` 匹配但属于其他 client(用 X-Gateway-Client 指定不同 client):404,不跨 client 兜底。
- 不传 `endpoint_id`:保持现有默认 + 兜底行为(回归保护)。

### 9.2 前端(扩展 tests/unit/config-panel.test.mjs)

- 「小工具」nav 项存在,`switchTab('tools')` 显示 `section-tools`。
- 工具卡片列表渲染「文本向量化」卡片,点击进入详情视图。
- client 选择后,节点 select 填充该 client 的 embedding 节点。
- 无 embedding 节点时显示空状态提示。
- 维度 checkbox 切换:未勾显示只读节点 dimensions,勾上变 input。
- 模式切换:单段 / 两段 textarea 数量与标签正确。
- 两段模式结果区展示相似度分数 + 公式。

### 9.3 基线回归

- 现有 `embeddings-endpoint.test.mjs` 中「不传 endpoint_id」路径必须保持通过(回归保护)。
- `config-panel.test.mjs` 现有用例保持通过。

## 10. 涉及文件

- `server.js`:`forwardOpenAIEmbeddings` 加 endpoint_id 分支(约 10 行)
- `desktop/config-panel.html`:新增 nav 项 + section-tools + 工具卡片列表 + 文本向量化工具 UI + JS 逻辑
- `tests/unit/embeddings-endpoint.test.mjs`:新增 endpoint_id 相关用例
- `tests/unit/config-panel.test.mjs`:新增小工具 UI 用例

不改 lib,不改现有配置 UI。

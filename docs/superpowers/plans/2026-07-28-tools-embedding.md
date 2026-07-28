# Tools Tab: Text Embedding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在配置面板新增「小工具」tab,实现文本向量化工具(选 client/节点/模型,自定义维度,单段向量化 + 两段余弦相似度)。

**Architecture:** 服务端在 `forwardOpenAIEmbeddings` 加可选 `endpoint_id` 精确匹配分支(不传时保持原默认+兜底行为)。前端在单文件 `desktop/config-panel.html` 新增 nav 项 + section-tools + 工具卡片列表 + 文本向量化工具 UI。相似度计算纯前端。

**Tech Stack:** Node.js (ESM),原生 `node:test`,单文件 HTML(原生 JS + CSS 变量主题)。

## Global Constraints

- 工作目录:所有命令在 worktree `.worktrees/codex-tools-embedding` 内执行(即 `/Users/pa/project/AI/local-ai-gateway/.worktrees/codex-tools-embedding`)。
- 不改 lib(`lib/config/gateway-config-store.mjs` 的 `selectEmbeddingEndpoints` / `selectDefaultEmbeddingEndpoint` 直接复用)。
- 不改现有 embedding 节点配置 UI(代理节点 tab 下的节点编辑器)。
- endpoint_id 是可选查询参数;不传时走原路径,现有所有调用方零感知。
- CSS 复用现有变量体系:`--bg-color`/`--surface`/`--surface-hover`/`--border-color`/`--text-primary`/`--text-secondary`/`--brand-primary`/`--input-bg`/`--radius-md`/`--font-mono` 等,暗/亮双主题。
- 复用现有组件类:`.btn`/`.btn-primary`/`.form-group`/`.badge`/`.section-header`。
- 测试风格:`tests/unit/config-panel.test.mjs` 对 HTML 文件做正则匹配;`tests/unit/embeddings-endpoint.test.mjs` 起 mock 上游服务器测端到端转发。

---

## File Structure

- `server.js` (modify):`forwardOpenAIEmbeddings` 加 endpoint_id 分支(~455 行)。
- `desktop/config-panel.html` (modify):新增 nav 项、section-tools、工具卡片列表、文本向量化工具 UI 与 JS 逻辑。
- `tests/unit/embeddings-endpoint.test.mjs` (modify):新增 endpoint_id 用例。
- `tests/unit/config-panel.test.mjs` (modify):新增小工具 UI 用例。

---

### Task 1: 服务端 endpoint_id 精确匹配

**Files:**
- Modify: `server.js` (`forwardOpenAIEmbeddings`,约 455-490 行)
- Test: `tests/unit/embeddings-endpoint.test.mjs`

**Interfaces:**
- Consumes: `context.url.searchParams`、`selectEmbeddingEndpoints`(已存在于 lib/config/gateway-config-store.mjs)、`selectDefaultEmbeddingEndpoint`(已存在)
- Produces: `POST /v1/embeddings?endpoint_id=<id>` 在传 endpoint_id 时按精确匹配转发;不传时行为不变

**背景:** 现有 `forwardOpenAIEmbeddings` 在 server.js 约 455 行:

```js
async function forwardOpenAIEmbeddings(body, req, res, context) {
  const clientName = context.client !== "unknown" ? context.client : "codex";
  let clientObj = GATEWAY_CONFIG.clients?.[clientName];
  let endpoints = clientObj?.endpoints || [];
  let embeddingEndpoint = selectDefaultEmbeddingEndpoint(endpoints);

  if (!embeddingEndpoint) {
    for (const fallbackClient of ["codex", "code", "desktop"]) {
      if (fallbackClient === clientName) continue;
      const fbEndpoints = GATEWAY_CONFIG.clients?.[fallbackClient]?.endpoints || [];
      embeddingEndpoint = selectDefaultEmbeddingEndpoint(fbEndpoints);
      if (embeddingEndpoint) break;
    }
  }

  if (!embeddingEndpoint) {
    sendJson(res, 404, {
      error: {
        type: "invalid_request_error",
        message: "No embedding endpoint configured for client '" + clientName + "'.",
      },
    });
    return;
  }
  // ...后续 base_url / model_mapping / dimensions / 转发逻辑不变
```

`selectEmbeddingEndpoints` 在 lib/config/gateway-config-store.mjs 已存在,返回所有 `purpose==="embedding" && enabled!==false` 的节点。但 server.js 顶部目前只 import 了 `selectDefaultEmbeddingEndpoint`,需要补 import `selectEmbeddingEndpoints`。

- [ ] **Step 1: 写失败测试 - endpoint_id 匹配时用指定节点**

先看现有 `tests/unit/embeddings-endpoint.test.mjs` 的测试:它起一个 mock 上游 server,直接 `fetch` 到 mock 上游的 `/embeddings`,**并没有经过 gateway 路由层**。所以新测试要验证 endpoint_id 路由,必须像 `tests/integration/basic-routes.test.mjs` 那样 spawn 真实 gateway 进程。

机制(已核实):
- `GATEWAY_CONFIG_FILE` 环境变量指定 config 文件路径(server.js:108)。
- `GATEWAY_PORT` 环境变量指定监听端口(server.js:83)。
- `GATEWAY_SECRETS_FILE` 指定 secrets 文件。
- `spawn(process.execPath, ["server.js"], { cwd: ROOT, env: {...} })` 启动。

先在测试文件顶部补 import(现有文件只 import 了 `http`/`test`,需补 `spawn`/`once`/`mkdtemp`/`rm`/`writeFile`/`os`/`path`):

```js
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
```

然后追加新 test 到文件末尾(用空闲端口,避免与已运行的 8788 冲突):

```js
test("endpoint_id query param selects the matching embedding endpoint by id", async (t) => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gw-embed-id-"));

  // mock 上游:按请求的 model 区分返回不同向量,用以区分命中了哪个节点
  // (base_url 拼接会给路径加 /v1/embeddings,故不依赖 URL 路径区分)
  const upstream = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      const body = JSON.parse(data || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      // text-embedding-3-large (ep_TARGET) -> [0.4,0.5,0.6];其它 -> [0.1,0.2,0.3]
      const vec = body.model === "text-embedding-3-large" ? [0.4, 0.5, 0.6] : [0.1, 0.2, 0.3];
      res.end(JSON.stringify({
        object: "list",
        data: [{ object: "embedding", embedding: vec, index: 0 }],
        model: body.model,
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  // 选一个空闲端口给 gateway
  const probe = http.createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const gatewayPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const configPath = path.join(tempDir, "gateway.config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients: {
      codex: {
        endpoints: [
          {
            id: "ep_DEFAULT",
            name: "default-node",
            purpose: "embedding",
            type: "openai-chat",
            base_url: "http://127.0.0.1:" + upstreamPort + "/v1",
            enabled: true,
            is_default: true,
            models: ["text-embedding-3-small"],
            model_mapping: {},
            embedding_model: "text-embedding-3-small",
            dimensions: 256
          },
          {
            id: "ep_TARGET",
            name: "target-node",
            purpose: "embedding",
            type: "openai-chat",
            base_url: "http://127.0.0.1:" + upstreamPort + "/v1",
            enabled: true,
            is_default: false,
            models: ["text-embedding-3-large"],
            model_mapping: {},
            embedding_model: "text-embedding-3-large",
            dimensions: 1024
          }
        ]
      }
    }
  }));
  await writeFile(path.join(tempDir, "gateway.secrets.json"), JSON.stringify({ api_keys: {} }));

  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_SECRETS_FILE: path.join(tempDir, "gateway.secrets.json"),
      GATEWAY_NO_OPEN: "1",
      CLAUDE_3P_SYNC_DISABLED: "1",
      CLAUDE_CODE_SYNC_DISABLED: "1",
      CODEX_WRITE_MODEL_CATALOG_DISABLED: "1",
      LOG_FILE: path.join(tempDir, "gateway.log"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  t.after(async () => {
    gateway.kill();
    await once(gateway, "exit").catch(() => {});
    await new Promise((resolve) => upstream.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  // 等待 gateway 就绪
  await once(gateway, "spawn");
  await new Promise((resolve) => setTimeout(resolve, 800));

  const res = await fetch("http://127.0.0.1:" + gatewayPort + "/v1/embeddings?endpoint_id=ep_TARGET", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Client": "codex",
    },
    body: JSON.stringify({
      input: "hello",
      model: "text-embedding-3-large",
    }),
  });

  const json = await res.json();
  assert.equal(res.status, 200);
  // 命中 ep_TARGET -> model=text-embedding-3-large -> [0.4, 0.5, 0.6]
  assert.deepEqual(json.data[0].embedding, [0.4, 0.5, 0.6]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd .worktrees/codex-tools-embedding && node --test tests/unit/embeddings-endpoint.test.mjs`

Expected: 新 test 失败,因为 server.js 还没实现 endpoint_id 分支--请求会走默认节点 ep_DEFAULT(其 model 是 text-embedding-3-small),上游返回 `[0.1, 0.2, 0.3]`,断言期望 `[0.4, 0.5, 0.6]` 失败。原有 test 保持通过。

注意:若 gateway 启动需更久,Step 1 中的 `setTimeout(resolve, 800)` 可适当加大;也可改为轮询 `/health` 直到 200。

- [ ] **Step 3: 补 import selectEmbeddingEndpoints**

在 server.js 顶部 import 处(约 51 行 `selectDefaultEmbeddingEndpoint,` 所在那块),补上 `selectEmbeddingEndpoints`。

先确认当前 import:
Run: `rg -n "selectDefaultEmbeddingEndpoint|selectEmbeddingEndpoints" server.js | head`

修改 import 块,把 `selectEmbeddingEndpoints` 加进去(和 `selectDefaultEmbeddingEndpoint` 同来源)。

- [ ] **Step 4: 实现 endpoint_id 分支**

在 `forwardOpenAIEmbeddings` 里,把开头取 embeddingEndpoint 的逻辑改为:

```js
async function forwardOpenAIEmbeddings(body, req, res, context) {
  const clientName = context.client !== "unknown" ? context.client : "codex";
  let clientObj = GATEWAY_CONFIG.clients?.[clientName];
  let endpoints = clientObj?.endpoints || [];

  // endpoint_id 精确匹配:用户显式指定节点时,严格在该 client 内查找,不跨 client 兜底
  const requestedEndpointId = context.url.searchParams.get("endpoint_id");
  let embeddingEndpoint;
  if (requestedEndpointId) {
    embeddingEndpoint = selectEmbeddingEndpoints(endpoints).find(
      (ep) => ep.id === requestedEndpointId,
    ) || null;
    if (!embeddingEndpoint) {
      sendJson(res, 404, {
        error: {
          type: "invalid_request_error",
          message: "Embedding endpoint '" + requestedEndpointId + "' not found for client '" + clientName + "'.",
        },
      });
      return;
    }
  } else {
    embeddingEndpoint = selectDefaultEmbeddingEndpoint(endpoints);

    if (!embeddingEndpoint) {
      for (const fallbackClient of ["codex", "code", "desktop"]) {
        if (fallbackClient === clientName) continue;
        const fbEndpoints = GATEWAY_CONFIG.clients?.[fallbackClient]?.endpoints || [];
        embeddingEndpoint = selectDefaultEmbeddingEndpoint(fbEndpoints);
        if (embeddingEndpoint) break;
      }
    }

    if (!embeddingEndpoint) {
      sendJson(res, 404, {
        error: {
          type: "invalid_request_error",
          message: "No embedding endpoint configured for client '" + clientName + "'.",
        },
      });
      return;
    }
  }

  // 后续 base_url / model_mapping / dimensions / 转发逻辑保持不变
  const apiKey = getEndpointApiKey(
  // ... (原代码不动)
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd .worktrees/codex-tools-embedding && node --test tests/unit/embeddings-endpoint.test.mjs`

Expected: 全部 PASS(含新用例和原有回归用例)。

- [ ] **Step 6: 写失败测试 - endpoint_id 不匹配返回 404 且不跨 client 兜底**

追加到 `tests/unit/embeddings-endpoint.test.mjs`。复用 Step 1 的启动模式,但 config 里 codex 和 desktop 各有一个 embedding 节点(都叫 ep_A),请求 codex 带 `endpoint_id=ep_MISSING`,验证返回 404 且不兜底到 desktop:

```js
test("endpoint_id not matching returns 404 without cross-client fallback", async (t) => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gw-embed-404-"));

  const upstream = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [{ object: "embedding", embedding: [0.9, 0.9, 0.9], index: 0 }],
        model: "m",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  const probe = http.createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const gatewayPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const configPath = path.join(tempDir, "gateway.config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients: {
      codex: {
        endpoints: [{
          id: "ep_A", name: "codex-emb", purpose: "embedding", type: "openai-chat",
          base_url: "http://127.0.0.1:" + upstreamPort + "/codex",
          enabled: true, is_default: true, models: ["m"], model_mapping: {}, embedding_model: "m"
        }]
      },
      desktop: {
        endpoints: [{
          id: "ep_DESKTOP", name: "desktop-emb", purpose: "embedding", type: "openai-chat",
          base_url: "http://127.0.0.1:" + upstreamPort + "/desktop",
          enabled: true, is_default: true, models: ["m2"], model_mapping: {}, embedding_model: "m2"
        }]
      }
    }
  }));
  await writeFile(path.join(tempDir, "gateway.secrets.json"), JSON.stringify({ api_keys: {} }));

  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_SECRETS_FILE: path.join(tempDir, "gateway.secrets.json"),
      GATEWAY_NO_OPEN: "1",
      CLAUDE_3P_SYNC_DISABLED: "1",
      CLAUDE_CODE_SYNC_DISABLED: "1",
      CODEX_WRITE_MODEL_CATALOG_DISABLED: "1",
      LOG_FILE: path.join(tempDir, "gateway.log"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  t.after(async () => {
    gateway.kill();
    await once(gateway, "exit").catch(() => {});
    await new Promise((resolve) => upstream.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  await once(gateway, "spawn");
  await new Promise((resolve) => setTimeout(resolve, 800));

  const res = await fetch("http://127.0.0.1:" + gatewayPort + "/v1/embeddings?endpoint_id=ep_MISSING", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gateway-Client": "codex" },
    body: JSON.stringify({ input: "hello", model: "m" }),
  });

  const json = await res.json();
  assert.equal(res.status, 404);
  assert.match(json.error.message, /ep_MISSING/);
});
```

- [ ] **Step 7: 运行测试确认通过(应已直接通过,因为 Step 4 已实现 404)**

Run: `cd .worktrees/codex-tools-embedding && node --test tests/unit/embeddings-endpoint.test.mjs`

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
cd .worktrees/codex-tools-embedding
git add server.js tests/unit/embeddings-endpoint.test.mjs
git commit -m "feat(embeddings): support endpoint_id query param for explicit node selection"
```

---

### Task 2: 前端 nav 项与 section-tools 骨架

**Files:**
- Modify: `desktop/config-panel.html` (侧边栏 nav,约 1797 行附近;新增 section;switchTab 哈希白名单,约 3626 行)
- Test: `tests/unit/config-panel.test.mjs`

**Interfaces:**
- Consumes: `switchTab(tabId)` 机制(已存在)
- Produces: nav 项「小工具」+ `<section id="section-tools">` 空容器 + switchTab 支持 'tools'

- [ ] **Step 1: 写失败测试 - nav 项与 section 存在**

追加到 `tests/unit/config-panel.test.mjs`:

```js
test("tools tab nav item and section exist alongside skills", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /href="#tools"[\s\S]*onclick="switchTab\('tools'\)"/);
  assert.match(html, /<section id="section-tools" class="tab-section"/);
  assert.match(html, /小工具/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd .worktrees/codex-tools-embedding && node --test tests/unit/config-panel.test.mjs`

Expected: FAIL。

- [ ] **Step 3: 添加 nav 项**

在 `desktop/config-panel.html` 侧边栏「预置技能」`nav-collapsible` 块之后(约 1810 行 `</div>` 结束 nav-skills-group 之后),新增:

```html
                <a href="#tools" class="nav-item" onclick="switchTab('tools')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px;"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
                    小工具
                </a>
```

- [ ] **Step 4: 添加 section-tools 容器**

在 `</section>` 结束 `section-install-history` 之后,新增:

```html
            <!-- Tools Section -->
            <section id="section-tools" class="tab-section" style="display: none;">
                <div class="section-header">
                    <div>
                        <h2>小工具</h2>
                        <p>实验性小工具集合,提供文本向量化等便捷能力。</p>
                    </div>
                </div>
                <div id="tools-cards" class="tools-cards"></div>
                <div id="tools-detail"></div>
            </section>
```

- [ ] **Step 5: switchTab 哈希白名单加 tools**

在 `desktop/config-panel.html` 的 load 事件处理(约 3626 行),把 'tools' 加入哈希判断:

把:
```js
if (hash === 'code' || hash === 'desktop' || hash === 'codex' || hash === 'sync' || hash === 'skills' || hash === 'install-history') {
```
改为:
```js
if (hash === 'code' || hash === 'desktop' || hash === 'codex' || hash === 'sync' || hash === 'skills' || hash === 'install-history' || hash === 'tools') {
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd .worktrees/codex-tools-embedding && node --test tests/unit/config-panel.test.mjs`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
cd .worktrees/codex-tools-embedding
git add desktop/config-panel.html tests/unit/config-panel.test.mjs
git commit -m "feat(tools): add tools tab nav item and section skeleton"
```

---

### Task 3: 工具卡片列表视图

**Files:**
- Modify: `desktop/config-panel.html` (CSS + JS 渲染函数)
- Test: `tests/unit/config-panel.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `renderToolsCards()` 渲染卡片列表;`openTool('embedding')` 进入工具详情;`toolsView` 状态变量

- [ ] **Step 1: 写失败测试 - 卡片列表渲染文本向量化卡片**

追加到 `tests/unit/config-panel.test.mjs`:

```js
test("tools cards list renders text embedding card", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /window\.renderToolsCards\s*=\s*function/);
  assert.match(html, /文本向量化/);
  assert.match(html, /openTool\('embedding'\)/);
  assert.match(html, /tools-card/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd .worktrees/codex-tools-embedding && node --test tests/unit/config-panel.test.mjs`

Expected: FAIL。

- [ ] **Step 3: 添加工具卡片 CSS**

在 `desktop/config-panel.html` 的 `<style>` 内(找 `.skills-empty` 附近样式块后),新增:

```css
        .tools-cards {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
            gap: 16px;
        }
        .tools-card {
            background: var(--surface);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-lg);
            padding: 20px;
            cursor: pointer;
            transition: var(--transition-fast);
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .tools-card:hover {
            background: var(--surface-hover);
            border-color: var(--text-secondary);
        }
        .tools-card-icon {
            width: 36px;
            height: 36px;
            border-radius: var(--radius-md);
            background: var(--input-bg);
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--text-primary);
        }
        .tools-card-name {
            font-weight: 600;
            font-size: 15px;
            color: var(--text-primary);
        }
        .tools-card-desc {
            font-size: 13px;
            color: var(--text-secondary);
            line-height: 1.5;
        }
        .tools-detail-back {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: none;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 13px;
            padding: 4px 0;
            margin-bottom: 16px;
        }
        .tools-detail-back:hover { color: var(--text-primary); }
        .embed-layout {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            gap: 20px;
        }
        @media (max-width: 900px) {
            .embed-layout { grid-template-columns: 1fr; }
        }
        .embed-panel {
            background: var(--surface);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-lg);
            padding: 16px;
        }
        .embed-panel h3 {
            margin: 0 0 12px;
            font-size: 14px;
            color: var(--text-primary);
        }
        .embed-form-group { margin-bottom: 12px; }
        .embed-form-group label {
            display: block;
            font-size: 12px;
            color: var(--text-secondary);
            margin-bottom: 4px;
        }
        .embed-form-select {
            width: 100%;
            box-sizing: border-box;
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            color: var(--text-primary);
            font-size: 13px;
            padding: 6px 8px;
        }
        .embed-textarea {
            width: 100%;
            min-height: 80px;
            resize: vertical;
            box-sizing: border-box;
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            color: var(--text-primary);
            font-family: var(--font-sans);
            font-size: 13px;
            padding: 8px;
        }
        .embed-textarea:focus {
            outline: none;
            border-color: var(--text-secondary);
        }
        .embed-mode-switch {
            display: inline-flex;
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            overflow: hidden;
            margin-bottom: 12px;
        }
        .embed-mode-btn {
            background: none;
            border: none;
            padding: 6px 14px;
            font-size: 13px;
            color: var(--text-secondary);
            cursor: pointer;
        }
        .embed-mode-btn.active {
            background: var(--brand-primary);
            color: var(--brand-text);
        }
        .embed-dims-row {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            color: var(--text-secondary);
        }
        .embed-dims-row input[type="number"] {
            width: 80px;
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            color: var(--text-primary);
            padding: 4px 6px;
            font-size: 13px;
        }
        .embed-result-empty {
            color: var(--text-secondary);
            font-size: 13px;
            text-align: center;
            padding: 32px 0;
        }
        .embed-similarity-score {
            font-size: 32px;
            font-weight: 700;
            color: var(--text-primary);
            font-family: var(--font-mono);
        }
        .embed-formula {
            font-family: var(--font-mono);
            font-size: 13px;
            color: var(--text-secondary);
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            padding: 8px 10px;
            margin: 8px 0;
        }
        .embed-formula-note {
            font-size: 12px;
            color: var(--text-secondary);
            line-height: 1.5;
        }
        .embed-vector-toggle {
            background: none;
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 12px;
            padding: 4px 10px;
        }
        .embed-vector-toggle:hover { color: var(--text-primary); }
        .embed-vector {
            font-family: var(--font-mono);
            font-size: 12px;
            color: var(--text-secondary);
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            padding: 8px;
            word-break: break-all;
            max-height: 200px;
            overflow-y: auto;
        }
        .embed-meta {
            font-size: 12px;
            color: var(--text-secondary);
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
        }
        .embed-error {
            color: var(--danger);
            background: var(--danger-bg);
            border: 1px solid var(--danger);
            border-radius: var(--radius-md);
            padding: 10px;
            font-size: 13px;
        }
```

- [ ] **Step 4: 添加 toolsView 状态与渲染函数**

在 `desktop/config-panel.html` 的 `<script>` 内,找现有状态变量声明区(约 2152 行 `let activeClient = 'code';` 附近),新增:

```js
        let toolsView = 'cards'; // 'cards' | 'embedding'
```

在合适位置(例如 `window.switchTab` 定义之后)新增渲染与切换函数:

```js
        window.renderToolsCards = function() {
            const cards = document.getElementById('tools-cards');
            const detail = document.getElementById('tools-detail');
            if (!cards || !detail) return;
            detail.innerHTML = '';
            cards.style.display = '';
            cards.innerHTML = `
                <div class="tools-card" onclick="openTool('embedding')">
                    <div class="tools-card-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>
                    </div>
                    <div class="tools-card-name">文本向量化</div>
                    <div class="tools-card-desc">选择已配置的向量模型,对文本生成向量或计算两段文本的余弦相似度。</div>
                </div>
            `;
        };

        window.openTool = function(toolId) {
            toolsView = toolId;
            renderToolsDetail();
        };

        window.backToToolsCards = function() {
            toolsView = 'cards';
            const cards = document.getElementById('tools-cards');
            const detail = document.getElementById('tools-detail');
            if (cards) cards.style.display = '';
            if (detail) detail.innerHTML = '';
            renderToolsCards();
        };
```

- [ ] **Step 5: switchTab 进入 tools 时渲染卡片**

修改 `window.switchTab`(约 3579 行),在现有 `if (tabId === 'skills')` 等分支后,加:

```js
            if (tabId === 'tools') {
                toolsView = 'cards';
                renderToolsCards();
            }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd .worktrees/codex-tools-embedding && node --test tests/unit/config-panel.test.mjs`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
cd .worktrees/codex-tools-embedding
git add desktop/config-panel.html tests/unit/config-panel.test.mjs
git commit -m "feat(tools): render tool cards list with text embedding entry"
```

---

### Task 4: 文本向量化工具详情 UI 与 JS 逻辑

**Files:**
- Modify: `desktop/config-panel.html` (renderToolsDetail 函数 + 请求逻辑 + 相似度算法)
- Test: `tests/unit/config-panel.test.mjs`

**Interfaces:**
- Consumes: `config.clients[client].endpoints`(`purpose==="embedding"` 节点)、`switchTab` 暴露的 `config` 全局变量
- Produces: `renderToolsDetail()`、`runEmbedding()`、`cosineSimilarity(a, b)`;调用 `POST /v1/embeddings?endpoint_id=<id>` 带 `X-Gateway-Client` 头

**背景 - embedding 节点数据结构:**
```js
// config.clients.codex.endpoints[i] 里 purpose==='embedding' 的节点:
{
  id: "ep_xxx",
  name: "向量模型节点",
  purpose: "embedding",
  base_url: "...",
  enabled: true,
  is_default: true,
  models: ["text-embedding-3-large"],
  model_mapping: {},
  embedding_model: "text-embedding-3-large",
  dimensions: 1024
}
```

- [ ] **Step 1: 写失败测试 - 工具详情渲染结构与相似度算法**

追加到 `tests/unit/config-panel.test.mjs`:

```js
test("text embedding tool detail renders form, mode switch, and similarity formula", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /function renderToolsDetail/);
  assert.match(html, /embed-client-select/);
  assert.match(html, /embed-node-select/);
  assert.match(html, /embed-model-select/);
  assert.match(html, /embed-custom-dims/);
  assert.match(html, /embed-mode-single/);
  assert.match(html, /embed-mode-similarity/);
  assert.match(html, /余弦相似度 = \(A·B\) \/ \(‖A‖ × ‖B‖\)/);
  assert.match(html, /范围 -1 到 1/);
});

test("cosine similarity and embedding request helpers exist", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /function cosineSimilarity\(a, b\)/);
  assert.match(html, /window\.runEmbedding\s*=\s*async function/);
  assert.match(html, /endpoint_id=/);
  assert.match(html, /X-Gateway-Client/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd .worktrees/codex-tools-embedding && node --test tests/unit/config-panel.test.mjs`

Expected: FAIL。

- [ ] **Step 3: 添加 embedState 状态变量**

在 `let toolsView = 'cards';` 之后新增:

```js
        const embedState = {
            client: 'codex',
            endpointId: '',
            model: '',
            customDims: false,
            dimensions: '',
            mode: 'single', // 'single' | 'similarity'
            textA: '',
            textB: '',
            result: null,
            loading: false,
            error: ''
        };
```

- [ ] **Step 4: 实现 renderToolsDetail**

新增函数:

```js
        function getEmbeddingEndpoints(client) {
            const eps = (config.clients[client]?.endpoints || []).filter(
                ep => ep.purpose === 'embedding' && ep.enabled !== false
            );
            return eps;
        }

        window.renderToolsDetail = function() {
            const cards = document.getElementById('tools-cards');
            const detail = document.getElementById('tools-detail');
            if (!cards || !detail) return;
            cards.style.display = 'none';

            const eps = getEmbeddingEndpoints(embedState.client);
            const nodeOptions = eps.map(ep => {
                const dim = ep.dimensions != null ? `${ep.dimensions}维` : '默认';
                const model = ep.embedding_model || (ep.models[0] || '未设置');
                const sel = ep.id === embedState.endpointId ? 'selected' : '';
                return `<option value="${escapeHtml(ep.id)}" ${sel}>${escapeHtml(ep.name)} · ${escapeHtml(model)} · ${dim}</option>`;
            }).join('');

            const selectedNode = eps.find(ep => ep.id === embedState.endpointId) || eps[0] || null;
            if (selectedNode && !embedState.endpointId) embedState.endpointId = selectedNode.id;
            const models = selectedNode?.models || [];
            const modelOptions = models.map(m => `<option value="${escapeHtml(m)}" ${m === embedState.model ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
            const nodeDims = selectedNode?.dimensions != null ? String(selectedNode.dimensions) : '默认';

            const noNodeHint = eps.length === 0
                ? `<div class="embed-error" style="margin-bottom:12px;">该 client 未配置向量节点,请到代理节点 tab 添加 purpose=embedding 的节点。</div>`
                : '';

            detail.innerHTML = `
                <button class="tools-detail-back" onclick="backToToolsCards()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    返回工具列表
                </button>
                <div class="embed-layout">
                    <div class="embed-panel">
                        <h3>输入</h3>
                        ${noNodeHint}
                        <div class="embed-form-group">
                            <label>Client</label>
                            <select id="embed-client-select" class="embed-form-select" onchange="onEmbedClientChange(this.value)">
                                <option value="codex" ${embedState.client==='codex'?'selected':''}>codex</option>
                                <option value="code" ${embedState.client==='code'?'selected':''}>code</option>
                                <option value="desktop" ${embedState.client==='desktop'?'selected':''}>desktop</option>
                            </select>
                        </div>
                        <div class="embed-form-group">
                            <label>向量节点</label>
                            <select id="embed-node-select" onchange="onEmbedNodeChange(this.value)" ${eps.length===0?'disabled':''}>
                                ${nodeOptions || '<option value="">无可用节点</option>'}
                            </select>
                        </div>
                        <div class="embed-form-group">
                            <label>模型</label>
                            <select id="embed-model-select" onchange="embedState.model=this.value; renderToolsDetail();" ${models.length===0?'disabled':''}>
                                ${modelOptions || `<option value="${escapeHtml(selectedNode?.embedding_model||'')}">${escapeHtml(selectedNode?.embedding_model||'无')}</option>`}
                            </select>
                        </div>
                        <div class="embed-form-group">
                            <label>维度</label>
                            <div class="embed-dims-row">
                                <span>节点维度: <strong>${escapeHtml(nodeDims)}</strong></span>
                                <label style="margin:0;"><input type="checkbox" id="embed-custom-dims" ${embedState.customDims?'checked':''} onchange="onEmbedCustomDimsToggle(this.checked)" /> 自定义</label>
                                ${embedState.customDims ? `<input type="number" id="embed-dims-input" min="1" placeholder="如 1024" value="${escapeHtml(String(embedState.dimensions))}" onchange="embedState.dimensions=this.value; renderToolsDetail();" />` : ''}
                            </div>
                        </div>
                        <div class="embed-mode-switch">
                            <button class="embed-mode-btn ${embedState.mode==='single'?'active':''}" id="embed-mode-single" onclick="setEmbedMode('single')">单段文本</button>
                            <button class="embed-mode-btn ${embedState.mode==='similarity'?'active':''}" id="embed-mode-similarity" onclick="setEmbedMode('similarity')">两段文本(相似度)</button>
                        </div>
                        <div class="embed-form-group">
                            <label>文本 A</label>
                            <textarea id="embed-text-a" class="embed-textarea" placeholder="输入要向量化的文本" oninput="embedState.textA=this.value">${escapeHtml(embedState.textA)}</textarea>
                        </div>
                        ${embedState.mode === 'similarity' ? `
                        <div class="embed-form-group">
                            <label>文本 B</label>
                            <textarea id="embed-text-b" class="embed-textarea" placeholder="输入第二段文本" oninput="embedState.textB=this.value">${escapeHtml(embedState.textB)}</textarea>
                        </div>` : ''}
                        <button class="btn btn-primary" id="embed-run-btn" onclick="runEmbedding()" ${embedState.loading?'disabled':''}>
                            ${embedState.loading ? '计算中...' : '向量化'}
                        </button>
                    </div>
                    <div class="embed-panel" id="embed-result-panel">
                        ${renderEmbedResult()}
                    </div>
                </div>
            `;
        };
```


- [ ] **Step 5: 实现交互函数**

新增:

```js
        window.onEmbedClientChange = function(client) {
            embedState.client = client;
            embedState.endpointId = '';
            embedState.model = '';
            embedState.result = null;
            embedState.error = '';
            renderToolsDetail();
        };

        window.onEmbedNodeChange = function(endpointId) {
            embedState.endpointId = endpointId;
            const ep = getEmbeddingEndpoints(embedState.client).find(e => e.id === endpointId);
            embedState.model = ep?.models?.[0] || ep?.embedding_model || '';
            embedState.result = null;
            embedState.error = '';
            renderToolsDetail();
        };

        window.onEmbedCustomDimsToggle = function(checked) {
            embedState.customDims = checked;
            if (!checked) embedState.dimensions = '';
            embedState.result = null;
            renderToolsDetail();
        };

        window.setEmbedMode = function(mode) {
            embedState.mode = mode;
            embedState.result = null;
            embedState.error = '';
            renderToolsDetail();
        };
```

- [ ] **Step 6: 实现 cosineSimilarity 与 runEmbedding**

新增:

```js
        function cosineSimilarity(a, b) {
            let dot = 0, normA = 0, normB = 0;
            for (let i = 0; i < a.length; i++) {
                dot += a[i] * b[i];
                normA += a[i] * a[i];
                normB += b[i] * b[i];
            }
            const denom = Math.sqrt(normA) * Math.sqrt(normB);
            if (denom === 0) return null; // 零向量无法计算
            return dot / denom;
        }

        async function callEmbedding(text) {
            const params = new URLSearchParams();
            if (embedState.endpointId) params.set('endpoint_id', embedState.endpointId);
            const body = { input: text };
            if (embedState.model) body.model = embedState.model;
            if (embedState.customDims && embedState.dimensions) {
                body.dimensions = Number(embedState.dimensions);
            }
            const res = await fetch(`/v1/embeddings?${params.toString()}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Gateway-Client': embedState.client,
                },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!res.ok) {
                throw new Error(json?.error?.message || `请求失败 (${res.status})`);
            }
            const vec = json?.data?.[0]?.embedding;
            if (!Array.isArray(vec)) throw new Error('返回数据格式异常,未找到向量');
            return {
                vector: vec,
                model: json.model || embedState.model,
                dimensions: vec.length,
                tokens: json?.usage?.prompt_tokens ?? null,
            };
        }

        window.runEmbedding = async function() {
            if (!embedState.textA.trim()) {
                embedState.error = '请输入文本 A';
                renderToolsDetail();
                return;
            }
            if (embedState.mode === 'similarity' && !embedState.textB.trim()) {
                embedState.error = '请输入文本 B';
                renderToolsDetail();
                return;
            }
            embedState.loading = true;
            embedState.error = '';
            embedState.result = null;
            renderToolsDetail();
            try {
                const t0 = performance.now();
                const a = await callEmbedding(embedState.textA);
                const t1 = performance.now();
                if (embedState.mode === 'single') {
                    embedState.result = { mode: 'single', a, elapsedMs: t1 - t0 };
                } else {
                    const b = await callEmbedding(embedState.textB);
                    const t2 = performance.now();
                    const sim = cosineSimilarity(a.vector, b.vector);
                    embedState.result = { mode: 'similarity', a, b, similarity: sim, elapsedMsA: t1 - t0, elapsedMsB: t2 - t1 };
                }
            } catch (err) {
                embedState.error = err.message || String(err);
            } finally {
                embedState.loading = false;
                renderToolsDetail();
            }
        };
```

- [ ] **Step 7: 实现 renderEmbedResult**

新增:

```js
        function renderEmbedResult() {
            if (embedState.loading) return '<div class="embed-result-empty">计算中...</div>';
            if (embedState.error) return `<div class="embed-error">${escapeHtml(embedState.error)}</div>`;
            if (!embedState.result) return '<div class="embed-result-empty">输入文本后点击「向量化」查看结果。</div>';

            const r = embedState.result;
            const vectorHtml = (label, info) => {
                const preview = info.vector.slice(0, 8).map(v => v.toFixed(6)).join(', ');
                const more = info.vector.length > 8 ? `, ...共 ${info.vector.length} 维` : '';
                return `
                    <div style="margin-top:8px;">
                        <button class="embed-vector-toggle" onclick="toggleEmbedVector('${label}')">${label} 向量 ▾</button>
                        <div class="embed-vector" id="embed-vec-${label}" style="display:none;">[${preview}${more}]</div>
                        <div class="embed-meta" style="margin-top:4px;">
                            <span>模型: ${escapeHtml(info.model)}</span>
                            <span>维度: ${info.dimensions}</span>
                            ${info.tokens != null ? `<span>tokens: ${info.tokens}</span>` : ''}
                            <span>耗时: ${(r.mode==='single'?r.elapsedMs:r[label==='A'? 'elapsedMsA':'elapsedMsB']).toFixed(0)}ms</span>
                        </div>
                    </div>`;
            };

            if (r.mode === 'single') {
                return `
                    <h3>结果</h3>
                    ${vectorHtml('A', r.a)}
                `;
            }
            const score = r.similarity === null ? '无法计算(向量模长为 0)' : r.similarity.toFixed(4);
            return `
                <h3>相似度</h3>
                <div class="embed-similarity-score">${escapeHtml(String(score))}</div>
                <div class="embed-formula">余弦相似度 = (A·B) / (‖A‖ × ‖B‖)</div>
                <div class="embed-formula-note">对两段文本分别向量化后计算两个向量的余弦值,范围 -1 到 1,越接近 1 越相似。</div>
                ${vectorHtml('A', r.a)}
                ${vectorHtml('B', r.b)}
            `;
        }

        window.toggleEmbedVector = function(label) {
            const el = document.getElementById(`embed-vec-${label}`);
            if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
        };
```

- [ ] **Step 8: 运行测试确认通过**

Run: `cd .worktrees/codex-tools-embedding && node --test tests/unit/config-panel.test.mjs`

Expected: PASS。

- [ ] **Step 9: 提交**

```bash
cd .worktrees/codex-tools-embedding
git add desktop/config-panel.html tests/unit/config-panel.test.mjs
git commit -m "feat(tools): implement text embedding tool with similarity"
```

---

### Task 5: 全量回归验证

**Files:** 无修改

- [ ] **Step 1: 运行全部相关测试**

Run: `cd .worktrees/codex-tools-embedding && node --test tests/unit/embeddings-endpoint.test.mjs tests/unit/config-panel.test.mjs tests/integration/basic-routes.test.mjs`

Expected: 全部 PASS。

- [ ] **Step 2: 语法检查**

Run: `cd .worktrees/codex-tools-embedding && npm run check`

Expected: 通过(`node --check server.js` 等)。

- [ ] **Step 3: 启动 gateway 手动验证**

从主工作目录拷贝真实的节点配置与密钥到 worktree(主 gateway 跑在 8787,这里用空闲的 8788 避免冲突):

```bash
cd .worktrees/codex-tools-embedding
cp ../../gateway.config.json ./gateway.config.json
cp ../../gateway.secrets.json ./gateway.secrets.json
```

用 8788 端口启动(指向刚拷贝的 config):

```bash
GATEWAY_PORT=8788 GATEWAY_CONFIG_FILE=./gateway.config.json GATEWAY_SECRETS_FILE=./gateway.secrets.json GATEWAY_NO_OPEN=1 node server.js
```

浏览器打开 `http://127.0.0.1:8788`:
1. 切到「小工具」tab,看到「文本向量化」卡片,点进去。
2. 选 codex client,选真实向量节点(如「向量模型节点」),选模型。
3. 单段模式:输入文本点向量化,确认返回向量(可展开)+ 元信息(模型/维度/token/耗时)。
4. 切两段模式:输入 A/B 文本,确认相似度分数 + 公式展示 `余弦相似度 = (A·B) / (‖A‖ × ‖B‖)` + 说明文字。
5. 勾「自定义维度」,填一个值(如 512),确认请求带该维度;若上游不支持会显示错误(正常)。
6. 选一个没配向量节点的 client,确认显示空状态提示。

验证完成后关闭 gateway(Ctrl+C)。注意:`gateway.config.json` 和 `gateway.secrets.json` 已被 `.gitignore` 忽略,不会误提交。

- [ ] **Step 4: 最终提交(若有手动验证中的小修)**

如无修改则跳过;有则:
```bash
cd .worktrees/codex-tools-embedding
git add -A
git commit -m "fix(tools): polish from manual verification"
```

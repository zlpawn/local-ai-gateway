/**
 * Config panel regression tests.
 *
 * These cover the live UI sources: desktop/src/app.ts (JS, esbuild-bundled),
 * desktop/index.html (HTML shell), and desktop/src/styles/panel.css (styles).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(".");

// The panel is split across three live sources after the Electron shell removal:
// app.ts (JS, bundled by esbuild), index.html (HTML shell), panel.css (styles).
// Tests read them together so assertions can match content wherever it lives.
let _sourcesCache = null;
async function readSources() {
  if (_sourcesCache) return _sourcesCache;
  const [app, idx, css] = await Promise.all([
    readFile(path.join(ROOT, "desktop", "src", "app.ts"), "utf8"),
    readFile(path.join(ROOT, "desktop", "index.html"), "utf8"),
    readFile(path.join(ROOT, "desktop", "src", "styles", "panel.css"), "utf8"),
  ]);
  _sourcesCache = app + "\n" + idx + "\n" + css;
  return _sourcesCache;
}

test("config panel exposes Codex tools, reasoning, and image capabilities", async () => {
  const html = await readSources();
  assert.match(html, /Codex 能力/);
  assert.match(html, /capabilities-input-image/);
  assert.match(html, /capabilities-reasoning/);
  assert.match(html, /capabilities-tools/);
  assert.match(html, /wire_api = "responses"/);
});

test("Codex capability controls and active navigation use compact product styling", async () => {
  const html = await readSources();
  assert.match(html, /\.nav-item\.active\s*\{[^}]*box-shadow:\s*inset 2px 0 0/s);
  assert.match(html, /\.capability-options\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(html, /\.capability-option\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center/s);
  assert.match(html, /\.capability-checkbox\s*\{[^}]*width:\s*16px[^}]*height:\s*16px[^}]*padding:\s*0/s);
  assert.match(html, /class="capability-option"/);
  assert.match(html, /class="capability-checkbox"/);
  assert.doesNotMatch(html, /class="checkbox-row"/);
});

test("config panel supports stable endpoint ids, secret status, exposure, and conflict suggestions", async () => {
  const html = await readSources();
  assert.match(html, /crypto\.randomUUID\(\)/);
  assert.match(html, /readonly[^>]*endpoint-id|endpoint-id[^>]*readonly/);
  assert.match(html, /has_api_key/);
  assert.match(html, /expose_models/);
  assert.match(html, /duplicate_public_model/);
  assert.match(html, /invalid_claude_model_name/);
  assert.match(html, /suggestion/);
  assert.match(html, /delete endpoint\.api_key/);
  assert.match(html, /createTemplateEndpoint/);
  assert.doesNotMatch(html, /codex:\s*\{\s*endpoints:\s*\[JSON\.parse/);
});

test("Codex endpoint editor offers Anthropic Messages protocol and auth selection", async () => {
  const html = await readSources();
  assert.match(html, /Anthropic Messages 协议/);
  assert.match(
    html,
    /\['anthropic',\s*'openai-responses',\s*'openai-chat',\s*'grok',\s*'antigravity'\]/,
  );
  assert.match(html, /<label>鉴权方式<\/label>/);
  assert.match(html, /value="bearer"/);
  assert.match(html, /value="x-api-key"/);
});

test("endpoint detail provides an explicit manual save action", async () => {
  const html = await readSources();
  assert.match(html, /id="save-node-\$\{client\}-\$\{index\}"/);
  assert.match(html, /onclick="saveNode\('\$\{client\}', \$\{index\}\)"/);
  assert.match(html, /window\.saveNode\s*=\s*async function/);
  assert.match(html, /saveConfig\(\{\s*button:\s*btn,\s*client,\s*scope:\s*'node'/);
});

test("each client can add capability nodes from the grouped node menu", async () => {
  const html = await readSources();
  assert.match(html, /data-client="code"/);
  assert.match(html, /data-client="desktop"/);
  assert.match(html, /data-client="codex"/);
  assert.match(html, /title:\s*'聊天模型'/);
  assert.match(html, /title:\s*'视觉兜底'/);
  assert.match(html, /title:\s*'联网搜索'/);
  assert.match(html, /title:\s*'向量模型'/);
  assert.match(html, /onclick="addNodeByPurpose\('\$\{client\}', '\$\{option\.purpose\}'\)"/);
  assert.match(html, /purpose:\s*'vision_fallback'/);
  assert.match(html, /addWebSearchEndpoint/);
  assert.match(html, /purpose:\s*'web_search'/);
  assert.match(html, /purpose:\s*'embedding'/);
  assert.match(html, /type:\s*'openai-chat'/);
  assert.match(html, /OpenAI Embeddings 协议/);
  assert.match(html, /setAsDefaultEmbedding/);
  assert.match(html, /setAsDefaultWebSearch/);
  assert.match(html, /vision_fallback_enabled:\s*true/);
  assert.match(html, /视觉兜底模型/);
  assert.match(html, /vision_model/);
});

test("endpoint list renders chat and capability nodes in separate groups", async () => {
  const html = await readSources();
  assert.match(html, /function createEndpointGroupsHTML/);
  assert.match(html, /title:\s*'聊天模型'/);
  assert.match(html, /title:\s*'视觉兜底'/);
  assert.match(html, /title:\s*'联网搜索'/);
  assert.match(html, /title:\s*'向量模型'/);
  assert.match(html, /class="node-group-header"/);
  assert.match(html, /class="node-group-count"/);
});

test("new embedding node starts without preset models or task-level options", async () => {
  const html = await readSources();
  const addEmbeddingSource = html.match(
    /window\.addEmbeddingEndpoint = function\(client\) \{[\s\S]*?\n\}/,
  )?.[0] || "";

  assert.match(html, /输出维度（可选，留空使用模型默认值）/);
  assert.match(html, /updateEndpoint\('\$\{client\}', \$\{index\}, 'dimensions'/);
  assert.doesNotMatch(html, /批处理大小|batch_size/);
  assert.doesNotMatch(addEmbeddingSource, /dimensions/);
  assert.match(addEmbeddingSource, /models:\s*\[\]/);
  assert.match(addEmbeddingSource, /embedding_model:\s*""/);
  assert.match(addEmbeddingSource, /base_url:\s*""/);
  assert.doesNotMatch(addEmbeddingSource, /text-embedding-3-small|BAAI\/bge-m3/);
  assert.match(html, /请先填写向量模型节点的 Base URL/);
});

test("section header actions stay compact and wrap cleanly on narrow screens", async () => {
  const html = await readSources();
  assert.match(html, /\.section-header-actions\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(html, /\.section-header-actions \.btn\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(html, /\.add-node-popover\s*\{[^}]*width:\s*292px/s);
  assert.match(html, /\.add-node-option\s*\{[^}]*grid-template-columns:\s*34px minmax\(0,\s*1fr\)/s);
  assert.match(html, /function createAddNodeOptionsHTML/);
  assert.match(html, /window\.toggleAddNodeMenu/);
  assert.doesNotMatch(html, /<select class="add-node-menu"/);
  assert.match(html, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.section-header\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(html, />\s*迁移历史会话\s*</);
});

test("each upstream model exposes vision capability and context window dropdowns", async () => {
  const html = await readSources();
  assert.match(html, /updateModelImageCapability/);
  assert.match(html, /支持视觉/);
  assert.match(html, /不支持视觉/);
  assert.match(html, /toggleCtxVisionMenu/);
  assert.match(html, /vision-dropdown/);
  assert.match(html, /toggleCtxWindowMenu/);
  assert.match(html, /ctx-window-dropdown/);
  assert.match(html, /model_capabilities/);
  assert.match(html, /delete endpoint\.model_capabilities\[model\]/);
});

test("global and card save actions preserve the active client context", async () => {
  const html = await readSources();
  assert.match(html, /id="save-btn"/);
  assert.match(html, /onclick="saveCurrentConfig\(\)"/);
  assert.match(html, /let activeClient = 'code'/);
  assert.match(html, /activeClient = tabId/);
  assert.match(html, /window\.saveCurrentConfig\s*=\s*async function/);
  assert.match(html, /saveConfig\(\{\s*button:\s*btn,\s*client:\s*activeClient,\s*scope:\s*'global'/);
  assert.match(html, /window\.removeEndpoint\s*=\s*async function/);
  assert.match(html, /saveConfig\(\{\s*client,\s*scope:\s*'delete'/);
  assert.match(html, /window\.setAsDefault\s*=\s*async function/);
  assert.match(html, /saveConfig\(\{\s*client,\s*scope:\s*'default'/);
  assert.match(html, /options\.scope === 'default'/);
  assert.match(html, /options\.scope === 'global' && options\.client === 'desktop'/);
  assert.match(html, /options\.scope === 'global' && options\.client === 'codex'/);
});

test("Claude Code config exposes four default-endpoint model slot selectors", async () => {
  const html = await readSources();
  assert.match(html, /Claude Code 快捷模型/);
  assert.match(html, /\.model-slots-panel\s*\{/);
  assert.match(html, /\.model-slots-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(html, /@media\s*\(max-width:\s*1100px\)[^{]*\{[\s\S]*?\.model-slots-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(html, /model_slots/);
  assert.match(html, /opus/);
  assert.match(html, /sonnet/);
  assert.match(html, /haiku/);
  assert.match(html, /fable/);
  assert.match(html, /claudeCodeSync/);
  assert.match(html, /X-Gateway-Config-Client/);
});

test("Claude Code default chat endpoint excludes every capability purpose", async () => {
  const html = await readSources();
  const source = html.match(
    /function getClaudeCodeDefaultEndpoint\(\) \{[\s\S]*?\n\}/,
  )?.[0] || "";

  assert.match(html, /function isCapabilityEndpointPurpose\(purpose\)/);
  assert.match(source, /\.filter\(endpoint => !isCapabilityEndpointPurpose\(endpoint\.purpose\)\)/);
});

test("Claude Code and Desktop guides describe automatic sync and restart only", async () => {
  const html = await readSources();
  const codeSection = html.match(/<section id="section-code"[\s\S]*?<\/section>/)?.[0] || "";
  const desktopSection = html.match(/<section id="section-desktop"[\s\S]*?<\/section>/)?.[0] || "";

  assert.match(codeSection, /自动同步到/);
  assert.match(codeSection, /完全退出并重新启动 Claude Code/);
  assert.doesNotMatch(codeSection, /ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY|修改全局配置/);

  assert.match(desktopSection, /自动同步到/);
  assert.match(desktopSection, /完全退出并重新启动 Claude Desktop/);
  assert.doesNotMatch(desktopSection, /export ANTHROPIC_BASE_URL|open -a "Claude"|环境变量覆盖/);
});

test("endpoint cards expose a compact model visibility switch outside the detail form", async () => {
  const html = await readSources();
  assert.match(html, /\.detail-actions\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*nowrap/s);
  assert.match(html, /class="detail-actions"/);
  assert.match(html, /class="node-card-switch"/);
  assert.match(html, /class="node-card-switch-track"/);
  assert.match(html, /toggleEndpointExposure\(event,\s*'\$\{client\}',\s*\$\{index\},\s*this\)/);
  assert.match(html, /window\.toggleEndpointExposure\s*=\s*async function/);
  assert.doesNotMatch(html, /class="form-group full model-exposure-setting"/);
  assert.doesNotMatch(html, /accent-color:\s*var\(--primary\)/);
});

test("Codex capability updates preserve unrelated fields and do not copy secrets", async () => {
  const sentinel = "sk-task7-ui-must-not-copy";
  const config = {
    future_root: { enabled: true },
    clients: {
      code: { endpoints: [{ name: "other-client", future: "keep" }] },
      codex: {
        future_client: "keep",
        endpoints: [
          {
            name: "target",
            api_key: sentinel,
            future_endpoint: { keep: true },
            capabilities: {
              input_modalities: ["text"],
              reasoning: false,
              tools: true,
              future_capability: "keep",
            },
          },
          { name: "other-endpoint", future: "keep" },
        ],
      },
    },
  };
  const otherClient = structuredClone(config.clients.code);
  const otherEndpoint = structuredClone(config.clients.codex.endpoints[1]);
  const html = await readSources();
  const updateSource = html.match(
    /window\.updateCodexCapability = function\(client, index, capability, enabled\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.equal(typeof updateSource, "string");
  const context = {
    config,
    window: {},
  };
  vm.runInNewContext(`${updateSource};
    window.updateCodexCapability("codex", 0, "image", true);
    window.updateCodexCapability("codex", 0, "reasoning", true);`, context);

  assert.equal(
    Array.from(
      config.clients.codex.endpoints[0].capabilities.input_modalities,
    ).join(","),
    "text,image",
  );
  assert.equal(config.clients.codex.endpoints[0].capabilities.reasoning, true);
  assert.equal(config.clients.codex.endpoints[0].future_endpoint.keep, true);
  assert.equal(config.clients.codex.endpoints[0].capabilities.future_capability, "keep");
  assert.deepEqual(config.clients.code, otherClient);
  assert.deepEqual(config.clients.codex.endpoints[1], otherEndpoint);
  assert.equal(config.clients.codex.endpoints[0].api_key, sentinel);
  assert.equal(JSON.stringify(config).split(sentinel).length - 1, 1);
});
const readHtml = () => readSources();



test("DeepTutor client has a nav tab and a node section mirroring Codex", async () => {
  const html = await readHtml();
  assert.match(html, /href="#deeptutor"[\s\S]*?DeepTutor 代理/);
  assert.match(html, /id="section-deeptutor"/);
  assert.match(html, /id="deeptutor-endpoints"/);
  assert.match(html, /data-client="deeptutor"/);
  assert.match(html, /toggleAddNodeMenu\('deeptutor'/);
});

test("DeepTutor section keeps a connection guide without generic client copy controls", async () => {
  const html = await readHtml();
  assert.match(html, /大语言模型 base_url：[\s\S]*?\/deeptutor\//);
  assert.match(html, /向量模型 base_url：[\s\S]*?\/deeptutor\/emb\/embeddings/);
  assert.doesNotMatch(html, /id="global-copy-panel"/);
  assert.doesNotMatch(html, /id="global-copy-btn"/);
  assert.doesNotMatch(html, /copyClientEndpointsGeneric/);
  assert.doesNotMatch(html, /copyClientFromCodex/);
  assert.doesNotMatch(html, /全局操作/);
});

test("DeepTutor is included in the render loop and default config", async () => {
  const html = await readHtml();
  assert.match(html, /\['code', 'desktop', 'codex', 'deeptutor'\]\.forEach/);
  assert.match(html, /deeptutor: \{ endpoints: \[\] \}/);
  // Deeptutor is preserved when merging fetched clients (now via mergeFetchedClients).
  assert.match(html, /deeptutor: fetched\.deeptutor \|\| \{ endpoints: \[\] \}/);
});

test("DeepTutor endpoints show the capability editor like Codex", async () => {
  const html = await readHtml();
  assert.match(html, /\(client === 'codex' \|\| client === 'deeptutor'\) && !isCapabilityNode/);
});

test("Preset CLI module has a nav group, a discovery section, and an install-history sub-tab", async () => {
  const html = await readHtml();
  assert.match(html, /id="nav-cli-group"/);
  assert.match(html, /href="#cli"[\s\S]*?本机 CLI/);
  assert.match(html, /href="#cli-install-history"/);
  assert.match(html, /id="section-cli"/);
  assert.match(html, /id="section-cli-install-history"/);
  assert.match(html, /refreshCliLibrary/);
  assert.match(html, /setCliView/);
  assert.match(html, /toggleCliFavorite/);
  assert.match(html, /\/v1\/cli\/favorite/);
  assert.match(html, /设为常用/);
  assert.match(html, /showFavoriteBtn/);
  assert.match(html, /取消常用/);
  assert.match(html, /cli-view-toggle/);
  assert.match(html, /viewParam/);
  assert.match(html, /推荐/);
  assert.match(html, /\/v1\/cli\/discover/);
  assert.match(html, /\/v1\/cli\/install-history/);
  assert.match(html, /\/v1\/cli\/install/);
  assert.match(html, /startCliInstallFromForm/);
});

test("CLI scan sources sub-tab and management endpoints exist", async () => {
  const html = await readHtml();
  assert.match(html, /href="#cli-sources"[\s\S]*?扫描来源/);
  assert.match(html, /id="section-cli-sources"/);
  assert.match(html, /refreshCliSources/);
  assert.match(html, /saveCliSources/);
  assert.match(html, /\/v1\/cli\/sources/);
  assert.match(html, /\/v1\/cli\/sources\/reset/);
  assert.match(html, /addCliSourceRow/);
});

test("tools tab nav item and section exist alongside skills", async () => {
  const html = await readSources();
  assert.match(html, /href="#tools"[\s\S]*onclick="switchTab\('tools'\)"/);
  assert.match(html, /<section id="section-tools" class="tab-section"/);
  assert.match(html, /迷你工具/);
});

test("tools cards list renders text embedding card", async () => {
  const html = await readSources();
  assert.match(html, /window\.renderToolsCards\s*=\s*function/);
  assert.match(html, /文本向量化/);
  assert.match(html, /'embedding':/);
  assert.match(html, /renderToolGroups/);
  assert.match(html, /tools-card/);
});

test("image generation mini-tool sends media request and renders local history", async () => {
  const html = await readSources();
  const firstDocument = html;
  assert.match(firstDocument, /'image-gen':/);
  assert.match(firstDocument, /toolCardHTML/);
  assert.match(firstDocument, /toolId === 'image-gen'/);
  assert.match(firstDocument, /const imageGenState\s*=\s*\{/);
  assert.match(firstDocument, /function getMediaEndpoints\(client, purpose\)/);
  assert.match(firstDocument, /window\.renderImageGenDetail\s*=\s*function/);
  assert.match(firstDocument, /window\.runImageGeneration\s*=\s*async function/);
  assert.match(firstDocument, /\/v1\/media\/image/);
  assert.match(firstDocument, /\/v1\/media\/history\?media_type=image/);
  assert.match(firstDocument, /DELETE.*\/v1\/media\/history\//s);
  assert.match(firstDocument, /image_paths/);
  assert.match(firstDocument, /file_path/);
  assert.match(firstDocument, /history_id/);
  assert.match(firstDocument, /historyLoaded/);
  assert.match(firstDocument, /主体\/风格\/构图\/光影\/约束/);
});

test("image generation mini-tool keeps executable DOM action arguments safe", async () => {
  const html = await readSources();
  const firstDocument = html;
  assert.match(firstDocument, /JSON\.stringify\(entry\.id\)/);
  assert.match(firstDocument, /JSON\.stringify\(path\)/);
});

test("media previews use history-owned same-origin files and history actions use a registry", async () => {
  const html = await readSources();
  const firstDocument = html;
  assert.match(firstDocument, /\/v1\/media\/files\//);
  assert.doesNotMatch(firstDocument, /file:\/\//);
  assert.match(firstDocument, /MEDIA_HISTORY_TOOL_REGISTRY/);
  assert.match(firstDocument, /registry\.state\.client/);
  assert.match(firstDocument, /registry\.render\(\)/);
  assert.doesNotMatch(firstDocument, /deleteMediaHistoryEntry[\s\S]{0,800}imageGenState\.client/);
});

test("tools cards list renders classification metrics lab card", async () => {
  const html = await readSources();
  assert.match(html, /分类评估实验室/);
  assert.match(html, /toolId === 'classification-metrics'/);
  assert.match(html, /window\.renderClassificationMetricsDetail\s*=\s*function/);
  assert.match(html, /TP 真正例/);
  assert.match(html, /精准率 Precision/);
  assert.match(html, /召回率 Recall/);
  assert.match(html, /Accuracy vs Precision/);
  assert.match(html, /类别不平衡陷阱/);
  assert.match(html, /业务引导填写/);
  assert.match(html, /setMetricsInputMode\('guided'\)/);
  assert.match(html, /onMetricsGuidedInput/);
  assert.match(html, /系统已翻译成专家口径/);
  assert.match(html, /一共有多少样本/);
  assert.match(html, /其中有多少被判成目标/);
  assert.match(html, /updateMetricsLiveView/);
  assert.match(html, /metrics-input-body/);
  assert.match(html, /metrics-result-body/);
  assert.match(html, /metrics-count-tp/);
  assert.ok(html.includes(`metrics-metric-card' + toneClass + '">`));
});

test("text embedding tool detail renders form, mode switch, and similarity formula", async () => {
  const html = await readSources();
  assert.match(html, /window\.renderToolsDetail\s*=\s*function/);
  assert.match(html, /embed-client-select/);
  assert.match(html, /embed-node-select/);
  assert.match(html, /embed-model-select/);
  assert.match(html, /embed-dims-pill/);
  assert.match(html, /onEmbedCustomDimsToggle/);
  assert.match(html, /embed-mode-single/);
  assert.match(html, /embed-mode-similarity/);
  assert.match(html, /余弦相似度 = \(A·B\) \/ \(‖A‖ × ‖B‖\)/);
  assert.match(html, /范围 -1 到 1/);
});

test("cosine similarity and embedding request helpers exist", async () => {
  const html = await readSources();
  assert.match(html, /function cosineSimilarity\(a, b\)/);
  assert.match(html, /window\.runEmbedding\s*=\s*async function/);
  assert.match(html, /params\.set\('endpoint_id'/);
  assert.match(html, /X-Gateway-Client/);
});

test("agent-node create/remove UI is present and wired", async () => {
  const html = await readHtml();
  // Sidebar trigger + custom nav container.
  assert.match(html, /class="nav-create-client"/);
  assert.match(html, /id="nav-custom-clients"/);
  assert.match(html, /openClientCreateModal/);
  // Create modal with both modes.
  assert.match(html, /id="client-create-modal"/);
  assert.match(html, /id="client-create-name"/);
  assert.match(html, /client-create-mode-empty/);
  assert.match(html, /client-create-mode-copy/);
  assert.match(html, /client-create-copy-config/);
  assert.match(html, /submitCreateClient/);
  // Custom agent-node section + per-block rendering.
  assert.match(html, /id="section-custom-clients"/);
  assert.match(html, /id="custom-clients-container"/);
  assert.match(html, /renderCustomClientNav/);
  assert.match(html, /renderCustomClientSections/);
  assert.match(html, /removeCustomClient/);
  // Built-in clients are protected from removal.
  assert.match(html, /const BUILTIN_CLIENTS = \['code', 'desktop', 'codex', 'deeptutor'\]/);
  assert.match(html, /slugifyClientName/);
  assert.match(html, /\/v1\/config\/add-client/);
  assert.match(html, /\/v1\/config\/remove-client/);
});

test("create modal copy-mode toggles the source picker visibility", async () => {
  const html = await readHtml();
  assert.match(html, /setClientCreateMode\('empty'\)/);
  assert.match(html, /onClientCreateModeChange/);
  assert.match(html, /copyConfig\.classList\.toggle\('is-visible', mode === 'copy'\)/);
});

test("create modal exposes a protocol picker synced to the copy source", async () => {
  const html = await readHtml();
  assert.match(html, /id="client-create-protocol"/);
  assert.match(html, /syncClientCreateProtocol/);
  assert.match(html, /clientProtocolFor/);
  // Both protocols are selectable (match without the trailing closing tag to
  // avoid regex-delimiter issues).
  assert.match(html, /<option value="anthropic">Anthropic Messages 协议/);
  assert.match(html, /<option value="openai">OpenAI 兼容协议/);
  // submitCreateClient forwards the chosen protocol.
  assert.match(html, /protocol = document\.getElementById\('client-create-protocol'\)\?\.value/);
});

test("custom agent-node blocks show the protocol and allow changing it inline", async () => {
  const html = await readHtml();
  assert.match(html, /protocolLabel/);
  assert.match(html, /setCustomClientProtocol/);
  assert.match(html, /custom-client-protocol-select/);
});


test("tools cards list renders antigravity subscribe card", async () => {
  const html = await readSources();
  assert.match(html, /接入 Antigravity 订阅/);
  assert.match(html, /toolId === 'antigravity-subscribe'/);
  assert.match(html, /window\.renderAntigravitySubscribeDetail/);
  assert.match(html, /\/v1\/subscription-auth\/antigravity\/status/);
  assert.match(html, /从本机提取/);
  assert.match(html, /一键登录/);
});

test("endpoint type list includes antigravity google subscription label", async () => {
  const html = await readSources();
  assert.match(html, /value: "antigravity"/);
  assert.match(html, /Antigravity（Google 订阅）/);
  assert.match(html, /\['anthropic',\s*'openai-responses',\s*'openai-chat',\s*'grok',\s*'antigravity'\]/);
  assert.match(html, /Google v1internal gRPC/);
});

test("config panel includes video generation mini-tool card and detail", async () => {
  const html = await readSources();
  assert.match(html, /videoGenState/);
  assert.match(html, /renderVideoGenDetail/);
  assert.match(html, /toolId === 'video-gen'/);
  assert.match(html, /runVideoGeneration/);
  assert.match(html, /pollVideoTask/);
  assert.match(html, /\/v1\/media\/video/);
  assert.match(html, /\/v1\/media\/tasks\//);
  assert.match(html, /registerMediaHistoryTool\('video'/);
  assert.match(html, /media-gen-progress-bar/);
  assert.match(html, /applyVideoPromptSuggestion/);
  assert.match(html, /镜头1/);
});

test("config panel includes TTS mini-tool card and detail", async () => {
  const html = await readSources();
  assert.match(html, /ttsGenState/);
  assert.match(html, /renderTtsGenDetail/);
  assert.match(html, /toolId === 'tts-gen'/);
  assert.match(html, /runTtsGeneration/);
  assert.match(html, /\/v1\/media\/tts/);
  assert.match(html, /registerMediaHistoryTool\('tts'/);
  assert.match(html, /zh_female_qingxin/);
  assert.match(html, /speedRatio/);
});

test("media mini-tools use shared custom select popovers instead of native selects", async () => {
  const html = await readSources();
  const firstDocument = html;
  assert.match(firstDocument, /function renderUiSelectHtml\(/);
  assert.match(firstDocument, /window\.toggleUiSelect\s*=\s*function/);
  assert.match(firstDocument, /window\.chooseUiSelectOption\s*=\s*function/);
  assert.match(firstDocument, /\.ui-select-dropdown/);
  assert.match(firstDocument, /id: 'image-gen-endpoint'/);
  assert.match(firstDocument, /id: 'video-gen-endpoint'/);
  assert.match(firstDocument, /id: 'tts-gen-voice'/);
  assert.doesNotMatch(firstDocument, /onImageGenClientChange\(this\.value\)/);
  assert.doesNotMatch(firstDocument, /onVideoGenClientChange\(this\.value\)/);
  assert.doesNotMatch(firstDocument, /onTtsGenClientChange\(this\.value\)/);
});

test("media mini-tools show full built-in client display names", async () => {
  const html = await readSources();
  const firstDocument = html;
  assert.match(firstDocument, /function clientDisplayName\(client\)/);
  assert.match(firstDocument, /code:\s*'Claude Code'/);
  assert.match(firstDocument, /desktop:\s*'Claude Desktop'/);
  assert.match(firstDocument, /label:\s*clientDisplayName\(client\)/);
});


test("chat model discovery suggestions and Claude catalog mini-tool are wired", async () => {
  const html = await readSources();
  const firstDocument = html;
  assert.match(firstDocument, /fetchEndpointModels/);
  assert.match(firstDocument, /Auto-discover when user focuses upstream model or mapping target fields/);
  assert.match(firstDocument, /refreshEndpointModels/);
  assert.match(firstDocument, /\/v1\/config\/endpoints\//);
  assert.match(firstDocument, /model-discovery-list/);
  assert.match(firstDocument, /map-target-list/);
  assert.match(firstDocument, /mergeClaudeOfficialModelsLocal/);
  assert.match(firstDocument, /availableClaudeDesktopMappingSources/);
  assert.match(firstDocument, /getUsedClaudeDesktopMappingSources/);
  assert.doesNotMatch(firstDocument, /'claude-sonnet'(?!,)/);
  assert.match(firstDocument, /'claude-opus-4-6'/);
  assert.match(firstDocument, /toolId === 'claude-model-catalog'/);
  assert.match(firstDocument, /renderClaudeModelCatalogDetail/);
  assert.doesNotMatch(firstDocument, /endpoint\.models\s*=\s*json\.models/);
});

/**
 * Web config panel regression tests.
 *
 * These cover desktop/config-panel.html and must stay after Electron shell removal.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(".");

test("config panel exposes Codex tools, reasoning, and image capabilities", async () => {
  const html = await readFile(
    path.join(ROOT, "desktop", "config-panel.html"),
    "utf8",
  );
  assert.match(html, /Codex 能力/);
  assert.match(html, /capabilities-input-image/);
  assert.match(html, /capabilities-reasoning/);
  assert.match(html, /capabilities-tools/);
  assert.match(html, /wire_api = "responses"/);
});

test("Codex capability controls and active navigation use compact product styling", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /\.nav-item\.active\s*\{[^}]*box-shadow:\s*inset 2px 0 0/s);
  assert.match(html, /\.capability-options\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(html, /\.capability-option\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center/s);
  assert.match(html, /\.capability-checkbox\s*\{[^}]*width:\s*16px[^}]*height:\s*16px[^}]*padding:\s*0/s);
  assert.match(html, /class="capability-option"/);
  assert.match(html, /class="capability-checkbox"/);
  assert.doesNotMatch(html, /class="checkbox-row"/);
});

test("config panel supports stable endpoint ids, secret status, exposure, and conflict suggestions", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
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
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /Anthropic Messages 协议/);
  assert.match(
    html,
    /\['anthropic',\s*'openai-responses',\s*'openai-chat',\s*'grok'\]/,
  );
  assert.match(html, /<label>鉴权方式<\/label>/);
  assert.match(html, /value="bearer"/);
  assert.match(html, /value="x-api-key"/);
});

test("endpoint detail provides an explicit manual save action", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /id="save-node-\$\{client\}-\$\{index\}"/);
  assert.match(html, /onclick="saveNode\('\$\{client\}', \$\{index\}\)"/);
  assert.match(html, /window\.saveNode\s*=\s*async function/);
  assert.match(html, /saveConfig\(\{\s*button:\s*btn,\s*client,\s*scope:\s*'node'/);
});

test("each client can add capability nodes from the grouped node menu", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /addNodeByPurpose\('code'/);
  assert.match(html, /addNodeByPurpose\('desktop'/);
  assert.match(html, /addNodeByPurpose\('codex'/);
  assert.match(html, /聊天模型节点/);
  assert.match(html, /视觉兜底节点/);
  assert.match(html, /联网搜索节点/);
  assert.match(html, /向量模型节点/);
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
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /function createEndpointGroupsHTML/);
  assert.match(html, /title:\s*'聊天模型'/);
  assert.match(html, /title:\s*'视觉兜底'/);
  assert.match(html, /title:\s*'联网搜索'/);
  assert.match(html, /title:\s*'向量模型'/);
  assert.match(html, /class="node-group-header"/);
  assert.match(html, /class="node-group-count"/);
});

test("section header actions stay compact and wrap cleanly on narrow screens", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /\.section-header-actions\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(html, /\.section-header-actions \.btn\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(html, /\.add-node-menu\s*\{[^}]*width:\s*148px[^}]*max-width:\s*148px/s);
  assert.match(html, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.section-header\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(html, />\s*迁移历史\s*</);
});

test("each upstream model exposes supported and unsupported vision choices", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /updateModelImageCapability/);
  assert.match(html, />支持视觉</);
  assert.match(html, />不支持视觉</);
  assert.match(html, /model_capabilities/);
  assert.match(html, /delete endpoint\.model_capabilities\[model\]/);
});

test("global and card save actions preserve the active client context", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
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
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
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

test("Claude Code and Desktop guides describe automatic sync and restart only", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
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
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
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
  const html = await readFile(
    path.join(ROOT, "desktop", "config-panel.html"),
    "utf8",
  );
  const updateSource = html.match(
    /window\.updateCodexCapability = function\(client, index, capability, enabled\) \{[\s\S]*?\n        \}/,
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

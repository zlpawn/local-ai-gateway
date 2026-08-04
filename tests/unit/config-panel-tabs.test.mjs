import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(".");
// Panel sources are split across app.ts (JS), index.html (shell), panel.css (styles).
const _app = fs.readFileSync(path.join(ROOT, "desktop", "src", "app.ts"), "utf8");
const _idx = fs.readFileSync(path.join(ROOT, "desktop", "index.html"), "utf8");
const _css = fs.readFileSync(path.join(ROOT, "desktop", "src", "styles", "panel.css"), "utf8");
const SOURCES = _app + "\n" + _idx + "\n" + _css;

test("config panel contains 用量统计 and 网络代理 navigation items and tab sections", () => {
  const html = SOURCES;

  // Verify 4-character Chinese Tab Nav labels
  assert.match(html, /用量统计/);
  assert.match(html, /网络代理/);

  // Verify tab IDs
  assert.match(html, /href="#analytics"/);
  assert.match(html, /href="#proxy"/);

  // Verify tab section IDs
  assert.match(html, /id="section-analytics"/);
  assert.match(html, /id="section-proxy"/);

  // Verify controls in Analytics tab
  assert.match(html, /loadAnalyticsData/);

  // Verify controls in Proxy tab
  assert.match(html, /testProxyConnection/);
  assert.match(html, /saveProxyConfig/);
});

test("endpoint editor renders one upstream-model heading per node", () => {
  const html = SOURCES;
  const editorBlock = html.match(
    /\$\{isWebSearch \? '' : `<div class="form-group full">[\s\S]*?<div class="form-group full">\s*<label>模型映射关系/,
  )?.[0] || "";

  assert.ok(editorBlock, "expected to find the endpoint upstream-model editor");
  assert.equal(
    (editorBlock.match(/上游模型列表 \(输入模型名称后按回车添加\)/g) || []).length,
    1,
  );
});





test("proxy and analytics tabs expose one complete set of working page actions", () => {
  const html = SOURCES;

  assert.equal((html.match(/onclick="testProxyConnection\(\)"/g) || []).length, 1);
  for (const functionName of [
    "loadProxyConfig",
    "saveProxyConfig",
    "testProxyConnection",
    "renderProxyEndpointsList",
    "loadAnalyticsData",
  ]) {
    assert.match(
      html,
      new RegExp(`window\\.${functionName}\\s*=\\s*(?:async\\s*)?function`),
      `${functionName} should be implemented`,
    );
  }

  assert.match(html, /fetch\('\/v1\/config\/proxy'/);
  assert.match(html, /fetch\('\/v1\/config\/proxy\/test'/);
  assert.match(html, /fetch\(`\/v1\/analytics\/token-usage\?/);
});

test("proxy endpoint status table lets users toggle each node between global and direct", () => {
  const html = SOURCES;
  assert.match(html, /setEndpointProxyMode/);
  assert.match(html, /data-proxy-client=/);
  assert.match(html, /上游域名/);
});

test("mini tools are grouped into categories instead of one flat grid", () => {
  const html = SOURCES;
  assert.match(html, /renderToolGroups|toolGroupConfigs/);
  assert.match(html, /媒体生成/);
  assert.match(html, /向量化/);
  assert.match(html, /订阅接入/);
  assert.match(html, /模型配置/);
  assert.match(html, /其他/);
  assert.match(html, /tools-group/);
});

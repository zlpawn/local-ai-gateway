import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const panelPath = path.resolve("desktop", "config-panel.html");

test("config panel contains 用量统计 and 网络代理 navigation items and tab sections", () => {
  const html = fs.readFileSync(panelPath, "utf8");

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
  const html = fs.readFileSync(panelPath, "utf8");
  const editorBlock = html.match(
    /\$\{isWebSearch \? '' : `<div class="form-group full">[\s\S]*?<div class="form-group full">\s*<label>模型映射关系/,
  )?.[0] || "";

  assert.ok(editorBlock, "expected to find the endpoint upstream-model editor");
  assert.equal(
    (editorBlock.match(/上游模型列表 \(输入模型名称后按回车添加\)/g) || []).length,
    1,
  );
});

test("config panel contains exactly one complete HTML document", () => {
  const html = fs.readFileSync(panelPath, "utf8");
  assert.equal((html.match(/<\/html>/gi) || []).length, 1);
  assert.equal(html.trimEnd().endsWith("</html>"), true);
});

test("proxy and analytics tabs expose one complete set of working page actions", () => {
  const html = fs.readFileSync(panelPath, "utf8");

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

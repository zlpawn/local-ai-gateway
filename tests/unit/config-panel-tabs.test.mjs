import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("config panel contains 用量统计 and 网络代理 navigation items and tab sections", () => {
  const html = fs.readFileSync(".worktrees/volc-models-filter/desktop/config-panel.html", "utf8");

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

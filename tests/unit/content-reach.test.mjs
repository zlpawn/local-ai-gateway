import assert from "node:assert/strict";
import test from "node:test";

import { detectAgentReach, getDoctorReport, getInstalledChannels } from "../../lib/content-reach/detector.mjs";
import { fetchContent } from "../../lib/content-reach/fetcher.mjs";
import { getInstallHint, detectUv } from "../../lib/content-reach/installer.mjs";

test("detectAgentReach: returns object with installed flag", () => {
  const result = detectAgentReach();
  assert.ok(typeof result.installed === "boolean");
  if (result.installed) {
    assert.ok(typeof result.path === "string");
    assert.ok(typeof result.version === "string");
  }
});

test("getDoctorReport: returns channels array", async () => {
  const report = await getDoctorReport();
  assert.ok(Array.isArray(report.channels));
});

test("getInstalledChannels: returns string array", async () => {
  const channels = await getInstalledChannels();
  assert.ok(Array.isArray(channels));
  for (const ch of channels) {
    assert.ok(typeof ch === "string");
  }
});

test("fetchContent: returns null or content object", async () => {
  // This test only runs meaningfully if agent-reach is installed
  const detected = detectAgentReach();
  if (!detected.installed) {
    assert.ok(true, "agent-reach not installed, skipping");
    return;
  }

  const content = await fetchContent("https://www.youtube.com/watch?v=nonexistent");
  if (content) {
    assert.ok(typeof content.title === "string");
    assert.ok(typeof content.text === "string");
    assert.ok(typeof content.source === "string");
    assert.ok(typeof content.type === "string");
  }
  // null is also acceptable for a non-existent video
});

test("getInstallHint: returns steps and commands", () => {
  const hint = getInstallHint();
  assert.ok(typeof hint.available === "boolean");
  assert.ok(Array.isArray(hint.steps));
  assert.ok(typeof hint.tool === "string");
});

test("detectUv: returns boolean", () => {
  const result = detectUv();
  assert.ok(typeof result === "boolean");
});

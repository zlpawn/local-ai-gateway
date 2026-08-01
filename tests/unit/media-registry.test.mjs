import assert from "node:assert/strict";
import test from "node:test";

import { getMediaProvider, listMediaProviderIds } from "../../lib/media/providers/registry.mjs";

test("listMediaProviderIds returns all four providers", () => {
  const ids = listMediaProviderIds();
  assert.ok(ids.includes("grok-subscription"));
  assert.ok(ids.includes("codex-subscription"));
  assert.ok(ids.includes("antigravity"));
  assert.ok(ids.includes("huoshan-agentplan"));
});

test("getMediaProvider returns adapter object", () => {
  const adapter = getMediaProvider("grok-subscription");
  assert.ok(adapter);
  assert.equal(adapter.id, "grok-subscription");
});

test("getMediaProvider returns null for unknown provider", () => {
  assert.equal(getMediaProvider("unknown"), null);
});

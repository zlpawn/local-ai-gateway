import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTokenTracker } from "../../lib/analytics/token-tracker.mjs";

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cost-"));
  return path.join(dir, "test.db");
}

test("schema migration is idempotent - open DB twice without error", () => {
  const dbPath = makeTempDb();
  const tracker1 = createTokenTracker({ dbPath });
  tracker1.close();
  // Opening again should not error
  const tracker2 = createTokenTracker({ dbPath });
  tracker2.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("recordUsage with known USD model stores correct cost", () => {
  const dbPath = makeTempDb();
  const tracker = createTokenTracker({ dbPath });
  tracker.recordUsage({
    timestamp: Date.now(),
    client: "codex",
    endpoint_id: "ep_test",
    endpoint_name: "test",
    purpose: "chat",
    model: "gpt-4o",
    prompt_tokens: 1000000,
    completion_tokens: 500000,
    price: { currency: "usd", prompt: 2.5, completion: 10, cache_creation: 0, cache_read: 1.25, source: "default" },
    fxRate: { usd_to_cny: 7.2, source: "default", updated_at: Date.now() },
  });
  const result = tracker.queryUsage({ range: "7d" });
  assert.equal(result.summary.total_requests, 1);
  // cost = (1M * 2.5 + 0.5M * 10) / 1M = 2.5 + 5 = 7.5
  assert.ok(result.summary.cost_native > 7.4 && result.summary.cost_native < 7.6,
    `expected ~7.5, got ${result.summary.cost_native}`);
  assert.equal(result.summary.cost_usd, result.summary.cost_native); // USD native = USD
  tracker.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("recordUsage with CNY model converts to USD correctly", () => {
  const dbPath = makeTempDb();
  const tracker = createTokenTracker({ dbPath });
  tracker.recordUsage({
    timestamp: Date.now(),
    client: "codex",
    endpoint_id: "ep_test",
    endpoint_name: "test",
    purpose: "chat",
    model: "glm-5.2",
    prompt_tokens: 1000000,
    completion_tokens: 0,
    price: { currency: "cny", prompt: 2.0, completion: 8.0, cache_creation: 0, cache_read: 0, source: "vendored" },
    fxRate: { usd_to_cny: 7.2, source: "default", updated_at: Date.now() },
  });
  const result = tracker.queryUsage({ range: "7d" });
  // cost_native = 1M * 2.0 / 1M = 2.0 CNY
  // cost_usd = 2.0 / 7.2 = 0.2778
  assert.ok(result.summary.cost_native > 1.99 && result.summary.cost_native < 2.01,
    `expected ~2.0, got ${result.summary.cost_native}`);
  assert.ok(result.summary.cost_usd > 0.27 && result.summary.cost_usd < 0.28,
    `expected ~0.278, got ${result.summary.cost_usd}`);
  tracker.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("recordUsage with cache tokens applies cache pricing", () => {
  const dbPath = makeTempDb();
  const tracker = createTokenTracker({ dbPath });
  tracker.recordUsage({
    timestamp: Date.now(),
    client: "codex",
    endpoint_id: "ep_test",
    endpoint_name: "test",
    purpose: "chat",
    model: "claude-3-5-sonnet",
    prompt_tokens: 1000000, // includes 200K cache creation + 200K cache read
    completion_tokens: 100000,
    cache_creation_tokens: 200000,
    cache_read_tokens: 200000,
    price: { currency: "usd", prompt: 3.0, completion: 15.0, cache_creation: 3.75, cache_read: 0.3, source: "default" },
    fxRate: { usd_to_cny: 7.2, source: "default", updated_at: Date.now() },
  });
  const result = tracker.queryUsage({ range: "7d" });
  // billablePrompt = 1M - 200K - 200K = 600K
  // cost = (200K * 3.75 + 200K * 0.3 + 600K * 3.0 + 100K * 15.0) / 1M
  //      = (0.75 + 0.06 + 1.8 + 1.5) = 4.11
  assert.ok(result.summary.cost_native > 4.10 && result.summary.cost_native < 4.12,
    `expected ~4.11, got ${result.summary.cost_native}`);
  tracker.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("recordUsage with unknown model stores zero cost", () => {
  const dbPath = makeTempDb();
  const tracker = createTokenTracker({ dbPath });
  tracker.recordUsage({
    timestamp: Date.now(),
    client: "codex",
    endpoint_id: "ep_test",
    endpoint_name: "test",
    purpose: "chat",
    model: "unknown-model-xyz",
    prompt_tokens: 1000,
    completion_tokens: 500,
    price: null,
    fxRate: null,
  });
  const result = tracker.queryUsage({ range: "7d" });
  assert.equal(result.summary.cost_native, 0);
  assert.equal(result.summary.cost_usd, 0);
  tracker.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("queryUsage returns cost_usd in breakdown rows", () => {
  const dbPath = makeTempDb();
  const tracker = createTokenTracker({ dbPath });
  tracker.recordUsage({
    timestamp: Date.now(),
    client: "codex",
    endpoint_id: "ep_test",
    endpoint_name: "test",
    purpose: "chat",
    model: "gpt-4o",
    prompt_tokens: 100000,
    completion_tokens: 50000,
    price: { currency: "usd", prompt: 2.5, completion: 10, cache_creation: 0, cache_read: 1.25, source: "default" },
    fxRate: { usd_to_cny: 7.2, source: "default", updated_at: Date.now() },
  });
  const result = tracker.queryUsage({ range: "7d" });
  assert.ok(result.model_breakdown.length > 0);
  assert.ok(result.model_breakdown[0].cost_usd >= 0);
  assert.ok(result.detail_breakdown.length > 0);
  assert.ok(result.detail_breakdown[0].cost_usd >= 0);
  tracker.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});
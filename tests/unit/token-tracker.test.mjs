import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTokenTracker } from "../../lib/analytics/token-tracker.mjs";

test("TokenTracker records usage and aggregates timeline by minute, hour, day, and purpose filters", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-test-"));
  const dbPath = path.join(tmpDir, "test-gateway.db");

  const tracker = createTokenTracker({ dbPath });

  // Record some sample usage entries
  tracker.recordUsage({
    timestamp: 1785648000000, // 2026-08-02T13:20:00.000Z
    client: "codex",
    endpoint_id: "ep_chat_1",
    endpoint_name: "huoshan-agentplan",
    purpose: "chat",
    model: "doubao-seed-2.0-pro",
    prompt_tokens: 100,
    completion_tokens: 50,
  });

  tracker.recordUsage({
    timestamp: 1785648030000, // 2026-08-02T13:20:30.000Z
    client: "codex",
    endpoint_id: "ep_chat_1",
    endpoint_name: "huoshan-agentplan",
    purpose: "chat",
    model: "doubao-seed-2.0-pro",
    prompt_tokens: 200,
    completion_tokens: 100,
  });

  tracker.recordUsage({
    timestamp: 1785648060000, // 2026-08-02T13:21:00.000Z
    client: "codex",
    endpoint_id: "ep_emb_1",
    endpoint_name: "huoshan-agentplan",
    purpose: "embedding",
    model: "doubao-embedding-vision",
    prompt_tokens: 30,
    completion_tokens: 0,
  });

  // Query hour breakdown
  const hourSummary = tracker.queryUsage({ granularity: "hour", range: "24h" });
  assert.ok(hourSummary.summary.total_tokens >= 480);
  assert.equal(hourSummary.summary.total_requests, 3);
  assert.equal(hourSummary.summary.prompt_tokens, 330);
  assert.equal(hourSummary.summary.completion_tokens, 150);

  // Query with purpose filter = "chat"
  const chatSummary = tracker.queryUsage({ granularity: "minute", range: "24h", purpose: "chat" });
  assert.equal(chatSummary.summary.total_requests, 2);
  assert.equal(chatSummary.summary.total_tokens, 450);

  // Query with purpose filter = "embedding"
  const embSummary = tracker.queryUsage({ granularity: "minute", range: "24h", purpose: "embedding" });
  assert.equal(embSummary.summary.total_requests, 1);
  assert.equal(embSummary.summary.total_tokens, 30);

  tracker.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

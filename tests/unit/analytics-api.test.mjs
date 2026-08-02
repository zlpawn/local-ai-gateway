import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTokenTracker } from "../../lib/analytics/token-tracker.mjs";

test("TokenTracker queryUsage handles empty database gracefully", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-api-test-"));
  const dbPath = path.join(tmpDir, "test-gateway-empty.db");

  const tracker = createTokenTracker({ dbPath });
  const result = tracker.queryUsage({ granularity: "hour", range: "24h", purpose: "all" });

  assert.equal(result.summary.total_requests, 0);
  assert.equal(result.summary.total_tokens, 0);
  assert.equal(result.timeline.length, 0);
  assert.equal(result.purpose_breakdown.length, 0);

  tracker.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

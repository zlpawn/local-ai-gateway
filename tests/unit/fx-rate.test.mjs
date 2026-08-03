import test from "node:test";
import assert from "node:assert/strict";
import { createFxRateService } from "../../lib/analytics/fx-rate.mjs";

test("getRate returns default rate on startup", () => {
  const svc = createFxRateService();
  const rate = svc.getRate();
  assert.equal(typeof rate.usd_to_cny, "number");
  assert.ok(rate.usd_to_cny > 0);
  assert.equal(typeof rate.source, "string");
  assert.equal(typeof rate.updated_at, "number");
});

test("getRate returns a reasonable CNY rate (>5, <10)", () => {
  const svc = createFxRateService();
  const rate = svc.getRate();
  assert.ok(rate.usd_to_cny > 5, `expected > 5, got ${rate.usd_to_cny}`);
  assert.ok(rate.usd_to_cny < 10, `expected < 10, got ${rate.usd_to_cny}`);
});
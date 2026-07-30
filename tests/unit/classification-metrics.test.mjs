import test from "node:test";
import assert from "node:assert/strict";
import {
  computeConfusionMetrics,
  buildMetricsNarrative,
  formatPercent,
  getScenario,
} from "../../lib/tools/classification-metrics.mjs";

test("computeConfusionMetrics calculates core binary metrics", () => {
  const result = computeConfusionMetrics({ tp: 40, fp: 10, fn: 20, tn: 130 });
  assert.equal(result.totals.total, 200);
  assert.equal(result.metrics.accuracy.value, 0.85);
  assert.equal(result.metrics.precision.value, 0.8);
  assert.equal(result.metrics.recall.value, Number((40 / 60).toFixed(6)));
  assert.equal(result.metrics.f1.value, Number(((2 * 0.8 * (40 / 60)) / (0.8 + 40 / 60)).toFixed(6)));
});

test("computeConfusionMetrics marks precision unavailable when no predicted positives", () => {
  const result = computeConfusionMetrics({ tp: 0, fp: 0, fn: 10, tn: 990 });
  assert.equal(result.metrics.precision.value, null);
  assert.equal(result.metrics.precision.unavailable, true);
  assert.equal(result.metrics.accuracy.value, 0.99);
  assert.equal(result.metrics.recall.value, 0);
});

test("buildMetricsNarrative explains imbalance trap", () => {
  const result = computeConfusionMetrics(getScenario("imbalance").counts);
  const lines = buildMetricsNarrative(result);
  assert.ok(lines.some((line) => line.includes("准确率容易虚高") || line.includes("准确率")));
  assert.equal(formatPercent(result.metrics.accuracy), "99.0%");
});

test("invalid counts are rejected", () => {
  assert.throws(
    () => computeConfusionMetrics({ tp: -1, fp: 0, fn: 0, tn: 1 }),
    /TP must be a non-negative integer/,
  );
});

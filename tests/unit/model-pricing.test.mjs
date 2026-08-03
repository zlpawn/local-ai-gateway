import test from "node:test";
import assert from "node:assert/strict";
import { createModelPricingEngine } from "../../lib/analytics/model-pricing.mjs";

const engine = createModelPricingEngine({
  configDir: "./test-tmp-pricing",
  customPrices: [
    { model: "my-custom-model", currency: "usd", prompt: 1.0, completion: 2.0 },
  ],
});

test("custom_prices override takes precedence", () => {
  const price = engine.resolvePrice("my-custom-model");
  assert.equal(price.source, "custom");
  assert.equal(price.currency, "usd");
  assert.equal(price.prompt, 1.0);
  assert.equal(price.completion, 2.0);
});

test("alias resolution strips provider prefix", () => {
  const price = engine.resolvePrice("deepseek-ai/DeepSeek-V3");
  assert.notEqual(price.source, "unknown");
  assert.equal(price.currency, "cny");
});

test("alias resolution strips version suffix", () => {
  const price = engine.resolvePrice("claude-3-5-sonnet-20241022");
  assert.equal(price.source, "default");
  assert.equal(price.currency, "usd");
  assert.equal(price.prompt, 3);
});

test("vendored CN price for glm-5.2", () => {
  const price = engine.resolvePrice("glm-5.2");
  assert.equal(price.source, "vendored");
  assert.equal(price.currency, "cny");
  assert.equal(price.prompt, 2.0);
  assert.equal(price.completion, 8.0);
});

test("cache price defaults for Anthropic models", () => {
  const price = engine.resolvePrice("claude-3-5-sonnet");
  assert.equal(price.source, "default");
  // Anthropic defaults: cache_creation = prompt * 1.25, cache_read = prompt * 0.10
  assert.equal(price.cache_creation, 3 * 1.25);
  assert.ok(Math.abs(price.cache_read - 3 * 0.1) < 0.001);
});

test("cache price defaults for OpenAI models", () => {
  const price = engine.resolvePrice("gpt-4o");
  assert.equal(price.source, "default");
  // OpenAI default: cache_read = prompt * 0.50
  assert.equal(price.cache_read, 2.5 * 0.5);
});

test("fallback to DEFAULT_MODEL_PRICES", () => {
  const price = engine.resolvePrice("gpt-4o-mini");
  assert.equal(price.source, "default");
  assert.equal(price.currency, "usd");
});

test("unknown model returns source: unknown", () => {
  const price = engine.resolvePrice("totally-unknown-model-xyz");
  assert.equal(price.source, "unknown");
  assert.equal(price.currency, null);
  assert.equal(price.prompt, 0);
  assert.equal(price.completion, 0);
});
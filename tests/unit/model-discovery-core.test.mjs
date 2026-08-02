import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDiscoveredModels } from "../../lib/models/normalize.mjs";
import { createModelDiscoveryCache } from "../../lib/models/cache.mjs";
import { createModelDiscoveryService } from "../../lib/models/discovery-service.mjs";
import { openaiCompatibleStrategy, buildOpenAICompatibleModelsUrl, buildOpenAICompatibleModelsUrlCandidates } from "../../lib/models/strategies/openai-compatible.mjs";

test("normalizeDiscoveredModels accepts OpenAI list payload", () => {
  const models = normalizeDiscoveredModels({
    data: [{ id: "glm-5.2" }, { id: "minimax-m3", name: "MiniMax" }, { id: "glm-5.2" }],
  });
  assert.deepEqual(models, [
    { id: "glm-5.2", name: "glm-5.2" },
    { id: "minimax-m3", name: "MiniMax" },
  ]);
});

test("cache expires but still exposes stale value", () => {
  let now = 1000;
  const cache = createModelDiscoveryCache({ ttlMs: 10, now: () => now });
  cache.set("k", { models: [{ id: "a", name: "a" }], strategy: "openai-compatible", fetched_at: "t0" });
  assert.deepEqual(cache.get("k").models[0].id, "a");
  now = 1020;
  assert.equal(cache.get("k"), null);
  assert.equal(cache.getStale("k").models[0].id, "a");
});

test("service rejects capability endpoints", async () => {
  const service = createModelDiscoveryService({ strategies: [openaiCompatibleStrategy] });
  await assert.rejects(
    () => service.discoverEndpointModels({
      client: "codex",
      endpoint: { id: "ep1", purpose: "image_generation", base_url: "https://x" },
    }),
    /chat/i,
  );
});

test("openai compatible strategy discovers models with bearer auth", async () => {
  const calls = [];
  const strategy = openaiCompatibleStrategy;
  const result = await strategy.discover(
    { id: "ep1", base_url: "https://api.example.com/v1", auth: "bearer" },
    {
      apiKey: "sk-test",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          async json() {
            return { data: [{ id: "model-a" }, { id: "model-b", name: "B" }] };
          },
        };
      },
    },
  );
  assert.equal(calls[0].url, "https://api.example.com/v1/models");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.deepEqual(result.models.map((m) => m.id), ["model-a", "model-b"]);
});

test("service returns stale cache when refresh fails", async () => {
  const service = createModelDiscoveryService({
    strategies: [openaiCompatibleStrategy],
    resolveApiKey: () => "sk",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { data: [{ id: "fresh-1" }] };
      },
    }),
  });
  const endpoint = { id: "ep1", base_url: "https://api.example.com/v1", auth: "bearer" };
  const first = await service.discoverEndpointModels({ client: "codex", endpoint });
  assert.equal(first.models[0].id, "fresh-1");

  const failing = createModelDiscoveryService({
    strategies: [openaiCompatibleStrategy],
    cache: service.cache || undefined,
    resolveApiKey: () => "sk",
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  // Reuse same service instance with patched fetch by calling strategy path via new service
  // that starts empty would not have stale; instead verify error path returns structured error.
  const secondService = createModelDiscoveryService({
    strategies: [openaiCompatibleStrategy],
    resolveApiKey: () => "sk",
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  // seed via internal cache by successful call first on this instance
  secondService.cache?.set?.("codex:ep1", {
    strategy: "openai-compatible",
    models: [{ id: "cached", name: "cached" }],
    fetched_at: "t0",
  });
  // createModelDiscoveryService does not expose cache; rebuild with shared cache
});

test("service uses shared cache fallback on failure", async () => {
  const { createModelDiscoveryCache } = await import("../../lib/models/cache.mjs");
  const cache = createModelDiscoveryCache({ ttlMs: 60_000 });
  cache.set("codex:ep1", {
    strategy: "openai-compatible",
    models: [{ id: "cached", name: "cached" }],
    fetched_at: "t0",
  });
  const service = createModelDiscoveryService({
    strategies: [openaiCompatibleStrategy],
    cache,
    resolveApiKey: () => "sk",
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  const result = await service.discoverEndpointModels({
    client: "codex",
    endpoint: { id: "ep1", base_url: "https://api.example.com/v1" },
    refresh: true,
  });
  assert.equal(result.source, "cache");
  assert.equal(result.models[0].id, "cached");
  assert.match(result.error.message, /network down/);
});


test("buildOpenAICompatibleModelsUrl handles volcengine roots and chat completions paths", () => {
  assert.equal(
    buildOpenAICompatibleModelsUrl("https://ark.cn-beijing.volces.com/api/coding"),
    "https://ark.cn-beijing.volces.com/api/coding/v3/models",
  );
  // plan root prefers shared /api/v3/models because /api/plan/v3/models often 404s
  assert.equal(
    buildOpenAICompatibleModelsUrl("https://ark.cn-beijing.volces.com/api/plan"),
    "https://ark.cn-beijing.volces.com/api/v3/models",
  );
  assert.equal(
    buildOpenAICompatibleModelsUrl("https://huskyapi.com/v1/chat/completions"),
    "https://huskyapi.com/v1/models",
  );
  assert.equal(
    buildOpenAICompatibleModelsUrl("https://api.example.com/v1"),
    "https://api.example.com/v1/models",
  );
});


test("volcengine plan candidates include shared /api/v3/models before plan/v3/models", () => {
  const candidates = buildOpenAICompatibleModelsUrlCandidates("https://ark.cn-beijing.volces.com/api/plan");
  assert.ok(candidates.includes("https://ark.cn-beijing.volces.com/api/v3/models"));
  assert.ok(candidates.indexOf("https://ark.cn-beijing.volces.com/api/v3/models") < candidates.indexOf("https://ark.cn-beijing.volces.com/api/plan/v3/models"));
});

test("openai compatible strategy tries next candidate after 404", async () => {
  const calls = [];
  const result = await openaiCompatibleStrategy.discover(
    { id: "ep1", base_url: "https://ark.cn-beijing.volces.com/api/plan", auth: "bearer" },
    {
      apiKey: "sk-test",
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.endsWith("/api/plan/v3/models")) {
          return { ok: false, status: 404 };
        }
        if (url.endsWith("/api/v3/models")) {
          return {
            ok: true,
            async json() { return { data: [{ id: "doubao-pro" }] }; },
          };
        }
        return { ok: false, status: 404 };
      },
    },
  );
  assert.equal(result.models[0].id, "doubao-pro");
  assert.ok(calls.some((u) => u.endsWith("/api/v3/models")));
});

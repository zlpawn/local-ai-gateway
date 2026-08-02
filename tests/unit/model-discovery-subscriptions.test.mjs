import test from "node:test";
import assert from "node:assert/strict";
import { createModelDiscoveryService } from "../../lib/models/discovery-service.mjs";
import {
  createDefaultStrategies,
  codexSubscriptionStrategy,
  antigravityStrategy,
  grokSubscriptionStrategy,
  openaiCompatibleStrategy,
} from "../../lib/models/strategies/index.mjs";

test("subscription strategies win over base_url strategy", () => {
  assert.equal(codexSubscriptionStrategy.supports({ type: "codex-subscription", base_url: "https://x" }), true);
  assert.equal(antigravityStrategy.supports({ type: "antigravity" }), true);
  assert.equal(grokSubscriptionStrategy.supports({ type: "grok" }), true);
  assert.equal(grokSubscriptionStrategy.supports({ type: "grok-subscription" }), true);
  const strategies = createDefaultStrategies();
  const selected = strategies.find((s) => s.supports({ type: "codex-subscription", base_url: "https://example.com/v1" }));
  assert.equal(selected.id, "codex-subscription");
});

test("service routes grok endpoints to grok strategy", async () => {
  const service = createModelDiscoveryService({
    strategies: createDefaultStrategies(),
  });
  const result = await service.discoverEndpointModels({
    client: "codex",
    endpoint: { id: "ep-grok", type: "grok" },
    context: {
      loadGrokModels: async () => [{ id: "grok-4.5", name: "Grok 4.5" }],
    },
  });
  assert.equal(result.strategy, "grok-subscription");
  assert.deepEqual(result.models.map((m) => m.id), ["grok-4.5"]);
  assert.equal(result.source, "subscription");
});

test("openai fallback still works for plain base_url chat endpoints", async () => {
  const service = createModelDiscoveryService({
    strategies: createDefaultStrategies(),
    resolveApiKey: () => "sk",
    fetchImpl: async () => ({
      ok: true,
      async json() { return { data: [{ id: "glm-5.2" }] }; },
    }),
  });
  const result = await service.discoverEndpointModels({
    client: "desktop",
    endpoint: { id: "ep-oai", type: "openai-chat", base_url: "https://api.example.com/v1" },
  });
  assert.equal(result.strategy, "openai-compatible");
  assert.equal(result.models[0].id, "glm-5.2");
});


test("codex subscription returns official models from loader", async () => {
  const service = createModelDiscoveryService({ strategies: createDefaultStrategies() });
  const result = await service.discoverEndpointModels({
    client: "codex",
    endpoint: { id: "ep-codex", type: "codex-subscription" },
    context: {
      loadCodexModels: async () => [
        { id: "gpt-5.4", name: "gpt-5.4" },
        { id: "o3", name: "o3" },
      ],
    },
  });
  assert.equal(result.strategy, "codex-subscription");
  assert.deepEqual(result.models.map((m) => m.id), ["gpt-5.4", "o3"]);
  assert.ok(!result.models.some((m) => m.id.includes("glm-") || m.id.includes("minimax") || m.id.includes("deepseek")));
});

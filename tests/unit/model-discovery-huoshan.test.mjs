import test from "node:test";
import assert from "node:assert/strict";
import { createModelDiscoveryService } from "../../lib/models/discovery-service.mjs";
import { createDefaultStrategies, huoshanArkStrategy } from "../../lib/models/strategies/index.mjs";

test("huoshan strategy wins over generic openai-compatible for ark hosts", () => {
  const strategies = createDefaultStrategies();
  const selected = strategies.find((s) => s.supports({ base_url: "https://ark.cn-beijing.volces.com/api/plan/v3" }));
  assert.equal(selected.id, "huoshan-ark");
});

test("huoshan strategy discovers models via /api/v3/models", async () => {
  const calls = [];
  const result = await huoshanArkStrategy.discover(
    { id: "ep1", base_url: "https://ark.cn-beijing.volces.com/api/coding" },
    {
      apiKey: "ark-test",
      fetchImpl: async (url, init) => {
        calls.push(url);
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
  assert.equal(calls[0], "https://ark.cn-beijing.volces.com/api/v3/models");
  assert.equal(result.models[0].id, "doubao-pro");
  assert.equal(result.strategy, "huoshan-ark");
});

test("huoshan strategy gives plan-specific message on auth failure", async () => {
  await assert.rejects(
    () => huoshanArkStrategy.discover(
      { id: "ep1", base_url: "https://ark.cn-beijing.volces.com/api/plan/v3", provider: "huoshan-agentplan" },
      {
        apiKey: "plan-key",
        fetchImpl: async () => ({ ok: false, status: 401 }),
      },
    ),
    /plan 类节点/,
  );
});

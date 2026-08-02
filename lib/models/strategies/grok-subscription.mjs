import { normalizeDiscoveredModels } from "../normalize.mjs";

export const grokSubscriptionStrategy = {
  id: "grok-subscription",
  supports(endpoint) {
    const type = String(endpoint?.type || "");
    const provider = String(endpoint?.provider || "");
    return type === "grok" || type === "grok-subscription" || provider === "grok-subscription" || provider === "grok";
  },
  async discover(endpoint, context = {}) {
    // Prefer injected remote loader (official cli-chat-proxy /v1/models).
    if (typeof context.loadGrokModels === "function") {
      const payload = await context.loadGrokModels(endpoint, context);
      return {
        source: "subscription",
        strategy: "grok-subscription",
        models: normalizeDiscoveredModels(payload),
      };
    }
    const error = new Error("Grok 模型发现器未注入");
    error.code = "strategy_dependency_missing";
    throw error;
  },
};

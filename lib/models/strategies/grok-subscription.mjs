import { normalizeDiscoveredModels } from "../normalize.mjs";

export const grokSubscriptionStrategy = {
  id: "grok-subscription",
  supports(endpoint) {
    const type = String(endpoint?.type || "");
    const provider = String(endpoint?.provider || "");
    return type === "grok" || type === "grok-subscription" || provider === "grok-subscription" || provider === "grok";
  },
  async discover(endpoint, context = {}) {
    const loadModels = context.loadGrokModels;
    if (typeof loadModels !== "function") {
      const error = new Error("Grok 模型发现器未注入");
      error.code = "strategy_dependency_missing";
      throw error;
    }
    const payload = await loadModels(endpoint, context);
    return {
      source: "subscription",
      strategy: "grok-subscription",
      models: normalizeDiscoveredModels(payload),
    };
  },
};

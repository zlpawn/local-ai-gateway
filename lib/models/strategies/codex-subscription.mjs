import { normalizeDiscoveredModels } from "../normalize.mjs";

export const codexSubscriptionStrategy = {
  id: "codex-subscription",
  supports(endpoint) {
    return endpoint?.type === "codex-subscription" || endpoint?.provider === "codex-subscription";
  },
  async discover(endpoint, context = {}) {
    const loadModels = context.loadCodexModels;
    if (typeof loadModels !== "function") {
      const error = new Error("Codex 订阅模型发现器未注入");
      error.code = "strategy_dependency_missing";
      throw error;
    }
    const payload = await loadModels(endpoint, context);
    return {
      source: "subscription",
      strategy: "codex-subscription",
      models: normalizeDiscoveredModels(payload),
    };
  },
};

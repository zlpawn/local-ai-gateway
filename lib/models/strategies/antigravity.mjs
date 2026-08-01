import { normalizeDiscoveredModels } from "../normalize.mjs";

// Antigravity model discovery is provider-specific; inject loader from server runtime.
export const antigravityStrategy = {
  id: "antigravity",
  supports(endpoint) {
    return endpoint?.type === "antigravity" || endpoint?.provider === "antigravity";
  },
  async discover(endpoint, context = {}) {
    const loadModels = context.loadAntigravityModels;
    if (typeof loadModels !== "function") {
      const error = new Error("Antigravity 模型发现器未注入");
      error.code = "strategy_dependency_missing";
      throw error;
    }
    const payload = await loadModels(endpoint, context);
    return {
      source: "subscription",
      strategy: "antigravity",
      models: normalizeDiscoveredModels(payload),
    };
  },
};

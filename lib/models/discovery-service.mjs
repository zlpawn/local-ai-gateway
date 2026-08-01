import { isCapabilityEndpoint } from "../config/gateway-config-store.mjs";
import { createModelDiscoveryCache } from "./cache.mjs";
import { createDefaultStrategies } from "./strategies/index.mjs";

export function createModelDiscoveryService({
  strategies = createDefaultStrategies(),
  cache = createModelDiscoveryCache(),
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  resolveApiKey = () => "",
} = {}) {
  return {
    async discoverEndpointModels({ client, endpoint, refresh = false, context = {} } = {}) {
      if (!endpoint?.id) {
        const error = new Error("Endpoint not found.");
        error.code = "endpoint_not_found";
        error.status = 404;
        throw error;
      }
      if (isCapabilityEndpoint(endpoint)) {
        const error = new Error("Model discovery is only supported for chat endpoints.");
        error.code = "not_chat_endpoint";
        error.status = 400;
        throw error;
      }

      const cacheKey = `${client || ""}:${endpoint.id}`;
      if (!refresh) {
        const cached = cache.get(cacheKey);
        if (cached) {
          return {
            endpoint_id: endpoint.id,
            client: client || null,
            source: "cache",
            strategy: cached.strategy,
            models: cached.models,
            fetched_at: cached.fetched_at,
            error: null,
          };
        }
      }

      const strategy = strategies.find((item) => item.supports?.(endpoint));
      if (!strategy) {
        return {
          endpoint_id: endpoint.id,
          client: client || null,
          source: null,
          strategy: null,
          models: [],
          fetched_at: now().toISOString(),
          error: {
            code: "no_discovery_source",
            message: "当前节点没有可用的模型发现来源（需要 Base URL 或订阅策略）",
          },
        };
      }

      try {
        const result = await strategy.discover(endpoint, {
          ...context,
          client,
          fetchImpl,
          apiKey: context.apiKey ?? resolveApiKey(endpoint),
        });
        const payload = {
          endpoint_id: endpoint.id,
          client: client || null,
          source: result.source || "base_url",
          strategy: result.strategy || strategy.id,
          models: Array.isArray(result.models) ? result.models : [],
          fetched_at: now().toISOString(),
          error: null,
        };
        cache.set(cacheKey, {
          strategy: payload.strategy,
          models: payload.models,
          fetched_at: payload.fetched_at,
        });
        return payload;
      } catch (error) {
        const stale = cache.getStale(cacheKey);
        return {
          endpoint_id: endpoint.id,
          client: client || null,
          source: stale ? "cache" : null,
          strategy: stale?.strategy || strategy.id,
          models: stale?.models || [],
          fetched_at: stale?.fetched_at || now().toISOString(),
          error: {
            code: error?.code || "discovery_failed",
            message: error?.message || String(error),
          },
        };
      }
    },
  };
}

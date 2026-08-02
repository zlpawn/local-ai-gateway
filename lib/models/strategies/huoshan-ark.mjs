import { normalizeDiscoveredModels } from "../normalize.mjs";

const ARK_HOST = "ark.cn-beijing.volces.com";

// Stable ARK model-list candidates. The same API key can reach both roots;
// /api/coding/v3/models and /api/v3/models are equivalent for ARK API keys.
const ARK_MODELS_CANDIDATES = [
  "https://ark.cn-beijing.volces.com/api/v3/models",
  "https://ark.cn-beijing.volces.com/api/coding/v3/models",
];

export function normalizeArkModelName(name) {
  if (!name) return "";
  let s = String(name);
  // Convert hyphens between digits to dots for Volcengine model names
  // e.g. doubao-seed-2-0-lite -> doubao-seed-2.0-lite, glm-5-2 -> glm-5.2
  s = s.replace(/([a-z0-9]+)-(\d+)-(\d+)($|-)/gi, "$1-$2.$3$4");
  s = s.replace(/([a-z]+)(\d+)-(\d+)($|-)/gi, "$1$2.$3$4");
  return s;
}

export const huoshanArkStrategy = {
  id: "huoshan-ark",
  supports(endpoint) {
    const base = String(endpoint?.base_url || "");
    return /ark\.cn-beijing\.volces\.com/i.test(base);
  },
  async discover(endpoint, context = {}) {
    const apiKey = context.apiKey || "";
    if (!apiKey) {
      const error = new Error("该火山节点未配置 API Key，无法发现模型");
      error.code = "missing_api_key";
      throw error;
    }

    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    const fetchImpl = context.fetchImpl || globalThis.fetch;

    const errors = [];
    for (const url of ARK_MODELS_CANDIDATES) {
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers,
          signal: context.signal,
        });
        if (!response.ok) {
          errors.push(`${response.status} @ ${url}`);
          continue;
        }
        const payload = await response.json();
        const models = normalizeDiscoveredModels(payload, {
          useNameAsId: true,
          transformName: normalizeArkModelName,
        });
        if (!models.length) {
          errors.push(`empty @ ${url}`);
          continue;
        }
        return {
          source: "base_url",
          strategy: "huoshan-ark",
          models,
          request_url: url,
        };
      } catch (error) {
        errors.push(error?.message || String(error));
      }
    }

    // Plan-type keys (huoshan-agentplan) cannot reach ARK /v3/models (401/404).
    // Give a clear, actionable message instead of a generic 404 list.
    const isPlan = /\/api\/plan/i.test(String(endpoint?.base_url || "")) ||
      /agentplan/i.test(String(endpoint?.provider || endpoint?.name || ""));
    const message = isPlan
      ? "火山 plan 类节点的 API Key 不支持模型列表接口（/v3/models 返回 401）。请使用 coding 类 ARK Key，或在节点上手动维护模型。"
      : `火山模型列表请求失败: ${errors.slice(0, 2).join(" | ")}`;
    const error = new Error(message);
    error.code = "upstream_http_error";
    throw error;
  },
};

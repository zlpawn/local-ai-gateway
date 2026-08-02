import { normalizeDiscoveredModels } from "../normalize.mjs";

export function buildOpenAICompatibleModelsUrl(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    let pathname = (url.pathname || "").replace(/\/+$/, "");
    // If config points at a concrete endpoint path, climb to the API root-ish path.
    pathname = pathname.replace(/\/(chat\/completions|messages|responses|embeddings)$/i, "");
    pathname = pathname.replace(/\/+$/, "");

    // Already ends with /models
    if (/\/models$/i.test(pathname)) {
      url.pathname = pathname;
      return url.toString();
    }

    // Has a version segment like /v1 /v3 /api/v3
    if (/\/v\d+$/i.test(pathname)) {
      url.pathname = `${pathname}/models`;
      return url.toString();
    }

    // Common provider roots that already imply versioned API roots.
    // e.g. https://ark.cn-beijing.volces.com/api/coding
    //      https://ark.cn-beijing.volces.com/api/plan
    if (/\/api(?:\/(?:plan|coding|agentplan))?$/i.test(pathname)) {
      url.pathname = `${pathname}/v3/models`;
      return url.toString();
    }

    // Default OpenAI-compatible fallback
    url.pathname = `${pathname}/v1/models`;
    return url.toString();
  } catch {
    const base = raw.replace(/\/+$/, "");
    if (/\/models$/i.test(base)) return base;
    if (/\/v\d+$/i.test(base)) return `${base}/models`;
    if (/\/api(?:\/(?:plan|coding|agentplan))?$/i.test(base)) return `${base}/v3/models`;
    return `${base}/v1/models`;
  }
}

export const openaiCompatibleStrategy = {
  id: "openai-compatible",
  supports(endpoint) {
    const baseUrl = String(endpoint?.base_url || "").trim();
    if (!baseUrl) return false;
    // Special subscription strategies should win first in registry order.
    return true;
  },
  async discover(endpoint, context = {}) {
    const baseUrl = String(endpoint?.base_url || "").trim();
    const url = buildOpenAICompatibleModelsUrl(baseUrl);
    if (!url) {
      const error = new Error("缺少 Base URL，无法发现模型");
      error.code = "missing_base_url";
      throw error;
    }
    const apiKey = context.apiKey || "";
    if (!apiKey && endpoint?.auth !== "none") {
      const error = new Error("该节点未配置 API Key，无法发现模型");
      error.code = "missing_api_key";
      throw error;
    }

    const headers = {
      Accept: "application/json",
      ...(context.headers || {}),
    };
    if (apiKey) {
      if ((endpoint?.auth || "bearer") === "x-api-key") headers["x-api-key"] = apiKey;
      else if ((endpoint?.auth || "bearer") !== "none") headers.Authorization = `Bearer ${apiKey}`;
    }

    const fetchImpl = context.fetchImpl || globalThis.fetch;
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: context.signal,
    });
    if (!response.ok) {
      const error = new Error(`上游模型列表请求失败 (${response.status}) @ ${url}`);
      error.code = "upstream_http_error";
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    return {
      source: "base_url",
      strategy: "openai-compatible",
      models: normalizeDiscoveredModels(payload),
      request_url: url,
    };
  },
};

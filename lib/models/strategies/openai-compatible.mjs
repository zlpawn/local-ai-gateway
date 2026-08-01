import { normalizeDiscoveredModels } from "../normalize.mjs";

export const openaiCompatibleStrategy = {
  id: "openai-compatible",
  supports(endpoint) {
    const baseUrl = String(endpoint?.base_url || "").trim();
    if (!baseUrl) return false;
    // Special subscription strategies should win first in registry order.
    return true;
  },
  async discover(endpoint, context = {}) {
    const baseUrl = String(endpoint?.base_url || "").replace(/\/+$/, "");
    if (!baseUrl) {
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

    const url = `${baseUrl}/models`.includes("/v1/") || /\/v\d+(?:\/|$)/.test(baseUrl)
      ? `${baseUrl}/models`
      : `${baseUrl}/v1/models`;

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
      const error = new Error(`上游模型列表请求失败 (${response.status})`);
      error.code = "upstream_http_error";
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    return {
      source: "base_url",
      strategy: "openai-compatible",
      models: normalizeDiscoveredModels(payload),
    };
  },
};

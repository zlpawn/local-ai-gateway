import { normalizeDiscoveredModels } from "../normalize.mjs";

export function buildOpenAICompatibleModelsUrlCandidates(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return [];
  const out = [];
  const push = (value) => {
    const v = String(value || "").trim();
    if (v && !out.includes(v)) out.push(v);
  };

  try {
    const url = new URL(raw);
    let pathname = (url.pathname || "").replace(/\/+$/, "");
    pathname = pathname.replace(/\/(chat\/completions|messages|responses|embeddings)$/i, "");
    pathname = pathname.replace(/\/+$/, "");

    const withPath = (path) => {
      const next = new URL(url.toString());
      next.pathname = path;
      next.search = "";
      next.hash = "";
      return next.toString();
    };

    if (/\/models$/i.test(pathname)) push(withPath(pathname));
    if (/\/v\d+$/i.test(pathname)) {
      push(withPath(`${pathname}/models`));
    }

    // Volcengine / Ark style roots.
    // Users may configure:
    // - https://ark.cn-beijing.volces.com/api/plan
    // - https://ark.cn-beijing.volces.com/api/coding
    // - https://ark.cn-beijing.volces.com/api/plan/v3
    // - https://ark.cn-beijing.volces.com/api/coding/v3
    if (/ark\.cn-beijing\.volces\.com$/i.test(url.hostname) || /\/api(?:\/(?:plan|coding|agentplan))?/i.test(pathname)) {
      // Prefer known-good variants first.
      if (/\/api\/coding(?:\/v\d+)?$/i.test(pathname)) {
        push(withPath("/api/coding/v3/models"));
        push(withPath("/api/coding/models"));
        push(withPath("/api/v3/models"));
      } else if (/\/api\/plan(?:\/v\d+)?$/i.test(pathname) || /\/api\/agentplan(?:\/v\d+)?$/i.test(pathname)) {
        // plan often does not expose /api/plan/v3/models; try shared api roots and coding catalog.
        push(withPath("/api/v3/models"));
        push(withPath("/api/coding/v3/models"));
        push(withPath("/api/plan/v3/models"));
        push(withPath("/api/plan/models"));
        push(withPath("/api/coding/models"));
      } else if (/\/api$/i.test(pathname)) {
        push(withPath("/api/v3/models"));
        push(withPath("/api/coding/v3/models"));
        push(withPath("/api/plan/v3/models"));
      }
    }

    // Generic OpenAI-compatible fallbacks.
    if (pathname) {
      push(withPath(`${pathname}/v1/models`));
      push(withPath(`${pathname}/models`));
      if (!/\/v\d+$/i.test(pathname)) push(withPath(`${pathname}/v3/models`));
    } else {
      push(withPath("/v1/models"));
    }
  } catch {
    const base = raw.replace(/\/+$/, "");
    push(`${base}/v1/models`);
    push(`${base}/models`);
    push(`${base}/v3/models`);
  }
  return out;
}

export function buildOpenAICompatibleModelsUrl(baseUrl) {
  return buildOpenAICompatibleModelsUrlCandidates(baseUrl)[0] || "";
}

export const openaiCompatibleStrategy = {
  id: "openai-compatible",
  supports(endpoint) {
    return Boolean(String(endpoint?.base_url || "").trim());
  },
  async discover(endpoint, context = {}) {
    const candidates = buildOpenAICompatibleModelsUrlCandidates(endpoint?.base_url);
    if (!candidates.length) {
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
    const errors = [];
    for (const url of candidates) {
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers,
          signal: context.signal,
        });
        if (!response.ok) {
          errors.push(`${response.status} @ ${url}`);
          // try next candidate on common miss / auth-scope mismatch codes
          if ([401, 403, 404, 405, 501].includes(response.status)) continue;
          const error = new Error(`上游模型列表请求失败 (${response.status}) @ ${url}`);
          error.code = "upstream_http_error";
          error.status = response.status;
          throw error;
        }
        const payload = await response.json();
        const models = normalizeDiscoveredModels(payload);
        if (!models.length) {
          errors.push(`empty @ ${url}`);
          continue;
        }
        return {
          source: "base_url",
          strategy: "openai-compatible",
          models,
          request_url: url,
          tried: candidates,
        };
      } catch (error) {
        if (error?.code === "upstream_http_error" && ![404, 405, 501].includes(error.status)) throw error;
        errors.push(error?.message || String(error));
      }
    }

    const error = new Error(`上游模型列表请求失败: ${errors.slice(0, 3).join(" | ")}`);
    error.code = "upstream_http_error";
    throw error;
  },
};

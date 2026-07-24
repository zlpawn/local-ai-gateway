const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

export const tavilyAdapter = {
  id: "tavily",
  async search(request) {
    const query = String(request.query || "").trim();
    if (!query) {
      return {
        ok: false,
        provider: "tavily",
        query,
        results: [],
        error: "Missing search query.",
      };
    }

    const options = request.options || {};
    const maxResults = clampInt(
      request.max_results ?? options.max_results ?? 5,
      1,
      20,
      5,
    );
    const body = {
      query,
      search_depth: options.search_depth || "basic",
      max_results: maxResults,
      topic: options.topic || "general",
      include_answer: options.include_answer === true,
      include_raw_content: options.include_raw_content === true,
      include_images: options.include_images === true,
    };

    const timeRange = request.time_range || options.time_range;
    if (timeRange) body.time_range = timeRange;
    if (options.country) body.country = options.country;
    if (Array.isArray(options.include_domains) && options.include_domains.length) {
      body.include_domains = options.include_domains;
    }
    if (Array.isArray(options.exclude_domains) && options.exclude_domains.length) {
      body.exclude_domains = options.exclude_domains;
    }
    if (options.chunks_per_source != null) {
      body.chunks_per_source = options.chunks_per_source;
    }

    const response = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        provider: "tavily",
        query,
        results: [],
        error: `Tavily HTTP ${response.status}: ${summarizeError(payload, text)}`,
      };
    }

    const results = Array.isArray(payload?.results)
      ? payload.results.map((item) => ({
        title: item?.title || "",
        url: item?.url || "",
        snippet: item?.content || item?.snippet || "",
        published_at: item?.published_date || item?.published_at || null,
        score: typeof item?.score === "number" ? item.score : null,
      }))
      : [];

    return {
      ok: true,
      provider: "tavily",
      query: payload?.query || query,
      answer: payload?.answer || null,
      results,
      error: null,
    };
  },
};

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function summarizeError(payload, text) {
  if (payload && typeof payload === "object") {
    return String(payload.detail || payload.error || payload.message || JSON.stringify(payload)).slice(0, 500);
  }
  return String(text || "unknown error").slice(0, 500);
}

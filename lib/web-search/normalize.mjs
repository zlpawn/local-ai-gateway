export function formatWebSearchResultForModel(result) {
  if (!result || typeof result !== "object") {
    return "Web search failed: empty provider result.";
  }

  if (result.ok === false || result.error) {
    const provider = result.provider || "unknown";
    const query = result.query || "";
    const error = result.error || result.raw_error || "unknown error";
    return [
      "Web search failed.",
      `Provider: ${provider}`,
      query ? `Query: ${query}` : null,
      `Error: ${error}`,
    ].filter(Boolean).join("\n");
  }

  const lines = [
    `Web search results for: ${result.query || ""}`,
    `Provider: ${result.provider || "unknown"}`,
  ];

  if (result.answer) {
    lines.push("", `Answer summary: ${String(result.answer).trim()}`);
  }

  const results = Array.isArray(result.results) ? result.results : [];
  if (!results.length) {
    lines.push("", "No results found.");
    return lines.join("\n");
  }

  results.forEach((item, index) => {
    lines.push("");
    lines.push(`${index + 1}. ${item.title || "(untitled)"}`);
    if (item.url) lines.push(`   ${item.url}`);
    if (item.snippet) lines.push(`   ${String(item.snippet).replace(/\s+/g, " ").trim()}`);
    if (item.published_at) lines.push(`   published: ${item.published_at}`);
  });

  return lines.join("\n");
}

export function parseWebSearchToolArguments(rawArguments) {
  let parsed = rawArguments;
  if (typeof rawArguments === "string") {
    const text = rawArguments.trim();
    if (!text) return { query: "" };
    try {
      parsed = JSON.parse(text);
    } catch {
      return { query: text };
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { query: String(rawArguments || "") };
  }

  const query = String(parsed.query || parsed.q || "").trim();
  const maxResultsRaw = parsed.max_results ?? parsed.maxResults ?? parsed.limit;
  const maxResults = Number.isFinite(Number(maxResultsRaw))
    ? Math.max(1, Math.min(10, Number(maxResultsRaw)))
    : undefined;
  const timeRange = normalizeTimeRange(parsed.time_range || parsed.timeRange);
  return {
    query,
    ...(maxResults != null ? { max_results: maxResults } : {}),
    ...(timeRange ? { time_range: timeRange } : {}),
  };
}

function normalizeTimeRange(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  if (["day", "d"].includes(text)) return "day";
  if (["week", "w"].includes(text)) return "week";
  if (["month", "m"].includes(text)) return "month";
  if (["year", "y"].includes(text)) return "year";
  return null;
}

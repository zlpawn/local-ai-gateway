/**
 * Video summary helpers for video knowledge base.
 * Prefer LLM summary via gateway chat completions, with rule-based fallback.
 */

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function stripCodeFence(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("```")) return raw;
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonObject(text) {
  const raw = stripCodeFence(text);
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function clipText(text, maxChars = 12000) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.55);
  const tail = Math.floor(maxChars * 0.35);
  return `${value.slice(0, head)}\n...\n${value.slice(-tail)}`;
}

function firstSentences(text, maxChars = 120) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  const parts = value.split(/(?<=[。！？.!?])/).map((s) => s.trim()).filter(Boolean);
  let out = "";
  for (const part of parts) {
    const next = out ? `${out}${part}` : part;
    if (next.length > maxChars && out) break;
    out = next;
    if (out.length >= Math.min(60, maxChars)) break;
  }
  return out || value.slice(0, maxChars);
}

export function buildRuleSummary({ title = "", transcript = "", description = "" } = {}) {
  const sourceText = String(transcript || description || "").replace(/\s+/g, " ").trim();
  const summaryShort = firstSentences(sourceText, 120) || String(title || "").trim() || "暂无摘要";
  const summaryFull = sourceText
    ? clipText(sourceText, 400)
    : summaryShort;
  const keyPoints = sourceText
    .split(/(?<=[。！？.!?])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
    .slice(0, 5);
  return {
    summary_short: summaryShort,
    summary_full: summaryFull,
    key_points: keyPoints,
    topics: [],
    source: sourceText ? (transcript ? "transcript-rule" : "description-rule") : "title-rule",
  };
}

export function normalizeSummaryResult(raw, fallback = {}) {
  const parsed = raw && typeof raw === "object" ? raw : {};
  const summaryShort = String(parsed.summary_short || parsed.short || fallback.summary_short || "").trim();
  const summaryFull = String(parsed.summary_full || parsed.full || fallback.summary_full || summaryShort || "").trim();
  return {
    summary_short: summaryShort || fallback.summary_short || "",
    summary_full: summaryFull || fallback.summary_full || "",
    key_points: normalizeList(parsed.key_points || parsed.points || fallback.key_points || []),
    topics: normalizeList(parsed.topics || fallback.topics || []),
    source: String(parsed.source || fallback.source || "llm"),
  };
}

/**
 * Generate a video summary through gateway chat completions.
 *
 * @param {object} params
 * @param {string} params.title
 * @param {string} params.transcript
 * @param {string} [params.description]
 * @param {string} params.client
 * @param {string} params.model
 * @param {number} params.listenPort
 * @param {number} [params.timeoutMs]
 * @param {AbortSignal} [params.signal]
 */
export async function generateVideoSummary({
  title = "",
  transcript = "",
  description = "",
  client = "code",
  model = "",
  listenPort = 8787,
  timeoutMs = 60000,
  signal = null,
} = {}) {
  const fallback = buildRuleSummary({ title, transcript, description });
  if (!model) return fallback;

  const content = clipText(
    [
      `标题: ${title || "untitled"}`,
      description ? `简介: ${String(description).slice(0, 500)}` : "",
      `转写内容:\n${transcript || "(空)"}`,
    ].filter(Boolean).join("\n\n"),
    14000,
  );

  const promptMessages = [
    {
      role: "system",
      content: [
        "你是视频知识库摘要助手。",
        "请基于给定标题与转写内容生成结构化摘要。",
        "只输出 JSON，不要输出 Markdown 或解释。",
        'JSON schema: {"summary_short":"80-120字","summary_full":"200-400字","key_points":["..."],"topics":["..."]}',
        "语言与视频内容保持一致；信息不足时基于已有内容保守概括。",
      ].join(""),
    },
    {
      role: "user",
      content,
    },
  ];

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `http://127.0.0.1:${listenPort}/${encodeURIComponent(client)}/v1/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-gateway-client": client,
      },
      body: JSON.stringify({
        model,
        messages: promptMessages,
        temperature: 0.2,
        max_tokens: 700,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[video-kb] summary LLM failed (${res.status}): ${errText.slice(0, 240)}`);
      return fallback;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = extractJsonObject(text);
    if (!parsed) {
      console.error("[video-kb] summary LLM returned non-JSON content");
      return fallback;
    }
    return normalizeSummaryResult(parsed, { ...fallback, source: "llm" });
  } catch (err) {
    if (signal?.aborted || controller.signal.aborted) throw err;
    console.error(`[video-kb] summary LLM error: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

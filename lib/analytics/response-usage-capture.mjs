function normalizeUsage(value = {}) {
  const promptTokens = Number(value.prompt_tokens ?? value.input_tokens ?? 0) || 0;
  const completionTokens = Number(value.completion_tokens ?? value.output_tokens ?? 0) || 0;
  const totalTokens = Number(value.total_tokens ?? (promptTokens + completionTokens)) || 0;
  const cacheCreation = Number(value.cache_creation_tokens ?? value.cache_creation_input_tokens ?? 0) || 0;
  const cacheRead = Number(value.cache_read_tokens ?? value.cache_read_input_tokens ?? 0) || 0;
  const cachedTokens = Number(value.prompt_tokens_details?.cached_tokens ?? 0) || 0;

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return null;
  return {
    prompt_tokens: Math.max(0, promptTokens),
    completion_tokens: Math.max(0, completionTokens),
    total_tokens: Math.max(0, totalTokens),
    cache_creation_tokens: Math.max(0, cacheCreation),
    cache_read_tokens: Math.max(0, cacheRead || cachedTokens),
  };
}

function usageFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  return normalizeUsage(payload.usage)
    || normalizeUsage(payload.response?.usage)
    || normalizeUsage(payload.message?.usage);
}

export function createResponseUsageCapture() {
  let text = "";
  let latest = null;
  let anthropicInputTokens = 0;
  let anthropicOutputTokens = 0;
  let anthropicCacheCreation = 0;
  let anthropicCacheRead = 0;

  const acceptPayload = (payload) => {
    const usage = usageFromPayload(payload);
    if (usage) latest = usage;

    if (payload?.type === "message_start" && payload.message?.usage) {
      anthropicInputTokens = Number(payload.message.usage.input_tokens || 0) || 0;
      anthropicOutputTokens = Number(payload.message.usage.output_tokens || 0) || 0;
      anthropicCacheCreation = Number(payload.message.usage.cache_creation_input_tokens || 0) || 0;
      anthropicCacheRead = Number(payload.message.usage.cache_read_input_tokens || 0) || 0;
    } else if (payload?.type === "message_delta" && payload.usage) {
      anthropicOutputTokens = Number(payload.usage.output_tokens || anthropicOutputTokens) || 0;
    }
    if (anthropicInputTokens || anthropicOutputTokens) {
      // Anthropic reports input_tokens EXCLUDING cache tokens. To match the
      // OpenAI convention (prompt_tokens = total input including cache), we
      // add cache_creation + cache_read so token-tracker's billablePrompt
      // subtraction works uniformly across providers.
      latest = {
        prompt_tokens: anthropicInputTokens + anthropicCacheCreation + anthropicCacheRead,
        completion_tokens: anthropicOutputTokens,
        total_tokens: anthropicInputTokens + anthropicOutputTokens,
        cache_creation_tokens: anthropicCacheCreation,
        cache_read_tokens: anthropicCacheRead,
      };
    }
  };

  return {
    push(chunk) {
      text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    },

    finish() {
      const trimmed = text.trim();
      if (!trimmed) return latest;

      try {
        acceptPayload(JSON.parse(trimmed));
      } catch {
        for (const line of text.split(/\r?\n/)) {
          const data = line.startsWith("data:") ? line.slice(5).trim() : "";
          if (!data || data === "[DONE]") continue;
          try {
            acceptPayload(JSON.parse(data));
          } catch {}
        }
      }
      return latest;
    },
  };
}
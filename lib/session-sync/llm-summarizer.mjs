export async function generateLLMSummary(messages, options = {}) {
  const {
    model = 'claude-haiku-4-5-20251001',
    listenPort = 8787,
    timeoutMs = 30000,
    ruleFallback = '',
    client = 'code',
  } = options;

  if (!messages || messages.length === 0) return ruleFallback;

  // Prefer real user/assistant turns; skip long injected system/runtime blobs.
  const usable = messages.filter((m) => {
    const text = String(m?.content || '');
    if (!text.trim()) return false;
    if (text.startsWith('<permissions instructions>')) return false;
    if (text.startsWith('<multi_agent_mode>')) return false;
    if (text.startsWith('<recommended_plugins>')) return false;
    if (text.startsWith('<environment_context>')) return false;
    if (text.startsWith('<skills_instructions>')) return false;
    if (text.startsWith('<app-context>')) return false;
    if (text.startsWith('You are `/root`')) return false;
    return true;
  });

  const source = usable.length > 0 ? usable : messages;
  const recentMsgs = source
    .slice(-10)
    .map((m) => `${String(m.role || 'user').toUpperCase()}: ${String(m.content).slice(0, 300)}`)
    .join('\n\n');

  const promptMessages = [
    {
      role: 'system',
      content: '你是 Cross-App Session Sync 的专业摘要生成助手。请用 1-2 句话概括以下对话的核心议题、最新进展与接下来的任务，语言精炼，控制在 100 字以内。禁止任何前言或客套话，直接输出摘要正文。'
    },
    {
      role: 'user',
      content: `以下是对话上下文：\n\n${recentMsgs}`
    }
  ];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Use a client-scoped path so model resolution can find configured endpoints.
    // Internal summary calls otherwise land on client=unknown and fall back to
    // the legacy Ark path without credentials.
    const url = `http://127.0.0.1:${listenPort}/${client}/v1/chat/completions`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gateway-client': client,
      },
      body: JSON.stringify({
        model,
        messages: promptMessages,
        max_tokens: 150,
        temperature: 0.3
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      const summaryText = data.choices?.[0]?.message?.content?.trim();
      if (summaryText) return summaryText;
    } else {
      const errText = await res.text().catch(() => '');
      console.error(`LLM summary failed (${res.status}) for model=${model}: ${errText.slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`LLM summary error for model=${model}: ${e instanceof Error ? e.message : String(e)}`);
  }

  return ruleFallback;
}

export async function generateLLMSummary(messages, options = {}) {
  const {
    model = 'claude-haiku-4-5-20251001',
    listenPort = 8787,
    timeoutMs = 5000,
    ruleFallback = ''
  } = options;

  if (!messages || messages.length === 0) return ruleFallback;

  // Take up to the last 10 messages for summary generation
  const recentMsgs = messages.slice(-10).map(m => `${m.role.toUpperCase()}: ${String(m.content).slice(0, 300)}`).join('\n\n');

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

    const res = await fetch(`http://127.0.0.1:${listenPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    }
  } catch (e) {
    // Seamless fallback to rule-based summary
  }

  return ruleFallback;
}

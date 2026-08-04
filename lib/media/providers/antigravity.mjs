const ANTIGRAVITY_API_BASE = "https://daily-cloudcode-pa.googleapis.com";

export const antigravityAdapter = {
  id: "antigravity",

  async generateImage(options, ctx) {
    const { prompt, aspectRatio, imageB64List, imageMimeTypes } = options;
    const accessToken = ctx.getApiKey ? ctx.getApiKey(ctx.endpoint) : ctx.accessToken;
    if (!accessToken) {
      throw new Error("Antigravity auth not found. Complete Antigravity subscription login.");
    }

    const model = options.model || "gemini-3.1-flash-image";
    const contents = [{ role: "user", parts: [{ text: prompt }] }];

    if (imageB64List?.length) {
      for (const [index, b64] of imageB64List.slice(0, 3).entries()) {
        contents[0].parts.push({ inline_data: { mime_type: imageMimeTypes?.[index] || "image/jpeg", data: b64 } });
      }
    }

    const url = `${ANTIGRAVITY_API_BASE}/v1internal:streamGenerateContent?alt=sse`;
    const doFetch = ctx.fetchImpl || fetch;
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        model: `models/${model}`,
        contents,
        generationConfig: {
          responseModalities: ["IMAGE"],
          ...(aspectRatio ? { aspectRatio } : {}),
        },
      }),
      signal: ctx.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Antigravity image API ${res.status}: ${text.slice(0, 300)}`);
    }

    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    for (const line of lines) {
      try {
        const chunk = JSON.parse(line.slice(6));
        const parts = chunk?.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.inline_data?.data) {
            return { b64Json: part.inline_data.data, revisedPrompt: null };
          }
        }
      } catch { /* skip unparseable lines */ }
    }
    throw new Error("Antigravity image response did not contain image data");
  },
};

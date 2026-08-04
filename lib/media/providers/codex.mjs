const CODEX_IMAGE_URL = "https://chatgpt.com/backend-api/codex/images/generations";

export const codexAdapter = {
  id: "codex-subscription",

  async generateImage(options, ctx) {
    const { prompt, size, quality } = options;
    const model = options.model || "gpt-image-2";
    const payload = {
      model,
      prompt,
      n: 1,
      size: size || "auto",
      quality: quality || "medium",
      output_format: "png",
    };
    if (Array.isArray(options.imageB64List) && options.imageB64List.length) {
      payload.input_images = options.imageB64List.map((b64, index) => ({
        image_url: `data:${options.imageMimeTypes?.[index] || "image/jpeg"};base64,${b64}`,
      }));
    }
    const accessToken = ctx.getApiKey ? ctx.getApiKey(ctx.endpoint) : ctx.accessToken;
    if (!accessToken) {
      throw new Error("Codex subscription auth not found. Sign in to Codex locally.");
    }
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.0.0",
    };
    const accountId = ctx.endpoint?.account_id || ctx.accountId || "";
    if (accountId) headers["chatgpt-account-id"] = accountId;

    const doFetch = ctx.fetchImpl || fetch;
    const res = await doFetch(CODEX_IMAGE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctx.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Codex image API ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error("Codex image response missing b64_json");
    return { b64Json: b64, revisedPrompt: data.data?.[0]?.revised_prompt || null };
  },
};

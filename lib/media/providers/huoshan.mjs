const ARK_API_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const TASKS_PATH = "/contents/generations/tasks";
const IMAGES_PATH = "/images/generations";
const TTS_API_BASE = "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional";

function arkHeaders(apiKey) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

export const huoshanAdapter = {
  id: "huoshan-agentplan",

  async generateImage(options, ctx) {
    const apiKey = ctx.getApiKey ? ctx.getApiKey(ctx.endpoint) : ctx.apiKey;
    if (!apiKey) throw new Error("Huoshan API Key not found in gateway secrets.");
    const { prompt, size, outputFormat, watermark } = options;
    const body = {
      model: options.model || "doubao-seedream-5-0-lite-260128",
      prompt,
      size: size || "2K",
      output_format: outputFormat || "png",
      response_format: "url",
      watermark: watermark === true,
    };
    if (Array.isArray(options.imageB64List) && options.imageB64List.length) {
      body.image = options.imageB64List.map((b64, index) =>
        `data:${options.imageMimeTypes?.[index] || "image/jpeg"};base64,${b64}`,
      );
    } else if (Array.isArray(options.imageUrls) && options.imageUrls.length) {
      body.image = options.imageUrls;
    }
    const res = await fetch(`${ARK_API_BASE}${IMAGES_PATH}`, {
      method: "POST", headers: arkHeaders(apiKey), body: JSON.stringify(body), signal: ctx.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Huoshan image API ${res.status}: ${data?.error?.message || ""}`);
    const items = Array.isArray(data?.data) ? data.data : [];
    if (!items.length) throw new Error("Huoshan image response missing data array");
    const item = items[0];
    if (item.url) return { url: item.url, revisedPrompt: null };
    if (item.b64_json) return { b64Json: item.b64_json, revisedPrompt: null };
    throw new Error("Huoshan image response has neither url nor b64_json");
  },

  async createVideoTask(options, ctx) {
    const apiKey = ctx.getApiKey ? ctx.getApiKey(ctx.endpoint) : ctx.apiKey;
    if (!apiKey) throw new Error("Huoshan API Key not found in gateway secrets.");
    const { prompt, ratio, duration, resolution, watermark } = options;
    const content = [{ type: "text", text: prompt }];
    if (Array.isArray(options.imageB64List)) {
      for (const [index, b64] of options.imageB64List.entries()) {
        content.push({ type: "image_url", image_url: { url: `data:${options.imageMimeTypes?.[index] || "image/jpeg"};base64,${b64}` }, role: "first_frame" });
      }
    }
    const body = {
      model: options.model || "doubao-seedance-2-0-260128",
      content,
      ...(ratio ? { ratio } : {}),
      ...(duration ? { duration } : {}),
      ...(resolution ? { resolution } : {}),
      ...(watermark ? { watermark } : {}),
    };
    const res = await fetch(`${ARK_API_BASE}${TASKS_PATH}`, {
      method: "POST", headers: arkHeaders(apiKey), body: JSON.stringify(body), signal: ctx.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Huoshan video create ${res.status}: ${data?.error?.message || ""}`);
    const taskId = data.id || data.task_id;
    if (!taskId) throw new Error("Huoshan video response missing task id");
    return { taskId };
  },

  async pollVideoTask(taskId, ctx) {
    const apiKey = ctx.getApiKey ? ctx.getApiKey(ctx.endpoint) : ctx.apiKey;
    if (!apiKey) throw new Error("Huoshan API Key not found in gateway secrets.");
    const res = await fetch(`${ARK_API_BASE}${TASKS_PATH}/${encodeURIComponent(taskId)}`, {
      method: "GET", headers: arkHeaders(apiKey), signal: ctx.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Huoshan video poll ${res.status}: ${data?.error?.message || ""}`);
    const status = data.status;
    if (status === "succeeded") {
      const videoUrl = data?.content?.video_url || data?.content?.[0]?.video_url;
      return { status: "succeeded", videoUrl, progress: 100 };
    }
    if (status === "failed") return { status: "failed", error: data?.error?.message || "Task failed" };
    return { status: "processing", progress: null };
  },

  async synthesizeSpeech(options, ctx) {
    const apiKey = ctx.getApiKey ? ctx.getApiKey(ctx.endpoint) : ctx.apiKey;
    if (!apiKey) throw new Error("Huoshan API Key not found in gateway secrets.");
    const { text, voice, encoding, speedRatio } = options;
    if (!text) throw new Error("TTS missing text to synthesize.");
    const body = {
      user: { uid: "0" },
      req_params: {
        text,
        model: options.model || "doubao-seed-tts-2.0",
        voice_type: voice || "zh_female_qingxin",
        encoding: encoding || "mp3",
        rate: 0, pitch: 0, volume: 50,
        speed_ratio: speedRatio || 1.0,
      },
    };
    const res = await fetch(TTS_API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer; ${apiKey}`,
        "X-Api-Resource-Id": "seed-tts-2.0",
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Huoshan TTS API ${res.status}: ${errText.slice(0, 300)}`);
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await res.json();
      const b64 = data?.data || data?.audio;
      if (!b64) throw new Error("Huoshan TTS JSON response missing audio data");
      return { b64Audio: b64, format: body.req_params.encoding };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { binary: buf, format: body.req_params.encoding };
  },
};

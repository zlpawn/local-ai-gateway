import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const GROK_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";

function getGrokAuthToken() {
  const authPath = process.env.GROK_AUTH_PATH || path.join(os.homedir(), ".grok", "auth.json");
  if (!fs.existsSync(authPath)) {
    throw new Error(`Grok auth not found (${authPath}). Run 'grok' to login.`);
  }
  const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
  const entry = parsed[Object.keys(parsed)[0]];
  return entry?.key || entry?.access_token || entry?.token;
}

function grokHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "User-Agent": "grok-cli/0.2.101 (macOS; arm64)",
    Accept: "application/json",
  };
}

async function grokFetch(endpoint, method, body, signal) {
  const token = getGrokAuthToken();
  const url = `${GROK_PROXY_BASE}${endpoint}`;
  const headers = { ...grokHeaders(token) };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Grok API ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

export const grokAdapter = {
  id: "grok-subscription",

  async generateImage(options, ctx) {
    const { prompt, aspectRatio, imageB64List } = options;
    const model = options.model || "grok-imagine-image-quality";
    const payload = {
      model, prompt, n: 1,
      aspect_ratio: aspectRatio || "16:9",
      resolution: "1k",
      response_format: "b64_json",
    };
    if (imageB64List?.length === 1) payload.image_b64 = imageB64List[0];
    else if (imageB64List?.length > 1) {
      payload.image_b64 = imageB64List[0];
      payload.images_b64 = imageB64List;
    }
    const res = await grokFetch("/images/generations", "POST", payload, ctx.signal);
    const b64 = res.data?.[0]?.b64_json || res.b64_json;
    if (!b64) throw new Error("Grok image response missing b64_json");
    return { b64Json: b64, revisedPrompt: null };
  },

  async createVideoTask(options, ctx) {
    const { prompt, duration, aspectRatio, imageB64List, imageMimeTypes } = options;
    const model = options.model || "grok-imagine-video-1.5-preview";
    const payload = { model, prompt, duration: duration || 6, aspect_ratio: aspectRatio || "16:9" };
    if (imageB64List?.length === 1) {
      payload.image = { url: `data:${imageMimeTypes?.[0] || "image/jpeg"};base64,${imageB64List[0]}` };
    } else if (imageB64List?.length > 1) {
      payload.images = imageB64List.map((b64, index) => ({ url: `data:${imageMimeTypes?.[index] || "image/jpeg"};base64,${b64}` }));
    }
    const res = await grokFetch("/videos/generations", "POST", payload, ctx.signal);
    const taskId = res.request_id || res.id || res.task_id;
    if (!taskId) throw new Error("Grok video response missing task id");
    return { taskId };
  },

  async pollVideoTask(taskId, ctx) {
    let res;
    try {
      res = await grokFetch(`/videos/${taskId}`, "GET", null, ctx.signal);
    } catch {
      return { status: "processing", progress: null };
    }
    const status = String(res.status || res.state || "processing").toLowerCase();
    const videoUrl = res.video_url || res.url || res.download_url || res.data?.url;
    if (["done", "completed", "success", "finished"].includes(status) && videoUrl) {
      return { status: "succeeded", videoUrl, progress: 100 };
    }
    if (["failed", "error", "cancelled"].includes(status)) {
      return { status: "failed", error: res.error || res.message || "Video generation failed" };
    }
    return { status: "processing", progress: res.progress ? Math.round(res.progress * 100) : null };
  },
};

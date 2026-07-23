import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const GROK_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";

/**
 * Format Date to YYYYMMDDHHmmss (e.g. 20260723150343)
 */
export function formatDateYYYYMMDDHHmmss(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/**
 * Clean and slugify prompt for semantic filename (max 35 chars)
 */
export function slugifyPrompt(prompt, maxLength = 35) {
  if (!prompt) return "media";
  let slug = prompt
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) slug = "media";
  if (slug.length > maxLength) {
    slug = slug.substring(0, maxLength).replace(/_+$/, "");
  }
  return slug;
}

/**
 * Generate semantic filename: grok_<slug>_<YYYYMMDDHHmmss>.<ext>
 * No "img" or "video" tags, extension identifies file type
 */
export function generateSemanticFilename(prompt, ext = "jpg", explicitFilename = null) {
  if (explicitFilename) return explicitFilename;
  const slug = slugifyPrompt(prompt);
  const dateStr = formatDateYYYYMMDDHHmmss();
  const cleanExt = ext.startsWith(".") ? ext.slice(1) : ext;
  return `grok_${slug}_${dateStr}.${cleanExt}`;
}

/**
 * Read Grok subscription Bearer JWT token from ~/.grok/auth.json
 */
export function getGrokAuthToken(authPathOverride = null) {
  const authPath = authPathOverride || path.join(os.homedir(), ".grok", "auth.json");
  if (!fs.existsSync(authPath)) {
    throw new Error(`Grok auth.json not found at ${authPath}. Please run 'grok' to sign in first.`);
  }

  const content = fs.readFileSync(authPath, "utf8");
  const parsed = JSON.parse(content);
  const keys = Object.keys(parsed);
  if (keys.length === 0) {
    throw new Error("No entries found in ~/.grok/auth.json");
  }

  const entry = parsed[keys[0]];
  const token = entry.key || entry.access_token || entry.token;
  if (!token) {
    throw new Error("No valid token key found in ~/.grok/auth.json entry");
  }
  return token;
}

/**
 * Helper for HTTP POST / GET with Grok Headers
 */
async function grokApiFetch(endpoint, method = "GET", body = null, token = null) {
  const authToken = token || getGrokAuthToken();
  const url = `${GROK_PROXY_BASE}${endpoint}`;

  const headers = {
    "Authorization": `Bearer ${authToken}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "User-Agent": "grok-cli/0.2.101 (macOS; arm64)",
    "Accept": "application/json",
  };

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Grok API Error (${res.status}): ${errText || res.statusText}`);
  }

  return res.json();
}

/**
 * Generate Image via Grok Imagine API
 */
export async function generateImage(options = {}) {
  const prompt = options.prompt || "A beautiful artwork";
  const aspectRatio = options.aspectRatio || "16:9";
  const model = options.model || "grok-imagine-image-quality";
  const outputDir = options.outputDir || path.join(process.cwd(), "images");

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const payload = {
    model,
    prompt,
    n: 1,
    aspect_ratio: aspectRatio,
    resolution: "1k",
    response_format: "b64_json",
  };

  if (options.imagePath && fs.existsSync(options.imagePath)) {
    const imgBuf = fs.readFileSync(options.imagePath);
    payload.image_b64 = imgBuf.toString("base64");
  }

  const res = await grokApiFetch("/images/generations", "POST", payload, options.token);

  let b64Data = null;
  if (res.data && res.data[0] && res.data[0].b64_json) {
    b64Data = res.data[0].b64_json;
  } else if (res.b64_json) {
    b64Data = res.b64_json;
  }

  if (!b64Data) {
    throw new Error("No b64_json data received from Grok image generation API");
  }

  const filename = generateSemanticFilename(prompt, "jpg", options.filename);
  const filePath = path.join(outputDir, filename);
  fs.writeFileSync(filePath, Buffer.from(b64Data, "base64"));

  return {
    filePath,
    filename,
    prompt,
    markdown: `![Generated Image](file://${filePath})\n\n[📁 定位文件](file://${filePath})`,
  };
}

/**
 * Generate Video via Grok Imagine Video API (Asynchronous Poll)
 */
export async function generateVideo(options = {}) {
  const prompt = options.prompt || "Atmospheric cinematic scene";
  const duration = options.duration || 6;
  const aspectRatio = options.aspectRatio || "16:9";
  const model = options.model || "grok-imagine-video-1.5-preview";
  const outputDir = options.outputDir || path.join(process.cwd(), "videos");

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const payload = {
    model,
    prompt,
    duration,
    aspect_ratio: aspectRatio,
  };

  // Support single imagePath or multi-image imagePaths
  const imagePaths = [];
  if (options.imagePath && fs.existsSync(options.imagePath)) {
    imagePaths.push(options.imagePath);
  }
  if (Array.isArray(options.imagePaths)) {
    options.imagePaths.forEach((p) => {
      if (p && fs.existsSync(p) && !imagePaths.includes(p)) {
        imagePaths.push(p);
      }
    });
  }

  if (imagePaths.length === 1) {
    const imgBuf = fs.readFileSync(imagePaths[0]);
    payload.image_b64 = imgBuf.toString("base64");
  } else if (imagePaths.length > 1) {
    payload.images_b64 = imagePaths.map((p) => fs.readFileSync(p).toString("base64"));
  }

  // 1. Submit Video Task
  const startRes = await grokApiFetch("/videos/generations", "POST", payload, options.token);
  const requestId = startRes.request_id || startRes.id;
  if (!requestId) {
    throw new Error("Failed to start video generation: missing request_id");
  }

  // 2. Poll Task Status
  const maxPolls = 60; // Up to 5 minutes
  let videoUrl = null;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await grokApiFetch(`/videos/${requestId}`, "GET", null, options.token);
    if (pollRes.status === "done" && (pollRes.video_url || pollRes.url)) {
      videoUrl = pollRes.video_url || pollRes.url;
      break;
    } else if (pollRes.status === "failed") {
      throw new Error(`Video generation failed: ${pollRes.error || "Unknown error"}`);
    }
  }

  if (!videoUrl) {
    throw new Error("Video generation timed out after 5 minutes");
  }

  // 3. Download Video Bytes
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) {
    throw new Error(`Failed to download generated video from ${videoUrl}`);
  }
  const arrayBuffer = await videoRes.arrayBuffer();
  const videoBuf = Buffer.from(arrayBuffer);

  const filename = generateSemanticFilename(prompt, "mp4", options.filename);
  const filePath = path.join(outputDir, filename);
  fs.writeFileSync(filePath, videoBuf);

  return {
    filePath,
    filename,
    prompt,
    markdown: `<video src="file://${filePath}" controls width="100%"></video>\n\n[📁 定位文件](file://${filePath})`,
  };
}

// CLI runner when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  };
  const getAllArgs = (flag) => {
    const values = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && args[i + 1]) {
        values.push(args[i + 1]);
      }
    }
    return values;
  };

  const prompt = getArg("--prompt") || "A beautiful landscape";
  const type = getArg("--type") || "image";
  const imagePath = getArg("--image");
  const rawImagesArg = getArg("--images");
  const multiImageFlags = getAllArgs("--image");

  let imagePaths = [];
  if (rawImagesArg) {
    imagePaths = rawImagesArg.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (multiImageFlags.length > 0) {
    imagePaths = multiImageFlags;
  } else if (imagePath) {
    imagePaths = [imagePath];
  }

  const aspectRatio = getArg("--aspect-ratio") || "16:9";
  const duration = parseInt(getArg("--duration")) || 6;

  console.log(`[Grok Imagine Skill] Starting ${type} generation (duration: ${duration}s, images: ${imagePaths.length})...`);
  try {
    if (type === "video") {
      const result = await generateVideo({ prompt, imagePath: imagePaths[0], imagePaths, aspectRatio, duration });
      console.log(`\nSUCCESS:\n${result.markdown}`);
    } else {
      const result = await generateImage({ prompt, imagePath: imagePaths[0], aspectRatio });
      console.log(`\nSUCCESS:\n${result.markdown}`);
    }
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    process.exit(1);
  }
}

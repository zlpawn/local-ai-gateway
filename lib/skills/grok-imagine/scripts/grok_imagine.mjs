import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

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
    throw new Error(
      `Grok 登录凭证未找到 (${authPath})。请先在终端运行 'grok' 完成登录和授权。`
    );
  }

  try {
    const content = fs.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(content);
    const keys = Object.keys(parsed);
    if (keys.length === 0) {
      throw new Error("凭证文件格式错误：~/.grok/auth.json 为空数组/对象");
    }

    const entry = parsed[keys[0]];
    const token = entry.key || entry.access_token || entry.token;
    if (!token) {
      throw new Error("凭证文件无效：未包含有效 Key/Token，请运行 'grok' 重新登录。");
    }
    return token;
  } catch (err) {
    throw new Error(`读取 Grok 凭证失败: ${err.message}`);
  }
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
    if (res.status === 401) {
      throw new Error(`[401 Unauthorized] Grok 订阅 Token 已失效。请在终端执行 'grok' 刷新登录。`);
    } else if (res.status === 422) {
      throw new Error(`[422 Unprocessable] Grok 参数错误: ${errText || res.statusText}`);
    }
    throw new Error(`Grok API 请求失败 (${res.status}): ${errText || res.statusText}`);
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

  // Collect image paths (supports single or array)
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

  if (imagePaths.length > 0) {
    // For single or multi-image edit, supply primary image_b64
    const primaryBuf = fs.readFileSync(imagePaths[0]);
    payload.image_b64 = primaryBuf.toString("base64");
  }

  const res = await grokApiFetch("/images/generations", "POST", payload, options.token);

  let b64Data = null;
  if (res.data && res.data[0] && res.data[0].b64_json) {
    b64Data = res.data[0].b64_json;
  } else if (res.b64_json) {
    b64Data = res.b64_json;
  }

  if (!b64Data) {
    throw new Error("无法获取生成的图片：Grok API 返回数据未包含 b64_json");
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
 * Generate Video via Grok Imagine Video API (Asynchronous Poll with Progress Logging)
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

  // Collect image paths (supports single or array for multi-image reference)
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
  console.log(`[Grok Imagine Video] 正在发起视频生成任务 (模型: ${model}, 时长: ${duration}s, 参考图: ${imagePaths.length}张)...`);
  const startRes = await grokApiFetch("/videos/generations", "POST", payload, options.token);
  const requestId = startRes.request_id || startRes.id;
  if (!requestId) {
    throw new Error("视频任务提交失败：响应中缺少 request_id");
  }
  console.log(`[Grok Imagine Video] 任务创建成功! Request ID: ${requestId}`);

  // 2. Poll Task Status
  const maxPolls = 60; // Up to 5 minutes
  let videoUrl = null;
  for (let i = 1; i <= maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await grokApiFetch(`/videos/${requestId}`, "GET", null, options.token);
    const status = pollRes.status || "processing";
    const progress = pollRes.progress ? `${Math.round(pollRes.progress * 100)}%` : "";

    console.log(`[Grok Imagine Video] 轮询生成进度 (${i}/${maxPolls}) - 状态: ${status} ${progress}`);

    if (status === "done" || status === "completed" || pollRes.video_url || pollRes.url) {
      videoUrl = pollRes.video_url || pollRes.url;
      console.log(`[Grok Imagine Video] 视频生成成功! 正在下载媒体文件...`);
      break;
    } else if (status === "failed") {
      throw new Error(`视频生成失败: ${pollRes.error || "未知服务端错误"}`);
    }
  }

  if (!videoUrl) {
    throw new Error("视频生成超时：在 5 分钟内未能完成，请稍后重试。");
  }

  // 3. Download Video Bytes
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) {
    throw new Error(`无法下载生成的视频文件 (HTTP ${videoRes.status}): ${videoUrl}`);
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

/**
 * Robust CLI argument parser
 */
export function parseCliArgs(args) {
  const result = {
    prompt: "A beautiful landscape",
    type: "image",
    imagePaths: [],
    aspectRatio: "16:9",
    duration: 6,
    outputDir: null,
    filename: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--prompt" && next) {
      result.prompt = next;
      i++;
    } else if (arg === "--type" && next) {
      result.type = next;
      i++;
    } else if ((arg === "--image" || arg === "--images") && next) {
      const parts = next.split(",").map((s) => s.trim()).filter(Boolean);
      parts.forEach((p) => {
        if (!result.imagePaths.includes(p)) result.imagePaths.push(p);
      });
      i++;
    } else if (arg === "--aspect-ratio" && next) {
      result.aspectRatio = next;
      i++;
    } else if (arg === "--duration" && next) {
      result.duration = parseInt(next, 10) || 6;
      i++;
    } else if (arg === "--output-dir" && next) {
      result.outputDir = next;
      i++;
    } else if (arg === "--filename" && next) {
      result.filename = next;
      i++;
    }
  }

  return result;
}

// Robust CLI runner when executed directly
const currentFilePath = fileURLToPath(import.meta.url);
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (currentFilePath === executedFilePath) {
  const parsedArgs = parseCliArgs(process.argv.slice(2));

  console.log(
    `[Grok Imagine Skill] 开始执行 ${parsedArgs.type} 生成 (时长: ${parsedArgs.duration}s, 参考图数量: ${parsedArgs.imagePaths.length})...`
  );

  try {
    if (parsedArgs.type === "video") {
      const result = await generateVideo({
        prompt: parsedArgs.prompt,
        imagePath: parsedArgs.imagePaths[0],
        imagePaths: parsedArgs.imagePaths,
        aspectRatio: parsedArgs.aspectRatio,
        duration: parsedArgs.duration,
        outputDir: parsedArgs.outputDir,
        filename: parsedArgs.filename,
      });
      console.log(`\nSUCCESS:\n${result.markdown}`);
    } else {
      const result = await generateImage({
        prompt: parsedArgs.prompt,
        imagePath: parsedArgs.imagePaths[0],
        imagePaths: parsedArgs.imagePaths,
        aspectRatio: parsedArgs.aspectRatio,
        outputDir: parsedArgs.outputDir,
        filename: parsedArgs.filename,
      });
      console.log(`\nSUCCESS:\n${result.markdown}`);
    }
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    process.exit(1);
  }
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const GROK_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";

/**
 * Print CLI Help Instructions
 */
export function printHelp() {
  console.log(`
🎨 Grok Imagine Multi-Modal Skill CLI Tool

用法 (Usage):
  node grok_imagine.mjs [options]

选项 (Options):
  --prompt <string>        提示词 (默认: "A beautiful artwork")
  --type <image|video>     生成类型: image (生图) 或 video (生视频) (默认: "image")
  --image <path>           参考图片路径 (支持多次指定或逗号分隔多图)
  --images <path1,path2>   多张参考图片路径 (逗号分隔)
  --aspect-ratio <ratio>   宽高比, 例如 "16:9", "9:16", "1:1" (默认: "16:9")
  --duration <seconds>     视频时长(秒), 仅在 --type video 时生效 (默认: 6)
  --check-status <id>      通过已有的 Request ID 轮询并恢复下载先前发起的视频任务
  --output-dir <path>      媒体输出目录 (默认: ./images 或 ./videos)
  --filename <name>        显式指定输出文件名
  --dry-run                预检模式：校验凭证与参数，打印请求 Payload 但不触发 API 扣费
  --help, -h               显示此帮助文档

示例 (Examples):
  # 文生图
  node grok_imagine.mjs --prompt "赛博朋克风未来城市" --aspect-ratio "16:9"

  # 多图参考生视频
  node grok_imagine.mjs --type video --prompt "多图渐变过渡" --images "start.jpg,end.jpg" --duration 6

  # 任务恢复/查状态
  node grok_imagine.mjs --check-status "req_123456789"
`);
}

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
 * Helper for HTTP POST / GET with Grok Headers & Timeout / Retries
 */
async function grokApiFetch(endpoint, method = "GET", body = null, token = null, timeoutMs = 30000) {
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

  let lastErr = null;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if (res.status === 401) {
          throw new Error(`[401 Unauthorized] Grok 订阅 Token 已失效。请在终端执行 'grok' 刷新登录。`);
        } else if (res.status === 422) {
          throw new Error(`[422 Unprocessable] Grok 参数错误: ${errText || res.statusText}`);
        }
        throw new Error(`Grok API 请求失败 (${res.status}): ${errText || res.statusText}`);
      }

      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err.name === "AbortError") {
        lastErr = new Error(`请求超时 (${timeoutMs / 1000}s): ${url}`);
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  throw lastErr;
}

/**
 * Deep search helper to find video URL in arbitrary API response structures
 */
function extractVideoUrl(res) {
  if (!res) return null;
  if (typeof res === "string" && res.startsWith("http")) return res;

  const candidates = [
    res.video_url,
    res.url,
    res.download_url,
    res.videoUrl,
    res.video?.url,
    res.video?.video_url,
    res.result?.url,
    res.result?.video_url,
    res.data?.url,
    res.data?.video_url,
  ];

  for (const cand of candidates) {
    if (typeof cand === "string" && cand.startsWith("http")) {
      return cand;
    }
  }

  if (Array.isArray(res.data) && res.data.length > 0) {
    const item = res.data[0];
    if (typeof item === "string" && item.startsWith("http")) return item;
    if (item?.url) return item.url;
    if (item?.video_url) return item.video_url;
  }

  return null;
}

/**
 * Generate Image via Grok Imagine API (Supports true multi-image reference)
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

  if (imagePaths.length === 1) {
    const primaryBuf = fs.readFileSync(imagePaths[0]);
    payload.image_b64 = primaryBuf.toString("base64");
  } else if (imagePaths.length > 1) {
    const b64List = imagePaths.map((p) => fs.readFileSync(p).toString("base64"));
    payload.image_b64 = b64List[0]; // Fallback compatibility
    payload.images_b64 = b64List;   // Full multi-image array payload
  }

  if (options.dryRun) {
    console.log(`[DRY-RUN] Grok Image Payload:\n${JSON.stringify({ ...payload, image_b64: payload.image_b64 ? "<b64_data>" : undefined, images_b64: payload.images_b64 ? payload.images_b64.map(() => "<b64_data>") : undefined }, null, 2)}`);
    return {
      filePath: path.join(outputDir, generateSemanticFilename(prompt, "jpg", options.filename)),
      filename: generateSemanticFilename(prompt, "jpg", options.filename),
      prompt,
      markdown: `![Generated Image (DRY-RUN)](${path.join(outputDir, generateSemanticFilename(prompt, "jpg", options.filename))})`,
    };
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

  const absPath = path.resolve(filePath);
  const fileUrl = `file://${absPath}`;

  return {
    filePath: absPath,
    filename,
    prompt,
    markdown: `![Generated Image](${absPath})\n\n[📁 定位文件](${fileUrl})`,
  };
}

/**
 * Check or Resume Video Task by Request ID
 */
export async function checkAndDownloadVideo(requestId, options = {}) {
  const prompt = options.prompt || "Resumed video task";
  const outputDir = options.outputDir || path.join(process.cwd(), "videos");

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`[Grok Imagine Video] 正在查询任务 Request ID: ${requestId}...`);
  const maxPolls = 60;
  let videoUrl = null;

  for (let i = 1; i <= maxPolls; i++) {
    let pollRes = null;
    try {
      pollRes = await grokApiFetch(`/videos/${requestId}`, "GET", null, options.token);
    } catch (err) {
      console.warn(`[Grok Imagine Video] 轮询第 ${i} 次短暂停顿警告: ${err.message}，正在继续重试...`);
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }

    const rawStatus = (pollRes.status || pollRes.state || pollRes.task_status || "processing").toString().toLowerCase();
    const progress = pollRes.progress ? `${Math.round(pollRes.progress * 100)}%` : "";
    const extractedUrl = extractVideoUrl(pollRes);

    console.log(`[Grok Imagine Video] 轮询进度 (${i}/${maxPolls}) [ID: ${requestId}] - 状态: ${rawStatus} ${progress}`);

    // Robust Completion Check: Match status OR presence of playable URL
    const isCompleted =
      extractedUrl !== null ||
      ["done", "completed", "success", "successful", "finished"].includes(rawStatus);

    if (isCompleted && extractedUrl) {
      videoUrl = extractedUrl;
      console.log(`[Grok Imagine Video] 视频就绪! 开始下载媒体...`);
      break;
    } else if (["failed", "error", "cancelled"].includes(rawStatus)) {
      throw new Error(`[RequestID: ${requestId}] 视频生成失败: ${pollRes.error || pollRes.message || "服务端处理失败"}`);
    }

    await new Promise((r) => setTimeout(r, 4000));
  }

  if (!videoUrl) {
    throw new Error(`[RequestID: ${requestId}] 轮询超时，视频仍未准备就绪。您可稍后继续运行 --check-status "${requestId}" 查验。`);
  }

  // Download Video Bytes with retry & timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000); // 60s download timeout
  const videoRes = await fetch(videoUrl, { signal: controller.signal }).finally(() => clearTimeout(timer));

  if (!videoRes.ok) {
    throw new Error(`无法下载生成的视频 (HTTP ${videoRes.status}): ${videoUrl}`);
  }
  const arrayBuffer = await videoRes.arrayBuffer();
  const videoBuf = Buffer.from(arrayBuffer);

  const filename = generateSemanticFilename(prompt, "mp4", options.filename);
  const filePath = path.join(outputDir, filename);
  fs.writeFileSync(filePath, videoBuf);

  const absPath = path.resolve(filePath);
  const fileUrl = `file://${absPath}`;

  return {
    filePath: absPath,
    filename,
    prompt,
    markdown: `<video src="${absPath}" controls width="100%"></video>\n\n[📁 定位文件](${fileUrl})`,
  };
}

/**
 * Generate Video via Grok Imagine Video API
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

  // Collect image paths
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

  let baseImageMarkdown = "";

  // Two-stage pipeline: If model requires an image for text-to-video, generate base image first
  if (imagePaths.length === 0 && !options.dryRun) {
    console.log(`[Grok Imagine Video] 视频模型 ${model} 需首帧图像，正在自动执行第一阶段文生图...`);
    try {
      const imgRes = await generateImage({
        prompt,
        aspectRatio,
        outputDir: path.join(process.cwd(), "images"),
        token: options.token,
      });
      imagePaths.push(imgRes.filePath);
      baseImageMarkdown = `### 🖼️ 第一阶段 (首帧基准图)\n${imgRes.markdown}\n\n### 🎬 第二阶段 (动态视频)\n`;
      console.log(`[Grok Imagine Video] 第一阶段文生图就绪: ${imgRes.filePath}`);
    } catch (err) {
      throw new Error(`第一阶段首帧图生成失败: ${err.message}`);
    }
  }

  const payload = {
    model,
    prompt,
    duration,
    aspect_ratio: aspectRatio,
  };

  if (imagePaths.length === 1) {
    const imgBuf = fs.readFileSync(imagePaths[0]);
    const b64 = imgBuf.toString("base64");
    const mime = imagePaths[0].endsWith(".png") ? "image/png" : "image/jpeg";
    payload.image = { url: `data:${mime};base64,${b64}` };
  } else if (imagePaths.length > 1) {
    payload.images = imagePaths.map((p) => {
      const imgBuf = fs.readFileSync(p);
      const b64 = imgBuf.toString("base64");
      const mime = p.endsWith(".png") ? "image/png" : "image/jpeg";
      return { url: `data:${mime};base64,${b64}` };
    });
  }

  if (options.dryRun) {
    console.log(`[DRY-RUN] Grok Video Payload:\n${JSON.stringify({ ...payload, image: payload.image ? { url: "<data_uri>" } : undefined, images: payload.images ? payload.images.map(() => ({ url: "<data_uri>" })) : undefined }, null, 2)}`);
    return {
      filePath: path.join(outputDir, generateSemanticFilename(prompt, "mp4", options.filename)),
      filename: generateSemanticFilename(prompt, "mp4", options.filename),
      prompt,
      markdown: `<video src="${path.join(outputDir, generateSemanticFilename(prompt, "mp4", options.filename))}" controls width="100%"></video>`,
    };
  }

  // 1. Submit Video Task
  console.log(`[Grok Imagine Video] 正在发起视频生成任务 (模型: ${model}, 时长: ${duration}s, 参考图: ${imagePaths.length}张)...`);
  const startRes = await grokApiFetch("/videos/generations", "POST", payload, options.token);

  // Deep extract request ID to prevent undefined URL
  const requestId = startRes.request_id || startRes.id || startRes.task_id || startRes.data?.id || startRes.data?.request_id;
  if (!requestId) {
    throw new Error(`视频任务提交失败：服务端响应缺少 request_id (响应: ${JSON.stringify(startRes)})`);
  }
  console.log(`[Grok Imagine Video] 任务创建成功! Request ID: "${requestId}"`);

  // 2. Poll Task Status via checkAndDownloadVideo helper
  try {
    const result = await checkAndDownloadVideo(requestId, { ...options, prompt, outputDir });
    if (baseImageMarkdown) {
      result.markdown = `${baseImageMarkdown}${result.markdown}`;
    }
    return result;
  } catch (err) {
    throw new Error(`${err.message} [恢复提示: 您稍后可以通过 --check-status "${requestId}" 恢复查询与下载]`);
  }
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
    checkStatus: null,
    outputDir: null,
    filename: null,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--prompt" && next) {
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
    } else if (arg === "--check-status" && next) {
      result.checkStatus = next;
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

  if (parsedArgs.help) {
    printHelp();
    process.exit(0);
  }

  if (parsedArgs.checkStatus) {
    try {
      const result = await checkAndDownloadVideo(parsedArgs.checkStatus, {
        prompt: parsedArgs.prompt,
        outputDir: parsedArgs.outputDir,
        filename: parsedArgs.filename,
      });
      console.log(`\nSUCCESS:\n${result.markdown}`);
      process.exit(0);
    } catch (err) {
      console.error(`\nERROR: ${err.message}`);
      process.exit(1);
    }
  }

  console.log(
    `[Grok Imagine Skill] 开始执行 ${parsedArgs.type} 生成 (时长: ${parsedArgs.duration}s, 参考图: ${parsedArgs.imagePaths.length}张, dryRun: ${parsedArgs.dryRun})...`
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
        dryRun: parsedArgs.dryRun,
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
        dryRun: parsedArgs.dryRun,
      });
      console.log(`\nSUCCESS:\n${result.markdown}`);
    }
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    process.exit(1);
  }
}

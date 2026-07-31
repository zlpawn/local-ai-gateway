import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const ARK_API_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const TASKS_PATH = "/contents/generations/tasks";
const DEFAULT_VIDEO_MODEL = "doubao-seedance-2-0-260128";

// Endpoint name whose stored key the skill reuses for media generation.
// The gateway stores one key per endpoint id in gateway.secrets.json under
// api_keys[id]; multiple endpoints share the name "huoshan-agentplan" and the
// same Ark key, so matching by name is stable across config migrations.
const GATEWAY_ENDPOINT_NAME = "huoshan-agentplan";

/**
 * Resolve the gateway data dir, mirroring lib/cli/init-config.mjs
 * detectDefaultDataDir: GATEWAY_DATA_DIR > source repo cwd > ~/.shrimp.
 */
function resolveGatewayDataDir() {
  if (process.env.GATEWAY_DATA_DIR) return process.env.GATEWAY_DATA_DIR;
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, ".git"))) return cwd;
  return path.join(os.homedir(), ".shrimp");
}

/**
 * Resolve the Ark API key. Precedence:
 *   1. explicit --api-key param
 *   2. ARK_API_KEY env var
 *   3. the key stored for the "huoshan-agentplan" endpoint in the gateway
 *      secrets file (gateway.secrets.json -> api_keys[id]), looked up by
 *      matching the endpoint name in gateway.config.json. This lets the skill
 *      reuse the gateway's configured Ark credential with zero extra setup.
 */
export function resolveApiKey(explicit) {
  if (explicit) return explicit;
  // Node coerces process.env.X = undefined into the string "undefined"; treat
  // empty / "undefined" as unset so a leaky test or shell restore cannot mask
  // the gateway secrets lookup.
  const envKey = String(process.env.ARK_API_KEY || "").trim();
  if (envKey && envKey !== "undefined") return envKey;

  try {
    const dataDir = resolveGatewayDataDir();
    const secretsPath = path.join(dataDir, "gateway.secrets.json");
    const configPath = path.join(dataDir, "gateway.config.json");
    if (!fs.existsSync(secretsPath) || !fs.existsSync(configPath)) return "";

    const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf-8"));
    const apiKeys = secrets?.api_keys || {};
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    // Find endpoint ids whose name matches the target, across all clients.
    const clients = config?.clients || {};
    for (const client of Object.values(clients)) {
      const endpoints = Array.isArray(client?.endpoints) ? client.endpoints : [];
      for (const ep of endpoints) {
        if (ep?.name === GATEWAY_ENDPOINT_NAME && ep?.id && apiKeys[ep.id]) {
          return String(apiKeys[ep.id]);
        }
      }
    }
  } catch {
    // missing / corrupt config or secrets is non-fatal
  }
  return "";
}

export function formatDateYYYYMMDDHHmmss(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

export function slugifyPrompt(prompt, maxLength = 35) {
  if (!prompt) return "media";
  let slug = prompt
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) slug = "media";
  if (slug.length > maxLength) slug = slug.substring(0, maxLength).replace(/_+$/, "");
  return slug;
}

export function generateSemanticFilename(prompt, ext = "mp4", explicitFilename = null) {
  if (explicitFilename) return explicitFilename;
  const slug = slugifyPrompt(prompt);
  const cleanExt = ext.startsWith(".") ? ext.slice(1) : ext;
  return `volcano_${slug}_${formatDateYYYYMMDDHHmmss()}.${cleanExt}`;
}

export async function downloadMediaFile(url, targetPath) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(targetPath, buf);
      return targetPath;
    }
  } catch (err) {
    console.warn(`[Huoshan Media Download] fetch 受限 (${err.message})，尝试 curl 回退...`);
  }
  try {
    const escapedUrl = url.replace(/"/g, '\\"');
    const escapedTarget = targetPath.replace(/"/g, '\\"');
    execSync(`curl -sSL --connect-timeout 15 -m 180 "${escapedUrl}" -o "${escapedTarget}"`);
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) return targetPath;
  } catch (curlErr) {
    throw new Error(`curl 下载失败 (${url}): ${curlErr.message}`);
  }
  throw new Error(`无法下载媒体文件 (${url}): 响应为空`);
}

function arkHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

export function buildVideoContent(prompt, imagePaths = []) {
  const content = [{ type: "text", text: prompt }];
  if (Array.isArray(imagePaths)) {
    for (const imgPath of imagePaths) {
      if (!imgPath || !fs.existsSync(imgPath)) continue;
      const buf = fs.readFileSync(imgPath);
      const b64 = buf.toString("base64");
      const mime = imgPath.endsWith(".png") ? "image/png" : "image/jpeg";
      const role = content.filter((c) => c.type === "image_url").length === 0 ? "first_frame" : "reference_image";
      content.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${b64}` },
        role,
      });
    }
  }
  return content;
}

export async function createVideoTask(options = {}) {
  const apiKey = resolveApiKey(options.apiKey);
  if (!apiKey) {
    throw new Error("未找到 ARK_API_KEY。请在 .env / gateway.secrets.json 中配置或通过 --api-key 传入。");
  }

  const model = options.model || DEFAULT_VIDEO_MODEL;
  const prompt = options.prompt || "电影感镜头，海浪拍打沙滩，夕阳余晖";
  const content = buildVideoContent(prompt, options.imagePaths || []);

  const body = {
    model,
    content,
    ratio: options.ratio || "16:9",
    duration: options.duration != null ? options.duration : 5,
    resolution: options.resolution || "720p",
    watermark: options.watermark === true,
    generate_audio: options.generateAudio !== false,
  };
  if (options.seed != null) body.seed = options.seed;
  if (options.callbackUrl) body.callback_url = options.callbackUrl;

  if (options.dryRun) {
    const redacted = {
      ...body,
      content: body.content.map((c) =>
        c.type === "image_url" ? { ...c, image_url: { url: "<data_uri>" } } : c,
      ),
    };
    console.log(`[DRY-RUN] 创建视频任务 Payload:\n${JSON.stringify(redacted, null, 2)}`);
    return { id: "dry-run", body: redacted };
  }

  const res = await fetch(`${ARK_API_BASE}${TASKS_PATH}`, {
    method: "POST",
    headers: arkHeaders(apiKey),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
    throw new Error(`创建视频任务失败: ${msg}`);
  }
  const taskId = data.id || data.task_id || data?.data?.id;
  if (!taskId) throw new Error(`服务端响应缺少任务 ID: ${JSON.stringify(data)}`);
  return { id: taskId, raw: data };
}

export async function getVideoTask(taskId, options = {}) {
  const apiKey = resolveApiKey(options.apiKey);
  if (!apiKey) throw new Error("未找到 ARK_API_KEY。");
  const res = await fetch(`${ARK_API_BASE}${TASKS_PATH}/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: arkHeaders(apiKey),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`查询视频任务失败 (${taskId}): ${msg}`);
  }
  return data;
}

export async function generateVideo(options = {}) {
  const prompt = options.prompt || "电影感镜头";
  const outputDir = options.outputDir || path.join(process.cwd(), "videos");
  fs.mkdirSync(outputDir, { recursive: true });

  let taskId = options.taskId;
  if (!taskId) {
    console.log(`[Huoshan Video] 创建任务 (模型 ${options.model || DEFAULT_VIDEO_MODEL})...`);
    const created = await createVideoTask(options);
    taskId = created.id;
    if (options.dryRun) return created;
    console.log(`[Huoshan Video] 任务已创建 ID: ${taskId}`);
  }

  const maxAttempts = options.maxAttempts || 120;
  const intervalMs = options.intervalMs || 5000;
  for (let i = 0; i < maxAttempts; i++) {
    const task = await getVideoTask(taskId, { apiKey: options.apiKey });
    const status = task.status;
    console.log(`[Huoshan Video] 轮询 ${i + 1}/${maxAttempts} status=${status}`);
    if (status === "succeeded") {
      const videoUrl = task?.content?.video_url || task?.content?.[0]?.video_url;
      if (!videoUrl) throw new Error(`任务成功但缺少 content.video_url: ${JSON.stringify(task)}`);
      const filename = generateSemanticFilename(prompt, "mp4", options.filename);
      const filePath = path.join(outputDir, filename);
      await downloadMediaFile(videoUrl, filePath);
      const abs = path.resolve(filePath);
      const fileUrl = `file://${abs}`;
      return {
        filePath: abs,
        filename,
        prompt,
        taskId,
        markdown: `![Generated Video](${abs})\n\n[▶️ 播放视频](${fileUrl}) | [📁 打开文件](${fileUrl})`,
      };
    }
    if (status === "failed") {
      const emsg = task?.error?.message || "任务失败";
      throw new Error(`视频任务失败: ${emsg} [恢复: --check-status ${taskId}]`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`轮询超时，任务仍未完成。稍后运行 --check-status "${taskId}" 恢复查询下载。`);
}

// ---------------------------------------------------------------------------
// Image generation (Doubao Seedream, synchronous images/generations API)
//   POST https://ark.cn-beijing.volces.com/api/v3/images/generations
// Synchronous (not an async task): the response carries data[].url directly,
// so there is nothing to poll - just download each returned image.
// ---------------------------------------------------------------------------

const IMAGES_PATH = "/images/generations";
const DEFAULT_IMAGE_MODEL = "doubao-seedream-5-0-lite-260128";

/**
 * Build the Seedream image-generation request body. Reference images are passed
 * as a top-level `image` array (URLs or data URIs); prompt/size/output_format/
 * response_format/watermark mirror the documented contract.
 */
export function buildImageBody(options = {}) {
  const prompt = options.prompt || "A beautiful artwork";
  const body = {
    model: options.model || DEFAULT_IMAGE_MODEL,
    prompt,
    size: options.size || "2K",
    output_format: options.outputFormat || "png",
    response_format: options.responseFormat || "url",
    watermark: options.watermark === true,
  };
  if (Array.isArray(options.imageUrls) && options.imageUrls.length > 0) {
    body.image = options.imageUrls;
  }
  if (options.sequentialImageGeneration) {
    body.sequential_image_generation = options.sequentialImageGeneration;
  }
  return body;
}

/**
 * Generate one or more images via the Seedream images/generations API and
 * download each to disk. Returns { files, markdown } where files is an array
 * of { filePath, filename } and markdown renders every image.
 */
export async function generateImage(options = {}) {
  const apiKey = resolveApiKey(options.apiKey);
  if (!apiKey) {
    throw new Error("未找到 ARK_API_KEY。请在 .env / gateway.secrets.json 中配置或通过 --api-key 传入。");
  }

  const prompt = options.prompt || "A beautiful artwork";
  const body = buildImageBody(options);

  if (options.dryRun) {
    console.log(`[DRY-RUN] 图片生成 Payload:\n${JSON.stringify(body, null, 2)}`);
    return { body };
  }

  const res = await fetch(`${ARK_API_BASE}${IMAGES_PATH}`, {
    method: "POST",
    headers: arkHeaders(apiKey),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
    throw new Error(`图片生成失败: ${msg}`);
  }

  const items = Array.isArray(data?.data) ? data.data : [];
  if (items.length === 0) {
    throw new Error(`图片生成成功但响应缺少 data 数组: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const outputDir = options.outputDir || path.join(process.cwd(), "images");
  fs.mkdirSync(outputDir, { recursive: true });
  const ext = body.output_format || "png";
  const files = [];
  const markdownParts = [];

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const suffix = items.length > 1 ? `_${idx + 1}` : "";
    const filename = generateSemanticFilename(prompt, ext, options.filename ? options.filename.replace(/\.(png|jpe?g)$/i, "") + suffix + "." + ext : null);
    const filePath = path.join(outputDir, filename);

    if (body.response_format === "b64_json" && item.b64_json) {
      fs.writeFileSync(filePath, Buffer.from(item.b64_json, "base64"));
    } else if (item.url) {
      await downloadMediaFile(item.url, filePath);
    } else if (item.b64_json) {
      fs.writeFileSync(filePath, Buffer.from(item.b64_json, "base64"));
    } else {
      throw new Error(`图片 ${idx + 1} 既无 url 也无 b64_json: ${JSON.stringify(item).slice(0, 200)}`);
    }

    const abs = path.resolve(filePath);
    const fileUrl = `file://${abs}`;
    files.push({ filePath: abs, filename });
    markdownParts.push(`![Generated Image](${abs})\n\n[📁 打开文件](${fileUrl})`);
  }

  return { files, markdown: markdownParts.join("\n\n---\n\n") };
}

// ---------------------------------------------------------------------------
// Text-to-speech (Doubao Seed TTS 2.0 HTTP one-shot)
//   POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional
// Auth: the speech service lives on the openspeech host and uses the
// X-Api-Resource-Id header (seed-tts-2.0) plus the Ark API key. The HTTP
// one-shot endpoint returns the full audio body in a single response, which
// keeps the dependency surface to fetch only (no websocket binary protocol).
// ---------------------------------------------------------------------------

const TTS_API_BASE = "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional";
const DEFAULT_TTS_MODEL = "doubao-seed-tts-2.0";
const DEFAULT_TTS_VOICE = "zh_female_qingxin";

/**
 * Build the Seed TTS 2.0 HTTP request body. The req_params envelope (text,
 * voice_type, encoding, rate, pitch, volume, speed_ratio) follows the Seed TTS
 * contract; numeric ranges match the documented defaults.
 */
export function buildTtsBody(options = {}) {
  const text = options.text || options.prompt || "";
  if (!text) throw new Error("TTS 缺少待合成文本。请通过 --text 传入。");
  const body = {
    user: { uid: "0" },
    req_params: {
      text,
      model: options.model || DEFAULT_TTS_MODEL,
      voice_type: options.voice || options.voiceType || DEFAULT_TTS_VOICE,
      encoding: options.encoding || "mp3",
      rate: options.rate != null ? options.rate : 0,
      pitch: options.pitch != null ? options.pitch : 0,
      volume: options.volume != null ? options.volume : 50,
      speed_ratio: options.speedRatio || 1.0,
    },
  };
  if (options.audioFormat) body.req_params.audio_format = options.audioFormat;
  if (options.sampleRate) body.req_params.sample_rate = options.sampleRate;
  return body;
}

/**
 * Synthesize speech via the Seed TTS 2.0 HTTP one-shot endpoint and write the
 * audio to disk. Returns { filePath, filename, text, markdown }.
 *
 * The endpoint returns raw audio bytes on success; some deployments wrap the
 * audio in a JSON envelope (base64 in a data field) - both shapes are handled.
 */
export async function synthesizeSpeech(options = {}) {
  const apiKey = resolveApiKey(options.apiKey);
  if (!apiKey) throw new Error("未找到 ARK_API_KEY。");

  const body = buildTtsBody(options);
  const resourceId = options.resourceId || "seed-tts-2.0";

  if (options.dryRun) {
    console.log(`[DRY-RUN] TTS Payload:\n${JSON.stringify(body, null, 2)}`);
    return { body };
  }

  const res = await fetch(TTS_API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer; ${apiKey}`,
      "X-Api-Resource-Id": resourceId,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`TTS 请求失败 HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }

  const contentType = res.headers.get("content-type") || "";
  const text2 = options.text || options.prompt || "tts";
  const ext = body.req_params.encoding || "mp3";
  const outputDir = options.outputDir || path.join(process.cwd(), "audios");
  fs.mkdirSync(outputDir, { recursive: true });
  const filename = generateSemanticFilename(text2, ext, options.filename);
  const filePath = path.join(outputDir, filename);

  if (contentType.includes("application/json")) {
    const data = await res.json().catch(() => ({}));
    const b64 = data?.data || data?.audio || data?.audio_data;
    if (!b64) {
      throw new Error(`TTS 响应为 JSON 但未找到音频数据: ${JSON.stringify(data).slice(0, 300)}`);
    }
    fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buf);
  }

  const abs = path.resolve(filePath);
  const fileUrl = `file://${abs}`;
  return {
    filePath: abs,
    filename,
    text: text2,
    markdown: `🔊 [播放语音](${fileUrl}) | [📁 打开文件](${fileUrl})`,
  };
}

export function printHelp() {
  console.log(`
🌋 Huoshan Imagine Skill CLI (火山引擎视频生成 + 文本转语音)

用法 (Usage):
  node leo_huoshan_imagine.mjs <command> [options]

命令 (Commands):
  video        文生视频 / 图生视频 (Seedance 2.0 异步任务)
  image        文生图 / 图文生图 / 多图融合 (Seedream 同步生成)
  --check-status <id>   通过任务 ID 恢复轮询并下载先前发起的视频任务
  tts          文本转语音 (Doubao Seed TTS 2.0 HTTP 一次性合成)

视频选项 (video):
  --prompt <string>        视频提示词
  --image <path>           参考图片路径 (可多次指定或逗号分隔)
  --images <p1,p2>         多张参考图片 (逗号分隔)
  --ratio <ratio>          宽高比 16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9 (默认 16:9)
  --duration <seconds>     时长 4~15 秒 (默认 5)
  --resolution <res>       480p / 720p / 1080p / 4k (默认 720p)
  --model <id>             模型 ID (默认 doubao-seedance-2-0-260128)
  --no-audio               关闭视频配乐
  --watermark              生成水印

图片选项 (image):
  --prompt <string>        图片提示词
  --image-url <url>        参考图片 URL (可多次指定或逗号分隔)
  --image-urls <u1,u2>     多张参考图片 URL (逗号分隔)
  --size <size>            输出尺寸 1K/2K/4K 或 2048x2048 (默认 2K)
  --output-format <fmt>    png / jpeg (默认 png)
  --response-format <fmt>  url / b64_json (默认 url)
  --watermark              添加水印

TTS 选项 (tts):
  --text <string>          待合成文本
  --voice <voice_type>     音色 ID (默认 zh_female_qingxin)
  --encoding <fmt>         mp3 / wav / ogg_opus / pcm (默认 mp3)
  --speed-ratio <float>    语速 (默认 1.0)

通用 (Common):
  --api-key <key>          覆盖 ARK_API_KEY
  --output-dir <path>      输出目录 (默认 ./videos)
  --filename <name>        指定输出文件名
  --dry-run                预检模式，打印 Payload 不调用 API
  --help, -h               显示此帮助

示例 (Examples):
  # 文生视频
  node leo_huoshan_imagine.mjs video --prompt "赛博朋克夜景，霓虹雨夜" --ratio 16:9 --duration 5

  # 图生视频 (首帧)
  node leo_huoshan_imagine.mjs video --prompt "镜头缓缓推进" --image scene.jpg

  # 预检
  node leo_huoshan_imagine.mjs video --prompt "测试" --dry-run

  # 恢复视频任务
  node leo_huoshan_imagine.mjs --check-status "cgt-2026xxxx"
`);
}

export function parseCliArgs(args) {
  const result = {
    command: null,
    prompt: null,
    size: "2K",
    outputFormat: "png",
    responseFormat: "url",
    imageUrls: [],
    text: null,
    imagePaths: [],
    ratio: "16:9",
    duration: 5,
    resolution: "720p",
    model: null,
    watermark: false,
    generateAudio: true,
    voice: null,
    encoding: "mp3",
    speedRatio: 1.0,
    checkStatus: null,
    apiKey: null,
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
    } else if (arg === "video" || arg === "tts" || arg === "image") {
      result.command = arg;
    } else if (arg === "--check-status" && next) {
      result.checkStatus = next;
      i++;
    } else if (arg === "--prompt" && next) {
      result.prompt = next;
      i++;
    } else if (arg === "--text" && next) {
      result.text = next;
      i++;
    } else if ((arg === "--image" || arg === "--images") && next) {
      next
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((p) => {
          if (!result.imagePaths.includes(p)) result.imagePaths.push(p);
        });
      i++;
    } else if (arg === "--size" && next) {
      result.size = next;
      i++;
    } else if (arg === "--output-format" && next) {
      result.outputFormat = next;
      i++;
    } else if (arg === "--response-format" && next) {
      result.responseFormat = next;
      i++;
    } else if ((arg === "--image-url" || arg === "--image-urls") && next) {
      next.split(",").map((x) => x.trim()).filter(Boolean).forEach((u) => {
        if (!result.imageUrls.includes(u)) result.imageUrls.push(u);
      });
      i++;
    } else if (arg === "--ratio" && next) {
      result.ratio = next;
      i++;
    } else if (arg === "--duration" && next) {
      result.duration = Math.floor(parseFloat(next)) || 5;
      i++;
    } else if (arg === "--resolution" && next) {
      result.resolution = next;
      i++;
    } else if (arg === "--model" && next) {
      result.model = next;
      i++;
    } else if (arg === "--no-audio") {
      result.generateAudio = false;
    } else if (arg === "--watermark") {
      result.watermark = true;
    } else if (arg === "--voice" && next) {
      result.voice = next;
      i++;
    } else if (arg === "--encoding" && next) {
      result.encoding = next;
      i++;
    } else if (arg === "--speed-ratio" && next) {
      result.speedRatio = parseFloat(next) || 1.0;
      i++;
    } else if (arg === "--api-key" && next) {
      result.apiKey = next;
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

// Auto-run when executed directly.
const currentFilePath = new URL(import.meta.url).pathname;
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isMain =
  currentFilePath === executedFilePath || executedFilePath.endsWith("leo_huoshan_imagine.mjs");

if (isMain) {
  const parsed = parseCliArgs(process.argv.slice(2));

  if (parsed.help || (!parsed.command && !parsed.checkStatus)) {
    printHelp();
    process.exit(parsed.help ? 0 : 1);
  }

  (async () => {
    try {
      if (parsed.checkStatus) {
        const result = await generateVideo({
          taskId: parsed.checkStatus,
          prompt: parsed.prompt || "recovered",
          outputDir: parsed.outputDir,
          filename: parsed.filename,
          apiKey: parsed.apiKey,
          dryRun: parsed.dryRun,
        });
        console.log(`\nSUCCESS:\n${result.markdown || JSON.stringify(result)}`);
        return;
      }

      if (parsed.command === "video") {
        const result = await generateVideo({
          prompt: parsed.prompt,
          imagePaths: parsed.imagePaths,
          ratio: parsed.ratio,
          duration: parsed.duration,
          resolution: parsed.resolution,
          model: parsed.model,
          watermark: parsed.watermark,
          generateAudio: parsed.generateAudio,
          outputDir: parsed.outputDir,
          filename: parsed.filename,
          apiKey: parsed.apiKey,
          dryRun: parsed.dryRun,
        });
        console.log(`\nSUCCESS:\n${result.markdown || JSON.stringify(result)}`);
        return;
      }

      if (parsed.command === "image") {
        const result = await generateImage({
          prompt: parsed.prompt,
          imageUrls: parsed.imageUrls,
          size: parsed.size,
          outputFormat: parsed.outputFormat,
          responseFormat: parsed.responseFormat,
          watermark: parsed.watermark,
          model: parsed.model,
          outputDir: parsed.outputDir,
          filename: parsed.filename,
          apiKey: parsed.apiKey,
          dryRun: parsed.dryRun,
        });
        console.log(`\nSUCCESS:\n${result.markdown || JSON.stringify(result)}`);
        return;
      }

      if (parsed.command === "tts") {
        const result = await synthesizeSpeech({
          text: parsed.text,
          voice: parsed.voice,
          encoding: parsed.encoding,
          speedRatio: parsed.speedRatio,
          outputDir: parsed.outputDir,
          filename: parsed.filename,
          apiKey: parsed.apiKey,
          dryRun: parsed.dryRun,
        });
        console.log(`\nSUCCESS:\n${result.markdown || JSON.stringify(result)}`);
        return;
      }
    } catch (err) {
      console.error(`\nERROR: ${err.message}`);
      process.exit(1);
    }
  })();
}

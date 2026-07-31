import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ARK_API_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const TASKS_PATH = "/contents/generations/tasks";
const DEFAULT_VIDEO_MODEL = "doubao-seedance-2-0-260128";

export function resolveApiKey(explicit) {
  if (explicit) return explicit;
  const envKey = process.env.ARK_API_KEY;
  if (envKey) return envKey;
  try {
    const secretsPath = path.join(process.cwd(), "gateway.secrets.json");
    if (fs.existsSync(secretsPath)) {
      const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf-8"));
      const arkKey = secrets?.arkApiKey || secrets?.ARK_API_KEY || secrets?.ark_api_key;
      if (arkKey) return arkKey;
    }
  } catch {
    // missing / corrupt secrets file is non-fatal
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

// TTS HTTP contract pending docs; surface reserved via the `tts` CLI command.
export function buildTtsBody(options = {}) {
  const text = options.text || options.prompt || "";
  if (!text) throw new Error("TTS 缺少待合成文本。请通过 --text 传入。");
  return {
    text,
    voice: options.voice || "zh_female_qingxin",
    encoding: options.encoding || "mp3",
    speedRatio: options.speedRatio || 1.0,
  };
}

export async function synthesizeSpeech(_options = {}) {
  throw new Error("TTS 尚未接入：HTTP 契约待确认。请等待文档补充后再使用。");
}

export function printHelp() {
  console.log(`
🌋 Huoshan Imagine Skill CLI (火山引擎视频生成 + 文本转语音)

用法 (Usage):
  node leo_huoshan_imagine.mjs <command> [options]

命令 (Commands):
  video        文生视频 / 图生视频 (Seedance 2.0 异步任务)
  --check-status <id>   通过任务 ID 恢复轮询并下载先前发起的视频任务
  (tts 命令暂未接入，待 TTS HTTP 契约确认后启用)

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
    } else if (arg === "video" || arg === "tts") {
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

      if (parsed.command === "tts") {
        throw new Error("TTS 暂未接入，待 HTTP 契约确认后启用。");
      }
    } catch (err) {
      console.error(`\nERROR: ${err.message}`);
      process.exit(1);
    }
  })();
}

import fs from "node:fs";

const GATEWAY_URL = process.env.GATEWAY_URL || "http://127.0.0.1:8787";
const GATEWAY_CLIENT = process.env.GATEWAY_CLIENT || "codex";

export function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === "--prompt") { args.prompt = val; i++; }
    else if (key === "--images") { args.imagePaths = val; i++; }
    else if (key === "--image-name") { args.imageName = val; i++; }
    else if (key === "--aspect-ratio") { args.aspectRatio = val; i++; }
    else if (key === "--output-dir") { args.outputDir = val; i++; }
    else if (key === "--filename") { args.filename = val; i++; }
    else if (key === "--endpoint-id") { args.endpointId = val; i++; }
    else if (key === "--dry-run") { args.dryRun = true; }
    else if (key === "--help" || key === "-h") { args.help = true; }
  }
  return args;
}

export function slugifyPrompt(prompt, maxLength = 35) {
  if (!prompt) return "media";
  let slug = prompt.toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5]+/g, "_").replace(/^_+|_+$/g, "");
  if (!slug) slug = "media";
  if (slug.length > maxLength) slug = slug.substring(0, maxLength).replace(/_+$/, "");
  return slug;
}

export function formatDateYYYYMMDDHHmmss(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

export function generateSemanticFilename(prompt, ext, prefix = "antigravity", explicitFilename = null) {
  if (explicitFilename) return explicitFilename;
  const slug = slugifyPrompt(prompt);
  const cleanExt = ext.startsWith(".") ? ext.slice(1) : ext;
  return `${prefix}_${slug}_${formatDateYYYYMMDDHHmmss()}.${cleanExt}`;
}

function showHelp() {
  console.log(`leo-antigravity-imagine - 通过网关 Antigravity 订阅节点生成图片

用法:
  node leo_antigravity_imagine.mjs --prompt "描述" [options]

参数:
  --prompt         图片描述提示词（必填）
  --images         参考图路径，逗号分隔（最多 3 张）
  --image-name     自定义输出文件名
  --aspect-ratio   画面比例 (1:1/2:3/3:2/3:4/4:3/9:16/16:9, 默认: auto)
  --output-dir     输出目录 (默认: ./images)
  --filename       自定义文件名
  --endpoint-id    指定节点 ID
  --dry-run        预检模式，不实际生成
  --help           显示帮助
`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) { showHelp(); return; }
  if (!args.prompt) { console.error("错误: --prompt 为必填参数"); process.exit(1); }

  const outputDir = args.outputDir || "./images";
  const filename = args.filename || args.imageName || generateSemanticFilename(args.prompt, "png", "antigravity");
  const filePath = `${outputDir}/${filename}`;

  if (args.dryRun) {
    console.log("[dry-run] 预检模式");
    console.log("  prompt:", args.prompt);
    console.log("  aspect_ratio:", args.aspectRatio || "auto");
    console.log("  output:", filePath);
    console.log("  gateway:", GATEWAY_URL);
    return;
  }

  const body = {
    prompt: args.prompt,
    aspectRatio: args.aspectRatio || "auto",
    output_format: "png",
  };
  if (args.imagePaths) {
    body.image_paths = args.imagePaths.split(",").map(s => s.trim()).filter(Boolean).slice(0, 3);
  }
  if (args.endpointId) body.endpoint_id = args.endpointId;

  const res = await fetch(`${GATEWAY_URL}/v1/media/image`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gateway-Client": GATEWAY_CLIENT },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`网关返回错误 ${res.status}: ${json?.error?.message || JSON.stringify(json)}`);
  }

  const savedPath = json.file_path || json.filePath || filePath;
  console.log(`![Generated Image](${savedPath})`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  main().catch(err => {
    console.error("图片生成失败:", err.message || err);
    process.exit(1);
  });
}

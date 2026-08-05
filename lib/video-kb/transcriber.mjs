import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Whisper transcriber: runtime tool detection, multi-backend support.
 * Detects: mlx_whisper, whisper-ctranslate2, faster-whisper, whisper, whisper.cpp
 *
 * All tools output a unified segment format:
 *   [{ segment_id, start_seconds, end_seconds, text }]
 */

const WHISPER_TOOLS = [
  {
    id: "mlx_whisper",
    name: "MLX Whisper",
    command: "mlx_whisper",
    platforms: ["darwin"],
    hint: "Apple Silicon Metal 加速,macOS 首选",
    install: "uv tool install mlx-whisper",
  },
  {
    id: "whisper-ctranslate2",
    name: "Whisper CTranslate2",
    command: "whisper-ctranslate2",
    platforms: ["darwin", "win32", "linux"],
    hint: "跨平台,GPU(CUDA)和 CPU 均可",
    install: "uv tool install whisper-ctranslate2",
  },
  {
    id: "faster-whisper",
    name: "Faster Whisper",
    command: "faster-whisper",
    platforms: ["linux", "darwin", "win32"],
    hint: "CTranslate2 后端,Linux 常用",
    install: "uv tool install faster-whisper",
  },
  {
    id: "whisper",
    name: "OpenAI Whisper",
    command: "whisper",
    platforms: ["darwin", "win32", "linux"],
    hint: "官方实现,PyTorch 后端",
    install: "pip install openai-whisper",
  },
  {
    id: "whisper.cpp",
    name: "Whisper.cpp",
    command: "whisper-cli",
    platforms: ["darwin", "win32", "linux"],
    hint: "C++ 实现,轻量,无 Python 依赖",
    install: "brew install whisper-cpp",
  },
];

const MODEL_SIZES = [
  { id: "tiny", name: "Tiny", sizeMB: 75, speedHint: "极快", guide: "适合快速预览,准确率较低,短视频可用" },
  { id: "base", name: "Base", sizeMB: 145, speedHint: "快", guide: "日常对话基本够用,速度和准确率平衡" },
  { id: "small", name: "Small", sizeMB: 480, speedHint: "中等", guide: "推荐默认,大多数场景准确率好" },
  { id: "medium", name: "Medium", sizeMB: 1500, speedHint: "慢", guide: "准确率高,长视频或专业内容推荐" },
  { id: "large-v3", name: "Large v3", sizeMB: 3000, speedHint: "很慢", guide: "最高准确率,适合重要内容,需要好硬件" },
];

/**
 * Detect all installed Whisper tools on this system.
 * @returns {Array<{id, name, command, path, version, platform, hint, install}>}
 */
export function detectWhisperTools() {
  const platform = process.platform;
  const arch = process.arch;
  const results = [];

  for (const tool of WHISPER_TOOLS) {
    if (!tool.platforms.includes(platform)) continue;
    try {
      const whichCmd = platform === "win32" ? `where ${tool.command}` : `which ${tool.command}`;
      const toolPath = execSync(whichCmd, { encoding: "utf8", timeout: 3000 }).trim().split("\n")[0];
      if (!toolPath) continue;

      let version = "";
      try {
        version = execSync(`${tool.command} --version`, { encoding: "utf8", timeout: 3000 }).trim();
      } catch { /* some tools don't have --version */ }

      results.push({
        id: tool.id,
        name: tool.name,
        command: tool.command,
        path: toolPath,
        version,
        platform,
        hint: tool.hint,
        install: tool.install,
      });
    } catch { /* not installed */ }
  }

  // Sort by platform preference
  if (platform === "darwin" && arch === "arm64") {
    results.sort((a, b) => {
      const order = { mlx_whisper: 0, "whisper-ctranslate2": 1, faster_whisper: 2, whisper: 3, "whisper.cpp": 4 };
      return (order[a.id] ?? 99) - (order[b.id] ?? 99);
    });
  }

  return results;
}

/**
 * Get available model sizes with guidance.
 * @returns {Array<{id, name, sizeMB, speedHint, guide}>}
 */
export function getWhisperModelSizes() {
  return MODEL_SIZES;
}

/**
 * Get install hint for a specific tool.
 */
export function getInstallHint(toolId) {
  const tool = WHISPER_TOOLS.find((t) => t.id === toolId);
  if (!tool) return null;
  return { command: tool.install, tool: toolId };
}

/**
 * Transcribe audio file to text with timestamps.
 *
 * @param {string} audioPath - Path to audio file (wav/mp3/m4a)
 * @param {{tool: string, modelSize: string, language: string, outputDir: string, signal?: AbortSignal, onProgress?: Function}} opts
 * @returns {Promise<{transcriptJson: Array, transcriptTxt: string, srtPath: string|null, detectedLanguage: string}>}
 */
export function transcribe(audioPath, { tool: toolId, modelSize = "base", language = "auto", outputDir, signal, onProgress } = {}) {
  const tool = WHISPER_TOOLS.find((t) => t.id === toolId);
  if (!tool) throw new Error(`Unknown Whisper tool: ${toolId}`);

  if (!fs.existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const baseName = path.basename(audioPath, path.extname(audioPath));

  switch (tool.id) {
    case "mlx_whisper":
      return transcribeMlxWhisper(audioPath, { tool, modelSize, language, outputDir, baseName, signal, onProgress });
    case "whisper-ctranslate2":
      return transcribeCtranslate2(audioPath, { tool, modelSize, language, outputDir, baseName, signal, onProgress });
    case "whisper":
      return transcribeOpenAIWhisper(audioPath, { tool, modelSize, language, outputDir, baseName, signal, onProgress });
    case "whisper.cpp":
      return transcribeWhisperCpp(audioPath, { tool, modelSize, language, outputDir, baseName, signal, onProgress });
    case "faster-whisper":
      return transcribeFasterWhisper(audioPath, { tool, modelSize, language, outputDir, baseName, signal, onProgress });
    default:
      throw new Error(`Transcription not implemented for tool: ${toolId}`);
  }
}

// --- mlx_whisper ---
function transcribeMlxWhisper(audioPath, { tool, modelSize, language, outputDir, baseName, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(outputDir, `${baseName}.json`);
    const args = [
      tool.command, audioPath,
      "--model", modelSize,
      "--output-format", "json",
      "--output-dir", outputDir,
    ];
    if (language && language !== "auto") args.push("--language", language);

    runWhisperProcess(args, { signal, onProgress, reject, resolve: async () => {
      const result = await parseJsonOutput(outputPath, baseName, outputDir);
      resolve(result);
    }});
  });
}

// --- whisper-ctranslate2 ---
function transcribeCtranslate2(audioPath, { tool, modelSize, language, outputDir, baseName, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = [
      tool.command, audioPath,
      "--model", modelSize,
      "--output_format", "json",
      "--output_dir", outputDir,
      "--device", "cpu",
    ];
    if (language && language !== "auto") args.push("--language", language);

    runWhisperProcess(args, { signal, onProgress, reject, resolve: async () => {
      const result = await parseJsonOutput(path.join(outputDir, `${baseName}.json`), baseName, outputDir);
      resolve(result);
    }});
  });
}

// --- OpenAI whisper ---
function transcribeOpenAIWhisper(audioPath, { tool, modelSize, language, outputDir, baseName, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = [
      tool.command, audioPath,
      "--model", modelSize,
      "--output_format", "json",
      "--output_dir", outputDir,
    ];
    if (language && language !== "auto") args.push("--language", language);

    runWhisperProcess(args, { signal, onProgress, reject, resolve: async () => {
      const result = await parseJsonOutput(path.join(outputDir, `${baseName}.json`), baseName, outputDir);
      resolve(result);
    }});
  });
}

// --- whisper.cpp ---
function transcribeWhisperCpp(audioPath, { tool, modelSize, language, outputDir, baseName, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const jsonPath = path.join(outputDir, `${baseName}.json`);
    const args = [
      tool.command, audioPath,
      "--output-json", "--output-file", jsonPath,
    ];
    if (language && language !== "auto") args.push("--language", language);
    // whisper.cpp uses model path, not model name
    // User should configure model path separately

    runWhisperProcess(args, { signal, onProgress, reject, resolve: async () => {
      const result = await parseJsonOutput(jsonPath, baseName, outputDir);
      resolve(result);
    }});
  });
}

// --- faster-whisper (uses Python API, wrapped via CLI) ---
function transcribeFasterWhisper(audioPath, { tool, modelSize, language, outputDir, baseName, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = [
      tool.command, audioPath,
      "--model", modelSize,
      "--output_format", "json",
      "--output_dir", outputDir,
    ];
    if (language && language !== "auto") args.push("--language", language);

    runWhisperProcess(args, { signal, onProgress, reject, resolve: async () => {
      const result = await parseJsonOutput(path.join(outputDir, `${baseName}.json`), baseName, outputDir);
      resolve(result);
    }});
  });
}

// --- shared process runner ---
function runWhisperProcess(args, { signal, onProgress, reject, resolve }) {
  const command = args[0];
  const rest = args.slice(1);
  const proc = spawn(command, rest, { timeout: 0 });
  let stderr = "";

  proc.stderr.on("data", (d) => {
    stderr += d;
    const text = d.toString();
    // Try to parse progress from various formats
    const pctMatch = text.match(/(\d+)%/);
    if (pctMatch && onProgress) {
      onProgress(parseInt(pctMatch[1]) / 100, text.trim());
    }
  });

  proc.on("error", (err) => {
    reject(new Error(`${command} failed to start: ${err.message}`));
  });

  const abortHandler = () => {
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) proc.kill("SIGTERM");
    else signal.addEventListener("abort", abortHandler, { once: true });
  }

  proc.on("close", (code) => {
    if (signal) signal.removeEventListener("abort", abortHandler);
    if (signal?.aborted) { reject(new Error("Transcription cancelled.")); return; }
    if (code !== 0) { reject(new Error(`${command} failed (exit ${code}): ${stderr.trim()}`)); return; }
    resolve();
  });
}

// --- output parsing ---
async function parseJsonOutput(jsonPath, baseName, outputDir) {
  let segments = [];
  let detectedLanguage = "unknown";
  let transcriptTxt = "";

  if (fs.existsSync(jsonPath)) {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    detectedLanguage = data.language || "unknown";

    // Different tools use different JSON structures
    if (Array.isArray(data.segments)) {
      segments = data.segments.map((seg, i) => ({
        segment_id: `ASR-S${String(i + 1).padStart(4, "0")}`,
        start_seconds: seg.start ?? seg.start_seconds ?? 0,
        end_seconds: seg.end ?? seg.end_seconds ?? 0,
        text: (seg.text || "").trim(),
      }));
    } else if (data.text) {
      // Single block of text
      segments = [{
        segment_id: "ASR-S0001",
        start_seconds: 0,
        end_seconds: 0,
        text: data.text.trim(),
      }];
    }
    transcriptTxt = data.text || segments.map((s) => s.text).join(" ");
  }

  // Generate plain text transcript
  const txtPath = path.join(outputDir, `${baseName}.txt`);
  fs.writeFileSync(txtPath, transcriptTxt, "utf8");

  // Check for SRT
  const srtPath = path.join(outputDir, `${baseName}.srt`);
  const hasSrt = fs.existsSync(srtPath);

  return {
    transcriptJson: segments,
    transcriptTxt,
    transcriptTxtPath: txtPath,
    srtPath: hasSrt ? srtPath : null,
    detectedLanguage,
  };
}

import { spawn, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * yt-dlp wrapper: download video audio + metadata, with cookie support.
 * Uses spawn for streaming progress, not execSync.
 */

/**
 * Detect if yt-dlp is installed and return its path + version.
 * @returns {{path: string, version: string} | null}
 */
export function detectYtDlp() {
  try {
    const version = execSync("yt-dlp --version", { encoding: "utf8", timeout: 5000 }).trim();
    const whichCmd = process.platform === "win32" ? "where yt-dlp" : "which yt-dlp";
    const ytPath = execSync(whichCmd, { encoding: "utf8", timeout: 5000 }).trim().split("\n")[0];
    return { path: ytPath, version };
  } catch {
    return null;
  }
}

/**
 * Check if uv is available (preferred installer).
 */
function detectUv() {
  try {
    execSync("uv --version", { encoding: "utf8", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get install hint for yt-dlp based on platform and available tools.
 * @returns {{commands: string[], platform: string}}
 */
export function getYtDlpInstallHint() {
  const platform = process.platform;
  const commands = [];

  if (detectUv()) {
    commands.push("uv tool install yt-dlp");
  }

  // Python pip
  try {
    execSync("python3 --version", { encoding: "utf8", timeout: 3000 });
    commands.push("pip install yt-dlp");
  } catch { /* no python */ }

  if (platform === "darwin") {
    commands.push("brew install yt-dlp");
  } else if (platform === "win32") {
    commands.push("scoop install yt-dlp");
    commands.push("winget install yt-dlp.yt-dlp");
  } else {
    commands.push("pipx install yt-dlp");
  }

  return { commands, platform };
}

/**
 * Check if ffmpeg is available (needed for audio extraction).
 */
export function detectFfmpeg() {
  try {
    execSync("ffmpeg -version", { encoding: "utf8", timeout: 3000 });
    const whichCmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    const ffPath = execSync(whichCmd, { encoding: "utf8", timeout: 3000 }).trim().split("\n")[0];
    return { path: ffPath };
  } catch {
    return null;
  }
}

/**
 * Generate a stable video ID from URL.
 */
export function videoIdFromUrl(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/**
 * Fetch video metadata without downloading.
 * @returns {Promise<{title, duration, uploader, url, extractor, thumbnail}>}
 */
export function fetchVideoInfo(url, { cookieFile } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["--no-playlist", "--dump-single-json", "--no-warnings"];
    if (cookieFile) args.push("--cookies", cookieFile);
    args.push(url);

    const proc = spawn("yt-dlp", args, { timeout: 30000 });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("error", (err) => {
      reject(new Error(`yt-dlp not found: ${err.message}. Install: ${getYtDlpInstallHint().commands[0]}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp info fetch failed (exit ${code}): ${stderr.trim()}`));
        return;
      }
      try {
        const info = JSON.parse(stdout);
        resolve({
          title: info.title || "untitled",
          duration: info.duration || 0,
          uploader: info.uploader || info.channel || "",
          url: info.webpage_url || url,
          extractor: info.extractor || "",
          thumbnail: info.thumbnail || "",
          originalInfo: info,
        });
      } catch (err) {
        reject(new Error(`Failed to parse yt-dlp output: ${err.message}`));
      }
    });
  });
}

/**
 * Download video (audio track and/or full video).
 *
 * @param {string} url - Video URL
 * @param {{cookieFile?: string, outputDir: string, audioOnly?: boolean, signal?: AbortSignal, onProgress?: Function}} opts
 * @returns {Promise<{audioPath: string, videoPath: string|null, infoPath: string, info: object}>}
 */
export function downloadVideo(url, { cookieFile, outputDir, audioOnly = false, signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const videoId = videoIdFromUrl(url);
    const template = path.join(outputDir, `${videoId}.%(ext)s`);

    const args = ["--no-playlist", "--newline", "--no-warnings", "--write-info-json"];
    if (cookieFile) args.push("--cookies", cookieFile);

    if (audioOnly) {
      args.push("-f", "bestaudio", "--extract-audio", "--audio-format", "wav", "--audio-quality", "0");
    } else {
      args.push("-f", "bestvideo+bestaudio/best", "--merge-output-format", "mp4");
    }
    args.push("-o", template, url);

    const proc = spawn("yt-dlp", args, { timeout: 0 });
    let stderr = "";
    let lastPercent = 0;

    proc.stderr.on("data", (d) => {
      stderr += d;
      const text = d.toString();
      // Parse progress: [download] xx.x% of ...
      const match = text.match(/\[download\]\s+([\d.]+)%/);
      if (match) {
        lastPercent = parseFloat(match[1]);
        if (onProgress) onProgress(lastPercent / 100, `downloading ${lastPercent.toFixed(1)}%`);
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`yt-dlp failed to start: ${err.message}`));
    });

    const abortHandler = () => {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    };
    if (signal) {
      if (signal.aborted) { proc.kill("SIGTERM"); }
      else { signal.addEventListener("abort", abortHandler, { once: true }); }
    }

    proc.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", abortHandler);

      if (signal?.aborted) {
        reject(new Error("Download cancelled."));
        return;
      }
      if (code !== 0) {
        reject(new Error(`yt-dlp download failed (exit ${code}): ${stderr.trim()}`));
        return;
      }

      // Find the downloaded files
      const infoPath = path.join(outputDir, `${videoId}.info.json`);
      let audioPath = null;
      let videoPath = null;

      if (audioOnly) {
        audioPath = findFile(outputDir, videoId, [".wav", ".m4a", ".mp3", ".opus", ".webm"]);
      } else {
        videoPath = findFile(outputDir, videoId, [".mp4", ".webm", ".mkv"]);
      }

      let info = {};
      if (fs.existsSync(infoPath)) {
        try { info = JSON.parse(fs.readFileSync(infoPath, "utf8")); } catch { /* ignore */ }
      }

      resolve({ audioPath, videoPath, infoPath, info });
    });
  });
}

function findFile(dir, prefix, extensions) {
  for (const ext of extensions) {
    const candidate = path.join(dir, `${prefix}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Fallback: scan directory for files starting with prefix
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(prefix) && !entry.endsWith(".info.json") && !entry.endsWith(".partial")) {
        return path.join(dir, entry);
      }
    }
  } catch { /* ignore */ }
  return null;
}

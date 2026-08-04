import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export async function downloadMediaFile(url, targetPath, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const res = await doFetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(targetPath, buf);
      return targetPath;
    }
  } catch (err) {
    console.warn(`[Media Download] fetch failed (${err.message}), trying curl fallback...`);
  }
  try {
    const escapedUrl = url.replace(/"/g, '\\"');
    const escapedTarget = targetPath.replace(/"/g, '\\"');
    execSync(`curl -sSL --connect-timeout 15 -m 180 "${escapedUrl}" -o "${escapedTarget}"`);
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) return targetPath;
  } catch (curlErr) {
    throw new Error(`curl download failed (${url}): ${curlErr.message}`);
  }
  throw new Error(`Cannot download media file (${url}): empty response`);
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

export function generateSemanticFilename(prompt, ext, providerPrefix = null, explicitFilename = null) {
  if (explicitFilename) return explicitFilename;
  const slug = slugifyPrompt(prompt);
  const cleanExt = ext.startsWith(".") ? ext.slice(1) : ext;
  const prefix = providerPrefix ? `${providerPrefix}_` : "media_";
  return `${prefix}${slug}_${formatDateYYYYMMDDHHmmss()}.${cleanExt}`;
}

const OUTPUT_DIRS = { image: "images", video: "videos", audio: "audios" };

export function ensureOutputDir(type, baseDir = process.cwd()) {
  const dirName = OUTPUT_DIRS[type] || type;
  const dir = path.join(baseDir, dirName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

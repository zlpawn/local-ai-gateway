import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { detectDefaultDataDir } from "../cli/init-config.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..", "..");
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

function resolveDataDir() {
  try {
    return detectDefaultDataDir(PROJECT_ROOT);
  } catch {
    return path.join(os.homedir(), ".local-ai-gateway");
  }
}

function resolveFile() {
  return path.join(resolveDataDir(), "cli-sources.json");
}

function expandDir(pattern) {
  if (!pattern) return [];
  let p = String(pattern).trim();

  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) {
    p = path.join(os.homedir(), p.slice(2));
  }

  p = p
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] || "")
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, n) => process.env[n] || "")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => process.env[n] || "");

  p = p.replace(/\//g, path.sep);

  const star = p.indexOf("*");
  if (star === -1) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return [p];
    } catch {}
    return [];
  }

  const before = p.slice(0, star);
  const segStart = before.lastIndexOf(path.sep) + 1;
  const segEndRel = p.slice(star).indexOf(path.sep);
  const segEnd = segEndRel === -1 ? p.length : star + segEndRel;
  const parent = p.slice(0, segStart) || path.sep;
  const pattern2 = p.slice(segStart, segEnd);
  const after = segEndRel === -1 ? "" : p.slice(segEnd + 1);
  const re = new RegExp(
    "^" + pattern2.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );

  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!re.test(ent.name)) continue;
    const child = path.join(parent, ent.name, after);
    try {
      if (fs.existsSync(child) && fs.statSync(child).isDirectory()) {
        results.push(child);
      }
    } catch {}
  }
  return results;
}

export function expandDirs(patterns) {
  const out = [];
  const seen = new Set();
  for (const pat of patterns || []) {
    for (const dir of expandDir(pat)) {
      const norm = path.resolve(dir);
      if (!seen.has(norm)) {
        seen.add(norm);
        out.push(dir);
      }
    }
  }
  return out;
}

export function defaultSources() {
  if (isWindows) {
    return [
      { id: "uv", name: "uv", label: "uv 安装", enabled: true, dirs: ["~/AppData/Roaming/uv/tools", "~/.local/bin"] },
      { id: "npm", name: "npm", label: "npm 全局", enabled: true, dirs: ["%APPDATA%/npm", "%ProgramFiles%/nodejs"] },
      { id: "curl", name: "curl", label: "curl 脚本安装", enabled: true, dirs: ["~/.local/bin", "%LOCALAPPDATA%/Programs"] },
      { id: "winget", name: "winget", label: "winget 安装", enabled: true, dirs: ["%LOCALAPPDATA%/Programs"] },
      { id: "irm", name: "irm", label: "PowerShell irm 安装", enabled: true, dirs: ["~/.local/bin", "%LOCALAPPDATA%/Programs"] },
      { id: "path", name: "path", label: "PATH 目录", enabled: true, dirs: ["$PATH"] },
    ];
  }
  if (isMac) {
    return [
      { id: "uv", name: "uv", label: "uv 安装", enabled: true, dirs: ["~/.local/bin"] },
      { id: "npm", name: "npm", label: "npm 全局", enabled: true, dirs: ["/usr/local/lib/node_modules/.bin", "/opt/homebrew/lib/node_modules/.bin", "~/.npm-global/bin", "~/.nvm/versions/node/*/bin"] },
      { id: "curl", name: "curl", label: "curl 脚本安装", enabled: true, dirs: ["~/.local/bin", "/usr/local/bin"] },
      { id: "homebrew", name: "homebrew", label: "Homebrew 安装", enabled: true, dirs: ["/opt/homebrew/bin", "/usr/local/bin"] },
      { id: "path", name: "path", label: "PATH 目录", enabled: true, dirs: ["$PATH"] },
    ];
  }
  return [
    { id: "uv", name: "uv", label: "uv 安装", enabled: true, dirs: ["~/.local/bin"] },
    { id: "npm", name: "npm", label: "npm 全局", enabled: true, dirs: ["~/.npm-global/bin", "~/.nvm/versions/node/*/bin"] },
    { id: "curl", name: "curl", label: "curl 脚本安装", enabled: true, dirs: ["~/.local/bin", "/usr/local/bin"] },
    { id: "path", name: "path", label: "PATH 目录", enabled: true, dirs: ["$PATH"] },
  ];
}

function readRaw() {
  const file = resolveFile();
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Array.isArray(data?.sources)) return data;
  } catch {}
  return { version: 1, sources: defaultSources(), ignored: [], favorites: [] };
}

function writeRaw(data) {
  const file = resolveFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function newId() {
  return `src_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export const CliSourceConfig = {
  filePath() {
    return resolveFile();
  },

  list() {
    const data = readRaw();
    return data.sources.map((s, i) => ({ ...s, order: i }));
  },

  defaults() {
    return defaultSources();
  },

  save(sources) {
    const data = readRaw();
    const normalized = (sources || [])
      .filter((s) => s && s.name)
      .map((s, i) => ({
        id: s.id || newId(),
        name: String(s.name).trim(),
        label: String(s.label || s.name).trim(),
        enabled: s.enabled !== false,
        dirs: Array.isArray(s.dirs) ? s.dirs.filter(Boolean) : [],
        order: i,
      }));
    writeRaw({ version: 1, sources: normalized, ignored: data.ignored || [], favorites: data.favorites || [] });
    return normalized;
  },

  reset() {
    const data = readRaw();
    const sources = defaultSources();
    // Keep user favorites across source resets; ignored list is cleared with sources.
    writeRaw({ version: 1, sources, ignored: [], favorites: Array.isArray(data.favorites) ? data.favorites : [] });
    return sources;
  },

  // --- Ignored CLI names: user opts out of scanning these ---
  listIgnored() {
    const data = readRaw();
    return Array.isArray(data.ignored) ? data.ignored : [];
  },

  addIgnored(name) {
    const n = String(name || "").trim();
    if (!n) return this.listIgnored();
    const data = readRaw();
    const ignored = Array.isArray(data.ignored) ? data.ignored : [];
    if (!ignored.includes(n)) ignored.push(n);
    writeRaw({ ...data, ignored });
    return ignored;
  },

  removeIgnored(name) {
    const n = String(name || "").trim();
    const data = readRaw();
    const ignored = (Array.isArray(data.ignored) ? data.ignored : []).filter((x) => x !== n);
    writeRaw({ ...data, ignored });
    return ignored;
  },

  // --- Favorite / preferred CLI names: user pins these into recommended ---
  listFavorites() {
    const data = readRaw();
    return Array.isArray(data.favorites) ? data.favorites : [];
  },

  addFavorite(name) {
    const n = String(name || "").trim();
    if (!n) return this.listFavorites();
    const data = readRaw();
    const favorites = Array.isArray(data.favorites) ? data.favorites : [];
    if (!favorites.includes(n)) favorites.push(n);
    writeRaw({ ...data, favorites });
    return favorites;
  },

  removeFavorite(name) {
    const n = String(name || "").trim();
    const data = readRaw();
    const favorites = (Array.isArray(data.favorites) ? data.favorites : []).filter((x) => x !== n);
    writeRaw({ ...data, favorites });
    return favorites;
  },
};
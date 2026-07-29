import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expandDirs, CliSourceConfig } from "./source-config.mjs";

const execFileP = promisify(execFile);
const isWindows = process.platform === "win32";
const WIN_EXE_EXTS = new Set([".exe", ".cmd", ".bat"]);

// Names that are clearly not CLIs -- uninstallers, setup wrappers, OS
// built-ins, installers. These are skipped so the list only shows real
// command-line tools the user can actually invoke.
const IGNORE_NAME_RE =
  /^(uninst|unins\d*|setup|install|installer|msiexec|regsvr32|rundll32|wscript|cscript|curl\.ca|update|updater|helper|crashpad|crashreporter|elevation|deprecated|remove)/i;

// Exact names (case-insensitive) that are NOT standalone CLIs the user would
// invoke directly. These are GUI apps, GUI launchers, or helper/shim scripts
// shipped inside other installers (e.g. the headless Java launcher javaw, the
// Git GUI tools, nvm environment-setup .bat, chocolatey RefreshEnv).
const IGNORE_NAME_SET = new Set([
  "antigravity",
  "ollama app",
  "javaw",
  "gitk",
  "git-gui",
  "elevate",
  "nodevars",
  "refreshenv",
  "nvdlisrwrapper",
  "scalar",
]);

// Path fragments (case-insensitive) whose binaries are internal runtimes,
// bundled dependencies, or host-app components rather than user-facing CLIs.
const IGNORE_PATH_FRAGMENTS = [
  ".codex/tmp",
  ".codex\\tmp",
  "codex-runtimes",
  "windowsapps/openai.codex_",
  "windowsapps\\openai.codex_",
  "nvidia app/nvdlisr",
  "nvidia app\\nvdlisr",
];

function pathDirs() {
  const envPath = process.env.PATH || process.env.Path || "";
  const sep = isWindows ? ";" : ":";
  return envPath.split(sep).map((p) => p.trim()).filter(Boolean);
}

function isSystemDir(dir) {
  if (!isWindows) return false;
  const root = (process.env.SystemRoot || process.env.windir || "C:\\Windows").toLowerCase();
  const lower = dir.toLowerCase();
  return lower === root || lower.startsWith(root + "\\");
}

function isExecutableName(name) {
  if (!isWindows) return true;
  return WIN_EXE_EXTS.has(path.extname(name).toLowerCase());
}

function baseName(name) {
  return isWindows ? name.replace(/\.(exe|cmd|bat)$/i, "") : name;
}

function isIgnoredName(name) {
  const base = baseName(name);
  if (!base) return false;
  if (IGNORE_NAME_SET.has(base.toLowerCase())) return true;
  if (IGNORE_NAME_RE.test(base)) return true;
  return false;
}

function isIgnoredPath(fullPath) {
  if (!fullPath) return false;
  const lower = String(fullPath).toLowerCase();
  for (const frag of IGNORE_PATH_FRAGMENTS) {
    if (lower.includes(frag.toLowerCase())) return true;
  }
  return false;
}

function scanDir(dir) {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!isExecutableName(name)) continue;
    if (isIgnoredName(name)) continue;
    const full = path.join(dir, name);
    if (isIgnoredPath(full)) continue;
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (!isWindows && (st.mode & 0o111) === 0) continue;
    } catch {
      continue;
    }
    out.push({ name: baseName(name), path: full });
  }
  return out;
}

function dirsForSource(source) {
  const dirs = [];
  for (const pat of source.dirs || []) {
    if (String(pat).trim().toUpperCase() === "$PATH") {
      dirs.push(...pathDirs().filter((d) => !isSystemDir(d)));
    } else {
      dirs.push(...expandDirs([pat]));
    }
  }
  return dirs;
}

function scanBinaries(sources, ignoredSet) {
  const seen = new Map();
  for (const source of sources) {
    if (source.enabled === false) continue;
    const label = source.name || source.id || "unknown";
    for (const dir of dirsForSource(source)) {
      for (const bin of scanDir(dir)) {
        if (ignoredSet && ignoredSet.has(bin.name)) continue;
        if (!seen.has(bin.name)) {
          seen.set(bin.name, { name: bin.name, path: bin.path, source: label });
        }
      }
    }
  }
  return [...seen.values()];
}

function cleanVersion(stdout) {
  const line = String(stdout || "").trim().split(/\r?\n/)[0];
  return line ? line.slice(0, 120) : null;
}

async function probeVersion(item) {
  const opts = { encoding: "utf8", timeout: 3000, windowsHide: true, maxBuffer: 1 << 20 };
  try {
    if (isWindows) {
      // For .cmd/.bat wrappers a shell is still needed to resolve them, but
      // windowsHide keeps any window hidden. For real .exe we spawn directly
      // (no shell) so no console window flashes at all.
      const needsShell = /\.(cmd|bat)$/i.test(item.path);
      const { stdout } = await execFileP(item.path, ["--version"], { ...opts, shell: needsShell });
      return cleanVersion(stdout);
    }
    const { stdout } = await execFileP(item.path, ["--version"], opts);
    return cleanVersion(stdout);
  } catch {
    return null;
  }
}

async function probeAll(items, concurrency = 16) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await probeVersion(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function matchesQuery(item, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    item.name.toLowerCase().includes(q) ||
    (item.path || "").toLowerCase().includes(q) ||
    (item.source || "").toLowerCase().includes(q)
  );
}

// Scan the machine for installed CLI binaries. Sources are configurable (uv,
// npm, curl, homebrew, winget, irm, PATH, plus user-added). Only installed
// binaries appear; uninstallers/installers/OS built-ins are filtered out. By
// default version probing is OFF so opening the tab does not spawn processes
// (which on Windows can flash terminal windows). Pass probe:true to fetch
// versions. Pass ignored (Set) to exclude CLI names the user opted-out of.
export async function discoverInstalledClis({
  query = "",
  probe = false,
  sources,
  ignored,
} = {}) {
  const resolved = sources || CliSourceConfig.list();
  const ignoredSet = ignored instanceof Set ? ignored : new Set(ignored || []);
  const found = scanBinaries(resolved, ignoredSet);
  const versions = probe ? await probeAll(found) : found.map(() => null);
  const items = found
    .map((b, idx) => ({
      name: b.name,
      command: b.name,
      installed: true,
      path: b.path,
      version: versions[idx] || null,
      source: b.source || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const filtered = items.filter((item) => matchesQuery(item, query));
  return {
    items: filtered,
    stats: { total: items.length, installed: items.length, shown: filtered.length },
  };
}
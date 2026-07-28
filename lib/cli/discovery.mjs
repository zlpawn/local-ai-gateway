import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expandDirs, CliSourceConfig } from "./source-config.mjs";

const execFileP = promisify(execFile);
const isWindows = process.platform === "win32";
const WIN_EXE_EXTS = new Set([".exe", ".cmd", ".bat"]);

function pathDirs() {
  const envPath = process.env.PATH || process.env.Path || "";
  const sep = isWindows ? ";" : ":";
  return envPath.split(sep).map((p) => p.trim()).filter(Boolean);
}

// Skip directories that belong to the OS itself. On Windows this keeps the
// scan from listing hundreds of built-ins under %SystemRoot% (System32 etc.);
// user-installed tooling lives elsewhere. On POSIX, /bin and /usr/bin hold
// real CLIs, so PATH is scanned as-is.
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

// Scan a single concrete directory for executable binaries. Returns an array
// of { name, path } for the executables found.
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
    const full = path.join(dir, name);
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

// Build the ordered list of concrete directories to scan from a source's dir
// patterns. "$PATH" is a special token that expands to the system PATH dirs.
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

// Scan all enabled sources in order. The first source to claim a binary name
// wins, which implements the "priority" ordering (uv > npm > ... > path).
// Returns an array of { name, path, source }.
function scanBinaries(sources) {
  const seen = new Map(); // baseName -> { name, path, source }
  for (const source of sources) {
    if (source.enabled === false) continue;
    const label = source.name || source.id || "unknown";
    for (const dir of dirsForSource(source)) {
      for (const bin of scanDir(dir)) {
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
      const { stdout } = await execFileP(item.name, ["--version"], { ...opts, shell: true });
      return cleanVersion(stdout);
    }
    const { stdout } = await execFileP(item.path, ["--version"], opts);
    return cleanVersion(stdout);
  } catch {
    return null;
  }
}

// Probe versions with bounded concurrency so a few slow CLIs don't stall scan.
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

// Scan the machine for installed CLI binaries and report them with probed
// versions. Scans are driven by the configurable source list (uv, npm, curl,
// homebrew, winget, irm, PATH, plus any user-added sources like chocolatey).
// Only installed binaries appear -- there is no curated catalog. Set
// probe:false to skip version probing (fast scan). Pass sources to override
// the persisted configuration (e.g. for testing).
export async function discoverInstalledClis({ query = "", probe = true, sources } = {}) {
  const resolved = sources || CliSourceConfig.list();
  const found = scanBinaries(resolved);
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
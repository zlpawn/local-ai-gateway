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
// bundled dependencies, host-app components, or toolchain utility dumps
// rather than user-facing CLIs. Especially important on Windows where Git for
// Windows / MSYS / MinGW flood PATH with hundreds of unixy helpers.
const IGNORE_PATH_FRAGMENTS = [
  ".codex/tmp",
  ".codex\\tmp",
  "codex-runtimes",
  "windowsapps/openai.codex_",
  "windowsapps\\openai.codex_",
  "nvidia app/nvdlisr",
  "nvidia app\\nvdlisr",
  // Git for Windows / MSYS / MinGW / Cygwin internal utility bins
  "mingw64\\bin",
  "mingw64/bin",
  "mingw32\\bin",
  "mingw32/bin",
  "git\\usr\\bin",
  "git/usr/bin",
  "git\\usr\\libexec",
  "git/usr/libexec",
  "git\\mingw64\\bin",
  "git/mingw64/bin",
  "git\\mingw32\\bin",
  "git/mingw32/bin",
  "msys64\\usr\\bin",
  "msys64/usr/bin",
  "msys64\\mingw64\\bin",
  "msys64/mingw64/bin",
  "msys2\\usr\\bin",
  "msys2/usr/bin",
  "cygwin\\bin",
  "cygwin/bin",
  "cygwin64\\bin",
  "cygwin64/bin",
  "libexec\\git-core",
  "libexec/git-core",
  "usr\\bin\\core_perl",
  "usr/bin/core_perl",
];

// Well-known CLIs users actually type day-to-day. Used for the default
// "recommended" view. Uncommon PATH noise stays available under view=all.
const RECOMMENDED_CLI_NAMES = new Set([
  // runtimes / package managers
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "python",
  "python3",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "pipx",
  "ruby",
  "gem",
  "bundle",
  "go",
  "rustc",
  "cargo",
  "rustup",
  "rust-analyzer",
  "java",
  "javac",
  "mvn",
  "gradle",
  "dotnet",
  "php",
  "composer",
  "perl",
  "lua",
  // vcs
  "git",
  "gh",
  "glab",
  "svn",
  "hg",
  // containers / cloud / infra
  "docker",
  "docker-compose",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "pulumi",
  "ansible",
  "aws",
  "az",
  "gcloud",
  "flyctl",
  "vercel",
  "netlify",
  "wrangler",
  // AI / agent CLIs
  "claude",
  "codex",
  "gemini",
  "ollama",
  "aider",
  "cursor",
  "opencode",
  "agent",
  "agent-gateway",
  "sgpt",
  "llm",
  // everyday developer utilities
  "rg",
  "fd",
  "fzf",
  "bat",
  "eza",
  "exa",
  "jq",
  "yq",
  "http",
  "httpie",
  "curl",
  "wget",
  "make",
  "cmake",
  "ninja",
  "just",
  "task",
  "tmux",
  "nvim",
  "vim",
  "code",
  "code-insiders",
  "sqlite3",
  "psql",
  "redis-cli",
  "mongosh",
  "ffmpeg",
  "ffprobe",
  "magick",
  // package managers / shells people intentionally install
  "winget",
  "scoop",
  "choco",
  "brew",
  "pwsh",
  // common node tooling
  "tsx",
  "ts-node",
  "nodemon",
  "vite",
  "next",
  "turbo",
  "nx",
]);

// Paths that mean the user intentionally dropped a CLI here. These promote
// uncommon names into the recommended view. Bulk toolchain dumps (cargo bin,
// go bin, nvm node bin, homebrew cellar dumps) are intentionally excluded —
// only exact allowlisted names from those locations stay recommended.
const BROAD_USER_INSTALL_PATH_FRAGMENTS = [
  `${path.sep}.local${path.sep}bin`,
  "appdata\\roaming\\npm",
  "appdata/roaming/npm",
  "appdata\\roaming\\uv",
  "appdata/roaming/uv",
  "appdata\\local\\programs",
  "appdata/local/programs",
  ".npm-global",
  "/usr/local/lib/node_modules/.bin",
  "/opt/homebrew/lib/node_modules/.bin",
];

// Satellite / helper binaries that ship next to real CLIs. Keep them visible
// under view=all, but never promote them into the default recommended list.
const SATELLITE_CLI_NAME_RE =
  /^(cargo-.+|clippy-driver|rustdoc|rust-gdb|rust-lldb|rls|corepack|npm-prefix|npm-cli|nodevars|tsc-help)$/i;

// Package-manager / installer sources count as recommended for non-satellite
// names, because the user (or a managed installer) put them there on purpose.
// Bare PATH dumps and bulk toolchain bins do not auto-promote.
const RECOMMENDED_SOURCES = new Set([
  "uv",
  "npm",
  "curl",
  "winget",
  "irm",
  "homebrew",
  "choco",
  "scoop",
  "pipx",
]);

function pathDirs() {
  const envPath = process.env.PATH || process.env.Path || "";
  const sep = isWindows ? ";" : ":";
  return envPath.split(sep).map((p) => p.trim()).filter(Boolean);
}

function isSystemDir(dir) {
  if (!isWindows) {
    // macOS system dirs hold ~1200 OS built-ins (ls, cp, mount, ...) that are
    // not user-installed CLIs. Filter them so only real tools from homebrew,
    // ~/.local/bin, npm, etc. surface in scan results.
    const macosSystem = ["/usr/bin", "/usr/sbin", "/bin", "/sbin"];
    const lower = dir.toLowerCase();
    if (macosSystem.includes(lower)) return true;
    if (lower === "/system" || lower.startsWith("/system/")) return true;
    if (lower.startsWith("/var/run/com.apple.security.cryptexd/")) return true;
    return false;
  }
  const root = (process.env.SystemRoot || process.env.windir || "C:\\Windows").toLowerCase();
  const lower = dir.toLowerCase();
  return lower === root || lower.startsWith(root + "\\");
}

// macOS app bundles expose internal helpers via PATH (e.g. ChatGPT.app's
// codex-code-mode-host, Yunshu's ping shim). These are app components, not
// user-installed CLIs, so skip any directory inside a .app bundle.
function isAppBundleDir(dir) {
  if (process.platform !== "darwin") return false;
  const lower = String(dir || "").toLowerCase();
  return lower.includes("/contents/");
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

function isBroadUserInstallPath(fullPath) {
  if (!fullPath) return false;
  const lower = String(fullPath).toLowerCase();
  for (const frag of BROAD_USER_INSTALL_PATH_FRAGMENTS) {
    if (lower.includes(frag.toLowerCase())) return true;
  }
  return false;
}

function isSatelliteCliName(name) {
  const base = String(name || "").toLowerCase();
  if (!base) return false;
  // Keep a few well-known tools that look satellite-ish but are primary CLIs.
  if (base === "rust-analyzer" || base === "cargo" || base === "rustc" || base === "rustup") {
    return false;
  }
  return SATELLITE_CLI_NAME_RE.test(base);
}

function classifyTier(item, favoriteSet) {
  const name = String(item.name || "").toLowerCase();
  // Explicit user pin always wins, including over satellite demotion.
  if (favoriteSet && (favoriteSet.has(item.name) || favoriteSet.has(name))) {
    return "recommended";
  }
  // Satellite helpers always stay in "all", never the default recommended view.
  if (isSatelliteCliName(name)) return "other";
  if (RECOMMENDED_CLI_NAMES.has(name)) return "recommended";
  const source = String(item.source || "").toLowerCase();
  if (source && RECOMMENDED_SOURCES.has(source)) return "recommended";
  // Custom / non-path sources that the user added also count as intentional,
  // but still exclude satellite helpers above.
  if (source && source !== "path") return "recommended";
  if (isBroadUserInstallPath(item.path)) return "recommended";
  return "other";
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
      dirs.push(...pathDirs().filter((d) => !isSystemDir(d) && !isAppBundleDir(d)));
    } else {
      // Explicit source dirs still skip toolchain dumps so MinGW/Git usr bins
      // never flood either the recommended or all views.
      dirs.push(...expandDirs([pat]).filter((d) => !isIgnoredPath(d)));
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
      if (isIgnoredPath(dir)) continue;
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
    (item.source || "").toLowerCase().includes(q) ||
    (item.tier || "").toLowerCase().includes(q)
  );
}

function normalizeView(view) {
  const v = String(view || "recommended").toLowerCase();
  return v === "all" ? "all" : "recommended";
}

// Scan the machine for installed CLI binaries. Sources are configurable (uv,
// npm, curl, homebrew, winget, irm, PATH, plus user-added). Only installed
// binaries appear; uninstallers/installers/OS built-ins/toolchain dumps are
// filtered out. By default the "recommended" view is returned (common CLIs +
// intentional installs). Pass view:"all" for every surviving scan hit. Version
// probing is OFF by default so opening the tab does not spawn processes
// (which on Windows can flash terminal windows). Pass probe:true to fetch
// versions for the selected view only. Pass ignored (Set) to exclude CLI
// names the user opted-out of.
export async function discoverInstalledClis({
  query = "",
  probe = false,
  sources,
  ignored,
  favorites,
  view = "recommended",
} = {}) {
  const resolved = sources || CliSourceConfig.list();
  const ignoredSet = ignored instanceof Set ? ignored : new Set(ignored || []);
  const favoriteSet = favorites instanceof Set ? favorites : new Set(favorites || []);
  const selectedView = normalizeView(view);
  const found = scanBinaries(resolved, ignoredSet);

  const classified = found
    .map((b) => {
      const favorite = favoriteSet.has(b.name);
      return {
        name: b.name,
        command: b.name,
        installed: true,
        path: b.path,
        version: null,
        source: b.source || null,
        favorite,
        tier: classifyTier(b, favoriteSet),
      };
    })
    // Favorites first, then alphabetical within each group.
    .sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const recommendedCount = classified.filter((item) => item.tier === "recommended").length;
  const viewItems =
    selectedView === "all"
      ? classified
      : classified.filter((item) => item.tier === "recommended");
  const filtered = viewItems.filter((item) => matchesQuery(item, query));

  if (probe && filtered.length) {
    const versions = await probeAll(filtered);
    for (let i = 0; i < filtered.length; i++) {
      filtered[i] = { ...filtered[i], version: versions[i] || null };
    }
  }

  return {
    items: filtered,
    stats: {
      total: classified.length,
      installed: classified.length,
      recommended: recommendedCount,
      other: classified.length - recommendedCount,
      shown: filtered.length,
      view: selectedView,
    },
  };
}

export const __test__ = {
  isIgnoredPath,
  isIgnoredName,
  classifyTier,
  isSatelliteCliName,
  isBroadUserInstallPath,
  normalizeView,
  RECOMMENDED_CLI_NAMES,
  IGNORE_PATH_FRAGMENTS,
};

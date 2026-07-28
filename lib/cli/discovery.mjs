import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Curated catalog of AI / dev CLIs the gateway can surface and (re)install.
// `candidates` lists the binary names to look for on PATH plus common Windows
// install roots; discovery reports the first one that exists.
const CATALOG = [
  {
    name: "codex",
    title: "Codex CLI",
    category: "AI Agent",
    command: "codex",
    candidates: ["codex"],
    versionArgs: ["--version"],
  },
  {
    name: "claude",
    title: "Claude Code",
    category: "AI Agent",
    command: "claude",
    candidates: ["claude"],
    versionArgs: ["--version"],
  },
  {
    name: "gemini",
    title: "Gemini CLI",
    category: "AI Agent",
    command: "gemini",
    candidates: ["gemini"],
    versionArgs: ["--version"],
  },
  {
    name: "qwen",
    title: "Qwen Code",
    category: "AI Agent",
    command: "qwen",
    candidates: ["qwen"],
    versionArgs: ["--version"],
  },
  {
    name: "cursor",
    title: "Cursor CLI",
    category: "Editor",
    command: "cursor",
    candidates: ["cursor"],
    versionArgs: ["--version"],
  },
  {
    name: "node",
    title: "Node.js",
    category: "Runtime",
    command: "node",
    candidates: ["node"],
    versionArgs: ["--version"],
  },
  {
    name: "npm",
    title: "npm",
    category: "Package Manager",
    command: "npm",
    candidates: ["npm"],
    versionArgs: ["--version"],
  },
  {
    name: "pnpm",
    title: "pnpm",
    category: "Package Manager",
    command: "pnpm",
    candidates: ["pnpm"],
    versionArgs: ["--version"],
  },
  {
    name: "python",
    title: "Python",
    category: "Runtime",
    command: "python",
    candidates: ["python", "python3"],
    versionArgs: ["--version"],
  },
  {
    name: "pip",
    title: "pip",
    category: "Package Manager",
    command: "pip",
    candidates: ["pip", "pip3"],
    versionArgs: ["--version"],
  },
  {
    name: "git",
    title: "Git",
    category: "VCS",
    command: "git",
    candidates: ["git"],
    versionArgs: ["--version"],
  },
  {
    name: "gh",
    title: "GitHub CLI",
    category: "VCS",
    command: "gh",
    candidates: ["gh"],
    versionArgs: ["--version"],
  },
  {
    name: "uv",
    title: "uv",
    category: "Package Manager",
    command: "uv",
    candidates: ["uv"],
    versionArgs: ["--version"],
  },
  {
    name: "bun",
    title: "Bun",
    category: "Runtime",
    command: "bun",
    candidates: ["bun"],
    versionArgs: ["--version"],
  },
  {
    name: "docker",
    title: "Docker",
    category: "Container",
    command: "docker",
    candidates: ["docker"],
    versionArgs: ["--version"],
  },
];

const isWindows = process.platform === "win32";

function pathDirs() {
  const envPath = process.env.PATH || process.env.Path || "";
  const sep = isWindows ? ";" : ":";
  return envPath
    .split(sep)
    .map((p) => p.trim())
    .filter(Boolean);
}

function executableNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// Resolve a binary name to an absolute path using PATH + a few well-known roots.
// Returns null when not found.
function resolveBinary(name) {
  const dirs = pathDirs();
  const exts = isWindows ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch {
        // try next
      }
    }
  }
  // Windows: npm global bins live under AppData and Program Files.
  if (isWindows) {
    const extra = [
      path.join(os.homedir(), "AppData", "Roaming", "npm"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs"),
    ];
    for (const dir of extra) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // try next
        }
      }
    }
  }
  return null;
}

function probeVersion(binaryPath, args) {
  if (!binaryPath) return null;
  try {
    const out = execFileSync(binaryPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
      windowsHide: true,
    });
    return String(out).trim().split(/\r?\n/)[0].slice(0, 120) || null;
  } catch {
    return null;
  }
}

function matchesQuery(entry, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    entry.name.toLowerCase().includes(q) ||
    entry.title.toLowerCase().includes(q) ||
    entry.category.toLowerCase().includes(q)
  );
}

// Scan the curated catalog and report install status + version. Lightweight and
// best-effort: missing CLIs are still listed (as not installed) so users can
// install them from the page.
export function discoverInstalledClis({ query = "" } = {}) {
  const items = CATALOG.map((entry) => {
    let binaryPath = null;
    for (const candidate of entry.candidates) {
      binaryPath = resolveBinary(candidate);
      if (binaryPath) break;
    }
    const installed = Boolean(binaryPath);
    const version = installed ? probeVersion(binaryPath, entry.versionArgs) : null;
    return {
      name: entry.name,
      title: entry.title,
      category: entry.category,
      command: entry.command,
      installed,
      path: binaryPath || null,
      version: version || null,
    };
  });
  const filtered = items.filter((item) => matchesQuery(item, query));
  return {
    items: filtered,
    stats: {
      total: items.length,
      installed: items.filter((i) => i.installed).length,
      shown: filtered.length,
    },
  };
}

export function listCliCatalog() {
  return CATALOG.map((entry) => ({
    name: entry.name,
    title: entry.title,
    category: entry.category,
    command: entry.command,
  }));
}

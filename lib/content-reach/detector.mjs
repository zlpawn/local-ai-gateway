import { execSync, spawn } from "node:child_process";

/**
 * Agent Reach detector - check if agent-reach CLI is installed and get its status.
 *
 * Agent Reach is an external CLI tool (installed via uv/pipx).
 * We only read its output, never import or modify its source.
 *
 * Doctor is expensive (full multi-channel health checks). Callers should use:
 * - detectAgentReach() for instant install/version checks
 * - getDoctorSnapshot() for non-blocking channel status
 * - getDoctorReport({ force }) only when a full wait is required
 */

const DOCTOR_CACHE_TTL_MS = 60_000;
let doctorCache = null;
let doctorCacheAt = 0;
let doctorInflight = null;
let doctorLastError = "";

/**
 * Detect if agent-reach is installed and return its path + version.
 * @returns {{installed: true, path: string, version: string} | {installed: false}}
 */
export function detectAgentReach() {
  try {
    const version = execSync("agent-reach --version", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
    const whichCmd = process.platform === "win32" ? "where agent-reach" : "which agent-reach";
    const reachPath = execSync(whichCmd, {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }).trim().split("\n")[0];
    return { installed: true, path: reachPath, version };
  } catch {
    return { installed: false };
  }
}

function normalizeDoctorReport(result) {
  if (!result?.ok) {
    return null;
  }
  try {
    const data = JSON.parse(result.stdout);
    const channels = [];
    for (const [key, val] of Object.entries(data)) {
      if (val && typeof val === "object") {
        channels.push({
          name: key,
          status: val.status || "unknown",
          backend: val.active_backend || (val.backends && val.backends[0]) || "",
          auth_required: val.tier >= 1,
          display_name: val.name || key,
          message: val.message || "",
        });
      }
    }
    return { channels };
  } catch {
    return parseDoctorText(result.stdout);
  }
}

function startDoctorRefresh({ force = false } = {}) {
  if (doctorInflight) return doctorInflight;
  if (!force && doctorCache && Date.now() - doctorCacheAt < DOCTOR_CACHE_TTL_MS) {
    return Promise.resolve(doctorCache);
  }

  doctorLastError = "";
  doctorInflight = (async () => {
    const result = await runAgentReach(["doctor", "--json"], { timeoutMs: 20_000 });
    if (!result.ok) {
      doctorLastError = (result.stderr || result.stdout || "doctor failed").trim();
      // Keep previous cache if doctor fails/times out, so UI still has something.
      if (doctorCache) return doctorCache;
      return { channels: [] };
    }

    const report = normalizeDoctorReport(result) || { channels: [] };
    doctorCache = report;
    doctorCacheAt = Date.now();
    doctorLastError = "";
    return report;
  })();

  doctorInflight.finally(() => {
    doctorInflight = null;
  });

  return doctorInflight;
}

/**
 * Non-blocking doctor snapshot for UI.
 * - Returns cached channels immediately when available
 * - Kicks off a background refresh when cache is missing/stale or force=true
 * - Never waits for the expensive doctor command
 */
export function getDoctorSnapshot({ force = false } = {}) {
  const now = Date.now();
  const hasCache = Boolean(doctorCache);
  const fresh = hasCache && now - doctorCacheAt < DOCTOR_CACHE_TTL_MS;
  const refreshing = Boolean(doctorInflight);

  if (force || !fresh) {
    startDoctorRefresh({ force: force || !hasCache });
  }

  const report = doctorCache || { channels: [] };
  const channelsReady = hasCache;
  return {
    channels: report.channels || [],
    channels_ready: channelsReady,
    channels_refreshing: Boolean(doctorInflight),
    cached: hasCache,
    cache_age_ms: hasCache ? now - doctorCacheAt : null,
    last_error: doctorLastError || "",
  };
}

/**
 * Get the agent-reach doctor report (waits for completion unless cache is fresh).
 * @param {{force?: boolean}} opts
 * @returns {Promise<{channels: Array<{name, status, backend, auth_required}>}>}
 */
export async function getDoctorReport({ force = false } = {}) {
  if (!force && doctorCache && Date.now() - doctorCacheAt < DOCTOR_CACHE_TTL_MS) {
    return doctorCache;
  }
  return startDoctorRefresh({ force });
}

/**
 * Get a list of installed channel names.
 * @returns {Promise<string[]>}
 */
export async function getInstalledChannels() {
  const report = await getDoctorReport();
  return report.channels
    .filter((ch) => ch.status === "ok" || ch.status === "warn")
    .map((ch) => ch.name)
    .filter(Boolean);
}

/**
 * Invalidate doctor cache (e.g. after install/channel changes).
 */
export function invalidateDoctorCache() {
  doctorCache = null;
  doctorCacheAt = 0;
  doctorInflight = null;
  doctorLastError = "";
}

/**
 * Run agent-reach with given args, return stdout.
 * Note: child_process.spawn's `timeout` option is NOT a reliable wall-clock kill on all
 * Node versions/platforms; we implement an explicit timer + SIGTERM/SIGKILL.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
export function runAgentReach(args = [], { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const proc = spawn("agent-reach", args, {
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", () => finish({ ok: false, stdout: "", stderr: "spawn failed" }));

    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      // Windows often ignores SIGTERM for console tools; force-kill shortly after.
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        finish({ ok: false, stdout, stderr: (stderr || "") + "\nagent-reach timed out" });
      }, 1000);
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, stdout, stderr });
    });
  });
}

/**
 * Parse text output of `agent-reach doctor` (fallback when --json not supported).
 * Format: "ok  youtube      auth:none    yt-dlp 2026.07.04"
 */
function parseDoctorText(text) {
  const channels = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Match: <status>  <name>  auth:<auth>  <backend> <version>
    const match = trimmed.match(/^(\w+)\s+(\S+)\s+auth:(\S+)\s+(.+)$/);
    if (match) {
      channels.push({
        name: match[2],
        status: match[1],
        backend: match[4].split(/\s+/)[0] || "",
        auth_required: match[3] !== "none",
      });
    }
  }
  return { channels };
}

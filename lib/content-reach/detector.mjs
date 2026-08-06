import { execSync } from "node:child_process";

/**
 * Agent Reach detector - check if agent-reach CLI is installed and get its status.
 *
 * Agent Reach is an external CLI tool (installed via uv/pipx).
 * We only read its output, never import or modify its source.
 */

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
    }).trim();
    const whichCmd = process.platform === "win32" ? "where agent-reach" : "which agent-reach";
    const reachPath = execSync(whichCmd, {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n")[0];
    return { installed: true, path: reachPath, version };
  } catch {
    return { installed: false };
  }
}

/**
 * Get the agent-reach doctor report.
 * Returns installed channels with their status and active backend.
 * @returns {Promise<{channels: Array<{name, status, backend, auth_required}>}>}
 */
export async function getDoctorReport() {
  const result = await runAgentReach(["doctor", "--json"]);
  if (!result.ok) return { channels: [] };

  try {
    const data = JSON.parse(result.stdout);
    // doctor --json format: { channels: [{ name, status, backend, auth, ... }] }
    // or it might be a flat array - handle both
    const channels = Array.isArray(data) ? data : (data.channels || []);
    return {
      channels: channels.map((ch) => ({
        name: ch.name || ch.channel || "",
        status: ch.status || "unknown",
        backend: ch.backend || ch.active_backend || "",
        auth_required: ch.auth === "required" || ch.auth_required || false,
      })),
    };
  } catch {
    // doctor might not support --json in some versions, parse text output
    return parseDoctorText(result.stdout);
  }
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
 * Run agent-reach with given args, return stdout.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
export function runAgentReach(args = []) {
  return new Promise((resolve) => {
    import("node:child_process").then(({ spawn }) => {
      const proc = spawn("agent-reach", args, {
        timeout: 30000,
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => { stdout += d; });
      proc.stderr.on("data", (d) => { stderr += d; });
      proc.on("error", () => resolve({ ok: false, stdout: "", stderr: "spawn failed" }));
      proc.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
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

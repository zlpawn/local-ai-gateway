import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { CliError } from "../protocol.mjs";

const require = createRequire(import.meta.url);

function shellCommand(command) {
  const isWin = process.platform === "win32";
  return {
    file: isWin ? "cmd.exe" : "/bin/sh",
    args: isWin ? ["/d", "/s", "/c", command] : ["-c", command],
  };
}

function ensurePtyHelperExecutable() {
  try {
    const indexJs = require.resolve("node-pty");
    const helper = path.join(
      path.dirname(indexJs),
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    if (!fs.existsSync(helper)) return;
    const st = fs.statSync(helper);
    if (!(st.mode & 0o100)) fs.chmodSync(helper, st.mode | 0o111);
  } catch {
    // optional
  }
}

function loadNodePty() {
  ensurePtyHelperExecutable();
  try {
    return require("node-pty");
  } catch (error) {
    throw new CliError({
      type: "runtime",
      code: "pty_unavailable",
      message: `Interactive PTY install requires node-pty: ${error.message}`,
      hint: "Reinstall package dependencies, or omit --interactive for non-interactive install",
    });
  }
}

/**
 * Run an install command.
 *
 * modes:
 * - noninteractive (default): pipe capture, agent-safe, no stdin prompts
 * - interactive: local node-pty attached to current TTY (web-panel parity)
 */
export async function runInstallCommand(command, {
  interactive = false,
  cwd = os.homedir(),
  env = process.env,
  onChunk,
  timeoutMs = 0,
} = {}) {
  if (!command) {
    throw new CliError({
      type: "validation",
      code: "missing_fields",
      message: "command is required",
      fields: ["command"],
    });
  }

  if (interactive) {
    return runInteractivePty(command, { cwd, env, onChunk, timeoutMs });
  }
  return runNonInteractive(command, { cwd, env, onChunk, timeoutMs });
}

function runNonInteractive(command, { cwd, env, onChunk, timeoutMs }) {
  const { file, args } = shellCommand(command);
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...env, FORCE_COLOR: "0" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        try { child.kill(); } catch {}
        finish(124, "timeout");
      }, timeoutMs)
      : null;

    function finish(exitCode, reason = null) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        mode: "noninteractive",
        exitCode: Number.isFinite(exitCode) ? exitCode : 1,
        stdout,
        stderr,
        output: [stdout, stderr].filter(Boolean).join(""),
        reason,
      });
    }

    child.stdout?.on("data", (buf) => {
      const text = buf.toString();
      stdout += text;
      onChunk?.(text, "stdout");
    });
    child.stderr?.on("data", (buf) => {
      const text = buf.toString();
      stderr += text;
      onChunk?.(text, "stderr");
    });
    child.on("error", (error) => {
      stderr += String(error?.message || error);
      finish(1, "spawn_error");
    });
    child.on("exit", (code) => finish(code == null ? 1 : code));
  });
}

function runInteractivePty(command, { cwd, env, onChunk, timeoutMs }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError({
      type: "usage",
      code: "tty_required",
      message: "--interactive requires a real TTY",
      hint: "Run in a terminal, or omit --interactive for agent/non-interactive installs",
    });
  }

  const ptyLib = loadNodePty();
  const { file, args } = shellCommand(command);
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 24;

  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    let pty;
    try {
      pty = ptyLib.spawn(file, args, {
        name: "xterm-color",
        cols: Math.max(20, Math.min(400, cols)),
        rows: Math.max(5, Math.min(120, rows)),
        cwd,
        env: { ...env, FORCE_COLOR: "0", TERM: process.env.TERM || "xterm-256color" },
      });
    } catch (error) {
      reject(new CliError({
        type: "runtime",
        code: "pty_spawn_failed",
        message: error.message || String(error),
      }));
      return;
    }

    const wasRaw = process.stdin.isRaw;
    try {
      process.stdin.setRawMode?.(true);
    } catch {
      // ignore
    }
    process.stdin.resume();

    const onStdin = (chunk) => {
      try { pty.write(chunk.toString()); } catch {}
    };
    const onResize = () => {
      try {
        pty.resize(
          Math.max(20, Math.min(400, process.stdout.columns || 100)),
          Math.max(5, Math.min(120, process.stdout.rows || 24)),
        );
      } catch {}
    };

    process.stdin.on("data", onStdin);
    process.stdout.on?.("resize", onResize);

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        try { pty.kill(); } catch {}
      }, timeoutMs)
      : null;

    function cleanup() {
      process.stdin.off("data", onStdin);
      process.stdout.off?.("resize", onResize);
      try { process.stdin.setRawMode?.(Boolean(wasRaw)); } catch {}
      if (timer) clearTimeout(timer);
    }

    function finish(exitCode, reason = null) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        mode: "interactive",
        exitCode: Number.isFinite(exitCode) ? exitCode : 1,
        stdout: output,
        stderr: "",
        output,
        reason,
      });
    }

    pty.onData((data) => {
      output += data;
      try { process.stdout.write(data); } catch {}
      onChunk?.(data, "pty");
    });
    pty.onExit(({ exitCode }) => finish(exitCode == null ? 1 : exitCode));
  });
}

export function tailText(text = "", maxChars = 4000) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}
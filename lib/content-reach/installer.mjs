import { execSync, spawn } from "node:child_process";

/**
 * Agent Reach installer - helps users install agent-reach and its channels.
 *
 * Installation is a two-step process:
 * 1. uv tool install https://github.com/Panniantong/agent-reach/archive/main.zip
 * 2. agent-reach install --env=auto  (installs upstream CLI tools + channels)
 */

/**
 * Check if uv is available (preferred installer).
 */
export function detectUv() {
  try {
    execSync("uv --version", { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if pipx is available (alternative installer).
 */
export function detectPipx() {
  try {
    execSync("pipx --version", { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get installation hint for the user.
 * @returns {{available: boolean, tool: string, steps: string[], commands: string[]}}
 */
export function getInstallHint() {
  const hasUv = detectUv();
  const hasPipx = detectPipx();

  if (hasUv) {
    return {
      available: true,
      tool: "uv",
      steps: [
        "1. 安装 Agent Reach CLI",
        "2. 安装基础渠道 (YouTube, GitHub, RSS, Web 等)",
      ],
      commands: [
        "uv tool install https://github.com/Panniantong/agent-reach/archive/main.zip",
        "agent-reach install --env=auto",
      ],
    };
  }

  if (hasPipx) {
    return {
      available: true,
      tool: "pipx",
      steps: [
        "1. 安装 Agent Reach CLI",
        "2. 安装基础渠道 (YouTube, GitHub, RSS, Web 等)",
      ],
      commands: [
        "pipx install https://github.com/Panniantong/agent-reach/archive/main.zip",
        "agent-reach install --env=auto",
      ],
    };
  }

  return {
    available: false,
    tool: "none",
    steps: [
      "需要先安装 uv 或 pipx",
      "macOS: brew install uv",
      "Windows: scoop install uv",
      "Linux: pip install uv",
    ],
    commands: [],
  };
}

/**
 * Install Agent Reach CLI + basic channels.
 * This is a long-running operation - should be called as a background task.
 *
 * @param {{onProgress?: Function, signal?: AbortSignal}} opts
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function installAgentReach({ onProgress, signal } = {}) {
  const hint = getInstallHint();
  if (!hint.available) {
    return {
      success: false,
      message: `未检测到 uv 或 pipx。请先安装: ${hint.steps.join("; ")}`,
    };
  }

  // Step 1: Install agent-reach CLI
  onProgress?.(0.1, "安装 Agent Reach CLI...");
  const installCmd = hint.tool === "uv"
    ? "uv tool install https://github.com/Panniantong/agent-reach/archive/main.zip"
    : "pipx install https://github.com/Panniantong/agent-reach/archive/main.zip";

  const step1 = await runCommand(installCmd, { signal });
  if (!step1.ok) {
    return {
      success: false,
      message: `安装 Agent Reach CLI 失败: ${step1.stderr || step1.stdout}`,
    };
  }

  // Step 2: Install basic channels
  onProgress?.(0.5, "安装基础渠道...");
  const step2 = await runCommand("agent-reach install --env=auto", { signal });
  if (!step2.ok) {
    return {
      success: false,
      message: `安装基础渠道失败: ${step2.stderr || step2.stdout}`,
    };
  }

  onProgress?.(1.0, "安装完成");
  return {
    success: true,
    message: "Agent Reach 安装成功，基础渠道已就绪",
  };
}

/**
 * Install additional channels (e.g. twitter, xiaohongshu, bilibili).
 *
 * @param {string[]} channels - Channel names to install
 * @param {{onProgress?: Function, signal?: AbortSignal}} opts
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function installChannels(channels, { onProgress, signal } = {}) {
  if (!channels || channels.length === 0) {
    return { success: false, message: "No channels specified" };
  }

  const channelStr = channels.join(",");
  onProgress?.(0.1, `安装渠道: ${channelStr}`);

  const result = await runCommand(
    `agent-reach install --env=auto --channels=${channelStr}`,
    { signal },
  );

  if (!result.ok) {
    return {
      success: false,
      message: `渠道安装失败: ${result.stderr || result.stdout}`,
    };
  }

  onProgress?.(1.0, "渠道安装完成");
  return {
    success: true,
    message: `渠道安装成功: ${channelStr}`,
  };
}

/**
 * Run a shell command and return output.
 */
function runCommand(command, { signal } = {}) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWin ? ["/c", command] : ["-c", command];

    const proc = spawn(shell, shellArgs, {
      timeout: 300000, // 5 min max
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("error", () => resolve({ ok: false, stdout: "", stderr: "spawn failed" }));

    const abortHandler = () => {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    };
    if (signal) {
      if (signal.aborted) proc.kill("SIGTERM");
      else signal.addEventListener("abort", abortHandler, { once: true });
    }

    proc.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", abortHandler);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

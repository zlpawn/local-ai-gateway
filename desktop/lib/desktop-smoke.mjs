import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export function findDesktopExecutable(rootDir, platform = process.platform) {
  if (platform === "win32") {
    return path.join(rootDir, "dist", "win-unpacked", "Local AI Gateway.exe");
  }

  if (platform === "darwin") {
    return path.join(
      rootDir,
      "dist",
      "mac",
      "Local AI Gateway.app",
      "Contents",
      "MacOS",
      "Local AI Gateway",
    );
  }

  throw new Error(`Desktop smoke test is not configured for platform: ${platform}`);
}

export function getDefaultSmokePort() {
  return 18787;
}

export async function findAvailablePort(preferredPort = getDefaultSmokePort()) {
  if (await isPortFree(preferredPort)) return preferredPort;

  for (let port = preferredPort + 1; port < preferredPort + 100; port += 1) {
    if (await isPortFree(port)) return port;
  }

  throw new Error(`No free smoke test port found near ${preferredPort}`);
}

export async function runDesktopSmoke(rootDir, options = {}) {
  const platform = options.platform || process.platform;
  const executable = options.executable || findDesktopExecutable(rootDir, platform);
  if (!fs.existsSync(executable)) {
    throw new Error(`Desktop executable not found: ${executable}`);
  }

  const port = options.port || (await findAvailablePort());
  const child = spawn(executable, [], {
    cwd: rootDir,
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
    },
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    await waitForHealth(port, options.timeoutMs || 15000);
  } finally {
    child.kill();
    await waitForExit(child, 5000);
  }

  await waitForPortClosed(port, 8000);
  return { port, pid: child.pid };
}

async function waitForHealth(port, timeoutMs) {
  const started = Date.now();
  let lastError = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1200),
      });
      const health = await response.json();
      if (response.ok && health.ok) return health;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error.message;
    }
    await delay(350);
  }

  throw new Error(`Desktop smoke health check failed on port ${port}: ${lastError || "timeout"}`);
}

async function waitForPortClosed(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isPortFree(port)) return;
    await delay(350);
  }
  throw new Error(`Desktop smoke port ${port} is still listening after app exit`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

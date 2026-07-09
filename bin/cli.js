#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRootDir = path.resolve(__dirname, "..");
const serverPath = path.join(packageRootDir, "server.js");

const dataDir = path.join(os.homedir(), ".local-ai-gateway");
const pidFile = path.join(dataDir, "gateway.pid");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Copy default configurations if they don't exist
const filesToCopy = ["gateway.config.json", "models.json"];
for (const file of filesToCopy) {
  const destPath = path.join(dataDir, file);
  if (!fs.existsSync(destPath)) {
    const srcPath = path.join(packageRootDir, file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Set default env vars for the server
process.env.GATEWAY_CONFIG_FILE = path.join(dataDir, "gateway.config.json");
process.env.MODEL_MAP_FILE = path.join(dataDir, "models.json");
process.env.LOG_FILE = path.join(dataDir, "gateway.log");

// Load .env from dataDir if it exists, otherwise copy from package root
const dotEnvDest = path.join(dataDir, ".env");
if (!fs.existsSync(dotEnvDest)) {
  const dotEnvSrc = path.join(packageRootDir, ".env");
  if (fs.existsSync(dotEnvSrc)) {
    fs.copyFileSync(dotEnvSrc, dotEnvDest);
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function getRunningPid() {
  if (fs.existsSync(pidFile)) {
    const pidStr = fs.readFileSync(pidFile, "utf8").trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid) && isProcessRunning(pid)) {
      return pid;
    }
    // Clean up stale pid file
    try {
      fs.unlinkSync(pidFile);
    } catch {}
  }
  return null;
}

const args = process.argv.slice(2);
const command = args[0];

if (command === "start") {
  const runningPid = getRunningPid();
  if (runningPid) {
    console.log(`Gateway is already running in the background (PID: ${runningPid}).`);
    process.exit(0);
  }

  const logFile = path.join(dataDir, "gateway.stdout.log");
  const errFile = path.join(dataDir, "gateway.stderr.log");
  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(errFile, "a");

  console.log("Starting gateway in the background...");
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ["ignore", out, err],
    env: {
      ...process.env
    }
  });

  child.unref();

  fs.writeFileSync(pidFile, String(child.pid), "utf8");
  console.log(`Gateway successfully started in background (PID: ${child.pid}).`);
  
  // Wait a moment and check health
  setTimeout(async () => {
    try {
      // Read port from configuration
      let port = 8787;
      const configPath = process.env.GATEWAY_CONFIG_FILE;
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (config.server?.port) {
          port = config.server.port;
        }
      }
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const status = await res.json();
      console.log(`Health Check: ok=${status.ok}, upstream=${status.upstream}`);
    } catch (e) {
      console.log("Health Check: Waiting for server to initialize...");
    }
    process.exit(0);
  }, 1200);

} else if (command === "stop") {
  const runningPid = getRunningPid();
  if (!runningPid) {
    console.log("Gateway is not running.");
    process.exit(0);
  }

  console.log(`Stopping gateway (PID: ${runningPid})...`);
  try {
    process.kill(runningPid, "SIGTERM");
    // Wait a brief moment for the process to exit
    let attempts = 0;
    while (isProcessRunning(runningPid) && attempts < 10) {
      // Sync sleep helper
      const limit = Date.now() + 100;
      while (Date.now() < limit) {}
      attempts++;
    }
    if (isProcessRunning(runningPid)) {
      process.kill(runningPid, "SIGKILL");
    }
    console.log("Gateway stopped.");
  } catch (err) {
    console.error(`Failed to stop gateway: ${err.message}`);
  } finally {
    try {
      fs.unlinkSync(pidFile);
    } catch {}
  }
  process.exit(0);

} else if (command === "status") {
  const runningPid = getRunningPid();
  if (runningPid) {
    console.log(`Gateway is running in the background (PID: ${runningPid}).`);
    // Print health details
    (async () => {
      try {
        let port = 8787;
        const configPath = process.env.GATEWAY_CONFIG_FILE;
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
          if (config.server?.port) {
            port = config.server.port;
          }
        }
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        const status = await res.json();
        console.log(`Health: ok=${status.ok}`);
        console.log(`Upstream: ${status.upstream}`);
      } catch {
        console.log("Health: unreachable");
      }
      process.exit(0);
    })();
  } else {
    console.log("Gateway is not running.");
    process.exit(0);
  }

} else if (command === "restart") {
  const runningPid = getRunningPid();
  if (runningPid) {
    console.log(`Stopping current instance (PID: ${runningPid})...`);
    try {
      process.kill(runningPid, "SIGTERM");
      let attempts = 0;
      while (isProcessRunning(runningPid) && attempts < 10) {
        const limit = Date.now() + 100;
        while (Date.now() < limit) {}
        attempts++;
      }
      if (isProcessRunning(runningPid)) {
        process.kill(runningPid, "SIGKILL");
      }
    } catch {}
    try {
      fs.unlinkSync(pidFile);
    } catch {}
  }

  // Start logic
  const logFile = path.join(dataDir, "gateway.stdout.log");
  const errFile = path.join(dataDir, "gateway.stderr.log");
  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(errFile, "a");

  console.log("Restarting gateway in background...");
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ["ignore", out, err],
    env: {
      ...process.env
    }
  });

  child.unref();
  fs.writeFileSync(pidFile, String(child.pid), "utf8");
  console.log(`Gateway successfully started in background (PID: ${child.pid}).`);
  process.exit(0);

} else {
  // Default: Foreground startup (allows browser auto-open and log streaming)
  import("../server.js").catch((err) => {
    console.error("Failed to start gateway server:", err);
    process.exit(1);
  });
}

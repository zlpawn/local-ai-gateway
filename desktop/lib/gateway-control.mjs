import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import path from "node:path";

const SECRET_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "x-api-key",
  "token",
  "bearer",
  "cookie",
]);

export async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export async function getGatewayPort(rootDir, env = process.env) {
  const envPort = parsePort(env.GATEWAY_PORT || env.PORT);
  if (envPort) return envPort;

  const dotEnv = await readDotEnvFile(path.join(rootDir, ".env"));
  const dotEnvPort = parsePort(dotEnv.GATEWAY_PORT || dotEnv.PORT);
  if (dotEnvPort) return dotEnvPort;

  const configPath = resolveConfigPath(rootDir, env.GATEWAY_CONFIG_FILE);
  try {
    const config = await readJsonFile(configPath);
    const configPort = parsePort(config?.server?.port);
    if (configPort) return configPort;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  return 8787;
}

export function buildGatewayEnvironment(rootDir, baseEnv = process.env, dataDir = rootDir) {
  const env = { ...baseEnv };
  env.GATEWAY_CONFIG_FILE ||= path.join(dataDir, "gateway.config.json");
  env.LOG_FILE ||= path.join(dataDir, "gateway.log");

  if (
    env.HTTPS_PROXY ||
    env.HTTP_PROXY ||
    env.ALL_PROXY ||
    env.https_proxy ||
    env.http_proxy ||
    env.all_proxy
  ) {
    env.NODE_USE_ENV_PROXY ||= "1";
  } else {
    env.NODE_USE_ENV_PROXY ||= "1";
  }

  return env;
}

export function maskConfigSecrets(value) {
  if (Array.isArray(value)) {
    return value.map((item) => maskConfigSecrets(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const masked = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key) && typeof child === "string" && child) {
      masked[key] = "********";
    } else {
      masked[key] = maskConfigSecrets(child);
    }
  }
  return masked;
}

export function startGatewayProcess(rootDir, options = {}) {
  const serverPath = path.join(rootDir, "server.js");
  if (!fsSync.existsSync(serverPath)) {
    throw new Error(`Gateway server not found: ${serverPath}`);
  }

  const env = buildGatewayEnvironment(rootDir, options.env || process.env, options.dataDir || rootDir);
  const executable = options.executable || process.execPath;
  const args = [];

  if (options.electronRunAsNode !== false) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  if (supportsUseEnvProxyFlag()) {
    args.push("--use-env-proxy");
  }
  args.push(serverPath);

  return spawn(executable, args, {
    cwd: rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

export async function fetchJson(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function readTextTail(filePath, maxBytes = 120000) {
  try {
    const stat = await fs.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export async function readDotEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const result = {};
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      result[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
    return result;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function parsePort(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function resolveConfigPath(rootDir, configFile) {
  if (!configFile) return path.join(rootDir, "gateway.config.json");
  return path.isAbsolute(configFile) ? configFile : path.join(rootDir, configFile);
}

function isSecretKey(key) {
  const normalized = key.toLowerCase();
  return SECRET_KEYS.has(normalized) || normalized.endsWith("_api_key") || normalized.endsWith("_token");
}

function supportsUseEnvProxyFlag() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  return Number.isInteger(major) && major >= 24;
}

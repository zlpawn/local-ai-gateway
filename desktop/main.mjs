import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchJson,
  getGatewayPort,
  isPortFree,
  maskConfigSecrets,
  readDotEnvFile,
  readJsonFile,
  readTextTail,
  startGatewayProcess,
} from "./lib/gateway-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, "..");
const DATA_DIR = app.getPath("userData");
const RENDERER_PATH = path.join(__dirname, "renderer", "index.html");
const PRELOAD_PATH = path.join(__dirname, "preload.cjs");
const STDOUT_LOG = path.join(DATA_DIR, "gateway.stdout.log");
const STDERR_LOG = path.join(DATA_DIR, "gateway.stderr.log");
const GATEWAY_LOG = path.join(DATA_DIR, "gateway.log");

let mainWindow = null;
let gatewayProcess = null;
let lastExit = null;
let isQuitting = false;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: "Local AI Gateway",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadFile(RENDERER_PATH);
}

async function ensureConfigFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await copyFirstExistingIfMissing([".env", ".env.example"], ".env");
  await copyFirstExistingIfMissing(["gateway.config.json", "gateway.config.example.json"], "gateway.config.json");
  await copyFirstExistingIfMissing(["models.json"], "models.json");
}

async function copyFirstExistingIfMissing(sourceNames, targetName) {
  const target = path.join(DATA_DIR, targetName);
  if (fsSync.existsSync(target)) return;
  for (const sourceName of sourceNames) {
    const source = path.join(APP_ROOT, sourceName);
    if (!fsSync.existsSync(source)) continue;
    await fs.copyFile(source, target);
    return;
  }
}

async function startGateway() {
  if (gatewayProcess && !gatewayProcess.killed) {
    return getState();
  }

  await ensureConfigFiles();
  lastExit = null;
  await fs.writeFile(STDOUT_LOG, "", "utf8");
  await fs.writeFile(STDERR_LOG, "", "utf8");

  const port = await getGatewayPort(DATA_DIR);
  if (!(await isPortFree(port))) {
    throw new Error(`Port ${port} is already in use. Stop the other gateway or change the desktop config port.`);
  }

  const dotEnv = await readDotEnvFile(path.join(DATA_DIR, ".env"));
  gatewayProcess = startGatewayProcess(APP_ROOT, {
    dataDir: DATA_DIR,
    env: {
      ...dotEnv,
      ...process.env,
      GATEWAY_CONFIG_FILE: path.join(DATA_DIR, "gateway.config.json"),
      MODEL_MAP_FILE: path.join(DATA_DIR, "models.json"),
      LOG_FILE: GATEWAY_LOG,
    },
  });
  gatewayProcess.stdout?.on("data", (chunk) => appendLog(STDOUT_LOG, chunk));
  gatewayProcess.stderr?.on("data", (chunk) => appendLog(STDERR_LOG, chunk));
  gatewayProcess.on("exit", (code, signal) => {
    lastExit = { code, signal, at: new Date().toISOString() };
    gatewayProcess = null;
    pushState();
  });
  gatewayProcess.on("error", (error) => {
    lastExit = { error: error.message, at: new Date().toISOString() };
    gatewayProcess = null;
    pushState();
  });

  await waitForHealth(8000);
  return getState();
}

async function stopGateway() {
  if (!gatewayProcess) return getState();

  const child = gatewayProcess;
  gatewayProcess = null;
  child.kill();

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 1800);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  return getState();
}

async function restartGateway() {
  await stopGateway();
  return startGateway();
}

async function getState() {
  const port = await getGatewayPort(DATA_DIR);
  const healthUrl = `http://127.0.0.1:${port}/health`;
  let health = null;
  let healthError = null;

  try {
    health = await fetchJson(healthUrl, 1200);
  } catch (error) {
    healthError = error.message;
  }

  return {
    root: APP_ROOT,
    dataDir: DATA_DIR,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    running: Boolean(gatewayProcess),
    pid: gatewayProcess?.pid || null,
    lastExit,
    health,
    healthError,
  };
}

async function waitForHealth(timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    const state = await getState();
    if (state.health?.ok) return;
    lastError = state.healthError;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`Gateway process started but health check failed: ${lastError || "timeout"}`);
}

function appendLog(filePath, chunk) {
  fs.appendFile(filePath, chunk).catch(() => {});
  mainWindow?.webContents.send("gateway:log-data", {
    stream: path.basename(filePath),
    text: chunk.toString("utf8"),
  });
}

async function pushState() {
  if (!mainWindow) return;
  mainWindow.webContents.send("gateway:state", await getState());
}

ipcMain.handle("gateway:get-state", () => getState());
ipcMain.handle("gateway:start", () => startGateway());
ipcMain.handle("gateway:stop", () => stopGateway());
ipcMain.handle("gateway:restart", () => restartGateway());

ipcMain.handle("gateway:get-models", async () => {
  const port = await getGatewayPort(DATA_DIR);
  return fetchJson(`http://127.0.0.1:${port}/v1/models`, 3000);
});

ipcMain.handle("gateway:get-providers", async () => {
  const port = await getGatewayPort(DATA_DIR);
  return fetchJson(`http://127.0.0.1:${port}/v1/providers`, 3000);
});

ipcMain.handle("config:read", async () => {
  const filePath = path.join(DATA_DIR, "gateway.config.json");
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = await readJsonFile(filePath);
  return {
    filePath,
    raw,
    masked: maskConfigSecrets(parsed),
  };
});

ipcMain.handle("config:save", async (_event, raw) => {
  JSON.parse(raw);
  await fs.writeFile(path.join(DATA_DIR, "gateway.config.json"), raw.trim() + "\n", "utf8");
  return configSavedResponse();
});

ipcMain.handle("logs:read", async () => ({
  stdout: await readTextTail(STDOUT_LOG),
  stderr: await readTextTail(STDERR_LOG),
  gateway: await readTextTail(GATEWAY_LOG),
}));

ipcMain.handle("app:open-path", async (_event, targetPath) => {
  const resolved = path.resolve(targetPath || "");
  const allowed = [APP_ROOT, DATA_DIR].some((basePath) => {
    const relative = path.relative(basePath, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!allowed) {
    throw new Error("Path is outside the gateway directory.");
  }
  await shell.openPath(targetPath);
  return true;
});

async function configSavedResponse() {
  return {
    ok: true,
    state: await getState(),
  };
}

app.on("before-quit", async (event) => {
  if (isQuitting || !gatewayProcess) return;
  isQuitting = true;
  event.preventDefault();
  await stopGateway();
  app.quit();
});

app.whenReady().then(async () => {
  await createWindow();
  try {
    await startGateway();
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Gateway did not start",
      message: error.message,
    });
  }
  pushState();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().then(pushState);
  }
});

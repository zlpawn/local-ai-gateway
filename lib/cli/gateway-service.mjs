import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_PORT = 8787;
const COMMANDS = new Set([
  "start",
  "stop",
  "restart",
  "status",
  "logs",
  "stdout",
  "stderr",
  "path",
  "help",
]);

export function parseGatewayArgs(args) {
  const command = args[0] && !args[0].startsWith("-") ? args[0] : "help";
  if (!COMMANDS.has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const options = {
    command,
    rootDir: valueAfter(args, "--root"),
    runtimeDir: valueAfter(args, "--runtime-dir"),
    port: parsePort(valueAfter(args, "--port")),
    force: args.includes("--force"),
    testMode: args.includes("--test"),
  };
  if (valueAfter(args, "--port") && !options.port) {
    throw new Error("--port must be an integer between 1 and 65535.");
  }
  return options;
}

export async function resolveGatewayPort(
  rootDir,
  { cliPort = 0, testMode = false, env = process.env } = {},
) {
  if (parsePort(cliPort)) return parsePort(cliPort);
  if (testMode) return 8788;
  if (parsePort(env.GATEWAY_PORT || env.PORT)) {
    return parsePort(env.GATEWAY_PORT || env.PORT);
  }

  const dotEnv = await readDotEnv(path.join(rootDir, ".env"));
  if (parsePort(dotEnv.GATEWAY_PORT || dotEnv.PORT)) {
    return parsePort(dotEnv.GATEWAY_PORT || dotEnv.PORT);
  }

  const configPath = resolveConfigPath(rootDir, env.GATEWAY_CONFIG_FILE);
  try {
    const config = JSON.parse((await fs.readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
    if (parsePort(config?.server?.port)) return parsePort(config.server.port);
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return DEFAULT_PORT;
}

export function buildRuntimePaths(runtimeDir) {
  const resolved = path.resolve(runtimeDir);
  return {
    runtimeDir: resolved,
    pidFile: path.join(resolved, "gateway.pid.json"),
    legacyPidFile: path.join(resolved, "gateway.pid"),
    stdoutLog: path.join(resolved, "gateway.stdout.log"),
    stderrLog: path.join(resolved, "gateway.stderr.log"),
    appLog: path.join(resolved, "gateway.log"),
  };
}

export function buildGatewayEnvironment(rootDir, options) {
  const {
    baseEnv = process.env,
    port,
    instanceId,
    configPath = resolveConfigPath(rootDir, baseEnv.GATEWAY_CONFIG_FILE),
    runtimeDir,
    testMode = false,
  } = options;
  const env = {
    ...baseEnv,
    GATEWAY_CONFIG_FILE: path.resolve(configPath),
    GATEWAY_INSTANCE_ID: instanceId,
    GATEWAY_NO_OPEN: "1",
    GATEWAY_PORT: String(port),
    LOG_FILE: path.join(path.resolve(runtimeDir), "gateway.log"),
  };

  if (testMode) env.NODE_ENV = "test";
  if (testMode || String(env.NODE_ENV).toLowerCase() === "test") {
    env.CLAUDE_3P_SYNC_DISABLED = "1";
    env.CLAUDE_CODE_SYNC_DISABLED = "1";
    env.CODEX_WRITE_MODEL_CATALOG_DISABLED = "1";
  }
  if (hasProxy(env)) env.NODE_USE_ENV_PROXY ||= "1";
  return normalizeWindowsEnvironment(env);
}

export function pidMetadataMatchesHealth(metadata, health) {
  return Boolean(
    metadata
    && health?.ok
    && metadata.instanceId
    && health.instance_id === metadata.instanceId,
  );
}

export function legacyPidMatchesHealth(health) {
  return Boolean(
    health?.ok
    && typeof health.client === "string"
    && typeof health.protocol === "string"
    && Array.isArray(health.models),
  );
}

export function metadataMatchesHealth(metadata, health) {
  return metadata?.legacy
    ? legacyPidMatchesHealth(health)
    : pidMetadataMatchesHealth(metadata, health);
}

export function recoverMetadataFromHealth(port, health) {
  if (
    health?.ok
    && health.service === "local-ai-gateway"
    && Number.isInteger(health.process_id)
    && health.process_id > 0
    && typeof health.instance_id === "string"
    && health.instance_id
  ) {
    return {
      pid: health.process_id,
      port,
      instanceId: health.instance_id,
      recovered: true,
    };
  }
  return null;
}

export function parseListeningPid(output, port, platform = process.platform) {
  if (platform === "win32") {
    for (const line of String(output || "").split(/\r?\n/)) {
      const match = line.match(
        /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i,
      );
      if (match && Number(match[2]) === port) return Number(match[3]);
    }
    return 0;
  }

  const pid = Number.parseInt(String(output || "").trim().split(/\s+/)[0] || "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

export async function runGatewayCommand(options, io = console) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const runtimeDir = path.resolve(
    options.runtimeDir || (options.testMode ? path.join(rootDir, ".gateway-test") : rootDir),
  );
  const paths = buildRuntimePaths(runtimeDir);
  const port = await resolveGatewayPort(rootDir, {
    cliPort: options.port,
    testMode: options.testMode,
    env: process.env,
  });
  const context = { ...options, rootDir, runtimeDir, paths, port, io };

  switch (options.command) {
    case "start":
      return startGateway(context);
    case "stop":
      return stopGateway(context);
    case "restart":
      await stopGateway(context);
      return startGateway(context);
    case "status":
      return showStatus(context);
    case "logs":
      return showLog(paths.appLog, io);
    case "stdout":
      return showLog(paths.stdoutLog, io);
    case "stderr":
      return showLog(paths.stderrLog, io);
    case "path":
      io.log(rootDir);
      return;
    default:
      printUsage(io);
  }
}

export function printUsage(io = console) {
  io.log(`Usage: local-ai-gateway <command> [options]

Commands:
  start      Start gateway in background
  stop       Stop the managed gateway
  restart    Restart the managed gateway
  status     Show gateway status
  logs       Show recent application logs
  stdout     Show recent process stdout
  stderr     Show recent process stderr
  path       Print project path

Options:
  --port <port>          Override the configured port
  --root <directory>     Gateway project directory
  --runtime-dir <path>   PID and log directory
  --test                 Use port 8788 and disable client config sync`);
}

async function startGateway(context) {
  const { rootDir, paths, port, io } = context;
  const serverPath = path.join(rootDir, "server.js");
  if (!fsSync.existsSync(serverPath)) {
    throw new Error(`Gateway server not found: ${serverPath}`);
  }
  await fs.mkdir(paths.runtimeDir, { recursive: true });

  const existing = await readPidMetadata(paths.pidFile);
  if (existing && isProcessRunning(existing.pid)) {
    const health = await fetchHealth(existing.port || port);
    if (metadataMatchesHealth(existing, health)) {
      io.log(`Gateway already running on 127.0.0.1:${existing.port || port} (PID: ${existing.pid}).`);
      return existing;
    }
    throw new Error(`PID file points to another process (${existing.pid}); remove ${paths.pidFile} after verifying it is stale.`);
  }
  const legacy = await readLegacyPid(paths.legacyPidFile, port);
  if (legacy && isProcessRunning(legacy.pid)) {
    const health = await fetchHealth(port);
    if (legacyPidMatchesHealth(health)) {
      io.log(`Gateway already running on 127.0.0.1:${port} (legacy PID: ${legacy.pid}).`);
      return legacy;
    }
    throw new Error(`Legacy PID file points to another process (${legacy.pid}); remove ${paths.legacyPidFile} after verifying it is stale.`);
  }
  await removeFile(paths.legacyPidFile);
  await removeFile(paths.pidFile);

  const occupiedHealth = await fetchHealth(port);
  const recovered = recoverMetadataFromHealth(port, occupiedHealth);
  if (recovered && isProcessRunning(recovered.pid)) {
    await fs.writeFile(paths.pidFile, `${JSON.stringify(recovered, null, 2)}\n`, "utf8");
    io.log(`Gateway already running on 127.0.0.1:${port} (PID: ${recovered.pid}).`);
    return recovered;
  }
  if (legacyPidMatchesHealth(occupiedHealth)) {
    const listenerPid = await findListeningPid(port);
    if (listenerPid && isProcessRunning(listenerPid)) {
      const legacyMetadata = { pid: listenerPid, port, legacy: true, recovered: true };
      await fs.writeFile(paths.pidFile, `${JSON.stringify(legacyMetadata, null, 2)}\n`, "utf8");
      io.log(`Gateway already running on 127.0.0.1:${port} (PID: ${listenerPid}).`);
      return legacyMetadata;
    }
  }
  if (occupiedHealth?.ok) {
    throw new Error(`Port ${port} already has a gateway that is not managed by ${paths.pidFile}.`);
  }
  if (!(await isPortFree(port))) {
    throw new Error(`Port ${port} is already in use.`);
  }

  const instanceId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const env = buildGatewayEnvironment(rootDir, {
    port,
    instanceId,
    runtimeDir: paths.runtimeDir,
    testMode: context.testMode,
  });
  const stdout = fsSync.openSync(paths.stdoutLog, "a");
  const stderr = fsSync.openSync(paths.stderrLog, "a");
  const nodeArgs = supportsUseEnvProxyFlag() ? ["--use-env-proxy", serverPath] : [serverPath];
  const child = spawn(process.execPath, nodeArgs, {
    cwd: rootDir,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
    env,
  });
  child.unref();
  fsSync.closeSync(stdout);
  fsSync.closeSync(stderr);

  const metadata = {
    pid: child.pid,
    port,
    instanceId,
    rootDir,
    startedAt: new Date().toISOString(),
  };
  await fs.writeFile(paths.pidFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  const health = await waitForMatchingHealth(metadata, 10_000);
  if (!health) {
    await terminateProcess(child.pid);
    await removeFile(paths.pidFile);
    throw new Error(`Gateway failed to become healthy on port ${port}. Check ${paths.stderrLog}.`);
  }
  io.log(`Gateway started on 127.0.0.1:${port} (PID: ${child.pid}).`);
  return metadata;
}

async function stopGateway(context) {
  const { paths, io, force } = context;
  let metadata = await readPidMetadata(paths.pidFile)
    || await readLegacyPid(paths.legacyPidFile, context.port);
  if (!metadata) {
    const health = await fetchHealth(context.port);
    metadata = recoverMetadataFromHealth(context.port, health);
    if (!metadata && legacyPidMatchesHealth(health)) {
      const pid = await findListeningPid(context.port);
      if (pid) metadata = { pid, port: context.port, legacy: true, recovered: true };
    }
  }
  if (!metadata) {
    io.log("Gateway is not running.");
    return;
  }
  if (!isProcessRunning(metadata.pid)) {
    await removeFile(paths.pidFile);
    io.log("Gateway is not running.");
    return;
  }

  const health = await fetchHealth(metadata.port);
  const matches = metadataMatchesHealth(metadata, health);
  if (!matches && !force) {
    throw new Error(
      `Refusing to stop PID ${metadata.pid}: the health endpoint does not match this managed instance. Use --force only after verifying the PID.`,
    );
  }

  await terminateProcess(metadata.pid);
  await removeFile(paths.pidFile);
  await removeFile(paths.legacyPidFile);
  io.log(`Gateway stopped (PID: ${metadata.pid}).`);
}

async function showStatus(context) {
  const { paths, port, io } = context;
  let metadata = await readPidMetadata(paths.pidFile)
    || await readLegacyPid(paths.legacyPidFile, port);
  if (!metadata) {
    const health = await fetchHealth(port);
    metadata = recoverMetadataFromHealth(port, health);
    if (!metadata && legacyPidMatchesHealth(health)) {
      const pid = await findListeningPid(port);
      if (pid) metadata = { pid, port, legacy: true, recovered: true };
    }
  }
  const health = await fetchHealth(metadata?.port || port);
  const matches = metadataMatchesHealth(metadata, health);
  if (!metadata || !isProcessRunning(metadata.pid) || !matches) {
    io.log(`Gateway is not running on 127.0.0.1:${metadata?.port || port}.`);
    return { running: false };
  }
  io.log(`Gateway listening on 127.0.0.1:${metadata.port}`);
  io.log(`PID: ${metadata.pid}`);
  io.log(`Health: ok=${health.ok}`);
  io.log(`Models: ${(health.models || []).join(", ")}`);
  return { running: true, metadata, health };
}

async function showLog(filePath, io) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    io.log(content.split(/\r?\n/).slice(-81).join(os.EOL));
  } catch (error) {
    if (error.code === "ENOENT") {
      io.log(`Log file not found: ${filePath}`);
      return;
    }
    throw error;
  }
}

async function waitForMatchingHealth(metadata, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(metadata.pid)) return null;
    const health = await fetchHealth(metadata.port);
    if (pidMetadataMatchesHealth(metadata, health)) return health;
    await delay(100);
  }
  return null;
}

async function fetchHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function readPidMetadata(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function readLegacyPid(filePath, port) {
  try {
    const pid = Number.parseInt((await fs.readFile(filePath, "utf8")).trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, port, legacy: true };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return processProbeIndicatesRunning(error);
  }
}

export function processProbeIndicatesRunning(error) {
  return !error || error.code === "EPERM";
}

async function terminateProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await delay(100);
  }

  if (process.platform === "win32") {
    await new Promise((resolve, reject) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", reject);
      killer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`taskkill exited with ${code}`)));
    });
  } else {
    process.kill(pid, "SIGKILL");
  }
}

async function findListeningPid(port) {
  if (process.platform === "win32") {
    const result = await collectCommand("netstat", ["-ano", "-p", "TCP"]);
    return result.code === 0 ? parseListeningPid(result.stdout, port, "win32") : 0;
  }

  const lsof = await collectCommand("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]);
  if (lsof.code === 0) return parseListeningPid(lsof.stdout, port, process.platform);

  if (process.platform === "linux") {
    const ss = await collectCommand("ss", ["-H", "-ltnp", `sport = :${port}`]);
    const match = ss.stdout.match(/pid=(\d+)/);
    return match ? Number(match[1]) : 0;
  }
  return 0;
}

function collectCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolve({ code: -1, stdout, stderr, error }));
    child.once("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    import("node:net").then(({ default: net }) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "127.0.0.1");
    });
  });
}

async function readDotEnv(filePath) {
  try {
    const result = {};
    for (const line of (await fs.readFile(filePath, "utf8")).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match) result[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
    return result;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function resolveConfigPath(rootDir, configured) {
  if (!configured) return path.join(rootDir, "gateway.config.json");
  return path.isAbsolute(configured) ? configured : path.join(rootDir, configured);
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

function parsePort(value) {
  const port = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function hasProxy(env) {
  return Boolean(
    env.HTTPS_PROXY
    || env.HTTP_PROXY
    || env.ALL_PROXY
    || env.https_proxy
    || env.http_proxy
    || env.all_proxy,
  );
}

function normalizeWindowsEnvironment(env) {
  if (process.platform !== "win32") return env;
  const normalized = { ...env };
  for (const [preferred, alias] of [
    ["HTTP_PROXY", "http_proxy"],
    ["HTTPS_PROXY", "https_proxy"],
    ["ALL_PROXY", "all_proxy"],
    ["NO_PROXY", "no_proxy"],
  ]) {
    normalized[preferred] ||= normalized[alias];
    delete normalized[alias];
  }
  return normalized;
}

function supportsUseEnvProxyFlag() {
  return Number.parseInt(process.versions.node.split(".")[0], 10) >= 24;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeFile(filePath) {
  await fs.rm(filePath, { force: true });
}

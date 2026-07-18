import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexCatalog } from "../lib/codex/model-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(ROOT, "scripts", "fixtures", "codex-e2e");
const REAL_SMOKE_MODEL = process.env.CODEX_REAL_SMOKE_MODEL || "";
const WORK_ROOT = path.join(
  process.env.LOCALAPPDATA || os.tmpdir(),
  "local-ai-gateway-codex-e2e",
);

const ROUNDS = [
  {
    toolNamePattern: /shell|command/i,
    arguments: { command: "ls -la && find . -maxdepth 3 -type f | sort" },
  },
  {
    toolNamePattern: /shell|command/i,
    arguments: { command: "sed -n '1,120p' src/math.js && npm test" },
  },
  {
    toolNamePattern: /shell|command/i,
    arguments: {
      command:
        "node -e \"const fs=require('fs');const p='src/math.js';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('left - right','left + right'))\"",
    },
  },
  {
    toolNamePattern: /shell|command/i,
    arguments: { command: "npm test" },
  },
];

async function main() {
  if (REAL_SMOKE_MODEL) {
    await runRealSmoke();
    return;
  }
  await runDeterministicE2E();
}

async function runDeterministicE2E() {
  ensureCodexAvailable();

  mkdirSync(WORK_ROOT, { recursive: true });
  const tempRoot = mkdtempSync(path.join(WORK_ROOT, "run-"));
  const fixtureDir = path.join(tempRoot, "fixture");
  const codexHome = path.join(tempRoot, "codex-home");
  const isolatedHome = path.join(tempRoot, "home");
  const catalogPath = path.join(tempRoot, "model-catalog.json");
  const gatewayConfigPath = path.join(tempRoot, "gateway.config.json");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(path.join(isolatedHome, "AppData", "Roaming"), { recursive: true });
  mkdirSync(path.join(isolatedHome, "AppData", "Local"), { recursive: true });
  cpSync(FIXTURE_ROOT, fixtureDir, { recursive: true });

  let provider = null;
  let gateway = null;

  try {
    provider = await startScriptedProvider();
    const gatewayPort = await reservePort();
    writeFileSync(gatewayConfigPath, JSON.stringify({
      server: { host: "127.0.0.1", port: gatewayPort },
      clients: {
        codex: {
          endpoints: [{
            name: "fixture-responses",
            type: "openai-responses",
            base_url: `http://127.0.0.1:${provider.port}/responses`,
            api_key: "env:CODEX_E2E_KEY",
            models: ["fixture-coder"],
            model_mapping: { "fixture-coder": "upstream-fixture-coder" },
            capabilities: {
              input_modalities: ["text", "image"],
              reasoning: true,
              tools: true,
            },
          }],
        },
      },
    }, null, 2));

    const officialModels = loadBundledCodexModels();
    const catalog = buildCodexCatalog({
      officialModels,
      endpoints: [{
        name: "fixture-responses",
        type: "openai-responses",
        models: ["fixture-coder"],
        display_names: { "fixture-coder": "Fixture Coder" },
        capabilities: {
          input_modalities: ["text", "image"],
          reasoning: true,
          tools: true,
        },
      }],
    });
    writeFileSync(catalogPath, JSON.stringify({
      generated_at: new Date().toISOString(),
      source: "codex-e2e",
      models: catalog.models.filter((model) => model.slug === "fixture-coder"),
    }, null, 2));

    const catalogPathPosix = toPosix(catalogPath);
    writeFileSync(path.join(codexHome, "config.toml"), [
      'model = "fixture-coder"',
      'model_provider = "local-gateway"',
      `model_catalog_json = ${JSON.stringify(catalogPathPosix)}`,
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      "",
      "[model_providers.local-gateway]",
      'name = "Local AI Gateway E2E"',
      `base_url = ${JSON.stringify(`http://127.0.0.1:${gatewayPort}/codex/v1`)}`,
      'wire_api = "responses"',
      "requires_openai_auth = true",
      'experimental_bearer_token = "dummy"',
      "",
      "[features]",
      "plugins = false",
      "",
    ].join("\n"));

    gateway = await startGateway({
      port: gatewayPort,
      configPath: gatewayConfigPath,
      env: { CODEX_E2E_KEY: "e2e-key" },
    });

    // Isolation notes:
    // - CODEX_HOME is temporary, so real ~/.codex is never written.
    // - HOME/USERPROFILE/APPDATA/LOCALAPPDATA are redirected so user plugins/skills
    //   from the desktop install do not load or hang the agent loop.
    // - Workdir is outside the repo so project-local skills are not discovered.
    // - --dangerously-bypass-approvals-and-sandbox is required for deterministic
    //   shell tool rounds inside the temporary fixture only.
    const codexArgs = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--disable",
      "plugins",
      "Inspect the project, run the tests, fix the add function, rerun the tests, and report the result.",
    ];

    const result = await runCodex(codexArgs, {
      cwd: fixtureDir,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: "dummy",
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        APPDATA: path.join(isolatedHome, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local"),
      },
      timeoutMs: 180_000,
    });

    const mathSource = readFileSync(path.join(fixtureDir, "src", "math.js"), "utf8");
    const testResult = spawnSync(process.execPath, ["--test"], {
      cwd: fixtureDir,
      encoding: "utf8",
      timeout: 30_000,
    });

    const summary = {
      ok: result.status === 0
        && testResult.status === 0
        && mathSource.includes("left + right")
        && provider.toolRounds >= 4,
      toolRounds: provider.toolRounds,
      testsPassed: testResult.status === 0,
      filesChanged: mathSource.includes("left + right") ? ["src/math.js"] : [],
      codexStatus: result.status,
      codexSignal: result.signal,
      providerHits: provider.hits,
    };

    if (!summary.ok) {
      const details = [
        `codex status=${result.status}`,
        `toolRounds=${provider.toolRounds}`,
        `providerHits=${provider.hits}`,
        `testsPassed=${testResult.status === 0}`,
        `mathFixed=${mathSource.includes("left + right")}`,
      ].join(", ");
      const stderrTail = String(result.stderr || "").trim().slice(-2000);
      const stdoutTail = String(result.stdout || "").trim().slice(-2000);
      throw new Error(
        `Codex E2E failed: ${details}` +
        (stderrTail ? `\n--- codex stderr ---\n${stderrTail}` : "") +
        (stdoutTail ? `\n--- codex stdout ---\n${stdoutTail}` : ""),
      );
    }

    console.log(JSON.stringify({
      ok: summary.ok,
      toolRounds: summary.toolRounds,
      testsPassed: summary.testsPassed,
      filesChanged: summary.filesChanged,
    }, null, 2));
  } finally {
    await stopChild(gateway?.child);
    await closeServer(provider?.server);
    safeRm(tempRoot);
  }
}

async function runRealSmoke() {
  ensureCodexAvailable();
  const gatewayPort = Number(process.env.GATEWAY_PORT || 8787);
  const health = await fetch(`http://127.0.0.1:${gatewayPort}/codex/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(
      `Real smoke requires a running gateway on 127.0.0.1:${gatewayPort}/codex/health`,
    );
  }

  mkdirSync(WORK_ROOT, { recursive: true });
  const tempRoot = mkdtempSync(path.join(WORK_ROOT, "smoke-"));
  const codexHome = path.join(tempRoot, "codex-home");
  const isolatedHome = path.join(tempRoot, "home");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(path.join(isolatedHome, "AppData", "Roaming"), { recursive: true });
  mkdirSync(path.join(isolatedHome, "AppData", "Local"), { recursive: true });

  try {
    writeFileSync(path.join(codexHome, "config.toml"), [
      `model = ${JSON.stringify(REAL_SMOKE_MODEL)}`,
      'model_provider = "local-gateway"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      "",
      "[model_providers.local-gateway]",
      'name = "Local AI Gateway Smoke"',
      `base_url = ${JSON.stringify(`http://127.0.0.1:${gatewayPort}/codex/v1`)}`,
      'wire_api = "responses"',
      "requires_openai_auth = true",
      'experimental_bearer_token = "dummy"',
      "",
      "[features]",
      "plugins = false",
      "",
    ].join("\n"));

    const result = spawnSync("codex", [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "--json",
      "--disable",
      "plugins",
      "-s",
      "read-only",
      "List the current directory with the shell tool, then reply with the first entry.",
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        APPDATA: path.join(isolatedHome, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local"),
      },
      input: "",
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const summary = {
      ok: result.status === 0,
      mode: "real-smoke",
      model: REAL_SMOKE_MODEL,
      status: result.status === 0 ? "completed" : "failed",
      codexStatus: result.status,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
      const stderrTail = String(result.stderr || "").trim().slice(-1000);
      throw new Error(
        `Real smoke failed with status ${result.status}` +
        (stderrTail ? `\n${stderrTail}` : ""),
      );
    }
  } finally {
    safeRm(tempRoot);
  }
}

function ensureCodexAvailable() {
  const probe = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (probe.error || probe.status !== 0) {
    throw new Error("codex executable is required for test:codex:e2e");
  }
}

function loadBundledCodexModels() {
  const result = spawnSync("codex", ["debug", "models", "--bundled"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("failed to load bundled Codex models for E2E catalog");
  }
  const parsed = JSON.parse(result.stdout || "{}");
  return Array.isArray(parsed.models) ? parsed.models : [];
}

async function startScriptedProvider() {
  let toolRounds = 0;
  let hits = 0;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      hits += 1;
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "invalid json" } }));
        return;
      }

      const functionResultCount = countFunctionCallOutputs(body.input);
      const events = functionResultCount >= ROUNDS.length
        ? finalAssistantEvents()
        : nextToolRoundEvents(body, functionResultCount);

      if (functionResultCount < ROUNDS.length) {
        toolRounds = Math.max(toolRounds, functionResultCount + 1);
      }

      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [event, data] of events) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      response.end();
    });
  });

  const port = await listen(server);
  return {
    server,
    port,
    get toolRounds() {
      return toolRounds;
    },
    get hits() {
      return hits;
    },
  };
}

function runCodex(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn("codex", args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({
        status: null,
        signal: "SIGTERM",
        stdout,
        stderr: `${stderr}\n[e2e] timed out after ${timeoutMs}ms`.trim(),
      });
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: null,
        signal: null,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
      });
    });

    child.on("exit", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function nextToolRoundEvents(body, functionResultCount) {
  const round = ROUNDS[functionResultCount];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const tool = tools.find((entry) => {
    const name = entry?.name || entry?.function?.name || "";
    return round.toolNamePattern.test(String(name));
  }) || tools[0];

  const toolName = tool?.name || tool?.function?.name || "shell_command";
  const callId = `call_round_${functionResultCount + 1}`;
  return functionCallEvents({
    responseId: `resp_round_${functionResultCount + 1}`,
    callId,
    name: toolName,
    argumentsObject: round.arguments,
  });
}

function finalAssistantEvents() {
  const responseId = "resp_final";
  const item = {
    id: "msg_final",
    type: "message",
    role: "assistant",
    content: [{
      type: "output_text",
      text: "Fixed add() and verified tests.",
      annotations: [],
    }],
  };
  return [
    ["response.created", {
      type: "response.created",
      response: { id: responseId, status: "in_progress" },
    }],
    ["response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item,
    }],
    ["response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: item.content[0].text,
    }],
    ["response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item,
    }],
    ["response.completed", {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [item],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      },
    }],
  ];
}

function functionCallEvents({ responseId, callId, name, argumentsObject }) {
  const item = {
    id: `fc_${callId}`,
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify(argumentsObject),
  };
  return [
    ["response.created", {
      type: "response.created",
      response: { id: responseId, status: "in_progress" },
    }],
    ["response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    }],
    ["response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    }],
    ["response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item,
    }],
    ["response.completed", {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    }],
  ];
}

function countFunctionCallOutputs(input) {
  if (!Array.isArray(input)) return 0;
  let count = 0;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call_output") {
      count += 1;
      continue;
    }
    if (item.type === "tool_result" || item.role === "tool") {
      count += 1;
    }
  }
  return count;
}

async function startGateway({ port, configPath, env = {} }) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(port),
      GATEWAY_NO_OPEN: "1",
      CLAUDE_3P_SYNC_DISABLED: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(port, child);
  return { child, port };
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`Gateway exited before health check: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Gateway health check timed out");
}

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

function safeRm(target) {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.error(`cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function toPosix(filePath) {
  return filePath.replaceAll("\\", "/");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

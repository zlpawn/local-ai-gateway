import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

loadDotEnv(path.join(root, ".env"));

const configPath = path.resolve(process.env.GATEWAY_CONFIG_FILE || "gateway.config.json");
const validation = spawnSync(process.execPath, ["scripts/validate-config.mjs", configPath], {
  cwd: root,
  encoding: "utf8",
});

let config = null;
try {
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  }
} catch {
}

const serverConfig = config?.server || {};
const host = process.env.GATEWAY_HOST || process.env.HOST || serverConfig.host || "127.0.0.1";
const port = Number(process.env.GATEWAY_PORT || process.env.PORT || serverConfig.port || 8787);

console.log("Local AI Gateway Doctor");
console.log("=======================");
console.log(`Project: ${root}`);
console.log(`Node: ${process.version} (${Number(process.versions.node.split(".")[0]) >= 18 ? "ok" : "too old"})`);
console.log(`Platform: ${os.platform()} ${os.release()}`);
console.log(`Config: ${configPath}`);
console.log("");

section("Config validation");
if (validation.stdout.trim()) console.log(indent(validation.stdout.trim()));
if (validation.stderr.trim()) console.log(indent(validation.stderr.trim()));
console.log(`Result: ${validation.status === 0 ? "ok" : "failed"}`);

if (config) {
  section("Providers");
  const providers = Object.entries(config.providers || {});
  if (providers.length === 0) {
    console.log("No providers configured.");
  } else {
    for (const [id, provider] of providers) {
      const keySource = provider.api_key
        ? "inline api_key"
        : provider.api_key_env
          ? envPresent(provider.api_key_env)
            ? `${provider.api_key_env}=set`
            : `${provider.api_key_env}=missing, client header can still supply`
          : "client-supplied key";
      console.log(`- ${id}: type=${provider.type || "openai-chat"}, auth=${provider.auth || "bearer"}, key=${keySource}`);
      console.log(`  ${provider.base_url || "(missing base_url)"}`);
    }
  }

  section("Models");
  const models = normalizeModelEntries(config.models);
  if (models.length === 0) {
    console.log("No custom models configured.");
  } else {
    for (const model of models) {
      const aliases = Array.isArray(model.aliases) && model.aliases.length ? ` aliases=${model.aliases.join(",")}` : "";
      const provider = (config.providers || {})[model.provider] || {};
      const type = provider.type || "openai-chat";
      const capabilities = protocolCapabilities(type).join("/");
      console.log(`- ${model.id} -> ${model.upstream_model || model.model || model.id} via ${model.provider} (${type}; ${capabilities})${aliases}`);
    }
  }
}

section("Runtime");
console.log(`Expected listen URL: http://${host}:${port}`);
const listening = await isListening(host, port);
console.log(`Port listening: ${listening ? "yes" : "no"}`);
if (listening) {
  const health = await getJson(`http://${host}:${port}/health`);
  if (health.ok) {
    console.log(`Health: ok`);
    console.log(`Models exposed: ${Array.isArray(health.body.models) ? health.body.models.length : 0}`);
  } else {
    console.log(`Health: failed (${health.error || health.status || "unknown"})`);
  }
}

section("Client URLs");
console.log(`Claude Desktop: http://${host}:${port}/desktop`);
console.log(`Claude Code:    http://${host}:${port}/code`);
console.log(`Codex:          http://${host}:${port}/codex`);

if (validation.status !== 0) process.exitCode = 1;

function section(title) {
  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
}

function indent(text) {
  return text.split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}

function envPresent(name) {
  return Boolean(process.env[name]);
}

function normalizeModelEntries(models) {
  if (Array.isArray(models)) return models;
  return Object.entries(models || {}).map(([id, model]) => ({ id, ...model }));
}

function protocolCapabilities(providerType) {
  if (providerType === "anthropic") {
    return ["messages", "chat*", "responses*"];
  }
  if (providerType === "openai-chat") {
    return ["messages*", "chat", "responses*"];
  }
  if (providerType === "openai-responses") {
    return ["chat*", "responses"];
  }
  return ["unknown"];
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] != null) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function isListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

function getJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => raw += chunk);
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: JSON.parse(raw) });
        } catch (error) {
          resolve({ ok: false, status: res.statusCode, error: error.message });
        }
      });
    });
    req.setTimeout(2000, () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.on("error", (error) => resolve({ ok: false, error: error.message }));
  });
}

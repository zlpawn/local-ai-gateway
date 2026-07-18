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
const secretsPath = path.resolve(
  process.env.GATEWAY_SECRETS_FILE || path.join(path.dirname(configPath), "gateway.secrets.json"),
);
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
  const secrets = fs.existsSync(secretsPath)
    ? JSON.parse(fs.readFileSync(secretsPath, "utf8"))
    : { api_keys: {} };
  section("Endpoints");
  for (const [clientName, client] of Object.entries(config.clients || {})) {
    for (const endpoint of client.endpoints || []) {
      const secret = secrets.api_keys?.[endpoint.id];
      const keyState = secret
        ? secret.startsWith("env:")
          ? `${secret.slice(4)}=${envPresent(secret.slice(4)) ? "set" : "missing"}`
          : "stored"
        : "missing";
      console.log(`- ${clientName}/${endpoint.name}: id=${endpoint.id}, type=${endpoint.type}, key=${keyState}`);
      console.log(`  ${endpoint.base_url || "(missing base_url)"}`);
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

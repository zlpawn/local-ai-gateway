import fs from "node:fs";
import net from "node:net";
import { formatSecretState } from "../protocol.mjs";
import { validateConfig, loadStateOrThrow } from "./config-service.mjs";
import { fetchHealth } from "./live-gateway.mjs";
import { DEFAULT_PORT } from "../constants.mjs";

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

export async function runDoctor({
  configPath,
  secretsPath,
  host = "127.0.0.1",
  port = DEFAULT_PORT,
} = {}) {
  const recommendations = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const node = {
    version: process.version,
    ok: nodeMajor >= 18,
  };
  if (!node.ok) {
    recommendations.push({
      command: "Install Node.js >= 18",
      reason: "Runtime too old",
    });
  }

  let configReport;
  let endpoints = [];
  try {
    configReport = await validateConfig({ configPath, secretsPath });
    if (configReport.valid) {
      const state = loadStateOrThrow({ configPath, secretsPath });
      for (const [client, body] of Object.entries(state.config.clients || {})) {
        for (const endpoint of body.endpoints || []) {
          const keyState = formatSecretState(state.secrets?.api_keys?.[endpoint.id]);
          endpoints.push({
            client,
            id: endpoint.id,
            name: endpoint.name,
            type: endpoint.type || null,
            purpose: endpoint.purpose || "chat",
            enabled: endpoint.enabled !== false,
            key_state: keyState,
          });
          if (keyState === "missing" && (endpoint.purpose || "chat") !== "unused") {
            recommendations.push({
              command: `secret set --endpoint-id ${endpoint.id} --api-key <value>`,
              reason: `Missing API key for ${client}/${endpoint.name}`,
            });
          }
        }
      }
    } else {
      recommendations.push({
        command: "config validate",
        reason: "Config validation failed",
      });
    }
  } catch (error) {
    configReport = {
      valid: false,
      path: configPath,
      issues: [{ message: error.message }],
    };
    recommendations.push({
      command: "config validate",
      reason: error.message,
    });
  }

  const listening = await isListening(host, port);
  const health = listening ? await fetchHealth({ host, port }) : { ok: false };
  if (!listening) {
    recommendations.push({
      command: "start",
      reason: `Nothing listening on ${host}:${port}`,
    });
  }

  const clients = {
    code: { urls: [`http://${host}:${port}/code`] },
    desktop: { urls: [`http://${host}:${port}/desktop`] },
    codex: { urls: [`http://${host}:${port}/codex`] },
    deeptutor: {
      urls: [
        `http://${host}:${port}/deeptutor/`,
        `http://${host}:${port}/deeptutor/emb/embeddings`,
      ],
    },
  };

  return {
    node,
    config: {
      path: configPath,
      secrets_path: secretsPath,
      valid: Boolean(configReport?.valid),
      issues: configReport?.issues || [],
      exists: fs.existsSync(configPath),
    },
    endpoints,
    runtime: {
      host,
      port,
      listening,
      health_ok: Boolean(health?.ok || health?.body?.ok),
      models: health?.body?.models || [],
    },
    clients,
    recommendations,
  };
}
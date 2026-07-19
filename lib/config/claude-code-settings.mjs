import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODEL_SLOT_NAMES = ["opus", "sonnet", "haiku", "fable"];
const MANAGED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  ...MODEL_SLOT_NAMES.flatMap((slot) => {
    const prefix = `ANTHROPIC_DEFAULT_${slot.toUpperCase()}_MODEL`;
    return [prefix, `${prefix}_NAME`];
  }),
];

export function syncClaudeCodeSettings({
  config,
  settingsPath = defaultClaudeCodeSettingsPath(),
  authToken = "all",
  gatewayBaseUrl = "",
} = {}) {
  try {
    const codeConfig = config?.clients?.code || {};
    const endpoints = Array.isArray(codeConfig.endpoints) ? codeConfig.endpoints : [];
    if (!endpoints.length) return { updated: false, reason: "no-code-endpoints", path: settingsPath };

    const defaultEndpoint =
      endpoints.find((endpoint) => endpoint?.is_default === true) ||
      (endpoints.length === 1 ? endpoints[0] : null);
    const slots = codeConfig.model_slots || {};
    if (Object.keys(slots).length && !defaultEndpoint) {
      return { updated: false, reason: "default-endpoint-not-found", path: settingsPath };
    }

    const available = new Set([
      ...(defaultEndpoint?.models || []),
      ...Object.keys(defaultEndpoint?.model_mapping || {}),
    ]);
    for (const slot of MODEL_SLOT_NAMES) {
      const model = String(slots[slot] || "").trim();
      if (model && !available.has(model)) {
        return {
          updated: false,
          reason: "invalid-model-slot",
          slot,
          model,
          path: settingsPath,
        };
      }
    }

    const existing = readJson(settingsPath, {});
    const next = structuredClone(existing);
    next.env = { ...(next.env || {}) };
    for (const key of MANAGED_ENV_KEYS) delete next.env[key];

    const server = config?.server || {};
    const host = server.host && server.host !== "0.0.0.0" ? server.host : "127.0.0.1";
    const port = Number(server.port) || 8787;
    next.env.ANTHROPIC_BASE_URL =
      String(gatewayBaseUrl || "").replace(/\/+$/, "") ||
      `http://${host}:${port}/code`;
    next.env.ANTHROPIC_AUTH_TOKEN = authToken;
    next.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";

    if (defaultEndpoint) {
      for (const slot of MODEL_SLOT_NAMES) {
        const model = String(slots[slot] || "").trim();
        if (!model) continue;
        const prefix = `ANTHROPIC_DEFAULT_${slot.toUpperCase()}_MODEL`;
        next.env[prefix] = `anthropic.gateway.${defaultEndpoint.id}.${model}`;
        next.env[`${prefix}_NAME`] = model;
      }
    }

    const previousText = jsonText(existing);
    const nextText = jsonText(next);
    if (previousText === nextText) {
      return { updated: false, reason: "already-in-sync", path: settingsPath };
    }

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    if (fs.existsSync(settingsPath)) {
      const backupPath = `${settingsPath}.gateway-backup`;
      fs.copyFileSync(settingsPath, backupPath);
    }
    const tempPath = `${settingsPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, nextText);
    fs.renameSync(tempPath, settingsPath);
    return { updated: true, path: settingsPath };
  } catch (error) {
    return {
      updated: false,
      reason: "sync-failed",
      path: settingsPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function defaultClaudeCodeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return structuredClone(fallback);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

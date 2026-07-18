import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class GatewayConfigError extends Error {
  constructor(issues) {
    super(issues.map((issue) => issue.message).join("\n"));
    this.name = "GatewayConfigError";
    this.code = "invalid_gateway_config";
    this.issues = issues;
  }
}

export function createEndpointId() {
  return `ep_${crypto.randomUUID()}`;
}

export function loadGatewayState({
  configPath,
  secretsPath = defaultSecretsPath(configPath),
  idFactory = createEndpointId,
  officialCodexIds = new Set(),
} = {}) {
  const original = readJson(configPath, {});
  const existingSecrets = readJson(secretsPath, { api_keys: {} });
  const prepared = prepareState(original, existingSecrets, idFactory);
  const issues = validateGatewayConfig(prepared.config, { officialCodexIds });
  if (issues.length) throw new GatewayConfigError(issues);

  const originalText = jsonText(original);
  const configText = jsonText(prepared.config);
  const secretsText = jsonText(prepared.secrets);
  const currentSecretsText = fs.existsSync(secretsPath)
    ? normalizeJsonText(fs.readFileSync(secretsPath, "utf8"))
    : "";
  const migrated =
    originalText !== configText ||
    (prepared.hasSecrets && currentSecretsText !== secretsText);
  let backupPath = null;

  if (migrated && fs.existsSync(configPath)) {
    backupPath = createBackup(configPath);
    writeJsonIfChanged(configPath, prepared.config);
    if (prepared.hasSecrets) writeJsonIfChanged(secretsPath, prepared.secrets, 0o600);
  }

  return {
    ...prepared,
    migrated,
    backupPath,
    configPath,
    secretsPath,
  };
}

export function saveGatewayState({
  configPath,
  secretsPath = defaultSecretsPath(configPath),
  config,
  idFactory = createEndpointId,
  officialCodexIds = new Set(),
} = {}) {
  const existingSecrets = readJson(secretsPath, { api_keys: {} });
  const prepared = prepareState(config || {}, existingSecrets, idFactory);
  const issues = validateGatewayConfig(prepared.config, { officialCodexIds });
  if (issues.length) throw new GatewayConfigError(issues);

  const configChanged = writeJsonIfChanged(configPath, prepared.config);
  const secretsChanged = prepared.hasSecrets
    ? writeJsonIfChanged(secretsPath, prepared.secrets, 0o600)
    : false;
  return { ...prepared, configChanged, secretsChanged, configPath, secretsPath };
}

export function getEndpointApiKey(endpoint, secrets, env = process.env) {
  const value = String(secrets?.api_keys?.[endpoint?.id] || "");
  if (!value) return "";
  if (!value.startsWith("env:")) return value;
  return env[value.slice(4)] || "";
}

export function selectExposedEndpoints(endpoints = []) {
  const selected = endpoints.filter((endpoint) => endpoint?.expose_models === true);
  return selected.length ? selected : endpoints;
}

export function validateGatewayConfig(config, { officialCodexIds = new Set() } = {}) {
  const issues = [];
  const endpointIds = new Map();

  for (const [clientName, client] of Object.entries(config?.clients || {})) {
    const endpoints = Array.isArray(client?.endpoints) ? client.endpoints : [];
    const defaults = endpoints.filter((endpoint) => endpoint?.is_default === true);
    if (defaults.length > 1) {
      issues.push({
        code: "multiple_default_endpoints",
        client: clientName,
        message: `Client '${clientName}' has more than one default endpoint.`,
      });
    }

    const publicIds = new Map();
    for (const [index, endpoint] of endpoints.entries()) {
      const id = String(endpoint?.id || "").trim();
      if (!id) {
        issues.push({
          code: "missing_endpoint_id",
          client: clientName,
          endpoint_index: index,
          message: `Client '${clientName}' endpoint ${index + 1} is missing an id.`,
        });
      } else if (endpointIds.has(id)) {
        issues.push({
          code: "duplicate_endpoint_id",
          endpoint_id: id,
          message: `Endpoint id '${id}' is used more than once.`,
        });
      } else {
        endpointIds.set(id, { client: clientName, index });
      }

      const occurrences = [
        ...(Array.isArray(endpoint?.models) ? endpoint.models : []).map((modelId) => ({
          modelId,
          source: "models",
        })),
        ...Object.keys(endpoint?.model_mapping || {}).map((modelId) => ({
          modelId,
          source: "model_mapping",
        })),
      ];
      for (const occurrence of occurrences) {
        const modelId = String(occurrence.modelId || "").trim();
        if (!modelId) continue;
        if (!publicIds.has(modelId)) publicIds.set(modelId, []);
        publicIds.get(modelId).push({
          endpoint_id: id,
          endpoint_name: endpoint?.name || `endpoint-${index + 1}`,
          source: occurrence.source,
        });
      }
    }

    for (const [modelId, occurrences] of publicIds) {
      if (occurrences.length > 1) {
        const used = new Set(publicIds.keys());
        const suggested = new Set();
        const enriched = occurrences.map((occurrence) => {
          let suffix = slugify(occurrence.endpoint_name);
          if (!suffix) suffix = shortEndpointId(occurrence.endpoint_id);
          let suggestion = `${modelId}-${suffix}`;
          if (used.has(suggestion) || suggested.has(suggestion)) {
            suggestion = `${suggestion}-${shortEndpointId(occurrence.endpoint_id)}`;
          }
          suggested.add(suggestion);
          return { ...occurrence, suggestion };
        });
        issues.push({
          code: "duplicate_public_model",
          client: clientName,
          model_id: modelId,
          occurrences: enriched,
          message: `Public model '${modelId}' is exposed more than once for client '${clientName}'.`,
        });
      }
      if (clientName === "codex" && officialCodexIds.has(modelId)) {
        issues.push({
          code: "official_model_collision",
          client: clientName,
          model_id: modelId,
          message: `Configured Codex model '${modelId}' conflicts with an official Codex model ID.`,
        });
      }
    }
  }
  return issues;
}

function prepareState(inputConfig, existingSecrets, idFactory) {
  const source = inputConfig && typeof inputConfig === "object"
    ? structuredClone(inputConfig)
    : {};
  const config = source.clients ? source : migrateLegacyConfig(source);
  config.server ||= {};
  config.clients ||= {};

  const apiKeys = { ...(existingSecrets?.api_keys || {}) };
  for (const client of Object.values(config.clients)) {
    client.endpoints = Array.isArray(client?.endpoints) ? client.endpoints : [];
    for (const endpoint of client.endpoints) {
      endpoint.id ||= idFactory();
      if (typeof endpoint.api_key === "string" && endpoint.api_key) {
        apiKeys[endpoint.id] = endpoint.api_key;
      }
      delete endpoint.api_key;
      delete endpoint.api_key_env;
      delete endpoint.has_api_key;
    }
  }

  delete config.providers;
  delete config.models;
  delete config.official_models;
  const secrets = { api_keys: apiKeys };
  return {
    config,
    secrets,
    hasSecrets: Object.keys(apiKeys).length > 0,
  };
}

function migrateLegacyConfig(source) {
  const config = {
    server: source.server || {},
    clients: {
      code: { endpoints: [] },
      desktop: { endpoints: [] },
      codex: { endpoints: [] },
    },
  };
  const providers = source.providers || {};
  const models = Array.isArray(source.models)
    ? source.models
    : Object.entries(source.models || {}).map(([id, model]) => ({ id, ...model }));
  const endpoints = new Map();

  for (const model of models) {
    const provider = providers[model.provider];
    if (!provider || provider.type !== "anthropic") continue;
    if (!endpoints.has(model.provider)) {
      endpoints.set(model.provider, {
        name: model.provider,
        type: provider.type,
        base_url: provider.base_url || "",
        api_key: provider.api_key || (
          provider.api_key_env ? `env:${provider.api_key_env}` : ""
        ),
        models: [],
        model_mapping: {},
      });
    }
    const endpoint = endpoints.get(model.provider);
    const upstream = model.upstream_model || model.model || model.id;
    if (!endpoint.models.includes(upstream)) endpoint.models.push(upstream);
    endpoint.model_mapping[model.id] = upstream;
    for (const alias of model.aliases || []) endpoint.model_mapping[alias] = upstream;
  }

  for (const endpoint of endpoints.values()) {
    for (const clientName of Object.keys(config.clients)) {
      config.clients[clientName].endpoints.push(structuredClone(endpoint));
    }
  }
  return config;
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function shortEndpointId(value) {
  return String(value || "endpoint").replace(/^ep_/, "").replaceAll("-", "").slice(0, 8);
}

function defaultSecretsPath(configPath) {
  return path.join(path.dirname(configPath), "gateway.secrets.json");
}

function createBackup(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.${stamp}.bak`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function readJson(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return structuredClone(fallback);
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function writeJsonIfChanged(filePath, value, mode) {
  const next = jsonText(value);
  const current = fs.existsSync(filePath)
    ? normalizeJsonText(fs.readFileSync(filePath, "utf8"))
    : "";
  if (current === next) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, next, { encoding: "utf8", mode });
  fs.renameSync(temporary, filePath);
  if (mode != null) {
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      // Windows permissions are governed by ACLs rather than POSIX modes.
    }
  }
  return true;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeJsonText(text) {
  return jsonText(JSON.parse(String(text).replace(/^\uFEFF/, "")));
}

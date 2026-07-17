import fs from "node:fs";
import path from "node:path";
import {
  loadOfficialCodexIds,
  validateCodexEndpoints,
} from "../lib/codex/config-validation.mjs";

const VALID_PROVIDER_TYPES = new Set(["anthropic", "openai-chat", "openai-responses", "grok"]);
const VALID_AUTH_SCHEMES = new Set(["bearer", "x-api-key", "none", ""]);

const configPath = path.resolve(process.argv[2] || process.env.GATEWAY_CONFIG_FILE || "gateway.config.json");
const errors = [];
const warnings = [];

if (!fs.existsSync(configPath)) {
  errors.push(`Config file not found: ${configPath}`);
  finish();
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
} catch (error) {
  errors.push(`Invalid JSON in ${configPath}: ${error.message}`);
  finish();
}

if (isObject(config.clients)) {
  validateClientConfig(config.clients);
} else {
  validateProviderModelConfig(config);
}

if (config.server) {
  if (config.server.host != null && typeof config.server.host !== "string") {
    errors.push("server.host must be a string.");
  }
  if (config.server.port != null) {
    const port = Number(config.server.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      errors.push("server.port must be an integer between 1 and 65535.");
    }
  }
}

const codexEndpoints = config.clients?.codex?.endpoints;
const codexValidation = validateCodexEndpoints({
  endpoints: Array.isArray(codexEndpoints) ? codexEndpoints : [],
  officialIds: loadOfficialCodexIds({ warnings }),
});
errors.push(...codexValidation.errors);
warnings.push(...codexValidation.warnings);

finish();

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function validateClientConfig(clients) {
  let endpointCount = 0;
  for (const [clientName, client] of Object.entries(clients)) {
    if (!isObject(client)) {
      errors.push(`client '${clientName}' must be an object.`);
      continue;
    }
    if (client.endpoints == null) continue;
    if (!Array.isArray(client.endpoints)) {
      errors.push(`client '${clientName}' endpoints must be an array.`);
      continue;
    }
    endpointCount += client.endpoints.length;
    for (const [index, endpoint] of client.endpoints.entries()) {
      validateEndpoint(`client '${clientName}' endpoint ${index + 1}`, endpoint);
    }
  }
  if (endpointCount === 0) {
    warnings.push("clients endpoints are empty. /v1/models will only expose official models.");
  }
}

function validateEndpoint(label, endpoint) {
  if (!isObject(endpoint)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  const type = endpoint.type || "openai-chat";
  if (!VALID_PROVIDER_TYPES.has(type)) {
    errors.push(`${label} has unsupported type '${endpoint.type}'.`);
  }
  validateBaseUrl(label, endpoint.base_url);
  if (endpoint.auth && !VALID_AUTH_SCHEMES.has(String(endpoint.auth).toLowerCase())) {
    errors.push(`${label} has unsupported auth '${endpoint.auth}'.`);
  }
  if (endpoint.api_key && !String(endpoint.api_key).startsWith("env:")) {
    warnings.push(`${label} contains inline api_key. Keep gateway.config.json ignored or use env:NAME.`);
  }
  if (endpoint.models != null && !Array.isArray(endpoint.models)) {
    errors.push(`${label} models must be an array.`);
  }
  if (endpoint.model_mapping != null && !isObject(endpoint.model_mapping)) {
    errors.push(`${label} model_mapping must be an object.`);
  }
}

function validateProviderModelConfig(config) {
  const providers = config.providers || {};
  if (!isObject(providers) || Object.keys(providers).length === 0) {
    errors.push("providers must be a non-empty object.");
  }

  for (const [id, provider] of Object.entries(providers)) {
    if (!id.trim()) errors.push("provider id cannot be empty.");
    if (!isObject(provider)) {
      errors.push(`provider '${id}' must be an object.`);
      continue;
    }

    const type = provider.type || "openai-chat";
    if (!VALID_PROVIDER_TYPES.has(type)) {
      errors.push(`provider '${id}' has unsupported type '${type}'.`);
    }
    validateBaseUrl(`provider '${id}'`, provider.base_url);

    const auth = (provider.auth || "bearer").toLowerCase();
    if (!VALID_AUTH_SCHEMES.has(auth)) {
      errors.push(`provider '${id}' has unsupported auth '${provider.auth}'.`);
    }
    if (provider.api_key) {
      warnings.push(`provider '${id}' contains inline api_key. Prefer api_key_env for open source configs.`);
    }
    if (provider.headers && !isObject(provider.headers)) {
      errors.push(`provider '${id}' headers must be an object.`);
    }
  }

  const modelEntries = Array.isArray(config.models)
    ? config.models
    : Object.entries(config.models || {}).map(([id, model]) => ({ id, ...model }));

  if (modelEntries.length === 0) {
    warnings.push("models is empty. /v1/models will only expose official models.");
  }

  const seenModels = new Set();
  const seenAliases = new Map();
  for (const model of modelEntries) {
    if (!isObject(model)) {
      errors.push("each model entry must be an object.");
      continue;
    }
    if (!model.id || typeof model.id !== "string") {
      errors.push("each model entry must set string id.");
      continue;
    }
    if (seenModels.has(model.id)) errors.push(`duplicate model id '${model.id}'.`);
    seenModels.add(model.id);

    if (!model.provider || !providers[model.provider]) {
      errors.push(`model '${model.id}' references unknown provider '${model.provider || ""}'.`);
    }
    if (!model.upstream_model && !model.model) {
      errors.push(`model '${model.id}' must set upstream_model or model.`);
    }
    if (model.aliases != null && !Array.isArray(model.aliases)) {
      errors.push(`model '${model.id}' aliases must be an array.`);
    }
    for (const alias of model.aliases || []) {
      if (!alias) continue;
      const existing = seenAliases.get(alias);
      if (existing && existing !== model.id) {
        errors.push(`alias '${alias}' is used by both '${existing}' and '${model.id}'.`);
      }
      seenAliases.set(alias, model.id);
    }
  }
}

function validateBaseUrl(label, baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") {
    errors.push(`${label} must set base_url.`);
    return;
  }
  try {
    new URL(baseUrl);
  } catch {
    errors.push(`${label} base_url is not a valid URL.`);
  }
}

function finish() {
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`);
    process.exit(1);
  }
  console.log(`Config OK: ${configPath}`);
  if (warnings.length > 0) console.log(`Warnings: ${warnings.length}`);
}

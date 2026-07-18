import fs from "node:fs";
import path from "node:path";
import {
  loadOfficialCodexIds,
  validateCodexEndpoints,
} from "../lib/codex/config-validation.mjs";
import { validateGatewayConfig } from "../lib/config/gateway-config-store.mjs";

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

if (!isObject(config.clients)) errors.push("clients must be an object.");
else validateClientConfig(config.clients);
for (const field of ["providers", "models", "official_models"]) {
  if (field in config) errors.push(`${field} is a legacy field and must be removed.`);
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
const gatewayIssues = validateGatewayConfig(config, {
  officialCodexIds: loadOfficialCodexIds({ warnings }),
});
errors.push(...gatewayIssues.map((issue) => issue.message));

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
  if ("api_key" in endpoint || "api_key_env" in endpoint) {
    errors.push(`${label} contains an API key field; store credentials in gateway.secrets.json.`);
  }
  if (!endpoint.id || typeof endpoint.id !== "string") errors.push(`${label} must set string id.`);
  if (endpoint.models != null && !Array.isArray(endpoint.models)) {
    errors.push(`${label} models must be an array.`);
  }
  if (endpoint.model_mapping != null && !isObject(endpoint.model_mapping)) {
    errors.push(`${label} model_mapping must be an object.`);
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

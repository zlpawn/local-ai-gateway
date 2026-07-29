import {
  createEndpointId,
  isCapabilityEndpoint,
} from "../../../config/gateway-config-store.mjs";
import { CliError } from "../protocol.mjs";
import { formatSecretState } from "../protocol.mjs";
import { loadStateOrThrow, saveState } from "./config-service.mjs";

function allEndpoints(config) {
  const out = [];
  for (const [client, body] of Object.entries(config.clients || {})) {
    for (const endpoint of body.endpoints || []) {
      out.push({ client, endpoint });
    }
  }
  return out;
}

function findEndpoint(config, id) {
  for (const item of allEndpoints(config)) {
    if (item.endpoint.id === id) return item;
  }
  return null;
}

function summarize(client, endpoint, secrets) {
  return {
    id: endpoint.id,
    client,
    name: endpoint.name,
    type: endpoint.type || null,
    purpose: endpoint.purpose || "chat",
    base_url: endpoint.base_url || null,
    enabled: endpoint.enabled !== false,
    is_default: Boolean(endpoint.is_default),
    models: endpoint.models || [],
    secret_state: formatSecretState(secrets?.api_keys?.[endpoint.id]),
  };
}

export function listEndpoints({ configPath, secretsPath, client, purpose } = {}) {
  const state = loadStateOrThrow({ configPath, secretsPath });
  let items = allEndpoints(state.config);
  if (client) items = items.filter((x) => x.client === client);
  if (purpose) {
    items = items.filter((x) => {
      const p = x.endpoint.purpose || "chat";
      return p === purpose || (purpose === "chat" && !x.endpoint.purpose);
    });
  }
  return {
    items: items.map(({ client: c, endpoint }) => summarize(c, endpoint, state.secrets)),
    count: items.length,
  };
}

export function getEndpoint({ configPath, secretsPath, id }) {
  const state = loadStateOrThrow({ configPath, secretsPath });
  const found = findEndpoint(state.config, id);
  if (!found) {
    throw new CliError({
      type: "not_found",
      code: "endpoint_not_found",
      message: `Endpoint not found: ${id}`,
    });
  }
  return {
    ...summarize(found.client, found.endpoint, state.secrets),
    endpoint: found.endpoint,
  };
}

export function addEndpoint(input) {
  const {
    configPath,
    secretsPath,
    client,
    name,
    type,
    base_url: baseUrl,
    purpose = "chat",
    models,
    model_mapping: modelMapping,
    upstream_model: upstreamModel,
    embedding_model: embeddingModel,
    dimensions,
    is_default: isDefault = false,
    expose_models: exposeModels,
    enabled = true,
    options,
    api_key: apiKey,
    api_key_env: apiKeyEnv,
    dryRun = false,
  } = input;

  const missing = [];
  if (!client) missing.push("client");
  if (!name) missing.push("name");
  if (!type && purpose === "chat") missing.push("type");
  if (!baseUrl && purpose !== "web_search") missing.push("base_url");
  if (missing.length) {
    throw new CliError({
      type: "validation",
      code: "missing_fields",
      message: `Missing required fields: ${missing.join(", ")}`,
      fields: missing,
      hint: `Provide ${missing.map((f) => `--${f.replaceAll("_", "-")}`).join(", ")}`,
    });
  }

  const state = loadStateOrThrow({ configPath, secretsPath });
  if (!state.config.clients?.[client]) {
    state.config.clients = {
      ...(state.config.clients || {}),
      [client]: { endpoints: [] },
    };
  }
  const id = createEndpointId();
  const endpoint = {
    id,
    name,
    enabled: enabled !== false,
    is_default: Boolean(isDefault),
  };
  if (purpose && purpose !== "chat") endpoint.purpose = purpose;
  if (type) endpoint.type = type;
  if (baseUrl) endpoint.base_url = baseUrl;
  if (models) endpoint.models = Array.isArray(models) ? models : String(models).split(",").map((s) => s.trim()).filter(Boolean);
  if (modelMapping) endpoint.model_mapping = typeof modelMapping === "string" ? JSON.parse(modelMapping) : modelMapping;
  if (upstreamModel) endpoint.upstream_model = upstreamModel;
  if (embeddingModel) endpoint.embedding_model = embeddingModel;
  if (dimensions != null && dimensions !== "") endpoint.dimensions = Number(dimensions);
  if (exposeModels != null) endpoint.expose_models = Boolean(exposeModels);
  if (options) endpoint.options = typeof options === "string" ? JSON.parse(options) : options;

  if (endpoint.is_default) {
    for (const ep of state.config.clients[client].endpoints || []) {
      if ((ep.purpose || "chat") === (endpoint.purpose || "chat")) ep.is_default = false;
    }
  }

  state.config.clients[client].endpoints = [
    ...(state.config.clients[client].endpoints || []),
    endpoint,
  ];

  if (apiKeyEnv) state.secrets.api_keys[id] = `env:${apiKeyEnv}`;
  else if (apiKey) state.secrets.api_keys[id] = apiKey;

  const saved = saveState({
    configPath,
    secretsPath,
    config: state.config,
    secrets: state.secrets,
    dryRun,
  });

  return {
    endpoint: summarize(client, endpoint, saved.secrets || state.secrets),
    dry_run: Boolean(dryRun),
  };
}

export function updateEndpoint(input) {
  const { configPath, secretsPath, id, dryRun = false, ...patch } = input;
  if (!id) {
    throw new CliError({
      type: "validation",
      code: "missing_fields",
      message: "id is required",
      fields: ["id"],
    });
  }
  const state = loadStateOrThrow({ configPath, secretsPath });
  const found = findEndpoint(state.config, id);
  if (!found) {
    throw new CliError({ type: "not_found", code: "endpoint_not_found", message: `Endpoint not found: ${id}` });
  }
  const endpoint = found.endpoint;
  const map = {
    name: "name",
    type: "type",
    purpose: "purpose",
    base_url: "base_url",
    upstream_model: "upstream_model",
    embedding_model: "embedding_model",
  };
  for (const [from, to] of Object.entries(map)) {
    if (patch[from] != null) endpoint[to] = patch[from];
  }
  if (patch.models != null) {
    endpoint.models = Array.isArray(patch.models)
      ? patch.models
      : String(patch.models).split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (patch.model_mapping != null) {
    endpoint.model_mapping = typeof patch.model_mapping === "string"
      ? JSON.parse(patch.model_mapping)
      : patch.model_mapping;
  }
  if (patch.dimensions != null && patch.dimensions !== "") endpoint.dimensions = Number(patch.dimensions);
  if (patch.enabled != null) endpoint.enabled = Boolean(patch.enabled);
  if (patch.expose_models != null) endpoint.expose_models = Boolean(patch.expose_models);
  if (patch.options != null) {
    endpoint.options = typeof patch.options === "string" ? JSON.parse(patch.options) : patch.options;
  }
  if (patch.is_default) {
    for (const ep of state.config.clients[found.client].endpoints || []) {
      if ((ep.purpose || "chat") === (endpoint.purpose || "chat")) ep.is_default = ep.id === id;
    }
  }
  if (patch.api_key_env) state.secrets.api_keys[id] = `env:${patch.api_key_env}`;
  else if (patch.api_key) state.secrets.api_keys[id] = patch.api_key;

  const saved = saveState({
    configPath,
    secretsPath,
    config: state.config,
    secrets: state.secrets,
    dryRun,
  });
  return {
    endpoint: summarize(found.client, endpoint, saved.secrets || state.secrets),
    dry_run: Boolean(dryRun),
  };
}

export function removeEndpoint({ configPath, secretsPath, id, yes = false, dryRun = false }) {
  if (!id) {
    throw new CliError({ type: "validation", code: "missing_fields", message: "id is required", fields: ["id"] });
  }
  if (!yes) {
    throw new CliError({
      type: "conflict",
      code: "confirmation_required",
      message: "Refusing to remove endpoint without --yes",
    });
  }
  const state = loadStateOrThrow({ configPath, secretsPath });
  const found = findEndpoint(state.config, id);
  if (!found) {
    throw new CliError({ type: "not_found", code: "endpoint_not_found", message: `Endpoint not found: ${id}` });
  }
  state.config.clients[found.client].endpoints = (state.config.clients[found.client].endpoints || [])
    .filter((ep) => ep.id !== id);
  if (state.secrets?.api_keys) delete state.secrets.api_keys[id];
  saveState({ configPath, secretsPath, config: state.config, secrets: state.secrets, dryRun });
  return { removed: id, client: found.client, dry_run: Boolean(dryRun) };
}

export function setDefaultEndpoint({ configPath, secretsPath, id, dryRun = false }) {
  return updateEndpoint({ configPath, secretsPath, id, is_default: true, dryRun });
}

export function enableEndpoint({ configPath, secretsPath, id, enabled = true, dryRun = false }) {
  return updateEndpoint({ configPath, secretsPath, id, enabled, dryRun });
}

export { isCapabilityEndpoint };
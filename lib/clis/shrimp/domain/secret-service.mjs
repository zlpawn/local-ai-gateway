import { CliError, formatSecretState } from "../protocol.mjs";
import { loadStateOrThrow, saveState } from "./config-service.mjs";

function findEndpointClient(config, endpointId) {
  for (const [client, body] of Object.entries(config.clients || {})) {
    for (const endpoint of body.endpoints || []) {
      if (endpoint.id === endpointId) return { client, endpoint };
    }
  }
  return null;
}

export function listSecrets({ configPath, secretsPath, client } = {}) {
  const state = loadStateOrThrow({ configPath, secretsPath });
  const items = [];
  for (const [clientName, body] of Object.entries(state.config.clients || {})) {
    if (client && client !== clientName) continue;
    for (const endpoint of body.endpoints || []) {
      items.push({
        endpoint_id: endpoint.id,
        client: clientName,
        name: endpoint.name,
        state: formatSecretState(state.secrets?.api_keys?.[endpoint.id]),
      });
    }
  }
  return { items, count: items.length };
}

export function getSecret({ configPath, secretsPath, endpointId }) {
  if (!endpointId) {
    throw new CliError({ type: "validation", code: "missing_fields", message: "endpoint-id is required", fields: ["endpoint-id"] });
  }
  const state = loadStateOrThrow({ configPath, secretsPath });
  const found = findEndpointClient(state.config, endpointId);
  if (!found) {
    throw new CliError({ type: "not_found", code: "endpoint_not_found", message: `Endpoint not found: ${endpointId}` });
  }
  return {
    endpoint_id: endpointId,
    client: found.client,
    name: found.endpoint.name,
    state: formatSecretState(state.secrets?.api_keys?.[endpointId]),
  };
}

export function setSecret({ configPath, secretsPath, endpointId, apiKey, apiKeyEnv, dryRun = false }) {
  if (!endpointId) {
    throw new CliError({ type: "validation", code: "missing_fields", message: "endpoint-id is required", fields: ["endpoint-id"] });
  }
  if (!apiKey && !apiKeyEnv) {
    throw new CliError({
      type: "validation",
      code: "missing_fields",
      message: "Provide --api-key or --api-key-env",
      fields: ["api-key", "api-key-env"],
    });
  }
  const state = loadStateOrThrow({ configPath, secretsPath });
  const found = findEndpointClient(state.config, endpointId);
  if (!found) {
    throw new CliError({ type: "not_found", code: "endpoint_not_found", message: `Endpoint not found: ${endpointId}` });
  }
  state.secrets.api_keys = state.secrets.api_keys || {};
  state.secrets.api_keys[endpointId] = apiKeyEnv ? `env:${apiKeyEnv}` : apiKey;
  saveState({ configPath, secretsPath, config: state.config, secrets: state.secrets, dryRun });
  return {
    endpoint_id: endpointId,
    state: formatSecretState(state.secrets.api_keys[endpointId]),
    dry_run: Boolean(dryRun),
  };
}

export function unsetSecret({ configPath, secretsPath, endpointId, yes = false, dryRun = false }) {
  if (!endpointId) {
    throw new CliError({ type: "validation", code: "missing_fields", message: "endpoint-id is required", fields: ["endpoint-id"] });
  }
  if (!yes) {
    throw new CliError({ type: "conflict", code: "confirmation_required", message: "Refusing to unset secret without --yes" });
  }
  const state = loadStateOrThrow({ configPath, secretsPath });
  if (state.secrets?.api_keys) delete state.secrets.api_keys[endpointId];
  saveState({ configPath, secretsPath, config: state.config, secrets: state.secrets, dryRun });
  return { endpoint_id: endpointId, state: "missing", dry_run: Boolean(dryRun) };
}
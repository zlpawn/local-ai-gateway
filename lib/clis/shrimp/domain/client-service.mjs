import { copyClientEndpoints, createEndpointId } from "../../../config/gateway-config-store.mjs";
import { CliError } from "../protocol.mjs";
import { loadStateOrThrow, saveState } from "./config-service.mjs";

export function listClients({ configPath, secretsPath } = {}) {
  const state = loadStateOrThrow({ configPath, secretsPath });
  const items = Object.entries(state.config.clients || {}).map(([name, body]) => ({
    client: name,
    endpoint_count: body.endpoints?.length || 0,
    has_model_slots: Boolean(body.model_slots && Object.keys(body.model_slots).length),
  }));
  return { items, count: items.length };
}

export function getClient({ configPath, secretsPath, client }) {
  const state = loadStateOrThrow({ configPath, secretsPath });
  const body = state.config.clients?.[client];
  if (!body) {
    throw new CliError({ type: "not_found", code: "client_not_found", message: `Client not found: ${client}` });
  }
  return {
    client,
    endpoint_count: body.endpoints?.length || 0,
    endpoints: (body.endpoints || []).map((ep) => ({
      id: ep.id,
      name: ep.name,
      type: ep.type || null,
      purpose: ep.purpose || "chat",
      is_default: Boolean(ep.is_default),
      enabled: ep.enabled !== false,
    })),
    model_slots: body.model_slots || {},
  };
}

function mergeCopy({ config, secrets, from, to }) {
  const source = config.clients?.[from];
  if (!source) {
    throw new CliError({ type: "not_found", code: "client_not_found", message: `Client not found: ${from}` });
  }
  const target = config.clients?.[to] || { endpoints: [] };
  const existing = Array.isArray(target.endpoints) ? target.endpoints : [];
  const apiKeys = { ...(secrets.api_keys || {}) };
  const cloned = (source.endpoints || []).map((endpoint) => {
    const copy = structuredClone(endpoint);
    const previousId = copy.id;
    copy.id = createEndpointId();
    if (previousId && apiKeys[previousId] != null) apiKeys[copy.id] = apiKeys[previousId];
    return copy;
  });
  config.clients = {
    ...(config.clients || {}),
    [to]: { ...target, endpoints: [...existing, ...cloned] },
  };
  return {
    config,
    secrets: { api_keys: apiKeys },
    copied: cloned.length,
    kept: existing.length,
  };
}

export function copyClient({
  configPath,
  secretsPath,
  from,
  to,
  mode = "replace",
  dryRun = false,
}) {
  if (!from || !to) {
    throw new CliError({
      type: "validation",
      code: "missing_fields",
      message: "from and to are required",
      fields: [!from ? "from" : null, !to ? "to" : null].filter(Boolean),
    });
  }
  if (from === to) {
    throw new CliError({
      type: "validation",
      code: "invalid_arguments",
      message: "from and to must differ",
    });
  }
  const state = loadStateOrThrow({ configPath, secretsPath });
  if (!state.config.clients?.[from]) {
    throw new CliError({ type: "not_found", code: "client_not_found", message: `Client not found: ${from}` });
  }

  const targetEndpoints = state.config.clients?.[to]?.endpoints || [];
  if (mode === "fill-empty" && targetEndpoints.length) {
    return {
      from,
      to,
      mode,
      copied: 0,
      skipped: targetEndpoints.length,
      secrets_copied: 0,
      message: "target already has endpoints",
      dry_run: Boolean(dryRun),
    };
  }

  let result;
  if (mode === "merge") {
    result = mergeCopy({
      config: structuredClone(state.config),
      secrets: structuredClone(state.secrets),
      from,
      to,
    });
  } else if (mode === "replace" || mode === "fill-empty") {
    result = copyClientEndpoints({
      config: structuredClone(state.config),
      secrets: structuredClone(state.secrets),
      from,
      to,
    });
  } else {
    throw new CliError({
      type: "validation",
      code: "invalid_arguments",
      message: `Unknown mode: ${mode}`,
      hint: "Use replace | merge | fill-empty",
    });
  }

  saveState({
    configPath,
    secretsPath,
    config: result.config,
    secrets: result.secrets,
    dryRun,
  });

  const secretsCopied = (result.config.clients?.[to]?.endpoints || []).filter(
    (ep) => result.secrets?.api_keys?.[ep.id] != null,
  ).length;

  return {
    from,
    to,
    mode,
    copied: result.copied,
    secrets_copied: secretsCopied,
    dry_run: Boolean(dryRun),
  };
}

export function addClient({ configPath, secretsPath, client, copyFrom, mode = "replace", protocol, dryRun = false }) {
  if (!client) {
    throw new CliError({ type: "validation", code: "missing_fields", message: "client is required", fields: ["client"] });
  }
  const resolvedProtocol = resolveClientProtocol(protocol, copyFrom);
  if (resolvedProtocol && !["anthropic", "openai"].includes(resolvedProtocol)) {
    throw new CliError({ type: "validation", code: "invalid_arguments", message: `Unknown protocol: ${protocol}. Use anthropic | openai`, hint: "Use anthropic | openai" });
  }
  const state = loadStateOrThrow({ configPath, secretsPath });
  if (state.config.clients?.[client] && !copyFrom) {
    throw new CliError({ type: "conflict", code: "client_exists", message: `Client already exists: ${client}` });
  }
  const existing = state.config.clients?.[client];
  state.config.clients = {
    ...(state.config.clients || {}),
    [client]: existing || { endpoints: [] },
  };
  // Stamp the protocol onto the new (or newly-seeded) group so routing knows
  // which wire format to serve. Built-ins infer this from their name; custom
  // groups must carry it explicitly.
  if (resolvedProtocol) {
    state.config.clients[client].protocol = resolvedProtocol;
  }
  if (!copyFrom) {
    saveState({ configPath, secretsPath, config: state.config, secrets: state.secrets, dryRun });
    return { client, created: true, protocol: resolvedProtocol || null, dry_run: Boolean(dryRun) };
  }
  const result = copyClient({ configPath, secretsPath, from: copyFrom, to: client, mode, dryRun });
  // copyClient re-reads state from disk, so re-stamp the protocol and persist.
  if (resolvedProtocol) {
    const after = loadStateOrThrow({ configPath, secretsPath });
    if (after.config.clients?.[client]) {
      after.config.clients[client].protocol = resolvedProtocol;
      saveState({ configPath, secretsPath, config: after.config, secrets: after.secrets, dryRun });
    }
  }
  return { ...result, protocol: resolvedProtocol || null };
}

// Resolve the protocol for a new agent-node group. An explicit choice wins;
// otherwise inherit from the source client (codex/deeptutor -> openai, the
// rest -> anthropic), defaulting to anthropic when there is no source.
function resolveClientProtocol(explicit, copyFrom) {
  if (explicit === "anthropic" || explicit === "openai") return explicit;
  if (copyFrom && (copyFrom === "codex" || copyFrom === "deeptutor")) return "openai";
  return "anthropic";
}

export function removeClient({ configPath, secretsPath, client, yes = false, dryRun = false }) {
  if (!client) {
    throw new CliError({ type: "validation", code: "missing_fields", message: "client is required", fields: ["client"] });
  }
  if (!yes) {
    throw new CliError({ type: "conflict", code: "confirmation_required", message: "Refusing to remove client without --yes" });
  }
  const state = loadStateOrThrow({ configPath, secretsPath });
  if (!state.config.clients?.[client]) {
    throw new CliError({ type: "not_found", code: "client_not_found", message: `Client not found: ${client}` });
  }
  for (const ep of state.config.clients[client].endpoints || []) {
    if (state.secrets?.api_keys) delete state.secrets.api_keys[ep.id];
  }
  delete state.config.clients[client];
  saveState({ configPath, secretsPath, config: state.config, secrets: state.secrets, dryRun });
  return { removed: client, dry_run: Boolean(dryRun) };
}
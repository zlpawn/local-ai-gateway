import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SUPPORTED_WEB_SEARCH_PROVIDERS = new Set(["tavily"]);
const MEDIA_PURPOSES = new Set(["image_generation", "video_generation", "audio_tts"]);

const MEDIA_PROVIDER_PURPOSES = {
  "grok-subscription": new Set(["image_generation", "video_generation"]),
  "codex-subscription": new Set(["image_generation"]),
  "antigravity": new Set(["image_generation"]),
  "huoshan-agentplan": new Set(["image_generation", "video_generation", "audio_tts"]),
};

export function isCapabilityEndpoint(endpoint) {
  return (
    endpoint?.purpose === "vision_fallback" ||
    endpoint?.purpose === "web_search" ||
    endpoint?.purpose === "embedding" ||
    endpoint?.purpose === "image_generation" ||
    endpoint?.purpose === "video_generation" ||
    endpoint?.purpose === "audio_tts"
  );
}

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

export function copyClientEndpoints({
  config,
  secrets,
  from,
  to,
  mode = "replace",
  idFactory = createEndpointId,
}) {
  const sourceClient = config?.clients?.[from];
  if (!sourceClient) {
    const error = new Error(`client '${from}' not found`);
    error.code = "client_not_found";
    throw error;
  }
  const sourceEndpoints = Array.isArray(sourceClient?.endpoints)
    ? sourceClient.endpoints
    : [];
  const targetClient = config.clients?.[to] || {};
  const existing = Array.isArray(targetClient.endpoints) ? targetClient.endpoints : [];
  if (mode === "fill-empty" && existing.length) {
    return {
      config,
      secrets: { api_keys: { ...((secrets && secrets.api_keys) || {}) } },
      copied: 0,
      skipped: existing.length,
      mode,
    };
  }
  const apiKeys = { ...((secrets && secrets.api_keys) || {}) };
  const cloned = sourceEndpoints.map((endpoint) => {
    const copy = structuredClone(endpoint);
    const previousId = copy.id;
    copy.id = idFactory();
    if (previousId && apiKeys[previousId] != null) {
      apiKeys[copy.id] = apiKeys[previousId];
    }
    return copy;
  });
  const nextEndpoints = mode === "merge" ? [...existing, ...cloned] : cloned;
  config.clients = {
    ...(config.clients || {}),
    [to]: { ...targetClient, endpoints: nextEndpoints },
  };
  return {
    config,
    secrets: { api_keys: apiKeys },
    copied: cloned.length,
    kept: mode === "merge" ? existing.length : 0,
    mode,
  };
}

function seedDeepTutorFromCodex(prepared, idFactory) {
  if (prepared.config.clients?.deeptutor) return false;
  const codexEndpoints = prepared.config.clients?.codex?.endpoints;
  if (!Array.isArray(codexEndpoints) || !codexEndpoints.length) return false;
  const result = copyClientEndpoints({
    config: prepared.config,
    secrets: prepared.secrets,
    from: "codex",
    to: "deeptutor",
    idFactory,
  });
  prepared.secrets = result.secrets;
  prepared.hasSecrets = Object.keys(prepared.secrets.api_keys).length > 0;
  return true;
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
  seedDeepTutorFromCodex(prepared, idFactory);
  const issues = validateGatewayConfig(prepared.config, {
    officialCodexIds,
    allowModelConflicts: true,
  });
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
  const prepared = prepareState(config || {}, existingSecrets, idFactory, {
    generateMissingIds: false,
    pruneSecrets: true,
  });
  const issues = validateGatewayConfig(prepared.config, { officialCodexIds });
  if (issues.length) throw new GatewayConfigError(issues);

  const configChanged = writeJsonIfChanged(configPath, prepared.config);
  const secretsChanged = prepared.hasSecrets || fs.existsSync(secretsPath)
    ? writeJsonIfChanged(secretsPath, prepared.secrets, 0o600)
    : false;
  return { ...prepared, configChanged, secretsChanged, configPath, secretsPath };
}

export function getEndpointApiKey(endpoint, secrets, env = process.env, allEndpoints = []) {
  let value = String(secrets?.api_keys?.[endpoint?.id] || "");
  if (!value && endpoint?.base_url && Array.isArray(allEndpoints)) {
    const sameHost = allEndpoints.find(
      (e) => e?.base_url === endpoint.base_url && secrets?.api_keys?.[e.id],
    );
    if (sameHost) {
      value = String(secrets.api_keys[sameHost.id]);
    }
  }
  if (!value) return "";
  if (!value.startsWith("env:")) return value;
  return env[value.slice(4)] || "";
}


export function selectEmbeddingEndpoints(endpoints = []) {
  return (endpoints || []).filter(
    (endpoint) => endpoint?.purpose === "embedding" && endpoint?.enabled !== false,
  );
}

export function selectDefaultEmbeddingEndpoint(endpoints = []) {
  const candidates = selectEmbeddingEndpoints(endpoints);
  return candidates.find((ep) => ep.is_default === true) || candidates[0] || null;
}

export function selectMediaEndpoints(endpoints = [], purpose) {
  return (endpoints || []).filter(
    (endpoint) => endpoint?.purpose === purpose && endpoint?.enabled !== false,
  );
}

export function selectDefaultMediaEndpoint(endpoints = [], purpose) {
  const candidates = selectMediaEndpoints(endpoints, purpose);
  return candidates.find((ep) => ep.is_default === true) || candidates[0] || null;
}

export function selectExposedEndpoints(endpoints = []) {
  const ordinary = endpoints.filter((endpoint) => !isCapabilityEndpoint(endpoint));
  const selected = ordinary.filter((endpoint) => endpoint?.expose_models === true);
  return selected.length ? selected : ordinary;
}

export function buildClaudeInferenceModels(endpoints = [], existingModels = []) {
  const previousByName = new Map(
    (Array.isArray(existingModels) ? existingModels : [])
      .filter((model) => model?.name)
      .map((model) => [model.name, model]),
  );
  const models = [];
  const seen = new Set();
  const addModel = (name, upstreamModel, endpoint) => {
    const publicName = String(name || "").trim();
    if (!isClaudePublicModelName(publicName) || seen.has(publicName)) return;
    seen.add(publicName);
    // Derive supports1m from the upstream model's configured context_window.
    // Desktop reads this flag to decide whether to enable 1M context.
    const contextWindow = resolveModelContextWindow(upstreamModel, endpoint);
    const previous = previousByName.get(publicName) || {};
    models.push({
      ...previous,
      name: publicName,
      labelOverride: upstreamModel || publicName,
      supports1m: contextWindow >= 1000000 || previous.supports1m === true,
    });
  };
  for (const endpoint of endpoints) {
    for (const [name, upstreamModel] of Object.entries(endpoint.model_mapping || {})) {
      addModel(name, upstreamModel, endpoint);
    }
  }
  return models;
}

function resolveModelContextWindow(modelId, endpoint) {
  const configured = endpoint?.model_capabilities?.[modelId]?.context_window;
  if (typeof configured === 'number' && configured > 0) return configured;
  return 1000000;
}

export function buildClaudeCodeModelRoutes(endpoints = []) {
  const exposedEndpoints = selectExposedEndpoints(endpoints);
  const candidates = [];

  for (const endpoint of exposedEndpoints) {
    const endpointId = String(endpoint?.id || "").trim();
    if (!endpointId) continue;

    const seen = new Set();
    const addCandidate = (displayName, upstreamModel) => {
      const name = String(displayName || "").trim();
      const upstream = String(upstreamModel || "").trim();
      if (!name || !upstream || seen.has(name)) return;
      seen.add(name);
      candidates.push({ endpoint, endpointId, name, upstream });
    };

    for (const [name, upstream] of Object.entries(endpoint.model_mapping || {})) {
      addCandidate(name, upstream);
    }
    for (const model of endpoint.models || []) addCandidate(model, model);
  }

  const nameCounts = new Map();
  for (const candidate of candidates) {
    nameCounts.set(candidate.name, (nameCounts.get(candidate.name) || 0) + 1);
  }

  const routes = new Map();
  const models = candidates.map((candidate) => {
    const id = `anthropic.gateway.${candidate.endpointId}.${candidate.name}`;
    const endpointName = String(candidate.endpoint?.name || candidate.endpointId).trim();
    const displayName = nameCounts.get(candidate.name) > 1
      ? `${candidate.name} · ${endpointName}`
      : candidate.name;
    routes.set(id, {
      endpoint: candidate.endpoint,
      upstream_model: candidate.upstream,
      display_name: displayName,
    });
    return {
      id,
      display_name: displayName,
      owned_by: candidate.endpointId,
    };
  });

  return { models, routes };
}

export function validateGatewayConfig(
  config,
  { officialCodexIds = new Set(), allowModelConflicts = false } = {},
) {
  const issues = [];
  const endpointIds = new Map();

  for (const [clientName, client] of Object.entries(config?.clients || {})) {
    const endpoints = Array.isArray(client?.endpoints) ? client.endpoints : [];
    const ordinaryEndpoints = endpoints.filter((endpoint) => !isCapabilityEndpoint(endpoint));
    const visionEndpoints = endpoints.filter((endpoint) => endpoint?.purpose === "vision_fallback");
    const webSearchEndpoints = endpoints.filter((endpoint) => endpoint?.purpose === "web_search");
    if (visionEndpoints.length > 1) {
      issues.push({
        code: "multiple_vision_fallback_endpoints",
        client: clientName,
        message: `Client '${clientName}' has more than one vision fallback endpoint.`,
      });
    }
    const embeddingEndpoints = endpoints.filter((endpoint) => endpoint?.purpose === "embedding");
    const embeddingDefaults = embeddingEndpoints.filter((endpoint) => endpoint?.is_default === true);
    if (embeddingDefaults.length > 1) {
      issues.push({
        code: "multiple_default_embedding_endpoints",
        client: clientName,
        message: `Client '${clientName}' has more than one default embedding endpoint.`,
      });
    }
    const webSearchDefaults = webSearchEndpoints.filter((endpoint) => endpoint?.is_default === true);
    const mediaEndpointsForDefaults = endpoints.filter((ep) => MEDIA_PURPOSES.has(ep?.purpose));
    const mediaDefaults = {};
    for (const ep of mediaEndpointsForDefaults) {
      if (ep.is_default === true) {
        mediaDefaults[ep.purpose] = (mediaDefaults[ep.purpose] || 0) + 1;
      }
    }
    for (const [purpose, count] of Object.entries(mediaDefaults)) {
      if (count > 1) {
        issues.push({
          code: "multiple_default_media_endpoints",
          client: clientName,
          message: `Client '${clientName}' has more than one default ${purpose} endpoint.`,
        });
      }
    }
    if (webSearchDefaults.length > 1) {
      issues.push({
        code: "multiple_default_web_search_endpoints",
        client: clientName,
        message: `Client '${clientName}' has more than one default web_search endpoint.`,
      });
    }
    const defaults = ordinaryEndpoints.filter((endpoint) => endpoint?.is_default === true);
    if (defaults.length > 1) {
      issues.push({
        code: "multiple_default_endpoints",
        client: clientName,
        message: `Client '${clientName}' has more than one default endpoint.`,
      });
    }
    if (clientName === "code" && client?.model_slots) {
      const defaultEndpoint =
        defaults[0] ||
        (ordinaryEndpoints.length === 1 ? ordinaryEndpoints[0] : null);
      const available = new Set([
        ...(defaultEndpoint?.models || []),
        ...Object.keys(defaultEndpoint?.model_mapping || {}),
      ]);
      for (const slot of ["opus", "sonnet", "haiku", "fable"]) {
        const modelId = String(client.model_slots[slot] || "").trim();
        if (!modelId) continue;
        if (!defaultEndpoint || !available.has(modelId)) {
          issues.push({
            code: "invalid_claude_code_model_slot",
            client: "code",
            slot,
            model_id: modelId,
            endpoint_id: defaultEndpoint?.id || "",
            message: `Claude Code model slot '${slot}' must reference a model exposed by the default endpoint.`,
          });
        }
      }
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

      if (endpoint?.purpose === "vision_fallback") {
        const visionModel = String(endpoint.vision_model || "").trim();
        if (!visionModel || !(endpoint.models || []).includes(visionModel)) {
          issues.push({
            code: "invalid_vision_fallback_model",
            client: clientName,
            endpoint_id: id,
            message: `Client '${clientName}' vision fallback endpoint must select one model from its model list.`,
          });
        }
        continue;
      }

      if (endpoint?.purpose === "embedding") {
        if (!String(endpoint.base_url || "").trim()) {
          issues.push({
            code: "missing_embedding_base_url",
            client: clientName,
            endpoint_id: id,
            message: `Client '${clientName}' embedding endpoint must set a base_url.`,
          });
        }
        if (!["openai-chat", "openai-responses"].includes(endpoint.type)) {
          issues.push({
            code: "unsupported_embedding_endpoint_type",
            client: clientName,
            endpoint_id: id,
            message: `Client '${clientName}' embedding endpoint must use the OpenAI-compatible protocol.`,
          });
        }
        const embeddingModel = String(endpoint.embedding_model || "").trim();
        if (
          embeddingModel &&
          Array.isArray(endpoint.models) &&
          endpoint.models.length > 0 &&
          !endpoint.models.includes(embeddingModel)
        ) {
          issues.push({
            code: "invalid_embedding_model",
            client: clientName,
            endpoint_id: id,
            message: `Client '${clientName}' embedding endpoint selected model '${embeddingModel}' must be in its model list.`,
          });
        }
        continue;
      }

      if (endpoint?.purpose === "web_search") {
        const provider = String(endpoint.provider || endpoint.search_provider || "").trim().toLowerCase();
        if (!provider) {
          issues.push({
            code: "missing_web_search_provider",
            client: clientName,
            endpoint_id: id,
            message: `Client '${clientName}' web_search endpoint must set provider (e.g. tavily).`,
          });
        } else if (!SUPPORTED_WEB_SEARCH_PROVIDERS.has(provider)) {
          issues.push({
            code: "unsupported_web_search_provider",
            client: clientName,
            endpoint_id: id,
            message: `Client '${clientName}' web_search provider '${provider}' is not supported. Supported: ${[...SUPPORTED_WEB_SEARCH_PROVIDERS].join(", ")}.`,
          });
        }
        continue;
      }

      // Media endpoint validation
      if (MEDIA_PURPOSES.has(endpoint?.purpose)) {
        const mediaProvider = String(endpoint.provider || "").trim();
        if (!mediaProvider) {
          issues.push({
            code: "missing_media_provider",
            client: clientName,
            endpoint_id: id,
            message: `Client '${clientName}' media endpoint must set provider.`,
          });
        } else if (!(mediaProvider in MEDIA_PROVIDER_PURPOSES)) {
          issues.push({
            code: "unsupported_media_provider",
            client: clientName,
            endpoint_id: id,
            message: `Client '${clientName}' media provider '${mediaProvider}' is not supported. Supported: ${Object.keys(MEDIA_PROVIDER_PURPOSES).join(", ")}.`,
          });
        } else if (!MEDIA_PROVIDER_PURPOSES[mediaProvider].has(endpoint.purpose)) {
          issues.push({
            code: "media_provider_purpose_mismatch",
            client: clientName,
            endpoint_id: id,
            message: `Client '${clientName}' provider '${mediaProvider}' does not support purpose '${endpoint.purpose}'.`,
          });
        }
        continue;
      }

      const occurrences = [
        ...(clientName === "desktop"
          ? []
          : (Array.isArray(endpoint?.models) ? endpoint.models : []).map((modelId) => ({
            modelId,
            source: "models",
          }))),
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
        const ctxWindow = endpoint?.model_capabilities?.[modelId]?.context_window;
        if (ctxWindow != null && (typeof ctxWindow !== "number" || !Number.isInteger(ctxWindow) || ctxWindow <= 0)) {
          issues.push({
            code: "invalid_context_window",
            client: clientName,
            endpoint_id: id,
            model_id: modelId,
            message: `Client '${clientName}' endpoint '${id}' model '${modelId}' context_window must be a positive integer, got ${JSON.stringify(ctxWindow)}.`,
          });
        }
      }
    }

    const invalidClaudeSuggestions = new Set();
    for (const [modelId, occurrences] of publicIds) {
      if (
        clientName === "desktop" &&
        !allowModelConflicts &&
        !isClaudePublicModelName(modelId)
      ) {
        const suggestion = nextClaudePublicNameSuggestion(
          modelId,
          new Set(publicIds.keys()),
          invalidClaudeSuggestions,
        );
        invalidClaudeSuggestions.add(suggestion);
        issues.push({
          code: "invalid_claude_model_name",
          client: clientName,
          model_id: modelId,
          suggestion,
          occurrences,
          message: `Claude Desktop public model '${modelId}' must use a versioned Claude model name such as '${suggestion}'.`,
        });
      }

      if (occurrences.length > 1 && !allowModelConflicts) {
        const used = new Set(publicIds.keys());
        const suggested = new Set();
        const enriched = clientName === "desktop"
          ? occurrences.map((occurrence, index) => {
            const suggestion = index === 0 && isClaudePublicModelName(modelId)
              ? modelId
              : nextClaudeVersionSuggestion(modelId, used, suggested);
            suggested.add(suggestion);
            return { ...occurrence, suggestion };
          })
          : occurrences.map((occurrence) => {
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
      if (
        clientName === "codex" &&
        officialCodexIds.has(modelId) &&
        !allowModelConflicts
      ) {
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

function prepareState(
  inputConfig,
  existingSecrets,
  idFactory,
  { generateMissingIds = true, pruneSecrets = false } = {},
) {
  const source = inputConfig && typeof inputConfig === "object"
    ? structuredClone(inputConfig)
    : {};
  const config = source.clients ? source : migrateLegacyConfig(source);
  config.server ||= {};
  config.clients ||= {};
  if (source.tools) config.tools = source.tools;

  const apiKeys = { ...(existingSecrets?.api_keys || {}) };
  const endpointIds = new Set();
  for (const client of Object.values(config.clients)) {
    client.endpoints = Array.isArray(client?.endpoints) ? client.endpoints : [];
    for (const endpoint of client.endpoints) {
      if (!endpoint.id && generateMissingIds) endpoint.id = idFactory();
      if (endpoint.id) endpointIds.add(endpoint.id);
      const inlineSecret =
        typeof endpoint.api_key === "string" && endpoint.api_key
          ? endpoint.api_key
          : typeof endpoint.api_key_env === "string" && endpoint.api_key_env
            ? `env:${endpoint.api_key_env}`
            : "";
      if (endpoint.id && inlineSecret) {
        apiKeys[endpoint.id] = inlineSecret;
      }
      delete endpoint.api_key;
      delete endpoint.api_key_env;
      delete endpoint.has_api_key;
    }
  }
  if (pruneSecrets) {
    for (const endpointId of Object.keys(apiKeys)) {
      if (!endpointIds.has(endpointId)) delete apiKeys[endpointId];
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

function isClaudePublicModelName(value) {
  return /^claude-[a-z0-9]+-\d+(?:-\d+)*(?:-max)?$/i.test(String(value || "").trim());
}

function nextClaudePublicNameSuggestion(modelId, used, suggested) {
  const source = String(modelId || "").toLowerCase();
  const family = source.includes("haiku")
    ? "haiku"
    : source.includes("sonnet") || source.includes("deepseek")
      ? "sonnet"
      : source.includes("fable")
        ? "fable"
        : "opus";
  const base = family === "fable" ? `claude-${family}-5` : `claude-${family}-4-7`;
  return nextClaudeVersionSuggestion(base, used, suggested, { allowCurrent: true });
}

function nextClaudeVersionSuggestion(
  modelId,
  used,
  suggested,
  { allowCurrent = false } = {},
) {
  const parsed = String(modelId || "").match(
    /^claude-([a-z0-9]+)-(\d+)(?:-(\d{1,2}))?/i,
  );
  const family = parsed?.[1]?.toLowerCase() || "opus";
  let major = Number(parsed?.[2] || 4);
  let minor = parsed?.[3] == null ? null : Number(parsed[3]);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = minor == null
      ? `claude-${family}-${major}`
      : `claude-${family}-${major}-${minor}`;
    if (
      (allowCurrent || candidate !== modelId) &&
      !suggested.has(candidate) &&
      (!used.has(candidate) || (allowCurrent && attempt === 0))
    ) {
      return candidate;
    }
    if (minor == null) {
      major = Math.max(1, major - 1);
    } else if (minor > 0) {
      minor -= 1;
    } else {
      major = Math.max(1, major - 1);
      minor = 9;
    }
    allowCurrent = true;
  }
  return `claude-${family}-${major}-${minor ?? 1}`;
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

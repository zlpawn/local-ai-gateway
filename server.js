import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync, exec } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { URL, fileURLToPath } from "node:url";
import https from "node:https";
import { Readable } from "node:stream";
import { HttpsProxyAgent } from "https-proxy-agent";
import { responsesRequestToChat } from "./lib/codex/chat-request-adapter.mjs";
import {
  chatCompletionToResponse,
  streamChatAsResponses,
} from "./lib/codex/chat-response-adapter.mjs";
import { buildCodexCatalog } from "./lib/codex/model-catalog.mjs";
import { bindRequestAbort } from "./lib/codex/request-abort.mjs";
import { collectResponsesStream } from "./lib/codex/responses-collector.mjs";
import {
  isOfficialCodexModelId,
  mergeOfficialDiscoveryModels,
  officialModelsFromOpenAIList,
} from "./lib/codex/official-models.mjs";
import { unifyCodexHistory } from "./lib/codex/history-unify.mjs";
import { pipeResponsesSsePassthrough } from "./lib/codex/responses-passthrough.mjs";
import { ResponsesWriter } from "./lib/codex/responses-writer.mjs";
import {
  GatewayConfigError,
  buildClaudeCodeModelRoutes,
  buildClaudeInferenceModels,
  getEndpointApiKey,
  loadGatewayState,
  saveGatewayState,
  selectExposedEndpoints,
} from "./lib/config/gateway-config-store.mjs";
import { syncClaudeCodeSettings } from "./lib/config/claude-code-settings.mjs";
import {
  collectImages,
  containsImages,
  imagePartToUrl,
  isImageCapabilityError,
  replaceImagesWithDescription,
  selectVisionFallback,
  shouldPreprocessImages,
} from "./lib/vision-fallback.mjs";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

loadDotEnv();
enableNodeEnvProxy();

const ENV_PORT = intEnv("GATEWAY_PORT", intEnv("PORT", 0));
const ENV_HOST = process.env.GATEWAY_HOST || process.env.HOST || "";
const REQUEST_TIMEOUT_MS = intEnv("REQUEST_TIMEOUT_MS", 120000);
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || "";
const CONFIGURED_API_KEY_SENTINEL = "all";
const ARK_API_KEY = process.env.ARK_API_KEY || "";
const ARK_AUTH_SCHEME = (process.env.ARK_AUTH_SCHEME || "bearer").toLowerCase();
const ARK_MODEL = process.env.ARK_MODEL || "";
const ARK_BASE_URL = trimRight(
  process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/plan",
  "/",
);
const ARK_MESSAGES_URL = process.env.ARK_MESSAGES_URL || `${ARK_BASE_URL}/v1/messages`;
const ARK_CODEX_BASE_URL = trimRight(
  process.env.ARK_CODEX_BASE_URL || "https://ark.cn-beijing.volces.com/api/plan/v3",
  "/",
);
const GATEWAY_CONFIG_FILE = resolveProjectPath(process.env.GATEWAY_CONFIG_FILE || "gateway.config.json");
const GATEWAY_SECRETS_FILE = resolveProjectPath(
  process.env.GATEWAY_SECRETS_FILE ||
  path.join(path.dirname(GATEWAY_CONFIG_FILE), "gateway.secrets.json"),
);
const CLAUDE_3P_CONFIG_FILE = process.env.CLAUDE_3P_CONFIG_FILE || "";
const CLAUDE_3P_CONFIG_LIBRARY = process.env.CLAUDE_3P_CONFIG_LIBRARY || "";
const CLAUDE_3P_SYNC_DISABLED = isTruthy(process.env.CLAUDE_3P_SYNC_DISABLED);
const CLAUDE_CODE_SYNC_DISABLED = isTruthy(process.env.CLAUDE_CODE_SYNC_DISABLED);
const CLAUDE_CODE_SETTINGS_FILE = process.env.CLAUDE_CODE_SETTINGS_FILE || "";
const ANTHROPIC_BASE_URL = trimRight(
  process.env.OFFICIAL_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_UPSTREAM_BASE_URL || "https://api.anthropic.com",
  "/",
);
const ANTHROPIC_MESSAGES_URL =
  process.env.OFFICIAL_ANTHROPIC_MESSAGES_URL || `${ANTHROPIC_BASE_URL}/v1/messages`;
const OFFICIAL_CLAUDE_MODELS = parseList(
  process.env.OFFICIAL_CLAUDE_MODELS ||
    "claude-3-5-sonnet-20241022,claude-3-5-sonnet-latest,claude-3-5-haiku-20241022,claude-3-5-haiku-latest,claude-3-opus-20240229,claude-3-opus-latest",
);
const OFFICIAL_CLAUDE_MODEL_IDS = new Set(OFFICIAL_CLAUDE_MODELS);
let GATEWAY_STATE = loadGatewayState({
  configPath: GATEWAY_CONFIG_FILE,
  secretsPath: GATEWAY_SECRETS_FILE,
});
let GATEWAY_CONFIG = GATEWAY_STATE.config;
let GATEWAY_SECRETS = GATEWAY_STATE.secrets;
let CLAUDE_CODE_MODEL_ROUTES = buildClaudeCodeModelRoutes(
  GATEWAY_CONFIG.clients?.code?.endpoints || [],
);
const LISTEN_HOST = ENV_HOST || GATEWAY_CONFIG.server?.host || "127.0.0.1";
const LISTEN_PORT = ENV_PORT || Number(GATEWAY_CONFIG.server?.port) || 8787;
const _allEndpoints = [
  ...(GATEWAY_CONFIG.clients?.code?.endpoints || []),
  ...(GATEWAY_CONFIG.clients?.desktop?.endpoints || []),
  ...(GATEWAY_CONFIG.clients?.claude?.endpoints || []),
  ...(GATEWAY_CONFIG.clients?.codex?.endpoints || [])
].filter((endpoint) => endpoint?.purpose !== "vision_fallback");
let EXPOSED_MODELS = [...new Set(_allEndpoints.flatMap(ep => [
  ...(ep.models || []),
  ...Object.keys(ep.model_mapping || {})
]))];
if (EXPOSED_MODELS.length === 0) {
  EXPOSED_MODELS.push(...parseList(process.env.EXPOSED_MODELS || process.env.MODEL_LIST || "claude-sonnet"));
}
const MODEL_ALIASES = {
  ...parseAliases(process.env.MODEL_ALIASES || ""),
};
const MODEL_DISPLAY_NAMES = {
  ...GATEWAY_CONFIG.displayNames,
};
const LOG_FILE = resolveProjectPath(process.env.LOG_FILE || "gateway.log");
// Auth may follow CODEX_HOME (Codex CLI convention). The Desktop catalog file
// always defaults to the real user profile ~/.codex so config.toml snippets stay
// stable even if a shell/session overrides CODEX_HOME for a worktree.
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_AUTH_PATH = path.join(CODEX_HOME, "auth.json");
const CODEX_USER_HOME = path.join(os.homedir(), ".codex");
const CODEX_MODEL_CATALOG_PATH =
  process.env.CODEX_MODEL_CATALOG_PATH || path.join(CODEX_USER_HOME, "gateway-model-catalog.json");
// Default on so Desktop can point model_catalog_json at a real file after save.
// Set CODEX_WRITE_MODEL_CATALOG_DISABLED=1 to disable disk writes.
const CODEX_WRITE_MODEL_CATALOG = !isTruthy(process.env.CODEX_WRITE_MODEL_CATALOG_DISABLED);
let OFFICIAL_CODEX_CATALOG_MODELS = loadOfficialCodexCatalogModels();
let OFFICIAL_CODEX_MODELS = OFFICIAL_CODEX_CATALOG_MODELS.map((model) => ({
  id: model.slug,
  display_name: model.display_name || model.slug,
  owned_by: "openai",
}));
let CODEX_CATALOG = buildCodexCatalog({
  officialModels: OFFICIAL_CODEX_CATALOG_MODELS,
  endpoints: GATEWAY_CONFIG.clients?.codex?.endpoints || [],
});
let OFFICIAL_CODEX_MODEL_IDS = CODEX_CATALOG.officialIds;
let CODEX_CUSTOM_MODELS = CODEX_CATALOG.models.filter(
  (model) => !OFFICIAL_CODEX_MODEL_IDS.has(model.slug),
);
// Declared before writeCodexModelCatalog runs at startup to avoid TDZ.
let _codexModelsDiscoveryCache = null;
const VISION_DESCRIPTION_CACHE = new Map();

// --- Grok CLI subscription provider ---------------------------------------
// Forwards standard OpenAI requests to the Grok CLI chat proxy
// (https://cli-chat-proxy.grok.com/v1), authenticating with the local
// `grok login` session JWT from ~/.grok/auth.json so the user's SuperGrok
// subscription quota is consumed instead of a paid API key. See
// docs/superpowers/plans/grok-provider-integration.md.
const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const GROK_AUTH_PATH = process.env.GROK_AUTH_PATH || path.join(GROK_HOME, "auth.json");
const GROK_MODELS_CACHE_PATH = path.join(GROK_HOME, "models_cache.json");
const GROK_AGENT_ID_PATH = path.join(GROK_HOME, "agent_id");
const GROK_VERSION_PATH = path.join(GROK_HOME, "version.json");
const GROK_DEFAULT_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
// grok.com is GFW-blocked; the grok CLI reaches it via the Windows system
// proxy (Clash/Mihomo on 127.0.0.1:7897). Node's fetch does not read the
// system proxy, so we tunnel grok requests explicitly.
const GROK_DEFAULT_PROXY = process.env.GROK_PROXY || "http://127.0.0.1:7897";
const GROK_FALLBACK_BACKENDS = {
  "grok-4.5": "responses",
  "grok-build": "chat",
  "grok-composer-2.5-fast": "responses",
};
let GROK_MODEL_CATALOG = loadGrokModelCatalog();
const _grokProxyAgents = new Map();
const _grokSemaphores = new Map();
let _grokClientVersionCache;
const _grokAgentIdCache = new Map();

if (CODEX_WRITE_MODEL_CATALOG) {
  try {
    writeCodexModelCatalog();
  } catch (error) {
    console.warn(`Codex model catalog write failed: ${error.message || error}`);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(error);
    const context = req.gatewayContext || getRequestContext(req);
    logError("request_failed", error, context);
    const status = error.statusCode || 500;
    if (!res.headersSent) {
      sendJson(res, status, {
        error: {
          type: "gateway_error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } else {
      res.end();
    }
  }
});

// Pin Claude Desktop (3p) to this gateway as soon as the process starts,
// even if the listen port is already occupied.
const startupClaude3pSync = syncClaudeThirdPartyInferenceConfig(GATEWAY_CONFIG);
if (startupClaude3pSync?.updated) {
  console.log(
    `Claude Desktop 3p synced: ${startupClaude3pSync.path}` +
    (startupClaude3pSync.models != null ? ` (${startupClaude3pSync.models} models)` : ""),
  );
} else if (startupClaude3pSync?.reason && startupClaude3pSync.reason !== "disabled") {
  console.log(`Claude Desktop 3p sync skipped: ${startupClaude3pSync.reason}`);
}

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  const host = LISTEN_HOST === "0.0.0.0" ? "127.0.0.1" : LISTEN_HOST;
  const url = `http://${host}:${LISTEN_PORT}/`;
  console.log(`Claude -> Ark gateway listening on ${url}`);
  console.log(`Ark Anthropic messages URL: ${ARK_MESSAGES_URL}`);
  console.log(`Ark Codex/OpenAI URL: ${ARK_CODEX_BASE_URL}`);
  console.log(`Official Anthropic messages URL: ${ANTHROPIC_MESSAGES_URL}`);
  console.log(`Gateway config: ${fs.existsSync(GATEWAY_CONFIG_FILE) ? GATEWAY_CONFIG_FILE : "not found"}`);
  console.log(`Providers: ${_allEndpoints.map(e => e.name).join(", ")}`);
  console.log(`Exposed models: ${EXPOSED_MODELS.join(", ")}`);
  console.log(`Official Claude models: ${OFFICIAL_CLAUDE_MODELS.join(", ")}`);
  console.log(`Codex official models: ${OFFICIAL_CODEX_MODELS.length}`);
  console.log(`Codex custom models: ${CODEX_CUSTOM_MODELS.length}`);
  console.log(`Codex model catalog writing: ${CODEX_WRITE_MODEL_CATALOG ? CODEX_MODEL_CATALOG_PATH : "disabled"}`);

  const shouldOpen = !process.env.GATEWAY_NO_OPEN &&
                     !process.env.MOCK_API_KEY &&
                     !process.env.ELECTRON_RUN_AS_NODE &&
                     process.env.NODE_ENV !== "test";
  if (shouldOpen) {
    const startCmd = 
      process.platform === "darwin" ? `open "${url}"` :
      process.platform === "win32" ? `start "" "${url}"` :
      `xdg-open "${url}"`;
    exec(startCmd, (err) => {
      if (err) {
        console.error("Failed to open browser automatically:", err.message);
      }
    });
  }
});

async function route(req, res) {
  const context = getRequestContext(req);
  req.gatewayContext = context;
  const url = context.url;
  const reqPath = context.path;


  if ((reqPath === "/" || reqPath === "/config") && req.method === "GET") {
    const htmlPath = path.join(PROJECT_ROOT, "desktop", "config-panel.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(htmlPath));
    } else {
      sendJson(res, 404, { error: { message: "config-panel.html not found" }});
    }
    return;
  }

  if (reqPath === "/v1/codex/history/unify" && req.method === "POST") {
    if (!checkLocalAuth(req, res)) return;
    try {
      const body = JSON.parse(await readText(req) || "{}");
      const dryRun = body.dry_run !== false && body.apply !== true;
      const result = unifyCodexHistory({
        dryRun,
        allowRunningCodex: Boolean(body.allow_running_codex),
        targetProvider: body.target_provider || "custom",
        sourceProviders: body.source_providers,
      });
      sendJson(res, 200, {
        success: true,
        ...result,
      });
    } catch (error) {
      const status =
        error?.code === "codex_running" ? 409 :
        error?.code === "state_db_missing" ? 404 :
        error?.code === "no_sources" ? 400 :
        500;
      sendJson(res, status, {
        success: false,
        error: {
          type: error?.code || "history_unify_failed",
          message: error instanceof Error ? error.message : String(error),
          running: error?.running || undefined,
        },
      });
    }
    return;
  }

  if (reqPath === "/v1/config/save" && req.method === "POST") {
    if (!checkLocalAuth(req, res)) return;
    try {
      const newConfig = JSON.parse(await readText(req));
      const result = saveGatewayState({
        configPath: GATEWAY_CONFIG_FILE,
        secretsPath: GATEWAY_SECRETS_FILE,
        config: { server: newConfig.server, clients: newConfig.clients },
        officialCodexIds: OFFICIAL_CODEX_MODEL_IDS,
      });
      GATEWAY_CONFIG = result.config;
      GATEWAY_SECRETS = result.secrets;
      const claude3pSync = syncClaudeThirdPartyInferenceConfig(GATEWAY_CONFIG);
      const saveClient = normalizeClientName(req.headers["x-gateway-config-client"]);
      const claudeCodeSync = saveClient === "code"
        ? syncClaudeCodeSettingsIfEnabled(GATEWAY_CONFIG)
        : { updated: false, reason: "not-requested" };
      reloadGatewayConfig({ reloadFiles: false });
      logInfo("gateway_config_saved", {
        config_changed: result.configChanged,
        secrets_changed: result.secretsChanged,
        user_agent: req.headers["user-agent"] || null,
      });
      sendJson(res, 200, {
        success: true,
        config_changed: result.configChanged,
        secrets_changed: result.secretsChanged,
        claude3pSync,
        claudeCodeSync,
        codex_model_catalog: {
          path: CODEX_MODEL_CATALOG_PATH,
          path_posix: toPosixPath(CODEX_MODEL_CATALOG_PATH),
          exists: fs.existsSync(CODEX_MODEL_CATALOG_PATH),
          write_enabled: CODEX_WRITE_MODEL_CATALOG,
        },
      });
    } catch (error) {
      if (error instanceof GatewayConfigError) {
        sendJson(res, 400, {
          error: {
            type: error.code,
            message: "Gateway configuration is invalid.",
            issues: error.issues,
          },
        });
      } else {
        sendJson(res, 500, { error: error.message });
      }
    }
    return;
  }

  if (reqPath === "/v1/config/secret" && req.method === "GET") {
    if (!checkLocalAuth(req, res)) return;
    if (req.headers["x-gateway-secret-intent"] !== "reveal") {
      sendPrivateJson(res, 403, {
        error: {
          type: "secret_reveal_confirmation_required",
          message: "Explicit secret reveal confirmation is required.",
        },
      });
      return;
    }

    const endpointId = String(url.searchParams.get("id") || "").trim();
    const endpointExists = Object.values(GATEWAY_CONFIG.clients || {}).some((client) =>
      (client.endpoints || []).some((endpoint) => endpoint.id === endpointId),
    );
    if (!endpointId || !endpointExists) {
      sendPrivateJson(res, 404, {
        error: {
          type: "endpoint_not_found",
          message: "Endpoint not found.",
        },
      });
      return;
    }

    const storedSecret = String(GATEWAY_SECRETS?.api_keys?.[endpointId] || "");
    if (!storedSecret) {
      sendPrivateJson(res, 404, {
        error: {
          type: "secret_not_found",
          message: "No API key is stored for this endpoint.",
        },
      });
      return;
    }

    sendPrivateJson(res, 200, { api_key: storedSecret });
    return;
  }

  if (req.method === "OPTIONS") {
    sendCors(res, 204);
    return;
  }

  if (reqPath === "/health" && req.method === "GET") {
    const healthModels =
      context.client === "codex"
        ? codexModelDiscovery().data.map((model) => model.id)
        : modelDiscovery().data.map((model) => model.id);
    sendJson(res, 200, {
      ok: true,
      service: "local-ai-gateway",
      process_id: process.pid,
      instance_id: process.env.GATEWAY_INSTANCE_ID || null,
      client: context.client,
      upstream: context.client === "codex" ? ARK_CODEX_BASE_URL : ARK_MESSAGES_URL,
      protocol: context.client === "codex" ? "openai-compatible" : "anthropic-messages",
      models: healthModels,
    });
    return;
  }

  if (reqPath === "/v1/models" && req.method === "GET") {
    if (!checkLocalAuth(req, res)) return;
    logInfo("models_request", {
      request_id: context.requestId,
      client: context.client,
      path: context.originalPath,
      user_agent: req.headers["user-agent"] || null,
    });
    if (context.client === "codex") {
      sendJson(res, 200, await codexModelDiscoveryFresh(context.client));
    } else {
      sendJson(res, 200, modelDiscovery(context.client));
    }
    return;
  }

  if (reqPath === "/v1/config" && req.method === "GET") {
    if (!checkLocalAuth(req, res)) return;
    sendJson(res, 200, publicGatewayConfig());
    return;
  }

  if (reqPath === "/v1/providers" && req.method === "GET") {
    if (!checkLocalAuth(req, res)) return;
    sendJson(res, 200, { providers: publicProviders() });
    return;
  }

  if (reqPath === "/v1/resolve" && req.method === "GET") {
    if (!checkLocalAuth(req, res)) return;
    const model = url.searchParams.get("model") || "";
    if (!model) {
      sendJson(res, 400, {
        error: {
          type: "invalid_request",
          message: "Missing required query parameter: model",
        },
      });
      return;
    }
    sendJson(res, 200, resolveModelPublic(model, context.client));
    return;
  }

  if (reqPath === "/v1/messages" && req.method === "POST") {
    if (!checkLocalAuth(req, res)) return;
    const body = await readJson(req);
    await forwardAnthropicMessages(body, req, res, context);
    return;
  }

  if (reqPath === "/v1/chat/completions" && req.method === "POST") {
    if (!checkLocalAuth(req, res)) return;
    const body = await readJson(req);
    await forwardOpenAIChatCompletions(body, req, res, context);
    return;
  }

  if (reqPath === "/v1/responses" && req.method === "POST") {
    if (!checkLocalAuth(req, res)) return;
    const body = await readJson(req);
    await forwardOpenAIResponses(body, req, res, context);
    return;
  }

  // Codex Desktop built-in image_gen posts to the provider base URL:
  //   POST /codex/v1/images/generations
  //   POST /codex/v1/images/edits
  // Forward to the matching official backend (chatgpt-codex or api.openai.com).
  if (
    (reqPath === "/v1/images/generations" || reqPath === "/v1/images/edits")
    && req.method === "POST"
  ) {
    if (!checkLocalAuth(req, res)) return;
    const kind = reqPath.endsWith("/edits") ? "edits" : "generations";
    await proxyOfficialCodexImages(kind, req, res, context);
    return;
  }

  if (reqPath === "/v1/messages/count_tokens" && req.method === "POST") {
    if (!checkLocalAuth(req, res)) return;
    const body = await readJson(req);
    logInfo("count_tokens_request", {
      request_id: context.requestId,
      client: context.client,
      path: context.originalPath,
      requested_model: body.model || null,
    });
    sendJson(res, 200, { input_tokens: estimateTokens(JSON.stringify(body)) });
    return;
  }

  sendJson(res, 404, {
    error: {
      type: "not_found",
      message: `${req.method} ${url.pathname} is not implemented`,
    },
  });
}

async function forwardAnthropicMessages(body, clientReq, clientRes, context) {
  const requestedModel = body.model;
  const route = resolveAnthropicRoute(requestedModel, context.client);
  body = await maybePreprocessImages(body, route, clientReq, context);
  const upstreamBody =
    route.provider?.type === "openai-chat"
      ? anthropicMessagesToOpenAIChat(body, route.model)
      : {
          ...body,
          model: route.model,
        };

  logInfo("messages_request", {
    request_id: context.requestId,
    client: context.client,
    path: context.originalPath,
    user_agent: clientReq.headers["user-agent"] || null,
    requested_model: requestedModel || null,
    resolved_model: route.model || null,
    provider: route.provider?.id || null,
    route: route.kind,
    stream: Boolean(body.stream),
  });
  if (route.provider?.type === "grok") {
    const backend = grokBackendFor(route.model);
    if (backend === "responses") {
      const chatBody = anthropicMessagesToOpenAIChat(body, route.model);
      const responsesBody = openAIChatCompletionsToResponses(chatBody, route.model);
      let upstream = await fetchGrok(route.provider, "/responses", responsesBody);
      upstream = await maybeRetryAfterImageError({
        upstream,
        originalBody: body,
        route,
        clientReq,
        context,
        fetchAgain: (retryBody) => fetchGrok(
          route.provider,
          "/responses",
          openAIChatCompletionsToResponses(
            anthropicMessagesToOpenAIChat(retryBody, route.model),
            route.model,
          ),
        ),
      });
      logInfo("grok_messages_response", { request_id: context.requestId, status: upstream.status, backend });
      if (body.stream) {
        await streamOpenAIResponseAsAnthropicMessages(upstream, clientRes, requestedModel, context.requestId);
      } else {
        if (await grokSendErrorIfNotOk(upstream, clientRes)) return;
        const completion = await collectResponsesSseAsChatCompletion(upstream, requestedModel);
        clientRes.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        clientRes.end(JSON.stringify(openAIChatCompletionToAnthropicMessage(completion, requestedModel)));
      }
    } else {
      const chatBody = anthropicMessagesToOpenAIChat(body, route.model);
      let upstream = await fetchGrok(route.provider, "/chat/completions", chatBody);
      upstream = await maybeRetryAfterImageError({
        upstream,
        originalBody: body,
        route,
        clientReq,
        context,
        fetchAgain: (retryBody) => fetchGrok(
          route.provider,
          "/chat/completions",
          anthropicMessagesToOpenAIChat(retryBody, route.model),
        ),
      });
      logInfo("grok_messages_response", { request_id: context.requestId, status: upstream.status, backend });
      if (body.stream) {
        await streamOpenAIChatAsAnthropicMessages(upstream, clientRes, requestedModel, context.requestId);
      } else {
        if (await grokSendErrorIfNotOk(upstream, clientRes)) return;
        const completion = await collectChatSseAsChatCompletion(upstream, requestedModel);
        clientRes.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        clientRes.end(JSON.stringify(openAIChatCompletionToAnthropicMessage(completion, requestedModel)));
      }
    }
    return;
  }

  let upstream =
    route.provider?.type === "openai-chat"
      ? await fetchConfiguredOpenAI(route.provider, "/v1/chat/completions", upstreamBody, clientReq)
      : route.provider
        ? await fetchConfiguredAnthropic(route.provider, upstreamBody, clientReq)
        : route.kind === "official"
          ? await fetchOfficialAnthropic(upstreamBody, clientReq)
          : await fetchArkAnthropic(upstreamBody, clientReq);
  if (route.provider) {
    upstream = await maybeRetryAfterImageError({
      upstream,
      originalBody: body,
      route,
      clientReq,
      context,
      fetchAgain: async (retryBody) => {
        const converted = route.provider.type === "openai-chat"
          ? anthropicMessagesToOpenAIChat(retryBody, route.model)
          : { ...retryBody, model: route.model };
        return route.provider.type === "openai-chat"
          ? fetchConfiguredOpenAI(route.provider, "/v1/chat/completions", converted, clientReq)
          : fetchConfiguredAnthropic(route.provider, converted, clientReq);
      },
    });
  }
  logInfo("messages_response", {
    request_id: context.requestId,
    client: context.client,
    status: upstream.status,
    provider: route.provider?.id || null,
    route: route.kind,
  });
  if (route.provider?.type === "openai-chat") {
    if (body.stream) {
      await streamOpenAIChatAsAnthropicMessages(upstream, clientRes, requestedModel, context.requestId);
    } else {
      await sendOpenAIChatAsAnthropicMessage(upstream, clientRes, requestedModel);
    }
    return;
  }

  clientRes.writeHead(upstream.status, responseHeaders(upstream.headers));

  if (!upstream.body) {
    clientRes.end(await upstream.text());
    return;
  }

  await upstream.body.pipeTo(
    new WritableStream({
      write(chunk) {
        clientRes.write(Buffer.from(chunk));
      },
      close() {
        clientRes.end();
      },
      abort(error) {
        console.error(error);
        clientRes.end();
      },
    }),
  );
}

async function forwardOpenAIChatCompletions(body, clientReq, clientRes, context) {
  const requestedModel = body.model;
  if (context.client === "codex" && isOfficialCodexModel(requestedModel)) {
    throw httpError(
      400,
      "Official Codex models are routed through /v1/responses only. Use /v1/responses for gpt-* and o* models.",
    );
  }

  const route = resolveConfiguredModel(requestedModel, ["anthropic", "openai-chat", "openai-responses", "grok"], context.client);
  const resolvedModel = route?.upstream_model || resolveModel(requestedModel);
  body = await maybePreprocessImages(body, route, clientReq, context);
  const upstreamBody =
    route?.provider?.type === "anthropic"
      ? openAIChatToAnthropic(body, resolvedModel)
      : route?.provider?.type === "openai-responses"
        ? openAIChatCompletionsToResponses(body, resolvedModel)
        : {
            ...body,
            model: resolvedModel,
          };

  logInfo("openai_chat_request", {
    request_id: context.requestId,
    client: context.client,
    path: context.originalPath,
    user_agent: clientReq.headers["user-agent"] || null,
    requested_model: requestedModel || null,
    resolved_model: resolvedModel || null,
    provider: route?.provider?.id || null,
    stream: Boolean(body.stream),
  });

  if (route?.provider?.type === "grok") {
    const backend = grokBackendFor(resolvedModel);
    if (backend === "responses") {
      const responsesBody = openAIChatCompletionsToResponses(body, resolvedModel);
      let upstream = await fetchGrok(route.provider, "/responses", responsesBody);
      upstream = await maybeRetryAfterImageError({
        upstream,
        originalBody: body,
        route,
        clientReq,
        context,
        fetchAgain: (retryBody) => fetchGrok(
          route.provider,
          "/responses",
          openAIChatCompletionsToResponses(retryBody, resolvedModel),
        ),
      });
      logInfo("grok_chat_response", { request_id: context.requestId, status: upstream.status, backend });
      if (body.stream) {
        await streamOpenAIResponseAsChatCompletion(upstream, clientRes, requestedModel, context.requestId);
      } else {
        if (await grokSendErrorIfNotOk(upstream, clientRes)) return;
        const completion = await collectResponsesSseAsChatCompletion(upstream, requestedModel);
        clientRes.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        clientRes.end(JSON.stringify(completion));
      }
    } else {
      let upstream = await fetchGrok(route.provider, "/chat/completions", { ...body, model: resolvedModel });
      upstream = await maybeRetryAfterImageError({
        upstream,
        originalBody: body,
        route,
        clientReq,
        context,
        fetchAgain: (retryBody) => fetchGrok(
          route.provider,
          "/chat/completions",
          { ...retryBody, model: resolvedModel },
        ),
      });
      logInfo("grok_chat_response", { request_id: context.requestId, status: upstream.status, backend });
      if (body.stream) {
        await pipeGrokSse(upstream, clientRes, context.requestId);
      } else {
        if (await grokSendErrorIfNotOk(upstream, clientRes)) return;
        const completion = await collectChatSseAsChatCompletion(upstream, requestedModel);
        clientRes.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        clientRes.end(JSON.stringify(completion));
      }
    }
    return;
  }

  let upstream =
    route?.provider?.type === "anthropic"
      ? await fetchConfiguredAnthropic(route.provider, upstreamBody, clientReq)
      : route?.provider?.type === "openai-responses"
        ? await fetchConfiguredOpenAI(route.provider, "/responses", upstreamBody, clientReq)
        : route?.provider
          ? await fetchConfiguredOpenAI(route.provider, "/v1/chat/completions", upstreamBody, clientReq)
      : await fetchArkOpenAI("/chat/completions", upstreamBody, clientReq);
  if (route?.provider) {
    upstream = await maybeRetryAfterImageError({
      upstream,
      originalBody: body,
      route,
      clientReq,
      context,
      fetchAgain: async (retryBody) => {
        const converted = route.provider.type === "anthropic"
          ? openAIChatToAnthropic(retryBody, resolvedModel)
          : route.provider.type === "openai-responses"
            ? openAIChatCompletionsToResponses(retryBody, resolvedModel)
            : { ...retryBody, model: resolvedModel };
        return route.provider.type === "anthropic"
          ? fetchConfiguredAnthropic(route.provider, converted, clientReq)
          : route.provider.type === "openai-responses"
            ? fetchConfiguredOpenAI(route.provider, "/responses", converted, clientReq)
            : fetchConfiguredOpenAI(route.provider, "/v1/chat/completions", converted, clientReq);
      },
    });
  }
  logInfo("openai_chat_response", {
    request_id: context.requestId,
    client: context.client,
    status: upstream.status,
    provider: route?.provider?.id || null,
    translated_to: route?.provider?.type === "anthropic"
      ? "anthropic_messages"
      : route?.provider?.type === "openai-responses"
        ? "responses"
        : null,
  });

  if (route?.provider?.type === "anthropic") {
    if (body.stream) {
      await streamAnthropicAsOpenAIChat(upstream, clientRes, requestedModel, context.requestId);
    } else {
      await sendAnthropicAsOpenAIChat(upstream, clientRes, requestedModel);
    }
    return;
  }

  if (route?.provider?.type === "openai-responses") {
    if (body.stream) {
      await streamOpenAIResponseAsChatCompletion(upstream, clientRes, requestedModel, context.requestId);
    } else {
      await sendOpenAIResponseAsChatCompletion(upstream, clientRes, requestedModel);
    }
    return;
  }

  if (!upstream.body) {
    clientRes.writeHead(upstream.status, responseHeaders(upstream.headers));
    clientRes.end(await upstream.text());
    return;
  }

  clientRes.writeHead(upstream.status, responseHeaders(upstream.headers));
  await upstream.body.pipeTo(
    new WritableStream({
      write(chunk) {
        clientRes.write(Buffer.from(chunk));
      },
      close() {
        clientRes.end();
      },
      abort(error) {
        console.error(error);
        clientRes.end();
      },
    }),
  );
}

// Normalize one tool coming out of an `additional_tools` input item for the
// top-level Responses `tools` array: drop nameless entries, and ensure every
// function tool carries a `parameters` schema (Ark rejects tools without it).
function normalizePromotedTool(tool) {
  if (!tool || typeof tool !== "object" || !tool.name) return null;
  const out = { ...tool };
  if (out.type === "function" && !("parameters" in out)) {
    out.parameters = { type: "object", properties: {} };
  }
  return out;
}

// Codex Desktop declares its tools inside an `input` item of type
// `additional_tools` (role: "developer") instead of the top-level `tools`
// array. The official Codex backend understands that extension, but third-party
// Responses endpoints (Ark, etc.) only read top-level `tools` -- so the model
// gets zero tools and loops on narration ("let me read the skill..."). Promote
// those tools to the top-level `tools` array (flattening `namespace` wrappers
// like codex_app), dedup by name, and drop the non-standard input item.
function promoteAdditionalTools(body) {
  if (!Array.isArray(body?.input)) return body;
  const promoted = [];
  const keptInput = [];
  for (const item of body.input) {
    if (item && item.type === "additional_tools" && Array.isArray(item.tools)) {
      for (const t of item.tools) {
        if (t && t.type === "namespace" && Array.isArray(t.tools)) {
          for (const inner of t.tools) {
            const nt = normalizePromotedTool(inner);
            if (nt) promoted.push(nt);
          }
        } else {
          const nt = normalizePromotedTool(t);
          if (nt) promoted.push(nt);
        }
      }
    } else {
      keptInput.push(item);
    }
  }
  if (promoted.length === 0) return body;
  const existing = Array.isArray(body.tools) ? body.tools : [];
  const seen = new Set(existing.map((t) => t?.name).filter(Boolean));
  const merged = [...existing];
  for (const t of promoted) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    merged.push(t);
  }
  return { ...body, input: keptInput, tools: merged };
}

async function forwardOpenAIResponses(body, clientReq, clientRes, context) {
  const requestAbort = bindRequestAbort(clientReq, clientRes);
  const upstreamAbort = createUpstreamAbort(requestAbort.signal);
  try {
    await forwardResolvedCodexResponse({
      body,
      clientReq,
      clientRes,
      context,
      signal: upstreamAbort.signal,
    });
  } finally {
    upstreamAbort.dispose();
    requestAbort.dispose();
  }
}

async function forwardResolvedCodexResponse({
  body,
  clientReq,
  clientRes,
  context,
  signal,
}) {
  const requestedModel = body.model;
  if (context.client === "codex" && isOfficialCodexModel(requestedModel)) {
    logInfo("openai_responses_request", {
      request_id: context.requestId,
      client: context.client,
      path: context.originalPath,
      user_agent: clientReq.headers["user-agent"] || null,
      requested_model: requestedModel || null,
      resolved_model: requestedModel || null,
      stream: Boolean(body.stream),
      route: "official",
    });
    await proxyOfficialCodexResponse(body, clientReq, clientRes, context, signal);
    return;
  }

  const route = resolveConfiguredModel(
    requestedModel,
    ["anthropic", "openai-chat", "openai-responses", "grok"],
    context.client,
  );
  const resolvedModel = route?.upstream_model || resolveModel(requestedModel);
  body = await maybePreprocessImages(body, route, clientReq, context);
  body = promoteAdditionalTools(body);
  const responseToolKinds = collectResponseToolKinds(body.tools);
  const upstreamBody = route?.provider?.type === "anthropic"
    ? openAIResponsesToAnthropic(body, resolvedModel)
    : {
        ...body,
        model: resolvedModel,
      };

  logInfo("openai_responses_request", {
    request_id: context.requestId,
    client: context.client,
    path: context.originalPath,
    user_agent: clientReq.headers["user-agent"] || null,
    requested_model: requestedModel || null,
    resolved_model: resolvedModel || null,
    provider: route?.provider?.id || null,
    stream: Boolean(body.stream),
    route: route?.provider?.id || "volcengine",
  });

  if (route?.provider?.type === "grok") {
    const backend = grokBackendFor(resolvedModel);
    const chatRequest = backend === "chat"
      ? responsesRequestToChat(body, resolvedModel)
      : null;
    let upstream;
    if (backend === "responses") {
      upstream = await fetchGrok(route.provider, "/responses", { ...body, model: resolvedModel }, signal);
    } else {
      upstream = await fetchGrok(route.provider, "/chat/completions", chatRequest.body, signal);
    }
    upstream = await maybeRetryAfterImageError({
      upstream,
      originalBody: body,
      route,
      clientReq,
      context,
      fetchAgain: (retryBody) => {
        if (backend === "responses") {
          return fetchGrok(
            route.provider,
            "/responses",
            { ...retryBody, model: resolvedModel },
            signal,
          );
        }
        return fetchGrok(
          route.provider,
          "/chat/completions",
          responsesRequestToChat(retryBody, resolvedModel).body,
          signal,
        );
      },
    });
    logInfo("grok_responses_response", { request_id: context.requestId, status: upstream.status, backend });
    if (body.stream) {
      if (backend === "responses") {
        // Grok forces stream:true even for non-stream clients; only the client
        // stream path needs terminal synthesis here.
        await pipeResponsesUpstream(upstream, clientRes, {
          requestId: context.requestId,
          model: requestedModel,
          logName: "grok_passthrough_stream_complete",
        });
      } else {
        await sendChatUpstreamAsResponses({
          upstream,
          clientRes,
          requestedModel,
          toolKinds: chatRequest.toolKinds,
        });
      }
    } else {
      if (await grokSendErrorIfNotOk(upstream, clientRes)) return;
      const response = backend === "responses"
        ? await collectResponsesStream(upstream.body, requestedModel)
        : chatCompletionToResponse({
            completion: await collectChatSseAsChatCompletion(upstream, requestedModel),
            model: requestedModel,
            toolKinds: chatRequest.toolKinds,
          });
      clientRes.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      clientRes.end(JSON.stringify(response));
    }
    return;
  }

  if (route?.provider?.type === "openai-chat") {
    const chatRequest = responsesRequestToChat(body, resolvedModel);
    let upstream = await fetchConfiguredOpenAI(
      route.provider,
      "/v1/chat/completions",
      chatRequest.body,
      clientReq,
      signal,
      context.client !== "codex",
    );
    upstream = await maybeRetryAfterImageError({
      upstream,
      originalBody: body,
      route,
      clientReq,
      context,
      fetchAgain: async (retryBody) => {
        const retryRequest = responsesRequestToChat(retryBody, resolvedModel);
        return fetchConfiguredOpenAI(
          route.provider,
          "/v1/chat/completions",
          retryRequest.body,
          clientReq,
          signal,
          context.client !== "codex",
        );
      },
    });
    logInfo("openai_responses_response", {
      request_id: context.requestId,
      client: context.client,
      status: upstream.status,
      provider: route.provider.id || null,
      translated_to: "chat_completions",
    });

    if (body.stream) {
      await sendChatUpstreamAsResponses({
        upstream,
        clientRes,
        requestedModel,
        toolKinds: chatRequest.toolKinds,
      });
    } else {
      if (!upstream.ok) {
        await sendUpstreamError(upstream, clientRes);
        return;
      }
      const completion = await upstream.json();
      clientRes.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      clientRes.end(JSON.stringify(chatCompletionToResponse({
        completion,
        model: requestedModel,
        toolKinds: chatRequest.toolKinds,
      })));
    }
    return;
  }

  if (route?.provider?.type === "anthropic") {
    let upstream = await fetchConfiguredAnthropic(
      route.provider,
      upstreamBody,
      clientReq,
    );
    upstream = await maybeRetryAfterImageError({
      upstream,
      originalBody: body,
      route,
      clientReq,
      context,
      fetchAgain: (retryBody) => fetchConfiguredAnthropic(
        route.provider,
        openAIResponsesToAnthropic(retryBody, resolvedModel),
        clientReq,
      ),
    });
    logInfo("openai_responses_response", {
      request_id: context.requestId,
      client: context.client,
      status: upstream.status,
      provider: route.provider.id || null,
      translated_to: "anthropic_messages",
    });

    if (body.stream) {
      await streamAnthropicAsOpenAIResponse(
        upstream,
        clientRes,
        requestedModel,
        context.requestId,
        responseToolKinds,
      );
    } else {
      if (!upstream.ok) {
        await sendUpstreamError(upstream, clientRes);
        return;
      }
      const payload = anthropicToOpenAIResponse(
        await upstream.json(),
        requestedModel,
        responseToolKinds,
      );
      clientRes.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      clientRes.end(JSON.stringify(payload));
    }
    return;
  }

  let upstream = route?.provider
    ? await fetchConfiguredOpenAI(
        route.provider,
        "/responses",
        upstreamBody,
        clientReq,
        signal,
        context.client !== "codex",
    )
    : await fetchArkOpenAI("/responses", upstreamBody, clientReq, signal);
  if (route?.provider) {
    upstream = await maybeRetryAfterImageError({
      upstream,
      originalBody: body,
      route,
      clientReq,
      context,
      fetchAgain: (retryBody) => fetchConfiguredOpenAI(
        route.provider,
        "/responses",
        { ...retryBody, model: resolvedModel },
        clientReq,
        signal,
        context.client !== "codex",
      ),
    });
  }
  logInfo("openai_responses_response", {
    request_id: context.requestId,
    client: context.client,
    status: upstream.status,
    provider: route?.provider?.id || null,
    translated_to: null,
  });

  if (body.stream) {
    await pipeResponsesUpstream(upstream, clientRes, {
      requestId: context.requestId,
      model: requestedModel,
      logName: "openai_responses_stream_complete",
    });
    return;
  }

  // Non-streaming Responses stay byte-for-byte JSON/SSE passthrough without
  // synthesizing terminal events into the body.
  if (!upstream.body) {
    clientRes.writeHead(upstream.status, responseHeaders(upstream.headers));
    clientRes.end(await upstream.text());
    return;
  }
  clientRes.writeHead(upstream.status, responseHeaders(upstream.headers));
  await upstream.body.pipeTo(
    new WritableStream({
      write(chunk) {
        clientRes.write(Buffer.from(chunk));
      },
      close() {
        clientRes.end();
      },
      abort(error) {
        console.error(error);
        clientRes.end();
      },
    }),
  );
}

async function proxyOfficialCodexImages(kind, clientReq, clientRes, context, signal) {
  const auth = getOfficialCodexImageAuth(clientReq, kind);
  if (!auth) {
    throw httpError(
      401,
      "Official Codex auth not found. Sign in to Codex locally or set OPENAI_API_KEY for official model routing.",
    );
  }

  const proxyUrl = officialCodexProxyUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const requestSignal = signal || controller.signal;
  const body = await readRequestBuffer(clientReq);
  const contentType =
    firstHeaderValue(clientReq.headers["content-type"]) || "application/json";
  const headers = officialUpstreamHeaders(clientReq, auth);
  headers["Content-Type"] = contentType;
  headers.Accept = firstHeaderValue(clientReq.headers.accept) || "application/json";

  try {
    const upstream = await fetchWithOptionalProxy(auth.url, {
      method: "POST",
      headers,
      body,
      signal: requestSignal,
      proxyUrl,
    });

    logInfo("openai_images_response", {
      request_id: context.requestId,
      client: context.client,
      status: upstream.status,
      route: "official",
      backend: auth.backend,
      kind,
      proxy: proxyUrl || null,
      url: auth.url,
      originator: firstHeaderValue(clientReq.headers["originator"]) || null,
    });

    const text = await upstream.text();
    clientRes.writeHead(upstream.status, responseHeaders(upstream.headers));
    clientRes.end(text);
  } catch (error) {
    const cause = error?.cause?.code || error?.code || error?.cause?.message || "";
    const detail = [error?.message || error, cause].filter(Boolean).join(": ");
    const message = error?.name === "AbortError"
      ? "Timed out calling official Codex image backend"
      : `Failed to call official Codex image backend: ${detail}${proxyUrl ? ` (proxy ${proxyUrl})` : ""}`;
    logInfo("openai_images_upstream_fetch_failed", {
      request_id: context.requestId,
      backend: auth.backend,
      kind,
      url: auth.url,
      proxy: proxyUrl || null,
      error: String(error?.message || error),
      cause: cause || null,
    });
    throw httpError(502, message);
  } finally {
    clearTimeout(timeout);
  }
}

async function readRequestBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return decodeRequestBody(Buffer.concat(chunks), req.headers["content-encoding"]);
}

async function proxyOfficialCodexResponse(body, clientReq, clientRes, context, signal) {
  const auth = getOfficialCodexAuth(clientReq);
  if (!auth) {
    throw httpError(
      401,
      "Official Codex auth not found. Sign in to Codex locally or set OPENAI_API_KEY for official model routing.",
    );
  }

  // Desktop custom providers often omit hosted tools. Inject web_search on the
  // official path, but never pair hosted image_generation with Desktop's
  // function image_gen.imagegen (backend rejects that combination).
  const withTools = maybeInjectOfficialHostedTools(body, clientReq);
  const outboundBody = withTools.body;
  const proxyUrl = officialCodexProxyUrl();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const requestSignal = signal || controller.signal;

  try {
    const upstream = await fetchWithOptionalProxy(auth.url, {
      method: "POST",
      headers: officialUpstreamHeaders(clientReq, auth),
      body: JSON.stringify(normalizeOfficialCodexBody(outboundBody, auth.backend)),
      signal: requestSignal,
      proxyUrl,
    });

    const toolTypes = Array.isArray(outboundBody?.tools)
      ? outboundBody.tools.map((tool) => tool?.type || tool?.name || "unknown").slice(0, 20)
      : [];
    logInfo("openai_responses_response", {
      request_id: context.requestId,
      client: context.client,
      status: upstream.status,
      route: "official",
      backend: auth.backend,
      proxy: proxyUrl || null,
      tool_count: toolTypes.length,
      tool_types: toolTypes,
      has_web_search_tool: toolTypes.some((type) => /web_search/i.test(String(type))),
      has_image_generation_tool: toolTypes.some((type) => /image_generation/i.test(String(type))),
      injected_web_search: withTools.injected,
      injected_hosted_tools: withTools.injected_types || [],
      stripped_hosted_tools: withTools.stripped_types || [],
      originator: firstHeaderValue(clientReq.headers["originator"]) || null,
    });

    if (body.stream) {
      await pipeResponsesUpstream(upstream, clientRes, {
        requestId: context.requestId,
        model: body.model || null,
        logName: "openai_responses_stream_complete",
      });
    } else if (!upstream.body) {
      clientRes.writeHead(upstream.status, responseHeaders(upstream.headers));
      clientRes.end(await upstream.text());
    } else {
      clientRes.writeHead(upstream.status, responseHeaders(upstream.headers));
      await upstream.body.pipeTo(
        new WritableStream({
          write(chunk) {
            clientRes.write(Buffer.from(chunk));
          },
          close() {
            clientRes.end();
          },
          abort(error) {
            console.error(error);
            clientRes.end();
          },
        }),
      );
    }
  } catch (error) {
    const cause = error?.cause?.code || error?.code || error?.cause?.message || "";
    const detail = [error?.message || error, cause].filter(Boolean).join(": ");
    const message = error?.name === "AbortError"
      ? "Timed out calling official Codex backend"
      : `Failed to call official Codex backend: ${detail}${proxyUrl ? ` (proxy ${proxyUrl})` : ""}`;
    logInfo("openai_responses_upstream_fetch_failed", {
      request_id: context.requestId,
      backend: auth.backend,
      url: auth.url,
      proxy: proxyUrl || null,
      error: String(error?.message || error),
      cause: cause || null,
    });
    throw httpError(502, message);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchArkAnthropic(body, clientReq) {
  const upstreamApiKey = getUpstreamApiKey(clientReq);
  if (!upstreamApiKey) {
    throw httpError(401, missingApiKeyMessage("ARK_API_KEY", clientReq));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    try {
      return await fetch(ARK_MESSAGES_URL, {
        method: "POST",
        headers: upstreamHeaders(clientReq, upstreamApiKey),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error?.name === "AbortError" ? "Timed out calling Ark" : `Failed to call Ark: ${error.message || error}`;
      throw httpError(502, message);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOfficialAnthropic(body, clientReq) {
  const auth = getOfficialAnthropicAuth(clientReq);
  if (!auth) {
    throw httpError(
      401,
      "Official Anthropic auth is not available. Use Claude Code OAuth pass-through, set ANTHROPIC_API_KEY, or choose a mapped Volcengine model.",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    try {
      return await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: officialAnthropicHeaders(clientReq, auth),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "Timed out calling official Anthropic"
          : `Failed to call official Anthropic: ${error.message || error}`;
      throw httpError(502, message);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function resolveUrl(baseUrl, defaultPath) {
  const trimmed = baseUrl.replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    if (trimmed.endsWith(defaultPath)) {
      return trimmed;
    }
    return `${trimmed}${defaultPath}`;
  }

  if (defaultPath === "/v1/messages") {
    if (trimmed.endsWith("/v1/messages") || trimmed.endsWith("/messages")) {
      return trimmed;
    }
    if (trimmed.endsWith("/v1")) {
      return `${trimmed}/messages`;
    }
    return `${trimmed}/v1/messages`;
  }

  if (defaultPath === "/v1/chat/completions") {
    if (trimmed.endsWith("/v1/chat/completions") || trimmed.endsWith("/chat/completions")) {
      return trimmed;
    }
    if (trimmed.endsWith("/v1")) {
      return `${trimmed}/chat/completions`;
    }
    return `${trimmed}/v1/chat/completions`;
  }

  const cleanPath = defaultPath.startsWith("/") ? defaultPath : `/${defaultPath}`;
  if (trimmed.endsWith(cleanPath)) {
    return trimmed;
  }
  return `${trimmed}${cleanPath}`;
}

async function fetchConfiguredAnthropic(provider, body, clientReq) {
  if (!provider?.base_url) {
    throw httpError(500, `Provider ${provider?.id || "unknown"} is missing base_url`);
  }

  const upstreamApiKey = providerApiKey(provider, clientReq);
  if (!upstreamApiKey) {
    throw httpError(
      401,
      missingProviderApiKeyMessage(provider, clientReq),
    );
  }

  const url = resolveUrl(provider.base_url, "/v1/messages");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    try {
      let res = await fetch(url, {
        method: "POST",
        headers: providerHeaders(provider, upstreamApiKey, {
          "anthropic-version": clientReq.headers["anthropic-version"] || "2023-06-01",
          ...(clientReq.headers["anthropic-beta"]
            ? { "anthropic-beta": clientReq.headers["anthropic-beta"] }
            : {}),
        }),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === 401 || res.status === 403) {
        const fallbackKey = getConfiguredProviderApiKey(provider);
        if (fallbackKey && fallbackKey !== upstreamApiKey) {
          logInfo("api_key_fallback", { provider: provider.id, original_status: res.status });
          res = await fetch(url, {
            method: "POST",
            headers: providerHeaders(provider, fallbackKey, {
              "anthropic-version": clientReq.headers["anthropic-version"] || "2023-06-01",
              ...(clientReq.headers["anthropic-beta"]
                ? { "anthropic-beta": clientReq.headers["anthropic-beta"] }
                : {}),
            }),
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        }
      }

      return res;
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? `Timed out calling provider ${provider.id}`
          : `Failed to call provider ${provider.id}: ${error.message || error}`;
      throw httpError(502, message);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchArkOpenAI(path, body, clientReq, signal) {
  const upstreamApiKey = getUpstreamApiKey(clientReq);
  if (!upstreamApiKey) {
    throw httpError(401, missingApiKeyMessage("ARK_API_KEY", clientReq));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    try {
      return await fetch(`${ARK_CODEX_BASE_URL}${path}`, {
        method: "POST",
        headers: openAIUpstreamHeaders(upstreamApiKey),
        body: JSON.stringify(body),
        signal: signal || controller.signal,
      });
    } catch (error) {
      const message = error?.name === "AbortError" ? "Timed out calling Ark" : `Failed to call Ark: ${error.message || error}`;
      throw httpError(502, message);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchConfiguredOpenAI(
  provider,
  endpointPath,
  body,
  clientReq,
  signal,
  allowAuthFallback = true,
) {
  if (!provider?.base_url) {
    throw httpError(500, `Provider ${provider?.id || "unknown"} is missing base_url`);
  }

  const upstreamApiKey = providerApiKey(provider, clientReq);
  if (!upstreamApiKey) {
    throw httpError(
      401,
      missingProviderApiKeyMessage(provider, clientReq),
    );
  }

  const url = resolveUrl(provider.base_url, endpointPath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    try {
      let res = await fetch(url, {
        method: "POST",
        headers: providerHeaders(provider, upstreamApiKey),
        body: JSON.stringify(body),
        signal: signal || controller.signal,
      });

      if (allowAuthFallback && (res.status === 401 || res.status === 403)) {
        const fallbackKey = getConfiguredProviderApiKey(provider);
        if (fallbackKey && fallbackKey !== upstreamApiKey) {
          logInfo("api_key_fallback", { provider: provider.id, original_status: res.status });
          res = await fetch(url, {
            method: "POST",
            headers: providerHeaders(provider, fallbackKey),
            body: JSON.stringify(body),
            signal: signal || controller.signal,
          });
        }
      }

      return res;
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? `Timed out calling provider ${provider.id}`
          : `Failed to call provider ${provider.id}: ${error.message || error}`;
      throw httpError(502, message);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function createUpstreamAbort(parentSignal) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

// --- Grok CLI subscription provider: credential / header / proxy / fetch ---

function loadGrokModelCatalog() {
  const catalog = new Map();
  try {
    const raw = fs.readFileSync(GROK_MODELS_CACHE_PATH, "utf8");
    const data = JSON.parse(raw);
    for (const [id, entry] of Object.entries(data?.models || {})) {
      const info = entry?.info || {};
      const backend =
        info.api_backend === "chat_completions"
          ? "chat"
          : info.api_backend === "responses"
            ? "responses"
            : GROK_FALLBACK_BACKENDS[id] || "responses";
      catalog.set(id, {
        api_backend: backend,
        reasoning_effort: info.reasoning_effort || null,
        context_window: info.context_window || null,
        display_name: info.name || id,
      });
    }
  } catch {
    // models_cache.json missing/unreadable - fall back to hardcoded set below.
  }
  for (const [id, backend] of Object.entries(GROK_FALLBACK_BACKENDS)) {
    if (!catalog.has(id)) {
      catalog.set(id, { api_backend: backend, reasoning_effort: null, context_window: null, display_name: id });
    }
  }
  return catalog;
}

function grokBackendFor(model) {
  const entry = GROK_MODEL_CATALOG.get(model);
  if (entry) return entry.api_backend;
  return "responses";
}

function grokClientVersion() {
  if (_grokClientVersionCache !== undefined) return _grokClientVersionCache;
  try {
    _grokClientVersionCache = JSON.parse(fs.readFileSync(GROK_VERSION_PATH, "utf8")).version || "0.2.101";
  } catch {
    _grokClientVersionCache = "0.2.101";
  }
  return _grokClientVersionCache;
}

function grokAgentId(agentIdPath = GROK_AGENT_ID_PATH) {
  const resolvedPath = resolveHomePath(agentIdPath) || GROK_AGENT_ID_PATH;
  if (_grokAgentIdCache.has(resolvedPath)) return _grokAgentIdCache.get(resolvedPath);
  try {
    const id = fs.readFileSync(resolvedPath, "utf8").trim();
    if (id) {
      _grokAgentIdCache.set(resolvedPath, id);
      return id;
    }
  } catch {
    // Generate a stable id below.
  }
  const id = randomUUID();
  try {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, `${id}\n`, { mode: 0o600 });
  } catch {
    // Keep the id stable for this process even if the file cannot be written.
  }
  _grokAgentIdCache.set(resolvedPath, id);
  return id;
}

function grokPlatformOs() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

function grokPlatformArch() {
  if (process.arch === "x64") return "x86_64";
  if (process.arch === "arm64") return "arm64";
  return process.arch;
}

function resolveHomePath(p) {
  if (!p) return null;
  if (p === "~/.grok/auth.json") return GROK_AUTH_PATH;
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Read the session JWT from ~/.grok/auth.json fresh on every call so the
// gateway picks up tokens the grok CLI refreshes in the background. Throws
// a clear 401 when missing/expired so callers can surface it to the client.
function readGrokToken(authPath = GROK_AUTH_PATH) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch (e) {
    throw httpError(401, `Grok auth not readable at ${authPath}. Run \`grok login\` first. (${e.message})`);
  }
  const scopes = Object.keys(data || {});
  if (scopes.length === 0) throw httpError(401, "Grok auth.json has no credentials. Run `grok login`.");
  const scope = scopes.find((s) => s.startsWith("https://auth.x.ai")) || scopes[0];
  const entry = data[scope] || {};
  if (!entry.key) throw httpError(401, "Grok auth.json entry has no session key. Run `grok login`.");
  const expiresAt = entry.expires_at ? Date.parse(entry.expires_at) : NaN;
  if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
    throw httpError(401, "Grok session token expired. Run `grok` (or `grok login`) to refresh, then retry.");
  }
  return { key: entry.key, user_id: entry.user_id || "", expires_at: entry.expires_at || "" };
}

// Lighter check used by hasConfiguredApiKey so an expired token still routes
// to fetchGrok (which emits the clear expiry error) rather than vanishing.
function grokHasCredentials(ep) {
  try {
    const authPath = resolveHomePath(ep?.auth_path) || GROK_AUTH_PATH;
    const data = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const scopes = Object.keys(data || {});
    if (!scopes.length) return false;
    const scope = scopes.find((s) => s.startsWith("https://auth.x.ai")) || scopes[0];
    return Boolean(data[scope]?.key);
  } catch {
    return false;
  }
}

function grokHeaders(provider, model, authInfo) {
  const version = provider?.client_version || grokClientVersion();
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authInfo.key}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-model-override": model,
    "x-grok-conv-id": randomUUID(),
    "x-grok-req-id": randomUUID(),
    "x-grok-session-id": randomUUID(),
    "x-grok-agent-id": grokAgentId(provider?.agent_id_path),
    "x-grok-client-version": version,
    "x-grok-client-identifier": "grok-cli",
    "x-grok-user-id": authInfo.user_id || "",
    "User-Agent": `grok-cli/${version} (${grokPlatformOs()}; ${grokPlatformArch()})`,
    "accept": "text/event-stream",
  };
}

function grokProxyAgentFor(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (!_grokProxyAgents.has(proxyUrl)) {
    _grokProxyAgents.set(proxyUrl, new HttpsProxyAgent(proxyUrl));
  }
  return _grokProxyAgents.get(proxyUrl);
}

// Official chatgpt.com / api.openai.com are blocked without the local Clash
// proxy. Node's env-proxy fetch is unreliable when HTTPS_PROXY is set after
// process start (and sometimes even with --use-env-proxy). Reuse the same
// HttpsProxyAgent path that already works for Grok.
function officialCodexProxyUrl() {
  if (isTruthy(process.env.OFFICIAL_CODEX_PROXY_DISABLED)) return "";
  return (
    process.env.OFFICIAL_CODEX_PROXY
    || process.env.GROK_PROXY
    || process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || process.env.ALL_PROXY
    || process.env.https_proxy
    || process.env.http_proxy
    || process.env.all_proxy
    || "http://127.0.0.1:7897"
  );
}

async function fetchWithOptionalProxy(url, {
  method = "GET",
  headers = {},
  body = null,
  signal = null,
  proxyUrl = officialCodexProxyUrl(),
} = {}) {
  // Prefer the explicit agent path whenever a proxy is configured. Falling back
  // to global fetch only when proxy is intentionally disabled/empty.
  if (!proxyUrl) {
    return fetch(url, { method, headers, body, signal });
  }

  const agent = grokProxyAgentFor(proxyUrl);
  const transport = new URL(url).protocol === "http:" ? http : https;
  const headerBag = { ...headers };
  if (body != null && headerBag["Content-Length"] == null && headerBag["content-length"] == null) {
    const payload = typeof body === "string" || Buffer.isBuffer(body)
      ? body
      : String(body);
    headerBag["Content-Length"] = Buffer.byteLength(payload);
  }

  return await new Promise((resolve, reject) => {
    const req = transport.request(url, { method, headers: headerBag, agent }, (res) => {
      resolve(nodeResToFetchLike(res));
    });

    const onAbort = () => {
      const error = new Error("client aborted");
      error.name = "AbortError";
      req.destroy(error);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      req.once("close", () => signal.removeEventListener("abort", onAbort));
    }

    req.on("error", (error) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    req.once("response", () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    });

    if (body != null) {
      req.write(typeof body === "string" || Buffer.isBuffer(body) ? body : String(body));
    }
    req.end();
  });
}

// Per-provider concurrency guard so many client tabs cannot fan out parallel
// requests that trip the subscription's rate/risk control.
function grokAcquire(provider, signal) {
  if (signal?.aborted) {
    const error = new Error("client aborted");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  const id = provider?.id || provider?.name || "grok";
  const configuredLimit = Number(provider?.max_concurrency);
  if (!Number.isFinite(configuredLimit) || configuredLimit <= 0) {
    return Promise.resolve();
  }
  const limit = Math.max(1, Math.floor(configuredLimit));
  let slot = _grokSemaphores.get(id);
  if (!slot) {
    slot = { running: 0, queue: [] };
    _grokSemaphores.set(id, slot);
  }
  return new Promise((resolve, reject) => {
    let queued = false;
    const abort = () => {
      if (queued) {
        const index = slot.queue.indexOf(run);
        if (index !== -1) slot.queue.splice(index, 1);
      }
      const error = new Error("client aborted");
      error.name = "AbortError";
      reject(error);
    };
    const run = () => {
      if (signal?.aborted) {
        abort();
        return;
      }
      queued = false;
      signal?.removeEventListener("abort", abort);
      slot.running += 1;
      resolve();
    };
    if (signal?.aborted) {
      abort();
    } else if (slot.running < limit) {
      run();
    } else {
      queued = true;
      slot.queue.push(run);
      signal?.addEventListener("abort", abort, { once: true });
    }
  });
}

function grokRelease(provider) {
  const id = provider?.id || provider?.name || "grok";
  const slot = _grokSemaphores.get(id);
  if (!slot) return;
  slot.running = Math.max(0, slot.running - 1);
  const next = slot.queue.shift();
  if (next) next();
}

// Adapt a node https.IncomingMessage into the fetch-like shape the existing
// stream translators expect ({ ok, status, headers.get, body, text, json }).
function nodeResToFetchLike(res) {
  let webBody = null;
  let bufferedPromise = null;
  return {
    status: res.statusCode,
    ok: res.statusCode >= 200 && res.statusCode < 300,
    headers: {
      get(name) {
        return res.headers[String(name).toLowerCase()] || null;
      },
    },
    get body() {
      if (!webBody) webBody = Readable.toWeb(res);
      return webBody;
    },
    async text() {
      if (bufferedPromise) return (await bufferedPromise).toString("utf8");
      if (webBody) throw new Error("grok response body already streamed");
      bufferedPromise = new Promise((resolve, reject) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      });
      return (await bufferedPromise).toString("utf8");
    },
    async json() {
      return JSON.parse(await this.text());
    },
  };
}

async function fetchGrok(provider, endpointPath, body, signal) {
  const authPath = resolveHomePath(provider?.auth_path) || GROK_AUTH_PATH;
  const authInfo = readGrokToken(authPath);
  const baseUrl = trimRight(provider?.base_url || GROK_DEFAULT_BASE_URL, "/");
  const model = body?.model || "";
  const headers = grokHeaders(provider, model, authInfo);
  // The proxy only reliably supports streaming for most models, so force it
  // upstream and aggregate back into a single JSON when the client asked for
  // non-streaming.
  const upstreamBody = { ...body, stream: true };
  if (endpointPath === "/chat/completions") {
    upstreamBody.stream_options = { ...(body?.stream_options || {}), include_usage: true };
  }
  const url = `${baseUrl}${endpointPath}`;
  const transport = new URL(url).protocol === "http:" ? http : https;
  const proxyUrl = provider?.proxy === "" ? "" : provider?.proxy ?? GROK_DEFAULT_PROXY;
  const agent = grokProxyAgentFor(proxyUrl);
  await grokAcquire(provider, signal);
  let timedOut = false;
  let reqRef = null;
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    grokRelease(provider);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    if (reqRef) reqRef.destroy(new Error("grok request timed out"));
  }, REQUEST_TIMEOUT_MS);
  try {
    const res = await new Promise((resolve, reject) => {
      reqRef = transport.request(url, { method: "POST", headers, agent }, resolve);
      const abortGrok = () => reqRef?.destroy(new Error("client aborted"));
      const removeAbortListener = () => {
        signal?.removeEventListener("abort", abortGrok);
      };
      signal?.addEventListener("abort", abortGrok, { once: true });
      reqRef.on("error", reject);
      reqRef.once("error", removeAbortListener);
      reqRef.once("response", (response) => {
        response.once("close", removeAbortListener);
      });
      if (signal?.aborted) {
        abortGrok();
        return;
      }
      reqRef.write(JSON.stringify(upstreamBody));
      reqRef.end();
    });
    res.once("end", finish);
    res.once("close", finish);
    res.once("error", finish);
    return nodeResToFetchLike(res);
  } catch (error) {
    finish();
    const message = timedOut
      ? "Timed out calling Grok proxy"
      : `Failed to call Grok proxy: ${error?.message || error}`;
    throw httpError(502, message);
  }
}

// Aggregate an OpenAI Responses SSE stream (always streamed by the grok
// proxy) into a single chat.completion JSON for non-streaming clients.
async function collectResponsesSseAsChatCompletion(upstream, requestedModel) {
  let text = "";
  let incomplete = false;
  let usage = null;
  let respId = "";
  await consumeSse(upstream.body, (eventName, payloadText) => {
    const payload = parseJsonMaybe(payloadText) || {};
    if (eventName === "response.created" || payload.type === "response.created") {
      respId = payload.response?.id || respId;
    } else if (eventName === "response.output_text.delta" || payload.type === "response.output_text.delta") {
      if (payload.delta) text += payload.delta;
    } else if (eventName === "response.completed" || payload.type === "response.completed") {
      if (payload.response?.status === "incomplete") incomplete = true;
      usage = payload.response?.usage || usage;
    }
  });
  const inputTokens = usage?.input_tokens || 0;
  const outputTokens = usage?.output_tokens || 0;
  return {
    id: respId || `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || "grok",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: incomplete ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

// Aggregate an OpenAI chat-completions SSE stream into a single
// chat.completion JSON for non-streaming clients.
async function collectChatSseAsChatCompletion(upstream, requestedModel) {
  let text = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage = null;
  let id = "";
  let created = Math.floor(Date.now() / 1000);
  // Grok always forces stream:true on chat/completions and aggregates here.
  // Mirror grok-build's chat_completions accumulator: keep tool_calls by index
  // and preserve reasoning_content / reasoning / analysis aliases.
  const toolCalls = new Map();

  await consumeSse(upstream.body, (_eventName, payloadText) => {
    if (payloadText === "[DONE]") return;
    const payload = parseJsonMaybe(payloadText) || {};
    if (payload.id) id = payload.id;
    if (payload.created) created = payload.created;
    const choice = payload.choices?.[0] || {};
    const delta = choice.delta || {};
    const deltaText =
      typeof delta.content === "string" ? delta.content : openAIContentToText(delta.content);
    if (deltaText) text += deltaText;

    const reasoningDelta = firstNonEmptyString(
      delta.reasoning_content,
      delta.reasoning,
      delta.analysis,
    );
    if (reasoningDelta) reasoning += reasoningDelta;

    for (const toolDelta of delta.tool_calls || []) {
      const index = Number.isInteger(toolDelta?.index) ? toolDelta.index : toolCalls.size;
      if (!toolCalls.has(index)) {
        toolCalls.set(index, {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        });
      }
      const state = toolCalls.get(index);
      if (toolDelta.id) state.id = toolDelta.id;
      if (toolDelta.type) state.type = toolDelta.type;
      if (toolDelta.function?.name) state.function.name += toolDelta.function.name;
      if (toolDelta.function?.arguments) {
        state.function.arguments += toolDelta.function.arguments;
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (payload.usage) usage = payload.usage;
  });

  const message = {
    role: "assistant",
    content: text || null,
  };
  if (reasoning) message.reasoning_content = reasoning;

  const assembledToolCalls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call], index) => ({
      id: call.id || `call_${index}`,
      type: call.type || "function",
      function: {
        name: call.function.name || "tool",
        arguments: call.function.arguments || "{}",
      },
    }));
  if (assembledToolCalls.length) {
    message.tool_calls = assembledToolCalls;
    if (!finishReason || finishReason === "stop") finishReason = "tool_calls";
  }

  return {
    id: id || `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created,
    model: requestedModel || "grok",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: usage?.prompt_tokens || 0,
      completion_tokens: usage?.completion_tokens || 0,
      total_tokens: usage?.total_tokens || (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0),
    },
  };
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

// Translate an OpenAI Responses SSE stream into Anthropic Messages SSE, for
// Anthropic-protocol clients hitting a grok model on the responses backend.
async function streamOpenAIResponseAsAnthropicMessages(upstream, clientRes, requestedModel, requestId) {
  if (!upstream.ok) {
    const text = await upstream.text();
    clientRes.writeHead(upstream.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    clientRes.end(text);
    return;
  }

  clientRes.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const messageId = `msg_${Date.now()}`;
  let nextBlockIndex = 0;
  let textBlockIndex = null;
  let sawToolUse = false;
  let usage = null;
  const toolBlocks = new Map();

  writeAnthropicSse(clientRes, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: requestedModel || "grok",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const ensureTextBlock = () => {
    if (textBlockIndex != null) return textBlockIndex;
    textBlockIndex = nextBlockIndex++;
    writeAnthropicSse(clientRes, "content_block_start", {
      type: "content_block_start",
      index: textBlockIndex,
      content_block: { type: "text", text: "" },
    });
    return textBlockIndex;
  };

  const startToolBlock = (outputIndex, item = {}) => {
    if (toolBlocks.has(outputIndex)) return toolBlocks.get(outputIndex);
    const tool = {
      index: nextBlockIndex++,
      id: item.call_id || item.id || randomUUID(),
      name: item.name || "tool",
      arguments: "",
      closed: false,
    };
    toolBlocks.set(outputIndex, tool);
    sawToolUse = true;
    writeAnthropicSse(clientRes, "content_block_start", {
      type: "content_block_start",
      index: tool.index,
      content_block: {
        type: "tool_use",
        id: tool.id,
        name: tool.name,
        input: {},
      },
    });
    return tool;
  };

  const appendToolArguments = (tool, delta) => {
    if (!delta) return;
    tool.arguments += delta;
    writeAnthropicSse(clientRes, "content_block_delta", {
      type: "content_block_delta",
      index: tool.index,
      delta: { type: "input_json_delta", partial_json: delta },
    });
  };

  const closeToolBlock = (tool) => {
    if (tool.closed) return;
    tool.closed = true;
    writeAnthropicSse(clientRes, "content_block_stop", {
      type: "content_block_stop",
      index: tool.index,
    });
  };

  await consumeSse(upstream.body, (eventName, payloadText) => {
    const payload = parseJsonMaybe(payloadText) || {};
    if (eventName === "response.output_text.delta" || payload.type === "response.output_text.delta") {
      const delta = payload.delta || "";
      if (delta) {
        const index = ensureTextBlock();
        writeAnthropicSse(clientRes, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: delta },
        });
      }
    } else if (eventName === "response.output_item.added" || payload.type === "response.output_item.added") {
      if (payload.item?.type === "function_call") {
        startToolBlock(payload.output_index ?? 0, payload.item);
      }
    } else if (
      eventName === "response.function_call_arguments.delta"
      || payload.type === "response.function_call_arguments.delta"
    ) {
      const tool = startToolBlock(payload.output_index ?? 0, {
        id: payload.item_id,
      });
      appendToolArguments(tool, payload.delta || "");
    } else if (eventName === "response.output_item.done" || payload.type === "response.output_item.done") {
      if (payload.item?.type === "function_call") {
        const tool = startToolBlock(payload.output_index ?? 0, payload.item);
        if (!tool.arguments && payload.item.arguments) {
          appendToolArguments(tool, payload.item.arguments);
        }
        closeToolBlock(tool);
      }
    } else if (eventName === "response.completed" || payload.type === "response.completed") {
      usage = payload.response?.usage || usage;
    }
  });

  if (textBlockIndex == null && toolBlocks.size === 0) ensureTextBlock();
  if (textBlockIndex != null) {
    writeAnthropicSse(clientRes, "content_block_stop", {
      type: "content_block_stop",
      index: textBlockIndex,
    });
  }
  for (const tool of toolBlocks.values()) closeToolBlock(tool);
  writeAnthropicSse(clientRes, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: sawToolUse ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: usage?.output_tokens || 0 },
  });
  writeAnthropicSse(clientRes, "message_stop", { type: "message_stop" });
  clientRes.end();
  logInfo("grok_responses_as_anthropic_stream_complete", { request_id: requestId });
}

// If the grok upstream returned an error, surface its body and signal that
// the caller should stop. Used before non-streaming aggregation.
async function grokSendErrorIfNotOk(upstream, clientRes) {
  if (upstream.ok) return false;
  const text = await upstream.text();
  clientRes.writeHead(upstream.status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  clientRes.end(text);
  return true;
}

// Raw SSE passthrough for the chat-completions backend when the client speaks
// the same OpenAI chat protocol (streaming).
async function pipeGrokSse(upstream, clientRes, requestId) {
  if (!upstream.ok) {
    const text = await upstream.text();
    clientRes.writeHead(upstream.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    clientRes.end(text);
    logInfo("grok_upstream_error", { request_id: requestId, status: upstream.status });
    return;
  }
  clientRes.writeHead(upstream.status, responseHeaders(upstream.headers));
  if (!upstream.body) {
    clientRes.end(await upstream.text());
    return;
  }
  await upstream.body.pipeTo(
    new WritableStream({
      write(chunk) {
        clientRes.write(Buffer.from(chunk));
      },
      close() {
        clientRes.end();
      },
      abort() {
        clientRes.end();
      },
    }),
  );
  logInfo("grok_passthrough_stream_complete", { request_id: requestId });
}

// Responses SSE passthrough that synthesizes response.failed when the upstream
// closes after headers without a terminal event.
async function pipeResponsesUpstream(upstream, clientRes, {
  requestId = null,
  model = null,
  logName = "responses_passthrough_stream_complete",
} = {}) {
  if (!upstream.ok) {
    const text = await upstream.text();
    clientRes.writeHead(upstream.status, responseHeaders(upstream.headers));
    clientRes.end(text);
    if (requestId) {
      logInfo("responses_upstream_error", {
        request_id: requestId,
        status: upstream.status,
      });
    }
    return;
  }

  if (!upstream.body) {
    clientRes.writeHead(upstream.status, responseHeaders(upstream.headers));
    clientRes.end(await upstream.text());
    return;
  }

  clientRes.writeHead(upstream.status, responseHeaders(upstream.headers));
  const result = await pipeResponsesSsePassthrough({
    readable: upstream.body,
    write(chunk) {
      if (!clientRes.writableEnded) clientRes.write(chunk);
    },
    end() {
      if (!clientRes.writableEnded) clientRes.end();
    },
    model,
  });
  if (requestId) {
    logInfo(logName, {
      request_id: requestId,
      terminal: result.sawTerminal ? "upstream" : "synthesized_failed",
    });
  }
}

function upstreamHeaders(clientReq, upstreamApiKey) {
  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": clientReq.headers["anthropic-version"] || "2023-06-01",
  };

  if (clientReq.headers["anthropic-beta"]) {
    headers["anthropic-beta"] = clientReq.headers["anthropic-beta"];
  }

  if (ARK_AUTH_SCHEME === "x-api-key") {
    headers["x-api-key"] = upstreamApiKey;
  } else {
    headers.Authorization = `Bearer ${upstreamApiKey}`;
  }

  return headers;
}

function openAIUpstreamHeaders(upstreamApiKey) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (ARK_AUTH_SCHEME === "x-api-key") {
    headers["x-api-key"] = upstreamApiKey;
  } else {
    headers.Authorization = `Bearer ${upstreamApiKey}`;
  }

  return headers;
}

function getOfficialAnthropicAuth(req) {
  if (process.env.OFFICIAL_ANTHROPIC_API_KEY) {
    return { scheme: "x-api-key", value: process.env.OFFICIAL_ANTHROPIC_API_KEY };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return { scheme: "x-api-key", value: process.env.ANTHROPIC_API_KEY };
  }

  const apiKey = req.headers["x-api-key"];
  if (apiKey) return { scheme: "x-api-key", value: apiKey };

  const auth = req.headers.authorization || "";
  if (auth) return { scheme: "authorization", value: auth };

  return null;
}

function getConfiguredProviderApiKey(provider) {
  if (!provider) return "";
  if (provider.id && GATEWAY_SECRETS?.api_keys?.[provider.id]) {
    return getEndpointApiKey(provider, GATEWAY_SECRETS);
  }
  if (provider.api_key) {
    if (provider.api_key.startsWith("env:")) {
      const envName = provider.api_key.slice(4);
      if (process.env[envName]) return process.env[envName];
    } else {
      return provider.api_key;
    }
  }
  if (provider.api_key_env && process.env[provider.api_key_env]) return process.env[provider.api_key_env];
  return "";
}

function providerApiKey(provider, req) {
  const passedKey = requestApiKey(req);

  const configuredKey = getConfiguredProviderApiKey(provider);
  if (configuredKey) {
    return configuredKey;
  }

  if (isConfiguredApiKeySentinel(passedKey)) {
    return "";
  }

  const isGatewayAuthKey = process.env.GATEWAY_API_KEY && passedKey === process.env.GATEWAY_API_KEY;

  if (passedKey && !isGatewayAuthKey) {
    return passedKey;
  }

  return "";
}

function providerHeaders(provider, apiKey, baseHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...baseHeaders,
    ...(provider?.headers || {}),
  };

  if (!apiKey) return headers;

  if (provider.auth === "x-api-key") {
    headers["x-api-key"] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function officialAnthropicHeaders(clientReq, auth) {
  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": clientReq.headers["anthropic-version"] || "2023-06-01",
  };

  if (clientReq.headers["anthropic-beta"]) {
    headers["anthropic-beta"] = clientReq.headers["anthropic-beta"];
  }

  if (auth.scheme === "authorization") {
    headers.Authorization = auth.value;
  } else {
    headers["x-api-key"] = auth.value;
  }

  return headers;
}

function getUpstreamApiKey(req) {
  if (ARK_API_KEY) return ARK_API_KEY;
  const passedKey = requestApiKey(req);
  return isConfiguredApiKeySentinel(passedKey) ? "" : passedKey;
}

function missingApiKeyMessage(envName, req) {
  const client = getRequestContext(req).client;
  if (client === "codex") {
    return `${envName} is not available to the gateway. For Codex, env_key reads a system environment variable, not this project's .env. Set ${envName} in your Windows/macOS/Linux environment, or put ${envName} in the gateway .env, or make the client send Authorization directly.`;
  }
  return `${envName} is not set. Put it in the gateway .env as ${envName}, or send it in the client Authorization / x-api-key header.`;
}

function missingProviderApiKeyMessage(provider, req) {
  const keyName = provider.api_key_env || "the provider API key";
  const client = getRequestContext(req).client;
  if (client === "codex" && provider.api_key_env) {
    return `API key is not set for provider ${provider.id}. Codex env_key reads a system environment variable, not this project's .env. Set ${keyName} in your system environment, put it in the gateway .env, or make the client send Authorization directly.`;
  }
  return `API key is not set for provider ${provider.id}. Set ${keyName} in the gateway .env, or pass it in the client Authorization / x-api-key header.`;
}

function modelDiscovery(client = 'claude') {
  const now = Math.floor(Date.now() / 1000);
  if (client === "code") {
    return {
      object: "list",
      data: [...CLAUDE_CODE_MODEL_ROUTES.models].map((model) => ({
        id: model.id,
        object: "model",
        created: now,
        owned_by: model.owned_by,
        display_name: model.display_name,
      })),
    };
  }
  const merged = new Map();

  for (const id of OFFICIAL_CLAUDE_MODELS) {
    if (!id) continue;
    merged.set(id, {
      id,
      object: "model",
      created: now,
      owned_by: "anthropic",
      display_name: displayNameForClaudeModel(id),
    });
  }

  const clientName = client === "claude" ? "desktop" : client;
  const clientEndpoints = selectExposedEndpoints(
    GATEWAY_CONFIG.clients?.[clientName]?.endpoints || [],
  );
  const visibleIds = [...new Set(clientEndpoints.flatMap((endpoint) => [
    ...(endpoint.models || []),
    ...Object.keys(endpoint.model_mapping || {}),
  ]))];
  for (const id of visibleIds) {
    if (!id || merged.has(id)) continue;
    const route = resolveConfiguredModel(id, [], client);
    merged.set(id, {
      id,
      object: "model",
      created: now,
      owned_by: route?.provider?.id || "custom",
      display_name: MODEL_DISPLAY_NAMES[id] || id,
    });
  }

  return {
    object: "list",
    data: [...merged.values()],
  };
}

function publicGatewayConfig() {
  const clients = structuredClone(GATEWAY_CONFIG.clients || {});
  for (const client of Object.values(clients)) {
    for (const endpoint of client.endpoints || []) {
      endpoint.has_api_key = Boolean(GATEWAY_SECRETS?.api_keys?.[endpoint.id]);
      delete endpoint.api_key;
      delete endpoint.api_key_env;
    }
  }
  return {
    ...GATEWAY_CONFIG,
    clients,
    config_file: fs.existsSync(GATEWAY_CONFIG_FILE) ? GATEWAY_CONFIG_FILE : null,
    codex_model_catalog: {
      path: CODEX_MODEL_CATALOG_PATH,
      path_posix: toPosixPath(CODEX_MODEL_CATALOG_PATH),
      exists: fs.existsSync(CODEX_MODEL_CATALOG_PATH),
      write_enabled: CODEX_WRITE_MODEL_CATALOG,
    },
  };
}

function toPosixPath(filePath) {
  return String(filePath || "").replaceAll("\\", "/");
}

function publicProviders() {
  return GATEWAY_CONFIG.clients || {};
}

function resolveModelPublic(model, client = 'claude') {
  const configured = resolveConfiguredModel(model, [], client);
  const officialClaude = isOfficialClaudeModel(model);
  const officialCodex = isOfficialCodexModel(model);

  return {
    model,
    configured: configured
      ? {
          id: configured.model.id,
          display_name: configured.model.display_name || configured.model.id,
          upstream_model: configured.upstream_model,
          provider: publicProvider(configured.provider),
          aliases: configured.model.aliases || [],
        }
      : null,
    official: {
      claude: officialClaude,
      codex: officialCodex,
    },
    routes: {
      anthropic_messages: resolveCapabilityForProtocol(model, "anthropic_messages", client),
      openai_chat: resolveCapabilityForProtocol(model, "openai_chat", client),
      openai_responses: resolveCapabilityForProtocol(model, "openai_responses", client),
    },
  };
}

function publicProvider(provider) {
  if (!provider) return null;
  return {
    id: provider.id,
    type: provider.type,
    base_url: provider.base_url,
    api_key_env: provider.api_key_env || "",
    auth: provider.auth,
    has_api_key: Boolean(getConfiguredProviderApiKey(provider)),
  };
}

function resolveCapabilityForProtocol(model, protocol, client = null) {
  const configured = resolveConfiguredModel(model, [], client);
  if (configured) {
    const providerType = configured.provider.type;
    const direct = {
      anthropic_messages: "anthropic",
      openai_chat: "openai-chat",
      openai_responses: "openai-responses",
    }[protocol];
    const translations = {
      anthropic_messages: {
        "openai-chat": "anthropic_messages_to_openai_chat",
      },
      openai_chat: {
        anthropic: "openai_chat_to_anthropic_messages",
        "openai-responses": "openai_chat_to_openai_responses",
      },
      openai_responses: {
        anthropic: "openai_responses_to_anthropic_messages",
        "openai-chat": "openai_responses_to_openai_chat",
      },
    };
    const translation = translations[protocol]?.[providerType] || null;
    const supported = providerType === direct || Boolean(translation);
    return {
      supported,
      mode: providerType === direct ? "direct" : translation ? "translated" : "unsupported",
      translation,
      provider: configured.provider.id,
      provider_type: providerType,
      upstream_model: configured.upstream_model,
      reason: supported ? null : `${protocol} cannot currently route to provider type ${providerType}`,
    };
  }

  if (protocol === "anthropic_messages" && isOfficialClaudeModel(model)) {
    return {
      supported: true,
      mode: "official",
      translation: null,
      provider: "official-anthropic",
      provider_type: "anthropic",
      upstream_model: model,
      reason: null,
    };
  }

  if (protocol === "openai_responses" && isOfficialCodexModel(model)) {
    return {
      supported: true,
      mode: "official",
      translation: null,
      provider: "official-codex",
      provider_type: "openai-responses",
      upstream_model: model,
      reason: null,
    };
  }

  const fallbackModel = resolveModel(model);
  const fallbackProviderType = protocol === "anthropic_messages" ? "anthropic" : protocol === "openai_responses" ? "openai-responses" : "openai-chat";
  return {
    supported: Boolean(fallbackModel),
    mode: "legacy_fallback",
    translation: null,
    provider: protocol === "anthropic_messages" ? "legacy-volcengine-anthropic" : "legacy-volcengine-openai",
    provider_type: fallbackProviderType,
    upstream_model: fallbackModel,
    reason: fallbackModel ? null : "No configured route, official route, or legacy fallback model found",
  };
}

const CODEX_MODELS_LIVE_ENABLED = !isTruthy(process.env.CODEX_MODELS_LIVE_DISABLED);
const CODEX_MODELS_TTL_MS = intEnv("CODEX_MODELS_TTL_MS", 300_000);
const CODEX_MODELS_LIVE_TIMEOUT_MS = intEnv("CODEX_MODELS_LIVE_TIMEOUT_MS", 2_500);

function codexModelDiscovery(client = "codex", officialModels = OFFICIAL_CODEX_MODELS) {
  const now = Math.floor(Date.now() / 1000);
  const merged = new Map();

  for (const model of officialModels) {
    const id = model.id || model.slug;
    if (!id) continue;
    merged.set(id, {
      id,
      object: "model",
      created: Number(model.created) || now,
      owned_by: model.owned_by || "openai",
      display_name: model.display_name || id,
    });
  }

  for (const model of CODEX_CUSTOM_MODELS) {
    const modelId = model.slug || model.id;
    if (!merged.has(modelId)) {
      merged.set(modelId, {
        id: modelId,
        object: "model",
        created: now,
        owned_by: model.owned_by || "local-volcengine-ark",
        display_name: model.display_name || modelId,
      });
    }
  }

  const data = [...merged.values()];

  return {
    object: "list",
    data,
    models: data.map((model) => ({
      slug: model.id,
      display_name: model.display_name || model.id,
      visibility: "list",
      supported_in_api: true,
      input_modalities: ["text"],
      owned_by: model.owned_by || "custom",
    })),
  };
}

// Best-effort refresh for Desktop model pickers. Routing still uses the startup
// bundled set + gpt-*/o* matcher, so discovery failures never change behavior.
async function codexModelDiscoveryFresh(client = "codex") {
  const now = Date.now();
  if (
    _codexModelsDiscoveryCache
    && now - _codexModelsDiscoveryCache.at < CODEX_MODELS_TTL_MS
  ) {
    return _codexModelsDiscoveryCache.payload;
  }

  let officialModels = OFFICIAL_CODEX_MODELS;
  let officialSource = "bundled-startup";

  if (CODEX_MODELS_LIVE_ENABLED) {
    try {
      const refreshedBundled = loadOfficialCodexCatalogModels().map((model) => ({
        id: model.slug,
        display_name: model.display_name || model.slug,
        owned_by: "openai",
      }));
      if (refreshedBundled.length) {
        officialModels = mergeOfficialDiscoveryModels(officialModels, refreshedBundled);
        officialSource = "bundled-refresh";
      }
    } catch {
      // Keep startup bundled list.
    }

    try {
      const liveModels = await fetchLiveOfficialCodexModels();
      if (liveModels.length) {
        officialModels = mergeOfficialDiscoveryModels(officialModels, liveModels);
        officialSource = officialSource === "bundled-refresh"
          ? "bundled-refresh+live"
          : "bundled-startup+live";
      }
    } catch {
      // Live OpenAI catalog is optional.
    }
  }

  const payload = {
    ...codexModelDiscovery(client, officialModels),
    official_source: officialSource,
  };
  _codexModelsDiscoveryCache = { at: now, payload };
  return payload;
}

async function fetchLiveOfficialCodexModels() {
  const auth = getOfficialCodexAuth(null);
  if (!auth?.accessToken) return [];

  // Prefer the public OpenAI models API. ChatGPT-subscription tokens may fail;
  // callers always fall back to bundled catalog.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CODEX_MODELS_LIVE_TIMEOUT_MS);
  try {
    const response = await fetchWithOptionalProxy("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return officialModelsFromOpenAIList(payload);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function openAIChatToAnthropic(body, resolvedModel) {
  const messages = [];
  const system = [];

  for (const message of body.messages || []) {
    if (message.role === "system") {
      const text = openAIContentToText(message.content);
      if (text) system.push(text);
      continue;
    }

    const converted = openAIMessageToAnthropic(message);
    if (converted) messages.push(converted);
  }

  const upstreamBody = {
    model: resolvedModel,
    messages,
    max_tokens: body.max_completion_tokens || body.max_tokens || 4096,
    stream: Boolean(body.stream),
  };

  if (system.length > 0) upstreamBody.system = system.join("\n\n");
  if (body.temperature != null) upstreamBody.temperature = body.temperature;
  if (body.top_p != null) upstreamBody.top_p = body.top_p;
  if (body.stop != null) upstreamBody.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    upstreamBody.tools = body.tools.map((tool) => ({
      name: tool.function?.name || tool.name || "tool",
      description: tool.function?.description || tool.description || "",
      input_schema: tool.function?.parameters || tool.parameters || {
        type: "object",
        properties: {},
      },
    }));
  }
  if (body.tool_choice) upstreamBody.tool_choice = openAIToolChoiceToAnthropic(body.tool_choice);

  return upstreamBody;
}

function openAIResponsesToAnthropic(body, resolvedModel) {
  const messages = [];
  const system = [];

  if (body.instructions) system.push(String(body.instructions));

  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      const converted = openAIResponseInputToAnthropic(item);
      if (converted?.role === "system") {
        if (converted.text) system.push(converted.text);
      } else if (converted) {
        appendAnthropicMessage(messages, converted);
      }
    }
  } else if (typeof body.input === "string") {
    messages.push({ role: "user", content: [{ type: "text", text: body.input }] });
  } else if (Array.isArray(body.messages)) {
    return openAIChatToAnthropic(
      {
        ...body,
        model: resolvedModel,
        max_tokens: body.max_output_tokens || body.max_tokens,
      },
      resolvedModel,
    );
  }

  const upstreamBody = {
    model: resolvedModel,
    messages,
    max_tokens: body.max_output_tokens || body.max_tokens || 4096,
    stream: Boolean(body.stream),
  };

  if (system.length > 0) upstreamBody.system = system.join("\n\n");
  if (body.temperature != null) upstreamBody.temperature = body.temperature;
  if (body.top_p != null) upstreamBody.top_p = body.top_p;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    upstreamBody.tools = body.tools
      .map(responseToolToAnthropic)
      .filter(Boolean);
  }
  if (body.tool_choice != null && body.tool_choice !== "none") {
    upstreamBody.tool_choice = openAIToolChoiceToAnthropic(body.tool_choice);
  }

  return upstreamBody;
}

function appendAnthropicMessage(messages, message) {
  if (!message || !Array.isArray(message.content)) return;
  const previous = messages[messages.length - 1];
  if (previous?.role === message.role && Array.isArray(previous.content)) {
    previous.content.push(...message.content);
    return;
  }
  messages.push(message);
}

function openAIChatCompletionsToResponses(body, resolvedModel) {
  const input = [];
  const instructions = [];

  for (const message of body.messages || []) {
    if (!message || typeof message !== "object") continue;
    const text = openAIContentToText(message.content);
    if (message.role === "system") {
      if (text) instructions.push(text);
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id || message.call_id || "tool",
        output: text,
      });
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = openAIChatContentToResponsesContent(message.content, role);
    if (content.length || role === "user") {
      input.push({
        role,
        content: content.length
          ? content
          : [{ type: "input_text", text: "" }],
      });
    }
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const fn = toolCall?.function || {};
        input.push({
          type: "function_call",
          call_id: toolCall?.id || randomUUID(),
          name: fn.name || "tool",
          arguments: typeof fn.arguments === "string"
            ? fn.arguments
            : JSON.stringify(fn.arguments || {}),
        });
      }
    }
  }

  const upstreamBody = {
    model: resolvedModel,
    input: input.length ? input : [{ role: "user", content: [{ type: "input_text", text: "" }] }],
    stream: Boolean(body.stream),
  };

  if (instructions.length > 0) upstreamBody.instructions = instructions.join("\n\n");
  if (body.max_completion_tokens != null) upstreamBody.max_output_tokens = body.max_completion_tokens;
  else if (body.max_tokens != null) upstreamBody.max_output_tokens = body.max_tokens;
  if (body.temperature != null) upstreamBody.temperature = body.temperature;
  if (body.top_p != null) upstreamBody.top_p = body.top_p;
  if (body.stop != null) upstreamBody.stop = body.stop;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    upstreamBody.tools = body.tools.map(openAIChatToolToResponseTool).filter(Boolean);
  }
  if (body.tool_choice != null) {
    upstreamBody.tool_choice = openAIChatToolChoiceToResponseToolChoice(body.tool_choice);
  }

  return upstreamBody;
}

function openAIChatToolToResponseTool(tool) {
  if (!tool || typeof tool !== "object") return null;
  const fn = tool.function || tool;
  if (!fn.name) return null;
  return {
    type: "function",
    name: fn.name,
    description: fn.description || "",
    parameters: fn.parameters || { type: "object", properties: {} },
  };
}

function openAIChatToolChoiceToResponseToolChoice(toolChoice) {
  if (typeof toolChoice === "string") return toolChoice;
  if (toolChoice?.type === "function") {
    return {
      type: "function",
      name: toolChoice.function?.name || toolChoice.name || "tool",
    };
  }
  return toolChoice;
}

function openAIChatContentToResponsesContent(content, role) {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    return content ? [{ type: textType, text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if ((part.type === "text" || part.type === "input_text" || part.type === "output_text") && part.text != null) {
      parts.push({ type: textType, text: String(part.text) });
      continue;
    }
    if (role !== "user" || (part.type !== "image_url" && part.type !== "input_image")) continue;
    const imageUrl = typeof part.image_url === "string"
      ? part.image_url
      : part.image_url?.url || part.url;
    if (imageUrl) parts.push({ type: "input_image", image_url: imageUrl });
  }
  return parts;
}

function anthropicMessagesToOpenAIChat(body, resolvedModel) {
  const messages = [];

  if (body.system) {
    const systemText = Array.isArray(body.system)
      ? body.system.map((part) => typeof part === "string" ? part : part?.text || "").filter(Boolean).join("\n\n")
      : String(body.system);
    if (systemText) messages.push({ role: "system", content: systemText });
  }

  for (const message of body.messages || []) {
    const converted = anthropicMessageToOpenAIChatMessage(message);
    if (Array.isArray(converted)) messages.push(...converted);
    else if (converted) messages.push(converted);
  }

  const upstreamBody = {
    model: resolvedModel,
    messages: messages.length ? messages : [{ role: "user", content: "" }],
    stream: Boolean(body.stream),
  };

  if (body.max_tokens != null) upstreamBody.max_tokens = body.max_tokens;
  if (body.temperature != null) upstreamBody.temperature = body.temperature;
  if (body.top_p != null) upstreamBody.top_p = body.top_p;
  if (body.stop_sequences != null) upstreamBody.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    upstreamBody.tools = body.tools.map(anthropicToolToOpenAIChatTool).filter(Boolean);
  }
  if (body.tool_choice != null) {
    upstreamBody.tool_choice = anthropicToolChoiceToOpenAIChat(body.tool_choice);
  }

  return upstreamBody;
}

function anthropicMessageToOpenAIChatMessage(message) {
  if (!message || typeof message !== "object") return null;
  const role = message.role === "assistant" ? "assistant" : "user";
  const content = message.content;

  if (!Array.isArray(content)) {
    return { role, content: typeof content === "string" ? content : "" };
  }

  const textAndImageParts = [];
  const toolCalls = [];
  const toolResults = [];

  for (const block of content) {
    if (!block) continue;
    if (block.type === "text") {
      textAndImageParts.push({ type: "text", text: block.text || "" });
      continue;
    }
    if (block.type === "image") {
      const imageUrl = anthropicImageBlockToDataUrl(block);
      if (imageUrl) textAndImageParts.push({ type: "image_url", image_url: { url: imageUrl } });
      continue;
    }
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || randomUUID(),
        type: "function",
        function: {
          name: block.name || "tool",
          arguments: JSON.stringify(block.input || {}),
        },
      });
      continue;
    }
    if (block.type === "tool_result") {
      toolResults.push({
        role: "tool",
        tool_call_id: block.tool_use_id || block.id || "tool",
        content: anthropicToolResultContentToText(block.content),
      });
    }
  }

  if (toolResults.length > 0 && role === "user") return toolResults;

  const chatMessage = {
    role,
    content: openAIChatContentFromParts(textAndImageParts),
  };
  if (toolCalls.length > 0) {
    chatMessage.content = chatMessage.content || null;
    chatMessage.tool_calls = toolCalls;
  }

  return chatMessage;
}

function anthropicImageBlockToDataUrl(block) {
  const source = block.source || {};
  if (source.type === "base64" && source.media_type && source.data) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  if (source.type === "url" && source.url) return source.url;
  return "";
}

function anthropicToolResultContentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content || "");
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text") return part.text || "";
    return JSON.stringify(part || "");
  }).join("\n");
}

function openAIChatContentFromParts(parts) {
  const filtered = parts.filter((part) => part.type !== "text" || part.text);
  if (filtered.length === 0) return "";
  if (filtered.every((part) => part.type === "text")) return filtered.map((part) => part.text).join("");
  return filtered;
}

function anthropicToolToOpenAIChatTool(tool) {
  if (!tool || typeof tool !== "object") return null;
  return {
    type: "function",
    function: {
      name: tool.name || "tool",
      description: tool.description || "",
      parameters: tool.input_schema || tool.parameters || { type: "object", properties: {} },
    },
  };
}

function anthropicToolChoiceToOpenAIChat(toolChoice) {
  if (typeof toolChoice === "string") return toolChoice;
  if (!toolChoice || typeof toolChoice !== "object") return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool") {
    return {
      type: "function",
      function: { name: toolChoice.name || "tool" },
    };
  }
  return undefined;
}

function openAIMessageToAnthropic(message) {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id || "tool",
          content: openAIContentToText(message.content),
        },
      ],
    };
  }

  if (message.role !== "user" && message.role !== "assistant") return null;

  const content = openAIContentToAnthropicBlocks(message.content);
  if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: toolCall.id || randomUUID(),
        name: toolCall.function?.name || "tool",
        input: parseJsonMaybe(toolCall.function?.arguments) || {},
      });
    }
  }

  return {
    role: message.role,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
  };
}

function openAIResponseInputToAnthropic(item) {
  if (typeof item === "string") {
    return { role: "user", content: [{ type: "text", text: item }] };
  }

  if (!item || typeof item !== "object") return null;
  if (item.role === "system") {
    return { role: "system", text: responseInputContentToText(item.content) };
  }
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    const input = item.type === "custom_tool_call"
      ? { input: typeof item.input === "string" ? item.input : responseToolOutputToText(item.input) }
      : parseJsonMaybe(item.arguments) || item.arguments || {};
    return {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: item.call_id || item.id || randomUUID(),
        name: item.name || "tool",
        input,
      }],
    };
  }
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: item.call_id || item.id || "tool",
        content: responseToolOutputToText(item.output),
      }],
    };
  }

  return {
    role: item.role === "assistant" ? "assistant" : "user",
    content: responseInputContentToAnthropicBlocks(item.content),
  };
}

function anthropicToOpenAIChatResponse(upstreamJson, requestedModel) {
  const text = anthropicContentToText(upstreamJson.content);
  const toolCalls = anthropicContentToToolCalls(upstreamJson.content);
  const finishReason = anthropicStopReasonToOpenAI(upstreamJson.stop_reason, toolCalls.length > 0);

  return {
    id: upstreamJson.id || `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || upstreamJson.model || "custom-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: upstreamJson.usage?.input_tokens || 0,
      completion_tokens: upstreamJson.usage?.output_tokens || 0,
      total_tokens:
        (upstreamJson.usage?.input_tokens || 0) + (upstreamJson.usage?.output_tokens || 0),
    },
  };
}

function anthropicToOpenAIResponse(upstreamJson, requestedModel, toolKinds = new Map()) {
  const text = anthropicContentToText(upstreamJson.content);
  const toolCalls = anthropicContentToResponseToolCalls(upstreamJson.content, toolKinds);
  const output = [];
  if (text || toolCalls.length === 0) {
    output.push({
      id: upstreamJson.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text,
          annotations: [],
        },
      ],
    });
  }
  output.push(...toolCalls);

  return {
    id: upstreamJson.id || `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: requestedModel || upstreamJson.model || "custom-model",
    status: "completed",
    output,
    output_text: text,
    usage: {
      input_tokens: upstreamJson.usage?.input_tokens || 0,
      output_tokens: upstreamJson.usage?.output_tokens || 0,
      total_tokens:
        (upstreamJson.usage?.input_tokens || 0) + (upstreamJson.usage?.output_tokens || 0),
    },
  };
}

async function sendAnthropicAsOpenAIChat(upstream, clientRes, requestedModel) {
  const headers = responseHeaders(upstream.headers);
  if (!upstream.ok) {
    clientRes.writeHead(upstream.status, headers);
    clientRes.end(await upstream.text());
    return;
  }

  const upstreamJson = await upstream.json();
  clientRes.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  clientRes.end(JSON.stringify(anthropicToOpenAIChatResponse(upstreamJson, requestedModel)));
}

async function sendOpenAIResponseAsChatCompletion(upstream, clientRes, requestedModel) {
  const headers = responseHeaders(upstream.headers);
  if (!upstream.ok) {
    clientRes.writeHead(upstream.status, headers);
    clientRes.end(await upstream.text());
    return;
  }

  const upstreamJson = await upstream.json();
  clientRes.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  clientRes.end(JSON.stringify(openAIResponseToChatCompletion(upstreamJson, requestedModel)));
}

function openAIResponseToChatCompletion(upstreamJson, requestedModel) {
  const text = upstreamJson.output_text || openAIResponseOutputToText(upstreamJson.output);
  const incomplete = upstreamJson.status === "incomplete";
  const inputTokens = upstreamJson.usage?.input_tokens || 0;
  const outputTokens = upstreamJson.usage?.output_tokens || 0;

  return {
    id: upstreamJson.id || `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: upstreamJson.created_at || Math.floor(Date.now() / 1000),
    model: requestedModel || upstreamJson.model || "custom-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: incomplete ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: upstreamJson.usage?.total_tokens || inputTokens + outputTokens,
    },
  };
}

function openAIResponseOutputToText(output) {
  if (!Array.isArray(output)) return "";
  const parts = [];
  for (const item of output) {
    if (!item) continue;
    if (typeof item.content === "string") {
      parts.push(item.content);
      continue;
    }
    if (Array.isArray(item.content)) {
      for (const content of item.content) {
        if (!content) continue;
        if ((content.type === "output_text" || content.type === "text") && content.text) {
          parts.push(content.text);
        }
      }
    }
  }
  return parts.join("");
}

async function sendOpenAIChatAsAnthropicMessage(upstream, clientRes, requestedModel) {
  const headers = responseHeaders(upstream.headers);
  if (!upstream.ok) {
    clientRes.writeHead(upstream.status, headers);
    clientRes.end(await upstream.text());
    return;
  }

  const upstreamJson = await upstream.json();
  clientRes.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  clientRes.end(JSON.stringify(openAIChatCompletionToAnthropicMessage(upstreamJson, requestedModel)));
}

function openAIChatCompletionToAnthropicMessage(upstreamJson, requestedModel) {
  const choice = upstreamJson.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  const text = openAIChatMessageText(message);

  if (text) content.push({ type: "text", text });

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: toolCall.id || randomUUID(),
        name: toolCall.function?.name || "tool",
        input: parseJsonMaybe(toolCall.function?.arguments) || {},
      });
    }
  }

  return {
    id: upstreamJson.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel || upstreamJson.model || "custom-model",
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: openAIChatFinishReasonToAnthropic(choice.finish_reason, content),
    stop_sequence: null,
    usage: {
      input_tokens: upstreamJson.usage?.prompt_tokens || 0,
      output_tokens: upstreamJson.usage?.completion_tokens || 0,
    },
  };
}

function openAIChatMessageText(message = {}) {
  return firstNonEmptyText(
    typeof message.content === "string" ? message.content : openAIContentToText(message.content),
    message.reasoning_content,
    message.reasoning,
    message.text,
  );
}

function openAIChatDeltaText(delta = {}) {
  return firstNonEmptyText(
    typeof delta.content === "string" ? delta.content : openAIContentToText(delta.content),
    delta.reasoning_content,
    delta.reasoning,
    delta.text,
  );
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function openAIChatFinishReasonToAnthropic(finishReason, content = []) {
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "tool_calls" || content.some((block) => block.type === "tool_use")) return "tool_use";
  return "end_turn";
}

function openAIChatCompletionToResponse(upstreamJson, requestedModel) {
  const choice = upstreamJson.choices?.[0] || {};
  const message = choice.message || {};
  const content = typeof message.content === "string" ? message.content : openAIContentToText(message.content);
  const outputContent = [];

  if (content) {
    outputContent.push({
      type: "output_text",
      text: content,
      annotations: [],
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      outputContent.push({
        type: "tool_call",
        id: toolCall.id || randomUUID(),
        name: toolCall.function?.name || "tool",
        arguments: toolCall.function?.arguments || "{}",
      });
    }
  }

  return {
    id: upstreamJson.id || `resp_${Date.now()}`,
    object: "response",
    created_at: upstreamJson.created || Math.floor(Date.now() / 1000),
    model: requestedModel || upstreamJson.model || "custom-model",
    status: choice.finish_reason === "length" ? "incomplete" : "completed",
    output: [
      {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: outputContent,
      },
    ],
    output_text: content,
    usage: {
      input_tokens: upstreamJson.usage?.prompt_tokens || 0,
      output_tokens: upstreamJson.usage?.completion_tokens || 0,
      total_tokens: upstreamJson.usage?.total_tokens || 0,
    },
  };
}

function resolveModel(requestedModel) {
  if (requestedModel && MODEL_ALIASES[requestedModel]) {
    return MODEL_ALIASES[requestedModel];
  }
  return ARK_MODEL || requestedModel;
}

function resolveAnthropicRoute(requestedModel, client) {
  const configured = resolveConfiguredModel(requestedModel, ["anthropic", "openai-chat", "grok"], client);
  if (configured) {
    if (!["anthropic", "openai-chat", "grok"].includes(configured.provider.type)) {
      throw httpError(
        400,
        `Model ${requestedModel} is configured for provider ${configured.provider.id} (${configured.provider.type}), which cannot serve Anthropic Messages requests yet.`,
      );
    }
    return {
      kind: configured.provider.id,
      model: configured.upstream_model,
      provider: configured.provider,
      endpoint: configured.endpoint,
      config: configured.model,
    };
  }

  if (isOfficialClaudeModel(requestedModel)) {
    return { kind: "official", model: requestedModel };
  }

  return { kind: "volcengine", model: ARK_MODEL || requestedModel };
}

function hasConfiguredApiKey(ep) {
  if (ep.type === "official" || ep.name === "official") return true;
  if (ep.type === "grok") return grokHasCredentials(ep);
  if (getEndpointApiKey(ep, GATEWAY_SECRETS)) return true;
  if (!ep.api_key) return false;
  if (ep.api_key.startsWith("env:")) {
    const envVar = ep.api_key.slice(4);
    return Boolean(process.env[envVar]);
  }
  return true;
}

function resolveConfiguredModel(requestedModel, allowedTypes = [], client = null) {
  if (!requestedModel) return null;
  const text = String(requestedModel);
  const allowed = new Set(allowedTypes);

  if (client === "code") {
    const internalRoute = CLAUDE_CODE_MODEL_ROUTES.routes.get(text);
    if (
      internalRoute &&
      (allowed.size === 0 || allowed.has(internalRoute.endpoint.type)) &&
      hasConfiguredApiKey(internalRoute.endpoint)
    ) {
      return {
        model: {
          id: text,
          display_name: internalRoute.display_name,
          upstream_model: internalRoute.upstream_model,
          aliases: [],
        },
        provider: endpointProvider(internalRoute.endpoint),
        endpoint: internalRoute.endpoint,
        upstream_model: internalRoute.upstream_model,
      };
    }
  }

  const clientsToCheck = client ? [client] : ["code", "desktop", "claude", "codex"];

  for (const c of clientsToCheck) {
    const allEndpoints = GATEWAY_CONFIG.clients?.[c]?.endpoints || [];
    const endpoints = allEndpoints.filter(ep =>
      ep.purpose !== "vision_fallback" && hasConfiguredApiKey(ep)
    );
    
    // Find the default endpoint first
    const defaultEp = endpoints.find(ep => ep.is_default && (allowed.size === 0 || allowed.has(ep.type)));

    // 1. If default endpoint is defined, check its precise models and mappings first
    if (defaultEp) {
      let targetModel = text;
      let matched = false;

      if (defaultEp.model_mapping && defaultEp.model_mapping[text]) {
        targetModel = defaultEp.model_mapping[text];
        matched = true;
      } else if (defaultEp.models?.includes(text)) {
        matched = true;
      }

      if (matched) {
        return {
          model: { id: text, display_name: text, upstream_model: targetModel, aliases: [] },
          provider: endpointProvider(defaultEp),
          endpoint: defaultEp,
          upstream_model: targetModel
        };
      }
    }

    // 2. Check all endpoints (including non-default ones) in order for precise matches
    for (const ep of endpoints) {
      if (allowed.size === 0 || allowed.has(ep.type)) {
        let targetModel = text;
        if (ep.model_mapping && ep.model_mapping[text]) {
          targetModel = ep.model_mapping[text];
        }

        if (ep.models?.includes(targetModel) || ep.name === text || ep.model_mapping?.[text]) {
          return {
             model: { id: text, display_name: text, upstream_model: targetModel, aliases: [] },
             provider: endpointProvider(ep),
             endpoint: ep,
             upstream_model: targetModel
          };
        }
      }
    }

    // 3. Fallback to default endpoint if still not matched
    if (defaultEp) {
      let targetModel = text;
      if (defaultEp.model_mapping && defaultEp.model_mapping[text]) {
        targetModel = defaultEp.model_mapping[text];
      }
      return {
         model: { id: text, display_name: text, upstream_model: targetModel, aliases: [] },
         provider: endpointProvider(defaultEp),
         endpoint: defaultEp,
         upstream_model: targetModel
      };
    }
  }

  return null;
}

async function maybePreprocessImages(body, route, clientReq, context) {
  if (!containsImages(body) || !route?.provider) return body;
  if (!shouldPreprocessImages({
    endpoint: route.endpoint || route.config,
    upstreamModel: route.upstream_model || route.model,
  })) return body;
  return applyVisionFallback(body, route, clientReq, context, "configured");
}

async function maybeRetryAfterImageError({
  upstream,
  originalBody,
  route,
  clientReq,
  context,
  fetchAgain,
}) {
  if (upstream.ok || !containsImages(originalBody)) return upstream;
  let preservedUpstream = upstream;
  let errorText;
  if (typeof upstream.clone === "function") {
    errorText = await upstream.clone().text();
  } else {
    errorText = await upstream.text();
    preservedUpstream = new Response(errorText, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers?.get?.("content-type") || "application/json; charset=utf-8",
      },
    });
  }
  if (!isImageCapabilityError(upstream.status, errorText)) return preservedUpstream;
  const retryBody = await applyVisionFallback(
    originalBody,
    route,
    clientReq,
    context,
    "upstream_error",
  );
  if (retryBody === originalBody) return upstream;
  return fetchAgain(retryBody);
}

async function applyVisionFallback(body, route, clientReq, context, reason) {
  const endpoints = GATEWAY_CONFIG.clients?.[context.client]?.endpoints || [];
  const fallback = selectVisionFallback(endpoints);
  if (!fallback || fallback.endpoint.id === route?.provider?.id) return body;
  const images = collectImages(body);
  if (!images.length) return body;
  const {
    description,
    analyzedImageCount,
    cachedImageCount,
  } = await describeImagesWithFallback(images, fallback, clientReq);
  logInfo("vision_fallback_applied", {
    request_id: context.requestId,
    client: context.client,
    target_provider: route?.provider?.id || null,
    target_model: route?.upstream_model || route?.model || null,
    vision_provider: fallback.endpoint.id,
    vision_model: fallback.model,
    image_count: images.length,
    analyzed_image_count: analyzedImageCount,
    cached_image_count: cachedImageCount,
    reason,
  });
  return replaceImagesWithDescription(body, description);
}

async function describeImagesWithFallback(images, fallback, clientReq) {
  const urls = images.map(imagePartToUrl).filter(Boolean);
  if (!urls.length) {
    throw httpError(400, "The request contains images that the vision fallback cannot read.");
  }
  const cacheKey = createHash("sha256")
    .update(`${fallback.endpoint.id}\0${fallback.model}\0${urls.join("\0")}`)
    .digest("hex");
  const exactCached = VISION_DESCRIPTION_CACHE.get(cacheKey);
  if (exactCached) {
    return {
      description: exactCached.description,
      analyzedImageCount: 0,
      cachedImageCount: urls.length,
    };
  }

  let cachedPrefix = null;
  for (const entry of VISION_DESCRIPTION_CACHE.values()) {
    if (
      entry.endpointId !== fallback.endpoint.id
      || entry.model !== fallback.model
      || entry.urls.length >= urls.length
      || (cachedPrefix && entry.urls.length <= cachedPrefix.urls.length)
    ) continue;
    if (entry.urls.every((url, index) => url === urls[index])) cachedPrefix = entry;
  }
  const uncachedUrls = cachedPrefix ? urls.slice(cachedPrefix.urls.length) : urls;

  const provider = endpointProvider(fallback.endpoint);
  const prompt = "请完整识别这些图片，提取所有文字、代码、表格、报错和界面结构，并描述与用户问题相关的关键视觉信息。只输出客观、结构化的图片解析结果，不要回答用户问题。";
  let upstream;
  let description = "";

  if (provider.type === "anthropic") {
    upstream = await fetchConfiguredAnthropic(provider, {
      model: fallback.model,
      max_tokens: 4096,
      stream: false,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...uncachedUrls.map(openAIImagePartToAnthropic).filter(Boolean),
        ],
      }],
    }, clientReq);
    if (upstream.ok) description = anthropicContentToText((await upstream.json()).content);
  } else if (provider.type === "openai-chat") {
    upstream = await fetchConfiguredOpenAI(provider, "/v1/chat/completions", {
      model: fallback.model,
      stream: false,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...uncachedUrls.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      }],
    }, clientReq);
    if (upstream.ok) {
      description = openAIChatMessageText((await upstream.json()).choices?.[0]?.message);
    }
  } else if (provider.type === "openai-responses") {
    upstream = await fetchConfiguredOpenAI(provider, "/responses", {
      model: fallback.model,
      stream: false,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          ...uncachedUrls.map((url) => ({ type: "input_image", image_url: url })),
        ],
      }],
    }, clientReq);
    if (upstream.ok) {
      const payload = await upstream.json();
      description = payload.output_text || openAIResponseOutputToText(payload.output);
    }
  } else if (provider.type === "grok") {
    const backend = grokBackendFor(fallback.model);
    upstream = backend === "chat"
      ? await fetchGrok(provider, "/chat/completions", {
          model: fallback.model,
          stream: false,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...uncachedUrls.map((url) => ({ type: "image_url", image_url: { url } })),
            ],
          }],
        })
      : await fetchGrok(provider, "/responses", {
          model: fallback.model,
          stream: false,
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: prompt },
            ...uncachedUrls.map((url) => ({ type: "input_image", image_url: url })),
            ],
          }],
        });
    if (upstream.ok) {
      description = backend === "chat"
        ? (await collectChatSseAsChatCompletion(upstream, fallback.model)).choices?.[0]?.message?.content || ""
        : (await collectResponsesSseAsChatCompletion(upstream, fallback.model)).choices?.[0]?.message?.content || "";
    }
  }

  if (!upstream?.ok) {
    const message = upstream ? await upstream.text() : "Unsupported vision fallback provider type";
    throw httpError(upstream?.status || 502, `Vision fallback failed: ${message}`);
  }
  if (!description.trim()) throw httpError(502, "Vision fallback returned no image description.");
  const combinedDescription = cachedPrefix
    ? `${cachedPrefix.description}\n\n[新增图片解析结果]\n${description}`
    : description;
  VISION_DESCRIPTION_CACHE.set(cacheKey, {
    endpointId: fallback.endpoint.id,
    model: fallback.model,
    urls,
    description: combinedDescription,
  });
  if (VISION_DESCRIPTION_CACHE.size > 100) {
    VISION_DESCRIPTION_CACHE.delete(VISION_DESCRIPTION_CACHE.keys().next().value);
  }
  return {
    description: combinedDescription,
    analyzedImageCount: uncachedUrls.length,
    cachedImageCount: urls.length - uncachedUrls.length,
  };
}

function endpointProvider(endpoint) {
  return {
    id: endpoint.id,
    name: endpoint.name,
    type: endpoint.type,
    base_url: endpoint.base_url,
    auth: endpoint.auth || "bearer",
    auth_path: endpoint.auth_path,
    proxy: endpoint.proxy,
    max_concurrency: endpoint.max_concurrency,
    client_version: endpoint.client_version,
    agent_id_path: endpoint.agent_id_path,
  };
}

function isOfficialClaudeModel(model) {
  if (!model) return false;
  const text = String(model);
  const route = resolveConfiguredModel(text, ["anthropic", "openai-chat", "grok"], "claude");
  if (route) return false;
  return /^claude-/i.test(text);
}

function displayNameForClaudeModel(id) {
  return String(id)
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function isOfficialCodexModel(model) {
  if (!model) return false;
  if (OFFICIAL_CODEX_MODEL_IDS.has(model)) return true;
  return isOfficialCodexModelId(model);
}

async function streamAnthropicAsOpenAIChat(upstream, clientRes, requestedModel, requestId) {
  if (!upstream.ok) {
    const text = await upstream.text();
    clientRes.writeHead(upstream.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    clientRes.end(text);
    return;
  }

  clientRes.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const completionId = `chatcmpl_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false;

  await consumeSse(upstream.body, (eventName, payloadText) => {
    const payload = parseJsonMaybe(payloadText) || {};
    if (!sentRole && (eventName === "message_start" || eventName === "content_block_start")) {
      writeOpenAISse(clientRes, {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: requestedModel || "custom-model",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });
      sentRole = true;
    }

    if (eventName === "content_block_delta" && payload.delta?.type === "text_delta") {
      writeOpenAISse(clientRes, {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: requestedModel || "custom-model",
        choices: [
          {
            index: 0,
            delta: { content: payload.delta.text || "" },
            finish_reason: null,
          },
        ],
      });
    }

    if (eventName === "message_delta") {
      writeOpenAISse(clientRes, {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: requestedModel || "custom-model",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: anthropicStopReasonToOpenAI(payload.delta?.stop_reason, false),
          },
        ],
      });
    }
  });

  clientRes.write("data: [DONE]\n\n");
  clientRes.end();
  logInfo("openai_chat_stream_complete", { request_id: requestId });
}

async function streamAnthropicAsOpenAIResponse(
  upstream,
  clientRes,
  requestedModel,
  requestId,
  toolKinds = new Map(),
) {
  if (!upstream.ok) {
    const text = await upstream.text();
    clientRes.writeHead(upstream.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    clientRes.end(text);
    return;
  }

  clientRes.writeHead(200, responsesSseHeaders());
  const writer = new ResponsesWriter({
    model: requestedModel || "custom-model",
    emit(event, payload) {
      clientRes.write(`event: ${event}\n`);
      clientRes.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
  });
  const toolBlocks = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let completed = false;

  try {
    await consumeSse(upstream.body, (eventName, payloadText) => {
      const payload = parseJsonMaybe(payloadText) || {};
      if (eventName === "message_start") {
        inputTokens = payload.message?.usage?.input_tokens || inputTokens;
        writer.created();
        return;
      }

      if (eventName === "content_block_start") {
        const block = payload.content_block || {};
        if (block.type === "tool_use") {
          const tool = {
            index: payload.index ?? toolBlocks.size,
            callId: block.id || randomUUID(),
            name: block.name || "tool",
            argumentsText: block.input && Object.keys(block.input).length
              ? JSON.stringify(block.input)
              : "",
          };
          toolBlocks.set(tool.index, tool);
          writer.functionArgumentsDelta({
            index: tool.index,
            callId: tool.callId,
            name: tool.name,
            delta: tool.argumentsText,
            kind: toolKinds.get(tool.name) || "function",
          });
        }
        return;
      }

      if (eventName === "content_block_delta") {
        if (payload.delta?.type === "text_delta") {
          writer.textDelta(payload.delta.text || "");
        } else if (payload.delta?.type === "input_json_delta") {
          const tool = toolBlocks.get(payload.index);
          if (!tool) return;
          const delta = payload.delta.partial_json || "";
          tool.argumentsText += delta;
          writer.functionArgumentsDelta({
            index: tool.index,
            callId: tool.callId,
            name: tool.name,
            delta,
            kind: toolKinds.get(tool.name) || "function",
          });
        }
        return;
      }

      if (eventName === "content_block_stop") {
        const tool = toolBlocks.get(payload.index);
        if (tool) {
          writer.finishFunction({
            index: tool.index,
            callId: tool.callId,
            name: tool.name,
            argumentsText: tool.argumentsText || "{}",
            kind: toolKinds.get(tool.name) || "function",
          });
        }
        return;
      }

      if (eventName === "message_delta") {
        outputTokens = payload.usage?.output_tokens || outputTokens;
        return;
      }

      if (eventName === "message_stop") {
        completed = true;
        writer.completed({
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        });
      }
    });
    if (!completed) {
      writer.failed({
        code: "upstream_stream_closed",
        message: "Anthropic upstream stream closed before message_stop.",
      });
    }
  } catch (error) {
    writer.failed({
      code: error.code || "upstream_protocol_error",
      message: error.message || "Anthropic upstream protocol error.",
    });
  } finally {
    clientRes.end();
  }
  logInfo("openai_responses_stream_complete", { request_id: requestId });
}

async function sendChatUpstreamAsResponses({
  upstream,
  clientRes,
  requestedModel,
  toolKinds,
}) {
  if (!upstream.ok) {
    await sendUpstreamError(upstream, clientRes);
    return;
  }

  clientRes.writeHead(200, responsesSseHeaders());
  const writer = new ResponsesWriter({
    model: requestedModel,
    emit(event, payload) {
      clientRes.write(`event: ${event}\n`);
      clientRes.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
  });
  try {
    await streamChatAsResponses({
      readable: upstream.body,
      writer,
      toolKinds,
    });
  } catch (error) {
    writer.failed({
      code: error.code || "upstream_protocol_error",
      message: error.message || "Upstream protocol error.",
    });
  } finally {
    clientRes.end();
  }
}

async function streamOpenAIResponseAsChatCompletion(upstream, clientRes, requestedModel, requestId) {
  if (!upstream.ok) {
    const text = await upstream.text();
    clientRes.writeHead(upstream.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    clientRes.end(text);
    return;
  }

  clientRes.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const completionId = `chatcmpl_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false;

  const ensureRole = () => {
    if (sentRole) return;
    sentRole = true;
    writeOpenAISse(clientRes, {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: requestedModel || "custom-model",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
  };

  await consumeSse(upstream.body, (eventName, payloadText) => {
    if (payloadText === "[DONE]") return;
    const payload = parseJsonMaybe(payloadText) || {};

    if (eventName === "response.output_text.delta" || payload.type === "response.output_text.delta") {
      ensureRole();
      writeOpenAISse(clientRes, {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: requestedModel || "custom-model",
        choices: [{ index: 0, delta: { content: payload.delta || "" }, finish_reason: null }],
      });
    }

    if (eventName === "response.completed" || payload.type === "response.completed") {
      ensureRole();
      writeOpenAISse(clientRes, {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: requestedModel || "custom-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
    }
  });

  if (!sentRole) ensureRole();
  clientRes.write("data: [DONE]\n\n");
  clientRes.end();
  logInfo("openai_responses_as_chat_stream_complete", { request_id: requestId });
}

async function streamOpenAIChatAsAnthropicMessages(upstream, clientRes, requestedModel, requestId) {
  if (!upstream.ok) {
    const text = await upstream.text();
    clientRes.writeHead(upstream.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    clientRes.end(text);
    return;
  }

  clientRes.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const messageId = `msg_${Date.now()}`;
  let blockStarted = false;
  let sawText = false;
  let finishReason = "end_turn";

  writeAnthropicSse(clientRes, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: requestedModel || "custom-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const ensureTextBlock = () => {
    if (blockStarted) return;
    blockStarted = true;
    writeAnthropicSse(clientRes, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
  };

  await consumeSse(upstream.body, (_eventName, payloadText) => {
    if (payloadText === "[DONE]") return;
    const payload = parseJsonMaybe(payloadText) || {};
    if (payload.error) {
      const message = payload.error.message || payload.error.code || payload.error.type || "Unknown upstream error";
      ensureTextBlock();
      sawText = true;
      writeAnthropicSse(clientRes, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `[upstream error] ${message}` },
      });
      return;
    }

    const choice = payload.choices?.[0] || {};
    const delta = choice.delta || {};

    if (choice.finish_reason) {
      finishReason = openAIChatFinishReasonToAnthropic(choice.finish_reason);
    }

    const text = openAIChatDeltaText(delta);
    if (text) {
      ensureTextBlock();
      sawText = true;
      writeAnthropicSse(clientRes, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      });
    }
  });

  if (!blockStarted) ensureTextBlock();
  if (!sawText) {
    logInfo("openai_chat_as_anthropic_stream_empty", { request_id: requestId });
    sawText = true;
    writeAnthropicSse(clientRes, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: "[upstream returned no text] The provider completed the request without any OpenAI Chat content. Check the upstream model mapping and provider response.",
      },
    });
  }
  writeAnthropicSse(clientRes, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  writeAnthropicSse(clientRes, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: sawText ? finishReason : "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  writeAnthropicSse(clientRes, "message_stop", { type: "message_stop" });
  clientRes.end();
  logInfo("openai_chat_as_anthropic_stream_complete", { request_id: requestId });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = decodeRequestBody(Buffer.concat(chunks), req.headers["content-encoding"]);
  const text = body.toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "Invalid JSON request body");
  }
}

function decodeRequestBody(buffer, contentEncoding = "") {
  const encodings = String(contentEncoding || "identity")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .reverse();

  let decoded = buffer;
  for (const encoding of encodings) {
    if (encoding === "identity") continue;
    if (encoding === "gzip" || encoding === "x-gzip") {
      decoded = zlib.gunzipSync(decoded);
      continue;
    }
    if (encoding === "br") {
      decoded = zlib.brotliDecompressSync(decoded);
      continue;
    }
    if (encoding === "deflate") {
      decoded = zlib.inflateSync(decoded);
      continue;
    }
    if (encoding === "zstd" && typeof zlib.zstdDecompressSync === "function") {
      decoded = zlib.zstdDecompressSync(decoded);
      continue;
    }
    throw httpError(415, `Unsupported content-encoding: ${encoding}`);
  }
  return decoded;
}

function requestApiKey(req) {
  const auth = req.headers.authorization || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  const apiKey = req.headers["x-api-key"] || "";
  return bearer || apiKey || "";
}

function isConfiguredApiKeySentinel(value) {
  return String(value || "").trim().toLowerCase() === CONFIGURED_API_KEY_SENTINEL;
}

function checkLocalAuth(req, res) {
  if (!GATEWAY_API_KEY) return true;
  const apiKey = requestApiKey(req);
  if (apiKey === GATEWAY_API_KEY || isConfiguredApiKeySentinel(apiKey)) return true;

  sendJson(res, 401, {
    error: {
      type: "unauthorized",
      message: "Invalid local gateway API key",
    },
  });
  return false;
}

function responseHeaders(headers) {
  return {
    "Content-Type": headers.get("content-type") || "application/json; charset=utf-8",
    "Cache-Control": headers.get("cache-control") || "no-cache",
    "Access-Control-Allow-Origin": "*",
  };
}

function responsesSseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  };
}

async function sendUpstreamError(upstream, clientRes) {
  clientRes.writeHead(upstream.status, responseHeaders(upstream.headers));
  clientRes.end(await upstream.text());
}

function sendJson(res, status, body) {
  sendCors(res, status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendPrivateJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendCors(res, status, extraHeaders = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, content-type, content-encoding, x-api-key, anthropic-version, anthropic-beta, x-gateway-client, x-request-id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...extraHeaders,
  });
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

async function consumeSse(stream, onEvent) {
  if (!stream) return;

  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    onEvent(eventName || "message", dataLines.join("\n"));
    eventName = "";
    dataLines = [];
  };

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line === "") {
        flush();
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }

  if (buffer) {
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
    flush();
  }
}

function parseAliases(value) {
  const aliases = {};
  for (const pair of parseList(value)) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    const left = pair.slice(0, index).trim();
    const right = pair.slice(index + 1).trim();
    if (left && right) aliases[left] = right;
  }
  return aliases;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveProjectPath(targetPath) {
  if (!targetPath) return "";
  return path.isAbsolute(targetPath) ? targetPath : path.join(PROJECT_ROOT, targetPath);
}

function resolveUserPath(targetPath) {
  if (!targetPath) return "";
  const expanded = targetPath === "~" || targetPath.startsWith("~/") || targetPath.startsWith("~\\")
    ? path.join(os.homedir(), targetPath.slice(2))
    : targetPath;
  return path.isAbsolute(expanded) ? expanded : path.join(PROJECT_ROOT, expanded);
}

function openAIContentToAnthropicBlocks(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) return [];

  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === "text" && part.text) {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url" && part.image_url?.url) {
      const imageBlock = openAIImagePartToAnthropic(part.image_url.url);
      if (imageBlock) blocks.push(imageBlock);
      continue;
    }
  }
  return blocks;
}

function responseInputContentToAnthropicBlocks(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) return [];

  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    if ((part.type === "input_text" || part.type === "output_text") && part.text) {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "input_image" && part.image_url) {
      const imageBlock = openAIImagePartToAnthropic(part.image_url);
      if (imageBlock) blocks.push(imageBlock);
    }
  }
  return blocks;
}

function responseInputContentToText(content) {
  return responseInputContentToAnthropicBlocks(content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function responseToolOutputToText(output) {
  if (typeof output === "string") return output;
  if (output == null) return "";
  if (Array.isArray(output)) {
    return output.map((item) => {
      if (typeof item === "string") return item;
      return item?.text || JSON.stringify(item);
    }).join("\n");
  }
  return JSON.stringify(output);
}

function responseToolToAnthropic(tool) {
  if (!tool || typeof tool !== "object") return null;
  if (tool.type === "custom") {
    return {
      name: tool.name || "tool",
      description: tool.description || "",
      input_schema: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
        additionalProperties: false,
      },
    };
  }
  if (tool.type && tool.type !== "function") return null;
  const fn = tool.function || tool;
  return {
    name: fn.name || "tool",
    description: fn.description || "",
    input_schema: fn.parameters || fn.input_schema || {
      type: "object",
      properties: {},
    },
  };
}

function collectResponseToolKinds(tools) {
  const kinds = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool?.name) continue;
    if (tool.type === "custom") kinds.set(tool.name, "custom");
    else if (!tool.type || tool.type === "function") kinds.set(tool.name, "function");
  }
  return kinds;
}

function openAIContentToText(content) {
  return openAIContentToAnthropicBlocks(content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function openAIImagePartToAnthropic(url) {
  if (!url || typeof url !== "string") return null;
  const match = url.match(/^data:(.+?);base64,(.+)$/);
  if (match) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: match[1],
        data: match[2],
      },
    };
  }

  return {
    type: "image",
    source: {
      type: "url",
      url,
    },
  };
}

function openAIToolChoiceToAnthropic(toolChoice) {
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto") return { type: "auto" };
    if (toolChoice === "required") return { type: "any" };
    return { type: "auto" };
  }

  if (toolChoice?.type === "function") {
    return {
      type: "tool",
      name: toolChoice.function?.name || toolChoice.name || "tool",
    };
  }

  return { type: "auto" };
}

function anthropicContentToText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("");
}

function anthropicContentToToolCalls(content) {
  if (!Array.isArray(content)) return [];
  let index = 0;
  return content
    .filter((block) => block?.type === "tool_use")
    .map((block) => ({
      index: index++,
      id: block.id || randomUUID(),
      type: "function",
      function: {
        name: block.name || "tool",
        arguments: JSON.stringify(block.input || {}),
      },
    }));
}

function anthropicContentToResponseToolCalls(content, toolKinds = new Map()) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "tool_use")
    .map((block) => {
      const callId = block.id || randomUUID();
      if (toolKinds.get(block.name) === "custom") {
        return {
          id: `fc_${callId}`,
          type: "custom_tool_call",
          call_id: callId,
          name: block.name || "tool",
          input: typeof block.input?.input === "string"
            ? block.input.input
            : responseToolOutputToText(block.input),
        };
      }
      return {
        id: `fc_${callId}`,
        type: "function_call",
        call_id: callId,
        name: block.name || "tool",
        arguments: JSON.stringify(block.input || {}),
      };
    });
}

function anthropicStopReasonToOpenAI(stopReason, hasToolCalls) {
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "tool_use" || hasToolCalls) return "tool_calls";
  return "stop";
}

function writeOpenAISse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeAnthropicSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function getRequestContext(req) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const originalPath = url.pathname;
  const normalized = normalizeClientPath(originalPath);
  const headerClient = normalizeClientName(req.headers["x-gateway-client"]);
  const queryClient = normalizeClientName(url.searchParams.get("client"));
  const inferredClient = inferClientFromUserAgent(req.headers["user-agent"] || "");
  const client = normalized.client || headerClient || queryClient || inferredClient || "unknown";

  return {
    url,
    originalPath,
    path: normalized.path,
    client,
    requestId: req.headers["x-request-id"] || randomUUID(),
  };
}

function normalizeClientPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { client: "", path: "/" };

  const client = normalizeClientName(parts[0]);
  if (!client) return { client: "", path: pathname };

  const rest = parts.slice(1).join("/");
  return { client, path: rest ? `/${rest}` : "/" };
}

function normalizeClientName(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (["code", "claude-code", "claude_code"].includes(text)) return "code";
  if (["desktop", "claude-desktop", "claude_desktop", "claude"].includes(text)) return "desktop";
  if (["codex", "codex-desktop", "codex_desktop"].includes(text)) return "codex";
  return "";
}

function inferClientFromUserAgent(userAgent) {
  const text = userAgent.toLowerCase();
  if (text.includes("codex")) return "codex";
  if (text.includes("claude-code") || text.includes("claude code")) return "code";
  if (text.includes("claude")) return "desktop";
  return "";
}

function logInfo(event, data = {}) {
  logLine({ level: "info", event, ...data });
}

function logError(event, error, context = {}) {
  logLine({
    level: "error",
    event,
    request_id: context.requestId || null,
    client: context.client || null,
    path: context.originalPath || null,
    message: error instanceof Error ? error.message : String(error),
    statusCode: error?.statusCode || null,
  });
}

function logLine(entry) {
  const line = `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`;
  fs.appendFile(LOG_FILE, line, () => {});
}

function loadOfficialCodexCatalogModels() {
  // Prefer Desktop's live cache. It includes newly rolled-out official models
  // (e.g. gpt-5.6-*) that are not yet in `codex debug models --bundled`.
  const fromDesktopCache = loadOfficialCodexModelsFromDesktopCache();
  if (fromDesktopCache.length) return fromDesktopCache;

  try {
    const output = execFileSync("codex", ["debug", "models", "--bundled"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    });
    const parsed = JSON.parse(output);
    const models = Array.isArray(parsed.models) ? parsed.models : [];
    const filtered = models.filter((model) => isBundledOfficialCodexModel(model.slug));
    if (filtered.length) return filtered;
  } catch {
    // Fall through to the hardcoded seed model.
  }

  return [
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Official Codex fallback model",
      visibility: "list",
      supported_in_api: true,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balanced reasoning" },
        { effort: "high", description: "More reasoning" },
      ],
      shell_type: "shell_command",
      input_modalities: ["text"],
    },
  ];
}

function loadOfficialCodexModelsFromDesktopCache() {
  const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
  try {
    if (!fs.existsSync(cachePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8").replace(/^﻿/, ""));
    const models = Array.isArray(parsed.models)
      ? parsed.models
      : Array.isArray(parsed?.data)
        ? parsed.data
        : [];
    return models
      .filter((model) => model && isBundledOfficialCodexModel(model.slug || model.id))
      .map((model) => ({
        ...model,
        slug: model.slug || model.id,
        display_name: model.display_name || model.slug || model.id,
      }));
  } catch {
    return [];
  }
}

function isBundledOfficialCodexModel(slug) {
  return isOfficialCodexModelId(slug);
}

function refreshOfficialCodexCatalogModels() {
  OFFICIAL_CODEX_CATALOG_MODELS = loadOfficialCodexCatalogModels();
  OFFICIAL_CODEX_MODELS = OFFICIAL_CODEX_CATALOG_MODELS.map((model) => ({
    id: model.slug,
    display_name: model.display_name || model.slug,
    owned_by: "openai",
  }));
}

function writeCodexModelCatalog() {
  // Re-read Desktop cache / bundled catalog so newly rolled-out official models
  // show up without restarting the gateway process.
  refreshOfficialCodexCatalogModels();
  CODEX_CATALOG = buildCodexCatalog({
    officialModels: OFFICIAL_CODEX_CATALOG_MODELS,
    endpoints: GATEWAY_CONFIG.clients?.codex?.endpoints || [],
  });
  OFFICIAL_CODEX_MODEL_IDS = CODEX_CATALOG.officialIds;
  CODEX_CUSTOM_MODELS = CODEX_CATALOG.models.filter(
    (model) => !OFFICIAL_CODEX_MODEL_IDS.has(model.slug),
  );

  const models = [
    ...OFFICIAL_CODEX_CATALOG_MODELS,
    ...CODEX_CUSTOM_MODELS,
  ];

  const catalog = {
    generated_at: new Date().toISOString(),
    source: "local-ai-gateway",
    official_source: fs.existsSync(path.join(os.homedir(), ".codex", "models_cache.json"))
      ? "desktop-models-cache"
      : "bundled-or-fallback",
    models,
  };

  fs.mkdirSync(path.dirname(CODEX_MODEL_CATALOG_PATH), { recursive: true });
  fs.writeFileSync(CODEX_MODEL_CATALOG_PATH, JSON.stringify(catalog, null, 2), "utf8");
  _codexModelsDiscoveryCache = null;
  return CODEX_MODEL_CATALOG_PATH;
}

function getOfficialCodexAuth(clientReq) {
  const authHeader = clientReq?.headers?.authorization || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const accessToken = authHeader.slice(7);
    if (accessToken && accessToken !== "dummy") {
      return {
        backend: "chatgpt-codex",
        url: "https://chatgpt.com/backend-api/codex/responses",
        accessToken,
        accountId: clientReq.headers["chatgpt-account-id"] || "",
      };
    }
  }

  if (fs.existsSync(CODEX_AUTH_PATH)) {
    try {
      const auth = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, "utf8"));
      const accessToken = auth?.tokens?.access_token || auth?.access_token || auth?.credentials?.access_token;
      const accountId = auth?.tokens?.account_id || auth?.account_id || "";
      if (accessToken) {
        return {
          backend: "chatgpt-codex",
          url: "https://chatgpt.com/backend-api/codex/responses",
          accessToken,
          accountId,
        };
      }
    } catch {
      // Fall through to OPENAI_API_KEY.
    }
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      backend: "openai",
      url: "https://api.openai.com/v1/responses",
      accessToken: process.env.OPENAI_API_KEY,
      accountId: "",
    };
  }

  return null;
}

function getOfficialCodexImageAuth(clientReq, kind = "generations") {
  const auth = getOfficialCodexAuth(clientReq);
  if (!auth) return null;

  const imagePath = kind === "edits" ? "images/edits" : "images/generations";
  if (auth.backend === "openai") {
    return {
      ...auth,
      url: `https://api.openai.com/v1/${imagePath}`,
    };
  }

  // chatgpt-codex subscription path used by Desktop's built-in image_gen.
  return {
    ...auth,
    url: `https://chatgpt.com/backend-api/codex/${imagePath}`,
  };
}

function officialUpstreamHeaders(clientReq, auth) {
  // Prefer client identity headers when present. Forcing a synthetic CLI
  // originator/UA can cause the chatgpt-codex backend to omit hosted tools
  // such as web_search for Desktop sessions.
  const clientOriginator = firstHeaderValue(clientReq.headers["originator"]);
  const clientUserAgent = firstHeaderValue(clientReq.headers["user-agent"]);
  const clientOpenAiBeta = firstHeaderValue(clientReq.headers["openai-beta"]);
  const clientAccountId = firstHeaderValue(clientReq.headers["chatgpt-account-id"]);

  const headers = {
    "Content-Type": "application/json",
    Accept: firstHeaderValue(clientReq.headers.accept) || "text/event-stream",
    Authorization: `Bearer ${auth.accessToken}`,
    "OpenAI-Beta": clientOpenAiBeta || "responses=experimental",
    originator: clientOriginator || "codex_cli_rs",
    "User-Agent": clientUserAgent || "codex_cli_rs/0.0.0",
  };

  const accountId = clientAccountId || auth.accountId || "";
  if (accountId) {
    headers["chatgpt-account-id"] = accountId;
  }

  // Preserve a few optional client headers used by newer Desktop builds.
  for (const name of [
    "x-codex-client-version",
    "x-codex-session-id",
    "x-request-id",
    "openai-organization",
    "openai-project",
  ]) {
    const value = firstHeaderValue(clientReq.headers[name]);
    if (value) headers[name] = value;
  }

  return headers;
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0] || "";
  return value ? String(value) : "";
}

// Desktop under model_provider=custom often omits hosted web_search.
// Default-on inject restores it on the official path only.
//
// Never default-inject image_generation: Codex Desktop already exposes
// function image_gen.imagegen (sometimes only as a session-side capability,
// not always listed in body.tools). The chatgpt-codex backend rejects both:
//   Function 'image_gen.imagegen' conflicts with a hosted tool
// Disable all inject with CODEX_INJECT_HOSTED_TOOLS_DISABLED=1
// (or CODEX_INJECT_WEB_SEARCH=0). Optional CODEX_INJECT_IMAGE_GENERATION=1
// only for non-Desktop clients when no image function is present.
function isOfficialHostedToolsInjectEnabled() {
  if (isTruthy(process.env.CODEX_INJECT_HOSTED_TOOLS_DISABLED)) return false;
  if (Object.prototype.hasOwnProperty.call(process.env, "CODEX_INJECT_WEB_SEARCH")) {
    return isTruthy(process.env.CODEX_INJECT_WEB_SEARCH);
  }
  return true;
}

function collectToolDescriptors(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    const type = String(tool?.type || "").toLowerCase();
    const name = String(
      tool?.name || tool?.function?.name || "",
    ).toLowerCase();
    return { type, name, raw: tool };
  });
}

function isCodexDesktopRequest(clientReq) {
  const originator = firstHeaderValue(clientReq?.headers?.["originator"]).toLowerCase();
  const userAgent = firstHeaderValue(clientReq?.headers?.["user-agent"]).toLowerCase();
  return originator.includes("desktop") || userAgent.includes("codex desktop");
}

function isImageFunctionTool(descriptor) {
  const blob = `${descriptor.type} ${descriptor.name}`;
  return (
    blob.includes("image_gen")
    || blob.includes("imagegen")
    || blob.includes("generate_image")
  );
}

function isHostedImageGenerationTool(descriptor) {
  return (
    descriptor.type === "image_generation"
    || descriptor.name === "image_generation"
  );
}

function hasConflictingTool(descriptors, kind) {
  return descriptors.some((descriptor) => {
    const blob = `${descriptor.type} ${descriptor.name}`;
    if (kind === "web_search") {
      return blob.includes("web_search") || blob.includes("websearch");
    }
    if (kind === "image_generation") {
      // Function image_gen.* and hosted image_generation cannot coexist.
      return isImageFunctionTool(descriptor) || isHostedImageGenerationTool(descriptor);
    }
    return false;
  });
}

function stripConflictingHostedImageGeneration(tools, descriptors) {
  if (!descriptors.some(isImageFunctionTool)) return tools;
  return tools.filter((tool, index) => !isHostedImageGenerationTool(descriptors[index]));
}

function maybeInjectOfficialHostedTools(body, clientReq = null) {
  const existing = Array.isArray(body?.tools) ? body.tools : [];
  const descriptors = collectToolDescriptors(existing);
  // If the client already listed image_gen.*, drop any hosted image_generation
  // it may also have included (or that a prior hop injected).
  const sanitized = stripConflictingHostedImageGeneration(existing, descriptors);
  const strippedImageGeneration = sanitized.length !== existing.length;
  const nextDescriptors = strippedImageGeneration
    ? collectToolDescriptors(sanitized)
    : descriptors;

  if (!isOfficialHostedToolsInjectEnabled()) {
    if (!strippedImageGeneration) {
      return { body, injected: false, injected_types: [], stripped_types: [] };
    }
    return {
      body: { ...body, tools: sanitized },
      injected: false,
      injected_types: [],
      stripped_types: ["image_generation"],
    };
  }

  const toAdd = [];

  if (!hasConflictingTool(nextDescriptors, "web_search")) {
    toAdd.push({ type: "web_search" });
  }

  // Image generation is opt-in, never for Desktop, and never when image_gen.*
  // function tools (or hosted image_generation) are already present.
  const allowImageInject =
    isTruthy(process.env.CODEX_INJECT_IMAGE_GENERATION)
    && !isCodexDesktopRequest(clientReq)
    && !hasConflictingTool(nextDescriptors, "image_generation");
  if (allowImageInject) {
    toAdd.push({ type: "image_generation" });
  }

  if (!toAdd.length && !strippedImageGeneration) {
    return { body, injected: false, injected_types: [], stripped_types: [] };
  }

  return {
    body: {
      ...body,
      tools: [...sanitized, ...toAdd],
    },
    injected: toAdd.length > 0,
    injected_types: toAdd.map((tool) => tool.type),
    stripped_types: strippedImageGeneration ? ["image_generation"] : [],
  };
}

// Back-compat alias for any external callers / older patches.
const maybeInjectOfficialWebSearchTools = maybeInjectOfficialHostedTools;

function normalizeOfficialCodexBody(body, backend) {
  const normalized = { ...body };

  if (!Object.prototype.hasOwnProperty.call(normalized, "instructions")) {
    normalized.instructions = "";
  }

  // The chatgpt-codex backend requires store=false and rejects id references
  // it did not persist. Strip inline `rs_*` reasoning items so multi-turn does
  // not re-inject 404-bait ids. The public openai backend (api.openai.com)
  // keeps store=true so multi-turn state is preserved.
  if (backend === "chatgpt-codex") {
    normalized.store = false;
    normalized.input = stripEphemeralItemReferences(normalized.input);
  } else {
    normalized.store = true;
  }

  if (typeof normalized.input === "string") {
    normalized.input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: normalized.input }],
      },
    ];
  }

  if (backend === "chatgpt-codex") {
    delete normalized.max_output_tokens;
  }

  return normalized;
}

// Remove only chatgpt-codex ephemeral reasoning snapshots that 404 when
// store=false. Never drop tool calls/results or web/image hosted tool items.
function stripEphemeralItemReferences(input) {
  if (!Array.isArray(input)) return input;
  return input.filter((item) => {
    if (!item || typeof item !== "object") return true;
    const type = String(item.type || "");
    const id = String(item.id || "");

    // Always keep executable tool history.
    if (
      /function_call|custom_tool|tool_result|tool_output|web_search|image_generation|mcp_tool|tool_search|patch_apply|shell/i
        .test(type)
    ) {
      return true;
    }

    // Drop pure reasoning snapshots / dangling references only.
    if (type === "reasoning") return false;
    if (type === "item_reference") return false;
    if (/^rs_/i.test(id) && (!type || type === "reasoning")) return false;
    return true;
  });
}

function syncClaudeThirdPartyInferenceConfig(config) {
  if (CLAUDE_3P_SYNC_DISABLED) {
    return { updated: false, reason: "disabled" };
  }

  try {
    const target = findClaudeThirdPartyConfigPath();
    if (!target.path) {
      return { updated: false, reason: target.reason };
    }

    const existingConfig = JSON.parse(fs.readFileSync(target.path, "utf8"));
    const endpoints = selectExposedEndpoints(config.clients?.desktop?.endpoints || []);
    const inferenceModels = endpoints.length
      ? buildClaudeInferenceModels(
          endpoints,
          existingConfig.inferenceModels,
        )
      : Array.isArray(existingConfig.inferenceModels)
        ? existingConfig.inferenceModels
        : [];

    const gatewayBaseUrl = buildClaudeThirdPartyGatewayBaseUrl(config);
    // Always pin Desktop 3p credentials to this local gateway.
    // "all" is the gateway's configured-key sentinel (see isConfiguredApiKeySentinel).
    const nextConfig = {
      ...existingConfig,
      inferenceGatewayBaseUrl: gatewayBaseUrl,
      inferenceGatewayApiKey: CONFIGURED_API_KEY_SENTINEL,
      inferenceModels,
      inferenceProvider: "gateway",
      inferenceCredentialKind: "static",
    };

    const previous = JSON.stringify(existingConfig);
    const next = JSON.stringify(nextConfig);
    if (previous === next) {
      return {
        updated: false,
        reason: "already-in-sync",
        path: target.path,
        models: inferenceModels.length,
        endpoints: endpoints.map((endpoint) => endpoint.name || endpoint.id),
      };
    }

    fs.writeFileSync(target.path, `${JSON.stringify(nextConfig, null, 2)}\n`);
    logInfo("claude3p_config_synced", {
      path: target.path,
      gateway_base_url: gatewayBaseUrl,
      gateway_api_key: CONFIGURED_API_KEY_SENTINEL,
      endpoints: endpoints.map((endpoint) => endpoint.name || endpoint.id),
      models: inferenceModels.length,
    });
    return {
      updated: true,
      path: target.path,
      models: inferenceModels.length,
      endpoints: endpoints.map((endpoint) => endpoint.name || endpoint.id),
      gatewayBaseUrl,
    };
  } catch (error) {
    logError("claude3p_config_sync_failed", error);
    return {
      updated: false,
      reason: "sync-failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function findClaudeThirdPartyConfigPath() {
  if (CLAUDE_3P_CONFIG_FILE) {
    const explicitPath = resolveUserPath(CLAUDE_3P_CONFIG_FILE);
    return fs.existsSync(explicitPath)
      ? { path: explicitPath }
      : { path: "", reason: "explicit-config-file-not-found" };
  }

  const libraryPath = resolveClaudeThirdPartyConfigLibraryPath();
  if (!libraryPath || !fs.existsSync(libraryPath)) {
    return { path: "", reason: "config-library-not-found" };
  }

  const metaPath = path.join(libraryPath, "_meta.json");
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const appliedId = meta.appliedId || meta.entries?.[0]?.id || "";
    if (appliedId) {
      const appliedPath = path.join(libraryPath, `${appliedId}.json`);
      return fs.existsSync(appliedPath)
        ? { path: appliedPath }
        : { path: "", reason: "applied-config-file-not-found" };
    }
  }

  const configFiles = fs
    .readdirSync(libraryPath)
    .filter((name) => name.endsWith(".json") && name !== "_meta.json");

  if (configFiles.length === 1) {
    return { path: path.join(libraryPath, configFiles[0]) };
  }

  return { path: "", reason: "applied-config-not-found" };
}

function resolveClaudeThirdPartyConfigLibraryPath() {
  if (CLAUDE_3P_CONFIG_LIBRARY) return resolveUserPath(CLAUDE_3P_CONFIG_LIBRARY);
  return defaultClaudeThirdPartyConfigLibraryPath(process.platform);
}

function defaultClaudeThirdPartyConfigLibraryPath(platform) {
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Claude-3p", "configLibrary");
  }

  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude-3p", "configLibrary");
  }

  if (platform === "linux") {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    return path.join(configHome, "Claude-3p", "configLibrary");
  }

  return "";
}

function buildClaudeThirdPartyGatewayBaseUrl(config) {
  const serverConfig = config.server || {};
  const host = serverConfig.host && serverConfig.host !== "0.0.0.0"
    ? serverConfig.host
    : "127.0.0.1";
  const port = Number(serverConfig.port) || LISTEN_PORT || 8787;
  return `http://${host}:${port}/desktop`;
}

function syncClaudeCodeSettingsIfEnabled(config) {
  if (CLAUDE_CODE_SYNC_DISABLED) {
    return { updated: false, reason: "disabled" };
  }
  return syncClaudeCodeSettings({
    config,
    ...(CLAUDE_CODE_SETTINGS_FILE
      ? { settingsPath: resolveUserPath(CLAUDE_CODE_SETTINGS_FILE) }
      : {}),
    authToken: CONFIGURED_API_KEY_SENTINEL,
    gatewayBaseUrl: `http://${LISTEN_HOST === "0.0.0.0" ? "127.0.0.1" : LISTEN_HOST}:${LISTEN_PORT}/code`,
  });
}

function reloadGatewayConfig({ reloadFiles = true } = {}) {
  if (reloadFiles) {
    GATEWAY_STATE = loadGatewayState({
      configPath: GATEWAY_CONFIG_FILE,
      secretsPath: GATEWAY_SECRETS_FILE,
      officialCodexIds: OFFICIAL_CODEX_MODEL_IDS,
    });
    GATEWAY_CONFIG = GATEWAY_STATE.config;
    GATEWAY_SECRETS = GATEWAY_STATE.secrets;
  }
  CLAUDE_CODE_MODEL_ROUTES = buildClaudeCodeModelRoutes(
    GATEWAY_CONFIG.clients?.code?.endpoints || [],
  );
  const _endpoints = [
    ...(GATEWAY_CONFIG.clients?.code?.endpoints || []),
    ...(GATEWAY_CONFIG.clients?.desktop?.endpoints || []),
    ...(GATEWAY_CONFIG.clients?.claude?.endpoints || []),
    ...(GATEWAY_CONFIG.clients?.codex?.endpoints || [])
  ].filter((endpoint) => endpoint?.purpose !== "vision_fallback");
  EXPOSED_MODELS = [...new Set(_endpoints.flatMap(ep => [
    ...(ep.models || []),
    ...Object.keys(ep.model_mapping || {})
  ]))];
  if (EXPOSED_MODELS.length === 0) {
    EXPOSED_MODELS.push(...parseList(process.env.EXPOSED_MODELS || process.env.MODEL_LIST || "claude-sonnet"));
  }

  // Rebuild Codex catalog from the latest config + current Desktop model cache,
  // then refresh the Desktop model_catalog_json file.
  if (CODEX_WRITE_MODEL_CATALOG) {
    try {
      writeCodexModelCatalog();
    } catch (error) {
      console.warn(`Codex model catalog write failed: ${error.message || error}`);
      refreshOfficialCodexCatalogModels();
      CODEX_CATALOG = buildCodexCatalog({
        officialModels: OFFICIAL_CODEX_CATALOG_MODELS,
        endpoints: GATEWAY_CONFIG.clients?.codex?.endpoints || [],
      });
      OFFICIAL_CODEX_MODEL_IDS = CODEX_CATALOG.officialIds;
      CODEX_CUSTOM_MODELS = CODEX_CATALOG.models.filter(
        (model) => !OFFICIAL_CODEX_MODEL_IDS.has(model.slug),
      );
      _codexModelsDiscoveryCache = null;
    }
  } else {
    refreshOfficialCodexCatalogModels();
    CODEX_CATALOG = buildCodexCatalog({
      officialModels: OFFICIAL_CODEX_CATALOG_MODELS,
      endpoints: GATEWAY_CONFIG.clients?.codex?.endpoints || [],
    });
    OFFICIAL_CODEX_MODEL_IDS = CODEX_CATALOG.officialIds;
    CODEX_CUSTOM_MODELS = CODEX_CATALOG.models.filter(
      (model) => !OFFICIAL_CODEX_MODEL_IDS.has(model.slug),
    );
    _codexModelsDiscoveryCache = null;
  }
}

function parseJsonMaybe(value) {
  if (typeof value !== "string") return value && typeof value === "object" ? value : null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function intEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimRight(value, char) {
  let result = value;
  while (result.endsWith(char)) result = result.slice(0, -1);
  return result;
}

function loadDotEnv() {
  try {
    const envPath = path.join(PROJECT_ROOT, ".env");
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] == null) process.env[key] = value;
    }
  } catch {
    // .env loading is a convenience; environment variables still work without it.
  }
}

function enableNodeEnvProxy() {
  ensureOfficialCodexProxyEnv();
  const hasProxy =
    Boolean(process.env.HTTPS_PROXY) ||
    Boolean(process.env.HTTP_PROXY) ||
    Boolean(process.env.ALL_PROXY) ||
    Boolean(process.env.https_proxy) ||
    Boolean(process.env.http_proxy) ||
    Boolean(process.env.all_proxy);

  if (hasProxy && process.env.NODE_USE_ENV_PROXY == null) {
    process.env.NODE_USE_ENV_PROXY = "1";
  }
}

// Prefer explicit env, then the same default local Clash port used by Grok.
function ensureOfficialCodexProxyEnv() {
  if (isTruthy(process.env.OFFICIAL_CODEX_PROXY_DISABLED)) return;

  const existing =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.all_proxy ||
    "";

  if (existing) {
    if (process.env.NODE_USE_ENV_PROXY == null) {
      process.env.NODE_USE_ENV_PROXY = "1";
    }
    return;
  }

  // Use env/literal only: this runs from enableNodeEnvProxy() at module top,
  // before const GROK_DEFAULT_PROXY is initialized (TDZ).
  const fallback =
    process.env.OFFICIAL_CODEX_PROXY ||
    process.env.GROK_PROXY ||
    "http://127.0.0.1:7897";

  if (!fallback) return;
  process.env.HTTPS_PROXY = fallback;
  process.env.HTTP_PROXY ||= fallback;
  process.env.NODE_USE_ENV_PROXY ||= "1";
}



async function readText(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

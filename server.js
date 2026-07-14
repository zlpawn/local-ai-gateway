import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync, exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { URL, fileURLToPath } from "node:url";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

loadDotEnv();
enableNodeEnvProxy();

const ENV_PORT = intEnv("GATEWAY_PORT", intEnv("PORT", 0));
const ENV_HOST = process.env.GATEWAY_HOST || process.env.HOST || "";
const REQUEST_TIMEOUT_MS = intEnv("REQUEST_TIMEOUT_MS", 120000);
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || "";
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
let GATEWAY_CONFIG = loadGatewayConfig(GATEWAY_CONFIG_FILE);
const LISTEN_HOST = ENV_HOST || GATEWAY_CONFIG.server?.host || "127.0.0.1";
const LISTEN_PORT = ENV_PORT || Number(GATEWAY_CONFIG.server?.port) || 8787;
const _allEndpoints = [
  ...(GATEWAY_CONFIG.clients?.code?.endpoints || []),
  ...(GATEWAY_CONFIG.clients?.desktop?.endpoints || []),
  ...(GATEWAY_CONFIG.clients?.claude?.endpoints || []),
  ...(GATEWAY_CONFIG.clients?.codex?.endpoints || [])
];
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
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_AUTH_PATH = path.join(CODEX_HOME, "auth.json");
const CODEX_MODEL_CATALOG_PATH =
  process.env.CODEX_MODEL_CATALOG_PATH || path.join(CODEX_HOME, "gateway-model-catalog.json");
const CODEX_WRITE_MODEL_CATALOG = isTruthy(process.env.CODEX_WRITE_MODEL_CATALOG);
const OFFICIAL_CODEX_CATALOG_MODELS = loadOfficialCodexCatalogModels();
const OFFICIAL_CODEX_MODELS = OFFICIAL_CODEX_CATALOG_MODELS.map((model) => ({
  id: model.slug,
  display_name: model.display_name || model.slug,
  owned_by: "openai",
}));
const OFFICIAL_CODEX_MODEL_IDS = new Set(OFFICIAL_CODEX_MODELS.map((model) => model.id));
const CODEX_CUSTOM_MODELS = buildCodexCustomModels(OFFICIAL_CODEX_CATALOG_MODELS[0] || null);

if (CODEX_WRITE_MODEL_CATALOG) {
  writeCodexModelCatalog();
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

  if (reqPath === "/v1/config/save" && req.method === "POST") {
    if (!checkLocalAuth(req, res)) return;
    try {
      const newConfig = JSON.parse(await readText(req));
      let currentConfig = {};
      if (fs.existsSync(GATEWAY_CONFIG_FILE)) {
         currentConfig = JSON.parse(fs.readFileSync(GATEWAY_CONFIG_FILE, "utf8"));
      }
      const mergedConfig = { ...currentConfig, server: newConfig.server, clients: newConfig.clients };
      fs.writeFileSync(GATEWAY_CONFIG_FILE, JSON.stringify(mergedConfig, null, 2));
      reloadGatewayConfig();
      sendJson(res, 200, { success: true });
    } catch(e) {
      sendJson(res, 500, { error: e.message });
    }
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
    sendJson(res, 200, context.client === "codex" ? codexModelDiscovery(context.client) : modelDiscovery(context.client));
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
  const upstream =
    route.provider?.type === "openai-chat"
      ? await fetchConfiguredOpenAI(route.provider, "/chat/completions", upstreamBody, clientReq)
      : route.provider
        ? await fetchConfiguredAnthropic(route.provider, upstreamBody, clientReq)
        : route.kind === "official"
          ? await fetchOfficialAnthropic(upstreamBody, clientReq)
          : await fetchArkAnthropic(upstreamBody, clientReq);
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

  const route = resolveConfiguredModel(requestedModel, ["anthropic", "openai-chat", "openai-responses"], context.client);
  const resolvedModel = route?.upstream_model || resolveModel(requestedModel);
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

  const upstream =
    route?.provider?.type === "anthropic"
      ? await fetchConfiguredAnthropic(route.provider, upstreamBody, clientReq)
      : route?.provider?.type === "openai-responses"
        ? await fetchConfiguredOpenAI(route.provider, "/responses", upstreamBody, clientReq)
        : route?.provider
          ? await fetchConfiguredOpenAI(route.provider, "/chat/completions", upstreamBody, clientReq)
          : await fetchArkOpenAI("/chat/completions", upstreamBody, clientReq);
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

async function forwardOpenAIResponses(body, clientReq, clientRes, context) {
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
    await proxyOfficialCodexResponse(body, clientReq, clientRes, context);
    return;
  }

  const route = resolveConfiguredModel(requestedModel, ["openai-chat", "openai-responses"], context.client);
  const resolvedModel = route?.upstream_model || resolveModel(requestedModel);
  const upstreamBody =
    route?.provider?.type === "openai-chat"
      ? openAIResponsesToChatCompletions(body, resolvedModel)
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

  const upstream =
    route?.provider?.type === "openai-chat"
      ? await fetchConfiguredOpenAI(route.provider, "/chat/completions", upstreamBody, clientReq)
      : route?.provider
        ? await fetchConfiguredOpenAI(route.provider, "/responses", upstreamBody, clientReq)
        : await fetchArkOpenAI("/responses", upstreamBody, clientReq);
  logInfo("openai_responses_response", {
    request_id: context.requestId,
    client: context.client,
    status: upstream.status,
    provider: route?.provider?.id || null,
    translated_to: route?.provider?.type === "openai-chat" ? "chat_completions" : null,
  });

  if (route?.provider?.type === "openai-chat") {
    if (body.stream) {
      await streamOpenAIChatAsOpenAIResponse(upstream, clientRes, requestedModel, context.requestId);
    } else {
      await sendOpenAIChatAsOpenAIResponse(upstream, clientRes, requestedModel);
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

async function proxyOfficialCodexResponse(body, clientReq, clientRes, context) {
  const auth = getOfficialCodexAuth(clientReq);
  if (!auth) {
    throw httpError(
      401,
      "Official Codex auth not found. Sign in to Codex locally or set OPENAI_API_KEY for official model routing.",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstream = await fetch(auth.url, {
      method: "POST",
      headers: officialUpstreamHeaders(clientReq, auth),
      body: JSON.stringify(normalizeOfficialCodexBody(body, auth.backend)),
      signal: controller.signal,
    });

    logInfo("openai_responses_response", {
      request_id: context.requestId,
      client: context.client,
      status: upstream.status,
      route: "official",
      backend: auth.backend,
    });

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
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "Timed out calling official Codex backend"
      : `Failed to call official Codex backend: ${error.message || error}`;
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

  const pathname = parsed.pathname;
  if (pathname === "" || pathname === "/") {
    return trimmed;
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

async function fetchArkOpenAI(path, body, clientReq) {
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

async function fetchConfiguredOpenAI(provider, endpointPath, body, clientReq) {
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
        signal: controller.signal,
      });

      if (res.status === 401 || res.status === 403) {
        const fallbackKey = getConfiguredProviderApiKey(provider);
        if (fallbackKey && fallbackKey !== upstreamApiKey) {
          logInfo("api_key_fallback", { provider: provider.id, original_status: res.status });
          res = await fetch(url, {
            method: "POST",
            headers: providerHeaders(provider, fallbackKey),
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
  const auth = req.headers.authorization || "";
  let passedKey = "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    passedKey = auth.slice(7);
  } else if (req.headers["x-api-key"]) {
    passedKey = req.headers["x-api-key"];
  }

  const isGatewayAuthKey = process.env.GATEWAY_API_KEY && passedKey === process.env.GATEWAY_API_KEY;

  if (passedKey && !isGatewayAuthKey) {
    return passedKey;
  }

  return getConfiguredProviderApiKey(provider);
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
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7);
  return req.headers["x-api-key"] || "";
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

  for (const id of EXPOSED_MODELS) {
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
  return {
    ...GATEWAY_CONFIG,
    config_file: fs.existsSync(GATEWAY_CONFIG_FILE) ? GATEWAY_CONFIG_FILE : null,
  };
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

function codexModelDiscovery(client = 'codex') {
  const now = Math.floor(Date.now() / 1000);
  const merged = new Map();

  for (const model of OFFICIAL_CODEX_MODELS) {
    merged.set(model.id, {
      id: model.id,
      object: "model",
      created: now,
      owned_by: model.owned_by || "openai",
      display_name: model.display_name || model.id,
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
        messages.push(converted);
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

  return upstreamBody;
}

function openAIResponsesToChatCompletions(body, resolvedModel) {
  const messages = [];

  if (body.instructions) {
    messages.push({ role: "system", content: String(body.instructions) });
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const converted = openAIResponseInputToChatMessage(message);
      if (converted) messages.push(converted);
    }
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      const converted = openAIResponseInputToChatMessage(item);
      if (converted) messages.push(converted);
    }
  } else if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  }

  const upstreamBody = {
    model: resolvedModel,
    messages: messages.length ? messages : [{ role: "user", content: "" }],
    stream: Boolean(body.stream),
  };

  if (body.max_output_tokens != null) upstreamBody.max_tokens = body.max_output_tokens;
  else if (body.max_tokens != null) upstreamBody.max_tokens = body.max_tokens;
  if (body.temperature != null) upstreamBody.temperature = body.temperature;
  if (body.top_p != null) upstreamBody.top_p = body.top_p;
  if (body.stop != null) upstreamBody.stop = body.stop;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    upstreamBody.tools = body.tools.map(responseToolToChatTool).filter(Boolean);
  }
  if (body.tool_choice != null) upstreamBody.tool_choice = body.tool_choice;

  return upstreamBody;
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
        role: "user",
        content: [{ type: "input_text", text: `Tool result ${message.tool_call_id || ""}:\n${text}` }],
      });
      continue;
    }
    input.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: [
        {
          type: message.role === "assistant" ? "output_text" : "input_text",
          text,
        },
      ],
    });
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

  return upstreamBody;
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

function openAIResponseInputToChatMessage(item) {
  if (typeof item === "string") return { role: "user", content: item };
  if (!item || typeof item !== "object") return null;

  if (item.type === "function_call") {
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: item.call_id || item.id || randomUUID(),
          type: "function",
          function: {
            name: item.name || "tool",
            arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
          },
        },
      ],
    };
  }

  if (item.type === "function_call_output") {
    return {
      role: "tool",
      tool_call_id: item.call_id || item.id || "tool",
      content: typeof item.output === "string" ? item.output : JSON.stringify(item.output || ""),
    };
  }

  const role = item.role === "assistant" || item.role === "system" || item.role === "tool" ? item.role : "user";
  if (role === "tool") {
    return {
      role: "tool",
      tool_call_id: item.tool_call_id || item.call_id || "tool",
      content: responseInputContentToText(item.content),
    };
  }

  return {
    role,
    content: responseInputContentToOpenAIChatContent(item.content),
  };
}

function responseInputContentToOpenAIChatContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const part of content) {
    if (!part) continue;
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && part.text != null) {
      parts.push({ type: "text", text: String(part.text) });
      continue;
    }
    if ((part.type === "input_image" || part.type === "image_url") && (part.image_url || part.url)) {
      parts.push({ type: "image_url", image_url: { url: part.image_url || part.url } });
    }
  }

  if (parts.length === 0) return responseInputContentToText(content);
  if (parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("");
  return parts;
}

function responseToolToChatTool(tool) {
  if (!tool || typeof tool !== "object") return null;
  if (tool.type === "function" && tool.function) return tool;
  if (tool.type === "function") {
    return {
      type: "function",
      function: {
        name: tool.name || "tool",
        description: tool.description || "",
        parameters: tool.parameters || tool.input_schema || { type: "object", properties: {} },
      },
    };
  }
  return tool.function ? { type: "function", function: tool.function } : null;
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

function anthropicToOpenAIResponse(upstreamJson, requestedModel) {
  const text = anthropicContentToText(upstreamJson.content);
  const outputMessage = {
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
  };

  return {
    id: upstreamJson.id || `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: requestedModel || upstreamJson.model || "custom-model",
    status: "completed",
    output: [outputMessage],
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
  const text = typeof message.content === "string" ? message.content : openAIContentToText(message.content);

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

function openAIChatFinishReasonToAnthropic(finishReason, content = []) {
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "tool_calls" || content.some((block) => block.type === "tool_use")) return "tool_use";
  return "end_turn";
}

async function sendOpenAIChatAsOpenAIResponse(upstream, clientRes, requestedModel) {
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
  clientRes.end(JSON.stringify(openAIChatCompletionToResponse(upstreamJson, requestedModel)));
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
  const configured = resolveConfiguredModel(requestedModel, ["anthropic", "openai-chat"], client);
  if (configured) {
    if (!["anthropic", "openai-chat"].includes(configured.provider.type)) {
      throw httpError(
        400,
        `Model ${requestedModel} is configured for provider ${configured.provider.id} (${configured.provider.type}), which cannot serve Anthropic Messages requests yet.`,
      );
    }
    return {
      kind: configured.provider.id,
      model: configured.upstream_model,
      provider: configured.provider,
      config: configured.model,
    };
  }

  if (isOfficialClaudeModel(requestedModel)) {
    return { kind: "official", model: requestedModel };
  }

  return { kind: "volcengine", model: ARK_MODEL || requestedModel };
}

function resolveConfiguredModel(requestedModel, allowedTypes = [], client = null) {
  if (!requestedModel) return null;
  const text = String(requestedModel);
  const allowed = new Set(allowedTypes);

  const clientsToCheck = client ? [client] : ["code", "desktop", "claude", "codex"];

  for (const c of clientsToCheck) {
    const endpoints = GATEWAY_CONFIG.clients?.[c]?.endpoints || [];
    for (const ep of endpoints) {
      if (allowed.size === 0 || allowed.has(ep.type)) {
        let targetModel = text;
        if (ep.model_mapping && ep.model_mapping[text]) {
          targetModel = ep.model_mapping[text];
        }

        if (ep.models?.includes(targetModel) || ep.name === text || ep.model_mapping?.[text]) {
          return {
             model: { id: text, display_name: text, upstream_model: targetModel, aliases: [] },
             provider: { id: ep.name, type: ep.type, base_url: ep.base_url, api_key: ep.api_key, auth: "bearer" },
             upstream_model: targetModel
          };
        }
      }
    }
  }

  // Second pass: fallback to default endpoint
  for (const c of clientsToCheck) {
    const endpoints = GATEWAY_CONFIG.clients?.[c]?.endpoints || [];
    for (const ep of endpoints) {
      if (allowed.size === 0 || allowed.has(ep.type)) {
        if (ep.is_default) {
          let targetModel = text;
          if (ep.model_mapping && ep.model_mapping[text]) {
            targetModel = ep.model_mapping[text];
          }
          return {
             model: { id: text, display_name: text, upstream_model: targetModel, aliases: [] },
             provider: { id: ep.name, type: ep.type, base_url: ep.base_url, api_key: ep.api_key, auth: "bearer" },
             upstream_model: targetModel
          };
        }
      }
    }
  }

  return null;
}

function isOfficialClaudeModel(model) {
  if (!model) return false;
  const text = String(model);
  const route = resolveConfiguredModel(text, ["anthropic", "openai-chat"], "claude");
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
  return /^gpt-|^o\d/i.test(String(model));
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

async function streamAnthropicAsOpenAIResponse(upstream, clientRes, requestedModel, requestId) {
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

  const responseId = `resp_${Date.now()}`;
  const outputIndex = 0;
  let itemStarted = false;

  clientRes.write(`event: response.created\n`);
  clientRes.write(
    `data: ${JSON.stringify({ type: "response.created", response: { id: responseId, model: requestedModel || "custom-model", object: "response", status: "in_progress" } })}\n\n`,
  );

  await consumeSse(upstream.body, (eventName, payloadText) => {
    const payload = parseJsonMaybe(payloadText) || {};

    if (!itemStarted && (eventName === "message_start" || eventName === "content_block_start")) {
      itemStarted = true;
      clientRes.write("event: response.output_item.added\n");
      clientRes.write(
        `data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: outputIndex,
          item: {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: [],
          },
        })}\n\n`,
      );
    }

    if (eventName === "content_block_delta" && payload.delta?.type === "text_delta") {
      clientRes.write("event: response.output_text.delta\n");
      clientRes.write(
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          output_index: outputIndex,
          delta: payload.delta.text || "",
        })}\n\n`,
      );
    }
  });

  clientRes.write("event: response.completed\n");
  clientRes.write(
    `data: ${JSON.stringify({ type: "response.completed", response: { id: responseId, object: "response", model: requestedModel || "custom-model", status: "completed" } })}\n\n`,
  );
  clientRes.end();
  logInfo("openai_responses_stream_complete", { request_id: requestId });
}

async function streamOpenAIChatAsOpenAIResponse(upstream, clientRes, requestedModel, requestId) {
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

  const responseId = `resp_${Date.now()}`;
  const messageId = `msg_${Date.now()}`;
  const outputIndex = 0;
  let itemStarted = false;

  clientRes.write("event: response.created\n");
  clientRes.write(
    `data: ${JSON.stringify({
      type: "response.created",
      response: { id: responseId, model: requestedModel || "custom-model", object: "response", status: "in_progress" },
    })}\n\n`,
  );

  const ensureItemStarted = () => {
    if (itemStarted) return;
    itemStarted = true;
    clientRes.write("event: response.output_item.added\n");
    clientRes.write(
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { id: messageId, type: "message", role: "assistant", content: [] },
      })}\n\n`,
    );
  };

  await consumeSse(upstream.body, (_eventName, payloadText) => {
    if (payloadText === "[DONE]") return;
    const payload = parseJsonMaybe(payloadText) || {};
    const choice = payload.choices?.[0] || {};
    const delta = choice.delta || {};

    if (delta.content) {
      ensureItemStarted();
      clientRes.write("event: response.output_text.delta\n");
      clientRes.write(
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          output_index: outputIndex,
          delta: delta.content,
        })}\n\n`,
      );
    }
  });

  clientRes.write("event: response.completed\n");
  clientRes.write(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: { id: responseId, object: "response", model: requestedModel || "custom-model", status: "completed" },
    })}\n\n`,
  );
  clientRes.end();
  logInfo("openai_chat_as_responses_stream_complete", { request_id: requestId });
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
    const choice = payload.choices?.[0] || {};
    const delta = choice.delta || {};

    if (choice.finish_reason) {
      finishReason = openAIChatFinishReasonToAnthropic(choice.finish_reason);
    }

    if (delta.content) {
      ensureTextBlock();
      sawText = true;
      writeAnthropicSse(clientRes, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta.content },
      });
    }
  });

  if (!blockStarted) ensureTextBlock();
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

function checkLocalAuth(req, res) {
  if (!GATEWAY_API_KEY) return true;
  const auth = req.headers.authorization || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  const apiKey = req.headers["x-api-key"] || "";
  if (bearer === GATEWAY_API_KEY || apiKey === GATEWAY_API_KEY) return true;

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

function sendJson(res, status, body) {
  sendCors(res, status, {
    "Content-Type": "application/json; charset=utf-8",
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
    type: "text",
    text: url,
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

function buildCodexCustomModels(referenceModel) {
  const seen = new Set();
  const models = [];

  const endpoints = GATEWAY_CONFIG.clients?.codex?.endpoints || [];
  for (const ep of endpoints) {
    if (!["openai-chat", "openai-responses"].includes(ep.type)) continue;
    const epModels = [
      ...(ep.models || []),
      ...Object.keys(ep.model_mapping || {})
    ];
    for (const id of epModels) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push(buildCodexCustomModel(id, displayNameForClaudeModel(id) || id, referenceModel));
    }
  }

  return models;
}

function buildCodexCustomModel(id, displayName, referenceModel) {
  const base = referenceModel ? JSON.parse(JSON.stringify(referenceModel)) : {};
  delete base.model_messages;
  base.instructions_variables = {};

  return {
    ...base,
    slug: id,
    display_name: displayName,
    description: `${id} via Volcengine Ark gateway.`,
    visibility: "list",
    supported_in_api: true,
    priority: 1000,
    input_modalities: ["text"],
    owned_by: "volcengine",
    base_instructions: "You are Codex, a coding agent. Follow the active system and developer instructions.",
  };
}

function loadOfficialCodexCatalogModels() {
  try {
    const output = execFileSync("codex", ["debug", "models", "--bundled"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    });
    const parsed = JSON.parse(output);
    const models = Array.isArray(parsed.models) ? parsed.models : [];

    return models.filter((model) => isBundledOfficialCodexModel(model.slug));
  } catch {
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
}

function isBundledOfficialCodexModel(slug) {
  return /^gpt-|^o\d/i.test(String(slug || ""));
}

function writeCodexModelCatalog() {
  const models = [
    ...OFFICIAL_CODEX_CATALOG_MODELS,
    ...CODEX_CUSTOM_MODELS,
  ];

  const catalog = {
    generated_at: new Date().toISOString(),
    source: "volcengine-agent-plan-gateway",
    models,
  };

  fs.mkdirSync(path.dirname(CODEX_MODEL_CATALOG_PATH), { recursive: true });
  fs.writeFileSync(CODEX_MODEL_CATALOG_PATH, JSON.stringify(catalog, null, 2), "utf8");
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

function officialUpstreamHeaders(clientReq, auth) {
  const headers = {
    "Content-Type": "application/json",
    Accept: clientReq.headers.accept || "application/json",
    Authorization: `Bearer ${auth.accessToken}`,
    "OpenAI-Beta": "responses=experimental",
    "originator": "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.0.0"
  };

  if (auth.accountId) {
    headers["chatgpt-account-id"] = auth.accountId;
  }

  return headers;
}

function normalizeOfficialCodexBody(body, backend) {
  const normalized = { ...body };

  if (!Object.prototype.hasOwnProperty.call(normalized, "instructions")) {
    normalized.instructions = "";
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, "store")) {
    normalized.store = false;
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

function loadGatewayConfig(filePath) {
  let config = {};
  if (filePath && fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    config = JSON.parse(raw);
  }

  if (!config.clients) {
    const old = normalizeGatewayConfig(config);
    config.clients = { code: { endpoints: [] }, desktop: { endpoints: [] }, codex: { endpoints: [] } };

    const providersMap = {};
    for (const m of old.models || []) {
      const provider = old.providers[m.provider];
      if (!provider) continue;

      // Do not auto-migrate OpenAPI URLs to Claude/Codex unless the user configures them manually
      if (provider.type === "anthropic") {
        if (!providersMap[provider.id]) {
          providersMap[provider.id] = {
            name: provider.id,
            type: provider.type,
            base_url: provider.base_url,
            api_key: provider.api_key || (provider.api_key_env ? `env:${provider.api_key_env}` : ""),
            models: [],
            model_mapping: {}
          };
        }

        const ep = providersMap[provider.id];
        if (!ep.models.includes(m.upstream_model)) {
          ep.models.push(m.upstream_model);
        }
        ep.model_mapping[m.id] = m.upstream_model;
        for (const alias of m.aliases || []) {
          ep.model_mapping[alias] = m.upstream_model;
        }
      }
    }

    for (const ep of Object.values(providersMap)) {
      config.clients.code.endpoints.push(JSON.parse(JSON.stringify(ep)));
      config.clients.desktop.endpoints.push(JSON.parse(JSON.stringify(ep)));
      config.clients.codex.endpoints.push(JSON.parse(JSON.stringify(ep)));
    }
  }

  // Deduplicate endpoints
  if (config.clients) {
    if (config.clients.claude) {
      if (!config.clients.code) config.clients.code = JSON.parse(JSON.stringify(config.clients.claude));
      if (!config.clients.desktop) config.clients.desktop = JSON.parse(JSON.stringify(config.clients.claude));
      delete config.clients.claude;
    }
    for (const clientName of Object.keys(config.clients)) {
      const endpoints = config.clients[clientName].endpoints || [];
      const mergedEndpoints = [];
      const epMap = new Map();

      for (const ep of endpoints) {
        const key = `${ep.type}|${ep.base_url}|${ep.api_key}`;
        if (epMap.has(key)) {
          const existing = epMap.get(key);
          if (ep.models) {
            for (const m of ep.models) {
              if (!existing.models.includes(m)) existing.models.push(m);
            }
          }
          if (ep.model_mapping) {
            Object.assign(existing.model_mapping, ep.model_mapping);
          }
        } else {
          epMap.set(key, ep);
          mergedEndpoints.push(ep);
        }
      }
      config.clients[clientName].endpoints = mergedEndpoints;
    }
  }

  return config;
}

function reloadGatewayConfig() {
  GATEWAY_CONFIG = loadGatewayConfig(GATEWAY_CONFIG_FILE);
  const _endpoints = [
    ...(GATEWAY_CONFIG.clients?.code?.endpoints || []),
    ...(GATEWAY_CONFIG.clients?.desktop?.endpoints || []),
    ...(GATEWAY_CONFIG.clients?.claude?.endpoints || []),
    ...(GATEWAY_CONFIG.clients?.codex?.endpoints || [])
  ];
  EXPOSED_MODELS = [...new Set(_endpoints.flatMap(ep => [
    ...(ep.models || []),
    ...Object.keys(ep.model_mapping || {})
  ]))];
  if (EXPOSED_MODELS.length === 0) {
    EXPOSED_MODELS.push(...parseList(process.env.EXPOSED_MODELS || process.env.MODEL_LIST || "claude-sonnet"));
  }
}

function normalizeGatewayConfig(config) {
  const providers = {};
  for (const [id, provider] of Object.entries(config.providers || {})) {
    if (!id || !provider) continue;
    providers[id] = {
      id,
      type: provider.type || "openai-chat",
      base_url: trimRight(provider.base_url || "", "/"),
      api_key_env: provider.api_key_env || "",
      api_key: provider.api_key || "",
      auth: (provider.auth || "bearer").toLowerCase(),
      headers: provider.headers || {},
    };
  }

  const models = [];
  const aliases = {};
  const displayNames = {};

  const modelEntries = Array.isArray(config.models)
    ? config.models
    : Object.entries(config.models || {}).map(([id, model]) => ({ id, ...model }));

  for (const model of modelEntries) {
    if (!model.id || !model.provider || !providers[model.provider]) continue;
    const normalized = {
      id: model.id,
      provider: model.provider,
      upstream_model: model.upstream_model || model.model || model.id,
      display_name: model.display_name || model.name || model.id,
      aliases: Array.isArray(model.aliases) ? model.aliases : [],
      owned_by: model.owned_by || providers[model.provider].id,
    };
    models.push(normalized);
    aliases[normalized.id] = normalized.upstream_model;
    displayNames[normalized.id] = normalized.display_name;
    for (const alias of normalized.aliases) {
      if (alias) aliases[alias] = normalized.upstream_model;
    }
  }

  return {
    server: config.server || {},
    providers,
    models,
    aliases,
    displayNames,
    officialModels: config.official_models || {},
  };
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



async function readText(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

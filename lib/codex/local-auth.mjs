// Read local Codex/ChatGPT subscription auth from ~/.codex/auth.json.
// Token secrets stay in the Codex home file; gateway endpoints only reference the path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CODEX_AUTH_RELATIVE = "~/.codex/auth.json";
export const CHATGPT_CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
export const OPENAI_API_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const OPENAI_AUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export function expandHomePath(input, { home = os.homedir() } = {}) {
  const text = String(input || "").trim();
  if (!text) return "";
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return path.join(home, text.slice(2));
  }
  return text;
}

export function resolveCodexHome({ env = process.env, home = os.homedir() } = {}) {
  if (env.CODEX_HOME) return expandHomePath(env.CODEX_HOME, { home });
  return path.join(home, ".codex");
}

export function resolveCodexAuthPath({
  authPath = "",
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (authPath) return expandHomePath(authPath, { home });
  if (env.CODEX_AUTH_PATH) return expandHomePath(env.CODEX_AUTH_PATH, { home });
  return path.join(resolveCodexHome({ env, home }), "auth.json");
}

export function decodeJwtPayload(token) {
  const text = String(token || "").trim();
  const parts = text.split(".");
  if (parts.length < 2) return null;
  try {
    const raw = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function readCodexAuthFile({
  authPath = "",
  env = process.env,
  home = os.homedir(),
  readFileSync = fs.readFileSync,
  existsSync = fs.existsSync,
} = {}) {
  const resolved = resolveCodexAuthPath({ authPath, env, home });
  if (!existsSync(resolved)) {
    return {
      ok: false,
      code: "auth_not_found",
      path: resolved,
      auth: null,
      error: `Codex auth file not found: ${resolved}`,
    };
  }
  try {
    const raw = readFileSync(resolved, "utf8");
    const auth = JSON.parse(raw);
    return {
      ok: true,
      code: "ok",
      path: resolved,
      auth,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      code: "auth_invalid",
      path: resolved,
      auth: null,
      error: `Failed to parse Codex auth file: ${error?.message || error}`,
    };
  }
}

export function extractCodexTokens(auth) {
  const tokens = auth?.tokens && typeof auth.tokens === "object" ? auth.tokens : {};
  const accessToken =
    tokens.access_token ||
    auth?.access_token ||
    auth?.credentials?.access_token ||
    "";
  const refreshToken =
    tokens.refresh_token ||
    auth?.refresh_token ||
    auth?.credentials?.refresh_token ||
    "";
  const idToken =
    tokens.id_token ||
    auth?.id_token ||
    auth?.credentials?.id_token ||
    "";
  const accountId =
    tokens.account_id ||
    auth?.account_id ||
    auth?.tokens?.accountId ||
    "";
  return {
    access_token: String(accessToken || ""),
    refresh_token: String(refreshToken || ""),
    id_token: String(idToken || ""),
    account_id: String(accountId || ""),
    auth_mode: String(auth?.auth_mode || ""),
    last_refresh: String(auth?.last_refresh || ""),
    api_key: auth?.OPENAI_API_KEY || auth?.openai_api_key || null,
  };
}

export function inspectAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) {
    return {
      exp: null,
      expires_at: null,
      expires_in_seconds: null,
      expired: false,
      client_id: "",
      claims: null,
    };
  }
  const exp = Number(payload.exp) || null;
  const expiresAt = exp ? new Date(exp * 1000).toISOString() : null;
  const expiresInSeconds = exp ? Math.round(exp * 1000 - Date.now()) / 1000 : null;
  return {
    exp,
    expires_at: expiresAt,
    expires_in_seconds: expiresInSeconds == null ? null : Math.round(expiresInSeconds),
    expired: exp ? exp * 1000 <= Date.now() : false,
    client_id: String(payload.client_id || ""),
    claims: payload,
  };
}

export function codexAuthSnapshotFromFile(options = {}) {
  const loaded = readCodexAuthFile(options);
  if (!loaded.ok) {
    return {
      ...loaded,
      tokens: extractCodexTokens(null),
      access: inspectAccessToken(""),
    };
  }
  const tokens = extractCodexTokens(loaded.auth);
  return {
    ...loaded,
    tokens,
    access: inspectAccessToken(tokens.access_token),
  };
}

export function resolveCodexSubscriptionCredentials({
  authPath = "",
  env = process.env,
  home = os.homedir(),
  clientReq = null,
  allowApiKeyFallback = true,
  readFileSync = fs.readFileSync,
  existsSync = fs.existsSync,
} = {}) {
  const authHeader = clientReq?.headers?.authorization || "";
  if (String(authHeader).toLowerCase().startsWith("bearer ")) {
    const accessToken = String(authHeader).slice(7).trim();
    if (accessToken && accessToken !== "dummy") {
      return {
        backend: "chatgpt-codex",
        url: CHATGPT_CODEX_RESPONSES_URL,
        accessToken,
        accountId: firstHeaderValue(clientReq?.headers?.["chatgpt-account-id"]) || "",
        refreshToken: "",
        authPath: resolveCodexAuthPath({ authPath, env, home }),
        source: "request_header",
      };
    }
  }

  const snapshot = codexAuthSnapshotFromFile({
    authPath,
    env,
    home,
    readFileSync,
    existsSync,
  });
  if (snapshot.ok && snapshot.tokens.access_token) {
    return {
      backend: "chatgpt-codex",
      url: CHATGPT_CODEX_RESPONSES_URL,
      accessToken: snapshot.tokens.access_token,
      accountId: snapshot.tokens.account_id || "",
      refreshToken: snapshot.tokens.refresh_token || "",
      authPath: snapshot.path,
      source: "auth_file",
      last_refresh: snapshot.tokens.last_refresh || "",
      access: snapshot.access,
    };
  }

  if (allowApiKeyFallback) {
    const apiKey =
      snapshot.tokens.api_key ||
      env.OPENAI_API_KEY ||
      "";
    if (apiKey) {
      return {
        backend: "openai",
        url: OPENAI_API_RESPONSES_URL,
        accessToken: String(apiKey),
        accountId: "",
        refreshToken: "",
        authPath: snapshot.path,
        source: snapshot.tokens.api_key ? "auth_file_api_key" : "env_api_key",
      };
    }
  }

  return null;
}

export async function refreshCodexAccessToken({
  refreshToken,
  clientId = CODEX_OAUTH_CLIENT_ID,
  tokenUrl = OPENAI_AUTH_TOKEN_URL,
  fetchImpl = globalThis.fetch,
  proxyFetch = null,
} = {}) {
  if (!refreshToken) {
    throw new Error("Missing Codex refresh_token");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const request = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  };
  const response = proxyFetch
    ? await proxyFetch(tokenUrl, request)
    : await fetchImpl(tokenUrl, request);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      payload?.error_description ||
      payload?.error ||
      text ||
      `HTTP ${response.status}`;
    const error = new Error(`Codex token refresh failed: ${message}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return {
    access_token: payload?.access_token || "",
    refresh_token: payload?.refresh_token || refreshToken,
    id_token: payload?.id_token || "",
    expires_in: Number(payload?.expires_in) || null,
    raw: payload,
  };
}

export function writeCodexAuthTokens({
  authPath = "",
  env = process.env,
  home = os.homedir(),
  tokens = {},
  readFileSync = fs.readFileSync,
  writeFileSync = fs.writeFileSync,
  existsSync = fs.existsSync,
} = {}) {
  const resolved = resolveCodexAuthPath({ authPath, env, home });
  let current = {};
  if (existsSync(resolved)) {
    try {
      current = JSON.parse(readFileSync(resolved, "utf8"));
    } catch {
      current = {};
    }
  }
  const nextTokens = {
    ...(current.tokens && typeof current.tokens === "object" ? current.tokens : {}),
  };
  if (tokens.access_token) nextTokens.access_token = tokens.access_token;
  if (tokens.refresh_token) nextTokens.refresh_token = tokens.refresh_token;
  if (tokens.id_token) nextTokens.id_token = tokens.id_token;
  if (tokens.account_id) nextTokens.account_id = tokens.account_id;

  const next = {
    ...current,
    auth_mode: current.auth_mode || "chatgpt",
    tokens: nextTokens,
    last_refresh: new Date().toISOString(),
  };
  writeFileSync(resolved, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return {
    path: resolved,
    auth: next,
  };
}

export async function ensureFreshCodexAuth({
  authPath = "",
  env = process.env,
  home = os.homedir(),
  skewSeconds = 300,
  clientReq = null,
  allowApiKeyFallback = true,
  fetchImpl = globalThis.fetch,
  proxyFetch = null,
  readFileSync = fs.readFileSync,
  writeFileSync = fs.writeFileSync,
  existsSync = fs.existsSync,
} = {}) {
  const credentials = resolveCodexSubscriptionCredentials({
    authPath,
    env,
    home,
    clientReq,
    allowApiKeyFallback,
    readFileSync,
    existsSync,
  });
  if (!credentials) return null;
  if (credentials.backend !== "chatgpt-codex") return credentials;
  if (credentials.source === "request_header") return credentials;

  const access = credentials.access || inspectAccessToken(credentials.accessToken);
  const expiresIn = access.expires_in_seconds;
  const needsRefresh =
    access.expired ||
    (expiresIn != null && expiresIn <= skewSeconds);

  if (!needsRefresh || !credentials.refreshToken) {
    return credentials;
  }

  const refreshed = await refreshCodexAccessToken({
    refreshToken: credentials.refreshToken,
    clientId: access.client_id || CODEX_OAUTH_CLIENT_ID,
    fetchImpl,
    proxyFetch,
  });
  writeCodexAuthTokens({
    authPath: credentials.authPath || authPath,
    env,
    home,
    tokens: {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      id_token: refreshed.id_token,
      account_id: credentials.accountId,
    },
    readFileSync,
    writeFileSync,
    existsSync,
  });

  return {
    ...credentials,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    source: "auth_file_refreshed",
    access: inspectAccessToken(refreshed.access_token),
  };
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0] || "";
  return value ? String(value) : "";
}

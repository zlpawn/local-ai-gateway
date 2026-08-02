// Antigravity OAuth - standard Google authorization_code flow.
// Matches AG-Manager src-tauri/src/modules/oauth.rs (form-urlencoded token
// requests, access_type=offline, prompt=consent, include_granted_scopes=true).
import {
  AUTH_URL,
  TOKEN_URL,
  USERINFO_URL,
  SCOPES,
  OAUTH_USER_AGENT,
} from "./constants.mjs";

// Resolve a proxy-aware fetch so oauth2.googleapis.com requests succeed behind
// local Clash/VPN proxies. Node's built-in fetch (undici) ignores the `agent`
// option, so we use http/https.request + HttpsProxyAgent instead, mirroring
// the gateway's fetchWithOptionalProxy implementation.
import http from "node:http";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";

function proxyUrl() {
  return (
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
    process.env.https_proxy || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy || ""
  );
}

function nodeResToFetchLike(res) {
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage || "",
    async text() {
      return new Promise((resolve, reject) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      });
    },
    async json() {
      return JSON.parse(await this.text());
    },
  };
}

async function proxiedFetch(url, init = {}) {
  const proxy = proxyUrl();
  const method = init.method || "GET";
  const headers = init.headers || {};
  const body = init.body || null;
  const signal = init.signal || null;

  if (!proxy) {
    return fetch(url, { method, headers, body, signal });
  }

  const agent = new HttpsProxyAgent(proxy);
  const transport = new URL(url).protocol === "http:" ? http : https;
  const headerBag = { ...headers };
  if (body != null && headerBag["Content-Length"] == null && headerBag["content-length"] == null) {
    const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : String(body);
    headerBag["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method, headers: headerBag, agent }, (res) => {
      resolve(nodeResToFetchLike(res));
    });
    const onAbort = () => {
      const error = new Error("client aborted");
      error.name = "AbortError";
      req.destroy(error);
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      req.once("close", () => signal.removeEventListener("abort", onAbort));
    }
    req.on("error", reject);
    if (body != null) req.write(typeof body === "string" || Buffer.isBuffer(body) ? body : String(body));
    req.end();
  });
}

export function buildAuthUrl({ clientId, redirectUri, state, prompt = "select_account consent" }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    // Force account chooser + consent so users can switch Google accounts.
    prompt,
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export function randomState() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function postForm(url, params) {
  const body = new URLSearchParams(params);
  const res = await proxiedFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": OAUTH_USER_AGENT,
    },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const msg = json?.error_description || json?.error || text;
    throw new Error(`OAuth request to ${url} failed (${res.status}): ${msg}`);
  }
  return json || {};
}

function normalizeToken(raw) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token || "",
    expires_at: raw.expires_in ? now + Number(raw.expires_in) : Number(raw.expires_at || 0),
    token_type: raw.token_type || "Bearer",
  };
}

export async function exchangeCode({ code, redirectUri, clientId, clientSecret }) {
  const token = await postForm(TOKEN_URL, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  return normalizeToken(token);
}

export async function refreshToken({ refreshToken, clientId, clientSecret }) {
  const token = await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  return normalizeToken(token);
}

export async function getUserInfo({ accessToken }) {
  const res = await proxiedFetch(USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": OAUTH_USER_AGENT,
    },
  });
  if (!res.ok) {
    throw new Error(`getUserInfo failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// Returns a fresh access_token, refreshing first if it expires within
// skewSeconds. Throws if no refresh_token is available.
export async function ensureFreshToken({ store, clientId, clientSecret, skewSeconds = 900 }) {
  const t = store.getStoredToken();
  const now = Math.floor(Date.now() / 1000);
  if (t.access_token && t.expires_at - now > skewSeconds) {
    return { access_token: t.access_token, expires_at: t.expires_at, account_id: t.account_id };
  }
  if (!t.refresh_token) {
    throw new Error("No refresh_token available; run `shrimp upstream google-oauth login` first.");
  }
  const refreshed = await refreshToken({ refreshToken: t.refresh_token, clientId, clientSecret });
  const next = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || t.refresh_token,
    expires_at: refreshed.expires_at,
    account_id: t.account_id,
  };
  store.saveSecrets(next);
  return next;
}

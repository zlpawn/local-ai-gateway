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
// local Clash/VPN proxies. Mirrors the gateway fetchWithOptionalProxy approach.
function proxyUrl() {
  return (
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
    process.env.https_proxy || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy || ""
  );
}

async function proxiedFetch(url, init = {}) {
  const proxy = proxyUrl();
  if (!proxy) return fetch(url, init);
  try {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    const agent = new HttpsProxyAgent(proxy);
    return fetch(url, { ...init, agent });
  } catch {
    return fetch(url, init);
  }
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

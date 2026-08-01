// Antigravity subscription auth service.
// Used by CLI + config-panel HTTP API. Provider-shaped so Codex can plug in later.
import { spawn } from "node:child_process";
import { REDIRECT_PORT, redirectUri, TOKEN_REFRESH_SKEW_SECONDS } from "./constants.mjs";
import {
  defaultInstallCandidates,
  discoverAntigravityClientCredentials,
  resolveInstallRoot,
} from "./client-discovery.mjs";
import {
  getClientCredentials,
  getSecretsPath,
  getStoredToken,
  loadSecrets,
  saveSecrets,
} from "./token-store.mjs";
import {
  buildAuthUrl,
  exchangeCode,
  getUserInfo,
  randomState,
} from "./oauth.mjs";
import { startCallbackServerOnFreePort } from "./oauth-callback-server.mjs";
import { hasValue, maskSecret } from "../subscription-auth/mask.mjs";

const loginSessions = new Map();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function detectInstallPresence({ env = process.env } = {}) {
  const installRoot = resolveInstallRoot(defaultInstallCandidates(env));
  if (!installRoot) {
    return {
      ok: false,
      code: "install_not_found",
      message:
        "未检测到本机 Antigravity 安装。请先安装 Antigravity Desktop，或手动填写 client_id / client_secret。",
      install_root: null,
      scanned_files: [],
    };
  }
  return {
    ok: true,
    code: "install_detected",
    message: "已检测到本机 Antigravity 安装，可尝试提取 OAuth client 凭据。",
    install_root: installRoot,
    scanned_files: [],
  };
}

// Open a URL in the default browser without going through cmd parsing.
// Critical on Windows: `cmd /c start ...&...` truncates OAuth query strings.
export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const target = String(url || "");
  if (!target) return false;
  try {
    if (platform === "win32") {
      // rundll32 receives the URL as one argument; & is not re-parsed by cmd.
      spawnImpl("rundll32", ["url.dll,FileProtocolHandler", target], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      return true;
    }
    if (platform === "darwin") {
      spawnImpl("open", [target], { detached: true, stdio: "ignore" }).unref();
      return true;
    }
    spawnImpl("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

function summarizeNodePresence(config = {}) {
  const clients = config.clients || {};
  const hits = [];
  for (const [clientName, group] of Object.entries(clients)) {
    const endpoints = Array.isArray(group?.endpoints) ? group.endpoints : [];
    for (const endpoint of endpoints) {
      if (String(endpoint?.type || "").toLowerCase() === "antigravity") {
        hits.push({
          client: clientName,
          endpoint_id: endpoint.id || null,
          endpoint_name: endpoint.name || null,
          models: Array.isArray(endpoint.models) ? endpoint.models : [],
        });
      }
    }
  }
  return {
    configured: hits.length > 0,
    count: hits.length,
    endpoints: hits,
  };
}

function deriveAuthState({ hasClient, hasRefresh, expiresAt, skewSeconds }) {
  if (!hasClient) return "missing_client";
  if (!hasRefresh) return "ready_to_login";
  const remaining = Number(expiresAt || 0) - nowSeconds();
  if (!Number.isFinite(remaining) || remaining <= 0) return "expired";
  if (remaining <= skewSeconds) return "expiring_soon";
  return "logged_in";
}

function buildNextSteps({ state, nodes, install }) {
  const steps = [];
  if (state === "missing_client") {
    if (install.detected) {
      steps.push("点击“从本机提取”，写入 Antigravity OAuth client 凭据。");
    } else {
      steps.push("本机未检测到 Antigravity，请手动填写 client_id / client_secret。");
    }
  }
  if (state === "ready_to_login" || state === "expired" || state === "expiring_soon") {
    steps.push("点击“一键登录”，用已订阅 Antigravity 的 Google 账号完成授权。");
  }
  if (state === "logged_in" && !nodes.configured) {
    steps.push("鉴权已就绪。请到 Codex / DeepTutor 节点页手动添加 type=antigravity 的节点。");
  }
  if (state === "logged_in" && nodes.configured) {
    steps.push("鉴权与节点都已配置，可在客户端选择 Antigravity 模型。");
  }
  return steps;
}

export function getAntigravityAuthStatus({
  env = process.env,
  config = {},
  skewSeconds = TOKEN_REFRESH_SKEW_SECONDS,
  discover = detectInstallPresence,
} = {}) {
  const secrets = loadSecrets(env);
  const token = getStoredToken(env);
  const hasClient = hasValue(secrets.client_id) && hasValue(secrets.client_secret);
  const hasAccess = hasValue(token.access_token);
  const hasRefresh = hasValue(token.refresh_token);
  const expiresAt = Number(token.expires_at || 0);
  const remaining = expiresAt ? expiresAt - nowSeconds() : null;
  const install = discover({ env });
  const nodes = summarizeNodePresence(config);
  const state = deriveAuthState({
    hasClient,
    hasRefresh,
    expiresAt,
    skewSeconds,
  });

  return {
    provider: "antigravity",
    label: "接入 Antigravity 订阅",
    secrets_path: getSecretsPath(env),
    state,
    state_label: {
      missing_client: "缺少 client 凭据",
      ready_to_login: "可登录",
      logged_in: "已登录",
      expiring_soon: "即将过期",
      expired: "已失效",
    }[state] || state,
    client: {
      configured: hasClient,
      client_id: secrets.client_id || "",
      client_id_masked: secrets.client_id ? maskSecret(secrets.client_id, { keepStart: 12, keepEnd: 8 }) : "",
      client_secret_configured: hasValue(secrets.client_secret),
      client_secret_masked: secrets.client_secret
        ? maskSecret(secrets.client_secret, { keepStart: 7, keepEnd: 4 })
        : "",
    },
    token: {
      access_token_configured: hasAccess,
      refresh_token_configured: hasRefresh,
      account_id: token.account_id || "",
      expires_at: expiresAt || 0,
      expires_in_seconds: remaining,
      refresh_skew_seconds: skewSeconds,
    },
    install: {
      detected: Boolean(install.install_root),
      install_root: install.install_root || null,
      can_extract: Boolean(install.install_root),
      code: install.code,
      message: install.message,
    },
    nodes,
    protocol_note:
      "Antigravity 节点真实上游是 Google Cloud Code v1internal gRPC，不是 Anthropic Messages。配置面板应选择 type=antigravity。",
    cli: {
      status: "shrimp upstream google-oauth status",
      login: "shrimp upstream google-oauth login",
      discover: "shrimp upstream google-oauth discover",
    },
    next_steps: buildNextSteps({ state, nodes, install }),
  };
}

export function saveAntigravityClientCredentials(
  { client_id, client_secret },
  { env = process.env } = {},
) {
  const clientId = String(client_id || "").trim();
  const clientSecret = String(client_secret || "").trim();
  if (!clientId || !clientSecret) {
    const error = new Error("client_id and client_secret are required");
    error.code = "invalid_client_credentials";
    throw error;
  }
  if (!clientId.includes("apps.googleuser.test")) {
    const error = new Error("client_id does not look like a Google OAuth client id");
    error.code = "invalid_client_id";
    throw error;
  }
  saveSecrets({ client_id: clientId, client_secret: clientSecret }, env);
  return getAntigravityAuthStatus({ env });
}

export function discoverAndSaveAntigravityClientCredentials({
  env = process.env,
  discover = discoverAntigravityClientCredentials,
  save = true,
} = {}) {
  const result = discover({ env });
  if (!result.ok) {
    return {
      ...result,
      status: getAntigravityAuthStatus({ env }),
    };
  }
  if (save) {
    saveSecrets(
      {
        client_id: result.client_id,
        client_secret: result.client_secret,
      },
      env,
    );
  }
  return {
    ...result,
    client_secret: undefined,
    client_secret_masked: maskSecret(result.client_secret, { keepStart: 7, keepEnd: 4 }),
    saved: Boolean(save),
    status: getAntigravityAuthStatus({ env }),
  };
}

async function completeLoginWithCode({
  code,
  redirectUriValue,
  creds,
  env,
}) {
  const token = await exchangeCode({
    code,
    redirectUri: redirectUriValue,
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
  });
  const userInfo = await getUserInfo({ accessToken: token.access_token });
  saveSecrets(
    {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: token.expires_at,
      account_id: userInfo.email,
    },
    env,
  );
  return {
    ok: true,
    account_id: userInfo.email,
    secrets_path: getSecretsPath(env),
    status: getAntigravityAuthStatus({ env }),
  };
}

function publicSessionView(session) {
  if (!session) return null;
  return {
    session_id: session.id,
    phase: session.phase,
    auth_url: session.auth_url,
    redirect_uri: session.redirect_uri,
    callback_port: session.callback_port,
    browser_opened: session.browser_opened,
    account_id: session.account_id || null,
    error: session.error || null,
    created_at: session.created_at,
  };
}

// Non-blocking login for UI:
// 1) start callback on free port
// 2) return full auth_url immediately
// 3) exchange code in background and expose via getLoginSession
export async function beginAntigravityLogin({
  env = process.env,
  openBrowserImpl = openBrowser,
  startCallback = startCallbackServerOnFreePort,
  preferredPort = REDIRECT_PORT,
  force = false,
} = {}) {
  let creds;
  try {
    creds = getClientCredentials(env);
  } catch (err) {
    const error = new Error(err.message);
    error.code = "missing_client_credentials";
    throw error;
  }

  // Prevent multiple concurrent logins fighting over callbacks, unless force=true.
  for (const [id, existing] of loginSessions.entries()) {
    if (!force && (existing.phase === "waiting" || existing.phase === "starting" || existing.phase === "exchanging")) {
      return {
        ok: true,
        resumed: true,
        ...publicSessionView(existing),
        message: "已有登录流程进行中。请在浏览器完成授权；若账号不对或页面报错，请点“强制重新登录”。",
      };
    }
    if (force && (existing.phase === "waiting" || existing.phase === "starting" || existing.phase === "exchanging")) {
      existing.phase = "error";
      existing.error = { type: "login_restarted", message: "Login restarted by user" };
      loginSessions.delete(id);
    }
  }

  const state = randomState();
  const sessionId = `aglogin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  let port;
  let codePromise;
  try {
    const started = await startCallback({ preferredPort, state });
    port = started.port;
    codePromise = started.codePromise;
  } catch (err) {
    const error = new Error(
      err?.message ||
        `OAuth callback port unavailable near ${preferredPort}. Close the process using that port and retry.`,
    );
    error.code = err?.code === "EADDRINUSE" || err?.code === "callback_port_in_use"
      ? "callback_port_in_use"
      : "oauth_callback_failed";
    throw error;
  }

  const uri = redirectUri(port);
  const authUrl = buildAuthUrl({
    clientId: creds.client_id,
    redirectUri: uri,
    state,
    prompt: "select_account consent",
  });

  // Validate URL still contains required params before opening browser.
  if (!authUrl.includes("response_type=code")) {
    const error = new Error("Internal error: auth URL missing response_type");
    error.code = "invalid_auth_url";
    throw error;
  }

  const browserOpened = openBrowserImpl(authUrl);
  const session = {
    id: sessionId,
    phase: "waiting",
    auth_url: authUrl,
    redirect_uri: uri,
    callback_port: port,
    browser_opened: browserOpened,
    created_at: Date.now(),
    account_id: null,
    error: null,
    result: null,
  };
  loginSessions.set(sessionId, session);

  // Background completion. UI polls getLoginSession(sessionId).
  codePromise
    .then(async (code) => {
      session.phase = "exchanging";
      const result = await completeLoginWithCode({
        code,
        redirectUriValue: uri,
        creds,
        env,
      });
      session.phase = "done";
      session.account_id = result.account_id;
      session.result = result;
    })
    .catch((err) => {
      session.phase = "error";
      session.error = {
        type: err?.code || "oauth_callback_failed",
        message: err?.message || String(err),
      };
    });

  // Auto-expire session records after 15 minutes.
  const expireTimer = setTimeout(() => {
    loginSessions.delete(sessionId);
  }, 15 * 60 * 1000);
  if (typeof expireTimer.unref === "function") expireTimer.unref();

  return {
    ok: true,
    resumed: false,
    ...publicSessionView(session),
    message: browserOpened
      ? "已打开浏览器。请选择 Google 账号并完成授权。"
      : "未能自动打开浏览器。请手动打开下方完整授权链接。",
  };
}

export function getAntigravityLoginSession(sessionId, { env = process.env } = {}) {
  const session = loginSessions.get(String(sessionId || ""));
  if (!session) {
    const error = new Error("Login session not found or expired");
    error.code = "login_session_not_found";
    throw error;
  }
  const view = publicSessionView(session);
  if (session.phase === "done") {
    return {
      ok: true,
      ...view,
      status: session.result?.status || getAntigravityAuthStatus({ env }),
      secrets_path: session.result?.secrets_path || getSecretsPath(env),
    };
  }
  if (session.phase === "error") {
    return {
      ok: false,
      ...view,
      status: getAntigravityAuthStatus({ env }),
    };
  }
  return {
    ok: true,
    ...view,
    status: getAntigravityAuthStatus({ env }),
  };
}

// Blocking login for CLI compatibility.
export async function loginAntigravitySubscription({
  env = process.env,
  openBrowserImpl = openBrowser,
  startCallback = startCallbackServerOnFreePort,
  preferredPort = REDIRECT_PORT,
} = {}) {
  const started = await beginAntigravityLogin({
    env,
    openBrowserImpl,
    startCallback,
    preferredPort,
  });

  // Wait until session completes.
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const current = getAntigravityLoginSession(started.session_id, { env });
    if (current.phase === "done") {
      return {
        ok: true,
        account_id: current.account_id,
        browser_opened: current.browser_opened,
        auth_url: current.auth_url,
        redirect_uri: current.redirect_uri,
        callback_port: current.callback_port,
        secrets_path: current.secrets_path,
        status: current.status,
      };
    }
    if (current.phase === "error") {
      const error = new Error(current.error?.message || "Login failed");
      error.code = current.error?.type || "oauth_callback_failed";
      error.auth_url = current.auth_url;
      throw error;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const error = new Error("OAuth login timed out waiting for browser callback");
  error.code = "oauth_timeout";
  error.auth_url = started.auth_url;
  throw error;
}

export const antigravitySubscriptionAuthProvider = {
  id: "antigravity",
  label: "接入 Antigravity 订阅",
  description: "从本机提取 OAuth 凭据，登录 Google 订阅账号，供网关调用 Antigravity Gemini 模型。",
  commands: ["status", "discover", "login"],
  getStatus: getAntigravityAuthStatus,
  discoverClient: discoverAndSaveAntigravityClientCredentials,
  saveClient: saveAntigravityClientCredentials,
  login: beginAntigravityLogin, // non-blocking for HTTP/UI
  beginLogin: beginAntigravityLogin,
  getLoginSession: getAntigravityLoginSession,
  // CLI still uses blocking helper via cli.mjs
  loginBlocking: loginAntigravitySubscription,
};

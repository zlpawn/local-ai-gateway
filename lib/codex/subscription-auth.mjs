// Codex subscription auth service.
// Provider-shaped so config-panel / CLI can manage local ChatGPT/Codex login state.
// Tokens remain in ~/.codex/auth.json; gateway endpoints only reference the auth path.

import os from "node:os";
import {
  DEFAULT_CODEX_AUTH_RELATIVE,
  codexAuthSnapshotFromFile,
  ensureFreshCodexAuth,
  resolveCodexAuthPath,
  resolveCodexHome,
} from "./local-auth.mjs";
import { hasValue, maskSecret } from "../subscription-auth/mask.mjs";

function countCodexSubscriptionNodes(config = {}) {
  let count = 0;
  const clients = config.clients || {};
  for (const client of Object.values(clients)) {
    for (const endpoint of client.endpoints || []) {
      const type = String(endpoint?.type || "").toLowerCase();
      if (type === "codex-subscription" || type === "chatgpt-codex") count += 1;
    }
  }
  return count;
}

function buildNextSteps({ hasAuth, hasAccess, hasRefresh, hasNode, expired }) {
  const steps = [];
  if (!hasAuth) {
    steps.push("请先在本机 Codex / ChatGPT 客户端完成登录，生成 ~/.codex/auth.json。");
  } else if (!hasAccess && !hasRefresh) {
    steps.push("本地 auth.json 缺少 access_token / refresh_token，请重新登录 Codex。");
  } else if (expired && !hasRefresh) {
    steps.push("access_token 已过期且没有 refresh_token，请重新登录 Codex。");
  } else if (expired) {
    steps.push("access_token 已过期，网关会在调用时尝试 refresh；也可重新登录 Codex。");
  } else {
    steps.push("本机 Codex 订阅鉴权已就绪。");
  }
  if (!hasNode) {
    steps.push("请到客户端节点页手动添加 type=codex-subscription 的节点，并填入官方模型。");
  } else {
    steps.push("鉴权与节点都已配置，可在 Claude Desktop / DeepTutor / Codex 中选择对应模型。");
  }
  return steps;
}

export function getCodexAuthStatus({
  env = process.env,
  home = os.homedir(),
  config = {},
  authPath = "",
} = {}) {
  const resolvedAuthPath = resolveCodexAuthPath({ authPath, env, home });
  const snapshot = codexAuthSnapshotFromFile({ authPath: resolvedAuthPath, env, home });
  const tokens = snapshot.tokens || {};
  const access = snapshot.access || {};
  const hasAuthFile = snapshot.ok;
  const hasAccess = hasValue(tokens.access_token);
  const hasRefresh = hasValue(tokens.refresh_token);
  const hasApiKey = hasValue(tokens.api_key);
  const expired = Boolean(access.expired);
  const nodeCount = countCodexSubscriptionNodes(config);

  let state = "missing_auth";
  let stateLabel = "未登录";
  if (!hasAuthFile) {
    state = "missing_auth";
    stateLabel = "未找到本地 Codex 登录态";
  } else if (!hasAccess && !hasRefresh && !hasApiKey) {
    state = "invalid_auth";
    stateLabel = "本地鉴权文件无效";
  } else if (expired && !hasRefresh && !hasApiKey) {
    state = "token_expired";
    stateLabel = "Token 已过期";
  } else if (hasAccess || hasRefresh || hasApiKey) {
    state = "ready";
    stateLabel = expired ? "可自动刷新" : "已就绪";
  }

  return {
    provider: "codex",
    label: "接入 Codex 订阅",
    description:
      "读取本机 ~/.codex/auth.json 的 ChatGPT/Codex 登录态，供网关把官方模型节点提供给其他客户端。",
    state,
    state_label: stateLabel,
    secrets_path: resolvedAuthPath,
    auth_path: resolvedAuthPath,
    auth_path_default: DEFAULT_CODEX_AUTH_RELATIVE,
    codex_home: resolveCodexHome({ env, home }),
    install: {
      detected: hasAuthFile,
      auth_path: resolvedAuthPath,
    },
    token: {
      auth_mode: tokens.auth_mode || "",
      access_token_configured: hasAccess,
      refresh_token_configured: hasRefresh,
      api_key_configured: hasApiKey,
      account_id: tokens.account_id || "",
      access_token_masked: hasAccess ? maskSecret(tokens.access_token, { keepStart: 8, keepEnd: 4 }) : "",
      refresh_token_masked: hasRefresh ? maskSecret(tokens.refresh_token, { keepStart: 6, keepEnd: 4 }) : "",
      expires_at: access.expires_at || null,
      expires_in_seconds: access.expires_in_seconds,
      expired,
      last_refresh: tokens.last_refresh || "",
    },
    nodes: {
      configured: nodeCount > 0,
      count: nodeCount,
      type: "codex-subscription",
    },
    notes: [
      "Codex 订阅节点真实上游是 chatgpt.com backend-api/codex/responses，不是普通 OpenAI API Key 接口。",
      "token 保留在本机 ~/.codex/auth.json，不会写入 gateway.secrets.json。",
      "可把 codex-subscription 节点配给 Claude Desktop / DeepTutor / Codex 等客户端复用。",
    ],
    next_steps: buildNextSteps({
      hasAuth: hasAuthFile,
      hasAccess,
      hasRefresh: hasRefresh || hasApiKey,
      hasNode: nodeCount > 0,
      expired,
    }),
    commands: {
      status: "shrimp upstream codex-oauth status",
      discover: "shrimp upstream codex-oauth discover",
    },
  };
}

export function discoverCodexLocalAuth({
  env = process.env,
  home = os.homedir(),
  config = {},
  authPath = "",
} = {}) {
  const status = getCodexAuthStatus({ env, home, config, authPath });
  if (!status.install.detected) {
    return {
      ok: false,
      code: "auth_not_found",
      message: "未找到本机 Codex 登录态。请先打开 Codex 客户端完成 ChatGPT 登录。",
      status,
    };
  }
  if (status.state === "invalid_auth") {
    return {
      ok: false,
      code: "auth_invalid",
      message: "找到 auth.json，但缺少可用 token。请重新登录 Codex。",
      status,
    };
  }
  return {
    ok: true,
    code: "ok",
    message: status.state === "ready"
      ? "已检测到本机 Codex 订阅登录态。"
      : `已检测到本地鉴权：${status.state_label}`,
    auth_path: status.auth_path,
    account_id: status.token.account_id || "",
    expires_at: status.token.expires_at,
    status,
  };
}

export async function refreshCodexLocalAuth({
  env = process.env,
  home = os.homedir(),
  config = {},
  authPath = "",
  skewSeconds = 365 * 24 * 3600, // force refresh attempt when requested
  proxyFetch = null,
} = {}) {
  const before = getCodexAuthStatus({ env, home, config, authPath });
  if (!before.token.refresh_token_configured && !before.token.access_token_configured) {
    return {
      ok: false,
      code: "missing_token",
      message: "本地没有可刷新的 Codex token，请先登录 Codex。",
      status: before,
    };
  }
  try {
    const fresh = await ensureFreshCodexAuth({
      authPath: before.auth_path,
      env,
      home,
      skewSeconds,
      allowApiKeyFallback: true,
      proxyFetch,
    });
    const status = getCodexAuthStatus({ env, home, config, authPath: before.auth_path });
    if (!fresh) {
      return {
        ok: false,
        code: "refresh_failed",
        message: "无法刷新 Codex token。",
        status,
      };
    }
    return {
      ok: true,
      code: "ok",
      message: fresh.source === "auth_file_refreshed"
        ? "已刷新 Codex access_token。"
        : "当前 token 仍有效，无需刷新。",
      source: fresh.source,
      status,
    };
  } catch (error) {
    return {
      ok: false,
      code: "refresh_failed",
      message: error?.message || String(error),
      status: getCodexAuthStatus({ env, home, config, authPath: before.auth_path }),
    };
  }
}

export const codexSubscriptionAuthProvider = {
  id: "codex",
  label: "接入 Codex 订阅",
  description:
    "读取本机 Codex/ChatGPT 登录态，配置 codex-subscription 节点给其他客户端复用官方模型。",
  commands: ["status", "discover", "refresh"],
  getStatus: getCodexAuthStatus,
  discoverClient: discoverCodexLocalAuth,
  refresh: refreshCodexLocalAuth,
};

// Subscription-auth facade.
// Register built-in providers here. Future providers can register without changing HTTP/CLI callers.
import {
  getSubscriptionAuthProvider,
  listSubscriptionAuthProviders,
  registerSubscriptionAuthProvider,
  requireSubscriptionAuthProvider,
} from "./registry.mjs";
import { antigravitySubscriptionAuthProvider } from "../antigravity/auth-service.mjs";
import { codexSubscriptionAuthProvider } from "../codex/subscription-auth.mjs";

let bootstrapped = false;

export function ensureSubscriptionAuthProviders() {
  if (bootstrapped) return;
  registerSubscriptionAuthProvider(antigravitySubscriptionAuthProvider);
  registerSubscriptionAuthProvider(codexSubscriptionAuthProvider);
  bootstrapped = true;
}

export function listProviders() {
  ensureSubscriptionAuthProviders();
  return listSubscriptionAuthProviders();
}

export function getProvider(id) {
  ensureSubscriptionAuthProviders();
  return getSubscriptionAuthProvider(id);
}

export function requireProvider(id) {
  ensureSubscriptionAuthProviders();
  return requireSubscriptionAuthProvider(id);
}

export function getProviderStatus(id, options = {}) {
  return requireProvider(id).getStatus(options);
}

export async function runProviderAction(id, action, options = {}) {
  const provider = requireProvider(id);
  const name = String(action || "").trim().toLowerCase();
  if (name === "status") return provider.getStatus(options);
  if (name === "discover" || name === "discover-client") {
    if (typeof provider.discoverClient !== "function") {
      const error = new Error(`Provider '${id}' does not support discover`);
      error.code = "unsupported_action";
      throw error;
    }
    return provider.discoverClient(options);
  }
  if (name === "save-client" || name === "save_client") {
    if (typeof provider.saveClient !== "function") {
      const error = new Error(`Provider '${id}' does not support save-client`);
      error.code = "unsupported_action";
      throw error;
    }
    return provider.saveClient(options.payload || options, options);
  }
  if (name === "refresh") {
    if (typeof provider.refresh !== "function") {
      const error = new Error(`Provider '${id}' does not support refresh`);
      error.code = "unsupported_action";
      throw error;
    }
    return provider.refresh(options);
  }
  if (name === "login" || name === "begin-login" || name === "begin_login") {
    const fn = provider.beginLogin || provider.login;
    if (typeof fn !== "function") {
      const error = new Error(`Provider '${id}' does not support login`);
      error.code = "unsupported_action";
      throw error;
    }
    return fn({ ...options, force: Boolean(options.payload?.force || options.force) });
  }
  if (name === "login-session" || name === "login_session" || name === "session") {
    if (typeof provider.getLoginSession !== "function") {
      const error = new Error(`Provider '${id}' does not support login-session`);
      error.code = "unsupported_action";
      throw error;
    }
    const sessionId = options.payload?.session_id || options.session_id || options.payload?.sessionId;
    return provider.getLoginSession(sessionId, options);
  }
  const error = new Error(`Unsupported action '${action}' for provider '${id}'`);
  error.code = "unsupported_action";
  throw error;
}

export {
  registerSubscriptionAuthProvider,
  getSubscriptionAuthProvider,
  listSubscriptionAuthProviders,
  requireSubscriptionAuthProvider,
};

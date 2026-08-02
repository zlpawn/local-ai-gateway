import { HttpsProxyAgent } from "https-proxy-agent";

export function buildProxyUrl(config = {}) {
  if (!config || !config.enabled) return "";
  const protocol = String(config.protocol || "http").toLowerCase();
  const host = String(config.host || "127.0.0.1").trim();
  const port = Number(config.port) || 7897;

  let authPrefix = "";
  if (config.username) {
    const user = encodeURIComponent(String(config.username));
    const pass = config.password ? encodeURIComponent(String(config.password)) : "";
    authPrefix = pass ? `${user}:${pass}@` : `${user}@`;
  }

  return `${protocol}://${authPrefix}${host}:${port}`;
}

export function getEffectiveProxyUrl(endpoint = {}, globalProxyConfig = {}) {
  const mode = String(endpoint?.proxy_mode || "global").toLowerCase();
  if (mode === "disabled") {
    return "";
  }
  if (mode === "custom" && endpoint?.proxy_url) {
    return String(endpoint.proxy_url).trim();
  }
  // Global proxy
  return buildProxyUrl(globalProxyConfig);
}

export function resolveOutboundProxyAgent(endpoint = {}, globalProxyConfig = {}) {
  const proxyUrl = getEffectiveProxyUrl(endpoint, globalProxyConfig);
  if (!proxyUrl) return null;
  try {
    return new HttpsProxyAgent(proxyUrl);
  } catch (err) {
    console.error("Failed to create proxy agent for URL:", proxyUrl, err.message);
    return null;
  }
}

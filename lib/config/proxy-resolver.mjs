import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

export function defaultProxyConfig() {
  return {
    enabled: true,
    protocol: "http",
    host: "127.0.0.1",
    port: 7897,
    username: "",
    password: "",
  };
}

export function buildProxyUrl(config = {}) {
  if (!config || !config.enabled) return "";
  const protocol = String(config.protocol || "http").toLowerCase();
  if (!["http", "https", "socks5"].includes(protocol)) {
    throw new Error(`Unsupported proxy protocol: ${protocol}`);
  }
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
  if (endpoint?.proxy === "") return "";
  if (typeof endpoint?.proxy === "string" && endpoint.proxy.trim()) {
    return endpoint.proxy.trim();
  }
  // Global proxy
  return buildProxyUrl(globalProxyConfig);
}

export function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;
  const protocol = new URL(proxyUrl).protocol.toLowerCase();
  if (protocol === "socks:" || protocol === "socks4:" || protocol === "socks4a:" || protocol === "socks5:" || protocol === "socks5h:") {
    return new SocksProxyAgent(proxyUrl);
  }
  if (protocol === "http:" || protocol === "https:") {
    return new HttpsProxyAgent(proxyUrl);
  }
  throw new Error(`Unsupported proxy protocol: ${protocol}`);
}

export function resolveOutboundProxyAgent(endpoint = {}, globalProxyConfig = {}) {
  const proxyUrl = getEffectiveProxyUrl(endpoint, globalProxyConfig);
  if (!proxyUrl) return null;
  try {
    return createProxyAgent(proxyUrl);
  } catch (err) {
    console.error("Failed to create proxy agent for URL:", proxyUrl, err.message);
    return null;
  }
}

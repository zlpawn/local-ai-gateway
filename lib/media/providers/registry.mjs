import { grokAdapter } from "./grok.mjs";
import { codexAdapter } from "./codex.mjs";
import { antigravityAdapter } from "./antigravity.mjs";
import { huoshanAdapter } from "./huoshan.mjs";
import { selectMediaEndpoints, selectDefaultMediaEndpoint } from "../../config/gateway-config-store.mjs";

export const MEDIA_PROVIDERS = {
  "grok-subscription": grokAdapter,
  "codex-subscription": codexAdapter,
  "antigravity": antigravityAdapter,
  "huoshan-agentplan": huoshanAdapter,
};

export function getMediaProvider(providerId) {
  const id = String(providerId || "").trim();
  return MEDIA_PROVIDERS[id] || null;
}

export function listMediaProviderIds() {
  return Object.keys(MEDIA_PROVIDERS);
}

export function selectMediaEndpointForRequest(endpoints, purpose, endpointId) {
  if (endpointId) {
    return selectMediaEndpoints(endpoints, purpose).find((ep) => ep.id === endpointId) || null;
  }
  return selectDefaultMediaEndpoint(endpoints, purpose);
}

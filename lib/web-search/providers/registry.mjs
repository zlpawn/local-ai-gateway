import { tavilyAdapter } from "./tavily.mjs";

export const WEB_SEARCH_PROVIDERS = {
  tavily: tavilyAdapter,
};

export function getWebSearchProvider(providerId) {
  const id = String(providerId || "").trim().toLowerCase();
  return WEB_SEARCH_PROVIDERS[id] || null;
}

export function listWebSearchProviderIds() {
  return Object.keys(WEB_SEARCH_PROVIDERS);
}

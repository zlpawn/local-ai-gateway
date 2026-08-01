// Provider registry for subscription-auth mini-tools.
// Open/closed: add a new provider module and register it here without changing callers.

const providers = new Map();

export function registerSubscriptionAuthProvider(provider) {
  if (!provider?.id || typeof provider.id !== "string") {
    throw new Error("subscription auth provider requires a string id");
  }
  if (typeof provider.getStatus !== "function") {
    throw new Error(`subscription auth provider '${provider.id}' requires getStatus()`);
  }
  providers.set(provider.id, provider);
  return provider;
}

export function getSubscriptionAuthProvider(id) {
  const key = String(id || "").trim().toLowerCase();
  return providers.get(key) || null;
}

export function listSubscriptionAuthProviders() {
  return [...providers.values()].map((provider) => ({
    id: provider.id,
    label: provider.label,
    description: provider.description || "",
    commands: provider.commands || [],
  }));
}

export function requireSubscriptionAuthProvider(id) {
  const provider = getSubscriptionAuthProvider(id);
  if (!provider) {
    const known = listSubscriptionAuthProviders().map((item) => item.id).join(", ") || "(none)";
    const error = new Error(`Unknown subscription auth provider: ${id}. Known: ${known}`);
    error.code = "unknown_provider";
    throw error;
  }
  return provider;
}

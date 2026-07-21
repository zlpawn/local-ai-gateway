export function isOfficialCodexModelId(modelId) {
  return /^gpt-|^5\.6|^o\d/i.test(String(modelId || ""));
}

export function normalizeOfficialDiscoveryModel(model, now = Math.floor(Date.now() / 1000)) {
  const id = String(model?.id || model?.slug || "").trim();
  return {
    id,
    object: "model",
    created: Number(model?.created) || now,
    owned_by: model?.owned_by || "openai",
    display_name: model?.display_name || model?.displayName || id,
  };
}

// base first, then live-only additions. Never let live overwrite richer base rows.
export function mergeOfficialDiscoveryModels(baseModels = [], liveModels = []) {
  const now = Math.floor(Date.now() / 1000);
  const merged = new Map();

  for (const model of baseModels) {
    const normalized = normalizeOfficialDiscoveryModel(model, now);
    if (!normalized.id || !isOfficialCodexModelId(normalized.id)) continue;
    merged.set(normalized.id, normalized);
  }

  for (const model of liveModels) {
    const normalized = normalizeOfficialDiscoveryModel(model, now);
    if (!normalized.id || !isOfficialCodexModelId(normalized.id)) continue;
    if (!merged.has(normalized.id)) merged.set(normalized.id, normalized);
  }

  return [...merged.values()];
}

export function officialModelsFromOpenAIList(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .map((row) => ({
      id: row?.id,
      created: row?.created,
      owned_by: row?.owned_by || "openai",
      display_name: row?.id,
    }))
    .filter((row) => isOfficialCodexModelId(row.id));
}

export function normalizeDiscoveredModels(input, options = {}) {
  const rows = extractRows(input);
  const seen = new Set();
  const models = [];
  const transformName = typeof options.transformName === "function" ? options.transformName : (x) => x;

  for (const row of rows) {
    const status = String(row?.status || "").trim().toLowerCase();
    if (status === "shutdown" || status === "retiring") continue;

    const rawName = String(row?.name || row?.id || row?.slug || row?.model || "").trim();
    const rawId = String(row?.id || row?.slug || row?.model || row?.name || "").trim();
    if (!rawName && !rawId) continue;

    const normalizedName = transformName(rawName || rawId);
    const id = options.useNameAsId ? normalizedName : (rawId || normalizedName);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const name = normalizedName || id;
    models.push({ id, name });
  }
  return models;
}

function extractRows(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.data)) return input.data;
  if (Array.isArray(input.models)) return input.models;
  if (Array.isArray(input.items)) return input.items;
  if (Array.isArray(input.result)) return input.result;
  return [];
}

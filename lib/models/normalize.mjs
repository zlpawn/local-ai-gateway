export function normalizeDiscoveredModels(input) {
  const rows = extractRows(input);
  const seen = new Set();
  const models = [];
  for (const row of rows) {
    const id = String(row?.id || row?.slug || row?.model || row?.name || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = String(row?.display_name || row?.displayName || row?.name || id).trim() || id;
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

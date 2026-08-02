export const BUILTIN_CLAUDE_OFFICIAL_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-haiku-4-0",
];

export function mergeClaudeOfficialModels({
  userModels = [],
  disabledBuiltinModels = [],
  builtinModels = BUILTIN_CLAUDE_OFFICIAL_MODELS,
} = {}) {
  const disabled = new Set((disabledBuiltinModels || []).map((x) => String(x || "").trim()).filter(Boolean));
  const out = [];
  const seen = new Set();
  for (const raw of [...(builtinModels || []), ...(userModels || [])]) {
    const id = String(raw || "").trim();
    if (!id || seen.has(id)) continue;
    if (disabled.has(id) && (builtinModels || []).includes(id) && !(userModels || []).includes(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function getUsedClaudeDesktopMappingSources(config) {
  const used = new Set();
  const endpoints = config?.clients?.desktop?.endpoints || [];
  for (const endpoint of endpoints) {
    // Only chat nodes participate in mapping source occupancy.
    const purpose = endpoint?.purpose;
    if (purpose && purpose !== "chat") continue;
    for (const source of Object.keys(endpoint?.model_mapping || {})) {
      const id = String(source || "").trim();
      if (id) used.add(id);
    }
  }
  return [...used];
}

export function availableClaudeDesktopMappingSources(config, {
  userModels = [],
  disabledBuiltinModels = [],
  builtinModels = BUILTIN_CLAUDE_OFFICIAL_MODELS,
} = {}) {
  const used = new Set(getUsedClaudeDesktopMappingSources(config));
  return mergeClaudeOfficialModels({ userModels, disabledBuiltinModels, builtinModels })
    .filter((id) => !used.has(id));
}

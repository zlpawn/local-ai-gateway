import { execFileSync } from "node:child_process";

const CODEX_PROVIDER_TYPES = new Set([
  "openai-responses",
  "openai-chat",
  "grok",
]);

export function loadOfficialCodexIds({
  warnings = [],
  execFile = execFileSync,
} = {}) {
  try {
    const output = execFile("codex", ["debug", "models", "--bundled"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
    const parsed = JSON.parse(output);
    return new Set((parsed.models || []).map((model) => model.slug));
  } catch {
    warnings.push(
      "Could not load bundled Codex model IDs; runtime catalog validation will still reject collisions.",
    );
    return new Set();
  }
}

export function validateCodexEndpoints({
  endpoints = [],
  officialIds = new Set(),
}) {
  const errors = [];
  const warnings = [];

  for (const [index, endpoint] of endpoints.entries()) {
    const label = `client 'codex' endpoint ${index + 1}`;
    if (!CODEX_PROVIDER_TYPES.has(endpoint.type)) {
      errors.push(`${label} has unsupported Codex type '${endpoint.type}'.`);
    }

    for (const id of [
      ...(endpoint.models || []),
      ...Object.keys(endpoint.model_mapping || {}),
    ]) {
      if (officialIds.has(id)) {
        errors.push(`${label} shadows official Codex model ID '${id}'.`);
      }
    }

    for (const modality of endpoint.capabilities?.input_modalities || ["text"]) {
      if (!["text", "image"].includes(modality)) {
        errors.push(`${label} has unsupported input modality '${modality}'.`);
      }
    }

    for (const key of ["reasoning", "tools"]) {
      const value = endpoint.capabilities?.[key];
      if (value != null && typeof value !== "boolean") {
        errors.push(`${label} capabilities.${key} must be boolean.`);
      }
    }
  }

  return { errors, warnings };
}

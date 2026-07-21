import { selectExposedEndpoints } from "../config/gateway-config-store.mjs";

const SUPPORTED_PROVIDER_TYPES = new Set([
  "anthropic",
  "openai-responses",
  "openai-chat",
  "grok",
]);

export class CodexCatalogError extends Error {
  constructor(code, modelId, message) {
    super(message);
    this.name = "CodexCatalogError";
    this.code = code;
    this.modelId = modelId;
  }
}

export function buildCodexCatalog({ officialModels = [], endpoints = [] }) {
  const officialCopies = officialModels.map((model) => {
    const copy = structuredClone(model);
    copy.supports_reasoning_summaries ??= true;
    return copy;
  });
  const officialIds = new Set(officialCopies.map((model) => model.slug));
  const customIds = new Set();
  const customModels = [];
  const reference = officialCopies[0] || fallbackReferenceModel();

  for (const endpoint of selectExposedEndpoints(endpoints)) {
    if (!SUPPORTED_PROVIDER_TYPES.has(endpoint?.type)) continue;
    const ids = [
      ...(Array.isArray(endpoint.models) ? endpoint.models : []),
      ...Object.keys(endpoint.model_mapping || {}),
    ];

    for (const rawId of ids) {
      const id = String(rawId || "").trim();
      if (!id || customIds.has(id)) continue;
      if (officialIds.has(id)) {
        throw new CodexCatalogError(
          "official_model_collision",
          id,
          `Configured Codex model '${id}' conflicts with an official Codex model ID.`,
        );
      }
      customIds.add(id);
      customModels.push(buildCustomModel(id, endpoint, reference));
    }
  }

  return {
    models: [...officialCopies, ...customModels],
    officialIds,
    customIds,
  };
}

function buildCustomModel(id, endpoint, reference) {
  const model = structuredClone(reference);
  delete model.model_messages;
  model.instructions_variables = {};
  model.slug = id;
  model.display_name = endpoint.display_names?.[id] || id;
  model.description = `${id} via ${endpoint.name || endpoint.type}.`;
  model.visibility = "list";
  model.supported_in_api = true;
  model.priority = 1000;
  model.owned_by = endpoint.name || "local-gateway";
  model.input_modalities = normalizeModalities(
    endpoint.capabilities?.input_modalities,
  );
  model.supports_reasoning_summaries = endpoint.capabilities?.reasoning === true;
  model.base_instructions =
    "You are Codex, a coding agent. Follow the active system and developer instructions.";
  model.support_verbosity ??= true;
  model.default_verbosity ??= "medium";
  return model;
}

function normalizeModalities(value) {
  const source = Array.isArray(value) ? value : ["text"];
  const result = source.filter((item) => item === "text" || item === "image");
  if (!result.includes("text")) result.unshift("text");
  return [...new Set(result)];
}

function fallbackReferenceModel() {
  return {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    supported_in_api: true,
    shell_type: "shell_command",
    input_modalities: ["text"],
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balanced reasoning" },
      { effort: "high", description: "More reasoning" },
    ],
  };
}

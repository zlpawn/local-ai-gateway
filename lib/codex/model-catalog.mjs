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
  model.display_name = endpoint.display_names?.[id] || formatPrettyDisplayName(id);
  model.description = `${id} via ${endpoint.name || endpoint.type}.`;
  model.visibility = "list";
  model.supported_in_api = true;
  model.priority = 1000;
  model.owned_by = endpoint.name || "local-gateway";
  model.input_modalities = normalizeModalities(
    endpoint.capabilities?.input_modalities,
  );
  model.supports_reasoning_summaries = endpoint.capabilities?.reasoning === true;
  model.base_instructions = reference.base_instructions ||
    "You are Codex, a coding agent. Follow the active system and developer instructions.";
  model.support_verbosity ??= true;
  model.default_verbosity ??= "medium";
  model.truncation_policy ??= reference.truncation_policy || {
    mode: "tokens",
    limit: 10000,
  };
  model.supports_parallel_tool_calls ??= reference.supports_parallel_tool_calls ?? true;
  model.supports_image_detail_original ??= reference.supports_image_detail_original ?? true;
  model.context_window ??= reference.context_window ?? 272000;
  model.max_context_window ??= reference.max_context_window ?? 272000;
  model.effective_context_window_percent ??= reference.effective_context_window_percent ?? 95;
  model.experimental_supported_tools ??= reference.experimental_supported_tools ?? [];
  model.supports_search_tool ??= reference.supports_search_tool ?? true;
  model.use_responses_lite ??= reference.use_responses_lite ?? false;
  return model;
}

function formatPrettyDisplayName(id) {
  if (!id) return "";
  if (id === "glm-5.2") return "GLM 5.2";
  if (id === "grok-4.5") return "Grok 4.5";
  if (id === "minimax-m3") return "MiniMax M3";
  if (id === "deepseek-v4-pro") return "DeepSeek V4 Pro";
  if (id === "claude-opus-4-8-max") return "Claude Opus 4.8 Max";
  if (id === "claude-opus-4-7-max") return "Claude Opus 4.7 Max";
  return id;
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
    description: "Frontier model for complex coding, research, and real-world work.",
    base_instructions:
      "You are Codex, a coding agent based on GPT-5. You and the user share the same workspace and collaborate to achieve the user's goals.",
    support_verbosity: true,
    default_verbosity: "medium",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balanced reasoning" },
      { effort: "high", description: "More reasoning" },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 7,
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 272000,
    max_context_window: 272000,
    comp_hash: "2911",
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
    use_responses_lite: false,
  };
}

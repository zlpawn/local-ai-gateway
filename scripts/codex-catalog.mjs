import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "gateway.config.json");
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, ".codex", "gateway-model-catalog.json");

const args = new Set(process.argv.slice(2));
const shouldVerify = args.has("--verify");
const shouldPrintConfig = args.has("--print-config") || !shouldVerify;

const configPath = path.resolve(process.env.GATEWAY_CONFIG_FILE || DEFAULT_CONFIG_PATH);
const outputPath = path.resolve(process.env.CODEX_MODEL_CATALOG_PATH || DEFAULT_OUTPUT_PATH);

const config = readJson(configPath);
const bundledModels = loadBundledCodexModels();
const officialModels = bundledModels.filter((model) => isOfficialCodexModel(model.slug));
const referenceModel = officialModels[0] || bundledModels[0] || fallbackReferenceModel();
const customModels = buildCustomModels(config, referenceModel);
const catalog = {
  generated_at: new Date().toISOString(),
  source: "volcengine-agent-plan-gateway",
  models: [...officialModels, ...customModels],
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(catalog, null, 2), "utf8");

console.log(`Wrote Codex model catalog: ${outputPath}`);
console.log(`Official models: ${officialModels.length}`);
console.log(`Custom models: ${customModels.length}`);
console.log(`Custom model ids: ${customModels.map((model) => model.slug).join(", ") || "(none)"}`);

if (shouldVerify) {
  verifyWithCodex(outputPath, customModels);
}

if (shouldPrintConfig) {
  printCodexConfigSnippet(outputPath, config);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Failed to read JSON ${filePath}: ${error.message}`);
  }
}

function loadBundledCodexModels() {
  try {
    const output = execFileSync("codex", ["debug", "models", "--bundled"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    const parsed = JSON.parse(output);
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch (error) {
    console.warn(`Warning: failed to read bundled Codex models: ${error.message}`);
    return [];
  }
}

function buildCustomModels(config, referenceModel) {
  const providers = config.providers || {};
  const models = Array.isArray(config.models)
    ? config.models
    : Object.entries(config.models || {}).map(([id, model]) => ({ id, ...model }));
  const seen = new Set();
  const customModels = [];

  for (const model of models) {
    const provider = providers[model.provider];
    if (!provider || !["openai-chat", "openai-responses"].includes(provider.type)) continue;

    const id = model.id || model.upstream_model || model.model;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    customModels.push(buildCustomModel(id, model.display_name || id, referenceModel));
  }

  return customModels;
}

function buildCustomModel(id, displayName, referenceModel) {
  const base = JSON.parse(JSON.stringify(referenceModel));
  delete base.model_messages;
  base.instructions_variables = {};

  return {
    ...base,
    slug: id,
    display_name: displayName,
    description: `${id} via Volcengine Ark gateway.`,
    visibility: "list",
    supported_in_api: true,
    priority: 1000,
    input_modalities: ["text"],
    owned_by: "volcengine",
    base_instructions: "You are Codex, a coding agent. Follow the active system and developer instructions.",
  };
}

function fallbackReferenceModel() {
  return {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "Official Codex fallback model",
    visibility: "list",
    supported_in_api: true,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balanced reasoning" },
      { effort: "high", description: "More reasoning" },
    ],
    shell_type: "shell_command",
    input_modalities: ["text"],
  };
}

function isOfficialCodexModel(slug) {
  return /^gpt-|^o\d/i.test(String(slug || ""));
}

function verifyWithCodex(catalogPath, customModels) {
  const codexArgs = [
    "debug",
    "models",
    "-c",
    `model_catalog_json=${JSON.stringify(toPosixPath(catalogPath))}`,
    "-c",
    "model_provider=\"custom\"",
    "-c",
    "model_providers.custom.name=\"Local AI Gateway\"",
    "-c",
    "model_providers.custom.base_url=\"http://127.0.0.1:8787/codex/v1\"",
    "-c",
    "model_providers.custom.wire_api=\"responses\"",
    "-c",
    "model_providers.custom.requires_openai_auth=true",
    "-c",
    "model_providers.custom.experimental_bearer_token=\"dummy\"",
  ];

  const output = execFileSync("codex", codexArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20000,
  });
  const parsed = JSON.parse(output);
  const modelIds = new Set((parsed.models || []).map((model) => model.slug));
  const missing = customModels.map((model) => model.slug).filter((id) => !modelIds.has(id));

  if (missing.length > 0) {
    throw new Error(`Codex verification failed. Missing custom models: ${missing.join(", ")}`);
  }

  console.log(`Codex verification passed. Effective models: ${(parsed.models || []).map((model) => model.slug).join(", ")}`);
}

function printCodexConfigSnippet(catalogPath, config) {
  const server = config.server || {};
  const host = server.host || "127.0.0.1";
  const port = Number(server.port) || 8787;
  const normalizedPath = toPosixPath(catalogPath);

  console.log("");
  console.log("Optional Codex config snippet for manual desktop testing:");
  console.log("Insert this before the first [section] in ~/.codex/config.toml so the first two keys stay top-level.");
  console.log("");
  console.log('model_provider = "custom"');
  console.log(`model_catalog_json = "${normalizedPath}"`);
  console.log(`openai_base_url = "http://${host}:${port}/codex/v1"`);
  console.log("");
  console.log("[model_providers.custom]");
  console.log('name = "Local AI Gateway"');
  console.log(`base_url = "http://${host}:${port}/codex/v1"`);
  console.log('wire_api = "responses"');
  console.log("requires_openai_auth = true");
  console.log('experimental_bearer_token = "dummy"');
  console.log("request_max_retries = 1");
  console.log("stream_max_retries = 1");
  console.log("stream_idle_timeout_ms = 600000");
}

function toPosixPath(filePath) {
  return path.resolve(filePath).replaceAll("\\", "/");
}

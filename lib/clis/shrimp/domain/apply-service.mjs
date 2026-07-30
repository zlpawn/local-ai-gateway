import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCodexCatalog } from "../../../codex/model-catalog.mjs";
import { unifyCodexHistory } from "../../../codex/history-unify.mjs";
import { syncClaudeCodeSettings } from "../../../config/claude-code-settings.mjs";
import { CliError } from "../protocol.mjs";
import { loadStateOrThrow, saveState } from "./config-service.mjs";

const SLOT_NAMES = ["opus", "sonnet", "haiku", "fable"];

function hostPort(config) {
  const server = config?.server || {};
  const host = server.host && server.host !== "0.0.0.0" ? server.host : "127.0.0.1";
  const port = Number(server.port) || 8787;
  return { host, port };
}

function toPosix(filePath) {
  return path.resolve(filePath).replaceAll("\\", "/");
}

function defaultCatalogPath() {
  return process.env.CODEX_MODEL_CATALOG_PATH
    || path.join(os.homedir(), ".codex", "gateway-model-catalog.json");
}

function loadBundledOfficialModels() {
  const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
  try {
    if (fs.existsSync(cachePath)) {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8").replace(/^\uFEFF/, ""));
      const models = Array.isArray(parsed.models)
        ? parsed.models
        : Array.isArray(parsed?.data)
          ? parsed.data
          : [];
      return models
        .filter((model) => model && /^(gpt-|o\d)/i.test(String(model.slug || model.id || "")))
        .map((model) => ({
          ...model,
          slug: model.slug || model.id,
          display_name: model.display_name || model.slug || model.id,
        }));
    }
  } catch {
    // ignore
  }
  return [];
}

export function getModelSlots({ configPath, secretsPath, client = "code" } = {}) {
  const state = loadStateOrThrow({ configPath, secretsPath });
  if (client !== "code") {
    throw new CliError({
      type: "validation",
      code: "unsupported_client",
      message: "Model slots are only supported for client=code",
    });
  }
  return {
    client,
    slots: state.config.clients?.code?.model_slots || {},
  };
}

export function setModelSlots({
  configPath,
  secretsPath,
  client = "code",
  slots = {},
  dryRun = false,
} = {}) {
  if (client !== "code") {
    throw new CliError({
      type: "validation",
      code: "unsupported_client",
      message: "Model slots are only supported for client=code",
    });
  }
  const state = loadStateOrThrow({ configPath, secretsPath });
  const current = state.config.clients?.code || { endpoints: [], model_slots: {} };
  const nextSlots = { ...(current.model_slots || {}) };
  for (const name of SLOT_NAMES) {
    if (slots[name] != null) nextSlots[name] = String(slots[name] || "").trim();
  }
  state.config.clients = {
    ...(state.config.clients || {}),
    code: { ...current, model_slots: nextSlots },
  };
  saveState({ configPath, secretsPath, config: state.config, secrets: state.secrets, dryRun });
  return { client, slots: nextSlots, dry_run: Boolean(dryRun) };
}

export function snippetForClient({ configPath, secretsPath, client }) {
  const state = loadStateOrThrow({ configPath, secretsPath });
  const { host, port } = hostPort(state.config);
  if (client === "code") {
    return {
      client,
      base_url: `http://${host}:${port}/code`,
      notes: [
        "Saving Claude Code endpoints can auto-sync ~/.claude/settings.json",
        "Or run: shrimp client apply --client code",
      ],
    };
  }
  if (client === "desktop") {
    return {
      client,
      base_url: `http://${host}:${port}/desktop`,
      notes: ["Gateway auto-syncs Claude Desktop third-party inference config on save when enabled"],
    };
  }
  if (client === "deeptutor") {
    return {
      client,
      llm_base_url: `http://${host}:${port}/deeptutor/`,
      embedding_base_url: `http://${host}:${port}/deeptutor/emb/embeddings`,
    };
  }
  if (client === "codex") {
    const catalogPath = defaultCatalogPath();
    return {
      client,
      catalog_path: catalogPath,
      snippet: [
        'model_provider = "custom"',
        `model_catalog_json = "${toPosix(catalogPath)}"`,
        `openai_base_url = "http://${host}:${port}/codex/v1"`,
        "",
        "[model_providers.custom]",
        'name = "Shrimp"',
        `base_url = "http://${host}:${port}/codex/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = true",
        'experimental_bearer_token = "dummy"',
      ].join("\n"),
      notes: [
        "Default apply writes catalog only; use --write-config --yes to mutate ~/.codex/config.toml",
      ],
    };
  }
  throw new CliError({
    type: "not_found",
    code: "client_not_found",
    message: `Unsupported client snippet: ${client}`,
  });
}

export function writeCodexCatalog({ configPath, secretsPath, outputPath } = {}) {
  const state = loadStateOrThrow({ configPath, secretsPath });
  const officialModels = loadBundledOfficialModels();
  const built = buildCodexCatalog({
    officialModels,
    endpoints: state.config.clients?.codex?.endpoints || [],
  });
  const catalogPath = path.resolve(outputPath || defaultCatalogPath());
  const catalog = {
    generated_at: new Date().toISOString(),
    source: "shrimp",
    models: built.models,
  };
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return {
    path: catalogPath,
    official_count: built.officialIds.size,
    custom_count: built.customIds.size,
  };
}

function upsertCodexConfigToml({ host, port, catalogPath, configTomlPath }) {
  const filePath = configTomlPath || path.join(os.homedir(), ".codex", "config.toml");
  const snippetTop = [
    'model_provider = "custom"',
    `model_catalog_json = "${toPosix(catalogPath)}"`,
    `openai_base_url = "http://${host}:${port}/codex/v1"`,
    "",
  ].join("\n");
  const snippetProvider = [
    "[model_providers.custom]",
    'name = "Shrimp"',
    `base_url = "http://${host}:${port}/codex/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    'experimental_bearer_token = "dummy"',
    "",
  ].join("\n");

  let text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  // crude but practical: if provider section exists, leave body and ensure top keys present
  if (!/^model_provider\s*=/m.test(text)) {
    text = `${snippetTop}${text}`;
  } else {
    text = text
      .replace(/^model_provider\s*=.*$/m, 'model_provider = "custom"')
      .replace(/^model_catalog_json\s*=.*$/m, `model_catalog_json = "${toPosix(catalogPath)}"`)
      .replace(/^openai_base_url\s*=.*$/m, `openai_base_url = "http://${host}:${port}/codex/v1"`);
  }
  if (!/\[model_providers\.custom\]/.test(text)) {
    text = `${text.trimEnd()}\n\n${snippetProvider}`;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const backup = fs.existsSync(filePath) ? `${filePath}.shrimp-backup` : null;
  if (backup) fs.copyFileSync(filePath, backup);
  fs.writeFileSync(filePath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  return { path: filePath, backup };
}

export function applyClient({
  configPath,
  secretsPath,
  client,
  writeConfig = false,
  yes = false,
  dryRun = false,
} = {}) {
  if (!client) {
    throw new CliError({
      type: "validation",
      code: "missing_fields",
      message: "client is required",
      fields: ["client"],
    });
  }
  const state = loadStateOrThrow({ configPath, secretsPath });
  if (client === "code") {
    if (dryRun) {
      return { client, dry_run: true, action: "syncClaudeCodeSettings" };
    }
    const result = syncClaudeCodeSettings({ config: state.config });
    return { client, ...result };
  }
  if (client === "desktop") {
    return {
      client,
      updated: false,
      reason: "desktop-auto-sync-on-gateway-save",
      snippet: snippetForClient({ configPath, secretsPath, client }),
    };
  }
  if (client === "deeptutor") {
    return {
      client,
      updated: false,
      reason: "deeptutor-is-url-only",
      snippet: snippetForClient({ configPath, secretsPath, client }),
    };
  }
  if (client === "codex") {
    if (dryRun) {
      return {
        client,
        dry_run: true,
        would_write_catalog: true,
        would_write_config: Boolean(writeConfig),
        snippet: snippetForClient({ configPath, secretsPath, client }),
      };
    }
    const catalog = writeCodexCatalog({ configPath, secretsPath });
    let configWrite = null;
    if (writeConfig) {
      if (!yes) {
        throw new CliError({
          type: "conflict",
          code: "confirmation_required",
          message: "Writing ~/.codex/config.toml requires --write-config --yes",
        });
      }
      const { host, port } = hostPort(state.config);
      configWrite = upsertCodexConfigToml({
        host,
        port,
        catalogPath: catalog.path,
      });
    }
    return {
      client,
      catalog,
      config_write: configWrite,
      snippet: snippetForClient({ configPath, secretsPath, client }),
    };
  }
  throw new CliError({
    type: "not_found",
    code: "client_not_found",
    message: `Unsupported client: ${client}`,
  });
}

export function unifyHistory({ apply = false, yes = false, dryRun = true, allowRunningCodex = false } = {}) {
  const effectiveDryRun = dryRun || !apply;
  if (apply && !yes && !effectiveDryRun) {
    throw new CliError({
      type: "conflict",
      code: "confirmation_required",
      message: "Applying Codex history unify requires --yes",
    });
  }
  return unifyCodexHistory({
    dryRun: effectiveDryRun,
    allowRunningCodex,
  });
}
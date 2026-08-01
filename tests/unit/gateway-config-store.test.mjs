import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GatewayConfigError,
  isCapabilityEndpoint,
  buildClaudeCodeModelRoutes,
  buildClaudeInferenceModels,
  getEndpointApiKey,
  loadGatewayState,
  copyClientEndpoints,
  saveGatewayState,
  selectExposedEndpoints,
  selectEmbeddingEndpoints,
  selectDefaultEmbeddingEndpoint,
  selectMediaEndpoints,
  selectDefaultMediaEndpoint,
  validateGatewayConfig,
} from "../../lib/config/gateway-config-store.mjs";

test("vision fallback endpoints are excluded from exposed model selection", () => {
  const endpoints = [
    { id: "normal", models: ["glm-5.2"] },
    {
      id: "vision",
      purpose: "vision_fallback",
      expose_models: true,
      models: ["vision-pro"],
    },
  ];
  assert.deepEqual(selectExposedEndpoints(endpoints).map((item) => item.id), ["normal"]);
});

test("load migrates legacy fields, adds stable ids, extracts keys, and creates a backup", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gateway-config-store-"));
  try {
    const configPath = path.join(root, "gateway.config.json");
    const secretsPath = path.join(root, "gateway.secrets.json");
    writeFileSync(configPath, JSON.stringify({
      server: { host: "127.0.0.1", port: 8787 },
      providers: {
        ark: {
          type: "anthropic",
          base_url: "https://example.test/v1",
          api_key_env: "ARK_API_KEY",
        },
      },
      models: [{
        id: "claude-public",
        provider: "ark",
        upstream_model: "glm-upstream",
        aliases: ["claude-alias"],
      }],
    }, null, 2));

    let counter = 0;
    const result = loadGatewayState({
      configPath,
      secretsPath,
      idFactory: () => `ep_test_${++counter}`,
    });

    assert.equal(result.migrated, true);
    assert.ok(result.backupPath);
    assert.equal(statSync(result.backupPath).isFile(), true);
    assert.deepEqual(Object.keys(result.config).sort(), ["clients", "server"]);
    assert.equal(result.config.clients.code.endpoints[0].id, "ep_test_1");
    assert.equal(result.config.clients.desktop.endpoints[0].id, "ep_test_2");
    assert.equal(result.config.clients.codex.endpoints[0].id, "ep_test_3");
    assert.equal("api_key" in result.config.clients.code.endpoints[0], false);
    assert.equal(result.secrets.api_keys.ep_test_1, "env:ARK_API_KEY");
    assert.equal(result.secrets.api_keys.ep_test_2, "env:ARK_API_KEY");
    assert.equal(result.secrets.api_keys.ep_test_3, "env:ARK_API_KEY");

    const persisted = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal("providers" in persisted, false);
    assert.equal("models" in persisted, false);
    assert.deepEqual(JSON.parse(readFileSync(secretsPath, "utf8")), result.secrets);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("save moves endpoint keys to secrets and does not rewrite unchanged files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gateway-config-save-"));
  try {
    const configPath = path.join(root, "gateway.config.json");
    const secretsPath = path.join(root, "gateway.secrets.json");
    const config = {
      server: { host: "127.0.0.1", port: 8787 },
      clients: {
        desktop: {
          endpoints: [{
            id: "ep_desktop",
            name: "Husky API",
            type: "openai-chat",
            base_url: "https://example.test/v1/chat/completions",
            api_key: "sk-secret",
            models: ["claude-public"],
            model_mapping: {},
          }],
        },
      },
    };

    const first = saveGatewayState({ configPath, secretsPath, config });
    assert.equal(first.config.clients.desktop.endpoints[0].api_key, undefined);
    assert.equal(first.secrets.api_keys.ep_desktop, "sk-secret");
    const configTime = statSync(configPath).mtimeMs;
    const secretsTime = statSync(secretsPath).mtimeMs;

    const second = saveGatewayState({
      configPath,
      secretsPath,
      config: first.config,
    });
    assert.equal(second.configChanged, false);
    assert.equal(second.secretsChanged, false);
    assert.equal(statSync(configPath).mtimeMs, configTime);
    assert.equal(statSync(secretsPath).mtimeMs, secretsTime);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("save rejects missing endpoint ids and removes secrets for deleted endpoints", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gateway-config-save-id-"));
  try {
    const configPath = path.join(root, "gateway.config.json");
    const secretsPath = path.join(root, "gateway.secrets.json");
    writeFileSync(secretsPath, JSON.stringify({
      api_keys: {
        ep_kept: "env:KEPT_KEY",
        ep_deleted: "sk-delete-me",
      },
    }));

    assert.throws(
      () => saveGatewayState({
        configPath,
        secretsPath,
        config: {
          clients: {
            desktop: {
              endpoints: [{ name: "Missing ID", api_key: "sk-secret" }],
            },
          },
        },
      }),
      (error) =>
        error instanceof GatewayConfigError &&
        error.issues.some((issue) => issue.code === "missing_endpoint_id"),
    );

    const result = saveGatewayState({
      configPath,
      secretsPath,
      config: {
        clients: {
          desktop: {
            endpoints: [{ id: "ep_kept", name: "Kept" }],
          },
        },
      },
    });
    assert.deepEqual(result.secrets, { api_keys: { ep_kept: "env:KEPT_KEY" } });
    assert.deepEqual(JSON.parse(readFileSync(secretsPath, "utf8")), result.secrets);

    const empty = saveGatewayState({
      configPath,
      secretsPath,
      config: { clients: { desktop: { endpoints: [] } } },
    });
    assert.deepEqual(empty.secrets, { api_keys: {} });
    assert.deepEqual(JSON.parse(readFileSync(secretsPath, "utf8")), empty.secrets);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential lookup resolves literal and environment-backed endpoint secrets", () => {
  const secrets = {
    api_keys: {
      ep_literal: "sk-secret",
      ep_env: "env:ARK_API_KEY",
    },
  };
  assert.equal(getEndpointApiKey({ id: "ep_literal" }, secrets, {}), "sk-secret");
  assert.equal(
    getEndpointApiKey({ id: "ep_env" }, secrets, { ARK_API_KEY: "ark-secret" }),
    "ark-secret",
  );
  assert.equal(getEndpointApiKey({ id: "ep_missing" }, secrets, {}), "");
});

test("exposure selection uses explicit nodes, or all nodes when none are selected", () => {
  const endpoints = [
    { id: "ep_a", expose_models: false },
    { id: "ep_b", expose_models: true },
    { id: "ep_c" },
  ];
  assert.deepEqual(selectExposedEndpoints(endpoints).map((item) => item.id), ["ep_b"]);
  assert.deepEqual(
    selectExposedEndpoints(endpoints.map(({ expose_models, ...item }) => item)).map((item) => item.id),
    ["ep_a", "ep_b", "ep_c"],
  );
});

test("Desktop validation suggests Claude version names for public model collisions", () => {
  const config = {
    server: { host: "127.0.0.1", port: 8787 },
    clients: {
      desktop: {
        endpoints: [
          {
            id: "ep_same",
            name: "火山 引擎",
            is_default: true,
            models: ["glm-5.2"],
            model_mapping: { "claude-opus-4-7": "glm-5.2" },
          },
          {
            id: "ep_same",
            name: "Husky API",
            is_default: true,
            models: ["claude-opus-4-7"],
            model_mapping: { "claude-opus-4-7": "claude-opus-4-7" },
          },
        ],
      },
    },
  };

  const issues = validateGatewayConfig(config);
  assert.ok(issues.some((issue) => issue.code === "duplicate_endpoint_id"));
  assert.ok(issues.some((issue) => issue.code === "multiple_default_endpoints"));
  const conflicts = issues.filter((issue) => issue.code === "duplicate_public_model");
  assert.deepEqual(conflicts.map((issue) => issue.model_id), ["claude-opus-4-7"]);
  assert.deepEqual(
    conflicts[0].occurrences.map((occurrence) => occurrence.suggestion),
    ["claude-opus-4-7", "claude-opus-4-6"],
  );
  assert.equal(
    conflicts[0].occurrences.some((occurrence) =>
      /husky|火山|endpoint|ep_/i.test(occurrence.suggestion)),
    false,
  );

  assert.throws(
    () => saveGatewayState({
      configPath: path.join(os.tmpdir(), "unused-config.json"),
      secretsPath: path.join(os.tmpdir(), "unused-secrets.json"),
      config,
    }),
    GatewayConfigError,
  );
});

test("Desktop validation checks mapping keys but permits third-party upstream model lists", () => {
  const issues = validateGatewayConfig({
    clients: {
      desktop: {
        endpoints: [{
          id: "ep_desktop",
          name: "Third Party",
          models: ["glm-5.2"],
          model_mapping: {
            "minimax-m3": "minimax-m3",
            "claude-sonnet-4-6": "deepseek-v4-pro",
          },
        }],
      },
    },
  });

  const invalid = issues.filter((issue) => issue.code === "invalid_claude_model_name");
  assert.deepEqual(invalid.map((issue) => issue.model_id), ["minimax-m3"]);
  assert.equal(
    invalid.every((issue) => /^claude-(?:opus|sonnet|haiku|fable)-\d+(?:-\d+)*$/.test(issue.suggestion)),
    true,
  );
});

test("validation rejects Codex custom models that collide with official ids", () => {
  const issues = validateGatewayConfig({
    clients: {
      codex: {
        endpoints: [{
          id: "ep_codex",
          name: "Custom",
          models: ["gpt-5.6"],
          model_mapping: {},
        }],
      },
    },
  }, { officialCodexIds: new Set(["gpt-5.6"]) });

  assert.ok(issues.some((issue) => issue.code === "official_model_collision"));
});

test("load permits legacy model conflicts so users can resolve them through the UI", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gateway-conflict-load-"));
  try {
    const configPath = path.join(root, "gateway.config.json");
    writeFileSync(configPath, JSON.stringify({
      clients: {
        desktop: {
          endpoints: [{
            name: "Legacy",
            models: ["shared"],
            model_mapping: { shared: "upstream" },
            api_key_env: "TEST_KEY",
          }],
        },
      },
    }));
    const state = loadGatewayState({
      configPath,
      secretsPath: path.join(root, "gateway.secrets.json"),
      idFactory: () => "ep_legacy",
    });
    assert.equal(state.config.clients.desktop.endpoints[0].id, "ep_legacy");
    assert.equal(state.secrets.api_keys.ep_legacy, "env:TEST_KEY");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude model aggregation keeps only valid distinct Claude public names", () => {
  const models = buildClaudeInferenceModels([
    {
      models: ["glm-5.2", "claude-opus-4-7"],
      model_mapping: {
        "claude-sonnet-4-6": "deepseek-v4-pro",
        "claude-sonnet-4-5": "deepseek-v4-pro",
        "claude-sonnet-husky": "deepseek-v4-pro",
      },
    },
  ]);
  assert.deepEqual(models.map((model) => model.name), [
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
  ]);
});

test("Claude Code model slots must reference models on the default endpoint", () => {
  const issues = validateGatewayConfig({
    clients: {
      code: {
        model_slots: {
          opus: "minimax-m3",
          sonnet: "missing-model",
        },
        endpoints: [{
          id: "ep_code",
          name: "code-default",
          is_default: true,
          models: ["minimax-m3", "glm-5.2"],
          model_mapping: {},
        }],
      },
    },
  });

  assert.deepEqual(
    issues.filter((issue) => issue.code === "invalid_claude_code_model_slot"),
    [{
      code: "invalid_claude_code_model_slot",
      client: "code",
      slot: "sonnet",
      model_id: "missing-model",
      endpoint_id: "ep_code",
      message: "Claude Code model slot 'sonnet' must reference a model exposed by the default endpoint.",
    }],
  );
});

test("Claude Code generated routes use mappings before same-named upstream models", () => {
  const result = buildClaudeCodeModelRoutes([{
    id: "ep_code",
    name: "code-node",
    models: ["public-model", "upstream-model"],
    model_mapping: {
      "public-model": "upstream-model",
    },
  }]);

  assert.deepEqual(result.models.map((model) => model.display_name), [
    "public-model",
    "upstream-model",
  ]);
  assert.equal(
    result.routes.get("anthropic.gateway.ep_code.public-model").upstream_model,
    "upstream-model",
  );
});

test("embedding endpoints are excluded from exposed model selection", () => {
  const endpoints = [
    { id: "normal", models: ["glm-5.2"] },
    {
      id: "embed",
      purpose: "embedding",
      expose_models: true,
      models: ["text-embedding-3-small"],
    },
  ];
  assert.deepEqual(selectExposedEndpoints(endpoints).map((item) => item.id), ["normal"]);
});

test("selectDefaultEmbeddingEndpoint selects default or first enabled embedding node", () => {
  const endpoints = [
    { id: "ep1", purpose: "embedding", enabled: true, is_default: false },
    { id: "ep2", purpose: "embedding", enabled: true, is_default: true },
  ];
  assert.equal(selectDefaultEmbeddingEndpoint(endpoints)?.id, "ep2");
});

test("validateGatewayConfig checks embedding endpoints for default uniqueness and model selection", () => {
  const duplicateDefaults = {
    clients: {
      codex: {
        endpoints: [
          { id: "ep1", purpose: "embedding", is_default: true, models: ["bge-m3"] },
          { id: "ep2", purpose: "embedding", is_default: true, models: ["bge-m3"] },
        ],
      },
    },
  };
  const issues1 = validateGatewayConfig(duplicateDefaults);
  assert.ok(issues1.some((issue) => issue.code === "multiple_default_embedding_endpoints"));

  const invalidModel = {
    clients: {
      codex: {
        endpoints: [
          { id: "ep1", purpose: "embedding", embedding_model: "invalid-model", models: ["bge-m3"] },
        ],
      },
    },
  };
  const issues2 = validateGatewayConfig(invalidModel);
  assert.ok(issues2.some((issue) => issue.code === "invalid_embedding_model"));

  const invalidType = {
    clients: {
      codex: {
        endpoints: [{
          id: "ep1",
          purpose: "embedding",
          type: "anthropic",
          embedding_model: "bge-m3",
          models: ["bge-m3"],
        }],
      },
    },
  };
  const issues3 = validateGatewayConfig(invalidType);
  assert.ok(issues3.some((issue) => issue.code === "unsupported_embedding_endpoint_type"));

  const missingBaseUrl = {
    clients: {
      codex: {
        endpoints: [{
          id: "ep1",
          purpose: "embedding",
          type: "openai-chat",
          embedding_model: "bge-m3",
          models: ["bge-m3"],
        }],
      },
    },
  };
  const issues4 = validateGatewayConfig(missingBaseUrl);
  assert.ok(issues4.some((issue) => issue.code === "missing_embedding_base_url"));
});
test("copyClientEndpoints clones endpoints with fresh ids and copies secrets", () => {
  const config = {
    clients: {
      codex: { endpoints: [
        { id: "ep_a", name: "ait", type: "openai-chat", base_url: "https://x", models: ["m1"], model_mapping: {}, capabilities: { reasoning: true } },
        { id: "ep_b", name: "tavily", purpose: "web_search", provider: "tavily", enabled: true, is_default: true, options: {} },
      ] },
    },
  };
  const secrets = { api_keys: { ep_a: "sk-secret-a", ep_b: "tvly-x" } };
  let counter = 0;
  const idFactory = () => "ep_new_" + (++counter);
  const result = copyClientEndpoints({ config, secrets, from: "codex", to: "deeptutor", idFactory });
  assert.equal(result.copied, 2);
  const dt = result.config.clients.deeptutor.endpoints;
  assert.equal(dt.length, 2);
  assert.deepEqual(dt.map((e) => e.id), ["ep_new_1", "ep_new_2"]);
  assert.equal(dt[0].name, "ait");
  assert.equal(dt[0].capabilities.reasoning, true);
  assert.equal(dt[1].purpose, "web_search");
  // secrets copied to new ids
  assert.equal(result.secrets.api_keys["ep_new_1"], "sk-secret-a");
  assert.equal(result.secrets.api_keys["ep_new_2"], "tvly-x");
  // original ids untouched and original client still present
  assert.equal(result.secrets.api_keys.ep_a, "sk-secret-a");
  assert.ok(result.config.clients.codex.endpoints.length, 2);
  // cloning does not share references with source
  assert.notEqual(dt[0], config.clients.codex.endpoints[0]);
});

test("loadGatewayState seeds DeepTutor from Codex with copied secrets on first load", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gw-deeptutor-"));
  try {
    const configPath = path.join(dir, "gateway.config.json");
    const secretsPath = path.join(dir, "gateway.secrets.json");
    writeFileSync(configPath, JSON.stringify({
      server: { host: "127.0.0.1", port: 8787 },
      clients: {
        code: { endpoints: [] },
        desktop: { endpoints: [] },
        codex: { endpoints: [
          { id: "ep_codex_1", name: "ait", type: "openai-chat", base_url: "https://x", models: ["m1"], model_mapping: {} },
        ] },
      },
    }));
    writeFileSync(secretsPath, JSON.stringify({ api_keys: { ep_codex_1: "sk-codex" } }));

    const state = loadGatewayState({ configPath, secretsPath });
    assert.ok(state.config.clients.deeptutor, "deeptutor client should be seeded");
    const dt = state.config.clients.deeptutor.endpoints;
    assert.equal(dt.length, 1);
    assert.equal(dt[0].name, "ait");
    assert.notEqual(dt[0].id, "ep_codex_1", "deeptutor endpoint must get a fresh id");
    assert.equal(state.secrets.api_keys[dt[0].id], "sk-codex", "secret copied to new id");
    assert.equal(state.secrets.api_keys.ep_codex_1, "sk-codex", "original codex secret preserved");
    assert.ok(state.migrated, "seeding should mark the state as migrated");

    // Second load does not re-seed: deeptutor already present, ids stable.
    const state2 = loadGatewayState({ configPath, secretsPath });
    assert.equal(state2.config.clients.deeptutor.endpoints[0].id, dt[0].id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadGatewayState does not seed DeepTutor when Codex has no endpoints", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gw-deeptutor-empty-"));
  try {
    const configPath = path.join(dir, "gateway.config.json");
    writeFileSync(configPath, JSON.stringify({
      server: { host: "127.0.0.1", port: 8787 },
      clients: { code: { endpoints: [] }, desktop: { endpoints: [] }, codex: { endpoints: [] } },
    }));
    const state = loadGatewayState({ configPath });
    assert.ok(!state.config.clients.deeptutor, "deeptutor should not be seeded from empty codex");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("buildClaudeInferenceModels derives supports1m from configured context_window", () => {
  const models = buildClaudeInferenceModels([
    {
      model_mapping: {
        "claude-opus-4-8": "glm-5.2",
        "claude-opus-4-7": "grok-4.5",
        "claude-opus-4-6": "some-small-model",
      },
      model_capabilities: {
        "glm-5.2": { context_window: 1000000 },
        "grok-4.5": { context_window: 500000 },
        "some-small-model": { context_window: 128000 },
      },
    },
  ]);
  const glm = models.find((m) => m.name === "claude-opus-4-8");
  const grok = models.find((m) => m.name === "claude-opus-4-7");
  const small = models.find((m) => m.name === "claude-opus-4-6");
  assert.equal(glm.supports1m, true);
  assert.equal(grok.supports1m, false);
  assert.equal(small.supports1m, false);
});

test("buildClaudeInferenceModels defaults supports1m to true when context_window unconfigured", () => {
  const models = buildClaudeInferenceModels([
    {
      model_mapping: {
        "claude-opus-4-8": "glm-5.2",
      },
    },
  ]);
  const model = models.find((m) => m.name === "claude-opus-4-8");
  assert.equal(model.supports1m, true);
});

test("validateGatewayConfig rejects invalid context_window values", () => {
  const issues = validateGatewayConfig({
    clients: {
      codex: {
        endpoints: [{
          id: "ep1",
          name: "test",
          is_default: true,
          models: ["glm-5.2", "grok-4.5"],
          model_capabilities: {
            "glm-5.2": { context_window: 0 },
            "grok-4.5": { context_window: "big" },
          },
        }],
      },
    },
  });
  const ctxIssues = issues.filter((i) => i.code === "invalid_context_window");
  assert.equal(ctxIssues.length, 2);
  assert.equal(ctxIssues.some((i) => i.model_id === "glm-5.2"), true);
  assert.equal(ctxIssues.some((i) => i.model_id === "grok-4.5"), true);
});

test("validateGatewayConfig accepts valid positive integer context_window", () => {
  const issues = validateGatewayConfig({
    clients: {
      codex: {
        endpoints: [{
          id: "ep1",
          name: "test",
          is_default: true,
          models: ["glm-5.2"],
          model_capabilities: {
            "glm-5.2": { context_window: 1000000 },
          },
        }],
      },
    },
  });
  const ctxIssues = issues.filter((i) => i.code === "invalid_context_window");
  assert.equal(ctxIssues.length, 0);
});

test("media generation endpoints are capability endpoints", () => {
  assert.ok(isCapabilityEndpoint({ purpose: "image_generation" }));
  assert.ok(isCapabilityEndpoint({ purpose: "video_generation" }));
  assert.ok(isCapabilityEndpoint({ purpose: "audio_tts" }));
});

test("selectMediaEndpoints filters by purpose", () => {
  const endpoints = [
    { id: "ep1", purpose: "image_generation", provider: "grok-subscription", models: ["m1"] },
    { id: "ep2", purpose: "video_generation", provider: "huoshan-agentplan", models: ["m2"] },
    { id: "ep3", purpose: "chat" },
  ];
  assert.deepEqual(selectMediaEndpoints(endpoints, "image_generation").map((e) => e.id), ["ep1"]);
  assert.deepEqual(selectMediaEndpoints(endpoints, "video_generation").map((e) => e.id), ["ep2"]);
});

test("selectDefaultMediaEndpoint prefers is_default", () => {
  const endpoints = [
    { id: "ep1", purpose: "image_generation", provider: "grok-subscription" },
    { id: "ep2", purpose: "image_generation", provider: "huoshan-agentplan", is_default: true },
  ];
  assert.equal(selectDefaultMediaEndpoint(endpoints, "image_generation").id, "ep2");
});

test("validateGatewayConfig rejects media endpoint with unsupported provider", () => {
  const config = {
    server: { host: "127.0.0.1", port: 8787 },
    clients: { codex: { endpoints: [
      { id: "ep1", purpose: "image_generation", provider: "unknown-provider", models: ["m1"] },
    ] } },
  };
  const issues = validateGatewayConfig(config);
  assert.ok(issues.some((i) => i.code === "unsupported_media_provider"));
});

test("validateGatewayConfig rejects provider/purpose mismatch", () => {
  const config = {
    server: { host: "127.0.0.1", port: 8787 },
    clients: { codex: { endpoints: [
      { id: "ep1", purpose: "video_generation", provider: "codex-subscription", models: ["m1"] },
    ] } },
  };
  const issues = validateGatewayConfig(config);
  assert.ok(issues.some((i) => i.code === "media_provider_purpose_mismatch"));
});

test("validateGatewayConfig rejects multiple defaults for same media purpose", () => {
  const config = {
    server: { host: "127.0.0.1", port: 8787 },
    clients: { codex: { endpoints: [
      { id: "ep1", purpose: "image_generation", provider: "grok-subscription", is_default: true },
      { id: "ep2", purpose: "image_generation", provider: "huoshan-agentplan", is_default: true },
    ] } },
  };
  const issues = validateGatewayConfig(config);
  assert.ok(issues.some((i) => i.code === "multiple_default_media_endpoints"));
});

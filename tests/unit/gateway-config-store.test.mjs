import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GatewayConfigError,
  buildClaudeCodeModelRoutes,
  buildClaudeInferenceModels,
  getEndpointApiKey,
  loadGatewayState,
  saveGatewayState,
  selectExposedEndpoints,
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

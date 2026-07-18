import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GatewayConfigError,
  getEndpointApiKey,
  loadGatewayState,
  saveGatewayState,
  selectExposedEndpoints,
  validateGatewayConfig,
} from "../lib/config/gateway-config-store.mjs";

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

test("validation rejects duplicate ids, defaults, and every public model collision with suggestions", () => {
  const config = {
    server: { host: "127.0.0.1", port: 8787 },
    clients: {
      desktop: {
        endpoints: [
          {
            id: "ep_same",
            name: "火山 引擎",
            is_default: true,
            models: ["glm-5.2", "shared"],
            model_mapping: { alias: "glm-5.2", shared: "other" },
          },
          {
            id: "ep_same",
            name: "Husky API",
            is_default: true,
            models: ["glm-5.2"],
            model_mapping: { alias: "other" },
          },
        ],
      },
    },
  };

  const issues = validateGatewayConfig(config);
  assert.ok(issues.some((issue) => issue.code === "duplicate_endpoint_id"));
  assert.ok(issues.some((issue) => issue.code === "multiple_default_endpoints"));
  const conflicts = issues.filter((issue) => issue.code === "duplicate_public_model");
  assert.deepEqual(conflicts.map((issue) => issue.model_id).sort(), ["alias", "glm-5.2", "shared"]);
  const glm = conflicts.find((issue) => issue.model_id === "glm-5.2");
  assert.match(glm.occurrences[0].suggestion, /^glm-5\.2-/);
  assert.match(glm.occurrences[1].suggestion, /^glm-5\.2-husky-api/);

  assert.throws(
    () => saveGatewayState({
      configPath: path.join(os.tmpdir(), "unused-config.json"),
      secretsPath: path.join(os.tmpdir(), "unused-secrets.json"),
      config,
    }),
    GatewayConfigError,
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

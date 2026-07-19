import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCodexCatalog,
  CodexCatalogError,
} from "../lib/codex/model-catalog.mjs";
import {
  loadOfficialCodexIds,
  validateCodexEndpoints,
} from "../lib/codex/config-validation.mjs";

const officialModels = [{
  slug: "gpt-5.5",
  display_name: "GPT-5.5",
  shell_type: "shell_command",
  input_modalities: ["text", "image"],
  supported_in_api: true,
}];

test("catalog merges Responses, Chat, Anthropic, and Grok models under independent IDs", () => {
  const result = buildCodexCatalog({
    officialModels,
    endpoints: [
      {
        name: "responses",
        type: "openai-responses",
        models: ["glm-5.2"],
        capabilities: {
          input_modalities: ["text", "image"],
          reasoning: true,
          tools: true,
        },
      },
      {
        name: "chat",
        type: "openai-chat",
        model_mapping: { "openrouter-qwen3-coder": "qwen/qwen3-coder" },
      },
      {
        name: "grok",
        type: "grok",
        models: ["grok-4.5"],
      },
      {
        name: "anthropic",
        type: "anthropic",
        models: ["claude-sonnet"],
      },
    ],
  });

  assert.deepEqual(result.models.map((model) => model.slug), [
    "gpt-5.5",
    "glm-5.2",
    "openrouter-qwen3-coder",
    "grok-4.5",
    "claude-sonnet",
  ]);
  assert.deepEqual(result.models[1].input_modalities, ["text", "image"]);
  assert.equal(result.officialIds.has("gpt-5.5"), true);
  assert.equal(result.customIds.has("grok-4.5"), true);
});

test("catalog fills the required reasoning summaries flag for every model", () => {
  const result = buildCodexCatalog({
    officialModels,
    endpoints: [{
      name: "chat",
      type: "openai-chat",
      models: ["custom-chat"],
      capabilities: { reasoning: false },
    }],
  });

  assert.equal(result.models[0].supports_reasoning_summaries, true);
  assert.equal(result.models[1].supports_reasoning_summaries, false);
});

test("catalog uses exposed endpoints, or every endpoint when none opt in", () => {
  const hidden = {
    name: "hidden",
    type: "openai-chat",
    models: ["hidden-model"],
  };
  const exposed = {
    name: "exposed",
    type: "openai-chat",
    expose_models: true,
    models: ["exposed-model"],
  };

  const selected = buildCodexCatalog({
    officialModels,
    endpoints: [hidden, exposed],
  });
  assert.deepEqual(selected.models.map((model) => model.slug), [
    "gpt-5.5",
    "exposed-model",
  ]);

  const fallback = buildCodexCatalog({
    officialModels,
    endpoints: [hidden, { ...exposed, expose_models: false }],
  });
  assert.deepEqual(fallback.models.map((model) => model.slug), [
    "gpt-5.5",
    "hidden-model",
    "exposed-model",
  ]);
});

test("catalog rejects a configured model that shadows an official ID", () => {
  assert.throws(
    () => buildCodexCatalog({
      officialModels,
      endpoints: [{
        name: "chat",
        type: "openai-chat",
        models: ["gpt-5.5"],
      }],
    }),
    (error) => {
      assert.equal(error instanceof CodexCatalogError, true);
      assert.equal(error.code, "official_model_collision");
      assert.equal(error.modelId, "gpt-5.5");
      return true;
    },
  );
});

test("config validation rejects official model and mapping collisions", () => {
  const result = validateCodexEndpoints({
    endpoints: [{
      name: "chat",
      type: "openai-chat",
      models: ["gpt-5.5"],
      model_mapping: { "gpt-5.6": "upstream-model" },
    }],
    officialIds: new Set(["gpt-5.5", "gpt-5.6"]),
  });

  assert.equal(
    result.errors.filter((error) => error.includes("official Codex model ID")).length,
    2,
  );
});

test("config validation accepts Anthropic and rejects unknown Codex types and capability values", () => {
  const result = validateCodexEndpoints({
    endpoints: [
      {
        type: "anthropic",
        capabilities: {
          input_modalities: ["text", "image"],
          reasoning: false,
          tools: true,
        },
      },
      {
        type: "unknown",
        capabilities: {
          input_modalities: ["text", "audio"],
          reasoning: "yes",
          tools: 1,
        },
      },
    ],
  });

  assert.equal(result.errors.some((error) => error.includes("unsupported Codex type 'anthropic'")), false);
  assert.equal(result.errors.some((error) => error.includes("unsupported Codex type")), true);
  assert.equal(result.errors.some((error) => error.includes("unsupported input modality")), true);
  assert.equal(result.errors.some((error) => error.includes("capabilities.reasoning must be boolean")), true);
  assert.equal(result.errors.some((error) => error.includes("capabilities.tools must be boolean")), true);
});

test("official Codex ID loading uses the bundled command and bounded timeout", () => {
  let invocation;
  const warnings = [];
  const ids = loadOfficialCodexIds({
    warnings,
    execFile(command, args, options) {
      invocation = { command, args, options };
      return JSON.stringify({ models: [{ slug: "gpt-5.5" }] });
    },
  });

  assert.deepEqual([...ids], ["gpt-5.5"]);
  assert.equal(invocation.command, "codex");
  assert.deepEqual(invocation.args, ["debug", "models", "--bundled"]);
  assert.equal(invocation.options.timeout, 15_000);
  assert.deepEqual(invocation.options.stdio, ["ignore", "pipe", "ignore"]);
  assert.deepEqual(warnings, []);
});

test("official Codex ID loading falls back to a warning without leaking errors", () => {
  const warnings = [];
  const sentinel = "sk-task7-must-not-leak";
  const ids = loadOfficialCodexIds({
    warnings,
    execFile() {
      throw new Error(`failed with ${sentinel}`);
    },
  });

  assert.deepEqual([...ids], []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes("Could not load bundled Codex model IDs"), true);
  assert.equal(warnings.join("\n").includes(sentinel), false);
});

test("validate-config continues after official ID lookup failure without leaking api keys", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "codex-config-validation-"));
  const configPath = path.join(tempDir, "gateway.config.json");
  const sentinel = "sk-task7-config-must-not-leak";
  writeFileSync(configPath, JSON.stringify({
    clients: {
      codex: {
        endpoints: [{
          type: "openai-chat",
          base_url: "https://example.invalid/chat/completions",
          api_key: sentinel,
          capabilities: {
            input_modalities: ["audio"],
            reasoning: "yes",
            tools: true,
          },
        }],
      },
    },
  }));

  try {
    const result = spawnSync(
      process.execPath,
      ["scripts/validate-config.mjs", configPath],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: { ...process.env, PATH: tempDir },
        timeout: 5_000,
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 1);
    assert.equal(output.includes("Could not load bundled Codex model IDs"), true);
    assert.equal(output.includes("unsupported input modality"), true);
    assert.equal(output.includes("capabilities.reasoning must be boolean"), true);
    assert.equal(output.includes(sentinel), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

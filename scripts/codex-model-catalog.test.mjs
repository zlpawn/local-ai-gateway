import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexCatalog,
  CodexCatalogError,
} from "../lib/codex/model-catalog.mjs";

const officialModels = [{
  slug: "gpt-5.5",
  display_name: "GPT-5.5",
  shell_type: "shell_command",
  input_modalities: ["text", "image"],
  supported_in_api: true,
}];

test("catalog merges Responses, Chat, and Grok models under independent IDs", () => {
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
        name: "ignored",
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
  ]);
  assert.deepEqual(result.models[1].input_modalities, ["text", "image"]);
  assert.equal(result.officialIds.has("gpt-5.5"), true);
  assert.equal(result.customIds.has("grok-4.5"), true);
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

import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_CLAUDE_OFFICIAL_MODELS,
  mergeClaudeOfficialModels,
} from "../../lib/config/claude-official-models.mjs";

test("mergeClaudeOfficialModels unions builtin and user models", () => {
  const models = mergeClaudeOfficialModels({ userModels: ["claude-opus-4-8", "my-claude"] });
  assert.ok(models.includes("claude-opus-4-8"));
  assert.ok(models.includes("my-claude"));
  assert.ok(models.length >= BUILTIN_CLAUDE_OFFICIAL_MODELS.length);
});

test("mergeClaudeOfficialModels de-duplicates", () => {
  const models = mergeClaudeOfficialModels({ userModels: ["claude-sonnet-4-5", "claude-sonnet-4-5"] });
  assert.equal(models.filter((x) => x === "claude-sonnet-4-5").length, 1);
});

test("builtin Claude official models prefer versioned ids", () => {
  assert.ok(BUILTIN_CLAUDE_OFFICIAL_MODELS.every((id) => /claude-(opus|sonnet|haiku)-\d/.test(id)));
  assert.ok(!BUILTIN_CLAUDE_OFFICIAL_MODELS.includes("claude-sonnet"));
  assert.ok(!BUILTIN_CLAUDE_OFFICIAL_MODELS.includes("claude-opus"));
  assert.ok(!BUILTIN_CLAUDE_OFFICIAL_MODELS.includes("claude-haiku"));
  assert.ok(!BUILTIN_CLAUDE_OFFICIAL_MODELS.includes("claude-fable"));
});

test("availableClaudeDesktopMappingSources excludes all desktop chat mappings", async () => {
  const { availableClaudeDesktopMappingSources } = await import("../../lib/config/claude-official-models.mjs");
  const models = availableClaudeDesktopMappingSources({
    clients: {
      desktop: {
        endpoints: [
          {
            purpose: "chat",
            model_mapping: {
              "claude-opus-4-8": "glm-5.2",
              "claude-opus-4-7": "minimax-m3",
            },
          },
          {
            purpose: "chat",
            model_mapping: {
              "claude-sonnet-4-5": "deepseek-v4-pro",
            },
          },
          {
            purpose: "image_generation",
            model_mapping: {
              "claude-haiku-4-0": "should-not-count",
            },
          },
        ],
      },
    },
  });
  assert.ok(!models.includes("claude-opus-4-8"));
  assert.ok(!models.includes("claude-opus-4-7"));
  assert.ok(!models.includes("claude-sonnet-4-5"));
  assert.ok(models.includes("claude-haiku-4-0"));
});


test("builtin Claude official models do not include date suffixes", () => {
  assert.ok(BUILTIN_CLAUDE_OFFICIAL_MODELS.every((id) => !/\d{8}$/.test(id)));
  assert.ok(BUILTIN_CLAUDE_OFFICIAL_MODELS.includes("claude-haiku-4-5"));
});

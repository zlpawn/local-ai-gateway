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
  const models = mergeClaudeOfficialModels({ userModels: ["claude-sonnet", "claude-sonnet"] });
  assert.equal(models.filter((x) => x === "claude-sonnet").length, 1);
});

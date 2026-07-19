import assert from "node:assert/strict";
import test from "node:test";
import {
  isOfficialCodexModelId,
  mergeOfficialDiscoveryModels,
  officialModelsFromOpenAIList,
} from "../../lib/codex/official-models.mjs";

test("official model id matcher accepts gpt and o-series only", () => {
  assert.equal(isOfficialCodexModelId("gpt-5.5"), true);
  assert.equal(isOfficialCodexModelId("o3"), true);
  assert.equal(isOfficialCodexModelId("o4-mini"), true);
  assert.equal(isOfficialCodexModelId("grok-4.5"), false);
  assert.equal(isOfficialCodexModelId("claude-sonnet"), false);
});

test("merge keeps bundled rows and adds live-only official ids", () => {
  const merged = mergeOfficialDiscoveryModels(
    [{ id: "gpt-5.5", display_name: "GPT-5.5", owned_by: "openai" }],
    [
      { id: "gpt-5.5", display_name: "should-not-overwrite" },
      { id: "gpt-5.6", display_name: "GPT-5.6" },
      { id: "grok-4.5", display_name: "ignore" },
    ],
  );

  assert.deepEqual(merged.map((model) => model.id), ["gpt-5.5", "gpt-5.6"]);
  assert.equal(merged[0].display_name, "GPT-5.5");
  assert.equal(merged[1].display_name, "GPT-5.6");
});

test("OpenAI /v1/models payload is filtered to official-looking ids", () => {
  const models = officialModelsFromOpenAIList({
    data: [
      { id: "gpt-5.6", created: 1, owned_by: "openai" },
      { id: "o3", created: 2, owned_by: "openai" },
      { id: "whisper-1", created: 3, owned_by: "openai" },
      { id: "text-embedding-3-small", created: 4, owned_by: "openai" },
    ],
  });

  assert.deepEqual(models.map((model) => model.id), ["gpt-5.6", "o3"]);
});

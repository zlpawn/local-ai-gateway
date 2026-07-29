import assert from "node:assert/strict";
import test from "node:test";
import { extractCompactionSummary } from "../../lib/codex/compaction-helper.mjs";

test("extractCompactionSummary extracts text from compaction item", () => {
  const item = { type: "compaction", text: "Prior conversation about auth." };
  assert.equal(extractCompactionSummary(item), "Prior conversation about auth.");
});

test("extractCompactionSummary extracts summary field when text is absent", () => {
  const item = { type: "summary", summary: "Prior context about caching." };
  assert.equal(extractCompactionSummary(item), "Prior context about caching.");
});

test("extractCompactionSummary returns null for non-compaction types", () => {
  assert.equal(extractCompactionSummary({ type: "message", content: "hello" }), null);
  assert.equal(extractCompactionSummary({ type: "reasoning" }), null);
  assert.equal(extractCompactionSummary({ type: "item_reference" }), null);
  assert.equal(extractCompactionSummary(null), null);
  assert.equal(extractCompactionSummary(undefined), null);
});

test("extractCompactionSummary returns null for empty or whitespace text", () => {
  assert.equal(extractCompactionSummary({ type: "compaction", text: "" }), null);
  assert.equal(extractCompactionSummary({ type: "compaction", text: "   " }), null);
  assert.equal(extractCompactionSummary({ type: "compaction" }), null);
});

test("extractCompactionSummary prefers text field over summary field", () => {
  const item = { type: "compaction", text: "from text", summary: "from summary" };
  assert.equal(extractCompactionSummary(item), "from text");
});

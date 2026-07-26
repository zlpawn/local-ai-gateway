import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANTIGRAVITY_IDENTITY,
  ANTIGRAVITY_WEB_SEARCH_IDENTITY,
} from "../../lib/antigravity/system-prompt.mjs";

test("identity is the short Antigravity stub (not 17.5K)", () => {
  assert.ok(ANTIGRAVITY_IDENTITY.startsWith("You are Antigravity"));
  assert.ok(ANTIGRAVITY_IDENTITY.includes("Google Deepmind team"));
  assert.ok(ANTIGRAVITY_IDENTITY.includes("pair programming with a USER"));
  assert.ok(ANTIGRAVITY_IDENTITY.endsWith("**Proactiveness**"));
  // short stub, well under 1K chars - the 17.5K in the plan referred to the
  // assembled systemInstruction (identity + preserved caller instructions).
  assert.ok(ANTIGRAVITY_IDENTITY.length < 1000);
  // 4 lines joined by \n (matches AG wrapper.rs after Rust line-continuation).
  assert.equal(ANTIGRAVITY_IDENTITY.split("\n").length, 4);
});

test("web search identity is the search-engine-bot stub", () => {
  assert.ok(ANTIGRAVITY_WEB_SEARCH_IDENTITY.startsWith("You are a search engine bot"));
  assert.ok(ANTIGRAVITY_WEB_SEARCH_IDENTITY.includes("MUST perform a web search"));
  assert.ok(ANTIGRAVITY_WEB_SEARCH_IDENTITY.length < 1000);
});

test("identities are distinct constants", () => {
  assert.notEqual(ANTIGRAVITY_IDENTITY, ANTIGRAVITY_WEB_SEARCH_IDENTITY);
});
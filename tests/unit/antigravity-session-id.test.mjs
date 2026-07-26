import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSessionId } from "../../lib/antigravity/session-id.mjs";

test("empty string yields FNV-64 offset basis as signed decimal", () => {
  // No bytes iterated -> hash stays at offset basis 0xCBF29CE484222325,
  // interpreted as signed i64 = -3750763034362895579 (matches AG session.rs).
  assert.equal(deriveSessionId(""), "-3750763034362895579");
});

test("stable for same input", () => {
  assert.equal(
    deriveSessionId("my_account@gmail.com"),
    deriveSessionId("my_account@gmail.com"),
  );
});

test("different inputs differ", () => {
  assert.notEqual(deriveSessionId("a@x.com"), deriveSessionId("b@x.com"));
});

test("output is a decimal integer string", () => {
  assert.match(deriveSessionId("test"), /^-?\d+$/);
});
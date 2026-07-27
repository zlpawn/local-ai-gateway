import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cacheSignature,
  getSignature,
  computeSessionFingerprint,
  _clearSignatureCache,
  _signatureCacheSize,
  _sessionCount,
} from "../../lib/antigravity/signature-cache.mjs";

const SIG = "a".repeat(120);
const FP = "sess-aaa";

test("store then retrieve by (session, call_id)", () => {
  _clearSignatureCache();
  cacheSignature(FP, "call_a", SIG);
  assert.equal(getSignature(FP, "call_a"), SIG);
});

test("missing call_id returns null", () => {
  _clearSignatureCache();
  cacheSignature(FP, "call_b", SIG);
  assert.equal(getSignature(FP, "call_c"), null);
  assert.equal(getSignature(FP, null), null);
  assert.equal(getSignature(null, "call_a"), null);
});

test("rejects signatures shorter than MIN_LENGTH (50)", () => {
  _clearSignatureCache();
  cacheSignature(FP, "call_short", "x".repeat(49));
  assert.equal(getSignature(FP, "call_short"), null);
  cacheSignature(FP, "call_50", "x".repeat(50));
  assert.equal(getSignature(FP, "call_50"), "x".repeat(50));
});

test("rejects missing id or non-string signature", () => {
  _clearSignatureCache();
  cacheSignature(FP, "", SIG);
  cacheSignature(FP, null, SIG);
  cacheSignature(FP, "call_d", 123);
  cacheSignature(FP, "call_d", null);
  assert.equal(_signatureCacheSize(), 0);
});

test("later signature overwrites earlier for same (session, call_id)", () => {
  _clearSignatureCache();
  cacheSignature(FP, "call_e", SIG);
  const longer = "b".repeat(200);
  cacheSignature(FP, "call_e", longer);
  assert.equal(getSignature(FP, "call_e"), longer);
});

// ── session isolation (the whole point) ──
test("same call_id under different sessions is isolated", () => {
  _clearSignatureCache();
  const sig1 = "1".repeat(100);
  const sig2 = "2".repeat(100);
  cacheSignature("sess-A", "call_x", sig1);
  cacheSignature("sess-B", "call_x", sig2);
  assert.equal(getSignature("sess-A", "call_x"), sig1);
  assert.equal(getSignature("sess-B", "call_x"), sig2);
  assert.equal(_sessionCount(), 2);
});

test("call_id cached under one session is invisible to another", () => {
  _clearSignatureCache();
  cacheSignature("sess-A", "call_y", SIG);
  assert.equal(getSignature("sess-B", "call_y"), null);
});

test("different call_ids within the same session are independent", () => {
  _clearSignatureCache();
  const s1 = "1".repeat(100), s2 = "2".repeat(100);
  cacheSignature(FP, "call_f", s1);
  cacheSignature(FP, "call_g", s2);
  assert.equal(getSignature(FP, "call_f"), s1);
  assert.equal(getSignature(FP, "call_g"), s2);
});

// ── computeSessionFingerprint ──
test("fingerprint is stable for same first user message", () => {
  const fp1 = computeSessionFingerprint([
    { type: "message", role: "user", content: [{ type: "input_text", text: "run echo hello" }] },
  ]);
  const fp2 = computeSessionFingerprint([
    { type: "message", role: "user", content: [{ type: "input_text", text: "run echo hello" }] },
    { type: "function_call", name: "shell", arguments: "{}", call_id: "c1" },
    { type: "function_call_output", call_id: "c1", output: "hello" },
  ]);
  assert.equal(fp1, fp2);
  assert.notEqual(fp1, "_default");
});

test("fingerprint differs for different first messages", () => {
  const fp1 = computeSessionFingerprint([
    { type: "message", role: "user", content: [{ type: "input_text", text: "aaa" }] },
  ]);
  const fp2 = computeSessionFingerprint([
    { type: "message", role: "user", content: [{ type: "input_text", text: "bbb" }] },
  ]);
  assert.notEqual(fp1, fp2);
});

test("fingerprint handles string input and string content", () => {
  const fpStr = computeSessionFingerprint("hello world");
  const fpArr = computeSessionFingerprint([
    { type: "message", role: "user", content: "hello world" },
  ]);
  assert.equal(fpStr, fpArr);
  assert.notEqual(fpStr, "_default");
});

test("fingerprint falls back to _default when no message text", () => {
  assert.equal(computeSessionFingerprint(null), "_default");
  assert.equal(computeSessionFingerprint([]), "_default");
  assert.equal(computeSessionFingerprint([{ type: "function_call", name: "x", call_id: "c" }]), "_default");
});

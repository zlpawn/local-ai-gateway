import assert from "node:assert/strict";
import test from "node:test";
import {
  successEnvelope,
  errorEnvelope,
  redactSecrets,
  formatSecretState,
  EXIT,
} from "../../../../lib/clis/shrimp/protocol.mjs";

test("success envelope shape", () => {
  const env = successEnvelope({
    command: "status",
    data: { running: true },
    meta: { dry_run: false },
    next: [],
  });
  assert.equal(env.ok, true);
  assert.equal(env.command, "status");
  assert.deepEqual(env.data, { running: true });
});

test("error envelope shape", () => {
  const env = errorEnvelope({
    command: "endpoint.add",
    error: {
      type: "validation",
      code: "missing_fields",
      message: "base_url is required",
      fields: ["base_url"],
      hint: "Provide --base-url",
      retryable: false,
    },
  });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "missing_fields");
});

test("redacts api keys and bearer tokens", () => {
  const redacted = redactSecrets({
    api_key: "sk-live-123",
    nested: { authorization: "Bearer abc", token: "xyz" },
    safe: "ok",
  });
  assert.equal(redacted.api_key, "***");
  assert.equal(redacted.nested.authorization, "***");
  assert.equal(redacted.nested.token, "***");
  assert.equal(redacted.safe, "ok");
});

test("formatSecretState distinguishes missing/stored/env", () => {
  assert.equal(formatSecretState(undefined), "missing");
  assert.equal(formatSecretState("sk-abc"), "stored");
  assert.equal(formatSecretState("env:ARK_API_KEY"), "env:ARK_API_KEY");
});

test("EXIT constants exist", () => {
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.NOT_FOUND, 3);
});
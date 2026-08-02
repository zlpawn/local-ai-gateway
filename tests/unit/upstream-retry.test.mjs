import test from "node:test";
import assert from "node:assert/strict";

import {
  isDeterministicQuotaError,
  shouldRetryUpstreamResponse,
} from "../../lib/upstream-retry.mjs";

test("does not retry deterministic account quota errors", async () => {
  const response = new Response(JSON.stringify({
    error: {
      code: "AccountQuotaExceeded",
      message: "You have exceeded the weekly usage quota.",
      type: "TooManyRequests",
    },
  }), { status: 429 });

  assert.equal(await shouldRetryUpstreamResponse(response), false);
});

test("retries ordinary rate limits and overload responses", async () => {
  assert.equal(
    await shouldRetryUpstreamResponse(
      new Response('{"error":{"message":"rate limit exceeded, retry later"}}', { status: 429 }),
    ),
    true,
  );
  assert.equal(await shouldRetryUpstreamResponse(new Response("", { status: 503 })), true);
  assert.equal(await shouldRetryUpstreamResponse(new Response("", { status: 400 })), false);
});

test("recognizes common deterministic quota error text", () => {
  assert.equal(isDeterministicQuotaError("AccountQuotaExceeded"), true);
  assert.equal(isDeterministicQuotaError("weekly usage quota will reset tomorrow"), true);
  assert.equal(isDeterministicQuotaError("requests per minute exceeded"), false);
});

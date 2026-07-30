import assert from "node:assert/strict";
import test from "node:test";
import { embedSimilarity } from "../../../../lib/clis/shrimp/domain/tool-service.mjs";

// Directly test cosine via public API by monkeypatching fetch/health internals is heavy;
// unit-test the pure path through a tiny local reimplementation check using private behavior
// by calling embedSimilarity with mocked global fetch.

test("embedSimilarity computes cosine from mocked embeddings", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    }
    calls += 1;
    const body = JSON.parse(init.body);
    const vector = body.input === "a" ? [1, 0, 0] : [1, 0, 0];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: body.model,
        data: [{ embedding: vector }],
        usage: { prompt_tokens: 1 },
      }),
    };
  };
  try {
    const result = await embedSimilarity({
      host: "127.0.0.1",
      port: 8797,
      client: "codex",
      model: "emb",
      textA: "a",
      textB: "b",
    });
    assert.equal(result.similarity, 1);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
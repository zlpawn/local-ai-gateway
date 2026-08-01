import assert from "node:assert/strict";
import test from "node:test";

import { huoshanAdapter } from "../../lib/media/providers/huoshan.mjs";

test("Huoshan image adapter turns canonical reference base64 into data image URLs", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ data: [{ url: "https://example.test/generated.png" }] }) };
  };
  try {
    await huoshanAdapter.generateImage({
      prompt: "reference image test",
      imageB64List: ["cG5n", "anBn"],
      imageMimeTypes: ["image/png", "image/jpeg"],
    }, { apiKey: "test-key", endpoint: {}, signal: undefined });

    assert.deepEqual(upstreamBody.image, ["data:image/png;base64,cG5n", "data:image/jpeg;base64,anBn"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

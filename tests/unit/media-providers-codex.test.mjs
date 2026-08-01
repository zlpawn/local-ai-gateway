import assert from "node:assert/strict";
import test from "node:test";

import { codexAdapter } from "../../lib/media/providers/codex.mjs";

test("Codex image adapter passes canonical reference images as data URLs", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ data: [{ b64_json: "generated" }] }) };
  };
  try {
    await codexAdapter.generateImage({
      prompt: "edit this reference",
      imageB64List: ["cG5n"],
      imageMimeTypes: ["image/png"],
    }, { getApiKey: () => "test-token", endpoint: {}, signal: undefined });

    assert.deepEqual(upstreamBody.input_images, [{ image_url: "data:image/png;base64,cG5n" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

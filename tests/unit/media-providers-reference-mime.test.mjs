import assert from "node:assert/strict";
import test from "node:test";

import { antigravityAdapter } from "../../lib/media/providers/antigravity.mjs";
import { grokAdapter } from "../../lib/media/providers/grok.mjs";
import { huoshanAdapter } from "../../lib/media/providers/huoshan.mjs";

test("Antigravity image adapter preserves canonical PNG MIME type", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, text: async () => 'data: {"candidates":[{"content":{"parts":[{"inline_data":{"data":"generated"}}]}}]}' };
  };
  try {
    await antigravityAdapter.generateImage({ prompt: "png reference", imageB64List: ["cG5n"], imageMimeTypes: ["image/png"] }, {
      getApiKey: () => "token", endpoint: {}, signal: undefined,
    });
    assert.equal(request.contents[0].parts[1].inline_data.mime_type, "image/png");
  } finally { globalThis.fetch = originalFetch; }
});

test("Grok video adapter preserves indexed MIME types and JPEG fallback", async () => {
  const originalFetch = globalThis.fetch;
  const authPath = process.env.GROK_AUTH_PATH;
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mime-"));
  const file = path.join(temp, "auth.json");
  fs.writeFileSync(file, JSON.stringify({ user: { key: "token" } }));
  process.env.GROK_AUTH_PATH = file;
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ request_id: "task" }) };
  };
  try {
    await grokAdapter.createVideoTask({
      prompt: "mixed", imageB64List: ["d2VicA==", "cG5n", "anBlZw=="], imageMimeTypes: ["image/webp", "image/png"],
    }, { signal: undefined });
    assert.deepEqual(payload.images.map((item) => item.url), [
      "data:image/webp;base64,d2VicA==",
      "data:image/png;base64,cG5n",
      "data:image/jpeg;base64,anBlZw==",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (authPath === undefined) delete process.env.GROK_AUTH_PATH; else process.env.GROK_AUTH_PATH = authPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("Huoshan video adapter preserves indexed MIME types and JPEG fallback", async () => {
  const originalFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ id: "task" }) };
  };
  try {
    await huoshanAdapter.createVideoTask({
      prompt: "mixed", imageB64List: ["cG5n", "d2VicA=="], imageMimeTypes: ["image/png"],
    }, { getApiKey: () => "key", endpoint: {}, signal: undefined });
    assert.deepEqual(payload.content.slice(1).map((item) => item.image_url.url), [
      "data:image/png;base64,cG5n",
      "data:image/jpeg;base64,d2VicA==",
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

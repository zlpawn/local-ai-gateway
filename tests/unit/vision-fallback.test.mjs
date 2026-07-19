import assert from "node:assert/strict";
import test from "node:test";

import {
  containsImages,
  isImageCapabilityError,
  shouldPreprocessImages,
  replaceImagesWithDescription,
  selectVisionFallback,
} from "../../lib/vision-fallback.mjs";

test("vision fallback selection requires one enabled purpose node with a selected model", () => {
  const selected = selectVisionFallback([
    { id: "normal", models: ["glm-5.2"] },
    {
      id: "vision",
      purpose: "vision_fallback",
      vision_fallback_enabled: true,
      vision_model: "vision-pro",
      models: ["vision-pro", "other"],
    },
  ]);
  assert.equal(selected.endpoint.id, "vision");
  assert.equal(selected.model, "vision-pro");
});

test("unconfigured image capability stays optimistic while explicit false preprocesses", () => {
  assert.equal(shouldPreprocessImages({ endpoint: {}, upstreamModel: "glm-5.2" }), false);
  assert.equal(shouldPreprocessImages({
    endpoint: { model_capabilities: { "glm-5.2": { image: false } } },
    upstreamModel: "glm-5.2",
  }), true);
});

test("image detection and replacement support Anthropic, Chat, and Responses bodies", () => {
  const bodies = [
    {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "分析图片" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
        ],
      }],
    },
    {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "分析图片" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
        ],
      }],
    },
    {
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "分析图片" },
          { type: "input_image", image_url: "data:image/png;base64,AA==" },
        ],
      }],
    },
  ];

  for (const body of bodies) {
    assert.equal(containsImages(body), true);
    const replaced = replaceImagesWithDescription(body, "图片中有一个红色错误框。");
    assert.equal(containsImages(replaced), false);
    assert.match(JSON.stringify(replaced), /红色错误框/);
  }
});

test("only explicit image capability errors trigger reactive fallback", () => {
  assert.equal(isImageCapabilityError(400, '{"error":"image input is not supported"}'), true);
  assert.equal(isImageCapabilityError(400, '{"error":"unsupported modality: image"}'), true);
  assert.equal(isImageCapabilityError(429, "Selected model is at capacity"), false);
  assert.equal(isImageCapabilityError(401, "invalid api key"), false);
});

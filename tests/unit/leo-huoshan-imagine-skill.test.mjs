import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  parseCliArgs,
  slugifyPrompt,
  generateSemanticFilename,
  formatDateYYYYMMDDHHmmss,
  buildVideoContent,
  buildImageBody,
  resolveApiKey,
  buildTtsBody,
} from "../../lib/skills/leo-huoshan-imagine/scripts/leo_huoshan_imagine.mjs";
import { SkillInstaller } from "../../lib/session-sync/skill-installer.mjs";

test("Huoshan Imagine Skill - parseCliArgs parser test", () => {
  const rawArgs = [
    "video",
    "--prompt", "赛博朋克夜景",
    "--images", "/img1.jpg,/img2.jpg",
    "--ratio", "9:16",
    "--duration", "8",
    "--resolution", "1080p",
    "--watermark",
    "--no-audio",
  ];
  const parsed = parseCliArgs(rawArgs);
  assert.equal(parsed.command, "video");
  assert.equal(parsed.prompt, "赛博朋克夜景");
  assert.deepEqual(parsed.imagePaths, ["/img1.jpg", "/img2.jpg"]);
  assert.equal(parsed.ratio, "9:16");
  assert.equal(parsed.duration, 8);
  assert.equal(parsed.resolution, "1080p");
  assert.equal(parsed.watermark, true);
  assert.equal(parsed.generateAudio, false);
});

test("Huoshan Imagine Skill - check-status and dry-run flags", () => {
  const parsed = parseCliArgs(["--check-status", "cgt-2026xxxx", "--dry-run"]);
  assert.equal(parsed.checkStatus, "cgt-2026xxxx");
  assert.equal(parsed.dryRun, true);
});

test("Huoshan Imagine Skill - semantic filename generator", () => {
  const prompt = "赛博朋克夜景，霓虹雨夜！";
  const slug = slugifyPrompt(prompt);
  assert.ok(slug.length > 0);

  const dateStr = formatDateYYYYMMDDHHmmss();
  assert.equal(/^\d{14}$/.test(dateStr), true);

  const filenameMp4 = generateSemanticFilename(prompt, "mp4");
  assert.ok(filenameMp4.startsWith("volcano_"));
  assert.ok(filenameMp4.endsWith(".mp4"));

  // explicit filename overrides the generated one
  assert.equal(generateSemanticFilename(prompt, "mp4", "custom.mp4"), "custom.mp4");
});

test("Huoshan Imagine Skill - buildVideoContent with no images", () => {
  const content = buildVideoContent("一只猫在奔跑", []);
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "一只猫在奔跑");
});

test("Huoshan Imagine Skill - buildVideoContent with images assigns roles", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "huoshan-video-"));
  try {
    const img1 = path.join(tmpDir, "first.png");
    const img2 = path.join(tmpDir, "ref.jpg");
    fs.writeFileSync(img1, Buffer.from("iVBORw0KGg=", "base64"));
    fs.writeFileSync(img2, Buffer.from("/9j/4AAQ", "base64"));

    const content = buildVideoContent("动起来", [img1, img2]);
    assert.equal(content.length, 3);
    assert.equal(content[0].type, "text");

    const first = content.find((c) => c.role === "first_frame");
    const ref = content.find((c) => c.role === "reference_image");
    assert.ok(first, "expected a first_frame image");
    assert.ok(ref, "expected a reference_image");
    assert.ok(first.image_url.url.startsWith("data:image/png;base64,"));
    assert.ok(ref.image_url.url.startsWith("data:image/jpeg;base64,"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Huoshan Imagine Skill - buildVideoContent skips missing image paths", () => {
  const content = buildVideoContent("prompt", ["/does/not/exist.jpg"]);
  assert.equal(content.length, 1); // text only; bad path skipped
});

test("Huoshan Imagine Skill - resolveApiKey precedence", () => {
  // explicit beats env
  assert.equal(resolveApiKey("explicit-key"), "explicit-key");

  // env fallback when no explicit and no resolvable gateway secrets
  const prevEnv = process.env.ARK_API_KEY;
  const prevDataDir = process.env.GATEWAY_DATA_DIR;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "huoshan-key-"));
  try {
    // point gateway data dir at an empty temp dir so no secrets/config are found
    process.env.GATEWAY_DATA_DIR = tmpHome;
    process.env.ARK_API_KEY = "env-key";
    assert.equal(resolveApiKey(), "env-key");
  } finally {
    if (prevEnv === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = prevEnv;
    if (prevDataDir === undefined) delete process.env.GATEWAY_DATA_DIR;
    else process.env.GATEWAY_DATA_DIR = prevDataDir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Huoshan Imagine Skill - resolveApiKey reads gateway endpoint key by name", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "huoshan-gw-"));
  const prevDataDir = process.env.GATEWAY_DATA_DIR;
  const prevEnv = process.env.ARK_API_KEY;
  try {
    process.env.GATEWAY_DATA_DIR = tmpDir;
    delete process.env.ARK_API_KEY;
    // simulate a gateway with a huoshan-agentplan endpoint + stored key
    fs.writeFileSync(
      path.join(tmpDir, "gateway.config.json"),
      JSON.stringify({
        clients: {
          codex: {
            endpoints: [
              { id: "ep_test_media", name: "huoshan-agentplan", base_url: "https://ark.cn-beijing.volces.com/api/v3" },
              { id: "ep_other", name: "other-node", base_url: "https://example.com" },
            ],
          },
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "gateway.secrets.json"),
      JSON.stringify({ api_keys: { ep_test_media: "ark-secret-from-gateway", ep_other: "wrong-key" } }),
      "utf-8",
    );
    assert.equal(resolveApiKey(), "ark-secret-from-gateway");
  } finally {
    if (prevEnv === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = prevEnv;
    if (prevDataDir === undefined) delete process.env.GATEWAY_DATA_DIR;
    else process.env.GATEWAY_DATA_DIR = prevDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Huoshan Imagine Skill - buildTtsBody validates text and shape", () => {
  assert.throws(() => buildTtsBody({}), /缺少待合成文本/);
  const body = buildTtsBody({ text: "你好", voice: "zh_male_xxx", encoding: "wav" });
  assert.equal(body.user.uid, "0");
  assert.equal(body.req_params.text, "你好");
  assert.equal(body.req_params.voice_type, "zh_male_xxx");
  assert.equal(body.req_params.encoding, "wav");
  assert.equal(body.req_params.model, "doubao-seed-tts-2.0");
  assert.equal(body.req_params.speed_ratio, 1.0);
});

test("Huoshan Imagine Skill - buildTtsBody optional fields", () => {
  const body = buildTtsBody({
    text: "测试",
    rate: 5,
    pitch: -2,
    volume: 80,
    speedRatio: 1.5,
    sampleRate: 24000,
    audioFormat: "raw",
  });
  assert.equal(body.req_params.rate, 5);
  assert.equal(body.req_params.pitch, -2);
  assert.equal(body.req_params.volume, 80);
  assert.equal(body.req_params.speed_ratio, 1.5);
  assert.equal(body.req_params.sample_rate, 24000);
  assert.equal(body.req_params.audio_format, "raw");
});

test("Huoshan Imagine Skill - buildImageBody defaults", () => {
  const body = buildImageBody({ prompt: "一只猫" });
  assert.equal(body.model, "doubao-seedream-5-0-lite-260128");
  assert.equal(body.prompt, "一只猫");
  assert.equal(body.size, "2K");
  assert.equal(body.output_format, "png");
  assert.equal(body.response_format, "url");
  assert.equal(body.watermark, false);
  assert.equal(body.image, undefined);
});

test("Huoshan Imagine Skill - buildImageBody with reference images", () => {
  const body = buildImageBody({
    prompt: "融合风格",
    imageUrls: ["https://a.com/1.png", "https://a.com/2.png"],
    size: "4K",
    outputFormat: "jpeg",
    responseFormat: "b64_json",
    watermark: true,
    sequentialImageGeneration: "auto",
  });
  assert.deepEqual(body.image, ["https://a.com/1.png", "https://a.com/2.png"]);
  assert.equal(body.size, "4K");
  assert.equal(body.output_format, "jpeg");
  assert.equal(body.response_format, "b64_json");
  assert.equal(body.watermark, true);
  assert.equal(body.sequential_image_generation, "auto");
});

test("Huoshan Imagine Skill - parseCliArgs image command", () => {
  const parsed = parseCliArgs([
    "image",
    "--prompt", "风景",
    "--image-urls", "https://a.com/1.png,https://a.com/2.png",
    "--size", "4K",
    "--output-format", "jpeg",
    "--watermark",
  ]);
  assert.equal(parsed.command, "image");
  assert.equal(parsed.prompt, "风景");
  assert.deepEqual(parsed.imageUrls, ["https://a.com/1.png", "https://a.com/2.png"]);
  assert.equal(parsed.size, "4K");
  assert.equal(parsed.outputFormat, "jpeg");
  assert.equal(parsed.watermark, true);
});

test("Huoshan Imagine Skill - SkillInstaller recognizes the managed skill", () => {
  const skill = SkillInstaller.getManagedSkill("leo-huoshan-imagine");
  assert.ok(skill, "leo-huoshan-imagine should be a registered managed skill");
  assert.equal(skill.category, "media");
  assert.equal(skill.builtin, true);
});

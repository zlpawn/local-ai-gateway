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

  // env fallback when no explicit and no secrets file in cwd
  const prev = process.env.ARK_API_KEY;
  const cwd = process.cwd();
  process.chdir(os.tmpdir()); // avoid picking up a real gateway.secrets.json
  try {
    process.env.ARK_API_KEY = "env-key";
    assert.equal(resolveApiKey(), "env-key");
  } finally {
    process.env.ARK_API_KEY = prev;
    process.chdir(cwd);
  }
});

test("Huoshan Imagine Skill - buildTtsBody validates text", () => {
  assert.throws(() => buildTtsBody({}), /缺少待合成文本/);
  const body = buildTtsBody({ text: "你好", voice: "zh_male_xxx", encoding: "wav" });
  assert.equal(body.text, "你好");
  assert.equal(body.voice, "zh_male_xxx");
  assert.equal(body.encoding, "wav");
});

test("Huoshan Imagine Skill - SkillInstaller recognizes the managed skill", () => {
  const skill = SkillInstaller.getManagedSkill("leo-huoshan-imagine");
  assert.ok(skill, "leo-huoshan-imagine should be a registered managed skill");
  assert.equal(skill.category, "media");
  assert.equal(skill.builtin, true);
});

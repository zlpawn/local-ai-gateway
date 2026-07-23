import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  getGrokAuthToken,
  generateSemanticFilename,
  slugifyPrompt,
  formatDateYYYYMMDDHHmmss,
  parseCliArgs,
} from "../../lib/skills/grok-imagine/scripts/grok_imagine.mjs";
import { SkillInstaller } from "../../lib/session-sync/skill-installer.mjs";

test("Grok Imagine Skill - parseCliArgs parser test", () => {
  const rawArgs = [
    "--prompt", "Cyberpunk neon city",
    "--type", "video",
    "--images", "/img1.jpg,/img2.jpg",
    "--duration", "10",
    "--aspect-ratio", "9:16",
  ];
  const parsed = parseCliArgs(rawArgs);
  assert.equal(parsed.prompt, "Cyberpunk neon city");
  assert.equal(parsed.type, "video");
  assert.deepEqual(parsed.imagePaths, ["/img1.jpg", "/img2.jpg"]);
  assert.equal(parsed.duration, 10);
  assert.equal(parsed.aspectRatio, "9:16");
});

test("Grok Imagine Skill - semantic filename generator", () => {
  const prompt = "A cute fluffy kitten in space!";
  const slug = slugifyPrompt(prompt);
  assert.equal(slug, "a_cute_fluffy_kitten_in_space");

  const dateStr = formatDateYYYYMMDDHHmmss();
  assert.equal(/^\d{14}$/.test(dateStr), true); // YYYYMMDDHHmmss is 14 digits

  const filenameImg = generateSemanticFilename(prompt, "jpg");
  assert.equal(filenameImg.startsWith("grok_a_cute_fluffy_kitten_in_space_"), true);
  assert.equal(filenameImg.endsWith(".jpg"), true);
  assert.equal(filenameImg.includes("img"), false); // No "img" tag

  const filenameVideo = generateSemanticFilename(prompt, "mp4");
  assert.equal(filenameVideo.startsWith("grok_a_cute_fluffy_kitten_in_space_"), true);
  assert.equal(filenameVideo.endsWith(".mp4"), true);
  assert.equal(filenameVideo.includes("video"), false); // No "video" tag
});

test("Grok Imagine Skill - token reader helper", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-token-test-"));
  const fakeAuthFile = path.join(tmpDir, "auth.json");

  fs.writeFileSync(
    fakeAuthFile,
    JSON.stringify({
      "https://auth.x.ai::client": {
        key: "test_jwt_secret_token_12345",
        user_id: "user_test",
      },
    }),
    "utf-8",
  );

  const token = getGrokAuthToken(fakeAuthFile);
  assert.equal(token, "test_jwt_secret_token_12345");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Grok Imagine Skill - SkillInstaller installation & symlink status", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-skill-test-"));
  const skillName = "grok-imagine";

  const initialStatus = SkillInstaller.getSymlinkStatus(tmpHome, skillName);
  assert.equal(initialStatus.antigravity, false);
  assert.equal(initialStatus.claude, false);
  assert.equal(initialStatus.codex, false);

  const centralDir = path.join(tmpHome, ".agents", "skills", skillName);
  const baseFile = SkillInstaller.installBaseSkill(centralDir, skillName);
  assert.equal(fs.existsSync(baseFile), true);

  const results = SkillInstaller.updateSymlinks(
    { antigravity: true, claude: true, codex: false },
    tmpHome,
    baseFile,
    skillName,
  );

  assert.equal(results.antigravity, true);
  assert.equal(results.claude, true);
  assert.equal(results.codex, false);

  const newStatus = SkillInstaller.getSymlinkStatus(tmpHome, skillName);
  assert.equal(newStatus.antigravity, true);
  assert.equal(newStatus.claude, true);
  assert.equal(newStatus.codex, false);

  fs.rmSync(tmpHome, { recursive: true, force: true });
});

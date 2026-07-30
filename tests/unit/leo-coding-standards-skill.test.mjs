import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { SkillInstaller } from "../../lib/session-sync/skill-installer.mjs";

const SKILL_NAME = "leo-coding-standards";

function installSkill(tmpHome) {
  const installedDir = path.join(tmpHome, ".agents", "skills", SKILL_NAME);
  SkillInstaller.installBaseSkill(installedDir, SKILL_NAME);
  return installedDir;
}

test("leo coding standards skill installs its complete package", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "leo-coding-standards-"));
  try {
    const installedDir = installSkill(tmpHome);

    for (const relativePath of [
      "SKILL.md",
      "agents/openai.yaml",
      "references/java-api-rules.md",
      "references/engineering-principles.md",
      "references/review-checklist.md",
    ]) {
      assert.equal(
        fs.existsSync(path.join(installedDir, relativePath)),
        true,
        `missing installed skill asset: ${relativePath}`,
      );
    }
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("leo coding standards entry point exposes Java triggers and reference navigation", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "leo-coding-entry-"));
  try {
    const installedDir = installSkill(tmpHome);
    const skill = fs.readFileSync(path.join(installedDir, "SKILL.md"), "utf-8");
    const agentMeta = fs.readFileSync(path.join(installedDir, "agents", "openai.yaml"), "utf-8");

    assert.match(skill, /^---\nname: leo-coding-standards\n/m);
    assert.match(skill, /description: Use when .*Java code/i);
    assert.match(skill, /references\/java-api-rules\.md/);
    assert.match(skill, /references\/engineering-principles\.md/);
    assert.match(skill, /references\/review-checklist\.md/);
    assert.match(skill, /MUST/);
    assert.match(skill, /SHOULD/);
    assert.match(skill, /CONSIDER/);

    assert.match(agentMeta, /display_name: "Leo Java 编码规范"/);
    assert.match(agentMeta, /default_prompt: "Use \$leo-coding-standards/);
    assert.match(agentMeta, /allow_implicit_invocation: true/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("leo coding standards API reference contains the approved preference set", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "leo-coding-api-"));
  try {
    const installedDir = installSkill(tmpHome);
    const apiRules = fs.readFileSync(
      path.join(installedDir, "references", "java-api-rules.md"),
      "utf-8",
    );

    for (const api of [
      "java.util.Objects#isNull",
      "java.util.Objects#nonNull",
      "java.util.Objects#equals",
      "org.apache.commons.lang3.ObjectUtils#notEqual",
      "org.apache.commons.lang3.StringUtils#isBlank",
      "org.apache.commons.lang3.StringUtils#isNotBlank",
      "org.apache.commons.collections4.CollectionUtils#isEmpty",
      "org.apache.commons.collections4.CollectionUtils#isNotEmpty",
      "com.google.common.collect.Lists#newArrayList()",
      "com.google.common.collect.Sets#newHashSet(java.lang.Iterable<? extends E>)",
      "org.apache.commons.lang3.BooleanUtils#isFalse",
      "java.util.Optional#ofNullable",
    ]) {
      assert.match(apiRules, new RegExp(api.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

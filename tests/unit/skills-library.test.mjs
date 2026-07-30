import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { SkillInstaller } from "../../lib/session-sync/skill-installer.mjs";

test("Skill library lists managed and discovered skills with categories", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "skill-library-"));
  try {
    const root = path.join(tmpHome, ".agents", "skills");
    fs.mkdirSync(root, { recursive: true });

    // discovered local skill
    const localDir = path.join(root, "browser-cookies-local");
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(
      path.join(localDir, "SKILL.md"),
      `---
name: browser-cookies-local
description: Auto-export Netscape cookies from Chrome for yt-dlp via CDP.
---

# Browser Cookies Local
`,
      "utf-8",
    );

    SkillInstaller.ensureManagedSkills(tmpHome);

    const snapshot = SkillInstaller.buildLibrarySnapshot({
      homeDir: tmpHome,
      query: "cookie",
      scope: "all",
    });

    assert.ok(snapshot.stats.total >= 3);
    assert.equal(snapshot.skills.some((s) => s.name === "browser-cookies-local"), true);
    const local = snapshot.skills.find((s) => s.name === "browser-cookies-local");
    assert.equal(local.category, "browser");
    assert.equal(local.managed, false);
    assert.equal(local.installed, true);

    const all = SkillInstaller.buildLibrarySnapshot({
      homeDir: tmpHome,
    });
    const grok = all.allSkills.find((s) => s.name === "grok-imagine");
    assert.ok(grok);
    assert.equal(grok.installed, true);
    assert.equal(grok.mounted, true); // compatibility alias
    assert.equal(all.stats.installed >= 3, true);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Skill library scope filters installed, managed, and missing skills", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "skill-scope-"));
  try {
    // Do not ensure managed skills so session-sync / grok-imagine stay missing.
    const root = path.join(tmpHome, ".agents", "skills");
    fs.mkdirSync(root, { recursive: true });
    const localDir = path.join(root, "browser-cookies-local");
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(
      path.join(localDir, "SKILL.md"),
      `---
name: browser-cookies-local
description: local cookie skill
---
`,
      "utf-8",
    );

    const installed = SkillInstaller.buildLibrarySnapshot({
      homeDir: tmpHome,
      scope: "installed",
    });
    assert.ok(installed.skills.every((s) => s.installed));
    assert.equal(installed.skills.some((s) => s.name === "browser-cookies-local"), true);

    // legacy alias still works
    const mountedAlias = SkillInstaller.buildLibrarySnapshot({
      homeDir: tmpHome,
      scope: "mounted",
    });
    assert.ok(mountedAlias.skills.every((s) => s.installed));

    const managed = SkillInstaller.buildLibrarySnapshot({
      homeDir: tmpHome,
      scope: "managed",
    });
    assert.ok(managed.skills.every((s) => s.managed));

    const missing = SkillInstaller.buildLibrarySnapshot({
      homeDir: tmpHome,
      scope: "missing",
    });
    assert.ok(missing.skills.every((s) => !s.installed));
    assert.equal(missing.skills.some((s) => s.name === "session-sync"), true);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Promote local skill writes project managed source like grok-imagine", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "skill-promote-"));
  const projectSkillRoot = SkillInstaller.MANAGED_SKILLS_ROOT;
  const promotedDir = path.join(projectSkillRoot, "browser-cookies-local");
  const catalogFile = SkillInstaller.MANAGED_CATALOG_FILE;
  const hadCatalog = fs.existsSync(catalogFile);
  const previousCatalog = hadCatalog ? fs.readFileSync(catalogFile, "utf-8") : null;
  const hadPromotedDir = fs.existsSync(promotedDir);

  try {
    const root = path.join(tmpHome, ".agents", "skills");
    fs.mkdirSync(root, { recursive: true });
    const localDir = path.join(root, "browser-cookies-local");
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(
      path.join(localDir, "SKILL.md"),
      `---
name: browser-cookies-local
description: Auto-export Netscape cookies from Chrome for yt-dlp via CDP.
---

# Browser Cookies Local
`,
      "utf-8",
    );
    fs.mkdirSync(path.join(localDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(localDir, "scripts", "export_cookies.py"), "print('ok')\n", "utf-8");

    const result = SkillInstaller.promoteLocalSkillToManaged("browser-cookies-local", {
      homeDir: tmpHome,
    });

    assert.equal(result.skill.name, "browser-cookies-local");
    assert.equal(result.skill.managed, true);
    assert.equal(fs.existsSync(path.join(promotedDir, "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(promotedDir, "scripts", "export_cookies.py")), true);
    assert.equal(fs.existsSync(catalogFile), true);

    const snapshot = SkillInstaller.buildLibrarySnapshot({
      homeDir: tmpHome,
      scope: "managed",
    });
    const managed = snapshot.skills.find((s) => s.name === "browser-cookies-local");
    assert.ok(managed);
    assert.equal(managed.managed, true);
    assert.equal(managed.canPromote, false);
    assert.equal(managed.installed, true);
  } finally {
    if (fs.existsSync(promotedDir) && !hadPromotedDir) {
      fs.rmSync(promotedDir, { recursive: true, force: true });
    }
    if (hadCatalog) {
      fs.writeFileSync(catalogFile, previousCatalog, "utf-8");
    } else if (fs.existsSync(catalogFile)) {
      fs.rmSync(catalogFile, { force: true });
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});


test("Skill library scans antigravity-only and claude roots with dedup", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "skill-multiscan-"));
  const catalogFile = SkillInstaller.MANAGED_CATALOG_FILE;
  const hadCatalog = fs.existsSync(catalogFile);
  const previousCatalog = hadCatalog ? fs.readFileSync(catalogFile, "utf-8") : null;
  try {
    // central: only grok-imagine ensured (managed). Put a local skill in antigravity dir only.
    const agRoot = SkillInstaller.getAntigravitySkillsRoot(tmpHome);
    const agDir = path.join(agRoot, "multiscan-ag-only-skill");
    fs.mkdirSync(agDir, { recursive: true });
    fs.writeFileSync(
      path.join(agDir, "SKILL.md"),
      `---
name: multiscan-ag-only-skill
description: Parse technical videos into dense Karpathy-style wiki notes.
---

# Video to Karpathy Wiki
`,
      "utf-8",
    );

    // claude root has a different local skill
    const claudeRoot = path.join(tmpHome, ".claude", "skills");
    const claudeDir = path.join(claudeRoot, "claude-only-skill");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "SKILL.md"),
      `---
name: claude-only-skill
description: A skill only present under ~/.claude/skills.
---
`,
      "utf-8",
    );

    SkillInstaller.ensureManagedSkills(tmpHome);

    const snapshot = SkillInstaller.buildLibrarySnapshot({ homeDir: tmpHome });

    const ag = snapshot.allSkills.find((s) => s.name === "multiscan-ag-only-skill");
    assert.ok(ag, "antigravity-only skill should be listed");
    assert.equal(ag.installed, true);
    assert.equal(ag.presentIn.central, false);
    assert.equal(ag.presentIn.antigravity, true);
    assert.equal(ag.presentIn.claude, false);

    const cl = snapshot.allSkills.find((s) => s.name === "claude-only-skill");
    assert.ok(cl, "claude-only skill should be listed");
    assert.equal(cl.installed, true);
    assert.equal(cl.presentIn.claude, true);
    assert.equal(cl.presentIn.central, false);

    // No duplicate entries: each name appears exactly once.
    const names = snapshot.allSkills.map((s) => s.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual(dupes, []);

    // Promote an antigravity-only skill into managed source.
    const promoted = SkillInstaller.promoteLocalSkillToManaged("multiscan-ag-only-skill", { homeDir: tmpHome });
    assert.equal(promoted.skill.managed, true);
    assert.ok(fs.existsSync(path.join(SkillInstaller.MANAGED_SKILLS_ROOT, "multiscan-ag-only-skill", "SKILL.md")));
  } finally {
    // clean promoted artifact so we don't leak into the real project tree
    const promotedDir = path.join(SkillInstaller.MANAGED_SKILLS_ROOT, "multiscan-ag-only-skill");
    if (fs.existsSync(promotedDir)) fs.rmSync(promotedDir, { recursive: true, force: true });
    if (hadCatalog) fs.writeFileSync(catalogFile, previousCatalog, "utf-8");
    else if (fs.existsSync(catalogFile)) fs.rmSync(catalogFile, { force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Leo coding standards is a searchable managed development skill", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "leo-coding-library-"));
  try {
    SkillInstaller.ensureManagedSkills(tmpHome);

    const snapshot = SkillInstaller.buildLibrarySnapshot({ homeDir: tmpHome });
    const skill = snapshot.allSkills.find((item) => item.name === "leo-coding-standards");
    assert.ok(skill);
    assert.equal(skill.managed, true);
    assert.equal(skill.installed, true);
    assert.equal(skill.category, "development");
    assert.equal(skill.categoryLabel, "开发工程");
    assert.equal(skill.title, "Leo Java 编码规范");

    const development = snapshot.categories.find((item) => item.id === "development");
    assert.ok(development);
    assert.equal(development.label, "开发工程");
    assert.equal(development.count >= 1, true);

    for (const query of ["java", "coding standards", "代码规范"]) {
      const result = SkillInstaller.buildLibrarySnapshot({
        homeDir: tmpHome,
        query,
      });
      assert.equal(
        result.skills.some((item) => item.name === "leo-coding-standards"),
        true,
        `query should find leo-coding-standards: ${query}`,
      );
    }

    const installedDir = path.join(tmpHome, ".agents", "skills", "leo-coding-standards");
    for (const relativePath of [
      "agents/openai.yaml",
      "references/java-api-rules.md",
      "references/engineering-principles.md",
      "references/review-checklist.md",
    ]) {
      assert.equal(fs.existsSync(path.join(installedDir, relativePath)), true, relativePath);
    }
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Skill library infers uncataloged Java review skills as development", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "java-review-category-"));
  try {
    const skillDir = path.join(tmpHome, ".agents", "skills", "java-review-local");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---
name: java-review-local
description: Use when reviewing Java code for coding standards and maintainability.
---

# Java Review Local
`,
      "utf-8",
    );

    const snapshot = SkillInstaller.buildLibrarySnapshot({ homeDir: tmpHome });
    const skill = snapshot.allSkills.find((item) => item.name === "java-review-local");
    assert.ok(skill);
    assert.equal(skill.managed, false);
    assert.equal(skill.category, "development");
    assert.equal(skill.categoryLabel, "开发工程");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

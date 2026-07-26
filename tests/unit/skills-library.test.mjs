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

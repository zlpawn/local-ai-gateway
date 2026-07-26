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
  try {
    // central: only grok-imagine ensured (managed). Put a local skill in antigravity dir only.
    const agRoot = SkillInstaller.getAntigravitySkillsRoot(tmpHome);
    const agDir = path.join(agRoot, "video-to-karpathy-wiki");
    fs.mkdirSync(agDir, { recursive: true });
    fs.writeFileSync(
      path.join(agDir, "SKILL.md"),
      `---
name: video-to-karpathy-wiki
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

    const ag = snapshot.allSkills.find((s) => s.name === "video-to-karpathy-wiki");
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
    const promoted = SkillInstaller.promoteLocalSkillToManaged("video-to-karpathy-wiki", { homeDir: tmpHome });
    assert.equal(promoted.skill.managed, true);
    assert.ok(fs.existsSync(path.join(SkillInstaller.MANAGED_SKILLS_ROOT, "video-to-karpathy-wiki", "SKILL.md")));
  } finally {
    // clean promoted artifact so we don't leak into the real project tree
    const promotedDir = path.join(SkillInstaller.MANAGED_SKILLS_ROOT, "video-to-karpathy-wiki");
    if (fs.existsSync(promotedDir)) fs.rmSync(promotedDir, { recursive: true, force: true });
    const cat = SkillInstaller.MANAGED_CATALOG_FILE;
    if (fs.existsSync(cat)) {
      const data = JSON.parse(fs.readFileSync(cat, "utf-8"));
      const filtered = (data.skills || []).filter((s) => s.name !== "video-to-karpathy-wiki");
      if (filtered.length === 0) fs.rmSync(cat, { force: true });
      else fs.writeFileSync(cat, JSON.stringify({ ...data, skills: filtered }, null, 2));
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

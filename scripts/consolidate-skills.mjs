#!/usr/bin/env node
// One-time skill directory consolidation script.
//
// Goal: make ~/.agents/skills the single source of truth (real dirs), and
// ~/.claude/skills + ~/.gemini/config/skills contain only symlinks pointing
// at central. Claude Desktop 3P directory is wiped per user request.
//
// Usage:
//   node scripts/consolidate-skills.mjs            # dry-run (prints plan, no changes)
//   node scripts/consolidate-skills.mjs --execute  # actually perform changes
//   node scripts/consolidate-skills.mjs --execute --skip-3p  # keep 3P dir intact

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const EXECUTE = process.argv.includes("--execute");
const SKIP_3P = process.argv.includes("--skip-3p");

const HOME = os.homedir();
const ROOTS = {
  central: path.join(HOME, ".agents", "skills"),
  claude: path.join(HOME, ".claude", "skills"),
  antigravity: path.join(HOME, ".gemini", "config", "skills"),
  claudeDesktop3p: "/Library/Application Support/Claude/org-plugins/pawn/skills",
};

// --- helpers ---

function log(tag, msg) {
  const prefix = EXECUTE ? "[EXEC]" : "[DRY]";
  console.log(`${prefix} ${tag.padEnd(14)} ${msg}`);
}

function scanRoot(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!name.isDirectory() && !name.isSymbolicLink()) continue;
    if (name.name.startsWith(".")) continue;
    const full = path.join(dir, name.name);
    let isLink = false, isReal = false, target = null;
    try {
      const st = fs.lstatSync(full);
      isLink = st.isSymbolicLink();
      isReal = st.isDirectory() && !isLink;
      if (isLink) target = fs.readlinkSync(full);
    } catch {
      continue;
    }
    const hasSkill = fs.existsSync(path.join(full, "SKILL.md"));
    out.set(name.name, { isLink, isReal, dir: full, target, hasSkill });
  }
  return out;
}

function copyDirRecursive(srcDir, destDir) {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
}

function removeDirRecursive(targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
}

function makeSymlink(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, "dir");
}

// --- main ---

console.log(`\n${"=".repeat(72)}`);
console.log(`  Skill directory consolidation  mode: ${EXECUTE ? "EXECUTE" : "DRY-RUN"}  skip-3p: ${SKIP_3P}`);
console.log(`${"=".repeat(72)}\n`);

const byRoot = Object.fromEntries(
  Object.entries(ROOTS).map(([k, v]) => [k, scanRoot(v)])
);

const allNames = new Set();
for (const m of Object.values(byRoot)) for (const n of m.keys()) allNames.add(n);

// Skip set: central symlinks (understand-* etc.) - never touch these.
const skipSet = new Set();
for (const [name, info] of byRoot.central) {
  if (info.isLink) skipSet.add(name);
}

// Stats
let planCopyToCentral = 0;
let planReplaceWithSymlink = 0;
let planDeleteBrokenSymlink = 0;
let planDelete3p = 0;
let planCreateSymlink = 0;
let planSkip = 0;

// --- Phase 1: Copy skills not in central into central ---

log("PHASE 1", "Copying skills missing from central into ~/.agents/skills");

const copySources = []; // {name, srcRid, srcDir}
for (const name of [...allNames].sort()) {
  if (skipSet.has(name)) continue;
  const centralEntry = byRoot.central.get(name);
  if (centralEntry && centralEntry.hasSkill) continue;

  let src = null;
  for (const rid of ["claude", "antigravity", "claudeDesktop3p"]) {
    const entry = byRoot[rid]?.get(name);
    if (entry?.isReal && entry.hasSkill) {
      src = { rid, dir: entry.dir };
      break;
    }
  }
  if (!src) {
    log("  WARN", `${name}: central missing and no real source found, skipping`);
    planSkip++;
    continue;
  }
  copySources.push({ name, src });
}

for (const { name, src } of copySources) {
  const destDir = path.join(ROOTS.central, name);
  if (EXECUTE) {
    copyDirRecursive(src.dir, destDir);
    if (!fs.existsSync(path.join(destDir, "SKILL.md"))) {
      throw new Error(`FAILED: copied ${name} but SKILL.md missing at ${destDir}`);
    }
  }
  log("  copy", `${name}  (${src.rid} -> central)`);
  planCopyToCentral++;
}

// --- Phase 2: Delete broken symlinks ---

log("PHASE 2", "Deleting broken symlinks");

for (const rid of ["claude", "antigravity"]) {
  const m = byRoot[rid];
  for (const [name, info] of m) {
    if (!info.isLink) continue;
    if (fs.existsSync(info.dir)) continue; // symlink resolves OK
    if (EXECUTE) fs.unlinkSync(info.dir);
    log("  rm", `${rid}/${name}  (broken symlink -> ${info.target})`);
    planDeleteBrokenSymlink++;
  }
}

// --- Phase 3: Replace non-central real dirs with symlinks to central ---

log("PHASE 3", "Replacing claude/antigravity real dirs with symlinks to central");

// In dry-run, simulate central state after Phase 1 copies.
const centralNow = new Set(byRoot.central.keys());
for (const { name } of copySources) centralNow.add(name);

for (const rid of ["claude", "antigravity"]) {
  const m = byRoot[rid];
  const names = [...m.keys()].sort();
  for (const name of names) {
    if (skipSet.has(name)) {
      planSkip++;
      continue;
    }
    const info = m.get(name);
    if (!info.isReal) continue; // already symlink
    if (!info.hasSkill) {
      log("  skip", `${rid}/${name}  (no SKILL.md, not a standard skill dir)`);
      planSkip++;
      continue;
    }
    if (!centralNow.has(name)) {
      log("  WARN", `${rid}/${name}: central still missing after Phase 1, leaving as real`);
      planSkip++;
      continue;
    }

    const centralDir = path.join(ROOTS.central, name);
    // In dry-run, Phase 1 hasn't actually copied yet. Skills scheduled for
    // copy in Phase 1 will exist at central when Phase 3 runs in execute mode.
    const willBeCopied = !EXECUTE && copySources.some((c) => c.name === name);
    // Safety: verify central actually has SKILL.md before replacing.
    if (!willBeCopied && !fs.existsSync(path.join(centralDir, "SKILL.md"))) {
      log("  WARN", `${rid}/${name}: central SKILL.md missing, leaving as real`);
      planSkip++;
      continue;
    }

    if (EXECUTE) {
      removeDirRecursive(info.dir);
      makeSymlink(centralDir, info.dir);
      // Verify the new symlink resolves to a SKILL.md.
      if (!fs.existsSync(path.join(info.dir, "SKILL.md"))) {
        throw new Error(`FAILED: ${info.dir} symlink did not resolve to SKILL.md`);
      }
    }
    log("  link", `${rid}/${name}  real->symlink -> central`);
    planReplaceWithSymlink++;
  }
}

// --- Phase 4: Delete all Claude Desktop 3P skill copies ---

log("PHASE 4", "Deleting Claude Desktop 3P skill copies");

if (!SKIP_3P) {
  const tp = byRoot.claudeDesktop3p;
  for (const name of [...tp.keys()].sort()) {
    const info = tp.get(name);
    if (EXECUTE) {
      removeDirRecursive(info.dir);
    }
    planDelete3p++;
  }
  if (planDelete3p > 0) {
    log("  rm", `${planDelete3p} skill dirs under ${ROOTS.claudeDesktop3p}`);
  }
} else {
  log("  skip", "Claude Desktop 3P (--skip-3p)");
}

// --- Phase 5: Create missing symlinks so every client sees all central skills ---

log("PHASE 5", "Creating missing symlinks for full sync");

// Re-scan claude/antigravity to account for Phase 3 changes (in execute mode).
const clientRoots = ["claude", "antigravity"];
const clientNow = {};
for (const rid of clientRoots) {
  clientNow[rid] = new Set();
  const base = ROOTS[rid];
  if (!fs.existsSync(base)) continue;
  for (const name of fs.readdirSync(base, { withFileTypes: true })) {
    if (!name.isDirectory() && !name.isSymbolicLink()) continue;
    if (name.name.startsWith(".")) continue;
    clientNow[rid].add(name.name);
  }
}

for (const rid of clientRoots) {
  const centralEntries = [...byRoot.central.keys()].sort();
  for (const name of centralEntries) {
    if (skipSet.has(name)) continue;
    const centralDir = path.join(ROOTS.central, name);
    // Skip central symlinks (understand-*) and skills without SKILL.md.
    if (!fs.existsSync(path.join(centralDir, "SKILL.md"))) continue;
    if (clientNow[rid].has(name)) continue;

    const linkPath = path.join(ROOTS[rid], name);
    if (EXECUTE) {
      makeSymlink(centralDir, linkPath);
      if (!fs.existsSync(path.join(linkPath, "SKILL.md"))) {
        throw new Error(`FAILED: ${linkPath} symlink did not resolve to SKILL.md`);
      }
    }
    log("  mklink", `${rid}/${name}  -> central`);
    planCreateSymlink++;
  }
}

// --- Summary ---

console.log(`\n${"-".repeat(72)}`);
console.log(`  Summary (${EXECUTE ? "EXECUTED" : "DRY-RUN, no changes made"})`);
console.log(`${"-".repeat(72)}`);
console.log(`  Copied to central:        ${planCopyToCentral}`);
console.log(`  Replaced with symlink:    ${planReplaceWithSymlink}`);
console.log(`  Deleted broken symlinks:  ${planDeleteBrokenSymlink}`);
console.log(`  Deleted 3P copies:        ${planDelete3p}`);
console.log(`  Created missing symlinks: ${planCreateSymlink}`);
console.log(`  Skipped (safe):           ${planSkip}`);
console.log(`  Skipped set (understand): ${skipSet.size}`);
if (!EXECUTE) {
  console.log(`\n  This was a DRY-RUN. To execute, run:`);
  console.log(`  node scripts/consolidate-skills.mjs --execute`);
}
console.log();

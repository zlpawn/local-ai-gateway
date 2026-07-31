# Leo Coding Standards Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `leo-coding-standards` as a repository-managed Java coding standards skill that is discoverable, installable, and complete according to the approved design.

**Architecture:** Keep `SKILL.md` as a concise Chinese workflow entry point and place detailed API, engineering, and review guidance in three direct `references/` files. Register the skill in the managed catalog, add a `development` category to the installer, and test the installed package through the real `SkillInstaller` APIs.

**Tech Stack:** Markdown/YAML skill assets, Node.js ESM, `node:test`, repository `SkillInstaller`, Python `quick_validate.py`.

## Global Constraints

- The skill name is exactly `leo-coding-standards`.
- The skill applies only to Java writing, modification, refactoring, tests, review, and standards-remediation work.
- Chinese is used for instructions; `MUST`, `SHOULD`, `CONSIDER`, Java identifiers, and code stay in English.
- Third-party APIs may be used only when the project already has the dependency.
- Do not add Java, Guava, Commons, Maven, Gradle, or validation dependencies to this repository.
- The skill does not initiate downstream Java compilation, tests, formatting, or static analysis.
- Only task-touched Java code is in remediation scope; no broad legacy cleanup.
- Design patterns remain problem-driven `CONSIDER` guidance.
- Preserve the pre-existing uncommitted `managed-catalog.json` timestamp update and append the new catalog entry.

---

### Task 1: Define The Managed Skill Package Contract

**Files:**
- Create: `tests/unit/leo-coding-standards-skill.test.mjs`
- Create: `lib/skills/leo-coding-standards/SKILL.md`
- Create: `lib/skills/leo-coding-standards/agents/openai.yaml`
- Create: `lib/skills/leo-coding-standards/references/java-api-rules.md`
- Create: `lib/skills/leo-coding-standards/references/engineering-principles.md`
- Create: `lib/skills/leo-coding-standards/references/review-checklist.md`

**Interfaces:**
- Consumes: `SkillInstaller.installBaseSkill(centralDir, skillName)`.
- Produces: a complete skill directory whose installed copy contains `SKILL.md`, `agents/openai.yaml`, and all three reference files.

- [x] **Step 1: Write the failing package tests**

Create tests that:

```js
test("leo coding standards skill installs its complete package", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "leo-coding-standards-"));
  try {
    const installedDir = path.join(tmpHome, ".agents", "skills", "leo-coding-standards");
    SkillInstaller.installBaseSkill(installedDir, "leo-coding-standards");

    for (const relativePath of [
      "SKILL.md",
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
```

Also assert the installed policy contains every approved API identifier, the three rule levels, Java-only scope, dependency constraints, optional boundaries, SOLID/LoD/KISS/DRY, restrained design patterns, and review priorities.

- [x] **Step 2: Run the package test and verify RED**

Run:

```bash
node --test tests/unit/leo-coding-standards-skill.test.mjs
```

Expected: FAIL because `lib/skills/leo-coding-standards/SKILL.md` does not exist and `installBaseSkill` reports no managed content.

- [x] **Step 3: Initialize the skill skeleton**

Run:

```bash
python3 /Users/pa/.codex/skills/.system/skill-creator/scripts/init_skill.py \
  leo-coding-standards \
  --path lib/skills \
  --resources references \
  --interface 'display_name=Leo Java 编码规范' \
  --interface 'short_description=约束 Java 编写、重构、测试与代码审查' \
  --interface 'default_prompt=Use $leo-coding-standards to write or review this Java code according to Leo coding standards.'
```

Expected: creates the skill directory, `SKILL.md`, `agents/openai.yaml`, and `references/`.

- [x] **Step 4: Write the concise skill workflow**

Replace the generated `SKILL.md` with:

- exact approved frontmatter;
- Java-only scope;
- project context inspection;
- task-based reference loading;
- conflict order;
- `MUST` / `SHOULD` / `CONSIDER`;
- touched-code-only scope;
- coding and review output behavior;
- explicit statement that verification belongs to explicit task instructions or other skills.

- [x] **Step 5: Write the three focused references**

Write:

- `java-api-rules.md` with all 12 approved API entries, dependency and Java-version rules, examples, reasonable exceptions, and `Optional` boundaries;
- `engineering-principles.md` with executable SOLID/LoD/KISS/DRY guidance, naming, exceptions, logs, comments, testability, and problem-driven pattern selection;
- `review-checklist.md` with review order, `P0`-`P3`, concrete-impact reporting, and no preference-only findings.

- [x] **Step 6: Verify package GREEN**

Run:

```bash
node --test tests/unit/leo-coding-standards-skill.test.mjs
```

Expected: all package and installed-content tests PASS.

### Task 2: Register Development Category And Managed Discovery

**Files:**
- Modify: `lib/skills/managed-catalog.json`
- Modify: `lib/session-sync/skill-installer.mjs`
- Modify: `tests/unit/skills-library.test.mjs`

**Interfaces:**
- Consumes: the skill package from Task 1.
- Produces: managed catalog metadata, `development` category inference, search discovery, and complete installation through `ensureManagedSkills()`.

- [x] **Step 1: Write failing catalog and discovery tests**

Add tests that:

```js
const managed = SkillInstaller.getManagedSkill("leo-coding-standards");
assert.equal(managed.category, "development");
assert.equal(managed.categoryLabel, "开发工程");
```

Use a temporary home, call `SkillInstaller.ensureManagedSkills(tmpHome)`, then verify:

- the installed skill is managed and installed;
- its category is `development`;
- category metadata contains `{ id: "development", label: "开发工程" }`;
- queries `java`, `coding standards`, and `代码规范` each return the skill;
- installed `agents/openai.yaml` and all references exist.

Create a temporary uncataloged local skill named `java-review-local` and verify keyword inference classifies it as `development`.

- [x] **Step 2: Run catalog tests and verify RED**

Run:

```bash
node --test tests/unit/skills-library.test.mjs
```

Expected: FAIL because `development` category metadata, inference, and catalog registration do not exist.

- [x] **Step 3: Add managed metadata**

Append the approved `leo-coding-standards` entry to `lib/skills/managed-catalog.json`, preserving existing entries and the pre-existing timestamp change.

- [x] **Step 4: Add development category behavior**

In `lib/session-sync/skill-installer.mjs`:

- add `development: { id: "development", label: "开发工程", order: 80 }`;
- infer `development` for Java/coding/code-review/refactor/engineering terms before the broad workflow fallback;
- use the development icon when metadata does not specify an icon.

- [x] **Step 5: Verify catalog GREEN**

Run:

```bash
node --test tests/unit/skills-library.test.mjs tests/unit/leo-coding-standards-skill.test.mjs
```

Expected: all tests PASS.

### Task 3: Validate The Skill And Run Regression Checks

**Files:**
- Modify only if validation reveals a defect in files from Tasks 1-2.

**Interfaces:**
- Consumes: completed managed skill package.
- Produces: validation evidence and a clean repository diff.

- [x] **Step 1: Run official skill validation**

Run `quick_validate.py` against `lib/skills/leo-coding-standards`. If `PyYAML` is unavailable, install it into a temporary directory outside the repository and invoke the validator with `PYTHONPATH` pointing there. Do not modify `package.json`, lockfiles, or project Python dependencies.

Expected: validator reports the skill is valid.

- [x] **Step 2: Run focused tests**

Run:

```bash
node --test tests/unit/leo-coding-standards-skill.test.mjs tests/unit/skills-library.test.mjs
```

Expected: all focused tests PASS.

- [x] **Step 3: Run broader installer regressions**

Run:

```bash
node --test tests/unit/session-sync.test.mjs tests/unit/leo-grok-imagine-skill.test.mjs tests/unit/skills-library.test.mjs tests/unit/leo-coding-standards-skill.test.mjs
```

Expected: all tests PASS.

- [x] **Step 4: Run syntax and diff checks**

Run:

```bash
npm run check
git diff --check
```

Expected: both commands exit successfully.

- [x] **Step 5: Review requirements and commit**

Verify every approved design section maps to the implemented files, inspect `git diff`, and commit:

```bash
git add \
  docs/superpowers/plans/2026-07-30-leo-coding-standards.md \
  lib/skills/leo-coding-standards \
  lib/skills/managed-catalog.json \
  lib/session-sync/skill-installer.mjs \
  tests/unit/leo-coding-standards-skill.test.mjs \
  tests/unit/skills-library.test.mjs
git commit -m "feat: add leo java coding standards skill"
```

Expected: commit succeeds on `codex/leo-coding-standards`.

## Validation Limitation

The current tool surface does not expose an independent subagent executor. Structural validation, real installer behavior, catalog discovery, and policy coverage are automated here. Independent baseline-versus-skill agent pressure tests from `superpowers:writing-skills` remain a follow-up validation surface when a multi-agent runtime is available.

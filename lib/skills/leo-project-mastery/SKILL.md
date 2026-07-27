---
name: leo-project-mastery
description: Internalize an unfamiliar or partially known codebase into a code-evidenced business and technical mental model, then turn that understanding into interview-ready explanations and deep-dive defenses. Use for whole-repository project mastery, business-flow and architecture analysis, genuine difficulty/highlight discovery, interview preparation, or tracing a specific method in business context. Triggers include "看懂这个项目", "梳理项目业务逻辑", "分析项目难点亮点", "把项目内化成自己的知识", "准备面试讲项目", and "解释这个方法的业务逻辑".
---

# Leo Project Mastery

Turn a whole repository or a specific method into knowledge the user can understand, retell, drill into, and defend. Treat the output as a private project-mastery dossier, not merely public project documentation.

## Non-negotiable Order

Follow this order:

1. **Cover the core**: inventory the available scope and identify the real business center before selecting stories or highlights.
2. **Obey the evidence**: separate verified facts, document claims, inferences, conflicts, unknowns, and improvement ideas.
3. **Teach before compressing**: explain the project from plain-language business value to code-level mechanics.
4. **Build mastery**: produce recall checks, probing questions, and a map of weak or unverified areas.
5. **Prepare interview expression**: generate concise narratives only from the established mental model.

Do not generate interview claims while the core-flow or evidence audit is incomplete. Never convert a likely design, an improvement suggestion, a sample metric, or a plausible business reason into current-project fact.

## Choose the Analysis Mode

- **Repository mode**: use when given a repository, service, or sub-project. Read [repository-mode.md](references/repository-mode.md).
- **Method mode**: use when given a method, class, endpoint, consumer, job, or other focused symbol. Read [method-mode.md](references/method-mode.md).
- If a method is named inside an otherwise whole-project request, run repository mode first and add a focused method deep dive.
- If the workspace is a monorepo, infer service relationships from build files, imports, deployment files, routes, and data flow. Ask for scope only when multiple independent products remain equally plausible.
- In method mode, constrain every workflow step to the symbol's trace envelope. Do not inventory or claim coverage of unrelated project domains.

## Workflow

### 1. Establish Scope and Evidence Rules

State what is in scope, what is excluded, and whether the available material includes backend, frontend, schema, configuration, tests, and documentation. Read and apply [evidence-and-coverage.md](references/evidence-and-coverage.md).

Completion criterion: the analysis has an explicit scope statement and an initial coverage ledger; uninspected areas are visible rather than silently ignored.

### 2. Inventory Before Deep Analysis

In repository mode, map modules, business entry points, persistence anchors, state fields, schedulers, message handlers, callbacks, external integrations, configuration/rule sources, outputs, tests, and recovery paths. Classify each as core candidate, supporting, infrastructure, generated, deprecated-looking, or unresolved.

In method mode, inventory only the reachable callers, meaningful entry, callees, persistence, states, side effects, tests, and recovery behavior needed to place the symbol in its business lifecycle.

Identify core candidates using multiple signals: business value, lifecycle control, data centrality, orchestration centrality, failure impact, and project specificity. Code size or interview appeal alone is not evidence of core status.

Completion criterion: every discovered business entry and high-signal module is either mapped to a candidate flow or explicitly excluded with a reason.

### 3. Reconstruct the System

Trace the representative business flows from trigger to user/business outcome:

`trigger -> validation -> orchestration -> data changes -> external effects -> state transitions -> output -> failure/recovery`

For each load-bearing conclusion, attach repo-relative code evidence and an evidence label. Explain contradictions rather than resolving them by guesswork. Build the overview diagram only after this reconstruction is stable.

Completion criterion: each selected core flow has its trigger, business meaning, main data anchor, terminal outcomes, and important failure paths accounted for.

### 4. Teach the User

Read [teaching-and-mastery.md](references/teaching-and-mastery.md). Explain in this progression:

1. six plain-language orientation questions;
2. business vocabulary;
3. one concrete scenario through the system;
4. business rules and state changes;
5. modules, code anchors, and technical mechanisms;
6. trade-offs, boundaries, and unresolved questions.

Do not begin with framework inventories or class-by-class narration.

Completion criterion: a newcomer can first understand what happens and why, then locate where it happens in code.

### 5. Discover Genuine Difficulties and Highlights

Look for project-specific constraints and failure consequences: consistency, concurrency, idempotency, recovery, resource limits, performance, security, complex business rules, external-system unreliability, configurability, observability, and AI-specific correctness when applicable.

A highlight must contain: concrete scenario, consequence, constraint, current implementation, evidence, trade-off, known boundary, and verification status. Treat ordinary framework usage and design-pattern names as implementation vocabulary, not difficulties.

If the project has no defensible deep-water problem, say so. Keep weaknesses, incomplete mechanisms, dead paths, mocks, and doc/code mismatches visible.

Completion criterion: every claimed highlight is implemented and evidenced; proposals are in a separate improvement section.

### 6. Produce the Mastery Dossier

Use [project-mastery-template.md](references/project-mastery-template.md), adapting rather than filling irrelevant sections. In repository mode, default to `PROJECT_MASTERY.md`. In method mode, default to `METHOD_MASTERY.md` and omit project-wide sections that the local evidence cannot support. Honor a user-specified path. For a large repository, optionally split evidence and interview material under `docs/project-mastery/`.

Use repo-relative links with line anchors. Never emit `file:///` links. Never leave placeholders in the final artifact.

Read [diagramming.md](references/diagramming.md) only when diagrams add clarity. A whole-project overview belongs near the beginning of the document but is synthesized late in the analysis.

Completion criterion: the dossier cleanly separates current facts, inferences, unknowns, and recommendations, and contains no unsupported metrics or first-person ownership claims.

### 7. Build Interview Mastery

Read [interview-output.md](references/interview-output.md). In repository mode, generate 30-second, 2-minute, and optional 10-minute project explanations. In method mode, generate a concise method explanation, its place in the business flow, and implementation-level follow-ups; add project-level narrative only when the available evidence supports it. In both modes, produce relevant difficulty cards, layered follow-up trees, safe wording for project knowledge versus personal contribution, and self-tests that send weak answers back to code evidence.

The user may deeply understand code they did not originally write. Optimize for genuine command of the project, not simulated authorship. Use "the project/we use" for project facts; reserve "I designed/implemented" for user-confirmed contribution.

Completion criterion: every answer can be traced to the dossier, and every ownership or production-scale claim is confirmed or visibly marked for user input.

### 8. Run the Reverse Completeness Audit

Before finishing, verify:

- every business entry belongs to a documented flow or justified exclusion;
- every core data anchor has creators, readers, mutations, and terminal meaning;
- every key state has known entry/exit paths or an explicit gap;
- every external dependency has purpose and failure impact;
- every scheduler, consumer, callback, and compensation path has a business role;
- success, failure, retry, timeout, cancellation, and manual recovery are covered where present;
- diagrams, prose, and code evidence agree;
- no recommendation is described as current implementation;
- no metric, outcome, business rationale, or contribution is invented;
- skipped areas and unresolved conflicts are listed.

If any gate fails, label the result `partial` and say exactly what remains unverified. Never claim complete project coverage without this audit.

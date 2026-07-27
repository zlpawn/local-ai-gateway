---
name: leo-internalize-knowledge
description: Use when the user provides a Craft, Lark/Feishu, web, PDF, Office, local, image-rich, or similar document and asks to internalize, ingest, curate, or 沉淀 it into a specified knowledgebase root. Completely read text, tables, code, images, whiteboards, embedded resources, and attachments; analyze context, architecture, evolution, metrics, trade-offs, and limitations; produce a coverage-audited proposal first; and write source snapshots, local media, reusable knowledge pages, interview explanations, and technical-sharing material only after user approval. Do not trigger for ordinary summarization, translation, or document-only Q&A without a knowledgebase destination.
---

# Leo Internalize Knowledge

Internalize external material into a user-specified knowledgebase without losing the source's load-bearing content. Optimize the result for professional interview explanation, understanding why a system evolved, and technical sharing with newcomers.

## Required Inputs

Require both:

- A source document, URL, app location, or local file.
- A target knowledgebase root directory.

Accept an optional focus and verification mode: `none`, `light` (default), or `targeted`. Do not invent or auto-detect a permanent knowledgebase path.

## Non-Negotiable Rules

1. Treat text, tables, code, images, diagrams, whiteboards, embeds, and attachments as source evidence.
2. Do not omit load-bearing content: business problem, architecture, evolution causality, mechanisms, metrics, trade-offs, and boundaries.
3. Keep author claims, curated synthesis, and agent assessment visibly separate.
4. Never claim to have visually read an image that was inferred only from surrounding prose.
5. Do not modify the target root during Phase 1.
6. Publish only after explicit user approval of the proposal.
7. Follow the target root's existing rules, templates, naming, metadata, and linking conventions. This is not an Obsidian-only importer.
8. Prefer updating existing knowledge over creating duplicates.
9. Do not merely shorten or retell the source in order. Reorganize it into a causal model: problem and constraints, prior approach and failure, core mechanisms, evolution decisions, evidence, trade-offs, and boundaries.
10. Keep pages conceptually focused and reusable, while preserving enough context to derive conclusions rather than memorize them.

## Workflow

### Phase 1: Read, Understand, Assess, Propose

1. Inspect the target root's instructions and representative content, excluding `leo/internalize-knowledge/**`. Learn its conventions without changing it.
2. Create an owned temporary run:

```bash
python3 <skill-dir>/scripts/run_workspace.py init \
  --source "<source>" \
  --target-root "<root>" \
  --verification light
```

3. Read the complete source and all reachable evidence. Use [source-connectors.md](references/source-connectors.md) for source-specific routing.
4. Build a section ledger, media manifest, claim ledger, outline, source snapshot, and visual analysis in the run directory.
5. Classify every source section as `load-bearing`, `supporting`, or `contextual`, and give it one disposition: `curated`, `source-only`, `blocked`, or `uncertain`.
6. Apply the content and visual gates in [coverage-and-visual-gates.md](references/coverage-and-visual-gates.md).
7. Assess the design professionally but non-dogmatically. Identify strengths, rationale, missing conditions, boundaries, risks, and possible improvements. Do not attribute inferred improvements to the original project.
8. Verify selectively according to the chosen mode. Prefer first-party documentation, specifications, official repositories/releases, and original papers. Internal implementation and performance claims remain `source-claimed` unless independently supportable.
9. Produce the proposal using [proposal-template.md](references/proposal-template.md). Include 3-6 interpretation bullets for every core image.
10. Present the proposal and wait. Do not publish, even when the destination seems obvious.

If a load-bearing image or section cannot be read, mark the proposal `BLOCKED` and explain what access or artifact is needed.

### Phase 2: Archive, Curate, Link, Audit, Cleanup

Begin only after explicit approval.

1. Reconcile requested proposal changes.
2. Preserve a complete source snapshot, source metadata, and important media locally in the target root.
3. Create or update the approved pages. Keep explanations professional and self-contained; do not rely on analogy unless requested.
4. Connect pages with meaningful links. Update navigation, topic maps, or logs only if the target already uses them.
5. Audit all load-bearing sections, claims, and images against the published result.
6. Verify links, media paths, metadata, and readable artifacts using [publication-and-audit.md](references/publication-and-audit.md).
7. Mark the run published and record a passing audit:

```bash
python3 <skill-dir>/scripts/run_workspace.py set-status \
  --run-dir "<run-dir>" --status published
python3 <skill-dir>/scripts/run_workspace.py record-audit \
  --run-dir "<run-dir>" --result pass
```

8. Clean only that owned run:

```bash
python3 <skill-dir>/scripts/run_workspace.py cleanup --run-dir "<run-dir>"
```

Do not clean on interruption, extraction failure, publication failure, or failed audit. If the user rejects the proposal, ask before removing the run.

## Output Standard

The curated knowledge should let a reader:

- Explain the problem, constraints, architecture, mechanisms, evolution, trade-offs, and results in an interview.
- Reconstruct why the system evolved instead of memorizing a conclusion.
- Deliver a newcomer-friendly technical sharing while preserving professional precision.
- Trace important statements and images back to the archived source.

Adapt page count to the material. Possible page roles include source, system, concept, method, query, comparison, and navigation, but only create roles that fit the target knowledgebase.

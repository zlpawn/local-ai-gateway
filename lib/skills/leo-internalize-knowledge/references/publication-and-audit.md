# Publication and Audit

Phase 2 starts only after explicit approval. Record approval and proposal changes in the run metadata or extraction notes before writing.

## Publication Sequence

1. Re-read the target root's rules and confirm paths.
2. Save the complete source snapshot and metadata.
3. Copy original core media where available; preserve provenance and source anchors.
4. Create or update only approved knowledge pages.
5. Add meaningful links and backlinks according to target conventions.
6. Update indexes, maps, or logs only when the target already maintains them.
7. Run the audits below.
8. Mark `published`, record audit `pass`, then clean the owned run.

Do not overwrite user-authored content blindly. Merge with existing pages and preserve unrelated changes.

## Required Audits

### Source Fidelity

- Every source section appears in the content coverage matrix.
- Every load-bearing section is represented in curated knowledge.
- Author claims retain their scope, conditions, and uncertainty.
- Source-only content remains in the full snapshot.

### Visual Fidelity

- Every discovered media item appears in the media matrix.
- Every load-bearing image has a local asset or an explicit approved exception.
- Every load-bearing image has 3-6 interpretation bullets in the proposal or resulting knowledge.
- Captions, legends, labels, units, and diagram direction are preserved.

### Knowledge Quality

- The problem, constraints, architecture, mechanisms, evolution, trade-offs, evidence, and boundaries are recoverable.
- Original claims, synthesis, and assessment are distinguishable.
- New pages do not duplicate an existing concept without reason.
- Interview and sharing narratives trace back to evidence.

### Repository Integrity

- Frontmatter or metadata follows target rules.
- Links and embeds resolve.
- Media paths use target conventions.
- Index/log updates are internally consistent.
- No temporary path is referenced by published pages.
- The target tree contains no unintended files.

## Audit Result

Write a concise audit record in the run directory:

```yaml
result: pass | fail
checked_at: <timestamp>
load_bearing_sections_total: 0
load_bearing_sections_covered: 0
load_bearing_media_total: 0
load_bearing_media_covered: 0
broken_links: []
temporary_references: []
notes: []
```

Any uncovered load-bearing item, broken required artifact, or temporary reference fails the audit. Preserve the run on failure.

## Cleanup Safety

Use `scripts/run_workspace.py cleanup`; do not delete manually.

Cleanup is allowed only when:

- `run.yaml` identifies this Skill as owner.
- The resolved run path exactly matches the recorded path.
- The run is directly under the recorded `leo/internalize-knowledge` parent.
- Status is `published`.
- Audit result is `pass`.

Cleanup removes only the current run directory. It must never remove `internalize-knowledge`, `leo`, the current workspace, or the target knowledgebase root.

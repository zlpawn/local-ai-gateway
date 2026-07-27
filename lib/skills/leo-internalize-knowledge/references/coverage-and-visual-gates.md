# Coverage and Visual Gates

Completeness is a publication gate, not an aspiration.

## Section Ledger

Represent every original section, block group, appendix, and meaningful embed. Each entry must include:

```yaml
- source_id: stable source anchor
  title: section title or generated label
  importance: load-bearing | supporting | contextual
  read_status: complete | partial | unreadable
  disposition: curated | source-only | blocked | uncertain
  destinations: []
  notes: ""
```

Classification:

- `load-bearing`: business problem, constraints, architecture, evolution causality, mechanisms, metrics, boundaries, or conclusions required to understand the system.
- `supporting`: examples, scenarios, implementation fragments, code, secondary evidence.
- `contextual`: repetition, promotion, biography, acknowledgements, or non-technical framing.

All load-bearing entries must be read completely and enter curated knowledge. Supporting entries may be curated or explicitly source-only. Contextual entries may be source-only but must remain represented in the ledger and source snapshot.

## Claim Ledger

Track important claims separately:

```yaml
- claim: concise statement
  source_anchor: section/block/page
  claim_type: author-claim | synthesis | assessment | verified-comparison
  evidence: text | table | image | mixed
  conditions: []
  confidence: high | medium | low
  destinations: []
```

Preserve the conditions around metrics: dataset, time window, workload, baseline, hardware, concurrency, percentile, and measurement method when available. Missing conditions must be called out.

## Visual Gate

Classify each image:

- `load-bearing`: removing it loses architecture, flow, state transition, quantitative result, UI evidence, or other meaning not fully recoverable from prose.
- `supporting`: reinforces or exemplifies prose.
- `decorative`: carries no substantive evidence.

Default “see figure below” images to `load-bearing` until inspected.

For every load-bearing image, provide 3-6 bullets covering the applicable items:

- Purpose and question answered
- Components, layers, or actors
- Flow, arrows, transitions, or dependencies
- Metrics, legend, axes, units, or experimental conditions
- Information present in the image but absent from prose
- Conflicts, ambiguity, truncation, or unreadable regions

Also record source anchor, importance, read status, confidence, and destination.

## Blocking Rules

- Unreadable load-bearing section: `BLOCKED`; do not publish.
- Unreadable load-bearing image: `BLOCKED`; do not publish.
- Partially readable load-bearing evidence: block unless the missing part is demonstrably immaterial.
- Unreadable supporting evidence: proposal may proceed with an explicit gap.
- Unreadable decorative evidence: does not block.
- Unsupported inference: label as synthesis or assessment, never as an author claim.

## Coverage Matrices

Before requesting approval, compute:

### Content Coverage

| Source item | Importance | Read status | Disposition | Destination | Notes |
|---|---|---|---|---|---|

### Media Coverage

| Media item | Importance | Read status | Local asset | Destination | Confidence |
|---|---|---|---|---|---|

The proposal is ready only when every discovered item appears in the relevant matrix and no load-bearing item is unresolved.

## Cross-Validation

Compare text, images, tables, and code for:

- Matching component names and boundaries
- Consistent arrows, state transitions, and data flow
- Consistent numbers, units, legends, and baselines
- Diagram elements absent from prose
- Prose claims unsupported or contradicted by figures

Report discrepancies without silently resolving them.

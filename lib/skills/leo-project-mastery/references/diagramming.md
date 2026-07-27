# Diagramming

Use diagrams to clarify an established model, not to discover or invent it.

## Timing

Analyze first. Synthesize the whole-project overview after core flows, data anchors, states, and capabilities are stable. Place it near the beginning of the final dossier.

## Diagram Types

- `erDiagram`: core business relationships, not every table.
- `stateDiagram-v2`: transitions found through actual writers and guards.
- `sequenceDiagram`: time-ordered core or failure flows.
- `flowchart`: routing, processing, configuration, or recovery.

Keep structural diagrams inline as Mermaid when practical so they remain editable and reviewable. Split diagrams that become difficult to scan.

## Overview Diagram

For a whole-project dossier, combine:

- core business pillars;
- representative end-to-end flow;
- capabilities supporting each stage;
- success and important failure/recovery outcomes.

Use project-specific pillars, never generic "API/data/UI layers" as substitutes for understanding.

A rendered PNG/SVG is optional when image-generation or rendering tools are available and visual polish materially helps. Mermaid is an acceptable primary output. Do not introduce a tool or connector dependency solely to satisfy a decorative preference.

If generating an image:

- save it under `docs/project-mastery/diagram/` or the user-specified directory;
- prefer a light, readable background;
- inspect the result for missing CJK glyphs, clipping, tiny text, and contradictions with the prose;
- include a text summary or equivalent structural diagram for accessibility and maintainability.

## Consistency Gate

Before finishing, compare every diagram against:

- documented flow order;
- actual state names;
- external dependencies;
- success/failure paths;
- code evidence.

When a diagram and the code disagree, fix the diagram or label the unresolved conflict. Do not choose the more visually convenient story.

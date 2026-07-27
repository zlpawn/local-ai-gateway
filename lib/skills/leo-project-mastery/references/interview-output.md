# Interview Output

Interview preparation is a compression and stress-test of established understanding.

## Repository Narrative Versions

Generate from the same verified mental model:

- **30 seconds**: product, user/problem, core result, one distinguishing capability.
- **2 minutes**: background, representative flow, architecture shape, two or three genuine challenges.
- **10 minutes**: business lifecycle, core model/state, technical decisions, failure handling, limits, and reflection.

Use natural spoken language. Avoid lists of technologies without business context.

## Method Narrative

For method mode, generate:

- **one sentence**: the business responsibility;
- **about one minute**: trigger, validation/rules, data or state changes, side effects, outcome;
- **deep dive**: transaction, idempotency, concurrency, failure, boundaries, and code anchors.

State the method's project context only to the depth established by the local trace. Do not manufacture a whole-project introduction from one symbol.

## Difficulty Card

For each defensible difficulty:

1. business scenario and consequence;
2. engineering constraint;
3. current implementation;
4. code evidence;
5. verified guarantee;
6. trade-off;
7. failure boundary or unresolved risk;
8. how to improve if redesigned.

Do not invent rejected alternatives or say "we considered X" without evidence or user confirmation. Present alternatives as analytical comparison, not project history.

## Follow-up Tree

Probe each core flow and difficulty through:

- business rationale;
- implementation depth;
- correctness and idempotency;
- concurrency and scale;
- failure and recovery;
- operations and diagnosis;
- security or compliance where applicable;
- trade-off and alternatives;
- current limitation;
- redesign or evolution.

For every answer provide:

- a concise safe answer;
- the code/business facts it relies on;
- unsupported statements to avoid;
- one likely second-order follow-up.

## Knowledge Versus Contribution

Deep understanding does not require original authorship. Keep these dimensions separate:

| Dimension | Question |
|---|---|
| Knowledge depth | Can the user explain, locate, debug, and defend it? |
| Contribution fact | Did the user design, implement, review, operate, inherit, or later study it? |

Recommended wording:

- Project fact: "这个项目里采用了……" / "我们的系统通过……"
- Deep understanding: "这块的核心机制是……我展开讲一下。"
- Confirmed implementation: "这块由我设计/实现……"
- Later ownership or study: "这块不是最初由我实现，但我后来做了深入梳理/接手维护……"

Never infer contribution from Git authorship, code complexity, or repository access. Ask the user or mark it `待确认`.

## Metrics and Outcomes

Only include metrics sourced from:

- user confirmation;
- monitoring or benchmark artifacts;
- production configuration that directly establishes the value;
- reproducible calculation with explicit inputs.

Otherwise produce a "numbers to collect" checklist. Never fill sample values into the final answer.

## Mastery Map

For each important topic include:

| Topic | Target level | Evidence to study | Self-test | Demonstrated level |
|---|---|---|---|---|

Set `Demonstrated level` to `待用户验证` unless the user has completed an interactive check.

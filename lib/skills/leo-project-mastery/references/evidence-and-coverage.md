# Evidence and Coverage Contract

Use this reference in both repository and method modes.

## Evidence Labels

Label load-bearing claims with one of:

| Label | Meaning | May be stated as fact? |
|---|---|---|
| `代码证实` | Implementation, SQL, schema, configuration, or test directly demonstrates it | Yes, within the observed scope |
| `用户确认` | The user supplied the business context, production fact, ownership, or metric | Yes, attribute when useful |
| `文档声明` | README or design documentation states it, but code does not fully verify it | Only as a document claim |
| `交叉推断` | Multiple code facts support the conclusion without an explicit declaration | State as an inference |
| `待确认` | Evidence is missing or the answer depends on runtime/business knowledge | No |
| `发现冲突` | Code, docs, tests, configuration, or different modules disagree | No; present both sides |

Prefer evidence near the claim. Use a compact evidence map when inline references would make the teaching section unreadable.

## Never Infer These Silently

- original design intent or historical decision-making;
- what a user sees when the frontend or caller is unavailable;
- whether configured or dormant code is enabled in production;
- QPS, P99, data volume, machine count, revenue, savings, or percentage improvements;
- personal ownership or authorship;
- whether dead-looking or mock-looking code has an out-of-repository caller;
- business meaning that depends on company policy rather than implementation.

For calculated numbers, include the formula and sourced inputs. Otherwise write `待确认`, not a plausible estimate.

## Keep Four Things Separate

For each important topic, distinguish:

1. **Current implementation**: what exists now.
2. **Verified effect**: what that implementation demonstrably guarantees.
3. **Known gap or unknown**: what evidence does not establish.
4. **Improvement idea**: what could be changed.

Never backfill a missing current mechanism with its improvement idea.

## Coverage Ledger

Maintain a ledger during analysis:

| Area | Status | Role | Evidence inspected | Included/excluded reason | Open question |
|---|---|---|---|---|---|

Allowed status values:

- `deep`: traced through business meaning and code;
- `surveyed`: inspected enough to classify;
- `partial`: important but incompletely traced;
- `excluded`: intentionally outside scope, with reason;
- `unresolved`: relationship or relevance cannot yet be determined.

The ledger is an analysis control, not necessarily a full final-document section. Include a concise version in the dossier so blind spots remain visible.

## Core Detection

Judge core candidates using several signals:

- **Business value**: directly determines the user's/business's result.
- **Lifecycle control**: creates, advances, or terminates the main record.
- **Data centrality**: many flows coordinate through its record or identifier.
- **Orchestration centrality**: connects stages, modules, or external systems.
- **Failure impact**: failure blocks the product, corrupts state, or causes material loss.
- **Project specificity**: distinguishes this project from ordinary infrastructure or CRUD.

Do not rank a module as core merely because it is large, sophisticated, uses fashionable technology, or is easy to discuss in interviews.

## Reverse Coverage Checks

At the end, reconcile:

- entries to flows;
- flows to data mutations and outcomes;
- states to transition writers and recovery;
- external calls to timeout/failure behavior;
- outputs to consumers;
- configs to readers;
- schedulers/consumers/callbacks to their business purpose;
- claimed highlights to real code;
- docs to implementation.

When the repository is too large for exhaustive tracing, report representative coverage and enumerate the untraced domains. Do not use "complete" as shorthand for "large sample".

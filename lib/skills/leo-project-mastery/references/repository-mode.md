# Repository Mode

Use this mode for a whole repository, service, module, or monorepo product.

## Pass 1: Repository Survey

Inspect, as applicable:

- build and workspace manifests;
- module/service boundaries and dependency direction;
- deployment/configuration files;
- API/RPC routes;
- message producers and consumers;
- schedulers, event listeners, callbacks, and batch/CLI entry points;
- entities, migrations, schemas, repositories, and state enums;
- external clients and integration adapters;
- frontend routes or callers that reveal user actions and outputs;
- tests, fixtures, documentation, and sample configuration;
- generated, vendored, deprecated-looking, mock, and migration-only areas.

Classify before deep tracing. Do not narrate the repository tree as the final explanation.

## Pass 2: Core Candidate Map

Create a compact candidate table:

| Candidate | Business role | Entry | Data anchor | Outcome | Core signals | Confidence |
|---|---|---|---|---|---|---|

Select the smallest set of flows that explains most of the product's business value, usually one to three. Keep other real domains in the coverage ledger so focus does not become omission.

## Pass 3: Bidirectional Tracing

Trace forward from every high-signal entry and backward from:

- core tables or aggregate roots;
- terminal statuses;
- user-visible outputs;
- externally emitted events;
- retry, timeout, cancellation, and compensation records.

Forward-only tracing misses recovery and hidden writers. Backward-only tracing misses triggers and user intent.

## Pass 4: Business Reconstruction

For each core flow, capture:

- actor or triggering system;
- initiating business event;
- prerequisites and rejection rules;
- core record creation;
- state and data mutations;
- external interactions;
- output semantics;
- success terminal state;
- retryable and non-retryable failure paths;
- timeout, cancellation, replay, and manual handling where implemented;
- evidence gaps.

Build state machines from actual writers and guards, not only enum constants.

## Pass 5: Cross-domain and Operational Paths

Check supporting paths that are easy to miss:

- configuration/rule authoring and runtime consumption;
- admin or manual-repair operations;
- reconciliation and cleanup jobs;
- audit, snapshots, outbox/inbox, and idempotency records;
- data import/export and migration;
- access control and tenant boundaries;
- observability used to diagnose the core flow.

Include them when they alter business behavior, reliability, or interview-worthy understanding.

## Large Repositories

Use staged depth:

1. survey all top-level modules;
2. deep-trace core candidates;
3. survey supporting domains;
4. list unresolved or excluded areas;
5. avoid claiming repository-wide completeness when only representative flows were traced.

Split outputs only when a single file would become difficult to study:

```text
docs/project-mastery/
├── PROJECT_MASTERY.md
├── CODE_EVIDENCE.md
├── INTERVIEW_QA.md
└── diagram/
```

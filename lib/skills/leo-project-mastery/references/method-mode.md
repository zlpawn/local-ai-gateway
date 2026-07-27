# Method Mode

Use this mode when the user names a method, class, endpoint, consumer, job, SQL operation, or focused symbol.

## Scope Contract

State that the result is a local mental model unless broader repository analysis is also requested. Do not generalize one method into a complete project description.

Default output: `METHOD_MASTERY.md`. Reuse only the relevant portions of the mastery template; do not emit empty project-wide sections.

## Trace Outward

Trace enough context to answer:

- Which business action or event does this symbol represent?
- Who calls or triggers it?
- What do its inputs and outputs mean to the business?
- What preconditions, authorization checks, and business rules does it enforce?
- What data does it read, create, update, or delete?
- Which status transitions occur, and under what guards?
- What downstream calls, messages, jobs, or other side effects does it trigger?
- Where are transaction, concurrency, idempotency, retry, and timeout boundaries?
- What does failure mean to the caller or business flow?
- Where does this method sit in the larger lifecycle?

Follow callers upward to a meaningful entry and callees downward to meaningful persistence or external effects. Stop when additional hops no longer change the business explanation; list unresolved dynamic/reflection-based edges.

## Explain in Five Layers

1. **One-sentence responsibility**
2. **Plain-language walkthrough**
3. **Business rules and data/state changes**
4. **Technical mechanism and code anchors**
5. **Risks, boundaries, likely interview follow-ups**

Do not perform line-by-line translation unless a line encodes a non-obvious rule.

## Local Completeness Checks

Before finishing, verify:

- all direct callers and meaningful triggers were searched;
- all business-significant callees and side effects were traced;
- transaction annotations/configuration and exception behavior were checked;
- status and persistence writes were reconciled with schema/enums;
- unknown external or runtime behavior is marked;
- the output names project areas not covered by this focused analysis.

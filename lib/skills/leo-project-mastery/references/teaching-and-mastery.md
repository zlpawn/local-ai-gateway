# Teaching and Mastery

The user may begin with no domain context. Teach before producing polished interview wording.

## Orientation

Answer these six questions in plain language:

1. Who or what uses the system?
2. What real problem does it solve?
3. What event starts its main work?
4. What happens from start to finish?
5. What result does the business user or downstream system receive?
6. What would fail, remain manual, or become costly without it?

Avoid framework names and class inventories here.

## Vocabulary

Build a business-first glossary:

| Code/schema term | Business term | Plain-language meaning | Role in lifecycle |
|---|---|---|---|

Include core nouns, important identifiers, statuses, configuration concepts, and outputs. Do not list every DTO or infrastructure entity.

## Concrete Scenario

Use one evidence-consistent example to walk through the core flow. Clearly label any illustrative values as examples. At each step explain:

- **Business**: why the step exists;
- **System**: which capability owns it;
- **Code**: where the behavior is implemented.

## Explain Why

For each non-obvious rule, ask:

- Why does this event trigger work while a similar event does not?
- Why is this idempotency key or status guard used?
- Why is the data snapshotted or read live?
- Why is this failure retryable or terminal?
- Why is this action inside or outside a transaction?
- What does the design trade away to gain its current property?

Mark inferred rationale as `交叉推断`; do not phrase it as historical intent.

## Mastery Levels

Use these as learning targets, not unsupported assessments:

| Level | Observable capability |
|---|---|
| L1 看懂 | Explain what the project does and for whom |
| L2 能复述 | Retell the core lifecycle without reading code |
| L3 能解释 | Explain rules, states, and why major steps exist |
| L4 能下钻 | Locate key methods, tables, transitions, and failure paths |
| L5 能辩护 | Defend trade-offs, boundaries, diagnostics, and evolution options |

Target L4 for core flows and L5 for selected difficulties.

## Recall and Understanding Checks

Generate questions in three rounds:

1. **Recall**: purpose, actors, nouns, main flow, output.
2. **Explanation**: rules, state transitions, retry choices, removed-component consequences.
3. **Deep dive**: entry points, data anchors, transaction boundaries, concurrency, recovery, diagnostics.

For each question, include:

- what a strong answer must mention;
- the relevant evidence location;
- the knowledge level it tests;
- `待用户作答` until the user actually answers.

Do not claim the user has mastered a topic merely because the dossier explains it.

## Feedback Loop

When the user answers questions:

1. compare the answer against evidence;
2. identify missing concepts or unsupported claims;
3. return to the relevant code;
4. explain the gap;
5. ask a harder follow-up;
6. update the mastery map only after demonstrated understanding.

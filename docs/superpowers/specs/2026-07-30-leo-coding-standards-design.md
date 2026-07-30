# Leo Coding Standards Skill Design

> Status: design approved
> Date: 2026-07-30
> Skill: `leo-coding-standards`

## 1. Goal

Create a repository-managed, distributable skill named `leo-coding-standards` for all Java coding activity:

- writing new Java code;
- modifying or fixing Java code;
- refactoring Java code;
- writing Java tests;
- reviewing Java code;
- performing an explicitly requested standards cleanup.

The skill codifies Leo's Java API preferences and general engineering standards while preserving context-sensitive judgment. It must improve consistency without turning preferred utility methods or design patterns into mechanical transformations.

The skill is Java-only. Its generic Leo-branded name does not imply support for other programming languages.

## 2. Non-Goals

The first version does not:

- define Spring, MyBatis, JPA, database, cache, messaging, distributed-system, or microservice conventions;
- add Guava, Commons Lang, Commons Collections, or any other dependency solely to satisfy style preferences;
- upgrade a project's Java version;
- run compilation, tests, formatting, Checkstyle, PMD, SpotBugs, Spotless, or other validation commands;
- automatically clean up an entire file or repository when the requested change has a smaller scope;
- require a design pattern where a direct implementation is sufficient;
- reproduce the Alibaba Java Development Manual in full;
- support languages other than Java.

Framework-specific standards may be added later as separate skills that complement this Java foundation.

## 3. Repository Structure

Use a concise entry point with progressively disclosed references:

```text
lib/skills/leo-coding-standards/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── references/
    ├── java-api-rules.md
    ├── engineering-principles.md
    └── review-checklist.md
```

Responsibilities:

- `SKILL.md`: trigger scope, rule levels, context inspection, reference-loading flow, conflict resolution, change boundaries, and output behavior.
- `references/java-api-rules.md`: nullability, strings, collections, boxed booleans, `Optional`, JDK compatibility, dependency constraints, preferred APIs, examples, and exceptions.
- `references/engineering-principles.md`: SOLID, Law of Demeter, KISS, DRY, naming, structure, exceptions, logging, comments, testability, and design-pattern selection.
- `references/review-checklist.md`: review order, finding priorities, reporting format, and rules for avoiding preference-only findings.
- `agents/openai.yaml`: user-facing metadata and implicit invocation policy.

No scripts or assets are needed in the first version. The skill contains judgment-oriented guidance rather than a deterministic transformation.

## 4. Triggering And Discovery

The `SKILL.md` frontmatter is:

```yaml
---
name: leo-coding-standards
description: Use when writing, modifying, refactoring, testing, or reviewing Java code, including requests involving Java code quality, coding standards, API usage, design principles, or maintainability.
---
```

The description states only when the skill applies. It does not summarize the workflow, preserving reliable skill discovery.

The body is written in Chinese. Rule labels, Java identifiers, method signatures, and code examples remain in English.

The skill should be implicitly invocable. `agents/openai.yaml` contains:

```yaml
interface:
  display_name: "Leo Java 编码规范"
  short_description: "约束 Java 编写、重构、测试与代码审查"
  default_prompt: "Use $leo-coding-standards to write or review this Java code according to Leo's coding standards."

policy:
  allow_implicit_invocation: true
```

## 5. Execution Flow

### 5.1 Confirm Java Scope

Apply the skill only to Java implementation, refactoring, test creation, review, and standards-remediation tasks. Do not apply its API rules to Kotlin, JavaScript, or other languages.

### 5.2 Inspect Project Context

Before applying detailed rules:

1. Inspect project-level instructions and nearby Java code.
2. Detect the configured Java version from Maven, Gradle, toolchains, compiler settings, or equivalent configuration.
3. Detect whether Guava, Commons Lang, and Commons Collections are already dependencies.
4. Observe established local patterns that do not conflict with correctness or higher-priority rules.
5. If the Java version cannot be determined, follow existing compatible code and do not introduce a version upgrade.

### 5.3 Load References By Task

- Java writing, modification, refactoring, or test creation: read `java-api-rules.md` and `engineering-principles.md`.
- Java review or explicit standards remediation: also read `review-checklist.md`.
- Java design discussion without implementation: primarily read `engineering-principles.md`; read API rules when API choices are part of the discussion.

### 5.4 Resolve Conflicts

Apply guidance in this order:

1. Explicit user requirements and project-level instructions.
2. Correctness, security, Java-version compatibility, and dependency constraints.
3. This skill's `MUST` rules.
4. Consistent local project style.
5. This skill's `SHOULD` rules.
6. This skill's `CONSIDER` guidance.

An explicit project convention may override a `SHOULD`. It may not override correctness or a `MUST` rule unless the user clearly accepts the resulting risk.

### 5.5 Limit Change Scope

Apply the standards to new code and code actually touched by the task. Adjacent low-risk issues may be fixed when doing so keeps the change coherent. Other existing issues are reported rather than repaired through a broad cleanup.

### 5.6 Output Behavior

- During coding, silently follow the standards and explain only important exceptions or design trade-offs.
- During review, report concrete findings explicitly using `review-checklist.md`.
- Do not emit a standards checklist after every coding task.
- This skill does not prescribe or initiate verification commands. Explicit user requests and other development or verification skills may still run compilation, tests, formatting, and static analysis.

## 6. Rule Levels

The skill uses three levels:

- `MUST`: correctness, security, compatibility, dependency, resource-management, or contract rules. Violations are defects.
- `SHOULD`: default API, readability, structure, and design preferences. Exceptions are allowed when context provides a clearer or safer choice.
- `CONSIDER`: optional patterns or optimizations that require a demonstrated benefit.

Not following a `CONSIDER` item is never a review finding by itself.

Not following a `SHOULD` item becomes a review finding only when it creates a concrete semantic, consistency, readability, testability, or maintenance problem.

## 7. Java API Rules

### 7.1 MUST

- Confirm a third-party library is already present before using its APIs.
- Do not add Guava, Commons Lang, or Commons Collections solely for coding style.
- Use syntax and APIs compatible with the project's configured Java version.
- Return empty collections instead of `null` unless an established API contract explicitly requires `null`.
- Never return or assign `null` where an `Optional` is required; use `Optional.empty()`.
- Do not wrap collections in `Optional` merely to distinguish an empty collection.
- Do not use unguarded `Optional.get()` to bypass absent-value handling.

### 7.2 SHOULD API Preferences

When the relevant library is already available and the semantics match, prefer:

| Intent | Preferred API |
|---|---|
| Null predicate | `java.util.Objects#isNull`, `java.util.Objects#nonNull` |
| Null-safe equality | `java.util.Objects#equals` |
| Null-safe inequality | `org.apache.commons.lang3.ObjectUtils#notEqual` |
| Blank string checks | `org.apache.commons.lang3.StringUtils#isBlank`, `org.apache.commons.lang3.StringUtils#isNotBlank` |
| Empty collection checks | `org.apache.commons.collections4.CollectionUtils#isEmpty`, `org.apache.commons.collections4.CollectionUtils#isNotEmpty` |
| Mutable empty list creation | `com.google.common.collect.Lists#newArrayList()` |
| Mutable set creation from an `Iterable` | `com.google.common.collect.Sets#newHashSet(java.lang.Iterable<? extends E>)` |
| Explicit boxed-false check | `org.apache.commons.lang3.BooleanUtils#isFalse` |
| Nullable value conversion | `java.util.Optional#ofNullable` |

The API list is a team preference, not a blind replacement table.

Examples:

```java
if (Objects.equals(expected, actual)) {
    handleMatch();
}

if (StringUtils.isBlank(name)) {
    throw new IllegalArgumentException("name must not be blank");
}

if (CollectionUtils.isEmpty(orders)) {
    return Collections.emptyList();
}

List<Order> orders = Lists.newArrayList();
Set<String> codes = Sets.newHashSet(source);

return Optional.ofNullable(repository.findById(id));
```

Reasonable exceptions remain valid:

```java
// A direct branch is clearer than wrapping a simple local null check.
if (value == null) {
    return;
}

// Predicate form communicates the stream operation directly.
values.stream()
        .filter(Objects::nonNull)
        .toList();
```

Although current Guava documentation favors direct JDK collection constructors in some of these cases, the approved team preference is to use `Lists.newArrayList()` and `Sets.newHashSet(Iterable)` in new code when Guava is already present. Correctness, compatibility, performance, type inference, and a clearly stronger local convention may justify an exception.

An exception to a `SHOULD` does not require a code comment unless the choice is non-obvious, likely to be reverted incorrectly, or based on a performance or compatibility constraint.

### 7.3 Optional Boundaries

Use `Optional` primarily for:

- return values that may be absent;
- mapping, filtering, and fallback chains;
- adapting a nullable value at a boundary through `Optional.ofNullable(...)`.

Do not normally use `Optional` for:

- entity fields;
- DTO fields;
- method parameters;
- collection elements;
- replacing every local null check;
- calling `isPresent()` followed immediately by `get()` when a clearer operation exists.

## 8. Engineering Principles

The skill draws from stable Alibaba Java Development Manual practices plus the rules approved in this design. It includes only guidance that an AI coding agent can execute or review effectively.

### 8.1 MUST

- A method has one clear primary intent.
- Do not swallow exceptions, leave empty `catch` blocks, or catch `Throwable` to hide system failures.
- Do not log passwords, tokens, secret keys, government identifiers, or comparable sensitive data.
- Do not use exceptions for normal business-flow control.
- When overriding `equals()`, evaluate and normally override `hashCode()` consistently.
- Release closeable resources with `try-with-resources` or an equivalent reliable mechanism.
- Do not change correct business semantics merely to introduce a design pattern.
- Structure core business logic so it can be tested independently of unstable external dependencies.

### 8.2 SHOULD

#### Single Responsibility Principle

- Keep each class and method focused on one primary responsibility.
- Consider extraction when a method mixes abstraction levels or combines retrieval, decision-making, transformation, and persistence.
- Do not use line count as the sole reason to split code.

#### Open/Closed Principle And Dependency Inversion

- Introduce interfaces, strategies, or abstractions for real variation points.
- Keep core business decisions independent of replaceable infrastructure implementations.
- Do not create speculative abstractions for a single stable implementation.

#### Liskov Substitution And Interface Segregation

- Preserve the behavioral contract of parent types.
- Do not make a subtype unusable by throwing unsupported-operation errors for promised behavior.
- Design focused interfaces around client needs instead of broad interfaces with unrelated methods.

#### Law Of Demeter

- Avoid reaching through long object graphs to manipulate distant state.
- Put behavior near the data and rules it owns.
- Do not create meaningless forwarding methods merely to remove every chained call.

#### KISS And DRY

- Prefer clear, direct, verifiable implementations.
- Extract duplication when it represents stable shared business knowledge.
- Do not merge code that merely looks similar while representing different business concepts.
- Do not introduce a complex abstraction to remove a small amount of harmless duplication.

### 8.3 General Coding Guidance

- Names communicate business meaning; avoid context-free names such as `data`, `info`, `obj`, and `temp`.
- Method names use verbs or verb phrases. Boolean names communicate predicate meaning.
- Prefer early returns when they reduce nesting and preserve a clear control flow.
- Replace stable business magic values with named constants.
- Comments explain reasons, constraints, contracts, and non-obvious trade-offs rather than restating code.
- Preserve exception causes and translate exceptions only at an appropriate abstraction boundary.
- Use parameterized logging placeholders and avoid recording the same exception repeatedly at multiple layers.
- Match log levels to operational actionability; normal business branches are not errors.
- Make time, randomness, network calls, persistence, and other unstable dependencies replaceable where core logic needs deterministic tests.
- Test code follows the same naming, structure, and duplication standards as production code.

## 9. Design Pattern Guidance

Design patterns are `CONSIDER`, not mandatory architecture.

| Demonstrated need | Pattern to consider |
|---|---|
| Replaceable algorithms, pricing rules, or validation rules | Strategy |
| Complex construction or isolation from concrete types | Factory or Builder |
| Stable process skeleton with variable steps | Template Method |
| Ordered matching or processing by multiple handlers | Chain of Responsibility |
| Multiple consumers reacting to an explicit event | Observer |
| Reusing an implementation behind an incompatible interface | Adapter |
| Adding cross-cutting behavior around a core object | Decorator |

Before adding a pattern, answer:

1. What current variation point or complexity does it address?
2. Why is the direct implementation no longer sufficient?
3. Does it reduce branching, coupling, or meaningful duplication?
4. Is the resulting abstraction easier to understand and maintain than the original problem?

Keep a direct implementation when there is one implementation, one simple branch, or no demonstrated variation point.

## 10. Java Review Behavior

Load `review-checklist.md` only for review or explicit standards-remediation tasks.

### 10.1 Review Order

1. Correctness, security, concurrency, and resource management.
2. Java-version and dependency compatibility.
3. API semantics and null handling.
4. Class, method, and interface responsibilities.
5. Exceptions, logging, and sensitive information.
6. Testability and test-code quality.
7. Readability, duplication, and design-pattern use.

### 10.2 Finding Priorities

- `P0`: security incident, data loss, or system-wide outage risk.
- `P1`: definite functional bug, resource leak, concurrency defect, broken exception contract, or sensitive-data exposure.
- `P2`: clear `MUST` violation, or a `SHOULD` violation with concrete maintenance, extensibility, readability, or testability cost.
- `P3`: localized naming, structure, or readability problem with a clear repair benefit and no current behavioral impact.

### 10.3 Finding Format

Each finding contains:

- priority and concise title;
- precise file and line;
- concrete impact;
- triggering input or scenario;
- smallest reasonable fix.

Example:

```text
[P2] 空值判断未覆盖仅含空白字符的名称
UserService.java:48

当前使用 `name == null || name.isEmpty()`，输入 `"   "` 时会被视为有效名称。
项目已包含 Commons Lang，应使用 `StringUtils.isBlank(name)`，使校验语义与规范一致。
```

### 10.4 Review Constraints

- Findings come before summaries.
- Do not report preference-only differences with no concrete effect.
- Failing to use a preferred API is not automatically a finding.
- Do not propose adding a third-party dependency solely to meet the standard.
- Do not request unrelated broad refactors or full legacy cleanup.
- Accept a direct implementation when it is clearer and qualifies as a reasonable exception.
- If no issue is found, say so and mention any untested or unverified residual risk.
- This skill does not initiate compilation, tests, formatting, or static analysis; explicit task instructions and other invoked skills may do so.

## 11. Managed Catalog Integration

Register the skill in `lib/skills/managed-catalog.json` with:

```json
{
  "id": "leo-coding-standards",
  "name": "leo-coding-standards",
  "title": "Leo Java 编码规范",
  "summary": "在 Java 编写、修改、重构、测试和代码审查中应用 Leo 的 API 偏好、工程原则与设计边界。",
  "category": "development",
  "categoryLabel": "开发工程",
  "icon": "🛠️",
  "featured": false,
  "tags": [
    "java",
    "coding-standards",
    "code-review",
    "design-principles"
  ],
  "requiresDaemon": false,
  "promoted": true,
  "managed": true
}
```

Add `development` to `CATEGORY_META` in `lib/session-sync/skill-installer.mjs`. Extend category inference to recognize Java, coding, code-review, refactoring, and related development terms. Ensure development skills receive the intended default icon if their catalog metadata does not specify one.

The installer already copies full managed skill directories. No new installation mechanism is required.

## 12. Validation Strategy

Although the skill does not run validation for downstream Java work, the repository implementation must verify that the skill itself is valid and distributable.

### 12.1 Structural Validation

Verify:

- `SKILL.md`, all three references, and `agents/openai.yaml` exist;
- frontmatter contains the expected name and a valid trigger-only description;
- `SKILL.md` links directly to all three reference files;
- all user-specified APIs appear in `java-api-rules.md`;
- no unnecessary script, asset, README, changelog, or installation guide is added.

### 12.2 Installer And Catalog Tests

Extend repository tests to verify:

- the managed catalog recognizes `leo-coding-standards`;
- its category is `development` with label `开发工程`;
- the skill library can find it using `java`, `coding standards`, and `代码规范`;
- `ensureManagedSkills()` copies `references/` and `agents/openai.yaml`;
- existing managed-skill discovery and installation behavior does not regress.

### 12.3 Skill Behavior Scenarios

Use representative prompts to compare baseline behavior against behavior with the skill loaded:

1. "用 Java 写一个用户名称校验方法。"
2. "重构这段包含多种折扣规则的 Java 代码。"
3. "审查这个直接调用 `Optional.get()` 的实现。"
4. "项目没有 Guava，按 Leo 规范创建一个列表。"
5. "项目已有 Guava，创建可变空列表。"
6. "这里仅有一个简单条件分支，是否应该引入策略模式？"

The scenarios should demonstrate:

- correct separation of `MUST`, `SHOULD`, and `CONSIDER`;
- no dependency additions for style;
- Java-version awareness;
- use of Guava collection factories when Guava already exists;
- acceptance of clear local null checks as reasonable exceptions;
- restrained design-pattern selection;
- review findings based on concrete impact rather than preference alone.

## 13. Expected Files Changed During Implementation

- `lib/skills/leo-coding-standards/SKILL.md`
- `lib/skills/leo-coding-standards/agents/openai.yaml`
- `lib/skills/leo-coding-standards/references/java-api-rules.md`
- `lib/skills/leo-coding-standards/references/engineering-principles.md`
- `lib/skills/leo-coding-standards/references/review-checklist.md`
- `lib/skills/managed-catalog.json`
- `lib/session-sync/skill-installer.mjs`
- focused tests under `tests/unit/`

No runtime daemon, network integration, or Java project dependency is added.

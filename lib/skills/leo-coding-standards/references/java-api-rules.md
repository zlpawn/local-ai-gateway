# Java API 规则

## 目录

- [决策顺序](#决策顺序)
- [MUST](#must)
- [SHOULD API 清单](#should-api-清单)
- [使用示例](#使用示例)
- [合理例外](#合理例外)
- [Optional 边界](#optional-边界)

## 决策顺序

选择 API 前依次确认：

1. 语义是否正确，包括 `null`、空白字符串、空集合和装箱布尔值。
2. API 和语法是否兼容项目 Java 版本。
3. 第三方依赖是否已经存在。
4. 邻近代码是否已有不冲突且一致的写法。
5. 本文的 `SHOULD` 是否适合当前上下文。

不要为了使用某个工具方法而新增依赖。

## MUST

- 使用第三方 API 前，确认项目已经包含对应依赖。
- 不得仅为了代码风格新增 Guava、Commons Lang 或 Commons Collections。
- 使用与项目 Java 版本兼容的 API 和语法。
- 除非既有 API 契约明确要求 `null`，集合返回值必须返回空集合而不是 `null`。
- 需要 `Optional` 时不得返回或赋值为 `null`；无结果使用 `Optional.empty()`。
- 不要用 `Optional<Collection<T>>` 区分无集合与空集合。
- 不要用无保护的 `Optional.get()` 绕过缺失值处理。
- 不要重复包装已经是 `Optional<T>` 的返回值。

## SHOULD API 清单

在语义匹配且项目已有相应依赖时，默认优先使用：

| 语义 | 首选 API |
|---|---|
| Predicate 风格的空值判断 | `java.util.Objects#isNull`、`java.util.Objects#nonNull` |
| 空值安全的相等判断 | `java.util.Objects#equals` |
| 空值安全的不等判断 | `org.apache.commons.lang3.ObjectUtils#notEqual` |
| 空白字符串判断 | `org.apache.commons.lang3.StringUtils#isBlank`、`org.apache.commons.lang3.StringUtils#isNotBlank` |
| 空集合判断 | `org.apache.commons.collections4.CollectionUtils#isEmpty`、`org.apache.commons.collections4.CollectionUtils#isNotEmpty` |
| 创建可变空列表 | `com.google.common.collect.Lists#newArrayList()` |
| 从 `Iterable` 创建可变集合 | `com.google.common.collect.Sets#newHashSet(java.lang.Iterable<? extends E>)` |
| 明确判断装箱布尔值为 `false` | `org.apache.commons.lang3.BooleanUtils#isFalse` |
| 将可空值转换为 Optional | `java.util.Optional#ofNullable` |

这是团队首选清单，不是无条件替换表。先匹配业务语义，再决定是否使用。

## 使用示例

### 空值与相等性

```java
if (Objects.equals(expected, actual)) {
    handleMatch();
}

List<String> values = source.stream()
        .filter(Objects::nonNull)
        .toList();

if (ObjectUtils.notEqual(previousStatus, currentStatus)) {
    publishStatusChanged();
}
```

### 字符串、集合与布尔值

```java
if (StringUtils.isBlank(name)) {
    throw new IllegalArgumentException("name must not be blank");
}

if (StringUtils.isNotBlank(keyword)) {
    criteria.setKeyword(keyword);
}

if (CollectionUtils.isEmpty(orders)) {
    return Collections.emptyList();
}

if (CollectionUtils.isNotEmpty(events)) {
    publish(events);
}

if (BooleanUtils.isFalse(command.getEnabled())) {
    disableFeature();
}
```

注意 `BooleanUtils.isFalse(null)` 为 `false`。只有业务语义确实是“明确为 false”时才使用；若 `null` 也表示禁用，必须显式表达该规则。

### 可变集合

```java
List<Order> orders = Lists.newArrayList();
Set<String> codes = Sets.newHashSet(source);
```

项目已有 Guava 时，新代码优先使用上述工厂方法。即使现代 Guava 文档对部分集合工厂更保守，本团队仍将其保留为 `SHOULD`。

### Optional

```java
public Optional<User> findUser(Long id) {
    return Optional.ofNullable(repository.findById(id));
}

String displayName = Optional.ofNullable(user)
        .map(User::getProfile)
        .map(Profile::getDisplayName)
        .filter(StringUtils::isNotBlank)
        .orElse("anonymous");
```

## 合理例外

当直接写法明显更清晰时，允许偏离 `SHOULD`：

```java
if (value == null) {
    return;
}
```

以下情况也可以例外：

- 项目没有相应第三方依赖。
- Java 版本不支持候选 API 或语法。
- 性能、容量或分配行为有可验证约束。
- 类型推断或重载解析使首选 API 更难理解。
- 邻近代码存在更强、更一致且语义正确的项目约定。

偏离 `SHOULD` 默认不需要代码注释。只有选择不直观、容易被误改，或依赖性能及兼容性约束时，才解释原因。

## Optional 边界

主要在以下场景使用 `Optional`：

- 表达可能缺失的返回结果。
- 执行映射、过滤和兜底链。
- 在边界处通过 `Optional.ofNullable(...)` 接纳可空值。

默认不要在以下位置使用：

- Entity 字段。
- DTO 字段。
- 方法参数。
- 集合元素。
- 所有局部变量的普通空值判断。
- 先 `isPresent()` 再立即 `get()` 的命令式包装。

优先使用 `map`、`flatMap`、`filter`、`orElseGet`、`orElseThrow`、`ifPresent` 等表达缺失值处理。选择 `orElse` 或 `orElseGet` 时考虑兜底值是否需要延迟计算。

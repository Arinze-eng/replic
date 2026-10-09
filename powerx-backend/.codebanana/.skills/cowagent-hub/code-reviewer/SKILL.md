---
name: code-reviewer
description: Perform systematic code review on files, directories, git diffs, or pasted code snippets. Use when the user asks to review, audit, check, or critique code; when they say "help me review", "check this code", "review this PR", or "review the diff"; or when they paste code and ask for feedback.
---

# Code Reviewer

Conduct thorough, structured code reviews across correctness, security, performance, maintainability, and test coverage. Output findings in a three-tier severity report.

## Input Modes

### Mode 1 — File or Directory

User provides a file path or directory. Read the code with `read` and explore structure with `ls`.

### Mode 2 — Git Diff / PR

User asks to review current changes, a branch diff, or a PR.

```bash
# Current uncommitted changes
git diff HEAD

# Staged changes only
git diff --cached

# Branch comparison
git diff main...feat/my-branch

# Specific commit range
git diff <base-sha>..<head-sha>
```

Also run `git log --oneline -10` to understand the commit context.

### Mode 3 — Pasted Code Snippet

User pastes code directly in the conversation. Analyze it in-context — no file reading needed.

## Workflow

### Step 1: Collect Code

- **Mode 1**: `ls` the directory, then `read` key files. For large directories, prioritize entry points, core logic, and recently modified files.
- **Mode 2**: Run the appropriate `git diff` command via `bash`. Read surrounding files if diff context is insufficient.
- **Mode 3**: Use the code from the conversation directly.

### Step 2: Understand Context

Before reviewing, briefly assess:

- Language and framework
- Purpose of the code (what it's supposed to do)
- Scope of change (new feature, bug fix, refactor, etc.)

### Step 3: Analyze

Review across five dimensions:

| Dimension           | What to check                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Correctness**     | Logic errors, off-by-one, null/undefined handling, type safety, edge cases, race conditions                                 |
| **Security**        | OWASP Top 10: injection (SQL/cmd/XSS), broken auth, insecure deserialization, sensitive data exposure, path traversal, SSRF |
| **Performance**     | N+1 queries, blocking I/O in hot paths, unnecessary allocations, unbounded loops, missing indexes                           |
| **Maintainability** | Naming clarity, function length, cyclomatic complexity, code duplication, tight coupling, missing abstractions              |
| **Test Coverage**   | Missing tests for critical paths, edge cases not covered, test quality (assertions, isolation)                              |

### Step 4: Output Report

```
## 代码审查报告
**审查范围**：[文件路径 / diff 范围 / 代码片段描述]
**语言/框架**：[语言] / [框架（如有）]

---

### 🔴 Critical（必须修复）

- `filename.py:42` — **[问题类型]** 描述问题的具体危害。建议：`修复代码示例或方向`
- `filename.py:87` — **[问题类型]** ...

*无 Critical 问题时写：「无 Critical 问题」*

---

### 🟡 Warning（建议修复）

- `filename.py:15` — **[问题类型]** 描述问题。建议：...
- ...

*无 Warning 问题时写：「无 Warning 问题」*

---

### 🔵 Suggestion（优化建议）

- `filename.py:60` — **[问题类型]** 描述可以改进的地方。
- ...

*无 Suggestion 时写：「代码整体规范」*

---

### 总结

[2–4 句话评价整体代码质量，指出最高优先级的修复项，肯定做得好的地方]

**优先修复**：[列出最重要的 1–3 项]
```

## Severity Definitions

| Level          | When to use                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Critical**   | Will cause bugs, security vulnerabilities, data loss, crashes, or incorrect behavior in production                   |
| **Warning**    | Won't break immediately but creates fragility, performance risk, or maintenance burden; should be fixed before merge |
| **Suggestion** | Style improvements, refactoring opportunities, or minor enhancements that improve quality but aren't urgent          |

## Guidelines

- **Always cite line numbers** when reviewing files or diffs. For pasted snippets, use relative line numbers (line 3, line 12, etc.).
- **Be specific**: Name the exact problem and explain why it matters, not just that it's "bad practice".
- **Provide fixes**: For Critical and Warning items, always suggest a concrete fix or direction.
- **Be balanced**: Acknowledge what's done well — a review with only negatives is demoralizing.
- **Scope appropriately**: For large diffs (> 500 lines), focus on the highest-risk areas and note that coverage is partial.
- **Language**: Respond in the same language the user used to make the request.

## Common Issue Patterns

**Security — injection**

```python
# Bad
cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")
# Good
cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))
```

**Performance — N+1**

```python
# Bad: queries inside loop
for order in orders:
    user = User.objects.get(id=order.user_id)
# Good: prefetch
orders = Order.objects.select_related('user').all()
```

**Correctness — unchecked None**

```python
# Bad
result = get_user(id).name
# Good
user = get_user(id)
if user:
    result = user.name
```

"""Objective, bounded completion checks for the in-sandbox agent."""
from __future__ import annotations

import re

DB_WORDS = re.compile(r"\b(database|sqlite|sql|table|record|student result|query|row)\b", re.I)
CODE_WORDS = re.compile(r"\b(code|coding|repository|repo|bug|fix|implement|build|script|function|api|refactor|vulnerabilit(?:y|ies)|security audit|pentest)\b", re.I)
ARTIFACT_WORDS = re.compile(r"\b(write|create|edit|modify|generate|file|document|report|zip|pdf|docx|xlsx|pptx)\b", re.I)
SECURITY_WORDS = re.compile(r"\b(vulnerabilit(?:y|ies)|security audit|pentest|penetration test|sast|dependency audit)\b", re.I)
FULL_STACK_WORDS = re.compile(r"\b(full[- ]?stack|frontend|backend|authentication|authorization|auth|database|api|from scratch|whole (?:app|application|project))\b", re.I)
DART_WORDS = re.compile(r"\b(?:dart|flutter|pubspec|\.dart\b|apk|android app)\b", re.I)
MIGRATION_WORDS = re.compile(r"\b(?:database|schema|data)\s+migrat(?:e|ion|ions|ing)\b|\bmigration\b", re.I)
DART_ANALYZE_CMD = re.compile(r"(?:^|\s)(?:dart|flutter)\s+analy[sz]e(?:\s|$)", re.I)
MIGRATION_CMD = re.compile(r"\b(?:migrat(?:e|ion|ions)|alembic|prisma\s+migrate|drizzle-kit|knex\s+migrate|sequelize\s+db:migrate|rails\s+db:migrate|flyway|liquibase|supabase\s+db)\b", re.I)
E2E_CMD = re.compile(r"\b(?:e2e|integration|playwright|cypress|vitest|jest|supertest|pytest|newman|smoke)\b", re.I)
NEGATIVE_DB_CLAIM = re.compile(r"\b(no (?:record|row|result|data)|not found|does not exist|nothing found)\b", re.I)
RUN_FAIL = re.compile(r"\[(?:exit [1-9]|error|timed out|shell error)\]|Traceback|SyntaxError|\bFAIL(?:ED|URE)?\b|\b[1-9]\d* failing\b", re.I)
VERIFY_CMD = re.compile(r"(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint|typecheck|[^\s]*migrat[^\s]*)|audit)|(?:^|\s)(?:pytest|python\s+-m\s+pytest|go\s+test|cargo\s+(?:test|check|clippy)|mvn\s+test|gradle\s+test|tsc\b|eslint\b|ruff\b|flake8\b|shellcheck\b|bandit\b|semgrep\b)|(?:^|\s)(?:dart|flutter)\s+(?:analy[sz]e|test|compile|build)\b|(?:^|\s)(?:node|python3?)\s+[^\n]*(?:test|check|verify|lint|audit)|(?:^|\s)(?:git\s+diff\s+--check|docker\s+build)\b", re.I)
SECURITY_CMD = re.compile(r"\b(?:npm\s+audit|pnpm\s+audit|yarn\s+audit|bun\s+audit|pip-audit|bandit|semgrep|trivy|grype|govulncheck|cargo\s+audit|gosec|osv-scanner)\b", re.I)
MATH_TASK = re.compile(r"(?:\bmath(?:s|ematics|ematical)?\b|\balgebra\b|\bcalculus\b|\bprobability\b|\bstatistics\b|\bdifferential equations?\b|\bfourier\b|\blaplace\b|\bintegral\b|\bderivative\b|\bequation\b|\bsolve\b[^\n]{0,80}(?:\d|[=+\-*/^√∫])|[=√∫∑][^\n]{1,120}\?)", re.I)
SOFTWARE_CONTEXT = re.compile(r"\b(?:repository|repo|codebase|javascript|typescript|python service|unit test|api endpoint|deploy|docker|npm|github)\b", re.I)
REPOSITORY_TASK = re.compile(r"\b(?:repository|repo|codebase|project|github|open[- ]?source)\b", re.I)
BUGFIX_TASK = re.compile(r"\b(?:fix|bug|debug|repair|patch|regression|root[- ]?cause|hallucin)\b", re.I)
MATH_STEPS = re.compile(r"\b(?:given|find|target|formula|principle|theorem|step\s*\d+|substitut|rearrang|expand|factor|differentiat|integrat|therefore|hence|because)\b", re.I)
MATH_VERIFY = re.compile(r"\b(?:verify|verification|check|substitut(?:e|ing) back|independent check|different method|units? check|domain check|sanity check|re-deriv)\b", re.I)
MATH_FINAL = re.compile(r"(?:\b(?:final answer|answer)\b|\\boxed\s*\{|\bboxed\b)", re.I)
MATH_SKIP = re.compile(r"\b(?:cannot solve|unable to solve|impossible to calculate|missing information|illegible|incomplete|answers? only|omitted|skipped)\b", re.I)


def _command(item: dict) -> str:
    args = item.get("args") or {}
    return str(args.get("cmd") or args.get("command") or args.get("code") or "")


def _mutation(item: dict) -> bool:
    tool = str(item.get("tool") or "").lower()
    return tool in {"write_file", "edit_file", "write", "edit", "coding"} or bool(re.search(r"FILE_WRITTEN|\[write\]|\[edit\]", str(item.get("result") or ""), re.I))


def _successful_verification(item: dict) -> bool:
    tool = str(item.get("tool") or "").lower()
    if tool not in {"run_code", "bash", "coding", "output_verifier", "verify", "test"}:
        return False
    result = str(item.get("result") or "")
    if RUN_FAIL.search(result):
        return False
    if tool in {"output_verifier", "verify", "test"}:
        return True
    return bool(VERIFY_CMD.search(_command(item)))


def evaluate(task: str, trace: list[dict], attempted_final: str) -> str | None:
    """Return a corrective observation, or None when finish is supported."""
    task = task or ""
    trace = trace or []
    tools = [str(item.get("tool") or "").lower() for item in trace]
    evidence = "\n".join(str(item.get("result") or "") for item in trace[-40:])
    final = attempted_final or ""

    if MATH_TASK.search(task) and not SOFTWARE_CONTEXT.search(task):
        reasons = []
        equation_lines = len(re.findall(r"(?:^|\n)[^\n]{0,140}(?:=|⇒|→)[^\n]{1,180}", final))
        explicit_steps = len(re.findall(r"\b(?:step\s*\d+|given|target|formula|rule|principle|theorem|substitut(?:e|ion|ing)?|verify|verification|check)\b", final, re.I))
        if len(final.strip()) < 280:
            reasons.append("solution is too short")
        if not MATH_STEPS.search(final) or explicit_steps < 3:
            reasons.append("missing givens/formula/substitution structure")
        if equation_lines < 2:
            reasons.append("too few visible calculation transformations")
        if not MATH_FINAL.search(final):
            reasons.append("final answer is not clearly identified")
        if not MATH_VERIFY.search(final):
            reasons.append("no independent verification")
        if MATH_SKIP.search(final):
            reasons.append("one or more items appear skipped")
        if reasons:
            return "[MATH COMPLETENESS GATE] The attempted solution is incomplete: " + "; ".join(reasons) + ". Re-solve every item with givens, target, governing rule, substitution, every meaningful algebra/arithmetic step, intermediate values, a clearly marked final answer, and an independent check."

    if DB_WORDS.search(task):
        if not any(tool in {"database", "db", "mcp_call"} for tool in tools):
            return "[CORRECTNESS GATE] Database task has no database tool evidence. Discover candidate databases, inspect schemas, and query the exact file before finishing."
        if NEGATIVE_DB_CLAIM.search(final) and "DATABASE_QUERY_VERIFIED" not in evidence:
            empty_count = evidence.count("EMPTY_RESULT_REQUIRES_DIAGNOSIS")
            diagnosed = "DATABASE_DISCOVERY_COMPLETE" in evidence and "DATABASE_SCHEMA_INSPECTED" in evidence and empty_count >= 2
            if not diagnosed:
                return "[CORRECTNESS GATE] An empty query is not proof that no record exists. Discover databases, inspect schemas/sample rows, then try normalized matching and related-table joins."

    if CODE_WORDS.search(task):
        read_first = any(tool in {"read", "read_file", "grep", "glob", "list_files", "inspect_codebase", "codebase_map"} for tool in tools) or "FILE_READ" in evidence
        if REPOSITORY_TASK.search(task) and BUGFIX_TASK.search(task) and not any(tool in {"inspect_codebase", "codebase_map"} for tool in tools):
            return "[CODEBASE GROUNDING GATE] Repository bug fixing requires a complete first-party codebase inventory before mutation. Run inspect_codebase, use its dependency map to locate the execution path, then read every file you may change in full."
        mutations = [i for i, item in enumerate(trace) if _mutation(item)]
        if not mutations:
            return "[CORRECTNESS GATE] Coding task has no code/file modification evidence. Read the repository, implement the complete change, then test it."
        if re.search(r"\b(fix|bug|refactor|edit|modify|update|change|repair|patch|improve|strengthen|harden)\b", task, re.I) and not read_first:
            return "[CORRECTNESS GATE] You changed code without reading/exploring it first. Ground the change with grep/glob/read, then run post-change test/build verification."
        post_change = trace[mutations[-1] + 1:]
        verifications = [item for item in post_change if _successful_verification(item)]
        if not verifications:
            return "[CORRECTNESS GATE] The latest code change has no successful post-change test/build, lint, typecheck, or explicit verifier evidence. Run the relevant check, inspect its output, fix failures, and retry."
        substantial = bool(re.search(r"\b(strengthen|harden|enterprise|heavy test|thorough|debug|architecture|multiple providers?|sandbox|agent)\b", task, re.I))
        if substantial and len(verifications) < 2:
            return "[CORRECTNESS GATE] This substantial coding task has only one verification layer. Run at least one targeted check and one broader regression/build/integration check after the final mutation, inspect both outputs, and repair any failure before finishing."
        if DART_WORDS.search(task) and not any(DART_ANALYZE_CMD.search(_command(item)) and not RUN_FAIL.search(str(item.get("result") or "")) for item in post_change):
            return "[CORRECTNESS GATE] Dart/Flutter code changed without a successful post-change analyzer run. Run `dart analyze` or `flutter analyze`, inspect every diagnostic, fix errors, and re-run it before finishing."
        if MIGRATION_WORDS.search(task):
            migrated = any(
                not RUN_FAIL.search(str(item.get("result") or ""))
                and (str(item.get("tool") or "").lower() in {"database", "db"} or MIGRATION_CMD.search(_command(item)))
                for item in post_change
            )
            if not migrated:
                return "[CORRECTNESS GATE] Database migration work needs a successful post-change migration or schema verification against a disposable/test database. Apply or dry-run the migration, inspect the resulting schema/data, and verify rollback or backward compatibility where applicable."
        if FULL_STACK_WORDS.search(task) and not any(E2E_CMD.search(_command(item)) and not RUN_FAIL.search(str(item.get("result") or "")) for item in post_change):
            return "[CORRECTNESS GATE] This full application task needs a successful integration/E2E/smoke test after the latest change. Exercise the frontend/backend/auth/database boundary as applicable, inspect the result, fix failures, and re-run before finishing."
        if SECURITY_WORDS.search(task) and not any(SECURITY_CMD.search(_command(item)) and not RUN_FAIL.search(str(item.get("result") or "")) for item in post_change):
            return "[CORRECTNESS GATE] Security work requires an actual post-change security scan or dependency audit. Run an appropriate scanner, review findings, remediate relevant issues, and re-run it before finishing."

    if ARTIFACT_WORDS.search(task) and not any(tool in {"write_file", "edit_file", "write", "edit", "make_zip", "create_pdf", "create_docx", "create_presentation", "create_slides"} for tool in tools):
        return "[CORRECTNESS GATE] The request requires a concrete artifact, but no file-producing tool succeeded. Create and inspect the requested output before finishing."
    return None

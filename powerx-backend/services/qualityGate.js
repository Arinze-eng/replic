'use strict';
// Evidence-based completion checks shared by the host LangGraph loop.
const mathQuality = require('./mathQuality');
const DB_WORDS = /\b(database|sqlite|sql|table|record|student result|query|row)\b/i;
const CODE_WORDS = /\b(code|coding|repository|repo|bug|fix|implement|build|script|function|api|refactor|vulnerabilit(?:y|ies)|security audit|pentest)\b/i;
const ARTIFACT_WORDS = /\b(write|create|edit|modify|generate|file|document|report|zip|pdf|docx|xlsx|pptx)\b/i;
const SECURITY_WORDS = /\b(vulnerabilit(?:y|ies)|security audit|pentest|penetration test|sast|dependency audit)\b/i;
const FULL_STACK_WORDS = /\b(full[- ]?stack|frontend|backend|authentication|authorization|auth|database|api|from scratch|whole (?:app|application|project))\b/i;
const DART_WORDS = /\b(?:dart|flutter|pubspec|\.dart\b|apk|android app)\b/i;
const MIGRATION_WORDS = /\b(?:database|schema|data)\s+migrat(?:e|ion|ions|ing)\b|\bmigration\b/i;
const DART_ANALYZE_CMD = /(?:^|\s)(?:dart|flutter)\s+analy[sz]e(?:\s|$)/i;
const MIGRATION_CMD = /\b(?:migrat(?:e|ion|ions)|alembic|prisma\s+migrate|drizzle-kit|knex\s+migrate|sequelize\s+db:migrate|rails\s+db:migrate|flyway|liquibase|supabase\s+db)\b/i;
const E2E_CMD = /\b(?:e2e|integration|playwright|cypress|vitest|jest|supertest|pytest|newman|smoke)\b/i;
const NEGATIVE_DB = /\b(no (?:record|row|result|data)|not found|does not exist|nothing found)\b/i;
const RUN_FAIL = /\[(?:exit [1-9]|error|timed out|shell error)\]|Traceback|SyntaxError|\bFAIL(?:ED|URE)?\b|\b[1-9]\d* failing\b/i;
const VERIFY_CMD = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint|typecheck|[^\s]*migrat[^\s]*)|audit)|(?:^|\s)(?:pytest|python\s+-m\s+pytest|go\s+test|cargo\s+(?:test|check|clippy)|mvn\s+test|gradle\s+test|tsc\b|eslint\b|ruff\b|flake8\b|shellcheck\b|bandit\b|semgrep\b)|(?:^|\s)(?:dart|flutter)\s+(?:analy[sz]e|test|compile|build)\b|(?:^|\s)(?:node|python3?)\s+[^\n]*(?:test|check|verify|lint|audit)|(?:^|\s)(?:git\s+diff\s+--check|docker\s+build)\b/i;
const SECURITY_CMD = /\b(?:npm\s+audit|pnpm\s+audit|yarn\s+audit|bun\s+audit|pip-audit|bandit|semgrep|trivy|grype|govulncheck|cargo\s+audit|gosec|osv-scanner)\b/i;
const REPOSITORY_TASK = /\b(?:repository|repo|codebase|project|github|open[- ]?source)\b/i;
const BUGFIX_TASK = /\b(?:fix|bug|debug|repair|patch|regression|root[- ]?cause|hallucin)\b/i;

function commandOf(item) {
  const a = item && item.args || {};
  return String(a.cmd || a.command || a.code || '');
}
function isMutation(item) {
  const t = String(item && item.tool || '').toLowerCase();
  return ['write_file', 'edit_file', 'write', 'edit', 'coding'].includes(t) || /FILE_WRITTEN|\[write\]|\[edit\]/i.test(String(item && item.result || ''));
}
function isSuccessfulVerification(item) {
  const t = String(item && item.tool || '').toLowerCase();
  if (!['run_code', 'bash', 'coding', 'output_verifier', 'verify', 'test'].includes(t)) return false;
  const result = String(item && item.result || '');
  if (RUN_FAIL.test(result)) return false;
  if (['output_verifier', 'verify', 'test'].includes(t)) return true;
  return VERIFY_CMD.test(commandOf(item));
}

function evaluate(task, trace, attemptedFinal) {
  task = String(task || '');
  trace = Array.isArray(trace) ? trace : [];
  const tools = trace.map(x => String(x.tool || '').toLowerCase());
  const evidence = trace.slice(-40).map(x => String(x.result || '')).join('\n');
  const final = String(attemptedFinal || '');

  const mathCorrection = mathQuality.correction(task, final);
  if (mathCorrection) return mathCorrection;

  if (DB_WORDS.test(task)) {
    if (!tools.some(t => ['database', 'db', 'mcp_call'].includes(t))) {
      return '[CORRECTNESS GATE] Database task has no database evidence. Discover candidates, inspect schemas, and query the exact database before finishing.';
    }
    if (NEGATIVE_DB.test(final) && !evidence.includes('DATABASE_QUERY_VERIFIED')) {
      const emptyCount = (evidence.match(/EMPTY_RESULT_REQUIRES_DIAGNOSIS/g) || []).length;
      const diagnosed = evidence.includes('DATABASE_DISCOVERY_COMPLETE') && evidence.includes('DATABASE_SCHEMA_INSPECTED') && emptyCount >= 2;
      if (!diagnosed) return '[CORRECTNESS GATE] An empty query is not proof that no record exists. Discover databases, inspect schemas/sample rows, and retry normalized matching plus related-table joins.';
    }
  }
  if (CODE_WORDS.test(task)) {
    const readFirst = tools.some(t => ['read', 'read_file', 'grep', 'glob', 'list_files', 'inspect_codebase', 'codebase_map'].includes(t)) || evidence.includes('FILE_READ');
    if (REPOSITORY_TASK.test(task) && BUGFIX_TASK.test(task) && !tools.some(t => ['inspect_codebase', 'codebase_map'].includes(t))) {
      return '[CODEBASE GROUNDING GATE] Repository bug fixing requires a complete first-party codebase inventory before mutation. Run inspect_codebase, trace the dependency path, then read every file you may change in full.';
    }
    const mutationIndexes = trace.map((x, i) => isMutation(x) ? i : -1).filter(i => i >= 0);
    if (!mutationIndexes.length) return '[CORRECTNESS GATE] Coding task has no code/file modification evidence. Implement the change before finishing.';
    const isEdit = /\b(fix|bug|refactor|edit|modify|update|change|repair|patch|improve|strengthen|harden)\b/i.test(task);
    if (isEdit && !readFirst) return '[CORRECTNESS GATE] You changed code without reading/exploring it first (grep/glob/read). Ground the change in the real code, then run post-change test/build verification.';
    const lastMutation = mutationIndexes[mutationIndexes.length - 1];
    const postChange = trace.slice(lastMutation + 1);
    const verification = postChange.find(isSuccessfulVerification);
    if (!verification) return '[CORRECTNESS GATE] The latest code change has no successful post-change test/build, lint, typecheck, or explicit verifier evidence. Run the relevant check, inspect its output, fix failures, and retry.';
    if (DART_WORDS.test(task)) {
      const analyzed = postChange.some(x => DART_ANALYZE_CMD.test(commandOf(x)) && !RUN_FAIL.test(String(x.result || '')));
      if (!analyzed) return '[CORRECTNESS GATE] Dart/Flutter code changed without a successful post-change analyzer run. Run `dart analyze` or `flutter analyze`, inspect every diagnostic, fix errors, and re-run it before finishing.';
    }
    if (MIGRATION_WORDS.test(task)) {
      const migrationVerified = postChange.some(x => {
        const tool = String(x.tool || '').toLowerCase();
        const result = String(x.result || '');
        return !RUN_FAIL.test(result) && (['database', 'db'].includes(tool) || MIGRATION_CMD.test(commandOf(x)));
      });
      if (!migrationVerified) return '[CORRECTNESS GATE] Database migration work needs a successful post-change migration or schema verification against a disposable/test database. Apply or dry-run the migration, inspect the resulting schema/data, and verify rollback or backward compatibility where applicable.';
    }
    if (FULL_STACK_WORDS.test(task)) {
      const e2eVerified = trace.slice(lastMutation + 1).some(x => E2E_CMD.test(commandOf(x)) && !RUN_FAIL.test(String(x.result || '')));
      if (!e2eVerified) return '[CORRECTNESS GATE] This full application task needs a successful integration/E2E/smoke test after the latest change. Exercise the frontend/backend/auth/database boundary (as applicable), inspect the real result, fix failures, and re-run before finishing.';
    }
    if (SECURITY_WORDS.test(task)) {
      const securityVerified = trace.slice(lastMutation + 1).some(x => SECURITY_CMD.test(commandOf(x)) && !RUN_FAIL.test(String(x.result || '')));
      if (!securityVerified) return '[CORRECTNESS GATE] Security work requires an actual post-change security scan or dependency audit. Run an appropriate scanner, review findings, remediate relevant issues, and re-run it before finishing.';
    }
  }
  if (ARTIFACT_WORDS.test(task) && !tools.some(t => ['write_file', 'edit_file', 'write', 'edit', 'make_zip', 'create_pdf', 'create_docx', 'create_presentation', 'create_slides'].includes(t))) {
    return '[CORRECTNESS GATE] The task requires a concrete artifact, but no file-producing tool succeeded. Create and inspect it first.';
  }
  return null;
}

module.exports = { evaluate, isSuccessfulVerification };

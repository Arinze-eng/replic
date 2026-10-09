#!/usr/bin/env python3
"""Adversarial regression tests for database reasoning and completion evidence."""
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent_worker"))

from database_intelligence import execute  # noqa: E402
from quality_gate import evaluate  # noqa: E402


def build_fixture(root: Path):
    # The trap: a plausible filename that is a valid but empty SQLite database.
    sqlite3.connect(root / "students.db").close()
    data_dir = root / "storage" / "archive"
    data_dir.mkdir(parents=True)
    db = data_dir / "school_prod.sqlite3"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE people(id INTEGER PRIMARY KEY, full_name TEXT, matric_no TEXT);
        CREATE TABLE courses(id INTEGER PRIMARY KEY, code TEXT, title TEXT);
        CREATE TABLE enrollments(id INTEGER PRIMARY KEY, person_id INTEGER, session TEXT);
        CREATE TABLE assessments(id INTEGER PRIMARY KEY, enrollment_id INTEGER, course_id INTEGER, score TEXT, grade TEXT);
        INSERT INTO people VALUES (1, '  Ada  Lovelace ', 'CS-001');
        INSERT INTO courses VALUES (10, 'CSC401', 'Advanced Algorithms');
        INSERT INTO enrollments VALUES (20, 1, '2025/2026');
        INSERT INTO assessments VALUES (30, 20, 10, '87', 'A');
        """
    )
    conn.commit()
    conn.close()
    return db


def assert_true(value, message):
    if not value:
        raise AssertionError(message)


def main():
    with tempfile.TemporaryDirectory(prefix="powerx-heavy-") as tmp:
        root = Path(tmp)
        real_db = build_fixture(root)

        discovered = execute({"action": "discover"}, str(root))
        assert_true(discovered["candidate_count"] == 2, "must discover both SQLite files")
        assert_true(discovered["candidates"][0]["relative_path"] == str(real_db.relative_to(root)), "populated DB must outrank empty decoy")
        assert_true(discovered["candidates"][0]["total_rows"] == 4, "row inventory must be evidence-backed")

        missing = execute({"db": "wrong.db", "sql": "SELECT * FROM students"}, str(root))
        assert_true(not missing["ok"] and missing["evidence"] == "WRONG_DATABASE_PATH_BLOCKED", "read must not create missing DB")
        assert_true(not (root / "wrong.db").exists(), "wrong read path must remain absent")

        empty = execute({"db": "students.db", "sql": "SELECT name FROM sqlite_master WHERE type='table'"}, str(root))
        assert_true(empty["evidence"] == "EMPTY_RESULT_REQUIRES_DIAGNOSIS", "empty result must demand diagnosis")
        assert_true(empty["diagnosis"]["other_candidates"], "empty result must expose alternate candidates")

        query = """
        SELECT trim(replace(p.full_name, '  ', ' ')) AS student, p.matric_no,
               c.code, c.title, CAST(a.score AS INTEGER) AS score, a.grade, e.session
        FROM people p
        JOIN enrollments e ON e.person_id = p.id
        JOIN assessments a ON a.enrollment_id = e.id
        JOIN courses c ON c.id = a.course_id
        WHERE lower(trim(p.full_name)) LIKE ?
        """
        result = execute({
            "db": str(real_db.relative_to(root)),
            "sql": query,
            "params": ["%ada%lovelace%"],
        }, str(root))
        assert_true(result["ok"] and result["evidence"] == "DATABASE_QUERY_VERIFIED", "joined result must be verified")
        assert_true(result["rows"][0]["score"] == 87 and result["rows"][0]["grade"] == "A", "must retrieve exact student result")

        blocked = evaluate(
            "Search the database for Ada's student result",
            [{"tool": "database", "result": json.dumps(empty)}],
            "No record found",
        )
        assert_true(blocked and "empty query is not proof" in blocked.lower(), "gate must block unsupported no-record claim")

        allowed = evaluate(
            "Search the database for Ada's student result",
            [{"tool": "database", "result": json.dumps(result)}],
            "Ada scored 87 (A) in CSC401.",
        )
        assert_true(allowed is None, "gate must allow verified rows")

        coding_block = evaluate(
            "Fix the repository code and test it",
            [{"tool": "edit_file", "result": "EVIDENCE:FILE_WRITTEN"}],
            "Fixed.",
        )
        assert_true(coding_block and "test/build" in coding_block.lower(), "code changes require verification")

    print("EVIDENCE:TEST_PASSED heavy agent database/correctness suite")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

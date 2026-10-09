-- ─────────────────────────────────────────────────────────────────────────────
-- WormGPT Agent CREDIT SYSTEM (Manus-style)            [OPTIONAL — ZERO-MIGRATION]
--
-- IMPORTANT: The credit system does NOT require this migration. By default the
-- live balances are stored in the existing `app_settings` table (the same
-- durable, service-key-writable store already used for Spotify counters and
-- sandbox sessions) under namespaced keys:
--     wgc:bal:<userId>    → current balance (integer)
--     wgc:day:<userId>    → "YYYY-MM-DD" of the last daily renewal
--     wgc:spent:<userId>  → lifetime credits spent (telemetry)
-- and the admin-tunable knobs live as ordinary settings:
--     credit_free_cap   (default 900)   credit_basic_cap (default 5000)
--     credit_task_base  (default 10)    credit_step_cost (default 3)
--     credit_step_heavy (default 6)
--
-- This means the credit gate works the moment the new code deploys — no schema
-- change needed. This SQL is provided ONLY for operators who prefer a dedicated
-- table + an auditable per-run ledger. The app auto-detects the ledger table and
-- writes to it when present (best-effort), but never depends on it.
--
--   • Free  → 900   credits, renew EVERY DAY (lazy top-up at first use of a new day)
--   • Basic → 5000  credits, renew EVERY DAY
--   • Pro   → UNLIMITED (never charged)
--   • Admin → UNLIMITED (never charged)
-- ─────────────────────────────────────────────────────────────────────────────

-- Optional dedicated balance table (the app prefers app_settings unless told
-- otherwise via the `credit_store=table` setting). Left here for operators.
CREATE TABLE IF NOT EXISTS wormgpt_credits (
  user_id        TEXT PRIMARY KEY,
  balance        INTEGER NOT NULL DEFAULT 0,
  last_renew     TEXT,
  lifetime_spent BIGINT  NOT NULL DEFAULT 0,
  updated_at     TEXT
);

-- Optional per-run ledger (auditable spend). The app writes here ONLY if the
-- table exists; it is never required for the gate to function.
CREATE TABLE IF NOT EXISTS wormgpt_credit_ledger (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  job_id        TEXT,
  scope         TEXT,                 -- 'web' | 'telegram' | 'whatsapp' | 'chat'
  delta         INTEGER NOT NULL,     -- negative = spent, positive = top-up / refund
  reason        TEXT,                 -- 'task_base' | 'step' | 'admin_topup' | 'daily_renew' | 'refund'
  balance_after INTEGER,
  created_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_wormgpt_credit_ledger_user ON wormgpt_credit_ledger (user_id, created_at);

-- ── WormGPT Public API (OpenRouter-style) ───────────────────────────────────
-- Dollar-balance ledger + API keys + usage, kept SEPARATE from the integer
-- agent "wgc" credits. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS worm_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  key_prefix   text NOT NULL,
  label        text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_worm_api_keys_user ON worm_api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_worm_api_keys_hash ON worm_api_keys(key_hash);

CREATE TABLE IF NOT EXISTS worm_api_balance (
  user_id        text PRIMARY KEY,
  balance_micro  bigint NOT NULL DEFAULT 0,
  spent_micro    bigint NOT NULL DEFAULT 0,
  free_granted   boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worm_api_usage (
  id            bigserial PRIMARY KEY,
  user_id       text NOT NULL,
  key_id        uuid,
  endpoint      text NOT NULL,
  model         text,
  cost_micro    bigint NOT NULL DEFAULT 0,
  balance_after bigint,
  meta          jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_worm_api_usage_user ON worm_api_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_worm_api_usage_created ON worm_api_usage(created_at DESC);

CREATE TABLE IF NOT EXISTS worm_api_topups (
  tx_ref       text PRIMARY KEY,
  user_id      text NOT NULL,
  amount_usd   numeric NOT NULL,
  raw_amount   numeric,
  currency     text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Atomic charge: subtract cost (micro), bump lifetime spent. Never below 0.
CREATE OR REPLACE FUNCTION worm_api_charge(p_user text, p_cost bigint)
RETURNS bigint AS $$
DECLARE cur bigint; spend bigint; new_bal bigint;
BEGIN
  INSERT INTO worm_api_balance(user_id) VALUES (p_user)
    ON CONFLICT (user_id) DO NOTHING;
  SELECT balance_micro INTO cur FROM worm_api_balance WHERE user_id = p_user FOR UPDATE;
  cur := COALESCE(cur, 0);
  spend := LEAST(cur, GREATEST(0, p_cost));
  new_bal := cur - spend;
  UPDATE worm_api_balance
     SET balance_micro = new_bal,
         spent_micro   = spent_micro + spend,
         updated_at    = now()
   WHERE user_id = p_user;
  RETURN new_bal;
END;
$$ LANGUAGE plpgsql;

-- Atomic add (topup / admin grant). Returns new balance (micro).
CREATE OR REPLACE FUNCTION worm_api_add(p_user text, p_amount bigint)
RETURNS bigint AS $$
DECLARE new_bal bigint;
BEGIN
  INSERT INTO worm_api_balance(user_id, balance_micro) VALUES (p_user, GREATEST(0, p_amount))
    ON CONFLICT (user_id) DO UPDATE
      SET balance_micro = GREATEST(0, worm_api_balance.balance_micro + p_amount),
          updated_at    = now()
  RETURNING balance_micro INTO new_bal;
  RETURN COALESCE(new_bal, 0);
END;
$$ LANGUAGE plpgsql;

-- STRICT atomic charge (race-safe pay-as-you-go). Debits the FULL cost in one
-- locked transaction ONLY when the balance can cover it. Returns the new
-- balance (micro) on success, or -1 when the balance is insufficient (nothing
-- is debited). This is the authoritative "can I serve this request?" gate:
-- because the SELECT … FOR UPDATE row-lock serializes concurrent calls, two
-- requests can no longer both pass a check-then-charge and be served for the
-- price of one (fixes the TOCTOU race in the check-then-charge pattern).
CREATE OR REPLACE FUNCTION worm_api_charge_strict(p_user text, p_cost bigint)
RETURNS bigint AS $$
DECLARE cur bigint; cost bigint; new_bal bigint;
BEGIN
  cost := GREATEST(0, p_cost);
  INSERT INTO worm_api_balance(user_id) VALUES (p_user)
    ON CONFLICT (user_id) DO NOTHING;
  SELECT balance_micro INTO cur FROM worm_api_balance WHERE user_id = p_user FOR UPDATE;
  cur := COALESCE(cur, 0);
  IF cur < cost THEN
    RETURN -1;                     -- insufficient: leave balance untouched
  END IF;
  new_bal := cur - cost;
  UPDATE worm_api_balance
     SET balance_micro = new_bal,
         spent_micro   = spent_micro + cost,
         updated_at    = now()
   WHERE user_id = p_user;
  RETURN new_bal;
END;
$$ LANGUAGE plpgsql;

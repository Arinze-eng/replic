-- Spotify Downloader usage tracking + daily paywall.
-- Mirrors the existing evilgpt_usage / hotbot_usage pattern exactly:
--   id          BIGSERIAL primary key
--   user_id     the app user UUID (stored as text, like other usage tables)
--   created_at  TEXT in "YYYY-MM-DD HH:MM:SS" form (matches db.nowISO())
-- One row is inserted per successful MP3 download. The per-day count is read
-- with a string >= "YYYY-MM-DD 00:00:00" threshold (db.todayStartStr()).
CREATE TABLE IF NOT EXISTS public.spotify_downloads (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Fast per-user daily lookups.
CREATE INDEX IF NOT EXISTS idx_spotify_downloads_user_created
  ON public.spotify_downloads (user_id, created_at);

-- Match the rest of the schema: RLS disabled (the app uses the service_role key
-- and bypasses RLS; every other usage table in this project is RLS-off too).
ALTER TABLE public.spotify_downloads DISABLE ROW LEVEL SECURITY;

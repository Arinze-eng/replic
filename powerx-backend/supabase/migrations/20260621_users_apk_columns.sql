-- ── Fix: APK Users admin tab was always empty/broken ──────────────────────
-- db.getApkUsers() filters on users.platform / users.apk_last_seen, but the
-- 2026-06-18 Supabase migration created the `users` table WITHOUT these
-- columns, so the query errored (42703 column does not exist) and the admin
-- "📱 APK Users" tab never showed anyone. Add the columns the heartbeat
-- (touchUserPlatform) and the admin query expect.
alter table public.users add column if not exists platform text;
alter table public.users add column if not exists apk_last_seen timestamptz;
alter table public.users add column if not exists apk_first_seen timestamptz;
create index if not exists idx_users_platform on public.users (platform);
create index if not exists idx_users_apk_last_seen on public.users (apk_last_seen);

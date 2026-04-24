# Boreas Supabase – Signup/Login ID Hang Fix

## What was happening
The **Sign Up** flow was blocked on GPS:
- `RegisterActivity` shows the loading popup and calls `obtainLocation()`.
- If GPS is off / no last-known location / permission not granted yet, `completeRegistration()` was never reached.
- In some early-return cases, the loading popup also wasn’t dismissed, so it looked like it was “generating id forever”.

## What I changed (Android app)
File: `app/src/main/java/com/sjsu/boreas/RegisterActivity.java`

1. **Location is now optional**
   - If GPS is disabled, we proceed with registration using `(lat, lon) = (0.0, 0.0)`.
   - If GPS is enabled but not ready yet, it will still register once `onLocationChanged()` fires.

2. **User token/ID no longer depends on location**
   - The UID is generated immediately with `UUID.randomUUID().toString()`.
   - This prevents any “waiting for location” hang.

3. **Fixed missing Toast `.show()` and dismiss loading popup on errors**
   - Added `.show()` to the existing toasts.
   - Dismisses the loading popup when validation fails.

## What I changed (Supabase DB)
Applied migration (via Supabase MCP):

```sql
create extension if not exists pgcrypto;
alter table public.boreas_users
  alter column uid set default gen_random_uuid()::text;
```

This makes `boreas_users.uid` auto-generate if you ever decide to omit `uid` from inserts.

## Notes
- I couldn’t run a Gradle build in this sandbox because the project’s Gradle/Groovy version is not compatible with the default Java runtime here (Groovy `Java7` init error). The code change is minimal and should compile in your normal Android Studio/JDK setup.

## Quick manual test checklist
1. Turn **GPS off** → Sign up should still complete and show a token.
2. Turn **GPS on** → Sign up should save lat/lon when available.
3. Log in using the shown token + password.

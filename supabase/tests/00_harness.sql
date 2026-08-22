-- ============================================================================
-- Test-only auth shim. NEVER a migration — applied only by scripts/verify-db.sh
-- against the scratch validation database, never part of supabase/migrations/.
-- Mirrors just enough of Supabase's `auth` schema (auth.users, auth.uid()) and
-- the `authenticated` / `anon` roles for the RLS policies in migration 0008
-- to be exercised outside a real Supabase project.
--
-- UPDATED BY BRIEF P1-3a: added `GRANT USAGE ON SCHEMA auth TO authenticated,
-- anon`. A real Supabase project grants this as part of its standard project
-- setup, so every SECURITY INVOKER function that calls `auth.uid()` directly
-- (brief P1-3a's create_run/create_assignment/move_run/apply_split_coverage/
-- delete_run, for `created_by`) works there without it. This scratch harness
-- had never needed it before P1-3a, because every P1-2 caller of auth.uid()
-- reached it only through a SECURITY DEFINER function (the RLS helpers in
-- migration 0008, or write_audit_log()/audit_current_actor() in 0007), which
-- runs as the schema owner regardless of the invoking role's own grants.
-- P1-3a's write RPCs are SECURITY INVOKER by explicit requirement (brief §5),
-- so `authenticated` needs its own USAGE on `auth` to call auth.uid() at all
-- -- without this grant every write RPC fails with "permission denied for
-- schema auth" on its very first call, which is not a bug in the RPCs, only
-- a gap in this shim. Confirmed by running the P1-3a suite before and after
-- adding this grant.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated')
    THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')
    THEN CREATE ROLE anon NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;

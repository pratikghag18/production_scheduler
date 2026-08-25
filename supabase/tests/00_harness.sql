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

-- ============================================================================
-- UPDATED BY BRIEF P1-5a §2.1: seed.sql's GoTrue dev-login block (added by
-- P1-3b, Aug 22) UPDATEs ~20 real auth.users columns and INSERTs an
-- auth.identities row so DevProfileSwitcher.tsx can sign in locally against
-- the scratch database. This shim had not been touched since P1-3a and only
-- declared `auth.users (id uuid, email text)`, so scripts/verify-db.sh had
-- been failing at step 6 on every run since Aug 22 with "column
-- u.created_at does not exist" -- nothing caught it because P1-4a..P1-4e
-- were all frontend briefs and nothing re-ran this suite.
--
-- Fixed here, never in the seed (same call as design-plan §17.2 item 3): the
-- seed legitimately targets a real Supabase project, which already has every
-- one of these columns as part of GoTrue's own auth.users schema; this shim
-- is the thing that drifted out from under it. Every column below is one the
-- seed's UPDATE ... SET actually sets -- read straight off that statement,
-- not guessed -- plus the auth.identities table its INSERT targets.
-- ============================================================================
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS encrypted_password          text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at          timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS aud                         text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS role                        text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS instance_id                 uuid;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS confirmation_token          text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS recovery_token              text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_change_token_new      text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_change                text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_change_token_current  text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone_change                text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone_change_token          text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS reauthentication_token      text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_change_confirm_status smallint;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_app_meta_data           jsonb;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_user_meta_data          jsonb;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS is_super_admin              boolean;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS created_at                  timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS updated_at                  timestamptz;

CREATE TABLE IF NOT EXISTS auth.identities (
  provider_id     text NOT NULL,
  user_id         uuid NOT NULL REFERENCES auth.users(id),
  identity_data   jsonb NOT NULL,
  provider        text NOT NULL,
  last_sign_in_at timestamptz,
  created_at      timestamptz,
  updated_at      timestamptz,
  PRIMARY KEY (provider_id, provider)
);

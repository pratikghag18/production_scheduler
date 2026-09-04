-- ============================================================================
-- 58_trainings_per_owner_test.sql — migration 0031, D111a.
--
-- THE MAINTAINER, 31 August, stating the requirement as a fact he expected to
-- already hold:
--
--   "Just making sure, trainings can be added by individual site admins as
--    well, but only to their own sites."
--
-- The PERMISSION half was already true — `skills_insert` (0028) admits
-- `app_is_admin_for(site_node_id)`. The NAMING half made it unusable: names
-- were unique across the whole company, so the second plant to want a
-- "Forklift" was refused, and could not see, open or reuse the row that
-- refused it. 0031 makes the name unique per OWNER.
--
-- ⚠️⚠️ WHY THIS FILE EXISTS WHEN `upgrade_0031_` ALREADY PROVES THE CONSTRAINT.
-- That file runs as the OWNER of the tables, with RLS not applying to it. It
-- proves the rule; it proves nothing about whether a real site admin can reach
-- it. **A constraint that is correct and a policy that refuses to let anybody
-- near it produce exactly the same screen as before.** Every case below runs as
-- `authenticated`, through RLS, as a named person.
--
-- FIXTURE, and the reasons for each part:
--   * TWO plants, because "one name, two plants" is the whole requirement;
--   * a SITE ADMIN per plant, not a company admin — a company admin satisfies
--     `app_is_admin()` and would pass every case without ever exercising the
--     `app_is_admin_for(site_node_id)` branch that site admins depend on
--     ([[verification-standard]] rule 3c);
--   * a LINE inside plant A, for T5's documented loosening;
--   * a VIEWER, so T6 shows the rule is not simply "anyone signed in".
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000058', 'Org 58');
INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('21111111-0000-0000-0000-000000000058', '11111111-0000-0000-0000-000000000058', 'T58 Shape');
INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('22111111-0000-0000-0000-000000000058', '11111111-0000-0000-0000-000000000058',
   '21111111-0000-0000-0000-000000000058', 0, 'Plant', false),
  ('22111111-0000-0000-0000-000000000059', '11111111-0000-0000-0000-000000000058',
   '21111111-0000-0000-0000-000000000058', 1, 'Line', true);

INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-0000000000a0', '11111111-0000-0000-0000-000000000058',
   '22111111-0000-0000-0000-000000000058', NULL, 'T58 Plant A'),
  ('23111111-0000-0000-0000-0000000000b0', '11111111-0000-0000-0000-000000000058',
   '22111111-0000-0000-0000-000000000058', NULL, 'T58 Plant B');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000058',
   '22111111-0000-0000-0000-000000000059', '23111111-0000-0000-0000-0000000000a0', 'T58 Line 1');

-- Three people. ⭐ The two admins are org-wide 'supervisor', NOT 'admin':
-- `app_is_admin()` reads the org-wide role, so an org-wide admin would answer
-- every case through the company branch and never reach the grant. Rule 3c-ii,
-- which cost seventeen green cases once.
INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000058a0'),
  ('00000000-0000-0000-0000-0000000058b0'),
  ('00000000-0000-0000-0000-0000000058c0');
INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
  ('e1111111-0000-0000-0000-0000000000a0', '11111111-0000-0000-0000-000000000058',
   '00000000-0000-0000-0000-0000000058a0', 'supervisor'),
  ('e1111111-0000-0000-0000-0000000000b0', '11111111-0000-0000-0000-000000000058',
   '00000000-0000-0000-0000-0000000058b0', 'supervisor'),
  ('e1111111-0000-0000-0000-0000000000c0', '11111111-0000-0000-0000-000000000058',
   '00000000-0000-0000-0000-0000000058c0', 'viewer');
INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
  ('e1111111-0000-0000-0000-0000000000a0', '23111111-0000-0000-0000-0000000000a0',
   '11111111-0000-0000-0000-000000000058', 'admin'),
  ('e1111111-0000-0000-0000-0000000000b0', '23111111-0000-0000-0000-0000000000b0',
   '11111111-0000-0000-0000-000000000058', 'admin'),
  ('e1111111-0000-0000-0000-0000000000c0', '23111111-0000-0000-0000-0000000000a0',
   '11111111-0000-0000-0000-000000000058', 'viewer');

-- ---------------------------------------------------------------------------
\echo 'T1: a SITE admin can create a training owned by their own plant'
SAVEPOINT sp_T1;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000058a0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000058', 'TRN-4471',
       '23111111-0000-0000-0000-0000000000a0');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  RESET ROLE;
  IF v_state = 'allowed' THEN RAISE NOTICE 'PASS T1';
  ELSE RAISE NOTICE 'FAIL T1: state=% (want allowed) — a site admin cannot create a training at all', v_state; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL T1: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T1;

\echo 'T2: and NOT one owned by a plant they do not administer'
SAVEPOINT sp_T2;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000058a0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000058', 'TRN-9999',
       '23111111-0000-0000-0000-0000000000b0');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  RESET ROLE;
  -- 42501 is the RLS refusal. ⚠️ NOT 23505: this must fail on PERMISSION, and a
  -- case that accepted either code would pass for the wrong reason the day the
  -- naming rule changed again.
  IF v_state = '42501' THEN RAISE NOTICE 'PASS T2';
  ELSE RAISE NOTICE 'FAIL T2: state=% (want 42501) — the ownership half of skills_insert is not holding', v_state; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL T2: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T2;

\echo 'T3 ⭐⭐: THE REQUIREMENT — two site admins, two plants, the SAME document number, both succeed'
SAVEPOINT sp_T3;
DO $$
DECLARE v_a text := 'none'; v_b text := 'none'; v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000058a0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000058', 'TRN-4471',
       '23111111-0000-0000-0000-0000000000a0');
    v_a := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_a := SQLSTATE; END;
  RESET ROLE;

  -- The OTHER plant's admin, as a different person entirely. Before 0031 this
  -- came back 23505 against a row this person cannot even read.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000058b0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000058', 'TRN-4471',
       '23111111-0000-0000-0000-0000000000b0');
    v_b := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_b := SQLSTATE; END;
  RESET ROLE;

  SELECT count(*) INTO v_n FROM skills
   WHERE org_id = '11111111-0000-0000-0000-000000000058' AND name = 'TRN-4471';
  IF v_a = 'allowed' AND v_b = 'allowed' AND v_n = 2 THEN RAISE NOTICE 'PASS T3';
  ELSE RAISE NOTICE 'FAIL T3: A=% B=% rows=% (want allowed/allowed/2)', v_a, v_b, v_n; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL T3: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T3;

\echo 'T4: one plant still may not hold the same name twice'
SAVEPOINT sp_T4;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000058a0', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO skills (org_id, name, site_node_id) VALUES
    ('11111111-0000-0000-0000-000000000058', 'TRN-4471', '23111111-0000-0000-0000-0000000000a0');
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000058', 'TRN-4471', '23111111-0000-0000-0000-0000000000a0');
    v_state := 'allowed';
  EXCEPTION WHEN unique_violation THEN v_state := SQLSTATE;
  END;
  RESET ROLE;
  IF v_state = '23505' THEN RAISE NOTICE 'PASS T4';
  ELSE RAISE NOTICE 'FAIL T4: state=% (want 23505) — the rule stopped guarding its own owner', v_state; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL T4: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T4;

\echo 'T5 ⚠️: the documented loosening — a LINE inside the same plant may hold the name too'
SAVEPOINT sp_T5;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000058a0', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO skills (org_id, name, site_node_id) VALUES
    ('11111111-0000-0000-0000-000000000058', 'TRN-4471', '23111111-0000-0000-0000-0000000000a0');
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000058', 'TRN-4471', '23111111-0000-0000-0000-0000000000a1');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  RESET ROLE;
  -- ⚠️ THIS CASE ASSERTS A LOOSENING, NOT A GUARANTEE, and it is here so the
  -- loosening is a DECISION on the record rather than a surprise. 0031's header
  -- weighs it: enforcing per-PLANT needs a stored root column kept by a trigger
  -- that goes stale when a node moves, and the client can warn instead — which
  -- it can do honestly, because a plant admin reads their whole plant. If this
  -- case ever needs to flip, that is the change, and it is an addition.
  IF v_state = 'allowed' THEN RAISE NOTICE 'PASS T5';
  ELSE RAISE NOTICE 'FAIL T5: state=% (want allowed) — uniqueness is biting wider than per-owner', v_state; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL T5: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T5;

\echo 'T6: a viewer on the plant creates nothing — the rule is administer, not sign in'
SAVEPOINT sp_T6;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000058c0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000058', 'TRN-0001',
       '23111111-0000-0000-0000-0000000000a0');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  RESET ROLE;
  IF v_state = '42501' THEN RAISE NOTICE 'PASS T6';
  ELSE RAISE NOTICE 'FAIL T6: state=% (want 42501)', v_state; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL T6: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T6;

\echo 'T7 ⭐: a site admin may RENAME their training to a name another plant already uses'
SAVEPOINT sp_T7;
DO $$
DECLARE v_state text := 'none';
BEGIN
  -- Plant B owns "TRN-4471". Plant A's admin renames their own row to match.
  -- ⚠️ THE UPDATE PATH IS NOT THE INSERT PATH and has its own policy; a
  -- constraint swap that only ever gets exercised by INSERT would leave this
  -- refusing with nothing on screen to explain it.
  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('24111111-0000-0000-0000-0000000000b1', '11111111-0000-0000-0000-000000000058',
     'TRN-4471', '23111111-0000-0000-0000-0000000000b0'),
    ('24111111-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000058',
     'TRN-0002', '23111111-0000-0000-0000-0000000000a0');

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000058a0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE skills SET name = 'TRN-4471'
     WHERE id = '24111111-0000-0000-0000-0000000000a1';
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  RESET ROLE;
  IF v_state = 'allowed' THEN RAISE NOTICE 'PASS T7';
  ELSE RAISE NOTICE 'FAIL T7: state=% (want allowed) — rename is still company-scoped', v_state; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL T7: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T7;

\echo 'T8 ⭐⭐: the neighbouring rule that makes the tenant column in skills_owner_name_unique redundant'
DO $$
DECLARE v_def text; v_state text := 'none';
BEGIN
  -- ⚠️⚠️ THIS CASE EXISTS BECAUSE A DELIBERATE BREAKAGE CAME BACK UNCAUGHT.
  -- Rewriting the constraint as `unique (site_node_id, name)` — dropping the
  -- tenant — changed no answer in this file, and it never can: `site_node_id`
  -- is a uuid primary key belonging to exactly one org, and the composite
  -- foreign key below pins a skill's `org_id` to its owner's. The mutation is
  -- INERT, and its kind is **"equivalent because of a neighbouring rule"** —
  -- not "unreachable" and not "covered by another case".
  --
  -- ⭐ An unexplained NOT CAUGHT is a hole; an explained one is a finished
  -- result ONLY IF the rule it leans on is pinned. **The day somebody
  -- simplifies this FK to reference `nodes(id)`, the harmless mutation becomes
  -- live and this case goes red in the same run**, instead of the tenant
  -- boundary quietly re-opening.
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.skills'::regclass
     AND conname = 'skills_org_id_site_node_id_fkey';

  -- ⭐⭐ AND THE REFUSAL IS DEMONSTRATED WITHOUT NAMING WHICH LAYER CATCHES IT,
  -- because there are TWO and the outer one was a surprise. This case first
  -- asserted `foreign_key_violation` and went red: `app_check_site_owner()` is
  -- a BEFORE trigger that gets there first and raises `invalid_argument`
  -- through `api_raise`, so the friendly message reaches the user and the FK
  -- never fires. Both are real, and the FK is the one that matters here — a
  -- trigger can be dropped by a migration without the catalogue noticing,
  -- which is why the definition above is asserted separately from the
  -- behaviour below. Asserting the SQLSTATE of whichever layer happens to win
  -- would make this case fail the next time the friendlier one is improved.
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000058', 'TRN-CROSS',
       '23111111-0000-0000-0000-000000000030');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := 'refused';
  END;

  IF v_def = 'FOREIGN KEY (org_id, site_node_id) REFERENCES nodes(org_id, id)'
     AND v_state = 'refused'
    THEN RAISE NOTICE 'PASS T8';
  ELSE RAISE NOTICE 'FAIL T8: def=% cross-tenant owner=% (want the composite FK, and refused)',
    v_def, v_state; END IF;
END $$;

ROLLBACK;

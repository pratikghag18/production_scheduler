-- ============================================================================
-- 56_delete_keeps_the_past_test.sql — migration 0029, D110.
--
-- THE MAINTAINER'S WORDS (28 August):
--   "When it is deleted, we give a warning to the user that all the
--    corresponding data will be deleted and encourage them deactivate to
--    retain the data instead. This will be handled by site admin so it their
--    call in the end."
--   "the row disappears from the list and from anything not yet started;
--    completed runs keep their record of it."
--
-- Three claims, separated on purpose:
--
--   D110a  THE LINE IS THE CLOCK. Not `status`, which nothing advances.
--          D13-D16, and D17 is the one nobody would think to write: a run
--          whose start we cannot name falls on the KEPT side.
--
--   D110b  THE PAST SURVIVES WITH ITS IDENTITY. A started run keeps the sku,
--          name and colour of the product it made; a started assignment keeps
--          the name of the person who worked it. D18-D21.
--
--   D110c  IT NEEDS NO ESCALATION, AND THE PROOF IS MEASURED RATHER THAN
--          ASSERTED. D28 is a Line 1 admin deleting a line-owned product and
--          the runs under it going with it — the migration header's argument
--          on a real database. D26/D27 are the two refusals that bound it.
--
-- ⭐⭐ D22 AND D23 ARE THE CASES THAT WOULD HAVE SHIPPED BROKEN. Nulling a
-- column that has been NOT NULL since 0003 hands two triggers a value they
-- have never seen. D22 is the capacity trigger refusing to let a person be
-- deleted because their own history exceeds a cap they are no longer subject
-- to; D23 is 0028's assignment guard returning early on a NULL operator and
-- skipping the product half below it. Neither is visible from the migration's
-- happy path and neither would fail loudly later — the first looks like
-- "delete is broken", the second like nothing at all.
--
-- FIXTURE, and why it is its own and not the seed's:
--   * the seed's runs are placed with `seed_t()` RELATIVE TO NOW, so which
--     side of "started" they fall on depends on the hour the suite runs. Every
--     row below is dated 2020 (started) or 2099 (not yet started), so this file
--     measures the rule and never the clock it ran at;
--   * an owner strictly BELOW the plant root (Line 1), because D110c is about
--     D109's "any level" and a fixture of roots cannot see it;
--   * a person owned by the PLANT holding a training owned by a LINE — legal
--     under 0028's comparability rule, and the configuration that makes
--     "delete this training" uncompletable without the cascade (D25).
--
-- People (all org-wide 'viewer', so app_is_admin() short-circuits nothing):
--   d1  admin grant on Plant 1
--   d2  admin grant on Plant D (a second plant, built here)
--   d3  admin grant on LINE 1 ONLY
--   d4  SUPERVISOR grant on Plant 1 — may write, may not administer
-- The seed supplies a1, an org-wide company admin.
--
-- Seed nodes used: plant_1 …0001, assembly …0002, line_1 …0004, cell_1 …0007,
-- cell_2 …0008, cell_5 …000b (no seeded run, so an unbounded range fits).
-- ============================================================================

BEGIN;

CREATE TEMP TABLE d_fix (k text primary key, v uuid);

-- ---------------------------------------------------------------------------
-- A second plant, built with create_node rather than INSERT: a direct insert
-- would skip copy-on-root-create (0020 §10) and Plant D would share Plant 1's
-- structure. §19.73 records that arriving as a real defect in dev_demo.sql.
-- ⚠️ Ids are accumulated in scalars and written to the temp table AFTER
-- RESET ROLE — `authenticated` cannot write a TEMP table and the refusal reads
-- exactly like RLS (instrument failure 34, hit twice already).
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_pd uuid; v_dept uuid; v_line uuid; v_cell uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_pd   := (create_node(NULL, 'Plant D (delete tests)', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept := (create_node(v_pd,   'Fabrication D', 0)->>'id')::uuid;
  v_line := (create_node(v_dept, 'Weld Line D',   0)->>'id')::uuid;
  v_cell := (create_node(v_line, 'Weld Cell D',   0)->>'id')::uuid;
  RESET ROLE;
  INSERT INTO d_fix (k, v) VALUES ('pd', v_pd), ('pd_cell', v_cell);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001'; v_pd uuid;
BEGIN
  SELECT v INTO v_pd FROM d_fix WHERE k = 'pd';

  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-00000000dd01'),
    ('00000000-0000-0000-0000-00000000dd02'),
    ('00000000-0000-0000-0000-00000000dd03'),
    ('00000000-0000-0000-0000-00000000dd04');

  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e2000000-0000-0000-0000-0000000000d1', v_org, '00000000-0000-0000-0000-00000000dd01', 'viewer'),
    ('e2000000-0000-0000-0000-0000000000d2', v_org, '00000000-0000-0000-0000-00000000dd02', 'viewer'),
    ('e2000000-0000-0000-0000-0000000000d3', v_org, '00000000-0000-0000-0000-00000000dd03', 'viewer'),
    ('e2000000-0000-0000-0000-0000000000d4', v_org, '00000000-0000-0000-0000-00000000dd04', 'viewer');

  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e2000000-0000-0000-0000-0000000000d1','30000000-0000-0000-0000-000000000001', v_org, 'admin'),
    ('e2000000-0000-0000-0000-0000000000d2', v_pd,                                  v_org, 'admin'),
    ('e2000000-0000-0000-0000-0000000000d3','30000000-0000-0000-0000-000000000004', v_org, 'admin'),
    ('e2000000-0000-0000-0000-0000000000d4','30000000-0000-0000-0000-000000000001', v_org, 'supervisor');

  -- Four products, three scopes. D115 (0034): the place is a product_sites row,
  -- not a column. DP1 is made in LINE 1 and nowhere else; the rest in Plant 1.
  INSERT INTO products (id, org_id, sku, name) VALUES
    ('d6000000-0000-0000-0000-0000000000d1', v_org, 'DP1', 'Line-owned Part'),
    ('d6000000-0000-0000-0000-0000000000d2', v_org, 'DP2', 'Plant-wide Part'),
    ('d6000000-0000-0000-0000-0000000000d3', v_org, 'DP3', 'Staffing Part'),
    ('d6000000-0000-0000-0000-0000000000d4', v_org, 'DP4', 'Never Scheduled');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    (v_org, 'd6000000-0000-0000-0000-0000000000d1', '30000000-0000-0000-0000-000000000004'),
    (v_org, 'd6000000-0000-0000-0000-0000000000d2', '30000000-0000-0000-0000-000000000001'),
    (v_org, 'd6000000-0000-0000-0000-0000000000d3', '30000000-0000-0000-0000-000000000001'),
    (v_org, 'd6000000-0000-0000-0000-0000000000d4', '30000000-0000-0000-0000-000000000001');

  INSERT INTO operators (id, org_id, display_name, employee_ref, site_node_id) VALUES
    ('d5000000-0000-0000-0000-0000000000d1', v_org, 'Dana Departing', 'EMP-D01', '30000000-0000-0000-0000-000000000001'),
    ('d5000000-0000-0000-0000-0000000000d2', v_org, 'Plantwide Pat',  'EMP-D02', '30000000-0000-0000-0000-000000000001');

  -- A LINE-owned training held by a PLANT-wide person: legal (comparability,
  -- 0028 §4) and the reason D25 exists.
  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('d4000000-0000-0000-0000-0000000000d1', v_org, 'Line Training D', '30000000-0000-0000-0000-000000000004');
  INSERT INTO operator_skills (operator_id, skill_id, org_id) VALUES
    ('d5000000-0000-0000-0000-0000000000d2', 'd4000000-0000-0000-0000-0000000000d1', v_org);
  INSERT INTO node_skill_requirements (node_id, skill_id, org_id) VALUES
    ('30000000-0000-0000-0000-000000000007', 'd4000000-0000-0000-0000-0000000000d1', v_org);

  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES
    ('d7000000-0000-0000-0000-0000000000d1', v_org, 'Pattern D', '30000000-0000-0000-0000-000000000001');
  INSERT INTO shifts (id, org_id, template_id, name, start_min, end_min) VALUES
    ('d7100000-0000-0000-0000-0000000000d1', v_org, 'd7000000-0000-0000-0000-0000000000d1', 'D Day', 360, 840);
  INSERT INTO shift_breaks (org_id, shift_id, name, start_min, end_min) VALUES
    (v_org, 'd7100000-0000-0000-0000-0000000000d1', 'D Break', 480, 495),
    (v_org, 'd7100000-0000-0000-0000-0000000000d1', 'D Lunch', 600, 630);
  INSERT INTO node_shift_templates (node_id, org_id, template_id) VALUES
    ('30000000-0000-0000-0000-000000000009', v_org, 'd7000000-0000-0000-0000-0000000000d1');

  -- DP2's schedule. 2020 has started; 2099 has not; the unbounded one is on
  -- Cell 5, which the seed leaves free of runs so the range can be open.
  INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount) VALUES
    ('d8000000-0000-0000-0000-0000000000d1', v_org, '30000000-0000-0000-0000-000000000007',
     'd6000000-0000-0000-0000-0000000000d2', tstzrange('2020-03-02 06:00+00','2020-03-02 14:00+00'), 2),
    ('d8000000-0000-0000-0000-0000000000d2', v_org, '30000000-0000-0000-0000-000000000007',
     'd6000000-0000-0000-0000-0000000000d2', tstzrange('2099-03-02 06:00+00','2099-03-02 14:00+00'), 2),
    ('d8000000-0000-0000-0000-0000000000d3', v_org, '3000000a-0000-0000-0000-00000000000b',
     'd6000000-0000-0000-0000-0000000000d2', tstzrange(NULL,'2098-01-01 00:00+00'), 1),
    ('d8000000-0000-0000-0000-0000000000d4', v_org, '30000000-0000-0000-0000-000000000007',
     'd6000000-0000-0000-0000-0000000000d1', tstzrange('2099-05-02 06:00+00','2099-05-02 14:00+00'), 1);

  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
    -- crew of the started run, and of the future one
    ('d9000000-0000-0000-0000-0000000000d1', v_org, '30000000-0000-0000-0000-000000000007',
     'd5000000-0000-0000-0000-0000000000d1', 'd8000000-0000-0000-0000-0000000000d1', NULL,
     tstzrange('2020-03-02 06:00+00','2020-03-02 14:00+00'), 1.000),
    ('d9000000-0000-0000-0000-0000000000d2', v_org, '30000000-0000-0000-0000-000000000007',
     'd5000000-0000-0000-0000-0000000000d1', 'd8000000-0000-0000-0000-0000000000d2', NULL,
     tstzrange('2099-03-02 06:00+00','2099-03-02 14:00+00'), 1.000),
    -- direct (model A) assignments carrying DP2 itself, one each side of the line
    ('d9000000-0000-0000-0000-0000000000d3', v_org, '30000000-0000-0000-0000-000000000008',
     'd5000000-0000-0000-0000-0000000000d2', NULL, 'd6000000-0000-0000-0000-0000000000d2',
     tstzrange('2020-03-02 06:00+00','2020-03-02 14:00+00'), 1.000),
    ('d9000000-0000-0000-0000-0000000000d4', v_org, '30000000-0000-0000-0000-000000000008',
     'd5000000-0000-0000-0000-0000000000d2', NULL, 'd6000000-0000-0000-0000-0000000000d2',
     tstzrange('2099-03-02 06:00+00','2099-03-02 14:00+00'), 1.000);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- A fixture that half-builds is worse than one that fails: the cases would
-- measure a world that is missing the thing they are about.
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM runs WHERE id::text LIKE 'd8000000%';
  IF v_n <> 4 THEN RAISE EXCEPTION 'FIXTURE FAILED: % runs, expected 4', v_n; END IF;
  SELECT count(*) INTO v_n FROM assignments WHERE id::text LIKE 'd9000000%';
  IF v_n <> 4 THEN RAISE EXCEPTION 'FIXTURE FAILED: % assignments, expected 4', v_n; END IF;
END $$;

-- ===========================================================================
-- SCHEMA — the columns, and the rules that replace the NOT NULLs they drop.
-- ===========================================================================

\echo 'D1: skills.active and shift_templates.active exist, NOT NULL, default true, and every existing row is true'
DO $$
DECLARE v_cols int; v_false int;
BEGIN
  SELECT count(*) INTO v_cols FROM information_schema.columns
   WHERE table_schema='public' AND column_name='active' AND is_nullable='NO'
     AND column_default='true' AND table_name IN ('skills','shift_templates');
  SELECT (SELECT count(*) FROM skills WHERE NOT active)
       + (SELECT count(*) FROM shift_templates WHERE NOT active) INTO v_false;
  IF v_cols = 2 AND v_false = 0 THEN RAISE NOTICE 'PASS D1';
  ELSE RAISE NOTICE 'FAIL D1: matching columns=% (want 2), rows already inactive=% (want 0)', v_cols, v_false; END IF;
END $$;

\echo 'D2: runs.product_id is nullable now, and runs_product_identified refuses BOTH and NEITHER'
SAVEPOINT sp_D2;
DO $$
DECLARE v_nullable text; v_both text := 'no error'; v_neither text := 'no error';
BEGIN
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema='public' AND table_name='runs' AND column_name='product_id';
  BEGIN
    UPDATE runs SET product_sku = 'X' WHERE id = 'd8000000-0000-0000-0000-0000000000d1';
    EXCEPTION WHEN check_violation THEN v_both := 'refused';
  END;
  BEGIN
    UPDATE runs SET product_id = NULL WHERE id = 'd8000000-0000-0000-0000-0000000000d1';
    EXCEPTION WHEN check_violation THEN v_neither := 'refused';
  END;
  IF v_nullable = 'YES' AND v_both = 'refused' AND v_neither = 'refused' THEN RAISE NOTICE 'PASS D2';
  ELSE RAISE NOTICE 'FAIL D2: nullable=% both=% neither=% (want YES/refused/refused)', v_nullable, v_both, v_neither; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_D2;

\echo 'D3: assignments_work_identified — a run, a product, or a remembered sku. Exactly one.'
SAVEPOINT sp_D3;
DO $$
DECLARE v_two text := 'no error'; v_none text := 'no error'; v_sku text := 'refused';
BEGIN
  BEGIN -- run AND product
    UPDATE assignments SET product_id = 'd6000000-0000-0000-0000-0000000000d2'
      WHERE id = 'd9000000-0000-0000-0000-0000000000d1';
    EXCEPTION WHEN check_violation THEN v_two := 'refused';
  END;
  BEGIN -- neither
    UPDATE assignments SET product_id = NULL WHERE id = 'd9000000-0000-0000-0000-0000000000d3';
    EXCEPTION WHEN check_violation THEN v_none := 'refused';
  END;
  BEGIN -- sku alone is the third legal shape
    UPDATE assignments SET product_id = NULL, product_sku = 'DP2'
      WHERE id = 'd9000000-0000-0000-0000-0000000000d3';
    v_sku := 'allowed';
    EXCEPTION WHEN check_violation THEN v_sku := 'refused';
  END;
  IF v_two = 'refused' AND v_none = 'refused' AND v_sku = 'allowed' THEN RAISE NOTICE 'PASS D3';
  ELSE RAISE NOTICE 'FAIL D3: both=% neither=% sku_only=% (want refused/refused/allowed)', v_two, v_none, v_sku; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_D3;

\echo 'D4: assignments_operator_identified — an operator id, or a remembered name. Exactly one.'
SAVEPOINT sp_D4;
DO $$
DECLARE v_two text := 'no error'; v_none text := 'no error';
BEGIN
  BEGIN
    UPDATE assignments SET operator_display_name = 'Ghost'
      WHERE id = 'd9000000-0000-0000-0000-0000000000d1';
    EXCEPTION WHEN check_violation THEN v_two := 'refused';
  END;
  BEGIN
    UPDATE assignments SET operator_id = NULL WHERE id = 'd9000000-0000-0000-0000-0000000000d1';
    EXCEPTION WHEN check_violation THEN v_none := 'refused';
  END;
  IF v_two = 'refused' AND v_none = 'refused' THEN RAISE NOTICE 'PASS D4';
  ELSE RAISE NOTICE 'FAIL D4: both=% neither=% (want refused/refused)', v_two, v_none; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_D4;

-- ===========================================================================
-- PREVIEW — the counts the dialog names.
-- ===========================================================================

\echo 'D5: preview of a product nothing has ever used — every count zero, identity right, and the keys present'
SAVEPOINT sp_D5;
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd01', true);
  SET LOCAL ROLE authenticated;
  v := deletion_preview('product','d6000000-0000-0000-0000-0000000000d4');
  RESET ROLE;
  IF v->>'name' = 'Never Scheduled' AND v->>'code' = 'DP4' AND (v->>'active')::boolean
     AND (v->'removes'->0->>'what') = 'runs'        AND (v->'removes'->0->>'count')::int = 0
     AND (v->'removes'->1->>'what') = 'assignments' AND (v->'removes'->1->>'count')::int = 0
     AND (v->'keeps'->0->>'count')::int = 0 AND (v->'keeps'->1->>'count')::int = 0
  THEN RAISE NOTICE 'PASS D5';
  ELSE RAISE NOTICE 'FAIL D5: %', v; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D5: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D5;

\echo 'D6 ⭐: preview splits DP2 by the clock — 1 run + 2 assignments go, 2 runs + 2 assignments stay'
SAVEPOINT sp_D6;
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd01', true);
  SET LOCAL ROLE authenticated;
  v := deletion_preview('product','d6000000-0000-0000-0000-0000000000d2');
  RESET ROLE;
  -- removes: the 2099 run, its one crew member, and the 2099 direct assignment.
  -- keeps:   the 2020 run and the unbounded one, the 2020 crew member and the
  --          2020 direct assignment.
  IF (v->'removes'->0->>'count')::int = 1 AND (v->'removes'->1->>'count')::int = 2
 AND (v->'keeps'->0->>'count')::int   = 2 AND (v->'keeps'->1->>'count')::int   = 2
  THEN RAISE NOTICE 'PASS D6';
  ELSE RAISE NOTICE 'FAIL D6: %', v; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D6: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D6;

\echo 'D7: an unrecognised kind is invalid_argument (PT400) naming p_kind, not a silent empty answer'
SAVEPOINT sp_D7;
DO $$
DECLARE v_state text := 'none'; v_field text := 'none'; v_detail text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd01', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM deletion_preview('run','d8000000-0000-0000-0000-0000000000d1');
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_field := v_detail::jsonb->>'field';
  END;
  RESET ROLE;
  IF v_state = 'PT400' AND v_field = 'p_kind' THEN RAISE NOTICE 'PASS D7';
  ELSE RAISE NOTICE 'FAIL D7: sqlstate=% field=% (want PT400/p_kind)', v_state, v_field; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D7: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D7;

\echo 'D8 ⭐: a row in ANOTHER TENANT reads as not-found, the same answer an invented id gets — no probe'
SAVEPOINT sp_D8;
DO $$
DECLARE v_other text := 'none'; v_invented text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd01', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- org 2's product, from the seed.
    PERFORM deletion_preview('product','6000000b-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN v_other := SQLSTATE; END;
  BEGIN
    PERFORM deletion_preview('product','00000000-0000-0000-0000-0000000000ff');
  EXCEPTION WHEN OTHERS THEN v_invented := SQLSTATE; END;
  RESET ROLE;
  IF v_other = 'PT400' AND v_invented = 'PT400' THEN RAISE NOTICE 'PASS D8';
  ELSE RAISE NOTICE 'FAIL D8: other_tenant=% invented=% (want PT400 both — a different answer is a probe)', v_other, v_invented; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D8: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D8;

\echo 'D9: an operator preview names the qualifications that go with them as well as the schedule'
SAVEPOINT sp_D9;
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd01', true);
  SET LOCAL ROLE authenticated;
  v := deletion_preview('operator','d5000000-0000-0000-0000-0000000000d2');
  RESET ROLE;
  IF v->>'name' = 'Plantwide Pat'
 AND (v->'removes'->0->>'what') = 'assignments'     AND (v->'removes'->0->>'count')::int = 1
 AND (v->'removes'->1->>'what') = 'operator_skills' AND (v->'removes'->1->>'count')::int = 1
 AND (v->'keeps'->0->>'count')::int = 1
  THEN RAISE NOTICE 'PASS D9';
  ELSE RAISE NOTICE 'FAIL D9: %', v; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D9: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D9;

\echo 'D10 ⭐: a training keeps NOTHING, and says so with an empty list rather than by silence'
SAVEPOINT sp_D10;
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd01', true);
  SET LOCAL ROLE authenticated;
  v := deletion_preview('skill','d4000000-0000-0000-0000-0000000000d1');
  RESET ROLE;
  IF v->>'name' = 'Line Training D' AND v->>'code' IS NULL
 AND (v->'removes'->0->>'what') = 'operator_skills'          AND (v->'removes'->0->>'count')::int = 1
 AND (v->'removes'->1->>'what') = 'node_skill_requirements'  AND (v->'removes'->1->>'count')::int = 1
 AND v->'keeps' = '[]'::jsonb
  THEN RAISE NOTICE 'PASS D10';
  ELSE RAISE NOTICE 'FAIL D10: %', v; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D10: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D10;

\echo 'D11: a shift pattern names its shifts, its breaks and the cells that would lose it'
SAVEPOINT sp_D11;
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd01', true);
  SET LOCAL ROLE authenticated;
  v := deletion_preview('shift_template','d7000000-0000-0000-0000-0000000000d1');
  RESET ROLE;
  IF (v->'removes'->0->>'what') = 'shifts'               AND (v->'removes'->0->>'count')::int = 1
 AND (v->'removes'->1->>'what') = 'shift_breaks'         AND (v->'removes'->1->>'count')::int = 2
 AND (v->'removes'->2->>'what') = 'node_shift_templates' AND (v->'removes'->2->>'count')::int = 1
  THEN RAISE NOTICE 'PASS D11';
  ELSE RAISE NOTICE 'FAIL D11: %', v; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D11: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D11;

-- ===========================================================================
-- THE DELETE ITSELF.
-- ===========================================================================

\echo 'D12: the product row is gone from the catalogue'
SAVEPOINT sp_D12;
DO $$
DECLARE v_left int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true); -- D115: deleting a product is a COMPANY-admin act (Split)
  SET LOCAL ROLE authenticated;
  PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d2');
  RESET ROLE;
  SELECT count(*) INTO v_left FROM products WHERE id = 'd6000000-0000-0000-0000-0000000000d2';
  IF v_left = 0 THEN RAISE NOTICE 'PASS D12';
  ELSE RAISE NOTICE 'FAIL D12: % product rows left', v_left; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D12: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D12;

\echo 'D13 ⭐: the run that had not started is gone; the one that had is still there'
SAVEPOINT sp_D13;
DO $$
DECLARE v_future int; v_past int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true); -- D115: deleting a product is a COMPANY-admin act (Split)
  SET LOCAL ROLE authenticated;
  PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d2');
  RESET ROLE;
  SELECT count(*) INTO v_future FROM runs WHERE id = 'd8000000-0000-0000-0000-0000000000d2';
  SELECT count(*) INTO v_past   FROM runs WHERE id = 'd8000000-0000-0000-0000-0000000000d1';
  IF v_future = 0 AND v_past = 1 THEN RAISE NOTICE 'PASS D13';
  ELSE RAISE NOTICE 'FAIL D13: future run rows=% (want 0), started run rows=% (want 1)', v_future, v_past; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D13: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D13;

\echo 'D14: the crew of the deleted run went with it; the crew of the kept run did not'
SAVEPOINT sp_D14;
DO $$
DECLARE v_future int; v_past int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true); -- D115: deleting a product is a COMPANY-admin act (Split)
  SET LOCAL ROLE authenticated;
  PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d2');
  RESET ROLE;
  SELECT count(*) INTO v_future FROM assignments WHERE id = 'd9000000-0000-0000-0000-0000000000d2';
  SELECT count(*) INTO v_past   FROM assignments WHERE id = 'd9000000-0000-0000-0000-0000000000d1';
  IF v_future = 0 AND v_past = 1 THEN RAISE NOTICE 'PASS D14';
  ELSE RAISE NOTICE 'FAIL D14: crew of deleted run=% (want 0), crew of kept run=% (want 1)', v_future, v_past; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D14: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D14;

\echo 'D15: the direct (model A) assignment that had not started is gone; the started one is not'
SAVEPOINT sp_D15;
DO $$
DECLARE v_future int; v_past int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true); -- D115: deleting a product is a COMPANY-admin act (Split)
  SET LOCAL ROLE authenticated;
  PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d2');
  RESET ROLE;
  SELECT count(*) INTO v_future FROM assignments WHERE id = 'd9000000-0000-0000-0000-0000000000d4';
  SELECT count(*) INTO v_past   FROM assignments WHERE id = 'd9000000-0000-0000-0000-0000000000d3';
  IF v_future = 0 AND v_past = 1 THEN RAISE NOTICE 'PASS D15';
  ELSE RAISE NOTICE 'FAIL D15: future direct=% (want 0), started direct=% (want 1)', v_future, v_past; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D15: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D15;

\echo 'D16 ⭐: the returned counts are what HAPPENED, and they match what the preview predicted'
SAVEPOINT sp_D16;
DO $$
DECLARE v_pre jsonb; v_post jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true); -- D115: product delete is a COMPANY-admin act (Split)
  SET LOCAL ROLE authenticated;
  v_pre  := deletion_preview('product','d6000000-0000-0000-0000-0000000000d2');
  v_post := delete_owned_row('product','d6000000-0000-0000-0000-0000000000d2');
  RESET ROLE;
  -- Deliberately compared rather than assumed equal: the two calls answer at
  -- different instants, so a screen that reports the PREDICTION as the outcome
  -- is a screen that lies the first time somebody schedules between them.
  IF v_post->'removes' = v_pre->'removes' AND v_post->'keeps' = v_pre->'keeps'
     AND (v_post->>'deleted')::boolean AND v_post->>'code' = 'DP2'
  THEN RAISE NOTICE 'PASS D16';
  ELSE RAISE NOTICE 'FAIL D16: preview=% actual=%', v_pre, v_post; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D16: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D16;

\echo 'D17 ⭐⭐: a run with an UNBOUNDED start is KEPT — a row whose start we cannot name is not one we delete'
SAVEPOINT sp_D17;
DO $$
DECLARE v_left int; v_sku text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true); -- D115: deleting a product is a COMPANY-admin act (Split)
  SET LOCAL ROLE authenticated;
  PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d2');
  RESET ROLE;
  SELECT count(*), max(product_sku) INTO v_left, v_sku
    FROM runs WHERE id = 'd8000000-0000-0000-0000-0000000000d3';
  IF v_left = 1 AND v_sku = 'DP2' THEN RAISE NOTICE 'PASS D17';
  ELSE RAISE NOTICE 'FAIL D17: rows=% sku=% (want 1/DP2 — lower() IS NULL must fall on the KEPT side)', v_left, v_sku; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D17: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D17;

\echo 'D18 ⭐⭐: the kept run remembers the sku, the name AND the colour, and its product_id is released'
SAVEPOINT sp_D18;
DO $$
DECLARE v_colour text; r record;
BEGIN
  SELECT color_token INTO v_colour FROM products WHERE id = 'd6000000-0000-0000-0000-0000000000d2';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true); -- D115: deleting a product is a COMPANY-admin act (Split)
  SET LOCAL ROLE authenticated;
  PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d2');
  RESET ROLE;
  SELECT product_id, product_sku, product_name, product_color_token INTO r
    FROM runs WHERE id = 'd8000000-0000-0000-0000-0000000000d1';
  IF r.product_id IS NULL AND r.product_sku = 'DP2' AND r.product_name = 'Plant-wide Part'
     AND r.product_color_token = v_colour
  THEN RAISE NOTICE 'PASS D18';
  ELSE RAISE NOTICE 'FAIL D18: id=% sku=% name=% colour=% (wanted NULL/DP2/Plant-wide Part/%)',
    r.product_id, r.product_sku, r.product_name, r.product_color_token, v_colour; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D18: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D18;

\echo 'D19: deleting a person leaves their finished work on the board under their name'
SAVEPOINT sp_D19;
DO $$
DECLARE r record; v_future int; v_holdings int; v_row int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd01', true);
  SET LOCAL ROLE authenticated;
  PERFORM delete_owned_row('operator','d5000000-0000-0000-0000-0000000000d1');
  RESET ROLE;
  SELECT operator_id, operator_display_name INTO r
    FROM assignments WHERE id = 'd9000000-0000-0000-0000-0000000000d1';
  SELECT count(*) INTO v_future   FROM assignments WHERE id = 'd9000000-0000-0000-0000-0000000000d2';
  SELECT count(*) INTO v_holdings FROM operator_skills WHERE operator_id = 'd5000000-0000-0000-0000-0000000000d1';
  SELECT count(*) INTO v_row      FROM operators WHERE id = 'd5000000-0000-0000-0000-0000000000d1';
  IF r.operator_id IS NULL AND r.operator_display_name = 'Dana Departing'
     AND v_future = 0 AND v_holdings = 0 AND v_row = 0
  THEN RAISE NOTICE 'PASS D19';
  ELSE RAISE NOTICE 'FAIL D19: id=% name=% future=% holdings=% operator_rows=%',
    r.operator_id, r.operator_display_name, v_future, v_holdings, v_row; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D19: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D19;

\echo 'D20 ⭐: the kept DIRECT assignment keeps its product by memory and stays a legal row'
SAVEPOINT sp_D20;
DO $$
DECLARE r record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true); -- D115: deleting a product is a COMPANY-admin act (Split)
  SET LOCAL ROLE authenticated;
  PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d2');
  RESET ROLE;
  SELECT run_id, product_id, product_sku, product_name INTO r
    FROM assignments WHERE id = 'd9000000-0000-0000-0000-0000000000d3';
  -- run_id still NULL and product_id now NULL: the row survives only because
  -- assignments_work_identified counts the remembered sku as the third way of
  -- naming the one thing an assignment is for.
  IF r.run_id IS NULL AND r.product_id IS NULL AND r.product_sku = 'DP2'
     AND r.product_name = 'Plant-wide Part'
  THEN RAISE NOTICE 'PASS D20';
  ELSE RAISE NOTICE 'FAIL D20: run=% product=% sku=% name=%', r.run_id, r.product_id, r.product_sku, r.product_name; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D20: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D20;

\echo 'D21: a snapshotted run can still be edited — app_guard_run_scope tolerates a NULL product rather than dying on it'
SAVEPOINT sp_D21;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true); -- D115: deleting a product is a COMPANY-admin act (Split)
  SET LOCAL ROLE authenticated;
  PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d2');
  BEGIN
    UPDATE runs SET planned_headcount = 9 WHERE id = 'd8000000-0000-0000-0000-0000000000d1';
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  IF v_state = 'allowed' THEN RAISE NOTICE 'PASS D21';
  ELSE RAISE NOTICE 'FAIL D21: editing a snapshotted run gave % (want allowed)', v_state; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D21: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D21;

\echo 'D22 ⭐⭐: a person can be deleted even when their own history exceeds a cap they are no longer subject to'
SAVEPOINT sp_D22;
DO $$
DECLARE v_state text := 'none'; v_name text;
BEGIN
  -- The kept assignment runs at efficiency 1.000. Drop the org cap below it,
  -- so the snapshot UPDATE re-enters check_operator_capacity with a peak that
  -- exceeds it. Without §4's early return this raises capacity_exceeded and
  -- "delete this person" becomes impossible for anyone who ever worked a full
  -- shift — a failure that reads as "delete is broken", not as a cap problem.
  UPDATE orgs SET settings = COALESCE(settings,'{}'::jsonb) || '{"capacity_cap":0.5}'::jsonb
    WHERE id = '10000000-0000-0000-0000-000000000001';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd01', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM delete_owned_row('operator','d5000000-0000-0000-0000-0000000000d1');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  SELECT operator_display_name INTO v_name FROM assignments WHERE id = 'd9000000-0000-0000-0000-0000000000d1';
  IF v_state = 'allowed' AND v_name = 'Dana Departing' THEN RAISE NOTICE 'PASS D22';
  ELSE RAISE NOTICE 'FAIL D22: state=% remembered_name=% (want allowed / Dana Departing)', v_state, v_name; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D22: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D22;

\echo 'D23 ⭐⭐: with the operator NULL, the assignment guard still checks the PRODUCT half it used to skip'
SAVEPOINT sp_D23;
DO $$
DECLARE v_state text := 'none'; v_kind text; v_detail text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd01', true);
  SET LOCAL ROLE authenticated;
  -- Pat is deleted, so the started direct assignment on Cell 2 now has a NULL
  -- operator and still carries DP3-able product DP2... so give it a product
  -- that belongs to LINE 1 and then move the row to Cell 6, which Line 1 does
  -- not cover. 0028's guard must still refuse it.
  PERFORM delete_owned_row('operator','d5000000-0000-0000-0000-0000000000d2');
  UPDATE assignments SET product_id = 'd6000000-0000-0000-0000-0000000000d1'
    WHERE id = 'd9000000-0000-0000-0000-0000000000d3';
  BEGIN
    UPDATE assignments SET node_id = '3000000a-0000-0000-0000-00000000000c'
      WHERE id = 'd9000000-0000-0000-0000-0000000000d3';
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_kind := v_detail::jsonb->>'kind';
  END;
  RESET ROLE;
  IF v_state = 'PT409' AND v_kind = 'product' THEN RAISE NOTICE 'PASS D23';
  ELSE RAISE NOTICE 'FAIL D23: state=% kind=% (want PT409/product — the operator half must not short-circuit the product half)', v_state, v_kind; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D23: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D23;

\echo 'D24: deleting a shift pattern takes its shifts, its breaks and its attachments with it'
SAVEPOINT sp_D24;
DO $$
DECLARE v_t int; v_s int; v_b int; v_n int; v_resolved uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd01', true);
  SET LOCAL ROLE authenticated;
  PERFORM delete_owned_row('shift_template','d7000000-0000-0000-0000-0000000000d1');
  RESET ROLE;
  SELECT count(*) INTO v_t FROM shift_templates WHERE id = 'd7000000-0000-0000-0000-0000000000d1';
  SELECT count(*) INTO v_s FROM shifts          WHERE template_id = 'd7000000-0000-0000-0000-0000000000d1';
  SELECT count(*) INTO v_b FROM shift_breaks    WHERE shift_id = 'd7100000-0000-0000-0000-0000000000d1';
  SELECT count(*) INTO v_n FROM node_shift_templates WHERE template_id = 'd7000000-0000-0000-0000-0000000000d1';
  -- Cell 3 had this pattern attached directly; with the attachment gone it
  -- falls back to whatever an ancestor supplies, which is what
  -- resolve_shift_template has always done.
  v_resolved := resolve_shift_template('30000000-0000-0000-0000-000000000009');
  IF v_t = 0 AND v_s = 0 AND v_b = 0 AND v_n = 0
     AND v_resolved IS DISTINCT FROM 'd7000000-0000-0000-0000-0000000000d1'
  THEN RAISE NOTICE 'PASS D24';
  ELSE RAISE NOTICE 'FAIL D24: template=% shifts=% breaks=% attachments=% resolved=%', v_t, v_s, v_b, v_n, v_resolved; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D24: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D24;

\echo 'D25 ⭐⭐: a LINE 1 admin deletes a LINE 1 training held by a PLANT-wide person they do not administer'
SAVEPOINT sp_D25;
DO $$
DECLARE v_state text := 'none'; v_skill int; v_hold int; v_req int; v_direct boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd03', true);
  SET LOCAL ROLE authenticated;
  -- First, the fact that makes this case worth having: d3 may NOT delete that
  -- holding by hand. If this ever comes back true the case has stopped
  -- measuring the cascade and started measuring nothing.
  SELECT app_is_admin_for_operator('d5000000-0000-0000-0000-0000000000d2') INTO v_direct;
  BEGIN
    PERFORM delete_owned_row('skill','d4000000-0000-0000-0000-0000000000d1');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  SELECT count(*) INTO v_skill FROM skills WHERE id = 'd4000000-0000-0000-0000-0000000000d1';
  SELECT count(*) INTO v_hold  FROM operator_skills WHERE skill_id = 'd4000000-0000-0000-0000-0000000000d1';
  SELECT count(*) INTO v_req   FROM node_skill_requirements WHERE skill_id = 'd4000000-0000-0000-0000-0000000000d1';
  IF v_direct IS NOT TRUE AND v_state = 'allowed' AND v_skill = 0 AND v_hold = 0 AND v_req = 0
  THEN RAISE NOTICE 'PASS D25';
  ELSE RAISE NOTICE 'FAIL D25: admin_for_holder=% state=% skill=% holdings=% requirements=%', v_direct, v_state, v_skill, v_hold, v_req; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D25: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D25;

-- ===========================================================================
-- PERMISSION — the two refusals that bound D110c, and the door being shut.
-- ===========================================================================

\echo 'D26 ⭐: a site admin of ANOTHER plant gets NOT FOUND, not "forbidden" — a refusal that confirms the row exists is itself a leak'
SAVEPOINT sp_D26;
DO $$
DECLARE v_state text := 'none'; v_left int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd02', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d2');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  SELECT count(*) INTO v_left FROM products WHERE id = 'd6000000-0000-0000-0000-0000000000d2';
  -- ⭐ PT400, not PT403, and the difference is the point. d2's grant and
  -- Plant 1 never meet, so under D107/D108 they cannot READ the row at all —
  -- the RLS-filtered lookup finds nothing and "not found" is the honest and
  -- the safe answer. A PT403 here would mean the function had confirmed a
  -- Plant 1 product exists to somebody who may not know that.
  -- ⚠️ The row count matters as much as the sqlstate: a refusal that has
  -- already deleted half the schedule is not a refusal.
  IF v_state = 'PT400' AND v_left = 1 THEN RAISE NOTICE 'PASS D26';
  ELSE RAISE NOTICE 'FAIL D26: state=% product_rows=% (want PT400 and 1)', v_state, v_left; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D26: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D26;

\echo 'D27 ⭐ (message updated by 0034/Split): a SUPERVISOR on the very same plant may schedule but may not delete the catalogue — the refusal now says "only a company admin"'
SAVEPOINT sp_D27;
DO $$
DECLARE v_state text := 'none'; v_left int; v_node text; v_detail text; v_msg text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd04', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d2');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL, v_msg = MESSAGE_TEXT;
    v_node := v_detail::jsonb->>'error';
  END;
  RESET ROLE;
  SELECT count(*) INTO v_left FROM products WHERE id = 'd6000000-0000-0000-0000-0000000000d2';
  -- ⭐⭐ THE MESSAGE IS ASSERTED, AND A MUTATION IS WHY. Deleting the RPC's
  -- up-front permission check does NOT make this delete succeed: the DELETE on
  -- `products` is filtered by the table's own policy, removes zero rows, and
  -- the ROW_COUNT guard turns that into the same PT403/not_permitted. So the
  -- sqlstate alone cannot tell "refused before anything was attempted" from
  -- "refused after the runs had been deleted and rolled back" — and the two
  -- are different products: one says you may not administer this site, the
  -- other says "the product itself could not be deleted", which is a sentence
  -- nobody can act on. Measured: without the message this case, and every
  -- other case in this file, passes against a version with no permission check.
  -- ⭐ D115/Split: a product is company property, so the refusal is no longer
  -- "no admin rights over the site" (the owner-scoped message the other three
  -- kinds still use) but "only a company admin can delete a shared part".
  IF v_state = 'PT403' AND v_node = 'not_permitted' AND v_left = 1
     AND v_msg LIKE '%only a company admin can delete a shared part%'
  THEN RAISE NOTICE 'PASS D27';
  ELSE RAISE NOTICE 'FAIL D27: state=% error=% product_rows=% message=% (want PT403/not_permitted/1 and the company-admin refusal)', v_state, v_node, v_left, v_msg; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D27: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D27;

\echo 'D28 ⭐⭐ (rewritten by 0034/Split): a LINE 1 admin may NOT delete a shared part even though they administer its only line — it is company property; a COMPANY admin can, and the run on a cell under it goes too'
SAVEPOINT sp_D28;
DO $$
DECLARE v_admin_cell boolean; v_line_state text := 'none'; v_left_after_line int;
        v_co_state text := 'none'; v_prod int; v_run int;
BEGIN
  -- ⭐⭐ SUPERSEDES THE OLD "the owner deletes it" CASE. D115's Split makes the
  -- shared product record company property, so administering the part's only
  -- place (Line 1) is NOT enough to delete it. d3 can edit every cell under Line
  -- 1 -- Cell 1 is reached only through it -- and still cannot delete the part.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000dd03', true);
  SET LOCAL ROLE authenticated;
  SELECT app_can_edit_node('30000000-0000-0000-0000-000000000007') INTO v_admin_cell;
  BEGIN
    PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d1');
    v_line_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_line_state := SQLSTATE; END;
  RESET ROLE;
  SELECT count(*) INTO v_left_after_line FROM products WHERE id = 'd6000000-0000-0000-0000-0000000000d1';
  -- The company admin CAN, and the migration header's cascade still holds: the
  -- future run on Cell 1 (which only Line 1 covers) goes with the part.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d1');
    v_co_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_co_state := SQLSTATE; END;
  RESET ROLE;
  SELECT count(*) INTO v_prod FROM products WHERE id = 'd6000000-0000-0000-0000-0000000000d1';
  SELECT count(*) INTO v_run  FROM runs     WHERE id = 'd8000000-0000-0000-0000-0000000000d4';
  IF v_admin_cell AND v_line_state = 'PT403' AND v_left_after_line = 1
     AND v_co_state = 'allowed' AND v_prod = 0 AND v_run = 0 THEN RAISE NOTICE 'PASS D28';
  ELSE RAISE NOTICE 'FAIL D28: can_edit_cell=% line_admin=% part_left=% company_admin=% product=% run=% (want true/PT403/1/allowed/0/0)',
    v_admin_cell, v_line_state, v_left_after_line, v_co_state, v_prod, v_run; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D28: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D28;

\echo 'D29: as anon, both functions are permission-denied — the default PUBLIC grant was revoked'
SAVEPOINT sp_D29;
DO $$
DECLARE v_p text := 'none'; v_d text := 'none';
BEGIN
  SET LOCAL ROLE anon;
  BEGIN PERFORM deletion_preview('product','d6000000-0000-0000-0000-0000000000d2');
    EXCEPTION WHEN OTHERS THEN v_p := SQLSTATE; END;
  BEGIN PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d2');
    EXCEPTION WHEN OTHERS THEN v_d := SQLSTATE; END;
  RESET ROLE;
  IF v_p = '42501' AND v_d = '42501' THEN RAISE NOTICE 'PASS D29';
  ELSE RAISE NOTICE 'FAIL D29: preview=% delete=% (want 42501 both)', v_p, v_d; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D29: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D29;

\echo 'D30: deleting a catalogue row is audited — the row itself, not only the schedule it took with it'
SAVEPOINT sp_D30;
DO $$
DECLARE v_n int; v_before jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true); -- D115: deleting a product is a COMPANY-admin act (Split)
  SET LOCAL ROLE authenticated;
  PERFORM delete_owned_row('product','d6000000-0000-0000-0000-0000000000d2');
  RESET ROLE;
  -- ⚠️ NOT `max(before)`: there is no max(jsonb) in PostgreSQL, and a case
  -- that reaches for one fails with 42883 rather than with anything about the
  -- audit log. 0028 shipped exactly this mistake as `min(uuid)`.
  SELECT count(*) INTO v_n FROM audit_log
   WHERE table_name = 'products' AND action = 'delete'
     AND row_id = 'd6000000-0000-0000-0000-0000000000d2';
  SELECT before INTO v_before FROM audit_log
   WHERE table_name = 'products' AND action = 'delete'
     AND row_id = 'd6000000-0000-0000-0000-0000000000d2' LIMIT 1;
  IF v_n = 1 AND v_before->>'sku' = 'DP2' THEN RAISE NOTICE 'PASS D30';
  ELSE RAISE NOTICE 'FAIL D30: audit rows=% before.sku=%', v_n, v_before->>'sku'; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D30: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D30;

\echo 'D31 ⭐: DEACTIVATE is the other half of the offer and it touches NOTHING — that is the whole reason to prefer it'
SAVEPOINT sp_D31;
DO $$
DECLARE v_active boolean; v_runs int; v_asg int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true); -- D115/Split: editing the shared product record is company-only
  SET LOCAL ROLE authenticated;
  UPDATE products SET active = false WHERE id = 'd6000000-0000-0000-0000-0000000000d2';
  RESET ROLE;
  SELECT active INTO v_active FROM products WHERE id = 'd6000000-0000-0000-0000-0000000000d2';
  SELECT count(*) INTO v_runs FROM runs        WHERE product_id = 'd6000000-0000-0000-0000-0000000000d2';
  SELECT count(*) INTO v_asg  FROM assignments WHERE product_id = 'd6000000-0000-0000-0000-0000000000d2';
  IF v_active = false AND v_runs = 3 AND v_asg = 2 THEN RAISE NOTICE 'PASS D31';
  ELSE RAISE NOTICE 'FAIL D31: active=% runs=% assignments=% (want false/3/2)', v_active, v_runs, v_asg; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL D31: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D31;

ROLLBACK;

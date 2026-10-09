-- ============================================================================
-- 84_shift_pattern_resolves_upward_test.sql --- migration 0061 (DEF-0016, R-039).
--
-- The defect: a line supervisor granted only her line opened her board and it
-- had no shift pattern at all. Plant A's template is attached at the plant; her
-- line and cells inherit it (R-039, nearest ancestor wins). resolve_shift_template
-- was SECURITY INVOKER, so the ancestor node and its attachment row --- both
-- above her descendants-only grant --- were filtered away by RLS, the walk found
-- nothing, and the resolver answered NULL for a line that does run a pattern.
-- board_window builds shift_templates and node_shift_map straight off the
-- resolver, so both keys came back empty and the board drew no break band, no
-- shift boundary and offered no shift chips.
--
-- 0061 re-emits the resolver SECURITY DEFINER with a pinned search_path, org-
-- bounded so a node in another company (or a uuid that exists nowhere) still
-- resolves to NULL for a tenant caller, the way 0050 did for settings and 0058
-- for people.
--
-- ⚠️ EVERY ANSWER AND REFUSAL IS MEASURED AS `authenticated`. psql connects as
-- the superuser, who bypasses RLS and whose app_current_org() is NULL --- the
-- exact owner context 30_shifts and 56_delete resolve in, and NOT the context
-- this defect is about. NOBODY in this fixture is a company admin except a1,
-- who exists only to build the tree (create_node needs app_is_admin()).
--
-- FIXTURE (org 1 Northwind, on nodes nothing else in the suite touches; all UTC).
--
--   Plant P (root)           <- template T attached here
--     Area P1
--       Line P1              <- Sup's ONLY grant (supervisor)
--         Cell P1
--         Cell P2
--       Line P2              <- template T2 attached here
--         Cell P3
--
--   Org 2 Contoso Cell 1 (seed 3000000b...0007) <- template T_other attached,
--         so the boundary case fails on the TENANT, not on an absent pattern.
--
--   T       plant pattern, one shift 06:00-14:00 with a 02:00-02:30 break, so
--           board_window carries real shift chips once the map is non-empty.
--   T2      a second pattern, to prove nearest-ancestor over the plant's.
--
--   People: Sup    org-wide 'supervisor', supervisor grant on Line P1 only.
--                  She can read NEITHER Plant P NOR Area P1 (nodes_select is
--                  path <@ grant, descendants only); ST0/ST1 measure that first.
--           Padm   org-wide 'viewer', ADMIN grant on Plant P. She can read the
--                  plant and everything under it, so she resolved T even as
--                  invoker --- ST2 pins that this migration did not change it.
--           a1     the seed's company admin, to build the tree only.
--
-- ST0    the premises: the attachments exist, org 2's node is another org and
--        has T_other, and Sup can read none of the three nodes above her line
-- ST1 ⛔ THE DEFECT: as Sup, resolve_shift_template(Line P1 / Cell P1 / Cell P2)
--        = T --- the plant's pattern, resolved past her grant (RED before 0061:
--        NULL; GREEN after)
-- ST2    as Padm (plant admin), the same node resolves to the same T
-- ST3    nearest ancestor: a template attached at Line P2 wins over the plant's
--        for Cell P3, while Cell P1 still resolves the plant's T
-- ST4 ⚠  a node in another company resolves to NULL for Sup even though it HAS
--        a pattern attached --- and to T_other in owner context, so the NULL is
--        the tenant boundary and not an absent row
-- ST5    a bogus uuid resolves to NULL
-- ST6 ⛔ board_window called as Sup carries node_shift_map (the key that was
--        array(0)) with an entry per readable cell, all pointing at T, and
--        shift_templates carrying T with its shift and break (RED before; GREEN
--        after)
-- ST7    grants on resolve_shift_template(uuid): authenticated only
-- ST8 ⚠  (DEF-0019) an authenticated session with NO profile row (a fresh
--        sign-up: app_current_org() NULL but auth.uid() NOT null) resolves NULL
--        for org 2's node AND for org 1's Plant P, both of which resolve their
--        pattern in owner context --- so 0068's exemption is auth.uid() IS NULL,
--        not app_current_org() IS NULL, and a profile-less tenant is bounded
-- ============================================================================

BEGIN;

CREATE TEMP TABLE st_fix (k text primary key, v uuid);
GRANT SELECT ON st_fix TO PUBLIC;

-- Build the org-1 tree as the company admin (create_node needs app_is_admin).
DO $$
DECLARE v_p uuid; v_a1 uuid; v_l1 uuid; v_c1 uuid; v_c2 uuid; v_l2 uuid; v_c3 uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_p  := (create_node(NULL, 'Plant P',  0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_a1 := (create_node(v_p,  'Area P1',  0)->>'id')::uuid;
  v_l1 := (create_node(v_a1, 'Line P1',  0)->>'id')::uuid;
  v_c1 := (create_node(v_l1, 'Cell P1',  0)->>'id')::uuid;
  v_c2 := (create_node(v_l1, 'Cell P2',  1)->>'id')::uuid;
  v_l2 := (create_node(v_a1, 'Line P2',  1)->>'id')::uuid;
  v_c3 := (create_node(v_l2, 'Cell P3',  0)->>'id')::uuid;
  RESET ROLE;
  INSERT INTO st_fix (k, v) VALUES
    ('p', v_p), ('a1', v_a1), ('l1', v_l1), ('c1', v_c1),
    ('c2', v_c2), ('l2', v_l2), ('c3', v_c3);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- Templates, attachments, people and grants, written as the OWNER (superuser
-- bypasses RLS; `authenticated` cannot write a TEMP table --- 57's lesson).
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_org2 uuid := '10000000-0000-0000-0000-000000000002';
        v_other uuid := '3000000b-0000-0000-0000-000000000007';
        v_t  uuid := 'a1000000-0000-0000-0000-000000000001';
        v_t2 uuid := 'a1000000-0000-0000-0000-000000000002';
        v_to uuid := 'a2000000-0000-0000-0000-000000000001';
        v_sh uuid := 'a1100000-0000-0000-0000-000000000001';
        v_p uuid; v_l1 uuid; v_l2 uuid;
BEGIN
  SELECT v INTO v_p  FROM st_fix WHERE k = 'p';
  SELECT v INTO v_l1 FROM st_fix WHERE k = 'l1';
  SELECT v INTO v_l2 FROM st_fix WHERE k = 'l2';

  -- Two org-1 patterns. T is the plant's; T2 is Line P2's.
  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES
    (v_t,  v_org, 'P plant pattern', v_p),
    (v_t2, v_org, 'P line2 pattern', v_l2);
  -- T gets one shift and one break, so board_window has real chips to send.
  INSERT INTO shifts (id, org_id, template_id, name, start_min, end_min) VALUES
    (v_sh, v_org, v_t, 'Day', 360, 840);
  INSERT INTO shift_breaks (org_id, shift_id, name, start_min, end_min) VALUES
    (v_org, v_sh, 'Lunch', 120, 150);

  INSERT INTO node_shift_templates (node_id, org_id, template_id) VALUES
    (v_p,  v_org, v_t),     -- the plant's pattern (the one Sup could not see)
    (v_l2, v_org, v_t2);    -- a lower attachment, for nearest-ancestor

  -- Org 2's node gets its OWN pattern, so ST4 refuses on the tenant boundary
  -- and not on an absent row.
  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES
    (v_to, v_org2, 'Contoso pattern', v_other);
  INSERT INTO node_shift_templates (node_id, org_id, template_id) VALUES
    (v_other, v_org2, v_to);

  -- Sup: org-wide 'supervisor' (app_can_edit reaches a supervisor grant only
  -- through app_can_write, which reads the org-wide role); grant on Line P1.
  -- Padm: org-wide 'viewer' so app_is_admin() answers nothing; her ADMIN grant
  -- on the plant is what lets her read it.
  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000000f1'),
    ('00000000-0000-0000-0000-0000000000f2');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('d0000000-0000-0000-0000-000000000001', v_org, '00000000-0000-0000-0000-0000000000f1', 'supervisor'),
    ('d0000000-0000-0000-0000-000000000002', v_org, '00000000-0000-0000-0000-0000000000f2', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('d0000000-0000-0000-0000-000000000001', v_l1, v_org, 'supervisor'),
    ('d0000000-0000-0000-0000-000000000002', v_p,  v_org, 'admin');
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FIXTURE FAILED (data): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

\echo 'ST0: premises --- attachments exist, org 2 node is another org with its own pattern, Sup can read none of the three nodes above her line'
SAVEPOINT sp_ST0;
DO $$
DECLARE v_p uuid; v_a1 uuid; v_l2 uuid; v_other uuid := '3000000b-0000-0000-0000-000000000007';
        v_att_p int; v_att_l2 int; v_att_o int; v_other_org uuid; v_readable int;
        v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_p  FROM st_fix WHERE k = 'p';
  SELECT v INTO v_a1 FROM st_fix WHERE k = 'a1';
  SELECT v INTO v_l2 FROM st_fix WHERE k = 'l2';
  SELECT count(*) INTO v_att_p  FROM node_shift_templates WHERE node_id = v_p;
  SELECT count(*) INTO v_att_l2 FROM node_shift_templates WHERE node_id = v_l2;
  SELECT count(*) INTO v_att_o  FROM node_shift_templates WHERE node_id = v_other;
  SELECT org_id INTO v_other_org FROM nodes WHERE id = v_other;
  -- As Sup: the three nodes above her line are unreadable (nodes_select is
  -- path <@ grant). This is the whole premise the defect rests on.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_readable FROM nodes WHERE id IN (v_p, v_a1);
  RESET ROLE;
  IF v_att_p <> 1 OR v_att_l2 <> 1 OR v_att_o <> 1
  THEN v_ok := false; v_why := v_why || format(' attachments p=%s l2=%s other=%s', v_att_p, v_att_l2, v_att_o); END IF;
  IF v_other_org <> '10000000-0000-0000-0000-000000000002'
  THEN v_ok := false; v_why := v_why || ' org2 node is not in org 2'; END IF;
  IF v_readable <> 0
  THEN v_ok := false; v_why := v_why || format(' Sup can read %s of the 2 nodes above her line', v_readable); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS ST0';
  ELSE RAISE NOTICE 'FAIL ST0:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL ST0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_ST0;

\echo 'ST1 ⛔ (DEF-0016): as Sup, resolve_shift_template(Line P1 / Cell P1 / Cell P2) = the plant pattern T, resolved past her grant'
SAVEPOINT sp_ST1;
DO $$
DECLARE v_l1 uuid; v_c1 uuid; v_c2 uuid; v_t uuid := 'a1000000-0000-0000-0000-000000000001';
        v_rl uuid; v_r1 uuid; v_r2 uuid; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_l1 FROM st_fix WHERE k = 'l1';
  SELECT v INTO v_c1 FROM st_fix WHERE k = 'c1';
  SELECT v INTO v_c2 FROM st_fix WHERE k = 'c2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  v_rl := resolve_shift_template(v_l1);
  v_r1 := resolve_shift_template(v_c1);
  v_r2 := resolve_shift_template(v_c2);
  RESET ROLE;
  IF v_rl IS DISTINCT FROM v_t THEN v_ok := false; v_why := v_why || format(' line=%s', COALESCE(v_rl::text,'null')); END IF;
  IF v_r1 IS DISTINCT FROM v_t THEN v_ok := false; v_why := v_why || format(' cell1=%s', COALESCE(v_r1::text,'null')); END IF;
  IF v_r2 IS DISTINCT FROM v_t THEN v_ok := false; v_why := v_why || format(' cell2=%s', COALESCE(v_r2::text,'null')); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS ST1';
  ELSE RAISE NOTICE 'FAIL ST1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL ST1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_ST1;

\echo 'ST2: as Padm (plant admin), Line P1 resolves to the same plant pattern T'
SAVEPOINT sp_ST2;
DO $$
DECLARE v_l1 uuid; v_t uuid := 'a1000000-0000-0000-0000-000000000001'; v_r uuid; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_l1 FROM st_fix WHERE k = 'l1';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  v_r := resolve_shift_template(v_l1);
  RESET ROLE;
  IF v_r IS DISTINCT FROM v_t THEN v_ok := false; v_why := v_why || format(' line=%s', COALESCE(v_r::text,'null')); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS ST2';
  ELSE RAISE NOTICE 'FAIL ST2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL ST2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_ST2;

\echo 'ST3: nearest ancestor --- as the company admin, Cell P3 resolves Line P2''s T2 while Cell P1 resolves the plant''s T'
SAVEPOINT sp_ST3;
DO $$
DECLARE v_c1 uuid; v_c3 uuid; v_t uuid := 'a1000000-0000-0000-0000-000000000001';
        v_t2 uuid := 'a1000000-0000-0000-0000-000000000002'; v_r1 uuid; v_r3 uuid;
        v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM st_fix WHERE k = 'c1';
  SELECT v INTO v_c3 FROM st_fix WHERE k = 'c3';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_r1 := resolve_shift_template(v_c1);
  v_r3 := resolve_shift_template(v_c3);
  RESET ROLE;
  IF v_r1 IS DISTINCT FROM v_t  THEN v_ok := false; v_why := v_why || format(' cell1=%s', COALESCE(v_r1::text,'null')); END IF;
  IF v_r3 IS DISTINCT FROM v_t2 THEN v_ok := false; v_why := v_why || format(' cell3=%s', COALESCE(v_r3::text,'null')); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS ST3';
  ELSE RAISE NOTICE 'FAIL ST3:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL ST3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_ST3;

\echo 'ST4 ⚠: a node in ANOTHER company resolves to NULL for Sup, though it has a pattern --- and to that pattern in owner context, so the NULL is the tenant boundary'
SAVEPOINT sp_ST4;
DO $$
DECLARE v_other uuid := '3000000b-0000-0000-0000-000000000007';
        v_to uuid := 'a2000000-0000-0000-0000-000000000001';
        v_as_sup uuid; v_as_owner uuid; v_ok boolean := true; v_why text := '';
BEGIN
  -- Owner context first (app_current_org() NULL): the row genuinely resolves.
  -- Clear any jwt claim a prior case left in the GUC, or app_current_org()
  -- would still read org 1 and this would not be owner context at all.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_as_owner := resolve_shift_template(v_other);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  v_as_sup := resolve_shift_template(v_other);
  RESET ROLE;
  IF v_as_owner IS DISTINCT FROM v_to
  THEN v_ok := false; v_why := v_why || format(' owner sees=%s (expected T_other, so the row resolves)', COALESCE(v_as_owner::text,'null')); END IF;
  IF v_as_sup IS NOT NULL
  THEN v_ok := false; v_why := v_why || format(' Sup crossed the tenant boundary and got=%s', v_as_sup::text); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS ST4';
  ELSE RAISE NOTICE 'FAIL ST4:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL ST4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_ST4;

\echo 'ST5: a bogus uuid resolves to NULL for Sup'
SAVEPOINT sp_ST5;
DO $$
DECLARE v_r uuid; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  v_r := resolve_shift_template('ffffffff-ffff-ffff-ffff-ffffffffffff');
  RESET ROLE;
  IF v_r IS NOT NULL THEN v_ok := false; v_why := v_why || format(' bogus=%s', v_r::text); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS ST5';
  ELSE RAISE NOTICE 'FAIL ST5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL ST5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_ST5;

\echo 'ST6 ⛔ (DEF-0016): board_window as Sup carries node_shift_map (the key that was array(0)) --- one entry per readable cell pointing at T --- and shift_templates carrying T with its shift and break'
SAVEPOINT sp_ST6;
DO $$
DECLARE v_l1 uuid; v_path ltree; v_t uuid := 'a1000000-0000-0000-0000-000000000001';
        v_win jsonb; v_map jsonb; v_tpls jsonb; v_map_len int; v_bad int;
        v_tpl_ids uuid[]; v_shifts int; v_breaks int; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_l1 FROM st_fix WHERE k = 'l1';
  SELECT path INTO v_path FROM nodes WHERE id = v_l1;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  v_win := board_window(v_path, '2099-08-03 00:00+00', '2099-08-10 00:00+00');
  RESET ROLE;
  v_map  := v_win->'node_shift_map';
  v_tpls := v_win->'shift_templates';
  SELECT jsonb_array_length(v_map) INTO v_map_len;
  SELECT count(*) FILTER (WHERE (e->>'template_id')::uuid IS DISTINCT FROM v_t)
    INTO v_bad FROM jsonb_array_elements(v_map) e;
  SELECT array_agg((t->>'id')::uuid) INTO v_tpl_ids FROM jsonb_array_elements(v_tpls) t;
  SELECT jsonb_array_length(t->'shifts'),
         jsonb_array_length(t->'shifts'->0->'breaks')
    INTO v_shifts, v_breaks
    FROM jsonb_array_elements(v_tpls) t WHERE (t->>'id')::uuid = v_t;

  -- The scoped nodes are Line P1 + Cell P1 + Cell P2 = three, all inheriting T.
  IF v_map_len <> 3 THEN v_ok := false; v_why := v_why || format(' node_shift_map length=%s (was 0 before 0061)', v_map_len); END IF;
  IF v_bad <> 0 THEN v_ok := false; v_why := v_why || format(' %s map entries point somewhere other than T', v_bad); END IF;
  IF v_tpl_ids IS DISTINCT FROM ARRAY[v_t] THEN v_ok := false; v_why := v_why || format(' shift_templates=%s', COALESCE(v_tpl_ids::text,'null')); END IF;
  IF COALESCE(v_shifts,0) < 1 THEN v_ok := false; v_why := v_why || ' T carries no shift (no boundaries/chips)'; END IF;
  IF COALESCE(v_breaks,0) < 1 THEN v_ok := false; v_why := v_why || ' T''s shift carries no break (no break band)'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS ST6';
  ELSE RAISE NOTICE 'FAIL ST6:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL ST6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_ST6;

\echo 'ST7: grants on resolve_shift_template(uuid) --- authenticated executes, anon and public do not'
SAVEPOINT sp_ST7;
DO $$
DECLARE v_sig text := 'resolve_shift_template(uuid)'; v_a boolean; v_n boolean; v_p boolean;
        v_ok boolean := true; v_why text := '';
BEGIN
  SELECT has_function_privilege('authenticated', v_sig, 'EXECUTE'),
         has_function_privilege('anon',          v_sig, 'EXECUTE'),
         has_function_privilege('public',        v_sig, 'EXECUTE')
    INTO v_a, v_n, v_p;
  IF NOT (v_a AND NOT v_n AND NOT v_p)
  THEN v_ok := false; v_why := v_why || format(' authenticated=%s anon=%s public=%s', v_a, v_n, v_p); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS ST7';
  ELSE RAISE NOTICE 'FAIL ST7:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL ST7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_ST7;

\echo 'ST8 ⚠ (DEF-0019): an authenticated session with NO user_profiles row (a fresh sign-up, app_current_org() NULL but auth.uid() NOT null) resolves NULL for org 2''s node AND for org 1''s Plant P, both of which HAVE a pattern in owner context --- so the null is the boundary holding, not an absent row, and 0061''s app_current_org() IS NULL exemption is gone'
SAVEPOINT sp_ST8;
DO $$
DECLARE v_p uuid; v_other uuid := '3000000b-0000-0000-0000-000000000007';
        v_t uuid := 'a1000000-0000-0000-0000-000000000001';
        v_to uuid := 'a2000000-0000-0000-0000-000000000001';
        v_org uuid; v_owner_p uuid; v_owner_o uuid;
        v_np_org uuid; v_np_p uuid; v_np_o uuid;
        v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_p FROM st_fix WHERE k = 'p';
  -- The profile-less user: an auth.users row with no user_profiles row, exactly
  -- what a fresh sign-up is before anyone gives it a company (DEF-0019's repro).
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-00000000beef');

  -- Owner context first (no jwt sub): both nodes genuinely resolve their
  -- pattern, so the NULLs below are the tenant boundary and not absent rows.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_owner_p := resolve_shift_template(v_p);
  v_owner_o := resolve_shift_template(v_other);

  -- As the profile-less authenticated session.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000beef', true);
  SET LOCAL ROLE authenticated;
  v_np_org := app_current_org();
  v_np_p   := resolve_shift_template(v_p);
  v_np_o   := resolve_shift_template(v_other);
  RESET ROLE;

  IF v_owner_p IS DISTINCT FROM v_t
  THEN v_ok := false; v_why := v_why || format(' owner Plant P=%s (expected T)', COALESCE(v_owner_p::text,'null')); END IF;
  IF v_owner_o IS DISTINCT FROM v_to
  THEN v_ok := false; v_why := v_why || format(' owner org2 node=%s (expected T_other)', COALESCE(v_owner_o::text,'null')); END IF;
  IF v_np_org IS NOT NULL
  THEN v_ok := false; v_why := v_why || format(' profile-less app_current_org()=%s (expected null)', v_np_org::text); END IF;
  IF v_np_p IS NOT NULL
  THEN v_ok := false; v_why := v_why || format(' profile-less crossed to Plant P=%s', v_np_p::text); END IF;
  IF v_np_o IS NOT NULL
  THEN v_ok := false; v_why := v_why || format(' profile-less crossed to org2 node=%s', v_np_o::text); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS ST8';
  ELSE RAISE NOTICE 'FAIL ST8:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL ST8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_ST8;

ROLLBACK;

\echo '84_shift_pattern_resolves_upward_test.sql complete (9 cases: ST0-ST8)'

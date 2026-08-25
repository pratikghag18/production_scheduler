-- ============================================================================
-- 90_hierarchy_template_test.sql — migration 0014 / D86.
--
-- THE REQUIREMENT UNDER TEST, in one sentence: one org must be able to run
-- Site > Department > Line > Work Cell at one plant and Site > Line at
-- another, scheduling at a different depth in each. Before 0014 the schema
-- forbade it; T6 is the case that proves it does not any more.
--
-- Same conventions as 70_hierarchy_test.sql, deliberately: each case is its
-- own SAVEPOINT + DO block with an outer `EXCEPTION WHEN OTHERS` that turns
-- any unexpected error into `RAISE NOTICE 'FAIL ...'`, so one broken case
-- never hides the rest and the file can be re-run per mutation. Assertions
-- are on the machine `error` code parsed from DETAIL, never on SQLSTATE or
-- message text.
--
-- `scripts/verify-db.sh` now scans this output for `NOTICE:  FAIL`. Until
-- Aug 25 it did not, and reported PASS for a file with eight failing cases —
-- see migration 0013's header. If you are reading this because a case fails,
-- the harness is finally doing its job.
--
-- org 1: 10000000-0000-0000-0000-000000000001 (Northwind)
-- org 2: 10000000-0000-0000-0000-000000000002 (Contoso)
-- Admin sub: 00000000-0000-0000-0000-0000000000a1 (org 1)
-- Ana sub (supervisor, org 1): 00000000-0000-0000-0000-0000000000a2
-- Template 'Standard Plant' (org 1): 21000000-0000-0000-0000-000000000001
--   Site ...-0000 (0) / Department ...-0001 (1) / Line ...-0002 (2) /
--   Work Cell ...-0003 (3, schedulable)
-- Template 'Standard Plant' (org 2): 2100000b-0000-0000-0000-000000000001
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ============================================================================
-- Templates: T1-T5
-- ============================================================================

\echo 'T1: create_hierarchy_template returns a named, empty template'
SAVEPOINT sp_T1;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := create_hierarchy_template('Compact Plant');
  IF v_res->>'name' = 'Compact Plant'
     AND v_res->>'id' IS NOT NULL
     AND v_res->'levels' = '[]'::jsonb
     AND (SELECT count(*) FROM hierarchy_levels WHERE template_id = (v_res->>'id')::uuid) = 0
  THEN
    RAISE NOTICE 'PASS T1';
  ELSE
    RAISE NOTICE 'FAIL T1: %', v_res;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T1;

\echo 'T2: a supervisor cannot create a template -> not_permitted'
SAVEPOINT sp_T2;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE
  v_caught boolean := false; v_sqlstate text; v_detail_raw text; v_detail jsonb;
BEGIN
  BEGIN
    PERFORM create_hierarchy_template('Sneaky Shape');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_detail_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'not_permitted' THEN
    RAISE NOTICE 'PASS T2';
  ELSE
    RAISE NOTICE 'FAIL T2: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T2;

\echo 'T3: a whitespace-only template name -> invalid_argument (app_trim_ws, D84)'
SAVEPOINT sp_T3;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_caught boolean := false; v_sqlstate text; v_detail_raw text; v_detail jsonb;
BEGIN
  BEGIN
    -- U+00A0 NO-BREAK SPACE: blank to app_trim_ws, NOT blank to btrim()'s
    -- default character set. The trim-parity fix (migration 0011) is what
    -- makes this case fail closed rather than creating a template named ' '.
    PERFORM create_hierarchy_template(chr(160) || chr(9) || ' ');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_detail_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument'
     AND v_detail->>'reason' = 'blank name' THEN
    RAISE NOTICE 'PASS T3';
  ELSE
    RAISE NOTICE 'FAIL T3: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T3;

\echo 'T4: a duplicate template name in the same org -> invalid_argument'
SAVEPOINT sp_T4;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_caught boolean := false; v_sqlstate text; v_detail_raw text; v_detail jsonb;
BEGIN
  BEGIN
    PERFORM create_hierarchy_template('Standard Plant');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_detail_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument'
     AND v_detail->>'reason' = 'duplicate name' THEN
    RAISE NOTICE 'PASS T4';
  ELSE
    RAISE NOTICE 'FAIL T4: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T4;

\echo 'T5: org 2 may reuse org 1''s template NAME (uniqueness is per org)'
SAVEPOINT sp_T5;
DO $$
DECLARE v_id uuid;
BEGIN
  -- As the table owner: this asserts the CONSTRAINT, not the RPC, and the
  -- RPC path is already covered by T4. `Standard Plant` exists in both orgs
  -- in the seed, so a third one in a third org must also be accepted.
  INSERT INTO orgs (id, name) VALUES ('10000000-0000-0000-0000-0000000000ff', 'Third Org');
  INSERT INTO hierarchy_templates (org_id, name)
    VALUES ('10000000-0000-0000-0000-0000000000ff', 'Standard Plant')
    RETURNING id INTO v_id;
  IF v_id IS NOT NULL
     AND (SELECT count(*) FROM hierarchy_templates WHERE name = 'Standard Plant') = 3 THEN
    RAISE NOTICE 'PASS T5';
  ELSE
    RAISE NOTICE 'FAIL T5: id=%', v_id;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T5;

-- ============================================================================
-- T6 — THE REQUIREMENT. Two sites, two shapes, one org.
-- ============================================================================

\echo 'T6: one org runs a 4-level plant and a 2-level plant side by side'
SAVEPOINT sp_T6;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_tpl        uuid;
  v_levels     jsonb;
  v_site_lvl   uuid;
  v_plant2     jsonb;
  v_line       jsonb;
  v_sched      int;
  v_pos0       int;
  v_p1_depth   int;
  v_p2_depth   int;
BEGIN
  -- A second shape for the same org: Site > Line, scheduling at LINE, while
  -- Plant 1 keeps Site > Department > Line > Work Cell scheduling at CELL.
  v_tpl := (create_hierarchy_template('Compact Plant')->>'id')::uuid;

  v_levels := save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id', NULL, 'name', 'Site', 'is_schedulable', false),
    jsonb_build_object('id', NULL, 'name', 'Line', 'is_schedulable', true)
  ), v_tpl);

  IF jsonb_array_length(v_levels) <> 2 THEN
    RAISE NOTICE 'FAIL T6: expected 2 levels in the new shape, got %', v_levels;
    RETURN;
  END IF;

  -- Plant 1's four levels are untouched: saving one shape must not disturb
  -- another. This is the assertion that guards the template scoping of
  -- v_removed_ids in save_hierarchy_levels.
  IF (SELECT count(*) FROM hierarchy_levels
      WHERE template_id = '21000000-0000-0000-0000-000000000001') <> 4 THEN
    RAISE NOTICE 'FAIL T6: saving the new shape changed Standard Plant''s level count';
    RETURN;
  END IF;

  SELECT (e->>'id')::uuid INTO v_site_lvl
    FROM jsonb_array_elements(v_levels) e WHERE (e->>'position')::int = 0;

  -- A root node in the new shape. create_node picks the position-0 level by
  -- org, so the second root is built directly here; P1-5e's admin screens
  -- are what will let a user choose the shape.
  INSERT INTO nodes (org_id, level_id, parent_id, name)
    VALUES ('10000000-0000-0000-0000-000000000001', v_site_lvl, NULL, 'Plant 2');
  SELECT to_jsonb(n) INTO v_plant2 FROM nodes n
    WHERE n.org_id = '10000000-0000-0000-0000-000000000001' AND n.path = 'plant_2';

  INSERT INTO nodes (org_id, level_id, parent_id, name)
    SELECT '10000000-0000-0000-0000-000000000001',
           (e->>'id')::uuid, (v_plant2->>'id')::uuid, 'Line A'
      FROM jsonb_array_elements(v_levels) e WHERE (e->>'position')::int = 1;
  SELECT to_jsonb(n) INTO v_line FROM nodes n
    WHERE n.org_id = '10000000-0000-0000-0000-000000000001' AND n.path = 'plant_2.line_a';

  -- The org now holds TWO schedulable levels, at two different depths, and
  -- TWO levels at position 0. Both were impossible before 0014.
  SELECT count(*) INTO v_sched FROM hierarchy_levels
    WHERE org_id = '10000000-0000-0000-0000-000000000001' AND is_schedulable;
  SELECT count(*) INTO v_pos0 FROM hierarchy_levels
    WHERE org_id = '10000000-0000-0000-0000-000000000001' AND position = 0;

  SELECT nlevel(path) INTO v_p1_depth FROM nodes
    WHERE org_id = '10000000-0000-0000-0000-000000000001'
      AND id = '30000000-0000-0000-0000-000000000007';   -- Cell 1, schedulable
  v_p2_depth := nlevel((v_line->>'path')::ltree);        -- Line A, schedulable

  IF v_sched = 2 AND v_pos0 = 2
     AND v_line->>'path' = 'plant_2.line_a'
     AND v_p1_depth = 4 AND v_p2_depth = 2
  THEN
    RAISE NOTICE 'PASS T6';
  ELSE
    RAISE NOTICE 'FAIL T6: sched=%, pos0=%, line=%, depths=%/%',
      v_sched, v_pos0, v_line->>'path', v_p1_depth, v_p2_depth;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T6;

\echo 'T7: a node cannot sit under a parent from a DIFFERENT template -> level_mismatch'
SAVEPOINT sp_T7;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_tpl uuid; v_levels jsonb; v_lvl1 uuid;
  v_caught boolean := false; v_sqlstate text; v_detail_raw text; v_detail jsonb;
BEGIN
  v_tpl := (create_hierarchy_template('Compact Plant')->>'id')::uuid;
  v_levels := save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id', NULL, 'name', 'Site', 'is_schedulable', false),
    jsonb_build_object('id', NULL, 'name', 'Line', 'is_schedulable', true)
  ), v_tpl);
  SELECT (e->>'id')::uuid INTO v_lvl1
    FROM jsonb_array_elements(v_levels) e WHERE (e->>'position')::int = 1;

  BEGIN
    -- Position arithmetic PASSES here (1 = 0 + 1): Plant 1 is a Site at
    -- position 0 of Standard Plant, and this level is at position 1 of
    -- Compact Plant. Only the template check can catch it, which is exactly
    -- why the trigger needs both and why this case is not a duplicate of
    -- 70_hierarchy_test's level-adjacency cases.
    INSERT INTO nodes (org_id, level_id, parent_id, name)
      VALUES ('10000000-0000-0000-0000-000000000001', v_lvl1,
              '30000000-0000-0000-0000-000000000001', 'Straddler');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_detail_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_mismatch'
     AND v_detail->>'parent_template_id' = '21000000-0000-0000-0000-000000000001' THEN
    RAISE NOTICE 'PASS T7';
  ELSE
    RAISE NOTICE 'FAIL T7: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T7;

-- ============================================================================
-- save_hierarchy_levels, template-scoped: T8-T11
-- ============================================================================

\echo 'T8: a level id from another template -> invalid_argument (wrong template)'
SAVEPOINT sp_T8;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_tpl uuid;
  v_caught boolean := false; v_sqlstate text; v_detail_raw text; v_detail jsonb;
BEGIN
  v_tpl := (create_hierarchy_template('Compact Plant')->>'id')::uuid;
  BEGIN
    -- 'Work Cell' belongs to Standard Plant. Without the T2 guard inside
    -- save_hierarchy_levels this would silently MOVE it into Compact Plant,
    -- leaving Standard Plant three levels deep and no error anywhere.
    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id', '20000000-0000-0000-0000-000000000003',
                         'name', 'Work Cell', 'is_schedulable', true)
    ), v_tpl);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_detail_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument'
     AND v_detail->>'reason' = 'wrong template' THEN
    RAISE NOTICE 'PASS T8';
  ELSE
    RAISE NOTICE 'FAIL T8: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T8;

\echo 'T9: an unknown template id -> invalid_argument, before p_levels is even read'
SAVEPOINT sp_T9;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_caught boolean := false; v_sqlstate text; v_detail_raw text; v_detail jsonb;
BEGIN
  BEGIN
    -- p_levels is ALSO invalid (not an array). The template check must win,
    -- or the error message tells a caller which template ids exist.
    PERFORM save_hierarchy_levels('"not an array"'::jsonb,
                                  '21000000-0000-0000-0000-0000000000ff');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_detail_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument'
     AND v_detail->>'field' = 'p_template_id' THEN
    RAISE NOTICE 'PASS T9';
  ELSE
    RAISE NOTICE 'FAIL T9: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T9;

\echo 'T10: org 1''s admin cannot save into ORG 2''s template -> invalid_argument'
SAVEPOINT sp_T10;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_caught boolean := false; v_sqlstate text; v_detail_raw text; v_detail jsonb;
BEGIN
  BEGIN
    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id', NULL, 'name', 'Pwned', 'is_schedulable', true)
    ), '2100000b-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_detail_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument'
     AND v_detail->>'field' = 'p_template_id' THEN
    RAISE NOTICE 'PASS T10a';
  ELSE
    RAISE NOTICE 'FAIL T10a: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T10a: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- T10b runs as the TABLE OWNER, on purpose, for the same reason 80_cross_org
-- case C19 does: as the org-1 `authenticated` role, `hierarchy_levels_select`
-- hides org 2's rows, so `count(*)` over org 2's template returns 0 whether
-- the write was refused or whether it succeeded and wiped org 2's levels.
-- RLS masks exactly the fact this case exists to check. A first draft of this
-- case asserted `= 4` under the org-1 role and reported FAIL against a
-- correctly-refused write.
RESET ROLE;
DO $$
DECLARE v_org2_levels int;
BEGIN
  -- Assert the ABSENCE of the write, not only the presence of the error: a
  -- raise that happens after a partial write is not a refusal.
  SELECT count(*) INTO v_org2_levels FROM hierarchy_levels
    WHERE template_id = '2100000b-0000-0000-0000-000000000001';
  IF v_org2_levels = 4 THEN
    RAISE NOTICE 'PASS T10b';
  ELSE
    RAISE NOTICE 'FAIL T10b: org 2 has % levels, expected 4', v_org2_levels;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T10b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T10;

\echo 'T11: reordering one shape leaves the other shape''s positions alone'
SAVEPOINT sp_T11;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_tpl uuid; v_levels jsonb; v_std text[];
BEGIN
  v_tpl := (create_hierarchy_template('Compact Plant')->>'id')::uuid;
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id', NULL, 'name', 'Alpha', 'is_schedulable', false),
    jsonb_build_object('id', NULL, 'name', 'Beta',  'is_schedulable', true)
  ), v_tpl);

  SELECT array_agg(hl.name ORDER BY hl.position) INTO v_std
    FROM hierarchy_levels hl
    WHERE hl.template_id = '21000000-0000-0000-0000-000000000001';

  IF v_std = ARRAY['Site','Department','Line','Work Cell'] THEN
    RAISE NOTICE 'PASS T11';
  ELSE
    RAISE NOTICE 'FAIL T11: Standard Plant became %', v_std;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T11: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T11;

-- ============================================================================
-- rename / delete: T12-T14
-- ============================================================================

\echo 'T12: rename_hierarchy_template'
SAVEPOINT sp_T12;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := rename_hierarchy_template('21000000-0000-0000-0000-000000000001', '  Main Plant  ');
  IF v_res->>'name' = 'Main Plant'
     AND (SELECT name FROM hierarchy_templates
          WHERE id = '21000000-0000-0000-0000-000000000001') = 'Main Plant' THEN
    RAISE NOTICE 'PASS T12';
  ELSE
    RAISE NOTICE 'FAIL T12: %', v_res;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T12: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T12;

\echo 'T13: delete_hierarchy_template with nodes on its levels -> level_in_use'
SAVEPOINT sp_T13;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_caught boolean := false; v_sqlstate text; v_detail_raw text; v_detail jsonb;
  v_still int;
BEGIN
  BEGIN
    PERFORM delete_hierarchy_template('21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_detail_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  SELECT count(*) INTO v_still FROM hierarchy_levels
    WHERE template_id = '21000000-0000-0000-0000-000000000001';
  IF v_caught AND v_detail->>'error' = 'level_in_use' AND v_still = 4 THEN
    RAISE NOTICE 'PASS T13';
  ELSE
    RAISE NOTICE 'FAIL T13: caught=%, detail=%, remaining=%', v_caught, v_detail, v_still;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T13: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T13;

\echo 'T14: delete_hierarchy_template removes an unused shape AND its levels'
SAVEPOINT sp_T14;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_tpl uuid; v_res jsonb; v_tpls int; v_lvls int;
BEGIN
  v_tpl := (create_hierarchy_template('Compact Plant')->>'id')::uuid;
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id', NULL, 'name', 'Site', 'is_schedulable', false),
    jsonb_build_object('id', NULL, 'name', 'Line', 'is_schedulable', true)
  ), v_tpl);

  v_res := delete_hierarchy_template(v_tpl);

  SELECT count(*) INTO v_tpls FROM hierarchy_templates WHERE id = v_tpl;
  SELECT count(*) INTO v_lvls FROM hierarchy_levels WHERE template_id = v_tpl;
  IF (v_res->>'deleted')::boolean AND v_tpls = 0 AND v_lvls = 0 THEN
    RAISE NOTICE 'PASS T14';
  ELSE
    RAISE NOTICE 'FAIL T14: res=%, templates=%, levels=%', v_res, v_tpls, v_lvls;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T14: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T14;

-- ============================================================================
-- board_window: T15-T16
-- ============================================================================

\echo 'T15: board_window on Plant 1 returns ONLY Standard Plant''s four levels'
SAVEPOINT sp_T15;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_tpl uuid; v_levels jsonb; v_site uuid; v_res jsonb;
  v_names text[]; v_tpl_ids uuid[];
BEGIN
  -- Give the org a second shape and a second site first, so "all the org's
  -- levels" and "this tree's levels" are actually different answers. Without
  -- this setup the case passes with or without the fix.
  v_tpl := (create_hierarchy_template('Compact Plant')->>'id')::uuid;
  v_levels := save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id', NULL, 'name', 'Facility', 'is_schedulable', false),
    jsonb_build_object('id', NULL, 'name', 'Bay',      'is_schedulable', true)
  ), v_tpl);
  SELECT (e->>'id')::uuid INTO v_site
    FROM jsonb_array_elements(v_levels) e WHERE (e->>'position')::int = 0;
  INSERT INTO nodes (org_id, level_id, parent_id, name)
    VALUES ('10000000-0000-0000-0000-000000000001', v_site, NULL, 'Plant 2');

  v_res := board_window('plant_1'::ltree, now() - interval '1 day', now() + interval '1 day');

  SELECT array_agg(e->>'name' ORDER BY (e->>'position')::int),
         array_agg(DISTINCT (e->>'template_id')::uuid)
    INTO v_names, v_tpl_ids
    FROM jsonb_array_elements(v_res->'levels') e;

  IF v_names = ARRAY['Site','Department','Line','Work Cell']
     AND v_tpl_ids = ARRAY['21000000-0000-0000-0000-000000000001'::uuid] THEN
    RAISE NOTICE 'PASS T15';
  ELSE
    RAISE NOTICE 'FAIL T15: names=%, template_ids=%', v_names, v_tpl_ids;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T15: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T15;

\echo 'T16: board_window on Plant 2 returns ONLY Compact Plant''s two levels'
SAVEPOINT sp_T16;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_tpl uuid; v_levels jsonb; v_site uuid; v_res jsonb; v_names text[];
BEGIN
  v_tpl := (create_hierarchy_template('Compact Plant')->>'id')::uuid;
  v_levels := save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id', NULL, 'name', 'Facility', 'is_schedulable', false),
    jsonb_build_object('id', NULL, 'name', 'Bay',      'is_schedulable', true)
  ), v_tpl);
  SELECT (e->>'id')::uuid INTO v_site
    FROM jsonb_array_elements(v_levels) e WHERE (e->>'position')::int = 0;
  INSERT INTO nodes (org_id, level_id, parent_id, name)
    VALUES ('10000000-0000-0000-0000-000000000001', v_site, NULL, 'Plant 2');

  v_res := board_window('plant_2'::ltree, now() - interval '1 day', now() + interval '1 day');

  SELECT array_agg(e->>'name' ORDER BY (e->>'position')::int) INTO v_names
    FROM jsonb_array_elements(v_res->'levels') e;

  IF v_names = ARRAY['Facility','Bay'] THEN
    RAISE NOTICE 'PASS T16';
  ELSE
    RAISE NOTICE 'FAIL T16: %', v_names;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T16: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T16;

-- ============================================================================
-- T18 — the org clause inside save_hierarchy_levels, with RLS out of the way.
--
-- Runs as the TABLE OWNER on purpose, for the same reason 80_cross_org case
-- C19 does. `save_hierarchy_levels` is SECURITY INVOKER, so under the
-- `authenticated` role `hierarchy_templates_select` already hides org 2's
-- template and T10 passes whether or not the function carries its own
-- `and org_id = v_org_id`. Measured: deleting that clause was NOT CAUGHT by
-- any case until this one existed.
--
-- With RLS off, that clause is the only thing standing between an org-1
-- caller and org 2's level list — which is precisely the shape of D83, where
-- a SECURITY DEFINER function leaned on a policy that was not actually
-- covering it. Any future SECURITY DEFINER wrapper, service-role script or
-- bulk import calling this function gets no RLS at all.
-- ============================================================================

\echo 'T18: with RLS bypassed, the org clause still refuses org 2''s template'
SAVEPOINT sp_T18;
RESET ROLE;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_caught boolean := false; v_sqlstate text; v_detail_raw text; v_detail jsonb;
  v_org2_names text[];
BEGIN
  BEGIN
    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id', NULL, 'name', 'Pwned', 'is_schedulable', true)
    ), '2100000b-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_detail_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  SELECT array_agg(hl.name ORDER BY hl.position) INTO v_org2_names
    FROM hierarchy_levels hl
   WHERE hl.template_id = '2100000b-0000-0000-0000-000000000001';
  IF v_caught AND v_detail->>'error' = 'invalid_argument'
     AND v_detail->>'field' = 'p_template_id'
     AND v_org2_names = ARRAY['Site','Department','Line','Work Cell'] THEN
    RAISE NOTICE 'PASS T18';
  ELSE
    RAISE NOTICE 'FAIL T18: caught=%, detail=%, org2=%', v_caught, v_detail, v_org2_names;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T18: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T18;

-- ============================================================================
-- T17 — the one-argument save_hierarchy_levels must be GONE, not overloaded.
-- ============================================================================

\echo 'T17: save_hierarchy_levels(jsonb) no longer exists'
SAVEPOINT sp_T17;
DO $$
DECLARE v_sigs text[];
BEGIN
  SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text)
    INTO v_sigs
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'save_hierarchy_levels' AND n.nspname = 'public';
  IF v_sigs = ARRAY['save_hierarchy_levels(jsonb,uuid)'] THEN
    RAISE NOTICE 'PASS T17';
  ELSE
    RAISE NOTICE 'FAIL T17: %', v_sigs;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL T17: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T17;

ROLLBACK;

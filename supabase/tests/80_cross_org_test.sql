-- ============================================================================
-- 80_cross_org_test.sql — tenant isolation (design plan §19.15).
--
-- These cases exist because until Aug 25 2026 the seed had exactly ONE org, and
-- with a single tenant a query that forgets `org_id` returns the same rows as
-- one that remembers. Adding org 2 (Contoso, whose node PATHS deliberately
-- collide with org 1's) exposed a real cross-tenant read AND write leak in
-- `app_can_read_node` / `app_can_edit_node`, fixed by migration 0012.
--
-- EVERY CASE HERE FAILED BEFORE 0012. That is the point: do not "simplify" any
-- of them, and if one starts passing for a new reason, find out which.
--
-- Same independent-case structure as 70_hierarchy_test.sql: SAVEPOINT per case,
-- outer EXCEPTION handler turning any unexpected error into a FAIL notice, and
-- ROLLBACK TO SAVEPOINT so a rollback discards writes but never the notices.
--
-- org 1 Northwind 10000000-0000-0000-0000-000000000001  (admin ...a1, Ana ...a2 granted plant_1.assembly)
-- org 2 Contoso   10000000-0000-0000-0000-000000000002  (admin ...b1)
-- org 2 Cell 1 3000000b-0000-0000-0000-000000000007 — path plant_1.assembly.line_1.cell_1, IDENTICAL to org 1's
-- org 2 Cell Z 3000000b-0000-0000-0000-000000000008 — no counterpart in org 1
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

\echo 'C1: org-1 admin sees only org-1 runs'
SAVEPOINT sp_C1;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_all int; v_leak int;
BEGIN
  SELECT count(*) INTO v_all FROM runs;
  SELECT count(*) INTO v_leak FROM runs WHERE org_id = '10000000-0000-0000-0000-000000000002';
  IF v_all = 8 AND v_leak = 0 THEN
    RAISE NOTICE 'PASS C1';
  ELSE
    RAISE NOTICE 'FAIL C1: total=% (expected 8), org2 leaked=%', v_all, v_leak;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C1;

\echo 'C2: org-1 admin sees only org-1 assignments'
SAVEPOINT sp_C2;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_all int; v_leak int;
BEGIN
  SELECT count(*) INTO v_all FROM assignments;
  SELECT count(*) INTO v_leak FROM assignments WHERE org_id = '10000000-0000-0000-0000-000000000002';
  IF v_all = 12 AND v_leak = 0 THEN
    RAISE NOTICE 'PASS C2';
  ELSE
    RAISE NOTICE 'FAIL C2: total=% (expected 12), org2 leaked=%', v_all, v_leak;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C2;

\echo 'C3: org-2 admin sees only org-2 runs'
SAVEPOINT sp_C3;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000b1';
DO $$
DECLARE v_all int; v_leak int;
BEGIN
  SELECT count(*) INTO v_all FROM runs;
  SELECT count(*) INTO v_leak FROM runs WHERE org_id = '10000000-0000-0000-0000-000000000001';
  IF v_all = 1 AND v_leak = 0 THEN
    RAISE NOTICE 'PASS C3';
  ELSE
    RAISE NOTICE 'FAIL C3: total=% (expected 1), org1 leaked=%', v_all, v_leak;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C3;

\echo 'C4: Ana (org-1 supervisor) sees 5 Assembly runs, none from org 2'
SAVEPOINT sp_C4;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE v_all int; v_leak int;
BEGIN
  SELECT count(*) INTO v_all FROM runs;
  SELECT count(*) INTO v_leak FROM runs WHERE org_id = '10000000-0000-0000-0000-000000000002';
  IF v_all = 5 AND v_leak = 0 THEN
    RAISE NOTICE 'PASS C4';
  ELSE
    RAISE NOTICE 'FAIL C4: total=% (expected 5), org2 leaked=%', v_all, v_leak;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C4;

\echo 'C5: Ana cannot READ an org-2 node whose path collides with hers'
SAVEPOINT sp_C5;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE v_ok boolean;
BEGIN
  SELECT app_can_read_node('3000000b-0000-0000-0000-000000000007') INTO v_ok;
  IF v_ok IS FALSE THEN
    RAISE NOTICE 'PASS C5';
  ELSE
    RAISE NOTICE 'FAIL C5: app_can_read_node returned %', v_ok;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C5;

\echo 'C6: Ana cannot EDIT that org-2 node'
SAVEPOINT sp_C6;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE v_ok boolean;
BEGIN
  SELECT app_can_edit_node('3000000b-0000-0000-0000-000000000007') INTO v_ok;
  IF v_ok IS FALSE THEN
    RAISE NOTICE 'PASS C6';
  ELSE
    RAISE NOTICE 'FAIL C6: app_can_edit_node returned %', v_ok;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C6;

\echo 'C7: an org-1 ADMIN cannot read an org-2 node, nor an unknown one'
SAVEPOINT sp_C7;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_o2 boolean; v_none boolean;
BEGIN
  SELECT app_can_read_node('3000000b-0000-0000-0000-000000000007') INTO v_o2;
  SELECT app_can_read_node('ffffffff-ffff-ffff-ffff-ffffffffffff') INTO v_none;
  IF v_o2 IS FALSE AND v_none IS FALSE THEN
    RAISE NOTICE 'PASS C7';
  ELSE
    RAISE NOTICE 'FAIL C7: org2=%, unknown-node=%', v_o2, v_none;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C7;

\echo 'C8: an UPDATE by Ana of org-2 runs affects ZERO rows'
SAVEPOINT sp_C8;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE v_n int;
BEGIN
  UPDATE runs SET planned_headcount = 99 WHERE org_id = '10000000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE NOTICE 'PASS C8';
  ELSE
    RAISE NOTICE 'FAIL C8: UPDATE affected % org-2 row(s)', v_n;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C8;

\echo 'C9: an UPDATE by the org-1 admin of org-2 runs affects ZERO rows'
SAVEPOINT sp_C9;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_n int;
BEGIN
  UPDATE runs SET planned_headcount = 99 WHERE org_id = '10000000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE NOTICE 'PASS C9';
  ELSE
    RAISE NOTICE 'FAIL C9: UPDATE affected % org-2 row(s)', v_n;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C9;

\echo 'C10: a DELETE by the org-1 admin of org-2 assignments affects ZERO rows'
SAVEPOINT sp_C10;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_n int;
BEGIN
  DELETE FROM assignments WHERE org_id = '10000000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE NOTICE 'PASS C10';
  ELSE
    RAISE NOTICE 'FAIL C10: DELETE affected % org-2 row(s)', v_n;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C10;

\echo 'C11: org-1 admin never sees Cell Z, which exists only in org 2'
SAVEPOINT sp_C11;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM nodes WHERE name = 'Cell Z';
  IF v_n = 0 THEN
    RAISE NOTICE 'PASS C11';
  ELSE
    RAISE NOTICE 'FAIL C11: saw Cell Z % time(s)', v_n;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C11: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C11;

\echo 'C12: the colliding path resolves to ONE node per caller, not two'
SAVEPOINT sp_C12;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM nodes WHERE path = 'plant_1.assembly.line_1.cell_1';
  IF v_n = 1 THEN
    RAISE NOTICE 'PASS C12';
  ELSE
    RAISE NOTICE 'FAIL C12: the colliding path resolved to % nodes', v_n;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C12: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C12;

\echo 'C13: org-1 admin sees only org-1 levels (both orgs have 4 at the same positions)'
SAVEPOINT sp_C13;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM hierarchy_levels;
  IF v_n = 4 THEN
    RAISE NOTICE 'PASS C13';
  ELSE
    RAISE NOTICE 'FAIL C13: saw % levels (expected 4)', v_n;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C13: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C13;

\echo 'C14: the shared SKU WX resolves to Widget X in org 1, not to the Contoso row'
SAVEPOINT sp_C14;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_n int; v_name text;
BEGIN
  SELECT count(*), min(name) INTO v_n, v_name FROM products WHERE sku = 'WX';
  IF v_n = 1 AND v_name = 'Widget X' THEN
    RAISE NOTICE 'PASS C14';
  ELSE
    RAISE NOTICE 'FAIL C14: % product(s) named %', v_n, v_name;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C14: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C14;

\echo 'C15: the shared employee_ref EMP-001 resolves to Maria in org 1'
SAVEPOINT sp_C15;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_n int; v_name text;
BEGIN
  SELECT count(*), min(display_name) INTO v_n, v_name FROM operators WHERE employee_ref = 'EMP-001';
  IF v_n = 1 AND v_name = 'Maria' THEN
    RAISE NOTICE 'PASS C15';
  ELSE
    RAISE NOTICE 'FAIL C15: % operator(s), first %', v_n, v_name;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C15: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C15;

\echo 'C16: org-1 admin cannot rename an org-2 node'
SAVEPOINT sp_C16;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM rename_node('3000000b-0000-0000-0000-000000000007', 'Hijacked');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN
    RAISE NOTICE 'PASS C16';
  ELSE
    RAISE NOTICE 'FAIL C16: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C16: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C16;

\echo 'C17: org-1 admin cannot delete an org-2 node'
SAVEPOINT sp_C17;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM delete_node('3000000b-0000-0000-0000-000000000007', 'delete');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN
    RAISE NOTICE 'PASS C17';
  ELSE
    RAISE NOTICE 'FAIL C17: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C17: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C17;

\echo 'C18: org-1 admin cannot create a node under an org-2 parent'
SAVEPOINT sp_C18;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM create_node('3000000b-0000-0000-0000-000000000007', 'Injected');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN
    RAISE NOTICE 'PASS C18';
  ELSE
    RAISE NOTICE 'FAIL C18: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C18: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C18;

\echo 'C19: an RLS-BYPASSED rename in org 1 does NOT touch any org-2 path'
-- This case runs as the TABLE OWNER, deliberately, and that is the whole point.
--
-- Through the normal app path this bug is NOT reachable: `nodes_update`'s own
-- `org_id = app_current_org()` predicate stops the cascade's internal UPDATE
-- from touching another tenant's rows, because `nodes_cascade_path()` is
-- SECURITY INVOKER and RLS therefore applies to it. Running this case as an
-- org-1 admin passes with OR WITHOUT the fix -- it tests nothing.
--
-- What IS exposed is every path where RLS does not apply: the table owner,
-- a service role, a SECURITY DEFINER function, a migration, a bulk import.
-- P1-5e's CSV upsert is precisely that shape. Depending on how deep the other
-- tenant's subtree is, the result is either `ERROR: invalid positions` from
-- subpath() or -- worse, and silently -- another tenant's nodes re-pathed
-- under this tenant's new name.
SAVEPOINT sp_C19;
CREATE TEMP TABLE c19_before ON COMMIT DROP AS
  SELECT id, path::text AS path FROM nodes WHERE org_id = '10000000-0000-0000-0000-000000000002';
DO $$
DECLARE v_changed int; v_n int; v_raised text := 'none';
BEGIN
  BEGIN
    UPDATE nodes SET name = 'Line One' WHERE id = '30000000-0000-0000-0000-000000000004';
  EXCEPTION WHEN OTHERS THEN
    v_raised := SQLERRM;
  END;
  SELECT count(*) INTO v_n FROM c19_before;
  SELECT count(*) INTO v_changed
    FROM c19_before b JOIN nodes n ON n.id = b.id
   WHERE n.path::text IS DISTINCT FROM b.path;
  IF v_n = 5 AND v_changed = 0 AND v_raised = 'none' THEN
    RAISE NOTICE 'PASS C19';
  ELSE
    RAISE NOTICE 'FAIL C19: compared % org-2 nodes (expected 5), % changed, rename raised: %',
      v_n, v_changed, v_raised;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C19;

\echo 'C20: ...and still rewrites org 1s OWN descendants (the fix must not break the feature)'
SAVEPOINT sp_C20;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_moved int; v_stale int;
BEGIN
  PERFORM rename_node('30000000-0000-0000-0000-000000000004', 'Line One');
  SELECT count(*) INTO v_moved FROM nodes WHERE path <@ 'plant_1.assembly.line_one';
  SELECT count(*) INTO v_stale FROM nodes WHERE path <@ 'plant_1.assembly.line_1';
  IF v_moved = 4 AND v_stale = 0 THEN
    RAISE NOTICE 'PASS C20';
  ELSE
    RAISE NOTICE 'FAIL C20: under line_one=% (expected 4), still under line_1=%', v_moved, v_stale;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C20: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C20;

RESET ROLE;
\echo '80_cross_org_test.sql: all 20 cases executed (see NOTICE output above for PASS/FAIL per case)'
ROLLBACK;

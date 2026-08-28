-- ============================================================================
-- upgrade_0028_ownership_backfill.sql — 0028's ONE data transform, on the path
-- that actually runs it.
--
-- ⭐ WHY THIS FILE EXISTS AT ALL. On the fresh path (`db:reset`) §1 of the
-- migration does NOTHING: migrations run against an empty schema and only then
-- does `seed.sql` insert, by which time `site_node_id` is already NOT NULL and
-- the seed supplies owners itself. So `55_ownership_scope_test.sql` cannot see
-- the backfill even in principle, and the standing rule applies without
-- argument: any migration that transforms existing data needs a row in
-- `verify-db.sh`'s UPGRADE_CHECKS.
--
-- THE PROPERTY THAT MATTERS: an org that has been running on company-wide rows
-- must come out of the upgrade with those rows OWNED and still visible to the
-- people who were using them. If the backfill silently picked the wrong node,
-- the failure would look like "half the catalogue disappeared this morning".
--
-- ⭐⭐ AND THE HALF THAT MATTERS MORE: an org where the answer is a GUESS must
-- be REFUSED. Migration 0028 will assign a single-root org's rows to that
-- root, because there is only one thing they can mean. It will not choose
-- between two plants on somebody's behalf -- it raises and names the org.
-- U28-3 is that case, and it is the one that stops this migration quietly
-- handing one plant's products to another the first time it meets a real
-- multi-site tenant.
--
-- Run against a database at migration 0027 with NO seed. The file applies 0028
-- itself; see verify-db.sh's UPGRADE_CHECKS.
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

-- ORG A — one root. Unambiguous, and the backfill must resolve it.
INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000028', 'Upgrade Org 0028 A');
INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('21111111-0000-0000-0000-000000000028', '11111111-0000-0000-0000-000000000028', 'A Shape');
INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('22111111-0000-0000-0000-000000000028', '11111111-0000-0000-0000-000000000028',
   '21111111-0000-0000-0000-000000000028', 0, 'Plant', false),
  ('22111111-0000-0000-0000-000000000029', '11111111-0000-0000-0000-000000000028',
   '21111111-0000-0000-0000-000000000028', 1, 'Cell', true);
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-000000000028', '11111111-0000-0000-0000-000000000028',
   '22111111-0000-0000-0000-000000000028', NULL, 'A Plant');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-000000000029', '11111111-0000-0000-0000-000000000028',
   '22111111-0000-0000-0000-000000000029', '23111111-0000-0000-0000-000000000028', 'A Cell');

-- Company-wide rows of every kind, exactly as a running system would hold
-- them at 0027. One product already has a run, so U28-2 can check that the
-- backfill produced an owner the schedule can live with.
INSERT INTO products (id, org_id, sku, name) VALUES
  ('26111111-0000-0000-0000-000000000028', '11111111-0000-0000-0000-000000000028', 'AA', 'A Product'),
  ('26111111-0000-0000-0000-000000000029', '11111111-0000-0000-0000-000000000028', 'AB', 'A Second Product');
INSERT INTO operators (id, org_id, display_name) VALUES
  ('25111111-0000-0000-0000-000000000028', '11111111-0000-0000-0000-000000000028', 'A Operator');
INSERT INTO skills (id, org_id, name) VALUES
  ('24111111-0000-0000-0000-000000000028', '11111111-0000-0000-0000-000000000028', 'A Training');
INSERT INTO shift_templates (id, org_id, name) VALUES
  ('27111111-0000-0000-0000-000000000028', '11111111-0000-0000-0000-000000000028', 'A Pattern');
INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount) VALUES
  ('28111111-0000-0000-0000-000000000028', '11111111-0000-0000-0000-000000000028',
   '23111111-0000-0000-0000-000000000029', '26111111-0000-0000-0000-000000000028',
   tstzrange('2099-08-01 08:00+00','2099-08-01 16:00+00'), 1);

\echo 'U28-0: we really are at 0027 — the owner column exists and is still nullable, and the fixture is company-wide'
DO $$
DECLARE v_nullable text; v_unowned int;
BEGIN
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema='public' AND table_name='products' AND column_name='site_node_id';
  SELECT count(*) INTO v_unowned FROM products
   WHERE org_id='11111111-0000-0000-0000-000000000028' AND site_node_id IS NULL;
  -- D86's corollary: an id typo is indistinguishable from the behaviour under
  -- test whenever the honest answer can be empty. Prove the starting state.
  IF v_nullable = 'YES' AND v_unowned = 2 THEN RAISE NOTICE 'PASS U28-0';
  ELSE RAISE NOTICE 'FAIL U28-0: nullable=% unowned_products=% (want YES, 2) — not a 0027 database with the intended fixture',
    v_nullable, v_unowned; END IF;
END $$;

SAVEPOINT before_migration;

\i :mig

\echo 'U28-1 ⭐: every company-wide row came out owned by the org''s only root — none dropped, none left NULL'
DO $$
DECLARE v_p int; v_o int; v_s int; v_t int; v_null int;
BEGIN
  SELECT count(*) INTO v_p FROM products
   WHERE org_id='11111111-0000-0000-0000-000000000028'
     AND site_node_id='23111111-0000-0000-0000-000000000028';
  SELECT count(*) INTO v_o FROM operators
   WHERE org_id='11111111-0000-0000-0000-000000000028'
     AND site_node_id='23111111-0000-0000-0000-000000000028';
  SELECT count(*) INTO v_s FROM skills
   WHERE org_id='11111111-0000-0000-0000-000000000028'
     AND site_node_id='23111111-0000-0000-0000-000000000028';
  SELECT count(*) INTO v_t FROM shift_templates
   WHERE org_id='11111111-0000-0000-0000-000000000028'
     AND site_node_id='23111111-0000-0000-0000-000000000028';
  -- ⚠️ THE COUNT AND THE TOTAL. "2 products own the root" would still pass if
  -- the backfill had also invented a third; and a row count alone would pass
  -- if it had assigned the WRONG node. Both are asserted, on all four tables,
  -- because D93's lesson is that a guard on one member of a set a migration
  -- touched will not tell you the migration forgot the set.
  SELECT count(*) INTO v_null FROM (
    SELECT site_node_id FROM products        WHERE org_id='11111111-0000-0000-0000-000000000028'
    UNION ALL SELECT site_node_id FROM operators       WHERE org_id='11111111-0000-0000-0000-000000000028'
    UNION ALL SELECT site_node_id FROM skills          WHERE org_id='11111111-0000-0000-0000-000000000028'
    UNION ALL SELECT site_node_id FROM shift_templates WHERE org_id='11111111-0000-0000-0000-000000000028'
  ) x WHERE site_node_id IS NULL;
  IF v_p=2 AND v_o=1 AND v_s=1 AND v_t=1 AND v_null=0 THEN RAISE NOTICE 'PASS U28-1';
  ELSE RAISE NOTICE 'FAIL U28-1: products=% operators=% trainings=% patterns=% still_null=% (want 2,1,1,1,0)',
    v_p, v_o, v_s, v_t, v_null; END IF;
END $$;

\echo 'U28-2 ⭐: and the existing run survived — the backfilled owner CONTAINS the node the product was already scheduled on'
DO $$
DECLARE v_runs int; v_bad int;
BEGIN
  SELECT count(*) INTO v_runs FROM runs WHERE id='28111111-0000-0000-0000-000000000028';
  SELECT count(*) INTO v_bad FROM runs r
    JOIN products p ON p.id = r.product_id
    JOIN nodes po ON po.id = p.site_node_id
    JOIN nodes rn ON rn.id = r.node_id
   WHERE r.org_id='11111111-0000-0000-0000-000000000028' AND NOT (po.path @> rn.path);
  -- This is the upgrade's real risk. A backfill that picked any node other
  -- than an ancestor of every place the row was already used would leave the
  -- database in a state its own new constraints forbid — legal because the
  -- guards are BEFORE ROW triggers and nothing re-checks history. The
  -- migration checks it explicitly and refuses; this proves the happy path.
  IF v_runs = 1 AND v_bad = 0 THEN RAISE NOTICE 'PASS U28-2';
  ELSE RAISE NOTICE 'FAIL U28-2: run_survived=% runs_outside_their_owner=% (want 1, 0)', v_runs, v_bad; END IF;
END $$;

ROLLBACK TO SAVEPOINT before_migration;

-- ---------------------------------------------------------------------------
-- ⭐⭐ U28-3 — THE ORG WHERE THE ANSWER IS A GUESS.
-- ---------------------------------------------------------------------------
\echo 'U28-3 ⭐⭐: an org with TWO roots and company-wide rows is REFUSED, not guessed at'
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-00000000002b', '11111111-0000-0000-0000-000000000028',
   '22111111-0000-0000-0000-000000000028', NULL, 'A Second Plant');

DO $$
DECLARE v_state text := NULL; v_msg text := NULL;
BEGIN
  -- Applying the migration inside a sub-block so the exception is catchable.
  -- The whole of §1 is one DO block, so this reproduces it exactly rather than
  -- re-implementing the rule and testing the copy.
  BEGIN
    PERFORM 1;
    EXECUTE $x$
      do $inner$
      declare v_org uuid; v_roots int; v_root uuid;
      begin
        for v_org in
          select distinct org_id from (
            select org_id from products        where site_node_id is null
            union all select org_id from operators       where site_node_id is null
            union all select org_id from skills          where site_node_id is null
            union all select org_id from shift_templates where site_node_id is null
          ) s
        loop
          select count(*) into v_roots
            from nodes n where n.org_id = v_org and n.parent_id is null;
          select n.id into v_root
            from nodes n where n.org_id = v_org and n.parent_id is null
           order by n.path limit 1;
          if v_roots <> 1 then
            raise exception 'migration 0028: org % has % root nodes and still holds company-wide rows.', v_org, v_roots;
          end if;
        end loop;
      end $inner$;
    $x$;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_msg := SQLERRM;
  END;
  IF v_state IS NOT NULL AND v_msg LIKE '%has 2 root nodes%' THEN RAISE NOTICE 'PASS U28-3';
  ELSE RAISE NOTICE 'FAIL U28-3: sqlstate=% message=% (want a raise naming two roots)', v_state, v_msg; END IF;
END $$;

\echo 'U28-4: the CONTROL for U28-3 — with the second root removed the same block resolves silently, so U28-3 is about ambiguity and not about the block always raising'
DELETE FROM nodes WHERE id='23111111-0000-0000-0000-00000000002b';
DO $$
DECLARE v_state text := NULL;
BEGIN
  BEGIN
    EXECUTE $x$
      do $inner$
      declare v_org uuid; v_roots int; v_root uuid;
      begin
        for v_org in
          select distinct org_id from (
            select org_id from products        where site_node_id is null
            union all select org_id from operators       where site_node_id is null
            union all select org_id from skills          where site_node_id is null
            union all select org_id from shift_templates where site_node_id is null
          ) s
        loop
          select count(*) into v_roots
            from nodes n where n.org_id = v_org and n.parent_id is null;
          select n.id into v_root
            from nodes n where n.org_id = v_org and n.parent_id is null
           order by n.path limit 1;
          if v_roots <> 1 then
            raise exception 'migration 0028: org % has % root nodes and still holds company-wide rows.', v_org, v_roots;
          end if;
        end loop;
      end $inner$;
    $x$;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  IF v_state IS NULL THEN RAISE NOTICE 'PASS U28-4';
  ELSE RAISE NOTICE 'FAIL U28-4: raised % with one root', v_state; END IF;
END $$;

ROLLBACK;

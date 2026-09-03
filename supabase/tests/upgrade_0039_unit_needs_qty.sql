-- ============================================================================
-- upgrade_0039_unit_needs_qty.sql — 0039 against a database that already holds
-- the dirty data the old client wrote: an assignment carrying target_unit
-- ("units") with NO target_qty beside it.
--
-- ⭐ WHY THIS FILE EXISTS, when the numbered suite only runs the FRESH path.
-- 0039 BACKFILLS (nulls the stray unit) and then adds a CHECK. On db:reset the
-- backfill sees nothing — migrations run against an empty schema and the seed
-- inserts clean rows afterwards — so neither the backfill nor "did the ALTER
-- succeed over real dirty rows" is exercised there. Both are pinned here.
--
-- ⚠️ TRIGGERS ON `assignments` ARE DISABLED FOR THE FIXTURE. A real assignment
-- must pass `app_guard_assignment_scope` (operator owned by an ancestor of the
-- node, product offered there). This file is about the unit rule, not the scope
-- guard, so it disables the user triggers to plant a minimal row and re-enables
-- nothing (the whole thing rolls back). Runs as the superuser, which may.
--
-- Run against a database at migration 0038 with NO seed. The file applies 0039
-- itself; see verify-db.sh's UPGRADE_CHECKS.
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

ALTER TABLE assignments DISABLE TRIGGER USER;

INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000039', 'Upgrade Org 0039');
INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('21111111-0000-0000-0000-000000000039', '11111111-0000-0000-0000-000000000039', 'U39 Shape');
INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('22111111-0000-0000-0000-000000000039', '11111111-0000-0000-0000-000000000039',
   '21111111-0000-0000-0000-000000000039', 0, 'Cell', true);
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-000000000039', '11111111-0000-0000-0000-000000000039',
   '22111111-0000-0000-0000-000000000039', NULL, 'U39 Cell');
INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
  ('51111111-0000-0000-0000-000000000039', '11111111-0000-0000-0000-000000000039',
   'U39 Operator', '23111111-0000-0000-0000-000000000039');
INSERT INTO products (id, org_id, sku, name, source) VALUES
  ('61111111-0000-0000-0000-000000000039', '11111111-0000-0000-0000-000000000039',
   'U39-SKU', 'U39 Product', 'manual');

-- ⭐ THE DIRTY ROW, written the way the OLD client wrote it: a unit, no quantity.
INSERT INTO assignments (id, org_id, node_id, operator_id, product_id, timerange, target_qty, target_unit)
VALUES ('91111111-0000-0000-0000-000000000039', '11111111-0000-0000-0000-000000000039',
        '23111111-0000-0000-0000-000000000039', '51111111-0000-0000-0000-000000000039',
        '61111111-0000-0000-0000-000000000039',
        tstzrange(now(), now() + interval '1 hour'), NULL, 'units');

-- ---------------------------------------------------------------------------
\echo 'U39-0: running against 0038 — the constraint does not exist yet and the dirty row is present'
DO $$
DECLARE v_con int; v_unit text; v_qty numeric;
BEGIN
  SELECT count(*) INTO v_con FROM pg_constraint WHERE conname = 'assignments_unit_needs_qty';
  SELECT target_unit, target_qty INTO v_unit, v_qty FROM assignments
   WHERE id = '91111111-0000-0000-0000-000000000039';
  IF v_con = 0 AND v_unit = 'units' AND v_qty IS NULL
    THEN RAISE NOTICE 'PASS U39-0';
  ELSE RAISE NOTICE 'FAIL U39-0: constraint=% unit=% qty=% (want 0, units, null) — not running against 0038', v_con, v_unit, v_qty; END IF;
END $$;

-- ---------------------------------------------------------------------------
\i :mig
-- ---------------------------------------------------------------------------

\echo 'U39-1 ⭐⭐: the backfill nulled the stray unit on the existing row'
DO $$
DECLARE v_unit text;
BEGIN
  SELECT target_unit INTO v_unit FROM assignments WHERE id = '91111111-0000-0000-0000-000000000039';
  IF v_unit IS NULL THEN RAISE NOTICE 'PASS U39-1';
  ELSE RAISE NOTICE 'FAIL U39-1: unit is % (want null) — the old data did not obey the rule', v_unit; END IF;
END $$;

\echo 'U39-2 ⭐: the CHECK now REFUSES a unit with no quantity, from any code path'
DO $$
DECLARE v_state text;
BEGIN
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, target_qty, target_unit)
    VALUES ('11111111-0000-0000-0000-000000000039', '23111111-0000-0000-0000-000000000039',
            '51111111-0000-0000-0000-000000000039', '61111111-0000-0000-0000-000000000039',
            tstzrange(now(), now() + interval '1 hour'), NULL, 'boxes');
    v_state := 'no error';
  EXCEPTION WHEN check_violation THEN v_state := 'check_violation';
  END;
  IF v_state = 'check_violation' THEN RAISE NOTICE 'PASS U39-2';
  ELSE RAISE NOTICE 'FAIL U39-2: a unit with no quantity was accepted (%) — the rule is not enforced', v_state; END IF;
END $$;

\echo 'U39-3: a unit WITH a quantity is still allowed — the rule bans only the orphan unit'
DO $$
DECLARE v_ok int;
BEGIN
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, target_qty, target_unit)
  VALUES ('11111111-0000-0000-0000-000000000039', '23111111-0000-0000-0000-000000000039',
          '51111111-0000-0000-0000-000000000039', '61111111-0000-0000-0000-000000000039',
          tstzrange(now() + interval '2 hours', now() + interval '3 hours'), 500, 'units');
  SELECT count(*) INTO v_ok FROM assignments WHERE target_qty = 500 AND target_unit = 'units';
  IF v_ok = 1 THEN RAISE NOTICE 'PASS U39-3';
  ELSE RAISE NOTICE 'FAIL U39-3: a legitimate unit+quantity row did not persist (%)', v_ok; END IF;
END $$;

ROLLBACK;

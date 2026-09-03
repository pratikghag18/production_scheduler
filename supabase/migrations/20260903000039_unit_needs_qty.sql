-- ============================================================================
-- 20260903000039_unit_needs_qty.sql
--
-- "A rule is a rule, be it new or old." — the maintainer, 3 Sept.
--
-- R-313's client fix stopped NEW assignments getting a stray target_unit (the
-- literal "units") when they carry no target_qty. But a code change only decides
-- the next write; rows already stored by the old code still carry the unit with
-- no quantity beside it. This migration makes the rule hold for ALL rows, and
-- forever, in the one place no code path can slip past:
--
--   1. BACKFILL — null the unit wherever there is no quantity, so existing rows
--      obey the rule the client now follows.
--   2. CHECK — `target_unit IS NULL OR target_qty IS NOT NULL`, so the database
--      itself refuses a unit without a quantity from then on, whatever writes it
--      (old client, new client, an RPC, a hand-run UPDATE). The invariant stops
--      being a convention the UI remembers and becomes a fact of the schema.
--
-- A unit is a label ON a quantity ("500 units"); with no quantity it labels
-- nothing. `target_qty` already carries `check (target_qty > 0)`; this is its
-- twin for the unit.
--
-- ⚠️ DATA-TRANSFORMING — it needs an upgrade check that runs over a
-- pre-migration database, unlike a pure function migration. See
-- `supabase/tests/upgrade_0039_unit_needs_qty.sql` and its row in verify-db.sh's
-- UPGRADE_CHECKS. No column is added, dropped or re-typed and no RPC changes, so
-- `db:types` is unaffected (generated types do not carry CHECK constraints).
-- ----------------------------------------------------------------------------

-- 1. The rule, applied to what is already stored.
UPDATE assignments
   SET target_unit = NULL
 WHERE target_qty IS NULL
   AND target_unit IS NOT NULL;

-- 2. The rule, enforced for every future write. Added AFTER the backfill so the
--    existing rows already satisfy it and the ALTER cannot fail on live data.
ALTER TABLE assignments
  ADD CONSTRAINT assignments_unit_needs_qty
  CHECK (target_unit IS NULL OR target_qty IS NOT NULL);

comment on constraint assignments_unit_needs_qty on assignments is
  'A target_unit may exist only beside a target_qty (0039). A unit labels a quantity; with no quantity it labels nothing. The database twin of the client rule R-313 shares in TargetField.normalizeTarget.';

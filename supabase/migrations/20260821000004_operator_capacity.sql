-- ============================================================================
-- Migration 0004: operator capacity
-- Implements: design-plan.md §15.1 verbatim (the instantaneous-peak query is
--   validated against live PostgreSQL 16 and is NOT restructured here — see
--   the brief's explicit warning). The only functional change from §15.1 is
--   the cap lookup (§17 D2: read from orgs.settings, not hardcoded). The
--   error surface is improved with ERRCODE and USING DETAIL so the API layer
--   can build the split-coverage popover (§15.1) without re-querying.
-- ============================================================================

create function check_operator_capacity() returns trigger as $fn$
DECLARE
  cap numeric;
  peak numeric;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;

  -- D2: cap is configurable per org (orgs.settings->>'capacity_cap'), default 1.0.
  SELECT COALESCE((o.settings->>'capacity_cap')::numeric, 1.0) INTO cap
  FROM orgs o WHERE o.id = NEW.org_id;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operator_id::text, 42));
  -- Do not restructure this query. It computes the operator's instantaneous
  -- peak load (not a naive sum of overlapping rows) by evaluating load only
  -- at the start of the new range and at the starts of overlapping
  -- assignments inside it. Validated case: 60% (08-10) + 60% (10-12) + 40%
  -- (09-11) is legal at peak exactly 1.0; a naive sum would wrongly report
  -- 1.6/1.7 and reject it. Acceptance cases 12 and 13 exist to catch a
  -- "simplification" that silently breaks this.
  SELECT COALESCE(max(load), 0) INTO peak FROM (
    SELECT (SELECT COALESCE(sum(a.efficiency), 0)
            FROM assignments a
            WHERE a.operator_id = NEW.operator_id
              AND a.id <> NEW.id AND a.status <> 'cancelled'
              AND a.timerange @> p.pt) + NEW.efficiency AS load
    FROM (
      SELECT lower(NEW.timerange) AS pt
      UNION
      SELECT lower(a.timerange) FROM assignments a
      WHERE a.operator_id = NEW.operator_id
        AND a.id <> NEW.id AND a.status <> 'cancelled'
        AND a.timerange && NEW.timerange
    ) p
    WHERE NEW.timerange @> p.pt
  ) q;
  IF peak > cap THEN
    RAISE EXCEPTION 'capacity exceeded: operator % would reach % (cap %)',
      NEW.operator_id, peak, cap
      USING ERRCODE = 'check_violation',
            DETAIL = format('operator_id=%s peak=%s cap=%s', NEW.operator_id, peak, cap);
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

CREATE TRIGGER assignments_capacity
BEFORE INSERT OR UPDATE OF timerange, efficiency, status, operator_id ON assignments
FOR EACH ROW EXECUTE FUNCTION check_operator_capacity();

-- ============================================================================
-- 0085 --- a person busy where the caller cannot see is still busy (DEF-0053,
-- R-465, R-033, R-431).
--
-- THE DEFECT. A line supervisor books a person for 10 am to noon while that
-- person is on a cell of ANOTHER line from 6 am to 2 pm, and the server writes
-- it: the person is at 200% against a cap of 100%. The sum behind R-033 was
-- computed from the CALLER'S view. operator_peak_load (0043) was LANGUAGE sql
-- STABLE with no SECURITY DEFINER, its callers check_operator_capacity (the
-- assignments_capacity trigger) and capacity_probe were invokers too, and
-- assignments_select shows a supervisor only the rows on nodes in
-- app_readable_node_ids(). So her sum left out every block on a place outside
-- her grant. It is CLAUDE.md section 4's rule about anything resolved by walking
-- past the caller's view: the server answers it as a definer and guards the
-- company boundary itself (0061, 0068, 0084).
--
-- THE DECISION (the maintainer, 30 Sept, R-465). The server counts every block
-- wherever it is. When the block that makes a person busy is on a place the
-- caller cannot read, the caller is told the PLACE and the HOURS, never the
-- product or the job: "Priya Shah is already on Cell 4 in Line 2 today from 6 am
-- to 2 pm."
--
-- EXTRACTED, NOT RETYPED (CLAUDE.md section 4). The last definition of each of
-- the three functions this migration touches is in
-- 20260904000043_assignment_delete_is_delete.sql (grep -in
-- "function \(public\.\)\?<name>(" supabase/migrations/*.sql, last hit). The
-- bodies below were sliced out of that file by a script
-- and the guards asserted on the assembled text before this file was written:
--   operator_peak_load: LANGUAGE sql STABLE with the same search_path, the
--     COALESCE(max(load), 0) shape, the "a.timerange @> p.pt) + p_efficiency"
--     sum and the "p_timerange @> p.pt" window, all present and unchanged.
--   capacity_probe: the same signature, the org_id / cap lookup, the delegation
--     to operator_peak_load, and the 'fits' / 'peak' / 'cap' keys, present.
-- The edits are stated at each function. check_operator_capacity is re-emitted
-- with SECURITY DEFINER only (see below): it reads no assignments itself, it asks
-- operator_peak_load, and the trigger (declared BEFORE INSERT OR UPDATE OF
-- timerange, efficiency, operator_id, 0043) refuses Ana's write with its own
-- text unchanged: capacity_exceeded, PT409, "capacity exceeded: operator ...
-- would reach 2.000 (cap 1.0)", detail {operator_id, peak, cap, timerange}.
--
-- HOW A CALLER WITH NO COMPANY CONTEXT IS TOLD APART. Exactly as 0068 and 0071
-- settled: the exemption is keyed on auth.uid() IS NULL (no identity at all: the
-- database owner running the seed, the service role, the SQL suite's setup
-- role), NOT on app_current_org() IS NULL, which is also true of a signed-in
-- session with no profile row (DEF-0019) and would hand that session every
-- company's sums. A caller with an identity sums only rows of its own company
-- (a.org_id = app_current_org()); for another company's operator that sum is
-- empty, so operator_peak_load answers the bare p_efficiency (a request's own
-- load, nothing of anyone else's) -- the answer absence_overlap gives for a
-- person it cannot see ('absent' false) rather than a raise, because the
-- trigger's own path can never reach it (the composite key refuses the row
-- first) and a raise would tell a stranger the person exists.
-- Since the helper is closed to signed-in people (below), only its two definer
-- callers reach it, and auth.uid() in them is still the request's caller, so the
-- same key tells the owner and the seed apart from a person exactly as before.
--
-- THE HELPER IS CLOSED TO SIGNED-IN PEOPLE. operator_peak_load is a definer that
-- answers a load number for any operator of the caller's company, including one
-- the caller cannot read (which capacity_probe refuses through
-- app_can_read_operator). 0009 granted it to authenticated only because its callers
-- were invokers and needed EXECUTE. Its two callers are now both definers, so this
-- migration REVOKES EXECUTE from authenticated (PUBLIC and anon stay revoked): nobody
-- calls it as themselves. The fix is NOT an app_can_read_operator test inside it: if a
-- writer could ever legitimately write a block for a person she cannot read, the
-- sum would go blind again, and integrity comes first. check_operator_capacity is
-- therefore re-emitted below, extracted from 0043 byte for byte, with only
-- SECURITY DEFINER and SET search_path = public, pg_temp added (guards asserted on
-- the extracted text: the D110 NULL-operator return, the capacity_cap lookup, the
-- advisory lock, the delegation to operator_peak_load and the api_raise). auth.uid()
-- inside a definer is still the CALLER's (it reads the jwt claim, not the role), so
-- the company term in operator_peak_load keeps working when the trigger calls it.
--
-- CALLERS OF operator_peak_load in the last definitions: check_operator_capacity
-- (0043, now a definer) and capacity_probe (0043, now a definer); no invoker calls
-- it and src/ makes no rpc call to it. apply_split_coverage (0030, its last) does
-- not call it: it UPDATEs and INSERTs assignments, so every efficiency it writes
-- goes through the trigger, and it still refuses a block the caller cannot edit
-- with its own app_can_edit_node gate, which runs before any write and which this
-- migration does not touch. capacity_probe is called by the copy-week planners
-- (0055, 0066, 0067) for the operators of blocks they copy.
--
-- NOT CHANGED: assignments_select or any other policy; no column changes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- operator_peak_load --- extracted from 20260904000043_assignment_delete_is_delete.sql.
-- Edits: SECURITY DEFINER, and a company term on each of the two reads of
-- assignments, (auth.uid() IS NULL OR a.org_id = app_current_org()). The peak
-- arithmetic is otherwise byte for byte 0043's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operator_peak_load(
  p_operator_id uuid,
  p_timerange tstzrange,
  p_efficiency numeric,
  p_exclude_assignment_id uuid DEFAULT NULL
) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(max(load), 0) FROM (
    SELECT (SELECT COALESCE(sum(a.efficiency), 0)
            FROM assignments a
            WHERE a.operator_id = p_operator_id
              AND (auth.uid() IS NULL OR a.org_id = app_current_org())
              AND (p_exclude_assignment_id IS NULL OR a.id <> p_exclude_assignment_id)
              AND a.timerange @> p.pt) + p_efficiency AS load
    FROM (
      SELECT lower(p_timerange) AS pt
      UNION
      SELECT lower(a.timerange) FROM assignments a
      WHERE a.operator_id = p_operator_id
              AND (auth.uid() IS NULL OR a.org_id = app_current_org())
        AND (p_exclude_assignment_id IS NULL OR a.id <> p_exclude_assignment_id)
        AND a.timerange && p_timerange
    ) p
    WHERE p_timerange @> p.pt
  ) q;
$$;

COMMENT ON FUNCTION operator_peak_load(uuid, tstzrange, numeric, uuid) IS
  'R-465/R-033 (DEF-0053): the highest load an operator would carry across p_timerange with p_efficiency added, summed over EVERY block of theirs in the caller''s company wherever it is. SECURITY DEFINER because a supervisor cannot read the blocks on a place outside her grant and a sum from her view says the person is free. NOT CALLABLE BY A SIGNED-IN PERSON (EXECUTE revoked from authenticated, 0085): as a definer it would answer about people the caller cannot read; its callers check_operator_capacity and capacity_probe are definers and need no grant. Guards the company boundary itself: with an identity the sum covers only the caller''s own company, so another company''s operator answers the bare p_efficiency; with no identity at all (auth.uid() IS NULL: owner, seed, service role) it sums everything, as before.';

-- ---------------------------------------------------------------------------
-- check_operator_capacity --- extracted from 20260904000043_assignment_delete_is_delete.sql.
-- Edit: SECURITY DEFINER and a pinned search_path, nothing else, so the trigger can
-- call operator_peak_load once nobody else may. It refuses with the same text and
-- the same detail as before.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_operator_capacity() RETURNS trigger AS $fn$
DECLARE
  cap numeric;
  peak numeric;
BEGIN
  -- D110: the operator has been deleted and this row is history now.
  IF NEW.operator_id IS NULL THEN RETURN NEW; END IF;

  -- D2: cap is configurable per org (orgs.settings->>'capacity_cap'), default 1.0.
  SELECT COALESCE((o.settings->>'capacity_cap')::numeric, 1.0) INTO cap
  FROM orgs o WHERE o.id = NEW.org_id;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operator_id::text, 42));
  -- Peak calculation lives in operator_peak_load() (brief P1-3a §4) so the
  -- trigger and capacity_probe() are provably the same implementation.
  peak := operator_peak_load(NEW.operator_id, NEW.timerange, NEW.efficiency, NEW.id);
  IF peak > cap THEN
    PERFORM api_raise('capacity_exceeded',
      format('capacity exceeded: operator %s would reach %s (cap %s)', NEW.operator_id, peak, cap),
      jsonb_build_object('operator_id', NEW.operator_id, 'peak', peak, 'cap', cap, 'timerange', NEW.timerange::text));
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

COMMENT ON FUNCTION check_operator_capacity() IS
  'R-465/R-033 (DEF-0053): the assignments_capacity trigger body --- refuses an assignment that would take an operator past the company cap, summed over every block of theirs wherever it is. SECURITY DEFINER (search_path pinned) so it may call operator_peak_load, which is closed to signed-in people; auth.uid() inside it is still the caller''s. Refusal text and detail unchanged: capacity_exceeded, PT409.';

-- ---------------------------------------------------------------------------
-- capacity_probe --- extracted from 20260904000043_assignment_delete_is_delete.sql.
-- Edits: SECURITY DEFINER; the invoker answer for an operator the caller could not read
-- (no cap, no verdict, the bare request as the peak, no rows; app_can_read_operator, the
-- operators_select predicate, decides); the company term on
-- the overlapping read; and the overlapping rows change shape per row (a block
-- on a readable node carries "outside": false and "parent_name"; a block on a
-- node the caller cannot read carries "outside": true, the node's name, its
-- parent's name, the hours and the efficiency, and JSON null for assignment_id,
-- node_id and product_name). fits / peak / cap are the same for every caller in
-- the company.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION capacity_probe(
  p_operator_id uuid,
  p_timerange tstzrange,
  p_efficiency numeric,
  p_exclude_assignment_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org_id uuid;
  v_cap numeric;
  v_peak numeric;
  v_result jsonb;
BEGIN
  -- R-465: this body now runs as the definer, so the question the invoker used to
  -- answer for free -- may the caller see this person at all -- is asked here, by
  -- the same helper operators_select's own predicate is (app_can_read_operator:
  -- org_id = app_current_org() AND app_can_read_in_plant(site_node_id)). No
  -- identity at all (auth.uid() IS NULL: the owner, the seed, the SQL suite's
  -- setup role) is exempt, as 0068/0071 key it.
  -- An operator the caller cannot read (another plant's person, another company's, a
  -- session with no profile, or a uuid that names nobody: a week template keeps ids of
  -- people since deleted, 0067) is answered EXACTLY as the invoker version answered it:
  -- no cap, no verdict, no rows, and the bare request as the peak. The copy-week and
  -- template planners (0055, 0066, 0067) call this for every item and read a NULL fits
  -- as "fits" on purpose (the writer's trigger decides); a raise here failed the whole
  -- plan for a template that names a deleted person (found by review). The same answer
  -- for a stranger and for nobody tells a caller nothing about who exists.
  IF auth.uid() IS NOT NULL AND (p_operator_id IS NULL OR NOT app_can_read_operator(p_operator_id)) THEN
    RETURN jsonb_build_object('fits', NULL, 'peak', p_efficiency, 'cap', NULL,
                              'overlapping', '[]'::jsonb);
  END IF;

  SELECT org_id INTO v_org_id FROM operators WHERE id = p_operator_id;
  SELECT COALESCE((o.settings->>'capacity_cap')::numeric, 1.0) INTO v_cap
    FROM orgs o WHERE o.id = v_org_id;

  -- Same implementation as the trigger -- see operator_peak_load() above.
  v_peak := operator_peak_load(p_operator_id, p_timerange, p_efficiency, p_exclude_assignment_id);

  SELECT jsonb_build_object(
    'fits', v_peak <= v_cap,
    'peak', v_peak,
    'cap', v_cap,
    'overlapping', COALESCE((
      SELECT jsonb_agg(
               CASE WHEN r.readable THEN
                 jsonb_build_object(
                   'assignment_id', r.id,
                   'node_id', r.node_id,
                   'node_name', r.node_name,
                   'parent_name', r.parent_name,
                   'product_name', r.product_name,
                   'timerange', r.timerange::text,
                   'efficiency', r.efficiency,
                   'outside', false)
               ELSE
                 -- R-465: a block on a place the caller cannot read is told as
                 -- the place and the hours, never the product or the ids.
                 jsonb_build_object(
                   'assignment_id', NULL::uuid,
                   'node_id', NULL::uuid,
                   'node_name', r.node_name,
                   'parent_name', r.parent_name,
                   'product_name', NULL::text,
                   'timerange', r.timerange::text,
                   'efficiency', r.efficiency,
                   'outside', true)
               END ORDER BY r.timerange)
      FROM (
        SELECT a.id, a.node_id, n.name AS node_name, pn.name AS parent_name,
               CASE WHEN auth.uid() IS NULL OR a.node_id IN (SELECT app_readable_node_ids())
                    THEN pr.name END AS product_name,
               a.timerange, a.efficiency,
               (auth.uid() IS NULL OR a.node_id IN (SELECT app_readable_node_ids())) AS readable
        FROM assignments a
        JOIN nodes n ON n.id = a.node_id
        LEFT JOIN nodes pn ON pn.id = n.parent_id
        LEFT JOIN products pr
          ON pr.id = COALESCE(a.product_id, (SELECT r2.product_id FROM runs r2 WHERE r2.id = a.run_id))
        WHERE a.operator_id = p_operator_id
          AND (auth.uid() IS NULL OR a.org_id = app_current_org())
          AND a.timerange && p_timerange
          AND (p_exclude_assignment_id IS NULL OR a.id <> p_exclude_assignment_id)
      ) r
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION capacity_probe(uuid, tstzrange, numeric, uuid) IS
  'R-465/R-033 (DEF-0053): what an operator''s load would be over p_timerange at p_efficiency, and the blocks it overlaps. SECURITY DEFINER so the answer is the same for every caller in the company; answers an operator the caller could not read as an invoker did (fits and cap null, the bare request as the peak, no rows), so a template naming a deleted person still plans. A block on a place the caller cannot read comes back as outside=true with the place, its parent, the hours and the efficiency and JSON null for assignment_id, node_id and product_name: the place and the hours, never the product or the job.';

-- ---------------------------------------------------------------------------
-- operator_blocks_elsewhere --- the blocks of people the caller can read that sit
-- on places the caller cannot read, as a set (R-465), modelled on
-- absence_recordable_people (0084) and app_readable_node_ids (0074). What the
-- operator rail and the bar use to say "booked (Cell 4, 6 am to 2 pm)" for a
-- person who is busy on another line.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operator_blocks_elsewhere(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (operator_id uuid, node_name text, parent_name text, timerange tstzrange, efficiency numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.operator_id, n.name, pn.name, a.timerange, a.efficiency
    FROM assignments a
    JOIN nodes n ON n.id = a.node_id
    LEFT JOIN nodes pn ON pn.id = n.parent_id
   WHERE a.org_id = app_current_org()
     AND a.operator_id IS NOT NULL
     AND a.timerange && tstzrange(p_from, p_to)
     AND a.node_id NOT IN (SELECT app_readable_node_ids())
     AND app_can_read_operator(a.operator_id)
   ORDER BY a.operator_id, a.timerange;
$$;

COMMENT ON FUNCTION operator_blocks_elsewhere(timestamptz, timestamptz) IS
  'R-465/R-431 (DEF-0053): every block overlapping the window, in the caller''s own company, whose operator the caller can read (app_can_read_operator) and whose node the caller CANNOT read (not in app_readable_node_ids()) --- the place, its parent, the hours and the efficiency, never a product, a run or an assignment id. Empty for a caller who reads the whole plant, for a caller with no profile, and for another company. SECURITY DEFINER because the node is by definition one the caller cannot read.';

REVOKE EXECUTE ON FUNCTION operator_blocks_elsewhere(timestamptz, timestamptz) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION operator_blocks_elsewhere(timestamptz, timestamptz) TO authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION operator_blocks_elsewhere(timestamptz, timestamptz) FROM anon';
  END IF;
END $$;

-- operator_peak_load is closed to signed-in people (see the header). 0009 granted it
-- to authenticated; take that grant back. PUBLIC and anon were already revoked.
REVOKE EXECUTE ON FUNCTION operator_peak_load(uuid, tstzrange, numeric, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION operator_peak_load(uuid, tstzrange, numeric, uuid) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION operator_peak_load(uuid, tstzrange, numeric, uuid) FROM anon';
  END IF;
END $$;

-- DEF-0069 (R-465): the operator rail said "free" for a person booked on a place the caller can READ but that is off the
-- board's root. operator_blocks_elsewhere (0085) returned only blocks on places the caller cannot read, and the board's own
-- window holds only the rows under its root, so a block on a readable place outside the root was in neither source. The
-- function gains a third parameter, the board's root (an ltree, the type board_window takes), and with it returns every block
-- off that root. A NULL root is 0085's answer exactly. A changed signature is a NEW function, so the two-argument one is
-- dropped; the body, the COMMENT, the REVOKE and the GRANT are 0085's, extracted by script and re-emitted for the new signature.

DROP FUNCTION IF EXISTS operator_blocks_elsewhere(timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION operator_blocks_elsewhere(p_from timestamptz, p_to timestamptz, p_root_path ltree DEFAULT NULL)
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
     AND CASE WHEN p_root_path IS NULL
              THEN a.node_id NOT IN (SELECT app_readable_node_ids())
              ELSE NOT (n.path <@ p_root_path)
         END
     AND app_can_read_operator(a.operator_id)
   ORDER BY a.operator_id, a.timerange;
$$;

COMMENT ON FUNCTION operator_blocks_elsewhere(timestamptz, timestamptz, ltree) IS
  'R-465/R-431 (DEF-0053, DEF-0069): every block overlapping the window, in the caller''s own company, whose operator the caller can read (app_can_read_operator) and that is NOT on the board the caller is looking at. With p_root_path NULL the board is unknown and the set is 0085''s: the blocks whose node the caller CANNOT read (not in app_readable_node_ids()). With p_root_path (the board''s root, the same ltree board_window takes) it is every block whose node is not at or below that root, whether or not the caller can read the node --- a place she can read but that is off her board is no more on the rail than one she cannot read. The place, its parent, the hours and the efficiency, never a product, a run or an assignment id. Empty for another company. SECURITY DEFINER because the node may be one the caller cannot read.';

REVOKE EXECUTE ON FUNCTION operator_blocks_elsewhere(timestamptz, timestamptz, ltree) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION operator_blocks_elsewhere(timestamptz, timestamptz, ltree) TO authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION operator_blocks_elsewhere(timestamptz, timestamptz, ltree) FROM anon';
  END IF;
END $$;

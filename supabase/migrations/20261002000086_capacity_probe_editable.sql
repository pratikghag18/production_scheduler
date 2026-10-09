-- ============================================================================
-- 0086: capacity_probe says which overlapping blocks the caller can CHANGE
-- (DEF-0065, R-431, R-468).
--
-- The probe's readable rows prove the caller can READ a block, not change it. The
-- bar's lot offered "Split evenly" for a person booked on a block the supervisor
-- reads but cannot edit (a read-only grant on another line), listed her as Ready,
-- and after the yes apply_split_coverage refused with not_permitted
-- (app_can_edit_node on every adjusted block's node). Which blocks she can change is
-- a fact only the server can answer (CLAUDE.md section 4: a screen that shows what
-- the server will refuse), so each row of the probe now carries it.
--
-- app_can_edit_node is itself a SECURITY DEFINER that reads auth.uid() and the
-- caller's grants, so inside this definer it still answers for the CALLER.
--
-- EXTRACTED from 0085's capacity_probe by script and asserted on, never retyped
-- (DEF-0011): the same SECURITY DEFINER and pinned search_path, the unreadable-
-- operator blind answer (fits and cap null), the company boundary, the outside rows
-- with JSON null ids, the exclude-assignment term. The only differences are one
-- column in the inner select, one field in each branch of the row object, and the
-- COMMENT. Nothing else is re-emitted; grants are unchanged (CREATE OR REPLACE).
-- ============================================================================
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
                   'outside', false,
                   'editable', r.editable)
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
                   'outside', true,
                   'editable', false)
               END ORDER BY r.timerange)
      FROM (
        SELECT a.id, a.node_id, n.name AS node_name, pn.name AS parent_name,
               CASE WHEN auth.uid() IS NULL OR a.node_id IN (SELECT app_readable_node_ids())
                    THEN pr.name END AS product_name,
               a.timerange, a.efficiency,
               (auth.uid() IS NULL OR a.node_id IN (SELECT app_readable_node_ids())) AS readable,
               (auth.uid() IS NULL OR app_can_edit_node(a.node_id)) AS editable
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
  'R-465/R-033 (DEF-0053): what an operator''s load would be over p_timerange at p_efficiency, and the blocks it overlaps. SECURITY DEFINER so the answer is the same for every caller in the company; answers an operator the caller could not read as an invoker did (fits and cap null, the bare request as the peak, no rows), so a template naming a deleted person still plans. A block on a place the caller cannot read comes back as outside=true with the place, its parent, the hours and the efficiency and JSON null for assignment_id, node_id and product_name: the place and the hours, never the product or the job. Every row carries editable (0086): true when the caller may EDIT the block''s node (app_can_edit_node, the check apply_split_coverage and the writers run; true for no identity at all), always false for an outside row, so a screen offers a split only where the server will accept it.';

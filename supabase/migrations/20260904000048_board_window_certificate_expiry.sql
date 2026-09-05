-- ===========================================================================
-- 0048 - THE BOARD IS TOLD WHEN A CERTIFICATE RUNS OUT (F-087).
--
-- THE DEFECT. Somebody whose certification expired a year ago could be dragged
-- onto a cell, drew as perfectly eligible, raised no warning, and was offered
-- no override tick. Pressing Create then failed with "operator is not eligible
-- for this node/window; override required under warn policy" -- and because the
-- client had never decided an override was needed, the box that would supply
-- one was not on screen. A DEAD END, NOT A WARNING.
--
-- THE SERVER WAS NEVER WRONG. `check_eligibility` has computed
--   expiring = expires_at IS NOT NULL
--              AND (upper_inf(p_timerange) OR expires_at < upper(p_timerange)::date)
-- since 0009, and `eligible` is false when any exist; `create_assignment` acts
-- on it. What was wrong is that THE BOARD ASKED A SIMPLER QUESTION -- "does
-- this person hold the training at all" -- and could not have asked a better
-- one, because `board_window` sent `operators[].skill_ids`: A BARE ARRAY OF
-- IDS WITH NO DATE ON IT. No amount of care on the client can separate a live
-- certificate from a lapsed one when the date was removed before it arrived.
-- CLAUDE.md s4, with the arrow reversed: a screen that OFFERS what the server
-- refuses, which is the worse half, because the person only finds out after
-- doing the work.
--
-- SO THE FIX IS ONE KEY: `operators[].skill_expiries`, a list of
-- `{skill_id, expires_at}` for THE DATED ROWS ONLY. The client can then run
-- the server's own comparison for the window it is actually about to write.
--
-- ⭐ WHY `skill_ids` STAYS, WHICH WAS THE ONE REAL CHOICE HERE. Replacing it
-- with a single `[{id, expires_at}]` list is the tidier shape and it was
-- rejected for two reasons. First, `skill_ids` answers a DIFFERENT question --
-- "was this person ever trained" -- and that question has its own screens
-- (the operator panel's chips, the drag hint, the departed-person row
-- `history.ts` synthesises) which are right to keep asking it; F-087 is
-- precisely the harm of collapsing "never trained" into "not eligible", and
-- merging the two lists would push that collapse down into the payload.
-- Second, the new key is NOT A SECOND COPY OF THE FIRST -- it carries only the
-- rows that HAVE a date, so it is an annotation on a subset, not the duplicated
-- column list CLAUDE.md s4 warns about. Both are aggregated in the same
-- statement over the same table, so they cannot drift.
--
-- ⚠️ NULL EXPIRY IS FILTERED OUT, NOT SENT AS NULL. "This certificate never
-- expires" is the common case and the absence of a row says it exactly once.
-- Sending `{"skill_id": ..., "expires_at": null}` would give the client a
-- second spelling of the same fact and a guard to write for it.
--
-- ⚠️ SAME EXPOSURE AS BEFORE. `board_window` stays SECURITY INVOKER and the new
-- sub-select reads `operator_skills` under `operator_skills_select`, exactly as
-- the `skill_ids` sub-select beside it already did. A reader who could see the
-- holder row could always see this column on it; this discloses nothing new.
--
-- APPEND-ONLY, and `board_window` is re-created here in full, EXTRACTED with
-- `pg_get_functiondef` from the live database rather than retyped (CLAUDE.md
-- s4). ONE key is added; every other key is byte-for-byte its 0042 text, and
-- `supabase/tests/71_board_expiry_test.sql` case E9 asserts they all still
-- arrive.
--
-- Proved by 71_board_expiry_test.sql. Its E7 is the case that matters: a helper
-- replays the CLIENT'S arithmetic over this payload alone, and its verdict is
-- compared with `check_eligibility`'s across a matrix of expiry dates and
-- windows. Before this migration, 13 of 28 pairs disagreed.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.board_window(p_root_path ltree, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org_id uuid;
  v_window tstzrange;
  v_result jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_from and p_to must not be null',
      jsonb_build_object('field', 'p_from/p_to', 'reason', 'null bound'));
  END IF;
  IF p_from >= p_to THEN
    PERFORM api_raise('invalid_argument', 'p_from must be before p_to',
      jsonb_build_object('field', 'p_from', 'reason', 'p_from >= p_to'));
  END IF;
  IF p_to - p_from > interval '92 days' THEN
    PERFORM api_raise('invalid_argument', 'window exceeds 92 days',
      jsonb_build_object('field', 'p_to', 'reason', 'window exceeds 92 days'));
  END IF;

  v_org_id := app_current_org();
  v_window := tstzrange(p_from, p_to);

  WITH scoped_nodes AS (
    SELECT n.* FROM nodes n
    WHERE n.org_id = v_org_id AND n.path <@ p_root_path
  ),
  -- DEF-0005: the ANSWER, computed where the authority is. See the header.
  offered_here AS (
    SELECT op.product_id, op.node_id FROM app_offered_product_nodes(p_root_path) op
  ),
  scoped_templates AS (
    SELECT DISTINCT hl.template_id
    FROM scoped_nodes sn JOIN hierarchy_levels hl ON hl.id = sn.level_id
  ),
  node_template_map AS (
    SELECT sn.id AS node_id, resolve_shift_template(sn.id) AS template_id
    FROM scoped_nodes sn
  )
  SELECT jsonb_build_object(
    'org', (SELECT jsonb_build_object('id', o.id, 'name', o.name, 'settings', o.settings)
            FROM orgs o WHERE o.id = v_org_id),

    'levels', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', hl.id, 'template_id', hl.template_id, 'position', hl.position,
               'name', hl.name, 'is_schedulable', hl.is_schedulable)
             ORDER BY hl.template_id, hl.position)
      FROM hierarchy_levels hl
      WHERE hl.org_id = v_org_id
        AND hl.template_id IN (SELECT template_id FROM scoped_templates)
    ), '[]'::jsonb),

    'nodes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', sn.id, 'parent_id', sn.parent_id, 'level_id', sn.level_id,
               'name', sn.name, 'path', sn.path::text, 'sort_order', sn.sort_order,
               'active', sn.active) ORDER BY sn.path)
      FROM scoped_nodes sn
    ), '[]'::jsonb),

    'runs', COALESCE((
      SELECT jsonb_agg(to_jsonb(r) ORDER BY r.timerange)
      FROM runs r
      WHERE r.node_id IN (SELECT id FROM scoped_nodes) AND r.timerange && v_window
    ), '[]'::jsonb),

    'assignments', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.timerange)
      FROM assignments a
      WHERE a.node_id IN (SELECT id FROM scoped_nodes) AND a.timerange && v_window
    ), '[]'::jsonb),

    'operators', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', op.id, 'home_node_id', op.home_node_id, 'display_name', op.display_name,
               'employee_ref', op.employee_ref, 'active', op.active,
               'site_node_id', op.site_node_id,
               'skill_ids', COALESCE((
                 SELECT jsonb_agg(os.skill_id) FROM operator_skills os WHERE os.operator_id = op.id
               ), '[]'::jsonb),
               -- THE KEY THIS MIGRATION EXISTS FOR (F-087). `skill_ids` above
               -- answers "was this person ever trained"; this answers "and is
               -- that certificate still good", which is the question
               -- `check_eligibility` actually decides on. Only the DATED rows
               -- are listed -- an undated certificate never expires, and its
               -- absence here says so once rather than twice.
               'skill_expiries', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object('skill_id', os.skill_id,
                                                     'expires_at', os.expires_at)
                          ORDER BY os.skill_id)
                 FROM operator_skills os
                 WHERE os.operator_id = op.id AND os.expires_at IS NOT NULL
               ), '[]'::jsonb)
             ) ORDER BY op.display_name)
      FROM operators op WHERE op.org_id = v_org_id
    ), '[]'::jsonb),

    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'active', p.active,
               'color_token', p.color_token,
               'site_node_ids', COALESCE((
                 SELECT jsonb_agg(ps.node_id) FROM product_sites ps WHERE ps.product_id = p.id
               ), '[]'::jsonb),
               -- THE KEY THIS MIGRATION EXISTS FOR (DEF-0005). Which nodes IN
               -- THIS WINDOW is this part offered at, asked of the same test the
               -- write guard runs. `site_node_ids` above is the raw place list
               -- and stays exactly as it was -- the admin screens and the
               -- deleted-product path in history.ts read it -- but it is
               -- RLS-filtered, so a supervisor granted a LINE sees `[]` for a
               -- part made at the PLANT and cannot tell that from a part that
               -- is made nowhere.
               'offered_node_ids', COALESCE((
                 SELECT jsonb_agg(oh.node_id) FROM offered_here oh WHERE oh.product_id = p.id
               ), '[]'::jsonb)) ORDER BY p.sku)
      FROM products p WHERE p.org_id = v_org_id
    ), '[]'::jsonb),

    'skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'site_node_id', s.site_node_id) ORDER BY s.name)
      FROM skills s WHERE s.org_id = v_org_id
    ), '[]'::jsonb),

    'node_skill_requirements', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('node_id', nsr.node_id, 'skill_id', nsr.skill_id)
               ORDER BY nsr.node_id, nsr.skill_id)
      FROM node_skill_requirements nsr
      WHERE nsr.node_id IN (SELECT id FROM scoped_nodes)
    ), '[]'::jsonb),

    'shift_templates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', st.id, 'name', st.name,
               'shifts', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', s.id, 'name', s.name, 'start_min', s.start_min, 'end_min', s.end_min,
                          'breaks', COALESCE((
                            SELECT jsonb_agg(jsonb_build_object(
                                     'id', b.id, 'name', b.name, 'start_min', b.start_min, 'end_min', b.end_min)
                                     ORDER BY b.start_min)
                            FROM shift_breaks b WHERE b.shift_id = s.id
                          ), '[]'::jsonb)
                        ) ORDER BY s.start_min)
                 FROM shifts s WHERE s.template_id = st.id
               ), '[]'::jsonb)
             ) ORDER BY st.name)
      FROM shift_templates st
      WHERE st.id IN (SELECT DISTINCT template_id FROM node_template_map WHERE template_id IS NOT NULL)
    ), '[]'::jsonb),

    'node_shift_map', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('node_id', ntm.node_id, 'template_id', ntm.template_id)
               ORDER BY ntm.node_id)
      FROM node_template_map ntm WHERE ntm.template_id IS NOT NULL
    ), '[]'::jsonb),

    'cycle_times', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('node_id', ct.node_id, 'product_id', ct.product_id,
                                          'seconds_per_unit', ct.seconds_per_unit)
               ORDER BY ct.node_id, ct.product_id)
      FROM node_product_cycle_times ct
      WHERE ct.node_id IN (SELECT id FROM scoped_nodes)
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

comment on function public.board_window(ltree, timestamptz, timestamptz) is
  'The board read. Unchanged from 0042 apart from one added key: operators[].skill_expiries, a {skill_id, expires_at} row for each certificate that CARRIES a date, so the client can run check_eligibility''s own comparison (expires_at < upper(window)::date, an open-ended window counting as expired) for the window it is about to write instead of offering a person the server will refuse (F-087). skill_ids keeps its old meaning and its old readers: was this person ever trained, regardless of renewal. Still SECURITY INVOKER, so every key stays RLS-scoped to the caller.';


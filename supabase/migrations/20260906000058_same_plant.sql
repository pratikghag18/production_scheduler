-- ============================================================================
-- 0058 --- ONE PLANT'S PEOPLE STAY IN THAT PLANT, AND THE PLANT'S PEOPLE ARE
--          WHAT THE BOARD IS SENT (R-345, R-346, S39).
--
-- The maintainer, 6 Sept, twice, and the two sentences are this whole file:
--
--   "You should be unable to put Plant B operator in Plant A, only operators
--    within the same plant should be assigned within the plant."
--
--   "If a operator is assigned to higher hierarchy they should automatically
--    become available to all lower hierarchy within that hierarchy ... That
--    should be the default behaviour. For other operators in the plant we need
--    to give an option to the supervisor to click through something so show
--    remaining operators so they can make that decision to assign someone
--    outside of that area."
--
-- ----------------------------------------------------------------------------
-- WHAT WAS WRONG, IN THE ORDER A PERSON MEETS IT.
--
-- 1. THE AREA OVERRIDE CROSSED ANYTHING. D113 (0030) gave the operator half of
--    `app_guard_assignment_scope` a door: a person owned outside the cell's
--    branch may be placed there anyway, with a reason. The door had no idea
--    what a plant was, so it let Plant B's welder onto Plant A's line for the
--    price of a sentence in a box. The maintainer's first rule says that door
--    must not exist across plants, override or not.
--
-- 2. A LINE SUPERVISOR SAW AN EMPTY PEOPLE PANEL. `operators_select` (0028) is
--    `app_can_read_owned(site_node_id)`: the owner and one of the caller's
--    grants must be on the same BRANCH, either direction. Ana is granted
--    Line 1 of Plant A. That reads people homed at Plant A and at Area 1 ---
--    her own ancestors --- and NOT people homed in Area 2, which is the rest of
--    her plant. The panel then narrowed that list again to people homed on a
--    node the BOARD had loaded, and the board only loads Line 1 and below, so
--    everybody homed above the line fell out and the panel was blank. Two
--    filters, each defensible, and nobody left.
--
-- 3. `board_window` SENT THE COMPANY'S PEOPLE AND NOT THE PLANT'S. Its
--    `operators` array was `FROM operators op WHERE op.org_id = v_org_id` ---
--    every person the caller could read anywhere --- while its `nodes` array is
--    the board's subtree. So the payload could not answer "where is this person
--    from" at all, and the pickers filled the gap by guessing from the node map
--    (R-342's cause).
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES, AND WHAT IT DELIBERATELY DOES NOT.
--
--   1  the table guard refuses a cross-plant placement, override or not, with
--      `not_offered_here` carrying `reason: other_plant`. It is the TABLE, so
--      create_assignment, reassign_assignment, move_run, apply_copy_week and a
--      bare PostgREST INSERT all inherit it in the same statement.
--   2  `operators_select` widens from "the same branch as one of my grants" to
--      "the same PLANT as one of my grants". `app_can_read_operator` follows,
--      so `operator_skills` --- the training records --- follows with it.
--   3  `board_window` sends the people whose home is inside the BOARD'S PLANT,
--      each carrying `site_path`, the home's ltree path as text.
--
-- IT DOES NOT SPLIT THE LIST. "Available by default" (homed at or above this
-- cell) and "one click away" (homed elsewhere in this plant) is a decision the
-- SCREEN makes from `site_path`, in a lane of its own. The server's job here is
-- to send the right people with their home, and to refuse the placement no
-- screen should have offered.
--
-- ----------------------------------------------------------------------------
-- THE CONTRACT THAT CHANGES, STATED PLAINLY, BECAUSE 0026 STATED THE OLD ONE.
--
-- 0026 wrote: "may the caller read a shared row owned by this node? The owner
-- and one of the caller's grants must be on the same branch, either direction."
-- That sentence still governs products, trainings and shift patterns. It NO
-- LONGER governs PEOPLE. For an operator the rule is now: the caller may read
-- them when they hold ANY grant in the person's PLANT, and a company admin
-- reads all. Wider than before within a plant --- Ana now reads Area 2's people
-- --- and exactly as tight as before at the plant boundary: no grant in the
-- plant, no person (S21). `app_can_read_in_plant` is the sentence in code, and
-- `app_can_read_owned` is left untouched for the tables that still keep the old
-- one.
--
-- WHY WIDER READING IS SAFE, ARGUED RATHER THAN ASSERTED. Reading a person tells
-- you their name, their employee reference, their home and their tickets. R-346
-- requires a supervisor to be ABLE to place any of them, with a reason, so
-- hiding them was already only hiding a name from somebody the server would let
-- them book. The boundary that matters is the plant, and that boundary is
-- unchanged in both halves of this file.
--
-- ----------------------------------------------------------------------------
-- HOW THIS FILE WAS BUILT (CLAUDE.md section 4: extract, never retype).
--
-- `app_guard_assignment_scope` and `board_window` are re-emitted WHOLE. Neither
-- body was typed. A script sliced each one out of the LAST migration that
-- defines it --- the guard from 0034 (NOT 0030: 0034 re-emitted it for the
-- product-places change and is the live text), `board_window` from 0051 ---
-- asserted every guard and every payload key on the extracted text, applied the
-- edits by string replacement, and asserted all of them AGAIN on the assembled
-- text before the file was written. 80 assertions, 0 failures. What was
-- asserted, in words:
--
--   guard        the SECURITY DEFINER header and pinned search_path; the
--                operator half; the owner lookup; the unknown-operator early
--                return; D109's `app_owner_covers_in_org`; D113's override
--                door and its sentence; `v_needed`; the product half; D115's
--                `app_product_offered_at_in_org` and its sentence; BOTH flag
--                normalisations (the early-return one and the tail one); and
--                that the new refusal is written before the door AND before
--                the D109 test.
--   board_window all thirteen top-level keys (org, levels, nodes,
--                node_policies, runs, assignments, operators, products,
--                skills, node_skill_requirements, shift_templates,
--                node_shift_map, cycle_times) and all four nested ones
--                (skill_ids, skill_expiries, offered_node_ids, site_node_ids);
--                the 92-day bound; the null-bound refusal; DEF-0005's
--                `app_offered_product_nodes`; R-331's resolved policy;
--                `resolve_shift_template`; and `scoped_nodes`.
--
-- No signature changes anywhere, so every existing GRANT survives and the
-- generated TypeScript changes only in `board_window`'s payload shape.
--
-- ----------------------------------------------------------------------------
-- WHAT WAS MEASURED. supabase/tests/81_same_plant_test.sql is new and asks
-- every half of both rules as a signed-in person: create_assignment and
-- reassign_assignment refused across plants with and without the override,
-- move_run refused with a crew member who would land in another plant, the
-- area override still crossing areas INSIDE a plant (the unchanged half of
-- D113, pinned so this file cannot quietly take it away), a supervisor granted
-- ONE LINE reading her whole plant's people and their training records and
-- getting all of them back from board_window with site_path, another plant's
-- person neither readable nor returned, the company admin unchanged, and the
-- grants. 78 and 79 were reworked where they built rows this migration makes
-- impossible; 78's header says what F-099 lost.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- SECTION 1. THE TABLE REFUSES A CROSS-PLANT PLACEMENT (R-345).
--
-- Re-emitted WHOLE from 0034's version by extraction. Everything below the
-- inserted block is byte-for-byte what 0034 shipped: D109's owner test, D113's
-- door, D115's product half with NO door (0029's SECURITY INVOKER proof for
-- delete_owned_row still rests on that), and both flag normalisations.
--
-- WHY THE TABLE AND NOT THE WRITERS. There are five doors onto `assignments`
-- that can carry a person --- create_assignment (0030), reassign_assignment
-- (0057), move_run (0050), apply_copy_week (0055) and a plain PostgREST
-- INSERT/UPDATE --- and a rule written in four of them is a rule with a hole in
-- it. `assignments_scope_guard` is BEFORE INSERT OR UPDATE OF node_id,
-- operator_id, product_id, so all five pass through this one function.
--
-- MOVE_RUN IS THE ONE WORTH SAYING OUT LOUD. It computes its own crew scope
-- BEFORE writing, so it can name every affected person at once instead of
-- refusing five times --- but that pre-check is skipped entirely when
-- p_area_override is true, and it asks `app_owner_covers`, which knows nothing
-- about plants. So move_run's own answer is not enough and was never meant to
-- be: the run row is updated first, each assignment follows, and THIS trigger
-- fires on that UPDATE OF node_id. A plpgsql function is one transaction, so
-- the raise rolls the run back with it. 80's SP7 measures exactly that, with
-- and without the override, and reads the run's node back afterwards --- a
-- refusal that has already moved the run would be the failure worth catching.
-- ---------------------------------------------------------------------------
create or replace function app_guard_assignment_scope() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_needed boolean := false;
        v_owner_plant ltree; v_cell_plant ltree;   -- R-345
begin
  if new.operator_id is not null then
    select o.site_node_id into v_owner from operators o
     where o.id = new.operator_id and o.org_id = new.org_id;
    if not found then return new; end if;
    -- R-345, THE RULE THIS MIGRATION EXISTS FOR, AND IT SITS BEFORE THE DOOR.
    -- The maintainer, 6 Sept: "You should be unable to put Plant B operator in
    -- Plant A, only operators within the same plant should be assigned within
    -- the plant." A plant is the FIRST LABEL of an ltree path, so the question
    -- is one comparison; `is distinct from` and not `<>` so a node that cannot
    -- be found fails CLOSED rather than to NULL.
    --
    -- NO OVERRIDE READS THIS. D113's door below still opens for an AREA inside
    -- one plant, with a reason; nothing opens for a plant. Which is why the
    -- test is here and not inside the `not app_owner_covers_in_org` branch: the
    -- branch is where the flag is consulted, and this refusal must not be.
    select subpath(n.path, 0, 1) into v_owner_plant
      from nodes n where n.id = v_owner and n.org_id = new.org_id;
    select subpath(n.path, 0, 1) into v_cell_plant
      from nodes n where n.id = new.node_id and n.org_id = new.org_id;
    if v_owner_plant is distinct from v_cell_plant then
      perform api_raise('not_offered_here',
        'That person works in a different plant.',
        jsonb_build_object('kind', 'operator', 'id', new.operator_id,
                           'owner_node_id', v_owner, 'node_id', new.node_id,
                           'reason', 'other_plant'));
    end if;
    if not app_owner_covers_in_org(new.org_id, v_owner, new.node_id) then
      -- D113: the door. RLS checked that the writer may override; the flag says
      -- they decided to, and gave a reason.
      if not new.area_override then
        perform api_raise('not_offered_here',
          'That person does not belong to this part of the structure.',
          jsonb_build_object('kind', 'operator', 'id', new.operator_id,
                             'owner_node_id', v_owner, 'node_id', new.node_id));
      end if;
      v_needed := true;
    end if;
  end if;

  -- An assignment carries EITHER a run or a product (assignments_work_identified),
  -- so this branch is only reached for the product-direct shape. NO DOOR HERE.
  if new.product_id is not null then
    if not exists (select 1 from products p
                    where p.id = new.product_id and p.org_id = new.org_id) then
      -- Normalise before the early return too, or a row whose product is in
      -- another org keeps a flag the operator half already decided about.
      if not v_needed then
        new.area_override := false; new.area_override_reason := null;
      end if;
      return new;
    end if;
    if not app_product_offered_at_in_org(new.org_id, new.product_id, new.node_id) then
      perform api_raise('not_offered_here',
        'That product does not belong to this part of the structure.',
        jsonb_build_object('kind', 'product', 'id', new.product_id, 'node_id', new.node_id));
    end if;
  end if;

  -- The flag means "this really did override something", or it means nothing.
  if not v_needed then
    new.area_override := false;
    new.area_override_reason := null;
  end if;
  return new;
end $$;
comment on function app_guard_assignment_scope() is
  'D109 + D113 + D115 + R-345. Refuses an assignment whose operator works in a DIFFERENT PLANT from its node (detail reason ''other_plant'', no override reads it), or whose operator is not owned by an ancestor-or-self of its node, or whose product is offered in no plant covering its node. A plant is the first label of the ltree path. The OPERATOR half defers to assignments.area_override for the AREA rule only; the PRODUCT half has no override and migration 0029''s SECURITY INVOKER proof depends on that. Normalises the flag off when the row did not need it.';

-- ---------------------------------------------------------------------------
-- SECTION 2. WHO MAY READ A PERSON (R-346).
--
-- One new predicate, in the shape of `app_can_read_owned` (0026, re-emitted in
-- 0028) and next to it rather than replacing it. Same three properties, and
-- 0023's Q35 question --- "which of its parameters is a tenant boundary the
-- caller gets to choose?" --- gets the same answer: NONE. It takes a node id
-- and returns a fact about the CALLER, computed from `app_current_org()` and
-- `app_grant_paths()`, neither of which can be passed in. Probing a node from
-- another tenant is false by the org term.
--
-- THE ONE CHANGED CLAUSE. `app_can_read_owned` asks `n.path <@ gp OR gp <@
-- n.path` --- the same BRANCH. This asks `subpath(n.path, 0, 1) =
-- subpath(gp, 0, 1)` --- the same PLANT. A plant is the first label, so this is
-- one comparison and it is strictly WIDER: on the same branch implies under the
-- same root. Nothing that could be read before cannot be read now.
--
-- WHY NOT JUST WIDEN `app_can_read_owned`. Because products, trainings and
-- shift patterns are not people and the maintainer has not said the same thing
-- about them. `skills_select` in particular is what 0045 leans on when it
-- argues that a certification cannot outlive its plant: the receiving plant's
-- supervisor must NOT read the old plant's training. Widening one function
-- would have moved that too, silently, in a file about people.
-- ---------------------------------------------------------------------------
create or replace function app_can_read_in_plant(p_site_node uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT app_is_admin()
      OR EXISTS (
           SELECT 1
             FROM nodes n, app_grant_paths(false) gp
            WHERE n.id = p_site_node
              AND n.org_id = app_current_org()
              AND subpath(n.path, 0, 1) = subpath(gp, 0, 1)
         );
$$;
comment on function app_can_read_in_plant(uuid) is
  'R-346 / 0058: may the caller read a PERSON owned by this node? They must hold a grant --- of any role --- somewhere in the same PLANT, the plant being the first label of the ltree path; company admins read all. Strictly wider than app_can_read_owned (same branch implies same plant) and exactly as tight at the plant boundary (S21). Used by operators_select and, through app_can_read_operator, by operator_skills_select. NOT used for products, trainings or shift patterns: those keep 0026''s branch rule, and 0045''s cross-plant certification argument depends on skills_select keeping it.';

-- The policy the maintainer's empty panel came from.
drop policy operators_select on operators;
create policy operators_select on operators for select
  using (org_id = app_current_org() and app_can_read_in_plant(site_node_id));

-- `app_can_read_operator` is how the TRAINING RECORDS ask the same question:
-- `operator_skills` was given no owner column of its own in 0023 on purpose
-- (a row joining a Plant-1 person to a Plant-1 training has no second owner to
-- derive), so it follows the PERSON. Re-emitted from 0028's version --- which
-- is the last one, and which had already dropped 0026's
-- `app_operator_on_visible_schedule` branch --- with `app_can_read_owned`
-- swapped for `app_can_read_in_plant`. `operator_skills_select` calls this
-- function and is therefore moved by this line and not by a policy of its own;
-- saying so here is the point of saying it at all.
create or replace function app_can_read_operator(p_operator uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (SELECT 1 FROM operators o
                  WHERE o.id = p_operator AND o.org_id = app_current_org()
                    AND app_can_read_in_plant(o.site_node_id));
$$;
comment on function app_can_read_operator(uuid) is
  'May the caller read a row that hangs off a PERSON (operator_skills, the training records)? Follows the person: app_can_read_in_plant on their home, R-346 / 0058. Was app_can_read_owned (0026, 0028) until the plant rule replaced the branch rule for people.';

revoke execute on function app_can_read_in_plant(uuid) from public;
revoke execute on function app_can_read_operator(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_can_read_in_plant(uuid) to authenticated';
    execute 'grant execute on function app_can_read_operator(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_can_read_in_plant(uuid) from anon';
    execute 'revoke all on function app_can_read_operator(uuid) from anon';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- SECTION 3. THE BOARD IS SENT ITS PLANT'S PEOPLE, WITH EACH HOME'S PATH
--            (R-346).
--
-- First the helper the payload leans on, and it is SECURITY DEFINER for a
-- reason that is measured, not assumed. `board_window` is SECURITY INVOKER and
-- `nodes_select` (0020) is
--
--     org_id = app_current_org()
--     and (app_is_admin()
--          or exists (select 1 from app_grant_paths(false) gp where path <@ gp)
--          or (parent_id is null and app_is_admin_on_grant_node(id)))
--
-- --- DESCENDANTS of a grant, not ancestors. Ana is granted Line 1; she cannot
-- read Area 1 or Plant A as nodes at all. So `JOIN nodes ON nodes.id =
-- op.site_node_id` inside board_window would have silently dropped every person
-- homed at the plant or at the area above her --- which is to say almost
-- everybody, and precisely the people whose absence from the panel started
-- this. The helper hands over the PATH so the join never happens under RLS,
-- the same move `app_resolve_node_setting` makes for node settings (0050 s3,
-- 0051's header).
--
-- WHAT IT DOES NOT DO IS DECIDE WHO IS IN THE LIST. It is joined to the
-- RLS-filtered `operators` inside board_window, so it can only ever narrow that
-- list to one plant; `operators_select` (section 2) still says who is readable.
-- A definer function that returned the people as well would have been a way to
-- read another company's staff by passing a path, which is the whole of 0023's
-- Q35. It is org-scoped internally regardless.
--
-- AND IT ANSWERS ONLY ABOUT A PLANT THE CALLER HOLDS A GRANT IN. The first
-- draft had the org term and not this one, and the reviewer (session 78) took
-- it the way DEF-0013 took app_node_is_plant_root eight days earlier: a
-- supervisor granted one line of Plant SA called it with a guessed slug,
-- 'plant_sb', and got Plant SB's operator ids and home paths back --- people
-- and nodes she cannot read by any policy. The call site was safe (board_window
-- is only ever rooted where the caller can read) and the function was not; it
-- is granted to authenticated, so it is a PostgREST route on its own. The rule
-- 0056 restated holds for every definer helper: a plant the caller has no
-- grant in gets the same answer as a plant that does not exist --- nothing.
-- SP13 asks it directly, the way 77's AR10 asks its helper.
-- ---------------------------------------------------------------------------
create or replace function app_operator_homes(p_root_path ltree)
returns table (operator_id uuid, site_path ltree)
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT o.id, n.path
    FROM operators o
    JOIN nodes n ON n.id = o.site_node_id AND n.org_id = o.org_id
   WHERE o.org_id = app_current_org()
     AND subpath(n.path, 0, 1) = subpath(p_root_path, 0, 1)
     AND (app_is_admin()
          OR EXISTS (SELECT 1 FROM app_grant_paths(false) gp
                      WHERE subpath(gp, 0, 1) = subpath(p_root_path, 0, 1)));
$$;
comment on function app_operator_homes(ltree) is
  'R-346 / 0058. Every person in the caller''s org whose home is in the same PLANT as this path, with the home''s ltree path. SECURITY DEFINER because nodes_select is `path <@ grant` --- descendants only --- so a line supervisor cannot resolve the home of anyone owned by the plant or by the area above them, and board_window is SECURITY INVOKER. Org-scoped internally (app_current_org, never a parameter) AND answers only about a plant the caller holds a grant in, or any plant for a company admin --- a plant with no grant gets nothing, the same as a plant that does not exist (session 78, the reviewer; SP13). Joined to the RLS-filtered `operators` at its one call site, so it narrows the list to a plant and never widens who is readable; operators_select decides that.';

revoke execute on function app_operator_homes(ltree) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_operator_homes(ltree) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_operator_homes(ltree) from anon';
  end if;
end $$;

-- Re-emitted WHOLE from 0051 by extraction. Two edits, both inside the
-- `operators` array: the row source gains an inner join to the helper above,
-- and each person gains `site_path`. Every other key is 0051's text.
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

    -- ⭐⭐ THE KEY THIS MIGRATION EXISTS FOR (R-331). One resolved answer per
    -- node in the window, so the popover can ask the CELL what the rule is
    -- instead of asking the company. Built off `scoped_nodes`, so it covers
    -- exactly the nodes `nodes` above sends and no others -- a node in one
    -- list and not the other is a cell the client cannot decide about.
    --
    -- ⛔ `app_resolve_node_setting` AND NOT THE RAW `node_settings` ROWS. This
    -- function is SECURITY INVOKER; `node_settings_select` is gated on
    -- `app_can_read_node`. A supervisor granted a LINE never receives the row
    -- sitting on the PLANT ROOT, so a browser handed those rows and told to
    -- walk the ancestry would miss the override and fall through to the
    -- company's default -- a `block` plant reading as `warn` for exactly the
    -- people who schedule against it all day. The resolver is SECURITY DEFINER
    -- for that reason (0050 §3), so the walk happens where the authority is.
    --
    -- ⚠️ THE COALESCE TO 'warn' IS THE KEY'S OWN DEFAULT, kept at the call site
    -- exactly as `check_eligibility` keeps it (0050 §5) -- the resolver returns
    -- NULL when nobody has an answer, and inventing one inside it would answer
    -- 'warn' for keys that have nothing to do with eligibility. This value and
    -- `check_eligibility`'s `policy` are therefore the SAME expression, which
    -- is what 74's N7 measures node by node.
    'node_policies', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'node_id', sn.id,
               'eligibility_policy',
               COALESCE(app_resolve_node_setting(sn.id, 'eligibility_policy'), 'warn'))
             ORDER BY sn.path)
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
               -- R-346. The home's PATH, so the screen can tell "homed above
               -- this cell" (available by default) from "homed in another area
               -- of this plant" (behind the click) WITHOUT being able to read
               -- the nodes above its own grant. `nodes` is RLS-scoped and
               -- `nodes_select` is `path <@ grant`, DESCENDANTS ONLY, so a line
               -- supervisor cannot resolve the home of anyone owned by the
               -- plant or by the area above them -- joining `nodes` here would
               -- have dropped exactly the people the maintainer was missing.
               -- The path therefore comes from a SECURITY DEFINER helper, for
               -- the same reason `app_resolve_node_setting` is one (0051).
               'site_path', oh.site_path::text,
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
      -- R-345/R-346. THE PLANT'S PEOPLE, not the company's. The join is an
      -- INNER one against a SECURITY DEFINER helper restricted to the board's
      -- own plant, so a person homed in another plant is not in the payload at
      -- all -- they can no longer be placed here (R-345), so offering them was
      -- only ever a dead end. `operators` itself stays RLS-filtered (this
      -- function is SECURITY INVOKER), so the helper widens the SHAPE of the
      -- list and `operators_select` still decides who is in it.
      FROM operators op
      JOIN app_operator_homes(p_root_path) oh ON oh.operator_id = op.id
      WHERE op.org_id = v_org_id
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

comment on function board_window(ltree, timestamptz, timestamptz) is
  'Unchanged from 0051 apart from the `operators` array (R-346): it is now the people whose HOME IS IN THE BOARD''S PLANT rather than every person in the company the caller can read, and each one carries `site_path`, the home node''s ltree path as text. The plant is subpath(p_root_path, 0, 1); the home paths come from app_operator_homes, which is SECURITY DEFINER because nodes_select is descendants-only and a line supervisor cannot read the nodes above her grant. site_path is what lets the screen split the list into "available here by default" (homed at or above this cell) and "the rest of this plant, one click away" (D113''s area override, with a reason) without seeing those nodes. A person from another plant is not sent at all, because R-345 means they can no longer be placed here.';

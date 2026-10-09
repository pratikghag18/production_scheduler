-- ============================================================================
-- 20260908000072_schedulable_node_guard.sql — F-120 / R-002.
--
-- R-002: "Only schedulable-level nodes accept runs and assignments." The
-- comment on runs.node_id (0003) already said so -- "must be the schedulable
-- level (app-enforced)" -- but nothing on the server ever checked it.
-- create_run and create_assignment don't; neither does move_run; no CHECK or
-- trigger anywhere references hierarchy_levels.is_schedulable except on the
-- READ side (board_window's payload, for drawing a group row vs a track
-- row). Found 8 Sept while writing tests for the requirement-coverage audit
-- (F-120), confirmed the same gap in move_run, and confirmed
-- reassign_assignment is not exposed to it (it never changes node_id).
--
-- THE CHEAPEST CORRECT PLACE IS THE TABLE, NOT A THIRD COPY OF THE RULE.
-- runs and assignments already carry a BEFORE INSERT OR UPDATE OF node_id
-- trigger each (runs_scope_guard / app_guard_run_scope, assignments_scope_
-- guard / app_guard_assignment_scope, both from 0028), which fires on every
-- write to node_id -- every RPC, and a raw PostgREST PATCH that goes through
-- none of them, the same "a door built on one screen is a door that refuses
-- from the other screen" reasoning 0030 used for the D113 area-override
-- door. Adding the check there closes create_run, create_assignment, move_run
-- and any direct PATCH at once, rather than three separate copies inside the
-- RPCs (a fourth, if a future writer changes node_id and forgets it).
--
-- Both functions are re-emitted here with ONE new check each, first, before
-- anything already there -- extracted from their last re-emissions
-- (app_guard_run_scope: 20260901000034; app_guard_assignment_scope:
-- 20260906000058), not retyped from memory. Nothing else in either body
-- changes.
-- ============================================================================

create or replace function app_guard_run_scope() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- F-120 / R-002: the node this run is being placed on must be on the
  -- schedulable level. Checked first, ahead of the product-scope question
  -- below, because it is about node_id alone and applies whether or not
  -- product_id resolves to anything.
  if not exists (
    select 1 from nodes n join hierarchy_levels hl on hl.id = n.level_id
     where n.id = new.node_id and n.org_id = new.org_id and hl.is_schedulable
  ) then
    perform api_raise('invalid_argument',
      'target node is not on the schedulable level',
      jsonb_build_object('field', 'node_id', 'node_id', new.node_id, 'reason', 'not_schedulable'));
  end if;

  -- A product that is not in this org at all is the composite FK's refusal to
  -- give, not this trigger's (0028 §4). A BEFORE trigger runs first, so without
  -- this the cross-tenant test in 10_constraints_test.sql would test me instead.
  if not exists (select 1 from products p
                  where p.id = new.product_id and p.org_id = new.org_id) then
    return new;
  end if;
  if not app_product_offered_at_in_org(new.org_id, new.product_id, new.node_id) then
    perform api_raise('not_offered_here',
      'That product does not belong to this part of the structure.',
      jsonb_build_object('kind', 'product', 'id', new.product_id, 'node_id', new.node_id));
  end if;
  return new;
end $$;
comment on function app_guard_run_scope() is
  'F-120/R-002 added a schedulable-level check ahead of everything 0034 already did (the product-scope question). Unchanged otherwise.';

create or replace function app_guard_assignment_scope() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_needed boolean := false;
        v_owner_plant ltree; v_cell_plant ltree;   -- R-345
begin
  -- F-120 / R-002: same schedulable-level floor as app_guard_run_scope, first,
  -- ahead of the operator/product scope questions below.
  if not exists (
    select 1 from nodes n join hierarchy_levels hl on hl.id = n.level_id
     where n.id = new.node_id and n.org_id = new.org_id and hl.is_schedulable
  ) then
    perform api_raise('invalid_argument',
      'target node is not on the schedulable level',
      jsonb_build_object('field', 'node_id', 'node_id', new.node_id, 'reason', 'not_schedulable'));
  end if;

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
  'D109 + D113 + D115 + R-345 + F-120/R-002. Refuses a write whose node is not on the schedulable level (added here, first); whose operator works in a DIFFERENT PLANT from its node (detail reason ''other_plant'', no override reads it); whose operator is not owned by an ancestor-or-self of its node; or whose product is offered in no plant covering its node. A plant is the first label of the ltree path. The OPERATOR half defers to assignments.area_override for the AREA rule only; the PRODUCT half has no override and migration 0029''s SECURITY INVOKER proof depends on that. Normalises the flag off when the row did not need it.';

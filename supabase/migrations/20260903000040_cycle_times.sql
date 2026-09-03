-- ============================================================================
-- Migration 0040: a standard cycle time per schedulable node per product,
-- and the default target it lets the board derive.
--
-- The maintainer, 3 Sept: "At each point in the lowest hierarchy where we
-- actually do the assignment I want to assign a standard cycle time for each
-- product which can be made in that hierarchy... What this will tell me is how
-- much product can be made based on (how much time a person is assigned -
-- breaks) / standard cycle time. This will become the default target for that
-- assignment. This however can be overwritten by the already present
-- mechanism."
--
-- WHAT THIS MIGRATION DOES, AND WHAT IT DELIBERATELY DOES NOT.
--
--  * It stores the FACT — seconds of standard work per unit, at one cell, for
--    one part. Nothing more. The derived target is NOT stored anywhere: it is
--    computed for display from this number, the assignment's own window, its
--    efficiency, and the breaks of the shift pattern the cell resolves to
--    (`src/features/board/lib/standardTarget.ts`). Storing it would need a
--    rewrite of every row whenever a block is dragged, a break is edited or a
--    shift pattern is re-pointed; deriving it means a resize is already right.
--    `assignments.target_qty` therefore keeps its exact meaning: the human's
--    explicit OVERRIDE, null when they have not typed one (R-031, R-313/0039).
--
--  * A cycle time is OPTIONAL and always will be (the maintainer, same day:
--    "This should not be mandatory... There could be products which have very
--    large cycle time, often more than the shift itself. When no cycle time are
--    defined, the target for the assignment is null."). No assignment, run or
--    product write consults this table. Absence is the normal case and renders
--    exactly as it does today: "target: NA".
--
--  * SECONDS ARE THE STORED UNIT, ALWAYS (the maintainer: "give the user
--    ability to enter cycle time in seconds/minutes/hours but as a standard
--    store it in the database in seconds so it is consistent"). Minutes and
--    hours are an INPUT convenience converted by the client before it writes,
--    and a display convenience on the way back. The column is one number in one
--    unit, so a sum across cells is a sum, never a unit-conversion bug. It is
--    numeric, not integer: 1.5 minutes is 90 s but a 0.5 s cycle is legal too.
--
--  * WHERE a cycle time may live is a rule, enforced here rather than
--    remembered by the UI (§4 of CLAUDE.md: a screen that shows what the server
--    will refuse is worse than one that refuses what the server allows). Two
--    conditions, both trigger-side:
--      (a) the node's own level is the schedulable one. Cycle times measure
--          work at the place work is actually booked. Note it is the NODE'S
--          level that is asked, never "the org's schedulable level" — since
--          0014 the one-schedulable-level index is per TEMPLATE, so an org with
--          two structures has two schedulable levels and both are right.
--      (b) the product is offered at that node — the same predicate the run and
--          assignment guards ask (`app_product_offered_at_in_org`, 0034 §3), so
--          a cycle time can never exist where the part may not be scheduled.
--
--  * THE LEVEL-ABOVE NUMBER IS NOT STORED. The maintainer's model — "for the
--    same product the standard time at a hierarchy 1 level above is the
--    summation of standard cycle time in the level below" — is true as LABOUR
--    CONTENT PER UNIT and is rendered as a sum in the admin grid. It is not a
--    line's output rate (sequential stations are limited by the slowest cell,
--    parallel ones make more than either), so it is display only and derives no
--    target. Deriving it on read also means it can never go stale.
--
-- Implements: R-315, R-316, R-317. Refs: design-plan §14.2 (target_qty is a
-- window total), §16.4 (breaks), D115 (0034, product_sites), D3, D7.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1. THE TABLE.
--
-- Shaped after node_skill_requirements (0002) — the repo's other per-node
-- per-thing configuration table: composite PK, org_id carried as D7 redundancy,
-- composite tenant FKs so a row can never straddle two orgs (D3).
--
-- ⚠️ ON DELETE CASCADE ON BOTH FKs, and the node one is NOT decoration.
-- `delete_node` (0020) deletes node_shift_templates and node_skill_requirements
-- rows EXPLICITLY, by name, before it deletes the node; it knows nothing about
-- this table and cannot, since it shipped first. Without the cascade the FK
-- would refuse (23503) and deleting any cell that ever had a cycle time would
-- fail with a foreign-key error the user cannot act on. A cycle time is
-- configuration ABOUT a place, not history OF one (contrast 0029's
-- delete_keeps_the_past, which snapshots identity onto scheduled rows): when
-- the place or the part is gone, the number measuring them means nothing.
-- ---------------------------------------------------------------------------
create table node_product_cycle_times (
  node_id          uuid not null,
  product_id       uuid not null,
  org_id           uuid not null references orgs(id), -- D7
  seconds_per_unit numeric not null check (seconds_per_unit > 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (node_id, product_id),
  foreign key (org_id, node_id)    references nodes (org_id, id)    on delete cascade,
  foreign key (org_id, product_id) references products (org_id, id) on delete cascade
);

comment on table node_product_cycle_times is
  'R-315: the standard cycle time — seconds of work per one unit — for one product at one schedulable node. ALWAYS SECONDS: the client offers seconds/minutes/hours on entry and converts, so a sum across cells never mixes units. Optional everywhere: a missing row means the assignment simply has no derived default (R-316), never an error. A row may exist only where the node''s own level is schedulable AND the product is offered there (app_guard_cycle_time_scope). Cascades on both parents: this is configuration about a place and a part, not history of them.';

comment on column node_product_cycle_times.seconds_per_unit is
  'Seconds of standard work to make one unit at this node. numeric, not integer: 1.5 minutes is 90 s, and a sub-second cycle is legal. Must be > 0 — zero would mean infinite output and is refused by CHECK, not by the UI alone.';

create index node_product_cycle_times_org_product_idx
  on node_product_cycle_times (org_id, product_id);

create trigger node_product_cycle_times_set_updated_at
  before update on node_product_cycle_times
  for each row execute function set_updated_at();

alter table node_product_cycle_times enable row level security;

-- GRANTS. Migration 0008's `GRANT ... ON ALL TABLES` was a one-shot over the
-- tables that existed then, not a standing rule — 0014 and 0034 both spell this
-- out, and 0034's header records the exact failure: a table created later
-- arrives with RLS policies and NO table privilege behind them, so every
-- authenticated caller gets `permission denied for table ...` (42501) before a
-- policy is ever consulted. board_window is SECURITY INVOKER and reads this
-- table below, so without this block the whole board read would fail, not just
-- the admin screen. UPDATE is granted here where product_sites did not need it:
-- a membership row has nothing to change, but a cycle time is a VALUE and gets
-- corrected in place (the client upserts). Guarded like 0008/0014/0034 so this
-- still runs on a scratch Postgres without the Supabase roles.
do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select, insert, update, delete on node_product_cycle_times to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on node_product_cycle_times from anon';
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- §2. THE PLACEMENT GUARD.
--
-- Shaped after app_guard_run_scope (0034 §4), including its first move: a row
-- whose parent is not in this org at all is the composite FK's refusal to give,
-- not this trigger's. A BEFORE trigger runs first, so without those early
-- returns a cross-tenant write would be reported as "not schedulable" or "not
-- offered here" instead of the foreign-key violation the cross-org tests expect.
--
-- SECURITY DEFINER for the same reason 0034 §3 gives: what a constraint may ASK
-- must not depend on what the writer may LIST. `nodes` and `product_sites` are
-- both RLS-scoped, and app_product_offered_at_in_org is itself DEFINER and
-- scoped by the row's own org rather than the session's, so this works for the
-- seed, a migration and service_role as well as for a signed-in admin.
-- ---------------------------------------------------------------------------
create or replace function app_guard_cycle_time_scope() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_schedulable boolean;
begin
  -- Not our refusal to make: let the composite FK speak (0034 §4).
  select hl.is_schedulable into v_schedulable
    from nodes n join hierarchy_levels hl on hl.id = n.level_id
   where n.id = new.node_id and n.org_id = new.org_id;
  if not found then
    return new;
  end if;

  -- (a) Work is booked at one level; that is the level a cycle time measures.
  -- The NODE'S level is asked, not "the org's" — since 0014 the
  -- one-schedulable-level index is per template, so an org may hold several.
  if not v_schedulable then
    perform api_raise('invalid_argument',
      'A cycle time belongs on the level where work is scheduled.',
      jsonb_build_object('field', 'node_id', 'reason', 'not_schedulable',
                         'node_id', new.node_id));
  end if;

  -- Same early return as above, for the product half.
  if not exists (select 1 from products p
                  where p.id = new.product_id and p.org_id = new.org_id) then
    return new;
  end if;

  -- (b) The same question the run and assignment guards ask (0034 §3/§4). A
  -- cycle time may not exist where the part may not be scheduled, so the admin
  -- grid can never offer a column that the board would then refuse.
  if not app_product_offered_at_in_org(new.org_id, new.product_id, new.node_id) then
    perform api_raise('not_offered_here',
      'That product does not belong to this part of the structure.',
      jsonb_build_object('kind', 'product', 'id', new.product_id,
                         'node_id', new.node_id));
  end if;

  return new;
end $$;

comment on function app_guard_cycle_time_scope() is
  'R-315: refuses a cycle time on a node whose own level is not schedulable, or for a product not offered at that node (app_product_offered_at_in_org — the same predicate app_guard_run_scope and app_guard_assignment_scope ask). Returns early for a node or product outside the row''s org so the composite FK reports the cross-tenant case, exactly as app_guard_run_scope does.';

revoke execute on function app_guard_cycle_time_scope() from public;

create trigger node_product_cycle_times_scope_guard
  before insert or update of node_id, product_id, org_id
  on node_product_cycle_times
  for each row execute function app_guard_cycle_time_scope();

-- ---------------------------------------------------------------------------
-- §3. RLS — per-node configuration, per-plant authority.
--
-- The node_skill_requirements pattern (0020 §, re-scoped by 0028 §7): reading
-- follows the node DOWNWARD (app_can_read_node), writing needs an admin grant
-- on an ancestor-or-self of the node (app_is_admin_for), with the company-admin
-- escape 0034 gave product_sites. app_is_admin_for is safe in a WITH CHECK here
-- for D85's reason: node_id names a row in a DIFFERENT table (`nodes`), so this
-- is not the self-referential read that breaks INSERT ... RETURNING.
-- ---------------------------------------------------------------------------
create policy node_product_cycle_times_select on node_product_cycle_times for select
  using (org_id = app_current_org() and app_can_read_node(node_id));

create policy node_product_cycle_times_insert on node_product_cycle_times for insert
  with check (org_id = app_current_org()
              and (app_is_admin() or app_is_admin_for(node_id)));

create policy node_product_cycle_times_update on node_product_cycle_times for update
  using (org_id = app_current_org()
         and (app_is_admin() or app_is_admin_for(node_id)))
  with check (org_id = app_current_org()
              and (app_is_admin() or app_is_admin_for(node_id)));

create policy node_product_cycle_times_delete on node_product_cycle_times for delete
  using (org_id = app_current_org()
         and (app_is_admin() or app_is_admin_for(node_id)));

-- ---------------------------------------------------------------------------
-- §4. board_window HANDS THE CYCLE TIMES TO THE BOARD.
--
-- The board derives every chip's default target on the client, so it needs the
-- numbers for the nodes it is already showing. One more key, scoped by the
-- `scoped_nodes` CTE that is already there — no new CTE, no new join, and the
-- payload stays empty (`[]`) for an org that has set none, which is the normal
-- case. Everything else in this function is byte-for-byte the 0034 version
-- (§4 of CLAUDE.md: extract, never retype).
--
-- Same signature, so this CREATE OR REPLACE keeps 0009's grants and the
-- generated TypeScript for the RPC (`-> Json`) does not change; `db:types` is
-- needed only for the new table.
--
-- SECURITY INVOKER, so this sub-select is filtered by
-- node_product_cycle_times_select above: a caller sees the cycle times of the
-- cells they can read, and the §1 grant is what lets them read any at all.
-- ---------------------------------------------------------------------------
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
               ), '[]'::jsonb)
             ) ORDER BY op.display_name)
      FROM operators op WHERE op.org_id = v_org_id
    ), '[]'::jsonb),

    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'active', p.active,
               'color_token', p.color_token,
               'site_node_ids', COALESCE((
                 SELECT jsonb_agg(ps.node_id) FROM product_sites ps WHERE ps.product_id = p.id
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
  'The board read. Unchanged from 0034 apart from one added key: cycle_times, the standard seconds-per-unit for the scoped nodes (R-315), from which the client derives each assignment''s default target (R-316). SECURITY INVOKER, so every key stays RLS-scoped to the caller.';

-- ============================================================================
-- 20260901000034_product_belongs_to_plants.sql — D115.
--
-- The maintainer, 31 Aug: "Part number is company wide, no company has
-- different part numbers for the same product... A Product can be assigned to
-- multiple plants as there can be different plants at different geo locations
-- within the company manufacturing the same part number." On how many:
-- "It could be one plant, a number of plants or all plants... we need to be
-- flexible."
--
-- ----------------------------------------------------------------------------
-- ⭐⭐ ONE COLUMN WAS DOING THREE JOBS, AND ONLY ONE OF THEM BECOMES A LIST.
--
-- `products.site_node_id` answered three questions at once, and they are
-- separate:
--   READ   who may see the row     (products_select / app_can_read_owned)
--   OFFER  where it is schedulable  (offeredHere, the run/assignment guards)
--   EDIT   who may change the record (products_insert/update/delete)
--
-- D108 fused READ and OFFER on purpose: one owner, so "can I see it" and "is it
-- offered here" had the same answer. D115 un-fuses them. A part made in Plant A
-- and Plant B is readable by both plants' admins and offered on both plants'
-- cells, and neither is a single-node question any more.
--
-- The list of makers is a JOIN TABLE — `node_shift_templates`' shape with the
-- CARDINALITY FLIPPED. `node_shift_templates` keys on `node_id` alone because a
-- node runs exactly one pattern; a product is made in MANY places, so the key
-- is `(product_id, node_id)`. Reaching for the single-node key here would
-- silently forbid the very thing D115 exists to allow — the trainings answer
-- (per-plant names) is the wrong analogy for the same reason: parts are one
-- thing made in several places, trainings are several courses sharing a word.
--
-- ----------------------------------------------------------------------------
-- THE SPLIT DECISION — who may change a part several plants share (1 Sept).
--
-- A part number is company-wide, so a rename touches everyone who makes it.
-- Asked, the maintainer chose Split:
--   * the shared record — sku, name, colour, delete — is company property:
--     `app_is_admin()` only;
--   * the list of makers is per-plant: a plant admin may add or remove THEIR
--     OWN plant (`app_is_admin_for(node_id)` on the product_sites row); a
--     company admin may manage the whole list.
--
-- So CREATING a product is a company-admin act (it creates the shared record),
-- and a product with ZERO plants is an ordinary state — a catalogue entry not
-- yet assigned to anyone. The board simply does not offer it.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES NOT DO.
--   * Operators, skills and shift patterns keep their single `site_node_id`.
--     D115 is products-only: only parts are "one thing made in several places".
--   * No starter library. No import screen. Both come later and both were
--     waiting on this: overlapping SKUs across plants are refused today, so an
--     importer built first would be built against a rule about to change.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1. THE JOIN TABLE.
-- ---------------------------------------------------------------------------
create table product_sites (
  org_id     uuid not null references orgs(id),                 -- D7
  product_id uuid not null,
  node_id    uuid not null,
  primary key (product_id, node_id),
  foreign key (org_id, product_id) references products (org_id, id) on delete cascade,
  foreign key (org_id, node_id)    references nodes (org_id, id)
);
comment on table product_sites is
  'D115: which plants (or any node) make a product. A product is company-wide (products.sku is unique per org); this is the LIST of places it is offered and readable at. PK (product_id, node_id) — many places per product, unlike node_shift_templates which is one pattern per node. ON DELETE CASCADE on the product: deleting a part takes its assignments with it. No cascade on the node: a plant is not deleted out from under its parts.';

create index product_sites_org_node_idx on product_sites (org_id, node_id);

alter table product_sites enable row level security;

-- GRANTS. Migration 0008's `GRANT ... ON ALL TABLES` was a one-shot over the
-- tables that existed then, not a standing rule (0014's header spells this out):
-- a table created later arrives with RLS policies and NO table privilege behind
-- them, so every authenticated caller gets `permission denied for table
-- product_sites` (42501) before a policy is ever consulted -- board_window's new
-- site_node_ids sub-select included. Guarded like 0008/0014 so this still runs
-- on a scratch Postgres without the Supabase roles.
do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select, insert, delete on product_sites to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on product_sites from anon';
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- §2. BACKFILL — one row per existing product from its single owner.
--
-- A strict widening in meaning: one plant becomes a one-element list, so
-- nothing legal becomes illegal. On `db:reset` this sees nothing (migrations
-- run against an empty schema; seed.sql inserts afterwards and supplies its own
-- product_sites rows). It runs only on a real upgrade, which
-- `tests/upgrade_0034_product_places.sql` exercises against pre-0034 rows.
-- ---------------------------------------------------------------------------
insert into product_sites (org_id, product_id, node_id)
  select org_id, id, site_node_id from products;

-- ---------------------------------------------------------------------------
-- §3. THE OFFERING PREDICATE — any place covers the cell.
--
-- The list-aware twin of app_owner_covers (0028 §3). SECURITY DEFINER for the
-- same reason: what a constraint may ASK must not depend on what the writer may
-- LIST (`product_sites` and `nodes` are both RLS-scoped).
-- ---------------------------------------------------------------------------
create or replace function app_product_offered_at(p_product uuid, p_node uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM product_sites ps, nodes o, nodes n
     WHERE ps.product_id = p_product
       AND o.id = ps.node_id AND n.id = p_node
       AND ps.org_id = app_current_org()
       AND o.org_id = app_current_org()
       AND n.org_id = app_current_org()
       AND o.path @> n.path
  );
$$;
comment on function app_product_offered_at(uuid, uuid) is
  'D115: is this product offered at this node — i.e. does ANY plant it is made in contain (or equal) the node? The list-aware successor to app_owner_covers for products. Self-scoped to app_current_org() so it cannot probe another tenant.';

-- The same asked from a trigger, where there is no session org: the writer may
-- be the seed, a migration, or service_role. Scoped by the row's own org.
create or replace function app_product_offered_at_in_org(p_org uuid, p_product uuid, p_node uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM product_sites ps, nodes o, nodes n
     WHERE ps.product_id = p_product
       AND o.id = ps.node_id AND n.id = p_node
       AND ps.org_id = p_org AND o.org_id = p_org AND n.org_id = p_org
       AND o.path @> n.path
  );
$$;
comment on function app_product_offered_at_in_org(uuid, uuid, uuid) is
  'Trigger-side twin of app_product_offered_at: takes the row''s org rather than the session''s. Not granted to authenticated — see the revoke block below.';

-- ---------------------------------------------------------------------------
-- §4. THE SCHEDULING GUARDS STOP READING A SINGLE OWNER.
--
-- app_guard_run_scope (0028) and app_guard_assignment_scope (latest in 0030,
-- with the D113 area-override door on the OPERATOR half) both asked
-- app_owner_covers_in_org(product's single owner, node). They now ask
-- app_product_offered_at_in_org(product, node): offered if ANY plant covers.
-- ---------------------------------------------------------------------------
create or replace function app_guard_run_scope() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
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

-- Re-emitted from 0030's version (the D113 area-override door on the OPERATOR
-- half, and the flag normalisation, both preserved exactly). Only the PRODUCT
-- branch changed: single owner -> the list. The product half still has NO door,
-- and 0029's proof that delete_owned_row needs no escalation still depends on a
-- scheduled product always being offered where it sits.
create or replace function app_guard_assignment_scope() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_needed boolean := false;
begin
  if new.operator_id is not null then
    select o.site_node_id into v_owner from operators o
     where o.id = new.operator_id and o.org_id = new.org_id;
    if not found then return new; end if;
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
  'D109 + D113 + D115. Refuses an assignment whose operator is not owned by an ancestor-or-self of its node, or whose product is offered in no plant covering its node. The OPERATOR half defers to assignments.area_override; the PRODUCT half has no override and migration 0029''s SECURITY INVOKER proof depends on that. Normalises the flag off when the row did not need it.';

-- ---------------------------------------------------------------------------
-- §5. THE STRAND GUARD MOVES FROM RE-HOME TO UN-ASSIGN.
--
-- 0028 §5 blocked moving a single owner out from under scheduled history. There
-- is no single owner to move now; the equivalent hazard is REMOVING the last
-- plant a part is still scheduled under. A run or direct assignment at node n is
-- stranded if the plant being removed covers n and NO remaining plant does.
-- Adding a plant strands nothing and is unguarded.
-- ---------------------------------------------------------------------------
create or replace function app_guard_product_site_remove() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_stranded int;
begin
  select count(*) into v_stranded from (
    select r.node_id as node_id from runs r where r.product_id = old.product_id
    union all
    select a.node_id from assignments a where a.product_id = old.product_id
  ) sched
  where app_owner_covers_in_org(old.org_id, old.node_id, sched.node_id)
    and not exists (
      select 1 from product_sites ps
       where ps.product_id = old.product_id
         and ps.node_id <> old.node_id
         and app_owner_covers_in_org(old.org_id, ps.node_id, sched.node_id));
  if v_stranded > 0 then
    perform api_raise('owner_change_blocked',
      'This product is still scheduled in the plant you are removing it from.',
      jsonb_build_object('kind', 'product', 'id', old.product_id,
                         'removed_node_id', old.node_id, 'stranded', v_stranded));
  end if;
  return old;
end $$;

create trigger product_sites_remove_guard before delete on product_sites
  for each row execute function app_guard_product_site_remove();

-- ---------------------------------------------------------------------------
-- §6. THE OLD RE-HOME MACHINERY FOR PRODUCTS GOES.
--
-- products_rehome_guard fired on a change of the single owner column, which is
-- being dropped. Its function is products-only, so it goes too (the operator /
-- skill / template rehome guards are untouched — those tables keep their owner).
-- products_check_site enforced "the owner is a root"; there is no owner column
-- on products any more, and product_sites places may be any node (D109).
-- ---------------------------------------------------------------------------
drop trigger if exists products_rehome_guard on products;
drop function if exists app_guard_product_rehome();
drop trigger if exists products_check_site on products;

-- ---------------------------------------------------------------------------
-- §7. COLOUR BECOMES COMPANY-WIDE.
--
-- app_pick_product_color balanced the palette within one owner's rows. A part
-- has no single owner and its colour shows on every board it appears on, so the
-- pick balances across the whole org's products now. Re-assignment never
-- re-colours (colour is set once at insert; only a hand-override changes it).
-- The signature changes, so the old two-arg version is dropped first.
-- ---------------------------------------------------------------------------
drop function if exists app_pick_product_color(uuid, uuid);

create function app_pick_product_color(p_org_id uuid)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT t.token
    FROM unnest(app_product_palette()) WITH ORDINALITY AS t(token, pos)
    LEFT JOIN products p
      ON p.color_token = t.token
     AND p.org_id = p_org_id
   GROUP BY t.token, t.pos
   ORDER BY count(p.id), t.pos
   LIMIT 1;
$$;
comment on function app_pick_product_color(uuid) is
  'D115: the least-used palette token across the WHOLE ORG''s products, ties broken by palette order. A product''s colour is company-wide now — it has no single owner to balance within. ⚠️ SECURITY DEFINER and GRANTED TO NOBODY (it takes the org and bypasses RLS); reachable only from products_set_color_token() and owner-context code.';

create or replace function products_set_color_token() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.color_token is null then
    new.color_token := app_pick_product_color(new.org_id);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- §8. THE READ RULE — readable when ANY plant is on your branch.
--
-- app_can_read_owned already answers per node (0028 §6). A product is readable
-- when the caller is a company admin OR any of its product_sites rows is owned
-- by a node on one of the caller's branches (either direction). The company-admin
-- arm makes a placeless part visible to the admin who just created it.
--
-- ⚠️⚠️ WHY THIS IS A SECURITY DEFINER FUNCTION AND NOT AN INLINE `EXISTS`, AND
-- IT COST A REGRESSION TO LEARN. A first cut wrote the EXISTS straight into the
-- policy: `... or exists (select 1 from product_sites ps where ps.product_id =
-- id and app_can_read_owned(ps.node_id))`. That `from product_sites` inside a
-- policy is ITSELF an ordinary query and RLS applies to it — so
-- `product_sites_select` (app_can_read_node, DOWNWARD only) ran first and hid
-- every place ABOVE the caller's grant, defeating the EITHER-DIRECTION read the
-- EXISTS was trying to do. A line supervisor could see a plant-owned part's runs
-- on the board yet read "(unknown product)" for the part itself — the exact leak
-- D108 §6 closed, reappearing one join out. The fix is the same shape 0026/0028
-- used for `app_can_read_owned` over `nodes`: a DEFINER function reads
-- `product_sites` as the owner (bypassing its RLS), and `app_can_read_owned` does
-- the grant scoping, so D108's proof (below) is evaluated as written.
--
-- ⚠️ D108's proof that the board-history read exception is redundant STILL
-- HOLDS, one place at a time: the offering guard guarantees SOME plant o covers
-- a run's node r, and if the caller can read r then app_can_read_owned(o) holds
-- by the 0028 argument, so this function returns true for that product.
--
-- product_sites_select stays app_can_read_node(node_id) — DOWNWARD, the same fix
-- 0028 §7 made for the two join tables it found leaking — so a Plant B admin
-- reading a shared part sees the Plant B place, never the Plant A one. That is
-- the LISTING of the individual join rows; whether the PRODUCT is readable is a
-- different question, and app_can_read_product is the one that answers it.
-- ---------------------------------------------------------------------------
create or replace function app_can_read_product(p_product uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT app_is_admin()
      OR EXISTS (
           SELECT 1 FROM product_sites ps
            WHERE ps.product_id = p_product
              AND ps.org_id = app_current_org()
              AND app_can_read_owned(ps.node_id)
         );
$$;
comment on function app_can_read_product(uuid) is
  'D115: may the caller read this product — is any of its plants (product_sites) owned by a node on one of the caller''s branches, either direction (or is the caller a company admin)? SECURITY DEFINER so the product_sites read bypasses product_sites_select''s DOWNWARD-only scope, which would otherwise hide a place ABOVE the caller''s grant and defeat D108''s either-direction read. Self-scoped to app_current_org().';

drop policy products_select on products;
create policy products_select on products for select
  using (org_id = app_current_org() and app_can_read_product(id));

create policy product_sites_select on product_sites for select
  using (org_id = app_current_org() and app_can_read_node(node_id));

-- ---------------------------------------------------------------------------
-- §9. THE WRITE POLICIES — the Split decision.
--
-- The shared record (products) is company property; the list of makers
-- (product_sites) is per-plant.
-- ---------------------------------------------------------------------------
drop policy products_insert on products;
create policy products_insert on products for insert
  with check (org_id = app_current_org() and app_is_admin());

drop policy products_update on products;
create policy products_update on products for update
  using (org_id = app_current_org() and app_is_admin())
  with check (org_id = app_current_org() and app_is_admin());

drop policy products_delete on products;
create policy products_delete on products for delete
  using (org_id = app_current_org() and app_is_admin());

-- A plant admin adds or removes THEIR OWN plant; a company admin manages the
-- whole list. app_is_admin_for(x) is an admin grant on an ancestor-or-self of
-- x, so a plant admin covers their plant and every line under it. No UPDATE
-- policy: a membership row has nothing to change — you add it or remove it.
create policy product_sites_insert on product_sites for insert
  with check (org_id = app_current_org()
              and (app_is_admin() or app_is_admin_for(node_id)));
create policy product_sites_delete on product_sites for delete
  using (org_id = app_current_org()
         and (app_is_admin() or app_is_admin_for(node_id)));

-- ---------------------------------------------------------------------------
-- §10. delete_owned_row — a company admin deletes a shared part.
--
-- Re-emitted from 0029. Only the identity/permission block changed: a product
-- has no owner node, so its existence is read separately and its delete
-- permission is app_is_admin() (the Split decision), while operator / skill /
-- shift_template keep the owner-scoped check. Everything after is byte-for-byte
-- 0029 — the counts, the ROW_COUNT guards, the history snapshot.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION delete_owned_row(p_kind text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now    timestamptz := now();
  v_owner  uuid;
  v_found  boolean;
  v_name   text;
  v_code   text;
  v_colour text;
  v_active boolean;
  v_removes jsonb := '[]'::jsonb;
  v_keeps   jsonb := '[]'::jsonb;
  v_got     int;
  v_rm_runs int; v_rm_asg int; v_kp_runs int; v_kp_asg int;
  v_crew    int;
  v_direct  int;
  v_kp_crew int;
  v_extra   int;
  v_extra2  int;
BEGIN
  IF p_kind NOT IN ('product', 'operator', 'skill', 'shift_template') THEN
    PERFORM api_raise('invalid_argument',
      'p_kind must be one of product, operator, skill, shift_template',
      jsonb_build_object('field', 'p_kind', 'reason', format('unrecognised kind %s', p_kind)));
  END IF;

  -- Identity, RLS-filtered: an id in another tenant is "not found", the same
  -- answer as an id that never existed. A product has no owner node.
  IF p_kind = 'product' THEN
    SELECT true, NULL::uuid, p.name, p.sku, p.active INTO v_found, v_owner, v_name, v_code, v_active
      FROM products p WHERE p.id = p_id;
  ELSIF p_kind = 'operator' THEN
    SELECT true, o.site_node_id, o.display_name, o.employee_ref, o.active INTO v_found, v_owner, v_name, v_code, v_active
      FROM operators o WHERE o.id = p_id;
  ELSIF p_kind = 'skill' THEN
    SELECT true, s.site_node_id, s.name, NULL::text, s.active INTO v_found, v_owner, v_name, v_code, v_active
      FROM skills s WHERE s.id = p_id;
  ELSE
    SELECT true, t.site_node_id, t.name, NULL::text, t.active INTO v_found, v_owner, v_name, v_code, v_active
      FROM shift_templates t WHERE t.id = p_id;
  END IF;

  IF v_found IS NULL THEN
    PERFORM api_raise('invalid_argument', format('%s not found', p_kind),
      jsonb_build_object('field', 'p_id', 'reason', 'not found'));
  END IF;

  -- The Split decision (D115): a company admin deletes a shared part; a site
  -- admin does not, because the part number is not theirs to remove. The other
  -- three kinds keep the owner-scoped test the table's own DELETE policy applies.
  IF p_kind = 'product' THEN
    IF NOT app_is_admin() THEN
      PERFORM api_raise('not_permitted', 'only a company admin can delete a shared part',
        jsonb_build_object('node_id', NULL));
    END IF;
  ELSE
    IF NOT (app_is_admin() OR app_is_admin_for(v_owner)) THEN
      PERFORM api_raise('not_permitted', 'no admin rights over the site this row belongs to',
        jsonb_build_object('node_id', v_owner));
    END IF;
  END IF;

  IF p_kind = 'product' THEN
    -- ---- every count, before anything moves -------------------------------
    SELECT count(*) INTO v_rm_runs FROM runs r
      WHERE r.product_id = p_id AND lower(r.timerange) > v_now;
    SELECT count(*) INTO v_crew FROM assignments a
      WHERE a.run_id IN (SELECT r.id FROM runs r
                          WHERE r.product_id = p_id AND lower(r.timerange) > v_now);
    SELECT count(*) INTO v_direct FROM assignments a
      WHERE a.product_id = p_id AND lower(a.timerange) > v_now;
    v_rm_asg := v_crew + v_direct;

    SELECT count(*) INTO v_kp_runs FROM runs r
      WHERE r.product_id = p_id AND (lower(r.timerange) <= v_now OR lower(r.timerange) IS NULL);
    SELECT count(*) INTO v_kp_crew FROM assignments a
      WHERE a.run_id IN (SELECT r.id FROM runs r
                          WHERE r.product_id = p_id
                            AND (lower(r.timerange) <= v_now OR lower(r.timerange) IS NULL));
    SELECT count(*) INTO v_extra FROM assignments a
      WHERE a.product_id = p_id AND (lower(a.timerange) <= v_now OR lower(a.timerange) IS NULL);
    v_kp_asg := v_kp_crew + v_extra;

    SELECT p.color_token INTO v_colour FROM products p WHERE p.id = p_id;

    -- ---- 1. the crew of every run that is about to go ---------------------
    DELETE FROM assignments a
      WHERE a.run_id IN (SELECT r.id FROM runs r
                          WHERE r.product_id = p_id AND lower(r.timerange) > v_now);
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_crew THEN
      PERFORM api_raise('not_permitted', 'cannot remove every assignment on the runs this would delete',
        jsonb_build_object('node_id', v_owner));
    END IF;

    -- ---- 2. the runs themselves -------------------------------------------
    DELETE FROM runs r WHERE r.product_id = p_id AND lower(r.timerange) > v_now;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_rm_runs THEN
      PERFORM api_raise('not_permitted', 'cannot remove every run this would delete',
        jsonb_build_object('node_id', v_owner));
    END IF;

    -- ---- 3. direct assignments carrying the product -----------------------
    DELETE FROM assignments a WHERE a.product_id = p_id AND lower(a.timerange) > v_now;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_direct THEN
      PERFORM api_raise('not_permitted', 'cannot remove every assignment this would delete',
        jsonb_build_object('node_id', v_owner));
    END IF;

    -- ---- 4. whatever still carries this product has started. Remember it. --
    UPDATE runs r SET product_id = NULL, product_sku = v_code,
                      product_name = v_name, product_color_token = v_colour
      WHERE r.product_id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_kp_runs THEN
      PERFORM api_raise('not_permitted', 'cannot keep the history of every run that used this',
        jsonb_build_object('node_id', v_owner));
    END IF;

    UPDATE assignments a SET product_id = NULL, product_sku = v_code,
                             product_name = v_name, product_color_token = v_colour
      WHERE a.product_id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_extra THEN
      PERFORM api_raise('not_permitted', 'cannot keep the history of every assignment that used this',
        jsonb_build_object('node_id', v_owner));
    END IF;

    -- ---- 5. the row itself (product_sites cascades) -----------------------
    DELETE FROM products WHERE id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> 1 THEN
      PERFORM api_raise('not_permitted', 'the product itself could not be deleted',
        jsonb_build_object('node_id', v_owner));
    END IF;

    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'runs', 'count', v_rm_runs),
      jsonb_build_object('what', 'assignments', 'count', v_rm_asg));
    v_keeps := jsonb_build_array(
      jsonb_build_object('what', 'runs', 'count', v_kp_runs),
      jsonb_build_object('what', 'assignments', 'count', v_kp_asg));

  ELSIF p_kind = 'operator' THEN
    SELECT count(*) INTO v_rm_asg FROM assignments a
      WHERE a.operator_id = p_id AND lower(a.timerange) > v_now;
    SELECT count(*) INTO v_kp_asg FROM assignments a
      WHERE a.operator_id = p_id AND (lower(a.timerange) <= v_now OR lower(a.timerange) IS NULL);
    SELECT count(*) INTO v_extra FROM operator_skills os WHERE os.operator_id = p_id;

    DELETE FROM assignments a WHERE a.operator_id = p_id AND lower(a.timerange) > v_now;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_rm_asg THEN
      PERFORM api_raise('not_permitted', 'cannot remove every future assignment for this person',
        jsonb_build_object('node_id', v_owner));
    END IF;

    UPDATE assignments a SET operator_id = NULL, operator_display_name = v_name
      WHERE a.operator_id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_kp_asg THEN
      PERFORM api_raise('not_permitted', 'cannot keep the history of every assignment this person worked',
        jsonb_build_object('node_id', v_owner));
    END IF;

    DELETE FROM operators WHERE id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> 1 THEN
      PERFORM api_raise('not_permitted', 'the person could not be deleted',
        jsonb_build_object('node_id', v_owner));
    END IF;

    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'assignments', 'count', v_rm_asg),
      jsonb_build_object('what', 'operator_skills', 'count', v_extra));
    v_keeps := jsonb_build_array(
      jsonb_build_object('what', 'assignments', 'count', v_kp_asg));

  ELSIF p_kind = 'skill' THEN
    SELECT count(*) INTO v_extra  FROM operator_skills os WHERE os.skill_id = p_id;
    SELECT count(*) INTO v_extra2 FROM node_skill_requirements q WHERE q.skill_id = p_id;

    DELETE FROM skills WHERE id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> 1 THEN
      PERFORM api_raise('not_permitted', 'the training could not be deleted',
        jsonb_build_object('node_id', v_owner));
    END IF;

    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'operator_skills', 'count', v_extra),
      jsonb_build_object('what', 'node_skill_requirements', 'count', v_extra2));
    v_keeps := '[]'::jsonb;

  ELSE -- shift_template
    SELECT count(*) INTO v_extra  FROM shifts s WHERE s.template_id = p_id;
    SELECT count(*) INTO v_extra2 FROM shift_breaks b
      WHERE b.shift_id IN (SELECT s.id FROM shifts s WHERE s.template_id = p_id);
    SELECT count(*) INTO v_kp_asg FROM node_shift_templates nst WHERE nst.template_id = p_id;

    DELETE FROM shift_templates WHERE id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> 1 THEN
      PERFORM api_raise('not_permitted', 'the shift pattern could not be deleted',
        jsonb_build_object('node_id', v_owner));
    END IF;

    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'shifts', 'count', v_extra),
      jsonb_build_object('what', 'shift_breaks', 'count', v_extra2),
      jsonb_build_object('what', 'node_shift_templates', 'count', v_kp_asg));
    v_keeps := '[]'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'kind', p_kind, 'id', p_id, 'name', v_name, 'code', v_code,
    'active', v_active, 'removes', v_removes, 'keeps', v_keeps, 'deleted', true);
END;
$$;

comment on function delete_owned_row(text, uuid) is
  'D110 + D115: delete an owned row, keeping the past. Anything not yet started is removed; anything begun keeps the row with the deleted thing''s identity copied onto it. A PRODUCT is company-wide, so only a company admin may delete one (the Split decision); the other three kinds keep the owner-scoped permission check. SECURITY INVOKER — see 0029''s header for the proof no escalation is needed.';

-- ---------------------------------------------------------------------------
-- §11. board_window HANDS OVER THE LIST, NOT THE OWNER.
--
-- The product payload emitted `site_node_id`; it now emits `site_node_ids`, the
-- places the caller can read (product_sites is RLS-scoped and board_window is
-- SECURITY INVOKER, so a Plant B admin sees only the Plant B place). Everything
-- else in the function is byte-for-byte the 0025 version.
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
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- §12. IMPORT IDENTITY FOLLOWS THE PART NUMBER COMPANY-WIDE.
--
-- 0033 made products.external_id unique PER OWNER, matching the per-plant rule
-- 0031 settled for training names. D115 makes a part company-wide, so its import
-- id is company-wide too: one row per external_id per org. This also resolves
-- the asymmetry 0033 noted — people, and now parts, match company-wide; only
-- trainings match per plant.
-- ---------------------------------------------------------------------------
drop index products_owner_external_id_unique;
create unique index products_org_external_id_unique
  on products (org_id, external_id)
  where external_id is not null;

comment on column products.external_id is
  '0033/0034: the id this product carries in whatever system exported it. Unique ORG-WIDE (products_org_external_id_unique) since D115 made a part company-wide — one row per external_id per org, the same shape as the sku. NULL for anything created by hand. ⚠️ Trainings (skills.external_id) stay per owner; an importer matches on a different key per table.';

-- ---------------------------------------------------------------------------
-- §13. DROP THE COLUMN. Everything that read it has been re-emitted above.
--
-- Left vestigial it would be the two-homes-for-one-fact trap this project keeps
-- deleting — whoever restored it would re-fuse the three jobs this migration
-- spent its length separating.
-- ---------------------------------------------------------------------------
drop index products_org_site_idx;
alter table products drop constraint products_org_id_site_node_id_fkey;
alter table products drop column site_node_id;

-- ---------------------------------------------------------------------------
-- §14. GRANTS. New functions default to PUBLIC EXECUTE (0009 §6); revoke, then
-- grant only the session-scoped offering check.
-- ---------------------------------------------------------------------------
revoke execute on function app_product_offered_at(uuid, uuid) from public;
revoke execute on function app_product_offered_at_in_org(uuid, uuid, uuid) from public;

-- app_pick_product_color(uuid) is created fresh above (the two-arg version was
-- dropped), so it arrives with the default PUBLIC EXECUTE. It is SECURITY
-- DEFINER, takes the org as a parameter and bypasses RLS -- exactly the
-- cross-tenant palette leak 0023's two-arg version revoked and this file's §7
-- comment promises is "GRANTED TO NOBODY". Revoke it here (51_'s Q30/Q35 pin it).
revoke execute on function app_pick_product_color(uuid) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    -- The session-scoped one answers only about the caller's own tenant. The
    -- org-parameterised twin takes the tenant boundary as an argument, so it
    -- stays reachable from triggers only.
    execute 'grant execute on function app_product_offered_at(uuid, uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_product_offered_at(uuid, uuid) from anon';
    execute 'revoke all on function app_product_offered_at_in_org(uuid, uuid, uuid) from anon';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- §15. UPGRADE_CHECKS. §2 transforms existing data, so the standing rule
-- applies: `tests/upgrade_0034_product_places.sql`, added to UPGRADE_CHECKS in
-- `scripts/verify-db.sh`. It builds pre-0034 products with single owners,
-- applies this migration, and asserts one product_sites row per product came
-- out and the column is gone.
-- ---------------------------------------------------------------------------

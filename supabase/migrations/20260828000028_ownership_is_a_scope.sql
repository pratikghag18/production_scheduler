-- ============================================================================
-- 20260828000028_ownership_is_a_scope.sql — D108 and D109.
--
-- The maintainer, Aug 28, after finding a Plant 2 product in a Plant 1 admin's
-- catalogue and being told the two admins behaved differently:
--
--   "I think we should remove company-wide as an option for products and
--    operators. Each site (or the highest hierarchy level) has its own set of
--    products and operators. No product or operator can be assigned where it
--    does not belong. ... a person under no circumstances should be able to
--    see data for other plants unless they are system admin, period."
--
-- ----------------------------------------------------------------------------
-- ⭐⭐ WHY THIS IS A BETTER FIX THAN THE ONE IT REPLACES, AND THE PROOF.
--
-- 0026 scoped reads by ownership and kept ONE exception on purpose:
-- `app_product_on_visible_schedule` / `app_operator_on_visible_schedule` — a
-- foreign-owned row stays readable while it sits on a run you can see, so the
-- board can name its own history instead of drawing "(unknown product)".
--
-- That exception is correct for the board and a LEAK on every catalogue, and
-- §19.71 patched the products list on the client. The patch was owed twice
-- more (operators, shift patterns) and would have been owed again for every
-- screen added later. D109 removes the need for it entirely:
--
--   CONSTRAINT C. A run's product must be owned by an ancestor-or-self of the
--   run's node. Likewise an assignment's operator, a node's skill
--   requirements, and a node's shift template.
--
--   CLAIM. Under C, `app_product_on_visible_schedule(p)` implies
--   `app_can_read_owned(owner(p))`. The exception admits no row the rule
--   would not already admit, so it can be deleted rather than worked around.
--
--   PROOF. Let r be a run's node and o the owning node of its product, so
--   `o.path @> r.path` by C. Suppose the caller can read r. `app_can_read_node`
--   (migration 0012) admits exactly two ways: `app_is_admin()`, in which case
--   `app_can_read_owned` is true by its own first branch and we are done; or
--   there is a grant path g with `r.path <@ g`, i.e. `g @> r.path`. Then o and
--   g are both ancestors-or-self of r. The ancestors of a node are totally
--   ordered by `@>`, so `o <@ g OR g <@ o` — which is exactly the condition
--   `app_can_read_owned(o)` tests. ∎
--
--   Cases R18-R21 in `55_ownership_scope_test.sql` are the empirical half:
--   they build the configuration the exception used to be needed for and show
--   the row is still visible with the exception gone.
--
-- ⚠️ THE PROOF DEPENDS ON `app_can_read_node` ADMITTING ONLY `n.path <@ gp`.
-- If a future migration widens it to "either direction" — the way
-- `app_can_read_owned` reads — case B of the proof changes shape and must be
-- re-checked. It still holds (o @> r @> g makes o an ancestor of g), but that
-- is a second argument, not the same one. Do not widen either function
-- without re-reading this section.
--
-- ----------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT DONE HERE.
--
-- 1. NO DEFAULT OWNER. It is tempting to give the four tables a BEFORE INSERT
--    trigger filling `site_node_id` with the org's only root when there is
--    exactly one — it would leave ~50 existing fixture inserts untouched and
--    it would even be TRUE in a one-plant org. It is not done, and the reason
--    is the defect this migration exists because of: a client that forgets to
--    send an owner would be invisible on a one-plant database and would start
--    mis-assigning the day a second plant appeared. The owner is a required
--    choice and the schema says so out loud.
--
-- 2. NO `active` WORK. Deactivate-instead-of-delete (D110) is migration 0029.
--    `products.active` and `operators.active` already exist; `skills` and
--    `shift_templates` have no such column yet.
--
-- 3. NO STARTER LIBRARY. D111 is migration 0030.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1 BACKFILL — THE ONE DATA TRANSFORM.
--
-- Every row that is company-wide today has to become owned by something, and
-- there is exactly one org shape where the answer is not a guess: an org with
-- a single root. Anything else raises, loudly, naming the org — because
-- picking one of several plants for somebody else's data is not a migration's
-- decision to make.
--
-- ⚠️ On the fresh path (`db:reset`) this does nothing at all: migrations run
-- against an empty schema and only then does `seed.sql` insert, by which time
-- the column is NOT NULL and the seed supplies owners itself. The transform
-- runs only on a real upgrade, which is what
-- `tests/upgrade_0028_ownership_backfill.sql` exercises — see UPGRADE_CHECKS.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org uuid;
  v_root uuid;
  v_roots int;
  v_orphans int;
begin
  for v_org in
    select distinct org_id from (
      select org_id from products        where site_node_id is null
      union all select org_id from operators       where site_node_id is null
      union all select org_id from skills          where site_node_id is null
      union all select org_id from shift_templates where site_node_id is null
    ) s
  loop
    -- ⚠️ NOT `min(n.id)`: there is no `min(uuid)` aggregate in PostgreSQL, and
    -- this line only ever executes on a REAL UPGRADE -- the loop has no
    -- iterations on a fresh database, where nothing is company-wide. It shipped
    -- broken and `upgrade_0028_ownership_backfill.sql` is what found it, which
    -- is the entire argument for the UPGRADE_CHECKS rule.
    select count(*) into v_roots
      from nodes n where n.org_id = v_org and n.parent_id is null;
    select n.id into v_root
      from nodes n where n.org_id = v_org and n.parent_id is null
     order by n.path limit 1;

    if v_roots <> 1 then
      raise exception
        'migration 0028: org % has % root nodes and still holds company-wide rows. '
        'Assign every product, operator, skill and shift template to a site before upgrading; '
        'this migration will not choose a plant on your behalf.', v_org, v_roots;
    end if;

    update products        set site_node_id = v_root where org_id = v_org and site_node_id is null;
    update operators       set site_node_id = v_root where org_id = v_org and site_node_id is null;
    update skills          set site_node_id = v_root where org_id = v_org and site_node_id is null;
    update shift_templates set site_node_id = v_root where org_id = v_org and site_node_id is null;
  end loop;

  -- An owner that does not cover where the row is already used would make the
  -- constraints below unsatisfiable, so say so here rather than failing on an
  -- opaque trigger error three statements later.
  select count(*) into v_orphans
    from runs r join products p on p.id = r.product_id
    join nodes po on po.id = p.site_node_id
    join nodes rn on rn.id = r.node_id
   where not (po.path @> rn.path);
  if v_orphans > 0 then
    raise exception
      'migration 0028: % existing runs use a product whose owning site does not contain the run''s node. '
      'Re-home those products or move those runs before upgrading.', v_orphans;
  end if;

  select count(*) into v_orphans
    from assignments a join operators o on o.id = a.operator_id
    join nodes oo on oo.id = o.site_node_id
    join nodes an on an.id = a.node_id
   where not (oo.path @> an.path);
  if v_orphans > 0 then
    raise exception
      'migration 0028: % existing assignments use an operator whose owning site does not contain the assignment''s node.', v_orphans;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- §2 OWNERSHIP IS MANDATORY (D108). There is no company-wide row.
-- ---------------------------------------------------------------------------
alter table products        alter column site_node_id set not null;
alter table operators       alter column site_node_id set not null;
alter table skills          alter column site_node_id set not null;
alter table shift_templates alter column site_node_id set not null;

comment on column products.site_node_id is
  'D108/D109: the node this product belongs to. NOT NULL - there is no company-wide product. May be any node, not only a root: a product owned by Line 1 is offered on Line 1 and nowhere else.';
comment on column operators.site_node_id is
  'D108/D109: the node this operator belongs to. NOT NULL - there is no company-wide operator.';
comment on column skills.site_node_id is
  'D108/D109: the node this training belongs to. NOT NULL.';
comment on column shift_templates.site_node_id is
  'D108/D109: the node this shift pattern belongs to. NOT NULL.';

-- ---------------------------------------------------------------------------
-- §3 THE SCOPE PREDICATE.
--
-- ⚠️ SECURITY DEFINER, AND NOT AS A CONVENIENCE. This is the corollary 0026
-- §3 paid for once already: what a constraint may ASK must not depend on what
-- the writer may LIST. `nodes` is scoped by `nodes_select`, so an INVOKER
-- version would answer "the owner does not cover this node" for any owner
-- above the writer's grant — refusing legal work with an error naming the
-- wrong cause. Same failure mode as `check_eligibility` before 0026, in the
-- opposite direction.
--
-- And the 0023 review's question, asked of it: which of its parameters is a
-- tenant boundary the caller gets to choose? None — the `app_current_org()`
-- term is not a parameter, so the pair of ids must both be inside the
-- caller's own tenant for the answer to be anything but false.
-- ---------------------------------------------------------------------------
create or replace function app_owner_covers(p_owner uuid, p_node uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM nodes o, nodes n
     WHERE o.id = p_owner
       AND n.id = p_node
       AND o.org_id = app_current_org()
       AND n.org_id = app_current_org()
       AND o.path @> n.path
  );
$$;
comment on function app_owner_covers(uuid, uuid) is
  'D109: does the owning node contain (or equal) this node? The rule that makes "no product or operator can be assigned where it does not belong" true. Self-scoped to app_current_org() so it cannot be used to probe another tenant''s tree.';

-- The same question asked from a trigger, where there is no session org to
-- read: the writer may be the seed, a migration, or `service_role`. Scoped by
-- the row's own org instead.
create or replace function app_owner_covers_in_org(p_org uuid, p_owner uuid, p_node uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM nodes o, nodes n
     WHERE o.id = p_owner AND n.id = p_node
       AND o.org_id = p_org AND n.org_id = p_org
       AND o.path @> n.path
  );
$$;
comment on function app_owner_covers_in_org(uuid, uuid, uuid) is
  'Trigger-side twin of app_owner_covers: takes the row''s org rather than the session''s. Not granted to authenticated - see the revoke block at the foot of this file.';

-- ---------------------------------------------------------------------------
-- §4 "NO PRODUCT OR OPERATOR CAN BE ASSIGNED WHERE IT DOES NOT BELONG."
--
-- BEFORE ROW on each table that names both a node and an owned thing. The
-- refusal carries `not_offered_here` and a payload whose keys the client
-- parser reads by name (doc_drift rule 7: assert the code AND the shape).
-- ---------------------------------------------------------------------------
create or replace function app_guard_run_scope() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  -- ⚠️ WHOSE ERROR IS IT? If the product does not exist IN THIS ORG, that is
  -- the composite foreign key's refusal to give, not this trigger's -- and a
  -- BEFORE trigger runs first, so without this guard 10_constraints_test.sql
  -- case 6 stops testing cross-tenant stitching and starts testing me. Same
  -- rule Q6/Q9 pin between the trigger and the policy.
  select p.site_node_id into v_owner from products p
   where p.id = new.product_id and p.org_id = new.org_id;
  if not found then return new; end if;
  if not app_owner_covers_in_org(new.org_id, v_owner, new.node_id) then
    perform api_raise('not_offered_here',
      'That product does not belong to this part of the structure.',
      jsonb_build_object('kind', 'product', 'id', new.product_id,
                         'owner_node_id', v_owner, 'node_id', new.node_id));
  end if;
  return new;
end $$;

create or replace function app_guard_assignment_scope() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  -- See app_guard_run_scope: a row that is not in this org at all is the
  -- foreign key's business, not this trigger's.
  select o.site_node_id into v_owner from operators o
   where o.id = new.operator_id and o.org_id = new.org_id;
  if not found then return new; end if;
  if not app_owner_covers_in_org(new.org_id, v_owner, new.node_id) then
    perform api_raise('not_offered_here',
      'That person does not belong to this part of the structure.',
      jsonb_build_object('kind', 'operator', 'id', new.operator_id,
                         'owner_node_id', v_owner, 'node_id', new.node_id));
  end if;

  -- An assignment carries EITHER a run or a product (assignments_check), so
  -- this branch is only reached for the product-direct shape.
  if new.product_id is not null then
    select p.site_node_id into v_owner from products p
     where p.id = new.product_id and p.org_id = new.org_id;
    if not found then return new; end if;
    if not app_owner_covers_in_org(new.org_id, v_owner, new.node_id) then
      perform api_raise('not_offered_here',
        'That product does not belong to this part of the structure.',
        jsonb_build_object('kind', 'product', 'id', new.product_id,
                           'owner_node_id', v_owner, 'node_id', new.node_id));
    end if;
  end if;
  return new;
end $$;

create or replace function app_guard_node_skill_scope() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  select s.site_node_id into v_owner from skills s
   where s.id = new.skill_id and s.org_id = new.org_id;
  if not found then return new; end if;
  if not app_owner_covers_in_org(new.org_id, v_owner, new.node_id) then
    perform api_raise('not_offered_here',
      'That training does not belong to this part of the structure.',
      jsonb_build_object('kind', 'skill', 'id', new.skill_id,
                         'owner_node_id', v_owner, 'node_id', new.node_id));
  end if;
  return new;
end $$;

create or replace function app_guard_node_template_scope() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  select t.site_node_id into v_owner from shift_templates t
   where t.id = new.template_id and t.org_id = new.org_id;
  if not found then return new; end if;
  if not app_owner_covers_in_org(new.org_id, v_owner, new.node_id) then
    perform api_raise('not_offered_here',
      'That shift pattern does not belong to this part of the structure.',
      jsonb_build_object('kind', 'shift_template', 'id', new.template_id,
                         'owner_node_id', v_owner, 'node_id', new.node_id));
  end if;
  return new;
end $$;

-- An operator's home cell has to be inside the operator's own scope, or the
-- "where do they normally work" field silently contradicts the owner.
create or replace function app_guard_operator_home() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.home_node_id is not null
     and not app_owner_covers_in_org(new.org_id, new.site_node_id, new.home_node_id) then
    perform api_raise('not_offered_here',
      'That home cell is outside the site this person belongs to.',
      jsonb_build_object('kind', 'operator_home', 'id', new.id,
                         'owner_node_id', new.site_node_id, 'node_id', new.home_node_id));
  end if;
  return new;
end $$;

-- A person may only hold a training on their own branch. Without this a Plant 2
-- operator can hold a Plant 1 training, and their skill list names a row from a
-- plant they cannot see -- the same leak as the catalogue, one join further out.
-- ⚠️ EITHER DIRECTION, unlike the guards above. A Plant-1-wide person holding a
-- Line 1 training is ordinary (they are qualified for Line 1 work); a Plant 2
-- person holding a Plant 1 training is not. The test is comparability, not
-- containment.
create or replace function app_guard_operator_skill_scope() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_skill uuid; v_op uuid; v_ok boolean;
begin
  select s.site_node_id into v_skill from skills s
   where s.id = new.skill_id and s.org_id = new.org_id;
  if not found then return new; end if;
  select o.site_node_id into v_op from operators o
   where o.id = new.operator_id and o.org_id = new.org_id;
  if not found then return new; end if;

  select exists (
    select 1 from nodes a, nodes b
     where a.id = v_skill and b.id = v_op
       and a.org_id = new.org_id and b.org_id = new.org_id
       and (a.path @> b.path or b.path @> a.path)) into v_ok;
  if not v_ok then
    perform api_raise('not_offered_here',
      'That training belongs to a different part of the structure than this person.',
      jsonb_build_object('kind', 'operator_skill', 'id', new.skill_id,
                         'owner_node_id', v_skill, 'node_id', v_op));
  end if;
  return new;
end $$;

drop trigger if exists operator_skills_scope_guard on operator_skills;
create trigger operator_skills_scope_guard
  before insert or update of operator_id, skill_id on operator_skills
  for each row execute function app_guard_operator_skill_scope();

drop trigger if exists runs_scope_guard on runs;
create trigger runs_scope_guard
  before insert or update of node_id, product_id on runs
  for each row execute function app_guard_run_scope();

drop trigger if exists assignments_scope_guard on assignments;
create trigger assignments_scope_guard
  before insert or update of node_id, operator_id, product_id on assignments
  for each row execute function app_guard_assignment_scope();

drop trigger if exists node_skill_requirements_scope_guard on node_skill_requirements;
create trigger node_skill_requirements_scope_guard
  before insert or update of node_id, skill_id on node_skill_requirements
  for each row execute function app_guard_node_skill_scope();

drop trigger if exists node_shift_templates_scope_guard on node_shift_templates;
create trigger node_shift_templates_scope_guard
  before insert or update of node_id, template_id on node_shift_templates
  for each row execute function app_guard_node_template_scope();

drop trigger if exists operators_home_scope_guard on operators;
create trigger operators_home_scope_guard
  before insert or update of home_node_id, site_node_id on operators
  for each row execute function app_guard_operator_home();

-- ---------------------------------------------------------------------------
-- §5 AN OWNER CANNOT BE MOVED OUT FROM UNDER ITS OWN HISTORY.
--
-- ⭐ THE HOLE THIS CLOSES IS THE EXACT DEFECT THE MAINTAINER REPORTED, ARRIVING BY A
-- DIFFERENT DOOR. Without it, §4 is enforced at write time and never
-- re-checked: re-home a Plant 1 product to Plant 2 and every run it already
-- has becomes a foreign-owned row on a Plant 1 board — the leak restored,
-- with no insert to catch it. AFTER ROW so the new value is visible to the
-- count, and it raises rather than cascading, because moving somebody else's
-- schedule is not a side effect an ownership edit gets to have.
-- ---------------------------------------------------------------------------
create or replace function app_guard_product_rehome() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_stranded int;
begin
  select count(*) into v_stranded
    from runs r where r.product_id = new.id
     and not app_owner_covers_in_org(new.org_id, new.site_node_id, r.node_id);
  select v_stranded + count(*) into v_stranded
    from assignments a where a.product_id = new.id
     and not app_owner_covers_in_org(new.org_id, new.site_node_id, a.node_id);
  if v_stranded > 0 then
    perform api_raise('owner_change_blocked',
      'This product is already scheduled outside the site you are moving it to.',
      jsonb_build_object('kind', 'product', 'id', new.id,
                         'new_owner_node_id', new.site_node_id, 'stranded', v_stranded));
  end if;
  return null;
end $$;

create or replace function app_guard_operator_rehome() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_stranded int;
begin
  select count(*) into v_stranded
    from assignments a where a.operator_id = new.id
     and not app_owner_covers_in_org(new.org_id, new.site_node_id, a.node_id);
  if v_stranded > 0 then
    perform api_raise('owner_change_blocked',
      'This person is already assigned outside the site you are moving them to.',
      jsonb_build_object('kind', 'operator', 'id', new.id,
                         'new_owner_node_id', new.site_node_id, 'stranded', v_stranded));
  end if;
  return null;
end $$;

create or replace function app_guard_skill_rehome() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_stranded int;
begin
  select count(*) into v_stranded
    from node_skill_requirements q where q.skill_id = new.id
     and not app_owner_covers_in_org(new.org_id, new.site_node_id, q.node_id);
  if v_stranded > 0 then
    perform api_raise('owner_change_blocked',
      'This training is already required outside the site you are moving it to.',
      jsonb_build_object('kind', 'skill', 'id', new.id,
                         'new_owner_node_id', new.site_node_id, 'stranded', v_stranded));
  end if;
  return null;
end $$;

create or replace function app_guard_template_rehome() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_stranded int;
begin
  select count(*) into v_stranded
    from node_shift_templates q where q.template_id = new.id
     and not app_owner_covers_in_org(new.org_id, new.site_node_id, q.node_id);
  if v_stranded > 0 then
    perform api_raise('owner_change_blocked',
      'This shift pattern is already in use outside the site you are moving it to.',
      jsonb_build_object('kind', 'shift_template', 'id', new.id,
                         'new_owner_node_id', new.site_node_id, 'stranded', v_stranded));
  end if;
  return null;
end $$;

drop trigger if exists products_rehome_guard on products;
create trigger products_rehome_guard after update of site_node_id on products
  for each row when (old.site_node_id is distinct from new.site_node_id)
  execute function app_guard_product_rehome();

drop trigger if exists operators_rehome_guard on operators;
create trigger operators_rehome_guard after update of site_node_id on operators
  for each row when (old.site_node_id is distinct from new.site_node_id)
  execute function app_guard_operator_rehome();

drop trigger if exists skills_rehome_guard on skills;
create trigger skills_rehome_guard after update of site_node_id on skills
  for each row when (old.site_node_id is distinct from new.site_node_id)
  execute function app_guard_skill_rehome();

drop trigger if exists shift_templates_rehome_guard on shift_templates;
create trigger shift_templates_rehome_guard after update of site_node_id on shift_templates
  for each row when (old.site_node_id is distinct from new.site_node_id)
  execute function app_guard_template_rehome();

-- ---------------------------------------------------------------------------
-- §6 THE READ RULE LOSES BOTH ITS EXCEPTIONS.
--
-- One sentence, no "except": you may read a row when the node that owns it and
-- one of your grants are on the same branch, either direction. Company admins
-- read everything.
-- ---------------------------------------------------------------------------
create or replace function app_can_read_owned(p_site_node uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT app_is_admin()
      OR EXISTS (
           SELECT 1
             FROM nodes n, app_grant_paths(false) gp
            WHERE n.id = p_site_node
              AND n.org_id = app_current_org()
              AND (n.path <@ gp OR gp <@ n.path)
         );
$$;
comment on function app_can_read_owned(uuid) is
  'D107/D108: may the caller read a shared row owned by this node? The owner and one of the caller''s grants must be on the same branch, either direction. The NULL/company-wide branch was removed in 0028 - there is no company-wide row.';

drop policy products_select on products;
create policy products_select on products for select
  using (org_id = app_current_org() and app_can_read_owned(site_node_id));

drop policy operators_select on operators;
create policy operators_select on operators for select
  using (org_id = app_current_org() and app_can_read_owned(site_node_id));

-- `app_can_read_operator` fed the same exception to `operator_skills`.
create or replace function app_can_read_operator(p_operator uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (SELECT 1 FROM operators o
                  WHERE o.id = p_operator AND o.org_id = app_current_org()
                    AND app_can_read_owned(o.site_node_id));
$$;

drop function if exists app_product_on_visible_schedule(uuid);
drop function if exists app_operator_on_visible_schedule(uuid);

-- ---------------------------------------------------------------------------
-- §7 TWO JOIN TABLES WERE STILL ORG-WIDE, AND NOBODY HAD LOOKED.
--
-- Found while writing §4. `node_skill_requirements_select` and
-- `node_shift_templates_select` carried only `org_id = app_current_org()`, so
-- a Plant 2 supervisor could list which trainings Plant 1's cells require and
-- which pattern each runs — the node ids and skill ids themselves, even
-- though `nodes_select` hides the nodes they name. Small, real, and exactly
-- the class the maintainer's "irrespective of whether I'm in products or operators or
-- shifts or anything" was about.
-- ---------------------------------------------------------------------------
drop policy node_skill_requirements_select on node_skill_requirements;
create policy node_skill_requirements_select on node_skill_requirements for select
  using (org_id = app_current_org() and app_can_read_node(node_id));

drop policy node_shift_templates_select on node_shift_templates;
create policy node_shift_templates_select on node_shift_templates for select
  using (org_id = app_current_org() and app_can_read_node(node_id));

-- ---------------------------------------------------------------------------
-- §8 THE WRITE POLICIES LOSE THEIR COMPANY-WIDE BRANCH.
--
-- `(app_is_admin() OR (site_node_id IS NOT NULL AND app_is_admin_for(...)))`
-- had two jobs: let a company admin write a company-wide row, and stop
-- `app_is_admin_for(NULL)` deciding anything. Neither exists now. Re-emitted
-- rather than left dead, so the policy text states today's rule.
--
-- ⚠️ `app_is_admin_for(x)` is an admin grant on an ancestor-or-self of x, so a
-- plant admin still edits a row owned by one of their lines. That is D109
-- working, not a hole.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['products','operators','skills','shift_templates'] loop
    execute format('drop policy %I on %I', t || '_insert', t);
    execute format($f$create policy %I on %I for insert
      with check (org_id = app_current_org()
                  and (app_is_admin() or app_is_admin_for(site_node_id)))$f$, t || '_insert', t);

    execute format('drop policy %I on %I', t || '_update', t);
    execute format($f$create policy %I on %I for update
      using (org_id = app_current_org()
             and (app_is_admin() or app_is_admin_for(site_node_id)))
      with check (org_id = app_current_org()
                  and (app_is_admin() or app_is_admin_for(site_node_id)))$f$, t || '_update', t);

    execute format('drop policy %I on %I', t || '_delete', t);
    execute format($f$create policy %I on %I for delete
      using (org_id = app_current_org()
             and (app_is_admin() or app_is_admin_for(site_node_id)))$f$, t || '_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- §9 GRANTS. A migration that CREATES a function must state its own grants;
-- `create or replace` preserves them but these are new.
-- ---------------------------------------------------------------------------
revoke execute on function app_owner_covers(uuid, uuid) from public;
revoke execute on function app_owner_covers_in_org(uuid, uuid, uuid) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    -- The session-scoped one is safe to expose: it answers only about the
    -- caller's own tenant. The org-parameterised twin is NOT — it takes the
    -- tenant boundary as an argument, which is precisely the shape 0023's
    -- review named as a leak, so it stays reachable from triggers only.
    execute 'grant execute on function app_owner_covers(uuid, uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_owner_covers(uuid, uuid) from anon';
    execute 'revoke all on function app_owner_covers_in_org(uuid, uuid, uuid) from anon';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- §10 UPGRADE_CHECKS.
--
-- §1 transforms existing data, so the standing rule applies without argument:
-- `tests/upgrade_0028_ownership_backfill.sql`, added to UPGRADE_CHECKS in
-- `scripts/verify-db.sh`. It runs against a database at 0027 with no seed,
-- builds a one-plant org holding company-wide rows, applies this migration,
-- and asserts the rows came out owned by that plant and that a second-root org
-- is refused rather than guessed at.
-- ---------------------------------------------------------------------------

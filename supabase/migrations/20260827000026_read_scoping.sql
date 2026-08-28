-- ============================================================================
-- 0026 — D107: OWNERSHIP DECIDES WHO MAY READ, NOT ONLY WHO MAY EDIT
--
-- The maintainer, Aug 27, signed in as the Plant 2 site admin and looking at the
-- Products catalogue:
--
--   "why am I seeing product which is assigned to Plant 1? No member from one
--    plant should see info for other plants, this is irrespective of whether
--    I'm in products or operators or shifts or anything."
--
-- ⭐ THIS MIGRATION REVERSES A DECISION 0023 MADE ON PURPOSE. 0023's header
-- says every `_select` stays org-wide and calls that "a measured requirement,
-- not caution". The measurement was real and it is honoured in §3 below — but
-- it was an argument about ONE FUNCTION'S IMPLEMENTATION, not about the
-- product. His frame was always a read statement: each site is its own
-- instance of the app. Case Q11 in `51_shared_list_owners_test.sql` was
-- written as a tripwire to fail if anyone did this; it changes polarity here
-- and is rewritten, not deleted (verification rule 1b-ii).
--
-- ⭐ THE RULE, AND IT IS THE ONE `app_can_read_node` ALREADY IMPLEMENTS FOR
-- `runs` AND `assignments`: you may read a shared row when it is company-wide
-- (`site_node_id IS NULL`), or when its owning node and one of your grants are
-- ON THE SAME BRANCH -- either direction.
--
--     grant on Plant 1, row owned by Line 1   -> visible (owner is below you)
--     grant on Line 1,  row owned by Plant 1  -> visible (owner is above you)
--     grant on Plant 2, row owned by Plant 1  -> NOT visible
--
-- Both directions matter and only one is obvious. "Owner below you" is the
-- site admin looking down. "Owner above you" is a line supervisor who must
-- still see the plant-wide product list, or their board is empty.
--
-- ⚠️ AND A ROW YOU CAN ALREADY SEE ON A SCHEDULE STAYS READABLE. Case S18
-- pins that `board_window` must keep returning a product that is on a run,
-- wherever it belongs -- "narrowing what is OFFERED must not un-schedule
-- history". Without §2's second clause every historical band on the board
-- renders "(unknown product)", and `BoardGrid`'s colour lookup falls through
-- to the first palette token, so they all collapse to one colour. Offering is
-- not listing and listing is not naming; this migration only narrows LISTING.
--
-- ⭐ WHAT THIS MIGRATION DELIBERATELY DOES NOT TOUCH, AND WHY:
--   `hierarchy_templates` / `hierarchy_levels`. 0020 §5 left those org-wide on
--   purpose so the shape picker and `editable_shape_ids()` work, and a
--   structure's NAME is a much weaker signal than a plant's product list --
--   `nodes_select` already hides every node of another site. Narrowing it is a
--   separate decision with its own screen to re-check, and bundling it here
--   would make this migration's mutation table unreadable. Recorded as open.
--
--   `user_profiles` / `profile_grants`. 0020 and 0022 already scope both.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1 THE PREDICATES
--
-- ⚠️ ALL SECURITY DEFINER, AND THE 0023 REVIEW'S QUESTION HAS TO BE ASKED OF
-- EACH: "which of its parameters is a tenant boundary the caller gets to
-- choose?" The answer here is none. Every one of these takes an id and returns
-- a fact ABOUT THE CALLER -- may *I* read this -- computed from
-- `app_current_org()` and `app_grant_paths()`, both of which read the session
-- and cannot be passed in. Probing an id from another tenant returns false via
-- the `org_id` term, and probing one inside your own org tells you only what
-- `nodes_select` would already tell you.
-- ---------------------------------------------------------------------------

create or replace function app_can_read_owned(p_site_node uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT p_site_node IS NULL
      OR app_is_admin()
      OR EXISTS (
           SELECT 1
             FROM nodes n, app_grant_paths(false) gp
            WHERE n.id = p_site_node
              AND n.org_id = app_current_org()
              AND (n.path <@ gp OR gp <@ n.path)
         );
$$;
comment on function app_can_read_owned(uuid) is
  'D107: may the caller read a shared row owned by this node? NULL owner = company-wide = yes. Otherwise the owner and one of the caller''s grants must be on the same branch, either direction.';

-- A product that appears on a run or an assignment the caller can already see
-- stays readable, or the board cannot name its own history. See case S18.
create or replace function app_product_on_visible_schedule(p_product uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (SELECT 1 FROM runs r
                  WHERE r.product_id = p_product AND app_can_read_node(r.node_id))
      OR EXISTS (SELECT 1 FROM assignments a
                  WHERE a.product_id = p_product AND app_can_read_node(a.node_id));
$$;

create or replace function app_operator_on_visible_schedule(p_operator uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (SELECT 1 FROM assignments a
                  WHERE a.operator_id = p_operator AND app_can_read_node(a.node_id));
$$;

-- Dependent tables ask about their PARENT rather than repeating the rule.
-- `operator_skills` got no owner column of its own in 0023 for exactly this
-- reason: a row joining a Plant-1 operator to a company-wide skill has no
-- derivable owner, so it follows the OPERATOR.
create or replace function app_can_read_operator(p_operator uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (SELECT 1 FROM operators o
                  WHERE o.id = p_operator AND o.org_id = app_current_org()
                    AND (app_can_read_owned(o.site_node_id)
                         OR app_operator_on_visible_schedule(o.id)));
$$;

create or replace function app_can_read_shift_template(p_template uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (SELECT 1 FROM shift_templates t
                  WHERE t.id = p_template AND t.org_id = app_current_org()
                    AND app_can_read_owned(t.site_node_id));
$$;

create or replace function app_can_read_shift(p_shift uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (SELECT 1 FROM shifts s
                  WHERE s.id = p_shift AND s.org_id = app_current_org()
                    AND app_can_read_shift_template(s.template_id));
$$;

-- ---------------------------------------------------------------------------
-- §2 THE POLICIES
-- Every one keeps its `org_id = app_current_org()` term. The tenant boundary
-- is not being replaced by the site boundary; the site boundary is being added
-- INSIDE it.
-- ---------------------------------------------------------------------------

drop policy products_select on products;
create policy products_select on products for select
  using (org_id = app_current_org()
         and (app_can_read_owned(site_node_id) or app_product_on_visible_schedule(id)));

drop policy operators_select on operators;
create policy operators_select on operators for select
  using (org_id = app_current_org()
         and (app_can_read_owned(site_node_id) or app_operator_on_visible_schedule(id)));

drop policy skills_select on skills;
create policy skills_select on skills for select
  using (org_id = app_current_org() and app_can_read_owned(site_node_id));

drop policy operator_skills_select on operator_skills;
create policy operator_skills_select on operator_skills for select
  using (org_id = app_current_org() and app_can_read_operator(operator_id));

drop policy shift_templates_select on shift_templates;
create policy shift_templates_select on shift_templates for select
  using (org_id = app_current_org() and app_can_read_owned(site_node_id));

drop policy shifts_select on shifts;
create policy shifts_select on shifts for select
  using (org_id = app_current_org() and app_can_read_shift_template(template_id));

drop policy shift_breaks_select on shift_breaks;
create policy shift_breaks_select on shift_breaks for select
  using (org_id = app_current_org() and app_can_read_shift(shift_id));

-- ---------------------------------------------------------------------------
-- §3 `check_eligibility` STOPS ANSWERING FROM WHAT THE CALLER CAN LIST
-- Extracted with `pg_get_functiondef` from a live database built from every
-- migration in order (rule 12: never from the migration that first wrote it),
-- then two changes applied by string replacement -- SECURITY DEFINER, and the
-- gate. Nothing else in the body is touched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_eligibility(p_node_id uuid, p_operator_id uuid, p_timerange tstzrange)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org_id uuid;
  v_policy text;
  v_result jsonb;
BEGIN
  -- ⭐⭐ THE GATE THIS FUNCTION NEVER HAD, AND IT IS WHY 0023 COULD NOT NARROW
  -- THE READS. Until now this was SECURITY INVOKER and read `skills`,
  -- `operator_skills` AND `nodes` AS THE CALLER, so its answer depended on what
  -- the caller could LIST rather than on what is true. Two consequences, one of
  -- them live before this migration:
  --
  --   (a) 0023's stated hazard: narrow `skills`/`operator_skills` and a skill
  --       the caller cannot see drops out of `held`, lands in `missing`, flips
  --       `eligible` to false, and `create_assignment` refuses -- silently.
  --
  --   (b) ⚠️ THE ONE THAT WAS ALREADY BROKEN AND NOBODY HAD LOOKED: `required`
  --       walks ANCESTORS through `nodes`, which 0020 already scoped. A
  --       supervisor granted Assembly cannot read the Plant 1 root, so a skill
  --       requirement placed on the root DROPPED OUT OF THEIR ANSWER. Measured
  --       on a seeded database, same cell, same operator, same instant: the
  --       company admin got `eligible=false, missing=[CNC]` and Ana the
  --       supervisor got `eligible=true, missing=[]`. A SAFETY CHECK THAT
  --       FAILS OPEN FOR EXACTLY THE PEOPLE WHO USE IT MOST.
  --
  -- So the fix is not "keep the tables readable". It is that what this function
  -- may ASK about must stop depending on what its caller may LIST. DEFINER, and
  -- one explicit gate: you must be able to see the NODE you are asking about.
  -- `app_can_read_node` is the same predicate `runs_select` uses, so this
  -- refuses exactly when reading the run would have refused.
  IF NOT app_can_read_node(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'you cannot see that place',
      jsonb_build_object('field', 'p_node_id', 'reason', 'node not readable'));
  END IF;

  SELECT org_id INTO v_org_id FROM nodes WHERE id = p_node_id;
  SELECT COALESCE(o.settings->>'eligibility_policy', 'warn') INTO v_policy
    FROM orgs o WHERE o.id = v_org_id;

  WITH required AS (
    SELECT DISTINCT nsr.skill_id
    FROM nodes target
    JOIN nodes anc ON target.path <@ anc.path AND anc.org_id = target.org_id
    JOIN node_skill_requirements nsr ON nsr.node_id = anc.id
    WHERE target.id = p_node_id
  ),
  held AS (
    SELECT os.skill_id, os.expires_at
    FROM operator_skills os
    WHERE os.operator_id = p_operator_id
  ),
  missing AS (
    SELECT r.skill_id FROM required r
    WHERE NOT EXISTS (SELECT 1 FROM held h WHERE h.skill_id = r.skill_id)
  ),
  expiring AS (
    -- An unbounded upper bound on the window counts as expiring for any
    -- non-null expires_at (brief §4): there is no finite date to compare
    -- against, so any real expiry falls "inside" an open-ended window.
    SELECT r.skill_id, h.expires_at
    FROM required r
    JOIN held h ON h.skill_id = r.skill_id
    WHERE h.expires_at IS NOT NULL
      AND (upper_inf(p_timerange) OR h.expires_at < upper(p_timerange)::date)
  )
  SELECT jsonb_build_object(
    'eligible', (SELECT count(*) FROM missing) = 0 AND (SELECT count(*) FROM expiring) = 0,
    'policy', v_policy,
    'missing_skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name))
      FROM missing m JOIN skills s ON s.id = m.skill_id
    ), '[]'::jsonb),
    'expiring_skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'expires_at', e.expires_at))
      FROM expiring e JOIN skills s ON s.id = e.skill_id
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;


-- ---------------------------------------------------------------------------
-- §4 GRANTS
-- ⚠️ A GRANT IS A THING PEOPLE DELETE, so each one is stated rather than
-- inherited (0023's Q35 is the case that taught this). The predicates are
-- callable by `authenticated` because the POLICIES call them as the caller;
-- none of them is useful to call directly, and none answers a question about
-- anyone but the caller.
-- ---------------------------------------------------------------------------
revoke execute on function app_can_read_owned(uuid)                from public;
revoke execute on function app_product_on_visible_schedule(uuid)   from public;
revoke execute on function app_operator_on_visible_schedule(uuid)  from public;
revoke execute on function app_can_read_operator(uuid)             from public;
revoke execute on function app_can_read_shift_template(uuid)       from public;
revoke execute on function app_can_read_shift(uuid)                from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_can_read_owned(uuid)               to authenticated';
    execute 'grant execute on function app_product_on_visible_schedule(uuid)  to authenticated';
    execute 'grant execute on function app_operator_on_visible_schedule(uuid) to authenticated';
    execute 'grant execute on function app_can_read_operator(uuid)            to authenticated';
    execute 'grant execute on function app_can_read_shift_template(uuid)      to authenticated';
    execute 'grant execute on function app_can_read_shift(uuid)               to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_can_read_owned(uuid)               from anon';
    execute 'revoke all on function app_product_on_visible_schedule(uuid)  from anon';
    execute 'revoke all on function app_operator_on_visible_schedule(uuid) from anon';
    execute 'revoke all on function app_can_read_operator(uuid)            from anon';
    execute 'revoke all on function app_can_read_shift_template(uuid)      from anon';
    execute 'revoke all on function app_can_read_shift(uuid)               from anon';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- §5 WHY THERE IS NO `UPGRADE_CHECKS` ROW FOR THIS MIGRATION
--
-- The standing rule is that any migration which TRANSFORMS EXISTING DATA needs
-- a row in `scripts/verify-db.sh`'s UPGRADE_CHECKS, because the numbered suite
-- runs against `db:reset` and can only ever see the fresh path. This migration
-- transforms no data: it creates six functions, replaces seven policies and
-- replaces one function body. There is no backfill, no DEFAULT, no ALTER TABLE
-- and no row is written. An upgrade test would assert the same thing the fresh
-- run already asserts, against the same rows.
--
-- ⚠️ Stated rather than assumed, because 0023 §9 talked itself out of an
-- upgrade test with a plausible paragraph and the test, written anyway, found
-- that the palette shipped 8 tokens against a stylesheet defining 4. The
-- difference here is the one that matters: 0023 HAD a backfill and this has
-- none. If a later change to this migration adds one, this note is void.
--
-- What DOES need saying: this migration is a NARROWING, and 0023's was a
-- widening. A widening cannot regress a permission and the only way to get it
-- wrong is to hand out too much. A narrowing can take away something someone
-- was relying on, so every case in `53_read_scoping_test.sql` that asserts a
-- refusal is paired with one asserting the thing that must STILL work:
-- R1/R2, R1/R3, R4's two halves, R9/R10/R11, and R15 for writes.
-- ---------------------------------------------------------------------------

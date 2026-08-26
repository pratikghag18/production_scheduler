-- ============================================================================
-- 20260826000021_site_membership.sql
--
-- "A site admin may add people to their site and set that person's role
--  there." — settled Aug 26, recorded in [[site-instance-model]].
--
-- 0020 §9 made that TRUE and left it UNREACHABLE, and said so in writing:
--
--     "`user_profiles_select` is still `own row, or company admin`, so a site
--      admin can WRITE a grant for a person they cannot READ. Everything in
--      this section works -- the foreign key resolves with RLS out of the way
--      -- but a UI cannot offer a person picker yet. That is
--      `add_site_member`, the next RPC after this migration, and it is where
--      the reciprocal read is designed rather than bolted on here."
--
-- This migration is that reciprocal read, plus the two writes whose refusal
-- would otherwise be SILENT.
--
-- ⭐ IT ADDS NO COLUMN, NO TABLE, NO POLICY AND NO TRIGGER. It transforms no
-- existing data, so it needs NO row in verify-db.sh's UPGRADE_CHECKS and no
-- `upgrade_0021_*.sql` -- stated here so the absence is a decision on the
-- record rather than something skipped. Everything below is a function.
--
-- ----------------------------------------------------------------------------
-- WHAT A SITE ADMIN CAN SEE ABOUT PEOPLE, AND WHY IT IS THE WHOLE COMPANY.
--
-- To put someone on their plant, a site admin has to be able to FIND them.
-- The people in this product are colleagues in one company, not strangers, and
-- the only thing the system knows about a person is their sign-in email --
-- `user_profiles` carries no name, and `auth.users.raw_user_meta_data` is `{}`
-- in this project's own seed. So the picker shows emails.
--
-- The exposure is bounded by an ACTION rather than by a standing privilege:
-- `site_people` answers only for a node the caller already administers, and
-- being able to administer a place is exactly the thing that makes "who works
-- here" the caller's business. There is no new standing visibility --
-- `user_profiles_select` is untouched, still `own row, or company admin`, and
-- a caller who administers nothing gets `not_permitted` from every function
-- here.
--
-- ⚠️ THE ALTERNATIVE WAS WIDENING `user_profiles_select`, AND IT IS WORSE FOR
-- A SPECIFIC REASON: **RLS filters rows, not columns** (gotcha 21, learned the
-- hard way in 0020). A policy cannot hand out the email and withhold
-- `user_profiles.role` -- the company-wide admin flag -- because a policy has
-- no say over columns at all. A function chooses its projection explicitly.
-- That is the argument for a function here and it is not a style preference.
--
-- ----------------------------------------------------------------------------
-- WHY THERE ARE TWO WRITE FUNCTIONS AND NOT FOUR, AND WHY THERE ARE ANY.
--
-- `docs/api.md` §4 is the house rule and it decides this:
--
--     "An RPC exists only where the operation needs to touch more than one row
--      atomically, needs a pre-write permission check ahead of RLS to avoid a
--      silent zero-row result, or is a pure read aggregation."
--
--   site_people ......... pure read aggregation.                    -> RPC
--   set_site_member ..... a refused UPDATE returns ZERO ROWS AND NO ERROR.
--                         A site admin editing somebody else's site would see
--                         the screen shrug.                         -> RPC
--   remove_site_member .. same, for DELETE.                         -> RPC
--   everything else ..... a plain PostgREST write, guarded by the 0020
--                         policies, exactly like a run's `notes`.
--
-- Adding and re-roling are ONE function because they are one row:
-- `profile_grants` is keyed `(profile_id, node_id)`, so "give Dana admin here"
-- and "make Dana a viewer here" differ only in whether the row already exists.
-- Two RPCs would be two guards to keep in step for one primary key.
--
-- ⚠️ AND THE PRE-CHECK IS NOT A DUPLICATE OF RLS, which gotcha 17 would
-- otherwise condemn. Delete it and the refusal still happens -- as a raw
-- `42501 new row violates row-level security policy`, which reaches the user
-- as a database error instead of "you don't administer that site". **The
-- mutation is caught because the SHAPE of the refusal changes**, and case X16
-- asserts the shape -- `PT403` and a typed detail, not merely "it was refused" --
-- because "it was refused" is green against the deletion. Same reasoning that
-- made 0020's §8.0 existence lookup worth having.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- §1. `app_profile_exists_in_org` — the twin of 0020 §8.0's node lookup.
--
-- Tells "no such person" from "not yours" for a caller who cannot SELECT
-- `user_profiles` at all. Org-scoped internally, grants nothing, and answers
-- only a boolean -- the same three properties that make `app_node_exists_in_org`
-- safe.
--
-- ⚠️ IT IS DELIBERATELY CALLED *AFTER* THE PERMISSION CHECK in §3 and §4, which
-- inverts 0020 §8's "existence first, then permission" ordering. That ordering
-- exists so a caller who may act on a node is told the node is missing rather
-- than being told they lack permission for something that is not there. Here
-- the subject is a PERSON, and "does an account for this address exist in the
-- company" is not a question an outsider gets to ask. A caller who administers
-- the node is not an outsider; a caller who does not is refused before the
-- lookup runs. Case X25 pins that order, and X24 pins the refusal it guards.
-- ----------------------------------------------------------------------------
create or replace function app_profile_exists_in_org(p_profile_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles up
     WHERE up.id = p_profile_id AND up.org_id = app_current_org()
  );
$$;

comment on function app_profile_exists_in_org(uuid) is
  'Does this profile exist in the caller''s org, regardless of whether the caller can SEE it (0021 §1)? The twin of app_node_exists_in_org. Grants nothing, org-scoped internally. Call it AFTER the permission check, never before -- see the migration comment.';


-- ----------------------------------------------------------------------------
-- §2. `editable_shape_ids` — the shape picker's filter.
--
-- THE ROUGH EDGE THIS CLOSES, named in §19.47 and left open on purpose: the
-- admin screen lists EVERY structure in the company, because
-- `hierarchy_templates_select` is org-wide and 0020 §5 kept it that way
-- deliberately. A site admin therefore sees five plants' structures, picks the
-- wrong one, edits a level name and gets a correct `not_permitted` for
-- something the screen offered them. The refusal is right; the offer was wrong.
--
-- ⚠️ THE FIX IS A FILTER ON THE SCREEN, NOT A NARROWING OF THE POLICY, and
-- 0020 §5 already wrote down why: a structure's name and level list are not
-- secrets, the nodes inside a site are, and `nodes_select` governs those. This
-- function does not restrict anything -- it ANSWERS a question the client
-- cannot compute, and the client uses the answer to decide what to offer.
-- shapePicker.ts's own header states the invariant this obeys: anything the
-- client hides, the server must also refuse. It does -- that is 0020's W6/W7.
--
-- SECURITY **INVOKER**, on purpose. The whole predicate it needs is already
-- `app_is_admin_for_template`, which is SECURITY DEFINER and carries its own
-- org scope; wrapping an invoker query around it adds no privilege and leaves
-- RLS on `hierarchy_templates` in force underneath. A DEFINER wrapper here
-- would be a new privilege surface bought for nothing -- and gotcha 22 is the
-- standing reminder that DEFINER is never free.
--
-- ⛔ AND IT DOES NOT CARRY ITS OWN ORG TERM, WHICH THE FIRST DRAFT DID AND
-- ONLY THE MUTATION RUN SHOWED TO BE POINTLESS. The argument for it was the
-- usual one -- verification rule 10 runs isolation cases as the TABLE OWNER,
-- where RLS is off and an org term is the only scope left. Measured, mutation
-- Y3 (`t.org_id = app_current_org()` deleted) was **NOT CAUGHT**, because
-- `app_is_admin_for_template` is SECURITY DEFINER and carries the org scope
-- itself -- 0020's W3 is the case that proves it, and it refuses org 2's
-- structure before this query ever sees the row. A second copy of a check
-- that always runs first cannot be mutation-tested (gotcha 17), so it is gone
-- rather than kept with an unfalsifiable justification. X3 stays and now
-- tests the COMPOSITION -- with RLS off, this function still never reports
-- another tenant's structure.
--
-- Returns a jsonb ARRAY, not `setof uuid`. Every client-facing read in this
-- project returns jsonb (`board_window`, `capacity_probe`, `check_eligibility`);
-- `setof` is reserved for the internal `app_grant_paths*` helpers, which no
-- client calls. `'[]'::jsonb` when there is nothing, never NULL -- a client
-- that has to distinguish "no shapes" from "the call failed" will eventually
-- fail to.
-- ----------------------------------------------------------------------------
create or replace function editable_shape_ids() returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  SELECT coalesce(jsonb_agg(t.id ORDER BY t.id), '[]'::jsonb)
    FROM hierarchy_templates t
   WHERE app_is_admin_for_template(t.id);
$$;

comment on function editable_shape_ids() is
  'The ids of the structures the caller may edit (0021 §2) -- every structure in the org for a company admin, their own site''s for a site admin. A PREVIEW for the shape picker: it restricts nothing, and hierarchy_templates_select stays org-wide on purpose (0020 §5).';


-- ----------------------------------------------------------------------------
-- §3. `site_people` — the reciprocal read 0020 §9 promised.
--
-- One row per person in the company, each carrying the grants they hold
-- INSIDE this node's subtree. The client buckets them: somebody with a grant
-- (or the company-admin flag) already has access; everybody else is a
-- candidate for the picker. **The server does not bucket**, because the moment
-- it does, "already has access" is a rule in two places.
--
-- WHY THE SUBTREE AND NOT THE NODE. A grant covers its subtree downward, so
-- the people who can reach Plant 1 include the admin of Assembly inside it.
-- Listing only grants whose `node_id` equals the node asked about would show a
-- site admin an empty list on a plant that four people can already edit --
-- which is worse than useless, it is misleading. `n.path <@ v_path` is the
-- same containment 0019's `app_grant_paths` uses, and each grant carries its
-- own node's name so the screen can say WHERE the access sits.
--
-- ⚠️ THE `org_id` TERMS IN THE GRANT SUBQUERY ARE EXECUTED AND INERT, AND
-- THEY STAY. `gn.path <@ v_path` looks like enough, and it is not: 0012's
-- lesson is that a path is unique only per `(org_id, path)`, so org 2 has its
-- own `plant_1.assembly` and it is contained in `plant_1` just as well.
-- Mutation Y12 removed both terms and was NOT CAUGHT -- MEASURED, and the
-- masking is a FOREIGN KEY IN ANOTHER MIGRATION: `profile_grants` carries
-- `(org_id, profile_id)` and `(org_id, node_id)` composite FKs (0006's D3
-- idiom), so a row pairing this org's person with another org's node cannot
-- exist to be found. **Case X39 pins that impossibility directly**, the way
-- 0020 §9 pinned its shadowed UPDATE clause: relax the FK and X39 goes red
-- and points here, instead of a cross-tenant leak appearing quietly.
--
-- ⚠️ A COMPANY ADMIN HAS NO GRANT AND CAN STILL REACH EVERY SITE. `companyAdmin`
-- is returned so the screen can say so instead of listing them under "no
-- access" beside a button that would do nothing for them. Case X8.
--
-- SECURITY DEFINER is unavoidable: `auth.users` is not readable by
-- `authenticated`, and the email is the only human-readable thing this system
-- knows about a person. The projection is written out column by column -- id,
-- email, org role, admin flag, grants -- which is precisely what a POLICY
-- could not have done (gotcha 21). It reads no session variable other than
-- through the `app_*` helpers, and nothing here consults `current_user`
-- (gotcha 22).
--
-- ORDER: `email COLLATE "C"`, tie-broken by profile id. Named collation, never
-- the database default, for migration 0011's reason -- a collation-dependent
-- comparison gave two machines two answers once already. The client sorts the
-- same way for the same reason; both are code-point order, so they cannot
-- disagree.
--
-- KNOWN LIMIT, RECORDED NOT CLOSED (rule 5): the list is UNBOUNDED. An org of
-- ten thousand people returns ten thousand rows. There is no `LIMIT` and no
-- search parameter, deliberately -- a silent cap would make a person missing
-- from the picker look like a person who does not exist. When it needs one it
-- gets a `p_search` argument and a documented bound, not a quiet `LIMIT 100`.
-- ----------------------------------------------------------------------------
create or replace function site_people(p_node_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
DECLARE
  v_path ltree;
  v_name text;
  v_org  uuid;
  v_people jsonb;
BEGIN
  IF NOT app_node_exists_in_org(p_node_id) THEN
    PERFORM api_raise('invalid_argument', 'no such node',
                      jsonb_build_object('node_id', p_node_id, 'reason', 'not found'));
  END IF;

  IF NOT app_is_admin_for(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'you do not administer this place',
                      jsonb_build_object('node_id', p_node_id));
  END IF;

  v_org := app_current_org();
  SELECT n.path, n.name INTO v_path, v_name FROM nodes n WHERE n.id = p_node_id;

  SELECT coalesce(jsonb_agg(p ORDER BY p->>'email' COLLATE "C", p->>'profileId'), '[]'::jsonb)
    INTO v_people
    FROM (
      SELECT jsonb_build_object(
               'profileId',    up.id,
               'email',        u.email,
               'orgRole',      up.role,
               'companyAdmin', (up.role = 'admin'),
               'grants',       coalesce((
                 SELECT jsonb_agg(jsonb_build_object(
                          'nodeId',   gn.id,
                          'nodeName', gn.name,
                          'role',     pg.role)
                        ORDER BY gn.path, pg.role)
                   FROM profile_grants pg
                   JOIN nodes gn ON gn.id = pg.node_id
                  WHERE pg.profile_id = up.id
                    AND pg.org_id     = v_org
                    AND gn.org_id     = v_org
                    AND gn.path <@ v_path
               ), '[]'::jsonb)
             ) AS p
        FROM user_profiles up
        LEFT JOIN auth.users u ON u.id = up.user_id
       WHERE up.org_id = v_org
    ) s;

  RETURN jsonb_build_object(
    'nodeId',   p_node_id,
    'nodeName', v_name,
    'people',   v_people
  );
END $$;

comment on function site_people(uuid) is
  'Everyone in the company, each with the grants they hold inside this node''s subtree (0021 §3). Refuses unless the caller administers p_node_id. The reciprocal read 0020 §9 named: a site admin could already WRITE a grant for a person they could not READ. LEFT JOIN on auth.users so a profile whose auth row is missing still appears, with a null email.';


-- ----------------------------------------------------------------------------
-- §4. `set_site_member` — add a person here, or change the role they hold here.
--
-- ORDER OF CHECKS, and each one is a different sentence to the user:
--   1. does the node exist in this company?     -> invalid_argument
--   2. does the caller administer it?           -> not_permitted
--   3. does the person exist in this company?   -> invalid_argument   (§1's note)
--   4. is the role one of the three?            -> invalid_argument
--   5. is the caller demoting THEMSELVES here?  -> not_permitted
--   6. the write, then the OUTCOME check.
--
-- ⭐ 5 IS A PRODUCT RULE, NOT A SAFETY ONE, AND IT IS HERE TO BE DELETED
-- DELIBERATELY IF HE DISAGREES. A site admin who sets their own role on their
-- own site to `viewer` loses the screen they are standing on and cannot undo
-- it -- only a company admin can put it back.
--
-- ⚠️ IT IS NARROWER THAN "you may not change your own row", and the narrowing
-- is the whole rule: it fires only when the row being changed is the one
-- currently granting the caller `admin` ON THIS EXACT NODE. Adding yourself as
-- a viewer somewhere inside your own site takes nothing away -- the strongest
-- covering grant wins (0019), so your admin grant on the site above still
-- decides -- and refusing it would be refusing a harmless thing with a
-- frightening message. **The first draft of this function was the broad
-- version and its own comment already described the narrow one**; rule 17,
-- caught by reading them side by side. Case X24 is the harmless change that
-- must be ALLOWED, and it is the case the broad version fails.
--
-- A company admin is exempt: they can always reach the row again.
-- Case X22 asserts the refusal on purpose, the way 0020's W24 does, so
-- removing the rule means removing a case on purpose.
--
-- SECURITY **INVOKER**: the 0020 policies are the real gate and this function
-- must not be able to write a row they would refuse. The pre-check exists to
-- shape the refusal (see the header), not to authorise anything -- if the two
-- ever disagree, RLS wins and the outcome check turns that into a refusal
-- rather than a lie.
--
-- ⛔ THERE WAS AN OUTCOME CHECK HERE AND THE MUTATION RUN DELETED IT.
-- Rule 7b says to read the row back and compare rather than trust the
-- statement -- and D92 earned that rule. It does not apply to this write, and
-- mutation Y27 is what showed it: removing the check entirely was **NOT
-- CAUGHT**, because there is no reachable state in which it fires. The
-- pre-check has already established `app_is_admin_for(p_node_id)`, and the
-- INSERT policy, the UPDATE USING clause and the UPDATE WITH CHECK clause are
-- all that identical predicate; if any of them disagreed, RLS would RAISE
-- rather than write a wrong row, and 42501 is not something a read-back can
-- turn into a better message.
--
-- ⚠️ THE DISTINCTION WORTH KEEPING, because it is the reason this RPC exists
-- at all: **rule 7b is for writes that can do nothing QUIETLY.** A refused
-- INSERT is loud. A refused DELETE is silent, which is api.md §4's stated
-- reason for `remove_site_member` -- and the thing that makes it loud there is
-- the PRE-check, not a post-check (§5 says so, having deleted its own).
--
-- The row is still read back, because the honest thing to return is what is
-- actually stored rather than an echo of the argument.
-- ----------------------------------------------------------------------------
create or replace function set_site_member(
  p_node_id    uuid,
  p_profile_id uuid,
  p_role       text
) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
DECLARE
  v_org   uuid;
  v_after text;
BEGIN
  IF NOT app_node_exists_in_org(p_node_id) THEN
    PERFORM api_raise('invalid_argument', 'no such node',
                      jsonb_build_object('node_id', p_node_id, 'reason', 'not found'));
  END IF;

  IF NOT app_is_admin_for(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'you do not administer this place',
                      jsonb_build_object('node_id', p_node_id));
  END IF;

  IF NOT app_profile_exists_in_org(p_profile_id) THEN
    PERFORM api_raise('invalid_argument', 'no such person',
                      jsonb_build_object('profile_id', p_profile_id, 'reason', 'not found'));
  END IF;

  IF p_role IS NULL OR p_role NOT IN ('admin', 'supervisor', 'viewer') THEN
    PERFORM api_raise('invalid_argument', 'unknown role',
                      jsonb_build_object('field', 'role', 'value', p_role));
  END IF;

  IF p_profile_id = app_current_profile_id()
     AND p_role <> 'admin'
     AND NOT app_is_admin()
     AND EXISTS (SELECT 1 FROM profile_grants pg
                  WHERE pg.profile_id = p_profile_id
                    AND pg.node_id    = p_node_id
                    AND pg.role       = 'admin') THEN
    PERFORM api_raise('not_permitted', 'you cannot take away your own admin access here',
                      jsonb_build_object('node_id', p_node_id, 'profile_id', p_profile_id,
                                         'reason', 'self'));
  END IF;

  v_org := app_current_org();

  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
       VALUES (p_profile_id, p_node_id, v_org, p_role)
  ON CONFLICT (profile_id, node_id) DO UPDATE SET role = EXCLUDED.role;

  SELECT pg.role INTO v_after
    FROM profile_grants pg
   WHERE pg.profile_id = p_profile_id AND pg.node_id = p_node_id;

  RETURN jsonb_build_object(
    'nodeId',    p_node_id,
    'profileId', p_profile_id,
    'role',      v_after
  );
END $$;

comment on function set_site_member(uuid, uuid, text) is
  'Give a person a role on this node''s subtree, or change the role they already hold there (0021 §4). One row, so adding and re-roling are one function. Refuses unless the caller administers the node; refuses a site admin removing their OWN access here. The row is read back so the returned role is what is stored, not an echo of the argument.';


-- ----------------------------------------------------------------------------
-- §5. `remove_site_member` — take a person's access to this place away.
--
-- The one that most needs to exist. `DELETE` under RLS deletes the rows the
-- USING clause admits and returns success for the rest -- **a refused delete
-- is a silent no-op**, and a screen wired straight to PostgREST would remove
-- the row from the list, refetch, and put it back with no explanation. That is
-- api.md §4's "silent zero-row result" verbatim.
--
-- It is NOT idempotent-quiet: removing access that is not there is
-- `invalid_argument`, not a shrug. Two admins with the same screen open should
-- not both be told they succeeded. Case X20.
--
-- The self-rule of §4 applies here, narrowed identically: only an `admin` row
-- of the caller's own, on this exact node, is protected. It is checked AFTER
-- the not-found check, because "there is nothing here to remove" is the truer
-- sentence when both are true.
-- ----------------------------------------------------------------------------
create or replace function remove_site_member(
  p_node_id    uuid,
  p_profile_id uuid
) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
DECLARE
  v_before text;
BEGIN
  IF NOT app_node_exists_in_org(p_node_id) THEN
    PERFORM api_raise('invalid_argument', 'no such node',
                      jsonb_build_object('node_id', p_node_id, 'reason', 'not found'));
  END IF;

  IF NOT app_is_admin_for(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'you do not administer this place',
                      jsonb_build_object('node_id', p_node_id));
  END IF;

  SELECT pg.role INTO v_before
    FROM profile_grants pg
   WHERE pg.profile_id = p_profile_id AND pg.node_id = p_node_id;

  IF v_before IS NULL THEN
    PERFORM api_raise('invalid_argument', 'that person has no access here to remove',
                      jsonb_build_object('node_id', p_node_id, 'profile_id', p_profile_id,
                                         'reason', 'not found'));
  END IF;

  -- §4's rule, in its strongest form and narrowed the same way: only the grant
  -- that currently makes the caller an admin OF THIS NODE is protected.
  -- Dropping a viewer or supervisor row of their own is harmless and allowed.
  IF p_profile_id = app_current_profile_id()
     AND NOT app_is_admin()
     AND v_before = 'admin' THEN
    PERFORM api_raise('not_permitted', 'you cannot take away your own admin access here',
                      jsonb_build_object('node_id', p_node_id, 'profile_id', p_profile_id,
                                         'reason', 'self'));
  END IF;

  -- ⛔ AND THERE IS NO OUTCOME CHECK AFTER THIS, FOR THE REASON §4 RECORDS.
  -- Mutation Y33 deleted one and was NOT CAUGHT: by the time this line runs,
  -- the pre-check has established `app_is_admin_for(p_node_id)` AND the row
  -- was readable, and `profile_grants_delete`'s USING clause is that same
  -- predicate -- so the DELETE cannot be the thing that quietly does nothing.
  -- **What makes a refused removal loud here is the PRE-check.** That is the
  -- whole reason this function exists instead of a PostgREST `DELETE`, and
  -- case X28 is where it is measured -- it asserts the typed refusal AND that
  -- the row survived.
  DELETE FROM profile_grants
   WHERE profile_id = p_profile_id AND node_id = p_node_id;

  RETURN jsonb_build_object(
    'nodeId',      p_node_id,
    'profileId',   p_profile_id,
    'removedRole', v_before
  );
END $$;

comment on function remove_site_member(uuid, uuid) is
  'Take away the access a person holds on this exact node (0021 §5). Refuses unless the caller administers the node, refuses removing your own access, and refuses when there is nothing to remove -- a refused DELETE under RLS is otherwise a silent no-op, and the PRE-check is what makes it loud (§5).';


-- ----------------------------------------------------------------------------
-- §6. Grants.
--
-- `REVOKE ... FROM PUBLIC` first, every time: PostgreSQL grants EXECUTE on a
-- new function to PUBLIC by default, unlike tables. api.md §6.2 records this
-- as a deviation found the hard way, and 0020 §8.0 repeats the idiom.
--
-- The role guards exist because this file runs against the test harness, which
-- creates `authenticated`/`anon`, AND against a real Supabase project, which
-- already has them -- and against neither during a bare `psql` bootstrap.
-- ----------------------------------------------------------------------------
revoke execute on function app_profile_exists_in_org(uuid) from public;
revoke execute on function editable_shape_ids() from public;
revoke execute on function site_people(uuid) from public;
revoke execute on function set_site_member(uuid, uuid, text) from public;
revoke execute on function remove_site_member(uuid, uuid) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_profile_exists_in_org(uuid) to authenticated';
    execute 'grant execute on function editable_shape_ids() to authenticated';
    execute 'grant execute on function site_people(uuid) to authenticated';
    execute 'grant execute on function set_site_member(uuid, uuid, text) to authenticated';
    execute 'grant execute on function remove_site_member(uuid, uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_profile_exists_in_org(uuid) from anon';
    execute 'revoke all on function editable_shape_ids() from anon';
    execute 'revoke all on function site_people(uuid) from anon';
    execute 'revoke all on function set_site_member(uuid, uuid, text) from anon';
    execute 'revoke all on function remove_site_member(uuid, uuid) from anon';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- §7. WHAT THIS MIGRATION DELIBERATELY DOES NOT DO.
--
-- 1. **`user_profiles` is untouched, again.** 0020 §9 left it alone because it
--    carries `role`, the company-wide admin flag, and that field's writer can
--    hand out reach across every site. Nothing here changes that: a site admin
--    still cannot create a company membership, cannot delete one, and cannot
--    write `user_profiles.role`. What they can now do is SEE the list, through
--    a function, for a place they administer.
--
-- 2. **No invitation flow.** `site_people` can only offer people who already
--    have a `user_profiles` row, because a grant's foreign key requires one.
--    Inviting a NEW person is an auth-side operation (GoTrue), it does not
--    exist for company admins either, and inventing half of it here would put
--    a dead button on a site admin's screen. Named so it is a task.
--
-- 3. **No "last admin" rule.** §4/§5 stop a site admin removing their OWN
--    access; they do not stop the last admin of a site being removed by a
--    company admin, or two site admins removing each other. A site with no
--    admin is not broken -- every company admin still administers it -- so the
--    rule would buy less than it costs, and it would need a second query on
--    every write. Recorded, not built.
--
-- 4. **No audit row.** `profile_grants` has never been in `audit_log` (0007
--    covers runs and assignments). Access changes are exactly the kind of
--    thing an audit trail is for, and adding one is a schema change with its
--    own migration and its own tests. Named, not smuggled in here.
-- ----------------------------------------------------------------------------

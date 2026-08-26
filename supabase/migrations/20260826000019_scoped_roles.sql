-- ============================================================================
-- 0019 — the (role, scope) permission model. SUBSTRATE ONLY.
--
-- WHAT PRATIK ASKED FOR, in his words:
--   "there should be a system admin (who has all the powers to affect anything
--    at any site), a site admin (allowed to make changes only to a particular
--    site they belong), user/supervisor (allowed to only do assignments, does
--    not have access to admin page)"
--   "a user can have multiple roles, for example, a supervisor can be an admin
--    as well, it is a case by case basis, not every supervisor will be an
--    admin"
--
-- THE ONE IDEA. A role stops being a property of a PERSON and becomes a
-- property of a (person, place) pair. `profile_grants` already IS that pair --
-- it has carried `(profile_id, node_id)` since 0006 -- but the only thing it
-- said about the pair was a boolean, `can_edit`. This migration replaces that
-- boolean with the role held THERE.
--
--   system admin  = user_profiles.role = 'admin'      -- org-wide, unchanged
--   site admin    = profile_grants.role = 'admin'     on a Site node
--   supervisor    = profile_grants.role = 'supervisor'
--   viewer        = profile_grants.role = 'viewer'
--   multiple roles= multiple ROWS. Supervisor on Line 3 and admin on Plant 2
--                   is two grants, and that is the whole mechanism.
--
-- WHY NOT A NEW TABLE. The primary key `(profile_id, node_id)` allows exactly
-- one role per person per node, and that is correct rather than a limitation:
-- admin ⊇ supervisor ⊇ viewer at a single node, so a second row on the SAME
-- node could only ever be redundant with or dominated by the first. Multiple
-- roles are multiple PLACES, which the existing key models exactly.
--
-- GRANTS ADD POWER, THEY NEVER SUBTRACT IT. Coverage is a union over every
-- grant whose node is an ancestor-or-self of the row, and the strongest wins.
-- Admin on Plant 1 plus viewer on Line 3 makes you an ADMIN on Line 3 -- the
-- deeper, weaker grant does not carve a hole in the broader one. Anything else
-- would make "give this person read access to one line" silently demote a
-- plant admin, which is a booby trap, not a feature. Case S7 pins this.
--
-- ============================================================================
-- SCOPE OF THIS MIGRATION, stated so the next one is unambiguous.
--
-- IN:  the column, the backfill, the predicates, and the `nodes` policies --
--      everything that decides WHO IS WHAT, WHERE.
-- OUT: the call-site sweep. Every node RPC still opens with
--          if not app_is_admin() then api_raise('not_permitted', ...)
--      and every non-node policy still reads `app_is_admin() and org match`.
--      A site admin therefore gains NO new ability from this migration: the
--      substrate admits them, the doors are still bolted. 0020 opens the
--      doors, one classified call site at a time.
--
-- That split is deliberate. A migration that both invents the model and
-- rewrites 21 call sites has no state in which it can be tested -- a failure
-- anywhere reads as a failure everywhere. This one has exactly one job and
-- 46_scoped_roles_test.sql measures exactly that job.
--
-- ⚠️ ALSO OUT, AND IT MATTERS: the policies on `profile_grants` ITSELF are
-- untouched, so granting stays org-wide-admin-only. This is not an oversight,
-- it is the safe order: if 0020 lets a site admin write `profile_grants`
-- without a subtree predicate, a site admin grants themselves 'admin' on the
-- ROOT and the whole model is decorative. That is the first item in 0020 and
-- it gets its own escalation test, the way D98 did.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The column.
--
-- Backfill order is load-bearing: an existing profile whose ORG-WIDE role is
-- 'admin' keeps 'admin' on its grant, so the seed's root-grant admins are not
-- silently demoted at the grant level. They would in fact be unaffected either
-- way -- `user_profiles.role = 'admin'` already makes them system admins and
-- every predicate below short-circuits on that -- but a backfill that wrote
-- 'supervisor' onto an admin's row would leave the table lying about who they
-- are, and the next person to read it would believe the table.
--
-- `can_edit = true` becomes 'supervisor', not 'admin'. The old boolean meant
-- "may edit runs and assignments in this subtree", which is exactly the
-- supervisor's authority in the new vocabulary. Reading it as 'admin' would
-- hand every existing subtree grantee -- Ana on Assembly, Marco on Machining --
-- the power to restructure the hierarchy, which nobody has ever given them.
-- ----------------------------------------------------------------------------
-- ⚠️ THE BACKFILL IS THE ONE THING 46_scoped_roles_test.sql CANNOT COVER, and
-- saying so is more useful than a case that pretends otherwise. `verify-db.sh`
-- applies every migration and THEN the seed, so by the time any test runs, this
-- UPDATE has already executed against an EMPTY table. A green suite would say
-- nothing about the upgrade path.
--
-- So it was measured directly instead, once, on the path that actually matters:
-- a database built to 0018, seeded in the OLD shape, given an extra
-- `can_edit = false` row so the third branch was not vacuous, then advanced to
-- 0019. Result:
--
--   profile         org_role     node        can_edit -> role
--   a0..01          admin        plant_1     true     -> admin
--   a0..02          supervisor   assembly    true     -> supervisor
--   a0..02          supervisor   machining   false    -> viewer
--   a0..03          supervisor   machining   true     -> supervisor
--
-- All three branches fired, and nobody's access changed meaning. Case S2 pins
-- the post-conditions that must hold forever (NOT NULL, the check constraint,
-- the default, `can_edit` gone); the row-by-row translation above is a
-- one-time event and was verified as one.
alter table profile_grants add column role text;

update profile_grants pg
   set role = case
                when up.role = 'admin' then 'admin'
                when pg.can_edit       then 'supervisor'
                else                        'viewer'
              end
  from user_profiles up
 where up.id = pg.profile_id;

-- Any row whose profile vanished from under it (impossible via the composite
-- FK, but the UPDATE above is a join and a join can miss) must not become NULL
-- and then fail the NOT NULL with an unreadable message.
update profile_grants set role = 'viewer' where role is null;

alter table profile_grants alter column role set not null;
alter table profile_grants alter column role set default 'supervisor';
alter table profile_grants
  add constraint profile_grants_role_check check (role in ('admin','supervisor','viewer'));

comment on column profile_grants.role is
  'The role this profile holds WITHIN this node''s subtree. Replaces can_edit (0019). admin = site admin here; supervisor = may schedule here; viewer = read-only here. Multiple roles are multiple rows on different nodes. Strongest covering grant wins -- a deeper, weaker grant never subtracts from a broader, stronger one.';

-- Every predicate below filters grants by role for one profile, so the lookup
-- is (profile_id, role) and the 0006 index on profile_id alone no longer
-- covers it once a person holds many grants.
create index profile_grants_profile_role_idx on profile_grants (profile_id, role);


-- ----------------------------------------------------------------------------
-- 2. The primitive. Every other predicate is a phrasing of this one.
--
-- ⚠️ NO ORG PREDICATE HERE, DELIBERATELY, AND IT IS SAFE ONLY BECAUSE OF THE
-- JOIN. `profile_grants` is reached through `app_current_profile_id()`, which
-- 0018 made a single deterministic profile, and that profile belongs to exactly
-- one org; `node_id` is a primary key, so the join to `nodes` cannot cross a
-- tenant. What this function returns is a set of PATHS, and paths are unique
-- only per `(org_id, path)` -- 0012's lesson. So every CALLER must carry its
-- own `org_id = app_current_org()` term. They all do, and each one says so.
-- ----------------------------------------------------------------------------
create or replace function app_grant_paths_for(p_roles text[]) returns setof ltree
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT n.path
  FROM profile_grants pg
  JOIN nodes n ON n.id = pg.node_id
  WHERE pg.profile_id = app_current_profile_id()
    AND pg.role = ANY (p_roles);
$$;

comment on function app_grant_paths_for(text[]) is
  'Paths of the acting profile''s grants whose role is in p_roles. Returns PATHS, which are unique only per (org_id, path) -- every caller must add its own org_id = app_current_org() term. See migration 0012.';

-- ----------------------------------------------------------------------------
-- The 0008 signature, kept, and now a phrasing of the primitive.
--
-- KEEPING IT IS THE POINT. `app_can_read_node` and `app_can_edit_node` -- and
-- through them the runs/assignments policies and six RPCs in 0009 -- call this
-- and are not touched by this migration. `require_edit` translates to "roles
-- that may write here", which is admin and supervisor: a site admin can
-- obviously do anything a supervisor can in their own subtree, and reading
-- 'admin' as non-writing would break every site admin's ability to schedule.
-- ----------------------------------------------------------------------------
create or replace function app_grant_paths(require_edit boolean) returns setof ltree
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT gp FROM app_grant_paths_for(
    CASE WHEN require_edit
         THEN ARRAY['admin','supervisor']
         ELSE ARRAY['admin','supervisor','viewer']
    END
  ) gp;
$$;

-- can_edit is now unreferenced. Dropped AFTER both functions above are
-- redefined: a `language sql` body written as a dollar-quoted STRING records
-- no dependency on the columns it names, so PostgreSQL would have allowed the
-- DROP first and left the functions to fail at runtime, on a caller's request,
-- instead of here.
alter table profile_grants drop column can_edit;


-- ----------------------------------------------------------------------------
-- 3. "Am I an admin over this PATH?"
--
-- ⚠️ THIS TAKES A PATH, NOT A NODE ID, AND THAT IS THE WHOLE REASON IT EXISTS
-- (D85, migration 0013). A predicate used in an INSERT ... WITH CHECK must be
-- answerable WITHOUT reading `nodes`, because the row being checked is not yet
-- visible to a fresh read inside the same command. That is exactly what killed
-- `create_node` when 0012 made `app_can_read_node` read the table. The `nodes`
-- policies below therefore pass the row's OWN `path` column -- already
-- populated by the `nodes_set_path` BEFORE trigger -- and this function never
-- touches `nodes` at all.
--
-- It also carries no org term, for the same reason `app_grant_paths_for`
-- doesn't: the caller supplies one. Every policy below pairs it with
-- `org_id = app_current_org()`.
-- ----------------------------------------------------------------------------
create or replace function app_is_admin_on_path(p_path ltree) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM app_grant_paths_for(ARRAY['admin']) gp WHERE p_path <@ gp
  );
$$;

comment on function app_is_admin_on_path(ltree) is
  'Does the acting profile hold an admin grant covering this path? Takes a PATH, not a node id, so it is safe inside an INSERT WITH CHECK -- it never reads `nodes`. See D85 / migration 0013. Carries no org predicate; the caller must add one.';

-- ----------------------------------------------------------------------------
-- 4. "Am I an admin over this NODE?" -- the id-taking form, for RPC bodies.
--
-- Shaped exactly like 0012's fixed `app_can_read_node`: the org predicate sits
-- INSIDE, next to the id lookup, so a call site that forgets its own org term
-- still cannot reach across a tenant. Safe in a function body reasoning about
-- an EXISTING node; NOT safe in an INSERT WITH CHECK -- use
-- app_is_admin_on_path there.
-- ----------------------------------------------------------------------------
create or replace function app_is_admin_for(p_node uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM nodes n
    WHERE n.id = p_node
      AND n.org_id = app_current_org()
      AND (app_is_admin() OR app_is_admin_on_path(n.path))
  );
$$;

comment on function app_is_admin_for(uuid) is
  'May the caller administer this node -- system admin of its org, or a site admin holding an admin grant on it or an ancestor? Tenant-scoped internally (0012). Do NOT call from an INSERT WITH CHECK: it reads `nodes` (D85) -- use app_is_admin_on_path(path).';

-- ----------------------------------------------------------------------------
-- 5. "Am I an admin ANYWHERE?" -- the admin-page gate, and nothing else.
--
-- This answers one product question: should this person see the admin section
-- at all. It is deliberately the weakest predicate in the file and must never
-- be used to authorise a write -- a site admin for Plant 2 is admin-anywhere
-- and has no business writing Plant 1. The client mirror of this is
-- `adminAccess()` in src/features/auth/session.ts (D97), which fails closed on
-- any role it does not recognise; this is the server half of the same gate.
-- ----------------------------------------------------------------------------
create or replace function app_is_admin_anywhere() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT app_is_admin() OR EXISTS (
    SELECT 1 FROM profile_grants pg
    WHERE pg.profile_id = app_current_profile_id() AND pg.role = 'admin'
  );
$$;

comment on function app_is_admin_anywhere() is
  'Should this person see the admin section at all? VISIBILITY ONLY. Never authorise a write with this -- being a site admin somewhere says nothing about the row in front of you. Use app_is_admin_for(node) / app_is_admin_on_path(path).';


-- ----------------------------------------------------------------------------
-- 5b. A site admin may SCHEDULE inside their own site, whatever their org-wide
--     role says.
--
-- WHY THIS IS SUBSTRATE AND NOT A 0020 CALL SITE. `app_can_edit_node` is the
-- write gate for every run and assignment, and its subtree branch is
-- `app_can_write() AND <covered by an edit grant>`. `app_can_write()` reads
-- `user_profiles.role` -- the ORG-WIDE role. So a person made a site admin of
-- Plant 2, whose org-wide role is 'viewer' because they have no org-wide
-- authority, would be able to restructure Plant 2's hierarchy (once 0020 opens
-- that door) and yet not move a single shift inside it. That is not a
-- conservative default, it is an incoherent one, and it would be discovered by
-- a real user rather than by a test.
--
-- The added term is `app_is_admin_on_path(n.path)`: an admin GRANT covering
-- this node is sufficient on its own. The org-wide branch is untouched, so
-- nothing any existing user can do changes -- case S15 pins that supervisors
-- gained nothing here.
-- ----------------------------------------------------------------------------
create or replace function app_can_edit_node(p_node uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1
    FROM nodes n
    WHERE n.id = p_node
      AND n.org_id = app_current_org()
      AND (
        app_is_admin()
        OR app_is_admin_on_path(n.path)
        OR (app_can_write()
            AND EXISTS (SELECT 1 FROM app_grant_paths(true) gp WHERE n.path <@ gp))
      )
  );
$$;

comment on function app_can_edit_node(uuid) is
  'May the caller EDIT runs/assignments at this node? System admin of its org, OR a site admin holding an admin grant over it (0019), OR an org-wide writer with an edit grant over it. Tenant-scoped internally (0012).';


-- ----------------------------------------------------------------------------
-- 6. `nodes_select` -- path-based, which DISSOLVES D85 rather than working
--    around it.
--
-- WHAT 0013 DID AND WHY IT IS NOT ENOUGH NOW. 0012 made `app_can_read_node`
-- read `nodes`, and `create_node`'s `INSERT ... RETURNING` then returned zero
-- rows for everyone, because the policy asked the table about a row the table
-- could not yet see. 0013 rescued it by putting `app_is_admin()` FIRST, an
-- admin-only term that answers from `user_profiles` alone -- so admins
-- short-circuit past the self-read and never hit it.
--
-- That fix has an expiry date, and this migration is it. A SITE admin is not
-- `app_is_admin()`. The moment 0020 lets one create a node, they fall through
-- to the second term, hit the self-read, and get D85's silent empty RETURNING
-- -- the exact failure, on the exact code path, for the exact reason.
--
-- The real fix is to stop asking the table. `path` is a COLUMN of the row
-- under test, populated by a BEFORE trigger, so the policy can read it
-- directly. MEASURED on a scratch database before this migration was written:
-- a supervisor ran `INSERT ... RETURNING` under a policy of this shape and got
-- `PathTest | plant_1.assembly.line_1.pathtest` back.
--
-- `app_is_admin()` stays as the first term -- not as a workaround now but as
-- what it always should have been: a system admin sees every node in their org
-- whether or not anyone ever wrote them a grant.
-- ----------------------------------------------------------------------------
drop policy nodes_select on nodes;

create policy nodes_select on nodes for select
  using (
    org_id = app_current_org()
    and (
      app_is_admin()
      or exists (select 1 from app_grant_paths(false) gp where nodes.path <@ gp)
    )
  );

-- ----------------------------------------------------------------------------
-- 7. `nodes` write policies -- admit site admins to their own subtree.
--
-- Every one is `org match AND (system admin OR admin grant covering this row's
-- path)`. The org term is first and independent, so 0013's D83 property holds
-- unchanged: an admin of org 1 evaluating an org-2 row fails on the first
-- conjunct and never reaches the second.
--
-- A SITE ADMIN CANNOT CREATE A SITE. A new root node has no parent and
-- therefore no path under anyone's grant, so `app_is_admin_on_path` is false
-- and only a system admin may insert it. That is the correct reading of
-- "allowed to make changes only to a particular site they belong" -- and it is
-- a consequence of the model, not a rule bolted on top of it.
--
-- ON UPDATE, BOTH ENDS ARE CHECKED. `using` sees the row as it was, `with
-- check` the row as it will be, and a re-parent changes `path`. A site admin
-- moving a node OUT of their subtree therefore fails the WITH CHECK, and one
-- pulling a node IN from outside fails the USING. Neither needed a special
-- case; it falls out of naming the same predicate twice. Case S11 pins it.
--
-- NOTE ON `nodes_cascade_path()`: it re-paths descendants with a plain UPDATE
-- under the caller's own privileges (SECURITY INVOKER), so those rows go
-- through this policy too. They are all inside the subtree being moved, hence
-- inside the grant, so they pass -- but a move that STRADDLES the grant
-- boundary would be refused mid-cascade rather than half-applied, because the
-- whole statement is one transaction.
-- ----------------------------------------------------------------------------
-- ⚠️ FOUND WHILE MUTATING THIS MIGRATION (X6), AND CARRIED INTO 0020 AS ITEM 3.
-- `nodes_check_level_adjacency()` is SECURITY INVOKER and resolves the parent
-- with a plain `select ... from nodes pn where pn.id = new.parent_id`. That
-- SELECT goes through `nodes_select` as the CALLER. For a site admin, a node
-- outside their grant is invisible, so the lookup returns no row, and the
-- trigger reports
--
--     level_mismatch: node ... level position is not exactly one below its
--                     parent's
--
-- MEASURED: a system admin moving Line 1 under Machining succeeds
-- (`plant_1.machining.line_1`); a site admin of Assembly attempting the exact
-- same move gets `level_mismatch`. It is not a level problem at all -- it is
-- an invisibility problem wearing a level problem's error code.
--
-- No move that SHOULD be allowed is refused by this: a destination inside the
-- grant is by definition visible. What is wrong is the code the client
-- receives -- `level_mismatch` instead of `not_permitted` -- from a closed set
-- of twelve that the client switches on. The fix belongs with the RPC sweep in
-- 0020, where `move_node` gains an `app_is_admin_for(new parent)` pre-check
-- that fires BEFORE the trigger, so the trigger only ever sees moves the
-- caller was entitled to attempt.
--
-- It also has a testing consequence worth naming: it MASKS policy defects.
-- S11's first draft moved a node to an invisible destination, so the trigger
-- refused it before the policy was ever consulted, and a deliberately broken
-- WITH CHECK went undetected. S11 now straddles between two VISIBLE nodes --
-- an admin grant on Line 1 and a viewer grant on Line 2 -- so that the policy
-- is the only thing that can refuse.
drop policy nodes_insert on nodes;
drop policy nodes_update on nodes;
drop policy nodes_delete on nodes;

create policy nodes_insert on nodes for insert
  with check (
    org_id = app_current_org()
    and (app_is_admin() or app_is_admin_on_path(path))
  );

create policy nodes_update on nodes for update
  using (
    org_id = app_current_org()
    and (app_is_admin() or app_is_admin_on_path(path))
  )
  with check (
    org_id = app_current_org()
    and (app_is_admin() or app_is_admin_on_path(path))
  );

create policy nodes_delete on nodes for delete
  using (
    org_id = app_current_org()
    and (app_is_admin() or app_is_admin_on_path(path))
  );


-- ----------------------------------------------------------------------------
-- 8. Grants for the new functions.
--
-- D93: migration 0014 added functions and did not grant them, and every
-- `authenticated` caller got `permission denied for function` -- not a policy
-- refusal, a hard 42501 that no client error code covers. That is why this
-- block exists in every migration that adds a function, and why it is checked
-- by case S1 rather than assumed.
-- ----------------------------------------------------------------------------
-- ⚠️ A BARE `GRANT ... TO authenticated` IS A NO-OP AND WOULD HAVE SHIPPED AS
-- ONE. PostgreSQL grants EXECUTE on every new function to PUBLIC by default,
-- so the grant lines below change nothing on their own -- `authenticated` is
-- already a member of PUBLIC. This was caught by mutation X15: deleting the
-- grant line entirely was detected by NOTHING, because the function was
-- reachable either way. The revoke is the load-bearing half, and it is what
-- migrations 0009 and 0010 already do for every RPC. Same idiom, including the
-- role guards so this file still runs on a scratch Postgres with no Supabase
-- roles.
revoke execute on function app_grant_paths_for(text[]) from public;
revoke execute on function app_is_admin_on_path(ltree) from public;
revoke execute on function app_is_admin_for(uuid)      from public;
revoke execute on function app_is_admin_anywhere()     from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_grant_paths_for(text[]) to authenticated';
    execute 'grant execute on function app_is_admin_on_path(ltree) to authenticated';
    execute 'grant execute on function app_is_admin_for(uuid)      to authenticated';
    execute 'grant execute on function app_is_admin_anywhere()     to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_grant_paths_for(text[]) from anon';
    execute 'revoke all on function app_is_admin_on_path(ltree) from anon';
    execute 'revoke all on function app_is_admin_for(uuid)      from anon';
    execute 'revoke all on function app_is_admin_anywhere()     from anon';
  end if;
end $$;

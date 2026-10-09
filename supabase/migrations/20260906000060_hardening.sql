-- ============================================================================
-- 0060 --- THREE ROUGH EDGES THE TESTER FLAGGED, CLOSED OR RETIRED AT THE TABLE.
--
-- A standing note in docs/plan.yaml carried three items nobody had closed:
--
--   1. X46: a DIRECT PostgREST DELETE --- and, the reviewer found, a direct
--      UPDATE --- on profile_grants still let a site admin delete, demote or
--      re-point a company admin's grant on a node they administer --- the gap
--      0022 §3 named and case X46 in 49_company_admin_rows_test.sql asserted
--      rather than left to be found.
--   2. site_people (0021 §3) returns EVERY person in the company with no bound
--      and no search parameter, recorded-not-closed since it was written.
--   3. "a department admin gets no-place" on the Access panel (R-231's note,
--      from 0021 §7 / 19.52).
--
-- This file closes 1 at the table the way 0054 closed its sibling, gives 2 the
-- p_search argument and the documented bound 0021 §3 said it would one day get,
-- and records why 3 is moot after R-340 rather than building for it. Sections
-- below; §3 is a finding, not DDL.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- §1. THE COMPANY-ADMIN RULE, PUT IN THE TABLE FOR A DIRECT DELETE *OR UPDATE*.
--
-- ⭐ THE GAP, IN ONE SENTENCE. `remove_site_member` and `set_site_member` (0022)
-- refuse a site admin touching a company admin's grant, but `profile_grants`'
-- policies ask only `app_is_admin() OR app_is_admin_for(node_id)`, so a caller
-- reaching PostgREST directly --- not through the RPCs --- can DELETE the row,
-- demote its role (admin -> viewer) or re-point its profile_id, and no guard
-- runs.
--
-- ⛔ THE FIRST DRAFT OF THIS SECTION WAS BEFORE DELETE ONLY, AND THE REVIEWER
-- BROKE IT: a site admin who sent an UPDATE instead of a DELETE demoted a
-- company admin's grant, or re-pointed its profile_id onto a supervisor,
-- quietly. A DELETE guard that leaves UPDATE open is not the close, because the
-- role inversion 0022 named is just as reachable by editing the row as by
-- removing it. So the trigger fires BEFORE DELETE OR UPDATE OF role, node_id,
-- profile_id --- the same events 0054's admin-at-root trigger watches, plus
-- DELETE and profile_id.
--
-- ⚠️ THIS IS THE SAME SHAPE 0054 USED FOR THE ADMIN-AT-ROOT RULE. 0054 put
-- `set_site_member`'s "admin only at a plant root" into the table as a trigger
-- so a bare INSERT/UPDATE gets the same answer the RPC gives. This is 0022's
-- "a company admin's row is not a site admin's to edit" put in the table so a
-- bare DELETE or UPDATE gets the same answer.
--
-- ⚠️ TWO SIDES ON AN UPDATE. The OLD row is guarded on every DELETE and UPDATE:
-- if it belongs to a company admin and the caller is not one, refuse --- that
-- covers demotion and removal of a company admin's grant, and re-pointing it
-- away. The NEW row is guarded only when an UPDATE re-points profile_id onto a
-- DIFFERENT person: if that person is a company admin, refuse too --- a site
-- admin must not fabricate a company admin's grant by moving an ordinary one
-- onto them, which mirrors `set_site_member` guarding the TARGET profile.
--
-- ⚠️ IT BINDS EXACTLY WHO THE TABLE'S POLICIES BIND, AND NOT THE OWNER, for the
-- reason 0054 records at length: RLS on `profile_grants` does not apply to the
-- table's owner (the migration and fixture tool), and neither may this, or the
-- suites that build "a company admin's grant" as the owner would fail. The
-- owner check is 0017's `pg_has_role(current_user, <relowner>, 'USAGE')`, which
-- is why the function is SECURITY INVOKER --- inside a definer `current_user`
-- would be the definer and the check would pass for everybody. Every PostgREST
-- session is `authenticated` or `anon`, and both are bound.
--
-- ⚠️ THE GUARD REUSES `app_profile_is_company_admin` (0022 §1), the same
-- definer helper the RPCs use, so the trigger and the RPCs cannot drift apart.
-- That helper is org-scoped internally and answers a boolean; on DELETE/UPDATE
-- the row exists, so `old.profile_id` (and a re-pointed `new.profile_id`) names
-- a real profile and the helper's "answers FALSE for a profile that does not
-- exist" caveat cannot bite.
--
-- ⚠️ IT DOES NOT DUPLICATE THE RPCS. RLS already decides WHICH rows a caller may
-- reach, and the self-rule --- "you cannot take away your own admin access
-- here" --- is a PRODUCT rule 0021 §4 marks as deliberately deletable and is
-- not a safety invariant, so it stays in the RPCs and is not mirrored here.
-- What is mirrored is the one rule that is a role inversion if a direct call
-- bypasses it: a site admin editing a company admin's row. Two company admins
-- remain peers (`NOT app_is_admin()`). INSERT of a fresh grant is not watched
-- here: creating a new grant on a company admin is additive, not the inversion
-- 0022 measured, and `set_site_member` still guards the RPC path.
--
-- ⚠️ THE OLD DELETE-ONLY TRIGGER AND ITS FUNCTION ARE DROPPED BY NAME FIRST, so
-- re-applying this file over a database that carried the first draft leaves no
-- stale delete-only guard behind. The rename to `_edit` is the honest name for
-- a guard that no longer fires on DELETE alone.
--
-- Cases X50-X54 and X60-X64 in 83_hardening_test.sql pin this, and X46 in
-- 49_company_admin_rows_test.sql is flipped from "asserts the gap" to "asserts
-- the close".
-- ----------------------------------------------------------------------------
drop trigger if exists profile_grants_company_admin_delete on profile_grants;
drop function if exists profile_grants_company_admin_delete();

create or replace function profile_grants_company_admin_edit() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- The owner is the migration and fixture tool, as it is for every policy on
  -- this table (0017's check, extracted rather than retyped).
  if pg_catalog.pg_has_role(
       current_user,
       (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.profile_grants'::regclass),
       'USAGE') then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  -- Two company admins are peers, so a company admin passes freely; the rules
  -- below are for everyone else (a site admin, a supervisor, a viewer).
  if not app_is_admin() then
    -- The OLD row: a company admin's grant is not theirs to delete, demote or
    -- re-point away (0022, R-238).
    if app_profile_is_company_admin(old.profile_id) then
      perform api_raise('not_permitted', 'company admins are not managed from a site',
                        jsonb_build_object('profile_id', old.profile_id,
                                           'reason', 'company_admin'));
    end if;

    -- The NEW row, only when an UPDATE re-points onto a DIFFERENT person: a
    -- company admin's grant is not theirs to fabricate either (mirrors
    -- set_site_member guarding the target profile).
    if tg_op = 'UPDATE'
       and new.profile_id is distinct from old.profile_id
       and app_profile_is_company_admin(new.profile_id) then
      perform api_raise('not_permitted', 'company admins are not managed from a site',
                        jsonb_build_object('profile_id', new.profile_id,
                                           'reason', 'company_admin'));
    end if;
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

comment on function profile_grants_company_admin_edit() is
  'Trigger: refuses a DIRECT DELETE or UPDATE (of role, node_id, profile_id) of a company admin''s grant unless the caller is themselves a company admin (0022, R-238, 0060 sec.1), for every session the table''s policies bind and not for the owner. The table''s copy of the RPCs'' company_admin guard, so a bare PostgREST DELETE/UPDATE gets the same answer set_site_member and remove_site_member give. Guards the OLD row on every fire and the NEW row when an update re-points profile_id onto another company admin. Reuses app_profile_is_company_admin (0022 sec.1) so the two cannot drift.';

revoke execute on function profile_grants_company_admin_edit() from public;

drop trigger if exists profile_grants_company_admin_edit on profile_grants;
create trigger profile_grants_company_admin_edit
  before delete or update of role, node_id, profile_id on profile_grants
  for each row execute function profile_grants_company_admin_edit();


-- ----------------------------------------------------------------------------
-- §2. site_people GETS ITS SEARCH ARGUMENT AND ITS DOCUMENTED BOUND (0021 §3).
--
-- ⭐ THE GAP, IN ONE SENTENCE. `site_people` returns one row per person in the
-- company with no LIMIT and no search parameter, so a company of ten thousand
-- ships ten thousand rows on every open of the Access panel.
--
-- ⚠️ 0021 §3 CHOSE THIS DELIBERATELY AND SAID HOW IT WOULD BE CLOSED: "a silent
-- cap would make a person missing from the picker look like a person who does
-- not exist ... when it needs one it gets a `p_search` argument and a
-- documented bound, not a quiet `LIMIT 100`." This is exactly that, and no
-- more: two OPTIONAL arguments that DEFAULT to NULL, so a caller that passes
-- only p_node_id gets the identical unbounded answer it gets today --- no
-- existing caller silently loses a colleague --- and the payload now carries
-- `total` (people matching the filter, before any limit) so a cap is never
-- silent: a client can see returned < total and prompt for a search.
--
-- ⚠️ ADDED ARGUMENTS ARE A NEW FUNCTION, NOT A REPLACEMENT. Postgres keys a
-- function by (name, arg types), so `create or replace` with the wider
-- signature would leave site_people(uuid) in place and make site_people(x)
-- ambiguous. The old one is dropped first; nothing in the schema calls it (only
-- the client, over PostgREST, which resolves the wider function by its
-- defaults). The body is EXTRACTED from 0021 (last hit, sliced lines 219-273),
-- not retyped: the node-exists guard, the admin-for guard, the org-scoped
-- grant subquery and the email COLLATE "C" order are unchanged; the filter and
-- the LIMIT are the only additions.
--
-- ⚠️ THE CLIENT MUST STILL ADOPT IT. src/lib/api/access.ts::fetchSitePeople
-- calls site_people with p_node_id only, so today's wire payload is still
-- unbounded --- this migration makes the honest bound AVAILABLE, it does not
-- force it. Passing p_search/p_limit from the Access panel's search box is a
-- client change owned by another lane and is not made here (see the report).
--
-- Cases X55-X58 in 83_hardening_test.sql pin the bound, the filter, the total,
-- and that the no-argument call is unchanged.
-- ----------------------------------------------------------------------------
drop function if exists site_people(uuid);

create or replace function site_people(p_node_id uuid,
                                       p_search  text    default null,
                                       p_limit   integer default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
DECLARE
  v_path   ltree;
  v_name   text;
  v_org    uuid;
  v_people jsonb;
  v_total  integer;
  v_search text;
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

  -- NULL or blank search is "no filter", the same as today. The bound is on the
  -- email, the only human-readable thing the system knows about a person.
  v_search := nullif(btrim(coalesce(p_search, '')), '');

  -- The honest total: people matching the filter BEFORE any limit, so a client
  -- that sees returned < total knows to narrow the search rather than mistake a
  -- capped list for the whole company (0021 §3's worry, answered).
  SELECT count(*) INTO v_total
    FROM user_profiles up
    LEFT JOIN auth.users u ON u.id = up.user_id
   WHERE up.org_id = v_org
     AND (v_search IS NULL OR u.email ILIKE '%' || v_search || '%');

  SELECT coalesce(jsonb_agg(s.p ORDER BY s.ord), '[]'::jsonb)
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
             ) AS p,
             row_number() OVER (ORDER BY u.email COLLATE "C", up.id) AS ord
        FROM user_profiles up
        LEFT JOIN auth.users u ON u.id = up.user_id
       WHERE up.org_id = v_org
         AND (v_search IS NULL OR u.email ILIKE '%' || v_search || '%')
       ORDER BY u.email COLLATE "C", up.id
       LIMIT CASE WHEN p_limit IS NULL THEN NULL ELSE greatest(p_limit, 0) END
    ) s;

  RETURN jsonb_build_object(
    'nodeId',   p_node_id,
    'nodeName', v_name,
    'total',    v_total,
    'returned', jsonb_array_length(v_people),
    'people',   v_people
  );
END $$;

comment on function site_people(uuid, text, integer) is
  'Everyone in the company matching p_search (email ILIKE, NULL = no filter), each with the grants they hold inside this node''s subtree (0021 sec.3, bounded by 0060 sec.2). Refuses unless the caller administers p_node_id. p_limit caps the rows returned; the payload carries total (matches before the limit) and returned so a cap is never silent. Both new args default to NULL, so a p_node_id-only call is the unbounded answer 0021 gave. LEFT JOIN on auth.users so a profile whose auth row is missing still appears, with a null email.';

revoke execute on function site_people(uuid, text, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function site_people(uuid, text, integer) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function site_people(uuid, text, integer) from anon';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- §3. "A DEPARTMENT ADMIN GETS NO-PLACE" --- MOOT AFTER R-340, NOT BUILT.
--
-- ⭐ THE GAP, IN ONE SENTENCE. The Access panel is scoped by
-- `editable_shape_ids()` --- the STRUCTURES the caller may edit, owned by a
-- root (0020 §1) --- so a person whose only admin grant sits on a department
-- (not a root) gets an empty places list and the "no-place" screen, the state
-- 0021 §7 and siteAccess.ts already name as the honest one for a mid-tree
-- admin.
--
-- WHY NOTHING IS BUILT:
--
--   1. R-340 (0053/0054) means an admin grant can ONLY be created at a plant
--      root, both in set_site_member and now in the table (0054's trigger). A
--      NEW department admin cannot exist. Only a LEGACY below-root admin grant
--      could, and 0054 records there are none on the dev database --- confirmed
--      again here: `SELECT ... FROM profile_grants JOIN nodes ... WHERE
--      role='admin' AND parent_id IS NOT NULL` returns 0 rows.
--
--   2. A legacy department admin is NOT shut out of the app. The BOARD opens on
--      `visible_board_roots()` --- "every node they can read whose parent they
--      cannot", SECURITY INVOKER (0027) --- so a department-level grant holder
--      gets their department as the top of their visible forest (measured for
--      Ana -> Assembly, Marco -> Machining). They see their department on the
--      board; they do not get "an empty screen where they should see their
--      department".
--
--   3. The Access-panel no-place is therefore the documented, intended
--      limitation for a mid-tree admin (0021 §7), reached by a shrinking legacy
--      population and by nobody new. It is not a hole to fix at the server, and
--      it is not this file's to change on the client. Recorded here so the
--      absence of DDL is on the record, the way 0022 §3 records its own.
-- ----------------------------------------------------------------------------
-- (no DDL for §3)

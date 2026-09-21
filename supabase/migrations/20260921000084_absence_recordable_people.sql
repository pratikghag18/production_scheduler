-- ============================================================================
-- 0084 --- absence_recordable_people(): the people the caller may record an
-- absence for, answered by the server (DEF-0035 reopened, R-357, R-431).
--
-- WHY A FUNCTION AND NOT A CLIENT PREVIEW. set_absence (0069) and remove_absence
-- (0066) gate on
--
--     app_can_edit_node(coalesce(home_node_id, site_node_id))     -- 0069:276-288
--
-- of the chosen person. Session 182 tried to mirror that on the client with
-- editRights.ts's canEditNode over the person's home node, and the tester
-- reopened the defect the same day: a Line 1 supervisor can READ the people
-- owned at the plant above her (app_can_read_owned scopes upward) but cannot
-- read the CELLS on the other lines those people are homed at, so the client
-- holds no path for four of the six, and a preview that cannot see fails open
-- by design (editRights.ts's header). The dropdown offered all six; the server
-- refused four. A predicate about a node the caller cannot see is not one the
-- client can transcribe --- it is the same shape as 0061/0068 (DEF-0016,
-- DEF-0017): the server answers it as a DEFINER and guards the org itself.
--
-- WHAT IT ANSWERS. The set of operator ids in the caller's own company for
-- whom set_absence would pass its permission gate --- the SAME expression, not
-- a paraphrase, so the screen offers exactly what the writer accepts (CLAUDE.md
-- section 4; R-431). It says nothing about overlaps, which are refused per
-- request (absence_overlap), and nothing about active/inactive, which the
-- screen decides for itself. 88_absences_test.sql AB35 holds the two to each
-- other: for every person in the fixture, membership here equals whether
-- set_absence accepts them.
--
-- BOUNDARIES. `o.org_id = app_current_org()` --- a caller with no profile
-- (app_current_org() NULL) gets an empty set, never another company's people.
-- app_can_edit_node reads the caller's own grants (auth.uid()), which a DEFINER
-- body still sees, exactly as set_absence itself does. STABLE, so PostgREST
-- may call it over GET. Revoked from public and anon, granted to authenticated,
-- the established path (0068 header).
-- ============================================================================

create or replace function absence_recordable_people() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT o.id
    FROM operators o
   WHERE o.org_id = app_current_org()
     AND app_can_edit_node(coalesce(o.home_node_id, o.site_node_id))
   ORDER BY o.id;
$$;

comment on function absence_recordable_people() is
  'R-357/R-431 (DEF-0035): the operator ids, in the caller''s own company, for whom set_absence and remove_absence would pass their permission gate --- app_can_edit_node(coalesce(home_node_id, site_node_id)), the same expression 0069 runs, so the Absences screen offers exactly the people the writer accepts. SECURITY DEFINER because the person''s home may be a node the caller cannot read (a cell on another line), which a client-side preview cannot decide and fails open on. Says nothing about overlaps or active flags. Empty for a caller with no profile. 88_absences_test.sql AB35 asserts parity with set_absence per person.';

revoke execute on function absence_recordable_people() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function absence_recordable_people() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function absence_recordable_people() from anon';
  end if;
end $$;

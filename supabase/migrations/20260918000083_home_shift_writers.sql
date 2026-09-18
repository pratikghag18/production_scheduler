-- ============================================================================
-- 0083 --- A PERSON BELONGS TO A SHIFT: THE ACCESS TAB'S WRITER (R-442; S66-b,
-- docs/design-plan.md D137). The model and the server for the two shift
-- columns shipped in 0082 (S66-a) with nowhere on any screen to write
-- `profile_grants.plans_shift_id` / `.outside_shift` yet: `set_site_member`
-- still took only a role, and `site_people` did not emit either column at
-- all -- its own comment on `AccessGrant.plansShiftId` in
-- `src/features/admin/lib/siteAccess.ts` said so in as many words: "site_people
-- ... does not emit them yet -- wiring that RPC is a later lane's work." This
-- migration is that lane.
--
-- EXTRACTED, NEVER RETYPED (CLAUDE.md §4, DEF-0011) --- both functions found by
-- `grep -in "function \(public\.\)\?<name>(" supabase/migrations/*.sql` and
-- taking the LAST hit, not the brief's own guess at a line number:
--
--   * `set_site_member`: last defined in 0054
--     (`20260905000054_admin_at_root_in_the_table.sql:76`), NOT 0021 or 0053 ---
--     0054's own header records the DEF-0011 lesson about this exact function:
--     a case-sensitive grep for the bare name misses 0022's upper-case,
--     schema-qualified `CREATE OR REPLACE FUNCTION public.set_site_member`.
--     The `-i` above is what catches it.
--   * `site_people`: last defined in 0076
--     (`20260910000076_deactivate_a_user.sql:136`), the version that added the
--     `active` field per person.
--
-- Every guard 0054's own body carries --- node exists, caller administers the
-- node, a company admin's row is not a site admin's to edit, a real role word,
-- admin-only-at-a-plant-root, the self-rule --- is reproduced VERBATIM below,
-- with exactly two additions: two new optional arguments, and their two
-- columns joining the one INSERT ... ON CONFLICT DO UPDATE. Asserted on the
-- assembled text before this file was written: every one of those five guard
-- phrases (`no such node`, `you do not administer`, `company_admin`,
-- `admin_below_root`, `reason', 'self'`) is present exactly once, in the same
-- order 0054 had them.
--
-- ⭐ THE SHAPE, AND WHY THE SQL SIDE CANNOT ITSELF SPELL "LEAVE ALONE". Unlike
-- `updateOperator`'s `"homeShiftId" in input` contract (0082's own client
-- half), a PL/pgSQL DEFAULT cannot tell "the caller did not send this
-- argument" from "the caller sent exactly the default value" --- Postgres
-- resolves the default BEFORE the function body ever runs, so both look
-- identical inside it. `role` already lives with this: `set_site_member` has
-- always fully overwritten it on every call, and no caller has ever needed a
-- partial one, because the panel always knows the role it means to write.
-- `plans_shift_id`/`outside_shift` are given the SAME shape here --- always
-- written, from whatever the two new arguments (or their defaults, NULL and
-- true --- the columns' own defaults, changing nothing for a call that omits
-- them) resolve to --- and the CLIENT carries the responsibility of resending
-- an existing grant's current shift-planning fields on every write that is
-- not itself about them, exactly as `siteAccess.ts`'s `rowGrant` now carries
-- `plansShiftId`/`outsideShift` for precisely that purpose. A write that
-- means to change only the role, or only the shift plan, still sends the
-- other unchanged --- there is no third door.
--
-- THE ACCESS TAB'S OWN GATE, TRANSCRIBED FROM THE ROLE CONTROL (R-442: "the
-- same test the role control uses"): `set_site_member` already refuses unless
-- `app_is_admin_for(p_node_id)`, already refuses a site admin editing a
-- company admin's row, and both refusals cover the two new fields for free ---
-- there is no separate door into `profile_grants` for them, only the one this
-- function already guards.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. set_site_member --- two new optional arguments, both defaulting to the
--    columns' own defaults (0082), so a call that omits them (every call site
--    this migration does not itself touch) writes exactly what it always did.
--
--    ⚠️ `CREATE OR REPLACE FUNCTION` DOES NOT REPLACE A FUNCTION WHOSE
--    ARGUMENT LIST DIFFERS -- Postgres keys a function's identity on its
--    parameter TYPES, so `(uuid, uuid, text, uuid, boolean)` is a DIFFERENT
--    function from `(uuid, uuid, text)`, not a new body for the same one.
--    Measured the hard way: without the DROP below, the OLD three-argument
--    overload from 0054 stayed live alongside this one, and a plain
--    three-argument call became genuinely AMBIGUOUS to Postgres --
--    `function set_site_member(unknown, unknown, unknown) is not unique`,
--    42725 -- because both overloads' remaining parameters have defaults and
--    either could be meant. The three-argument form must not survive this
--    migration.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.set_site_member(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.set_site_member(
  p_node_id uuid,
  p_profile_id uuid,
  p_role text,
  p_plans_shift_id uuid DEFAULT NULL,
  p_outside_shift boolean DEFAULT true
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org   uuid;
  v_after text;
  v_after_plans_shift_id uuid;
  v_after_outside_shift  boolean;
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

  -- ⭐ 0022: A COMPANY ADMIN'S ROW IS NOT A SITE ADMIN'S TO EDIT.
  IF app_profile_is_company_admin(p_profile_id) AND NOT app_is_admin() THEN
    PERFORM api_raise('not_permitted', 'company admins are not managed from a site',
                      jsonb_build_object('profile_id', p_profile_id,
                                         'reason', 'company_admin'));
  END IF;

  IF p_role IS NULL OR p_role NOT IN ('admin', 'supervisor', 'viewer') THEN
    PERFORM api_raise('invalid_argument', 'unknown role',
                      jsonb_build_object('field', 'role', 'value', p_role));
  END IF;

  -- ⭐ 0053, carried by 0054: `admin` ONLY AT A PLANT ROOT, and it sits here on purpose --
  -- AFTER "is that a real role" so an unknown word is still reported as an
  -- unknown word, and BEFORE the self-rule so the answer does not depend on
  -- who is asking. `invalid_argument` rather than `not_permitted`: the caller
  -- is allowed to administer this place, they have asked for a combination
  -- that does not exist.
  IF p_role = 'admin'
     AND EXISTS (SELECT 1 FROM nodes n
                  WHERE n.id = p_node_id AND n.parent_id IS NOT NULL) THEN
    PERFORM api_raise('invalid_argument',
                      'an admin runs a whole plant, so admin can only be given at a plant',
                      jsonb_build_object('field', 'role', 'value', p_role,
                                         'node_id', p_node_id,
                                         'reason', 'admin_below_root'));
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

  -- R-442: `plans_shift_id`/`outside_shift` join the one row this function has
  -- always written -- always OVERWRITTEN from the two new arguments (or their
  -- defaults), the same full-value contract `role` already keeps. See this
  -- file's header for why the CALLER, not this function, carries "leave it
  -- alone" for these two.
  INSERT INTO profile_grants (profile_id, node_id, org_id, role, plans_shift_id, outside_shift)
       VALUES (p_profile_id, p_node_id, v_org, p_role, p_plans_shift_id, p_outside_shift)
  ON CONFLICT (profile_id, node_id) DO UPDATE SET
    role           = EXCLUDED.role,
    plans_shift_id = EXCLUDED.plans_shift_id,
    outside_shift  = EXCLUDED.outside_shift;

  SELECT pg.role, pg.plans_shift_id, pg.outside_shift
    INTO v_after, v_after_plans_shift_id, v_after_outside_shift
    FROM profile_grants pg
   WHERE pg.profile_id = p_profile_id AND pg.node_id = p_node_id;

  RETURN jsonb_build_object(
    'nodeId',       p_node_id,
    'profileId',    p_profile_id,
    'role',         v_after,
    'plansShiftId', v_after_plans_shift_id,
    'outsideShift', v_after_outside_shift
  );
END $function$;

comment on function set_site_member(uuid, uuid, text, uuid, boolean) is
  'Give a person a role on this node''s subtree, or change the role (and now the shift-planning restriction, R-442) they already hold there (0021 §4, guarded by 0022, narrowed by 0053, re-assembled whole by 0054, extended by 0083). One row, so adding, re-roling and re-planning are one function. Refuses unless the caller administers the node; refuses a site admin editing a company admin''s row; refuses a site admin removing their OWN access here; and refuses `admin` anywhere but a plant root, which the table itself also refuses. p_plans_shift_id/p_outside_shift default to NULL/true (the columns'' own defaults, unrestricted) and are ALWAYS WRITTEN from whatever is passed -- there is no "leave alone" on the server side, exactly as there never has been for p_role; a caller changing only the role must resend the grant''s current shift-planning fields, and a caller changing only the shift plan must resend the current role. The row is read back so the returned values are what is stored, not an echo of the arguments.';

revoke execute on function set_site_member(uuid, uuid, text, uuid, boolean) from public;
do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function set_site_member(uuid, uuid, text, uuid, boolean) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function set_site_member(uuid, uuid, text, uuid, boolean) from anon';
  end if;
end $do$;


-- ----------------------------------------------------------------------------
-- 2. site_people --- re-emitted whole from its LAST body (0076), with exactly
--    ONE addition: `plansShiftId`/`outsideShift` join each grant object,
--    mirroring the column pair `parseGrant` in `siteAccess.ts` already reads
--    leniently (0082's own comment there: "wiring that RPC is a later lane's
--    work"). Everything else -- the total/returned counts, the invitedPending
--    rule, the grants subquery bounded to the node's subtree, the LEFT JOIN
--    on auth.users, the active flag, the ORDER BY, the limit -- is unchanged.
-- ----------------------------------------------------------------------------
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
               'active',       up.active,
               'invitedPending', (u.last_sign_in_at IS NULL),
               'grants',       coalesce((
                 SELECT jsonb_agg(jsonb_build_object(
                          'nodeId',       gn.id,
                          'nodeName',     gn.name,
                          'role',         pg.role,
                          'plansShiftId', pg.plans_shift_id,
                          'outsideShift', pg.outside_shift)
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
  'Everyone in the company matching p_search (email ILIKE, NULL = no filter), each with the grants they hold inside this node''s subtree (now carrying plansShiftId/outsideShift per grant, R-442/0083), an invitedPending flag, and an active flag (false = deactivated, migration 0076). Refuses unless the caller administers p_node_id. p_limit caps the rows returned; the payload carries total (matches before the limit) and returned so a cap is never silent. Both non-node args default to NULL, so a p_node_id-only call is the unbounded answer 0021 gave. LEFT JOIN on auth.users so a profile whose auth row is missing still appears, with a null email and invitedPending true.';

revoke execute on function site_people(uuid, text, integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function site_people(uuid, text, integer) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function site_people(uuid, text, integer) from anon';
  end if;
end $$;

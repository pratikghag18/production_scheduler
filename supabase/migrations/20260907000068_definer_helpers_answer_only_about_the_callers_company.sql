-- ============================================================================
-- 0068 --- DEFINER HELPERS ANSWER ONLY ABOUT THE CALLER'S COMPANY, AND THE
-- OWNER EXEMPTION IS KEYED ON THERE BEING NO CALLER AT ALL (DEF-0018, DEF-0019,
-- DEF-0021; R-341, R-356).
--
-- THE DEFECT, three helpers, one shape. A SECURITY DEFINER helper that takes a
-- node or row id runs with RLS out of the way, so unless it names the caller's
-- company itself it will answer about ANY company's row --- the same hole 0020's
-- app_node_exists_in_org is written not to have (R-341: another company's node,
-- and a uuid that exists nowhere, get the same answer, nothing).
--
--   * app_resolve_node_setting (0050) named the caller's company nowhere. As
--     Ana (org 1, one line) it answered the OTHER company's date_format,
--     eligibility_policy and timezone by literal uuid, while
--     app_node_exists_in_org said false for the same uuid. 0062/0063 made it the
--     authority for every board's date format and zone, so it is now on every
--     board load (DEF-0018).
--   * resolve_shift_template (0061) DID gain a boundary, but guarded with
--     `app_current_org() IS NULL OR ...`. app_current_org() is NULL not only in
--     owner context but for EVERY authenticated session with no user_profiles
--     row --- a fresh sign-up (enable_signup = true, and nothing creates a
--     profile on sign-up). Such a session resolved every company's templates
--     (DEF-0019).
--   * rename_week_template / delete_week_template (0067) read `plant_id, org_id
--     FROM week_templates WHERE id = p_template_id` with no org term, so a
--     foreign-company row was found and refused not_permitted/not_admin while a
--     bogus id was refused invalid_argument/no_such_template --- two
--     distinguishable answers, a cross-tenant existence leak (DEF-0021, R-356).
--     list_week_templates two functions above them already carries `wt.org_id =
--     app_current_org()`; this makes the writers match it.
--
-- ⚠️ WHY THE EXEMPTION IS KEYED ON `auth.uid() IS NULL`, AND WHY THE TWO
-- ALTERNATIVES ARE WRONG. Some callers reach these resolvers in OWNER CONTEXT
-- --- the seed, a superuser psql session, and the committed cases 30_shifts
-- 18a-c and 56_delete D24 that run resolve_shift_template after RESET ROLE ---
-- and those must keep resolving unbounded. The exemption must fire for exactly
-- those and for nothing that carries a tenant identity.
--
--   * `app_current_org() IS NULL` (what 0061 used) is DEF-0019 itself: it is
--     also NULL for a signed-in session that has no profile yet, which is a
--     tenant caller and must be bounded. Rejected.
--   * `session_user` is ruled out by 0020's own note (grep session_user in
--     20260826000020_site_ownership.sql): under PostgREST it is `authenticator`,
--     and in this repo's SQL harness it is the superuser, so a test keyed on it
--     would disagree with production in the direction that HIDES the hole.
--     Rejected.
--   * `auth.uid() IS NULL` means "no caller identity at all": no jwt sub claim
--     is set. That is precisely owner context (the seed, a superuser session, a
--     suite case after RESET ROLE with the claim cleared --- 84's ST4 clears it
--     with set_config('request.jwt.claim.sub','',true) to REACH owner context)
--     and nothing else. A PostgREST `authenticated` session always carries a
--     sub, profile or no profile, so it is bounded; `anon` is revoked from every
--     one of these functions and stays revoked. This is the established path:
--     app_current_profile_id (0018) already calls auth.uid() from a DEFINER
--     body with search_path = public, pg_temp, and the harness (00_harness.sql)
--     defines auth.uid() as NULLIF(current_setting('request.jwt.claim.sub',
--     true),'')::uuid, so it agrees with production --- NULL when no claim is
--     set, the caller's uuid when one is.
--
-- The two node resolvers write the boundary the SAME way so they cannot drift:
--
--     (auth.uid() IS NULL OR <row>.org_id = app_current_org())
--
-- The two week-template WRITERS take NO owner exemption: they are called by a
-- signed-in admin over PostgREST and never in owner context (confirmed: every
-- caller of rename/delete in the SQL suites sets a jwt claim first), so a bare
-- `org_id = app_current_org()` on the existence lookup is right --- a foreign
-- row and a bogus id then both fall into the no_such_template branch, matching
-- list_week_templates.
--
-- ⚠️ Each function is re-emitted WHOLE from its last definition by extraction
-- (0050 for app_resolve_node_setting, 0061 for resolve_shift_template, 0067 for
-- the two writers), the clauses asserted present and unique on the assembled
-- text before writing, because 0053 retyped a function and silently dropped a
-- rule (DEF-0011). Signatures are unchanged, so every caller stands. Grants are
-- re-stated after each function exactly as the last definition states them.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. app_resolve_node_setting (DEF-0018). Extracted from 0050. Both branches
--    gain the boundary: the ancestor scan on target.org_id, the company branch
--    on n.org_id. Result for another company's node or a bogus uuid: NULL, for
--    every key (date_format, eligibility_policy, timezone, any future key ---
--    p_key is generic, so one term bounds them all).
-- ----------------------------------------------------------------------------
create or replace function app_resolve_node_setting(p_node_id uuid, p_key text)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT COALESCE(
    -- 1. The nearest ancestor-or-self carrying an answer. `target.path <@
    -- anc.path` includes the target itself, so a plant with its own override
    -- resolves from it, and `ORDER BY nlevel(anc.path) DESC` makes "nearest"
    -- mean deepest -- a line's override beats its plant's.
    (SELECT ns.value
       FROM nodes target
       JOIN nodes anc ON target.path <@ anc.path AND anc.org_id = target.org_id
       JOIN node_settings ns ON ns.node_id = anc.id AND ns.key = p_key
      WHERE (auth.uid() IS NULL OR target.org_id = app_current_org())
        AND target.id = p_node_id
      ORDER BY nlevel(anc.path) DESC
      LIMIT 1),
    -- 2. The company's, from the node's OWN org.
    (SELECT o.settings->>p_key
       FROM nodes n JOIN orgs o ON o.id = n.org_id
      WHERE (auth.uid() IS NULL OR n.org_id = app_current_org())
        AND n.id = p_node_id)
  );
$$;

comment on function app_resolve_node_setting(uuid, text) is
  'R-331/R-341: what one setting says AT one node -- the nearest ancestor-or-self carrying an override (node_settings), else the node''s own org bag (orgs.settings), else NULL so the caller applies the default that belongs to that key. SECURITY DEFINER on purpose: nodes is RLS-scoped, and an INVOKER walk would miss an override on an ancestor the caller cannot read and fall through to the company default -- a safety rule failing open for exactly the people who use it most (the same defect 0023 fixed inside check_eligibility). Org-bounded since 0068 (DEF-0018): a node in another company, or a uuid that exists nowhere, resolves to NULL for a tenant caller -- both branches carry (auth.uid() IS NULL OR org_id = app_current_org()); owner context (no jwt sub: the seed, superuser tests) resolves unbounded. Shaped after resolve_shift_template.';

revoke execute on function app_resolve_node_setting(uuid, text) from public;

do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_resolve_node_setting(uuid, text) to authenticated';
  end if;
end $do$;

-- ----------------------------------------------------------------------------
-- 2. resolve_shift_template (DEF-0019). Extracted from 0061. One edit: the
--    first predicate's exemption changes from `app_current_org() IS NULL` to
--    `auth.uid() IS NULL`, so a profile-less authenticated session (a tenant
--    caller with a null org) is bounded and only true owner context is exempt.
--    Nothing else moves.
-- ----------------------------------------------------------------------------
create or replace function resolve_shift_template(p_node_id uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT nst.template_id
  FROM nodes target
  JOIN nodes anc ON target.path <@ anc.path AND anc.org_id = target.org_id
  JOIN node_shift_templates nst ON nst.node_id = anc.id
  WHERE (auth.uid() IS NULL OR target.org_id = app_current_org())
    AND target.id = p_node_id
  ORDER BY nlevel(anc.path) DESC
  LIMIT 1;
$$;

comment on function resolve_shift_template(uuid) is
  'R-039: which shift template a node RUNS --- the nearest ancestor-or-self carrying an attachment wins, along target.path <@ anc.path within the node''s own org, else NULL. SECURITY DEFINER since 0061 (DEF-0016): nodes and node_shift_templates are RLS-scoped, so an INVOKER walk misses a template attached on an ancestor the caller cannot read and answers NULL for a line that inherits the plant''s pattern --- the board of the supervisor who schedules the line loses its break band, shift boundaries and shift chips. Org-bounded: a node in another company, or a uuid that exists nowhere, resolves to NULL for a tenant caller (0020 s8.0, DEF-0013/0056). The owner exemption is keyed on auth.uid() IS NULL since 0068 (DEF-0019), not app_current_org() IS NULL: the latter is also true for a signed-in session with no profile row, a tenant caller that must be bounded; auth.uid() IS NULL is true only when no jwt sub is set (the seed, superuser tests), which resolves unbounded. Shape is 0050''s app_resolve_node_setting, which is DEFINER for the same reason.';

-- Grants, as 0050's helper: revoked from public, granted to authenticated (the
-- board payload runs it per node under the caller's session), never anon. 0023
-- and 0061 already set exactly this; re-stated here so a reader of the last
-- definition sees the whole contract in one place and a later re-emission
-- cannot drop it.
revoke execute on function resolve_shift_template(uuid) from public;

do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function resolve_shift_template(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function resolve_shift_template(uuid) from anon';
  end if;
end $do$;

-- ----------------------------------------------------------------------------
-- 3. rename_week_template (DEF-0021). Extracted from 0067. One edit: the
--    existence lookup gains `AND org_id = app_current_org()`, so a foreign-org
--    row is invisible to it (v_plant stays NULL) and falls into the
--    no_such_template branch, the same answer a bogus id gives. No owner
--    exemption: this is a writer called by a signed-in admin, matching
--    list_week_templates. v_org is still read for the duplicate-name check.
-- ----------------------------------------------------------------------------
create or replace function rename_week_template(p_template_id uuid, p_name text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_plant uuid;
  v_org   uuid;
  v_name  text := btrim(coalesce(p_name, ''));
BEGIN
  SELECT plant_id, org_id INTO v_plant, v_org FROM week_templates
   WHERE id = p_template_id AND org_id = app_current_org();
  IF v_plant IS NULL THEN
    PERFORM api_raise('invalid_argument', 'no such template',
      jsonb_build_object('field', 'p_template_id', 'reason', 'no_such_template'));
  END IF;
  IF NOT app_is_admin_for(v_plant) THEN
    PERFORM api_raise('not_permitted', 'only this plant''s admins may rename a template',
      jsonb_build_object('plant_id', v_plant, 'reason', 'not_admin'));
  END IF;
  IF v_name = '' THEN
    PERFORM api_raise('invalid_argument', 'a template needs a name',
      jsonb_build_object('field', 'p_name', 'reason', 'blank_name'));
  END IF;
  IF EXISTS (SELECT 1 FROM week_templates t
              WHERE t.org_id = v_org AND t.plant_id = v_plant
                AND lower(t.name) = lower(v_name) AND t.id <> p_template_id) THEN
    PERFORM api_raise('invalid_argument', 'a template with that name already exists for this plant',
      jsonb_build_object('field', 'p_name', 'name', v_name, 'reason', 'duplicate_name'));
  END IF;

  UPDATE week_templates SET name = v_name WHERE id = p_template_id;
  RETURN jsonb_build_object('id', p_template_id, 'name', v_name);
END $function$;

comment on function rename_week_template(uuid, text) is
  'R-356: a plant''s admins rename a week template. SECURITY DEFINER; the existence lookup is org-scoped (org_id = app_current_org()) since 0068 (DEF-0021), so a template in another company is invisible to it and answers no_such_template exactly as a bogus id does, rather than not_admin --- the two must not be distinguishable (the cross-tenant existence rule list_week_templates already keeps). Refuses a non-admin of the plant with not_permitted/not_admin.';

-- ----------------------------------------------------------------------------
-- 4. delete_week_template (DEF-0021). Extracted from 0067. Same one edit on the
--    existence lookup.
-- ----------------------------------------------------------------------------
create or replace function delete_week_template(p_template_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_plant uuid;
BEGIN
  SELECT plant_id INTO v_plant FROM week_templates
   WHERE id = p_template_id AND org_id = app_current_org();
  IF v_plant IS NULL THEN
    PERFORM api_raise('invalid_argument', 'no such template',
      jsonb_build_object('field', 'p_template_id', 'reason', 'no_such_template'));
  END IF;
  IF NOT app_is_admin_for(v_plant) THEN
    PERFORM api_raise('not_permitted', 'only this plant''s admins may delete a template',
      jsonb_build_object('plant_id', v_plant, 'reason', 'not_admin'));
  END IF;

  DELETE FROM week_templates WHERE id = p_template_id;   -- items cascade
  RETURN jsonb_build_object('id', p_template_id, 'deleted', true);
END $function$;

comment on function delete_week_template(uuid) is
  'R-356: a plant''s admins delete a week template (items cascade). SECURITY DEFINER; the existence lookup is org-scoped (org_id = app_current_org()) since 0068 (DEF-0021), so a template in another company answers no_such_template exactly as a bogus id does, not not_admin. Refuses a non-admin of the plant with not_permitted/not_admin.';

-- Grants, exactly as 0067 states them for the two writers: revoked from public,
-- granted to authenticated, revoked from anon. Re-stated so the last definition
-- carries the whole contract.
revoke execute on function rename_week_template(uuid, text)   from public;
revoke execute on function delete_week_template(uuid)         from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function rename_week_template(uuid, text) to authenticated';
    execute 'grant execute on function delete_week_template(uuid)       to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function rename_week_template(uuid, text) from anon';
    execute 'revoke all on function delete_week_template(uuid)       from anon';
  end if;
end $$;

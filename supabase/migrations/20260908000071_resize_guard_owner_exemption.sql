-- ============================================================================
-- 0071 --- THE RESIZE GUARD MISSED THE OWNER EXEMPTION EVERY OTHER DEFINER
-- HELPER IN THIS REPO CARRIES (DEF-0019, extending 0068; R-361).
--
-- 0070's `app_guard_assignment_resize()` calls `check_eligibility`, and
-- `check_eligibility` (0026) has NEVER carried the owner exemption 0068 gave
-- `app_resolve_node_setting`/`resolve_shift_template`: its own gate,
-- `app_can_read_node`, requires `n.org_id = app_current_org()` UNCONDITIONALLY,
-- which is false for EVERY caller with no resolvable company -- including
-- owner context itself (`app_current_org()` is NULL there too, same as a
-- profile-less signed-in session). Nothing surfaced this before 0070 because
-- nothing had ever called `check_eligibility` from a bare table UPDATE; the
-- seed and every migration write straight into `assignments` and never touch
-- the four RPCs in owner context. 0070's trigger fires on EVERY qualifying
-- UPDATE regardless of who or what issued it, so it is the first caller of
-- `check_eligibility` that can be owner context, and it inherited a refusal
-- ("you cannot see that place") that has nothing to do with eligibility or
-- absence and everything to do with a caller `check_eligibility` was never
-- taught to exempt. `50_audit_test.sql`'s Case 27 --- a bare `UPDATE
-- assignments SET timerange = ...` with no jwt claim, run to check the AUDIT
-- TRAIL captures exactly one row and only the business columns differ --- is
-- the measured symptom, and it is not the only caller this shape describes: a
-- migration backfill or a support script run by hand in `psql` would hit the
-- identical "you cannot see that place" the moment it touched an assignment's
-- `timerange`.
--
-- ⚠️ THE FIX BELONGS IN THE TRIGGER, NOT IN `check_eligibility` OR IN THE
-- TEST. Widening `check_eligibility`'s own gate would touch all four
-- scheduler RPCs for a question none of them can ever actually ask (every
-- PostgREST caller of `create_assignment`/`move_run`/`reassign_assignment`/
-- `apply_copy_week` carries a jwt sub by construction) -- risk with no
-- matching benefit, and CLAUDE.md's own rule against re-typing a rule a
-- second place. Rewriting `50_audit_test.sql`'s Case 27 to impersonate a user
-- would make it stop testing what it exists to test (that a timerange UPDATE
-- writes exactly one audit row whose before/after differ only on that column)
-- and start testing eligibility instead -- session-less on purpose, per its
-- own file header, and it is outside this piece's owned files regardless.
-- The gate that is actually missing is the same one every other table-level
-- DEFINER guard in this repo already carries: an owner-context caller never
-- needed asking in the first place, because owner context already bypasses
-- RLS on `assignments` entirely (no session for the `assignments_update`
-- policy to apply to) -- this trigger is the ONLY thing that would have
-- refused such a caller, and refusing them is pure breakage, not a boundary.
--
-- ⚠️⚠️ THE KEY IS `auth.uid() IS NULL`, AND THE OTHER TWO ARE WRONG FOR THE
-- SAME REASONS 0068 ALREADY WORKED OUT (read that migration's header in full;
-- this is the same defect number, DEF-0019, arriving at a second call site):
--
--   * `app_current_org() IS NULL` is DEF-0019 ITSELF. It is NULL not only in
--     owner context but for EVERY authenticated session with no
--     `user_profiles` row -- a fresh sign-up, `enable_signup = true`, nothing
--     creates a profile on sign-up. Such a session carries a real `auth.uid()`
--     and is bound by every other rule in this repo; exempting it from THIS
--     guard would let it resize any assignment onto any absence under `block`
--     for a company it does not belong to, wide open, silently. AB34 below
--     pins exactly this shape and is the case that would go red if this
--     migration were "corrected" to use this key instead.
--   * `session_user` is ruled out by 0020's own note (grep `session_user` in
--     `20260826000020_site_ownership.sql`): under PostgREST it is always
--     `authenticator`, and in this repo's SQL harness it is the superuser
--     connection itself, so a test keyed on it would disagree with production
--     in the direction that HIDES the hole -- every real caller and every
--     harness caller would look identical to this key.
--   * `auth.uid() IS NULL` means no jwt sub claim is set at all: owner
--     context (the seed, a superuser `psql` session, a backfill script, a
--     suite case after `set_config('request.jwt.claim.sub','',true)`) and
--     NOTHING ELSE. A PostgREST `authenticated` session always carries a sub,
--     profile or no profile, so it is bound regardless; `anon` was already
--     revoked from every table-level write path this trigger sits on. AB33
--     below pins that owner context resizes onto an absence under `block`
--     and succeeds -- the exemption actually firing, not just failing to
--     break anything.
--
-- Extracted from 0070 (its own last definition, the only one that exists),
-- with exactly one guard added at the top and nothing else moved: the
-- trigger's own `create trigger` statement is untouched (its WHEN clause
-- already decided which UPDATEs are in scope; this migration decides which
-- CALLERS are, inside the function body it already owns) and is not
-- re-emitted here -- `create or replace function` redefines the body under
-- the same name the existing trigger already points at.
-- ============================================================================

create or replace function app_guard_assignment_resize() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_elig jsonb;
  v_absence jsonb;
begin
  -- DEF-0019, second call site (0068's own key, not re-derived): no jwt sub
  -- at all means no caller identity, which is owner context and nothing
  -- else. Such a caller already bypasses RLS on this table outright, so this
  -- trigger is the only place that would otherwise refuse them, over a
  -- question (`check_eligibility`'s own `app_can_read_node` gate, which has
  -- no owner exemption of its own) that was never about them. See this
  -- migration's header for why this is the key and the other two are not.
  if auth.uid() is null then
    return new;
  end if;

  -- R-331: the SAME policy resolution `check_eligibility` itself performs
  -- (`app_resolve_node_setting(p_node_id, 'eligibility_policy')`, defaulted
  -- to 'warn') -- read off ITS OWN ANSWER rather than resolved a second way,
  -- so this can never drift from what the four writers already ask
  -- (CLAUDE.md §4, "extract, never retype"). `check_eligibility` guards the
  -- org boundary itself (`app_can_read_node`), exactly as it does for them.
  v_elig := check_eligibility(new.node_id, new.operator_id, new.timerange);

  if v_elig->>'policy' = 'block' then
    if not (v_elig->>'eligible')::boolean then
      perform api_raise('not_eligible',
        'operator is not eligible for this node/window under block policy',
        jsonb_build_object('operator_id', new.operator_id, 'node_id', new.node_id,
                           'missing_skills', v_elig->'missing_skills',
                           'expiring_skills', v_elig->'expiring_skills',
                           'policy', v_elig->>'policy'));
    end if;

    -- `absence_overlap` is org-scoped and SECURITY DEFINER the same way, and
    -- is asked only once policy is known to be `block` -- a `warn` answer is
    -- never acted on in here at all (see 0070's header: the trigger stays
    -- silent).
    v_absence := absence_overlap(new.operator_id, new.timerange);
    if (v_absence->>'absent')::boolean then
      perform api_raise('absent',
        'operator is absent for this window under block policy',
        jsonb_build_object('operator_id', new.operator_id, 'node_id', new.node_id,
                           'absence', v_absence, 'policy', v_elig->>'policy'));
    end if;
  end if;

  -- warn: silent by design (0070's header, R-361 decision 3). A trigger
  -- cannot return a warning; the client owns the sentence
  -- (useDragGesture.ts).
  return new;
end $$;

comment on function app_guard_assignment_resize() is
  'R-361, DEF-0019 (0071). BEFORE UPDATE trigger body for assignments_resize_guard: re-asks check_eligibility and absence_overlap, under the SAME resolved policy the four scheduler writers (create_assignment/move_run/reassign_assignment/apply_copy_week) already ask, whenever a plain UPDATE moves an assignment''s timerange or changes its operator_id. Under block it refuses with the same codes and DETAIL shape the four raise (not_eligible, absent); under warn it stays silent by construction (a trigger cannot return a warning) and the client (useDragGesture.ts) mirrors the same two questions to toast what the write allowed through. The trigger''s own WHEN clause fires only when NEW.operator_id IS NOT NULL (delete_owned_row/D110 clearing a departed person''s operator_id to NULL is exempt, AB32). The function body itself is exempt for auth.uid() IS NULL --- owner context, the same key and the same reasoning as 0068''s app_resolve_node_setting/resolve_shift_template, added in 0071 after DEF-0019 recurred here (AB33/AB34): a caller with no jwt sub already bypasses RLS on this table entirely, and check_eligibility''s own app_can_read_node gate has no owner exemption of its own, so without this early return an owner-context write (the seed, a superuser session, a backfill) was refused not_permitted for a question that was never about them.';

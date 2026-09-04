-- ============================================================================
-- 20260828000030_area_override.sql — D113.
--
-- Stage 20 asked for two things: *"the database refuses an assignment outside
-- someone's area, and a supervisor can override it while recording a reason."*
-- D109 delivered the first half sideways — `app_guard_assignment_scope` (0028
-- §4) refuses exactly that — and nobody noticed, because 0028 was reasoned
-- about as an ownership change and its scheduling half quietly answered a
-- different stage's requirement in the strictest possible way. Measured before
-- writing this:
--
--   as the COMPANY ADMIN, the one account no permission check refuses,
--   p_eligibility_override := true with a reason, on a cell in their own org
--     -->  PT409  not_offered_here
--          "That person does not belong to this part of the structure."
--
-- So what shipped is STRICTER than what was asked for. This migration cuts the
-- door.
--
-- The maintainer, 28 August, asked who should hold the key:
--
--   > **Anyone who can schedule there.** A supervisor with edit rights on the
--   > cell may place someone outside their area, recording a reason. The area
--   > rule becomes a strong warning rather than a wall, and the audit log
--   > carries who waved it through.
--
-- ----------------------------------------------------------------------------
-- ⭐⭐ WHY THIS IS A COLUMN AND NOT AN RPC ARGUMENT.
--
-- The refusal is a TRIGGER. It fires on INSERT and on UPDATE OF node_id,
-- operator_id, product_id — for every writer, including a plain PostgREST
-- `PATCH` that passes through no RPC at all, and including `service_role`.
-- An override expressed as a function parameter, or as a transaction-local
-- GUC an RPC sets, is reachable only from the paths somebody remembered to
-- plumb. **A column rides on the row, so every writer supplies it or does
-- not, and the guard reads the same field whichever door was used.**
--
-- That is D110's lesson arriving one migration later: a door built on one
-- screen is a door that refuses from the other screen.
--
-- ----------------------------------------------------------------------------
-- ⭐⭐ AND THE PRODUCT HALF IS NOT TOUCHED. THE PROOF IN 0029 DEPENDS ON IT.
--
-- 0029's `delete_owned_row` is `SECURITY INVOKER` and needs no escalation
-- because of one claim: every run and assignment carrying an owned row sits
-- inside that row's owner, so admin-over-the-owner implies edit-over-every-
-- affected-node. **An overridable product scope would falsify that** — a
-- product could then sit on a node its owner does not cover, the ancestor
-- chain would break, and `delete_owned_row`'s ROW_COUNT guard would start
-- refusing deletes for a reason nobody could see.
--
-- The two halves are separate `if` blocks precisely so one can be opened
-- without the other. **Re-read §19.74's proof before ever giving the product
-- half a door.** N-cases in `57_` assert the product half is still absolute,
-- including when the override flag is set.
--
-- ----------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT DONE.
--
-- 1. **IT IS NOT `eligibility_override`, AND THAT IS THE WHOLE POINT.** That
--    flag governs `check_eligibility` — the TRAINING question — and nothing
--    else. A supervisor waving through "no Welding ticket" must not silently
--    also place someone in a plant they are not cleared for: **the weaker
--    permission would grant the stronger one.** Two flags, two reasons, two
--    decisions. The board already renders the old one as "· certification
--    override", so reusing it would also relabel every area override as a
--    certification one.
--
-- 2. **NO PERMISSION CHECK INSIDE THE TRIGGER.** "Anyone who can schedule
--    there" is exactly `app_can_edit_node(node_id)`, which is already the
--    `assignments_insert` / `assignments_update` policy — so a second copy
--    inside the guard would be a check that always runs behind one that
--    always runs first, and gotcha 17 says such a copy cannot be
--    mutation-tested. It would also be WRONG: the trigger fires for the seed
--    and for `service_role`, where `app_current_org()` is NULL and
--    `app_can_edit_node` answers false for everybody. **RLS is the permission
--    gate; the trigger is the scope rule.** Case A12 proves the gate is
--    reachable — a viewer with no edit rights is still refused, by 42501.
--
-- 3. **NO AUTOMATIC OVERRIDE ANYWHERE.** `move_run` already sets
--    `eligibility_override` by itself, with a machine-written reason, when a
--    moved crew member turns out untrained (0009 §5). Nothing here copies
--    that. D113 says *recording a reason*, and a reason the system wrote is
--    not one anybody recorded — it is a log line wearing an accountability
--    field's clothes. Every path takes the reason from its caller or refuses.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1. The flag and the reason.
--
-- ⭐ THE CHECK IS AN EQUIVALENCE, NOT AN IMPLICATION. `area_override` and
-- `area_override_reason` are two halves of one fact, so a flag with no reason
-- is inadmissible AND a reason with no flag is inadmissible. Written as a
-- single `=` between two booleans, which is the whole rule in one line and
-- cannot be half-satisfied.
-- ---------------------------------------------------------------------------
alter table assignments
  add column area_override        boolean not null default false,
  add column area_override_reason text;

alter table assignments add constraint assignments_area_override_reasoned
  check (area_override = (area_override_reason is not null));

comment on column assignments.area_override is
  'D113: this assignment deliberately places somebody outside the part of the structure they belong to. Set by the writer; NORMALISED BACK TO FALSE by app_guard_assignment_scope when the row did not actually need it, so the flag always means "this really did override something". Never set automatically — see migration 0030 §3 of "what is deliberately not done".';
comment on column assignments.area_override_reason is
  'D113: why. Required exactly when area_override is true (assignments_area_override_reasoned). NOT the same field as override_reason, which belongs to the training check.';
comment on constraint assignments_area_override_reasoned on assignments is
  'D113: the flag and the reason are two halves of one fact. A flag with no reason is an unaccountable override; a reason with no flag is a sentence nobody can act on.';

-- ---------------------------------------------------------------------------
-- §2. The guard learns the word "unless".
--
-- ⚠️ EXTRACTED FROM THE LIVE DATABASE with `pg_get_functiondef`, from a
-- database with all 29 prior migrations applied — 0029 re-emitted this
-- function, so a copy taken from 0028 would silently revert the NULL-operator
-- split that 0029's D23 exists to pin.
--
-- ⭐ THE NORMALISATION IS THE SUBTLE PART. A BEFORE trigger may rewrite NEW,
-- so when the row turns out NOT to need the override the flag is turned off
-- and the reason dropped. Without that, "override" would come to mean "the
-- client sent a flag", the board would badge ordinary assignments as
-- overridden, and the audit trail would fill with reasons for things nobody
-- overrode. `eligibility_override` does the same thing one layer up
-- (`v_use_override` in `create_assignment`, 0009 §5) and for the same reason;
-- this does it in the trigger because the trigger is the only place every
-- writer passes through.
-- ---------------------------------------------------------------------------
create or replace function app_guard_assignment_scope() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_needed boolean := false;
begin
  if new.operator_id is not null then
    -- See app_guard_run_scope: a row that is not in this org at all is the
    -- foreign key's business, not this trigger's.
    select o.site_node_id into v_owner from operators o
     where o.id = new.operator_id and o.org_id = new.org_id;
    if not found then return new; end if;
    if not app_owner_covers_in_org(new.org_id, v_owner, new.node_id) then
      -- D113: the door. `area_override` says a person with edit rights on this
      -- cell has decided to place them here anyway and has said why; RLS is
      -- what checked that they may (see §2 of "what is deliberately not done").
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
  -- so this branch is only reached for the product-direct shape.
  -- ⚠️ NO DOOR HERE, AND NOT BY OVERSIGHT. Migration 0029's proof that
  -- `delete_owned_row` needs no escalation depends on a product never sitting
  -- outside its owner. `area_override` is not consulted below.
  if new.product_id is not null then
    select p.site_node_id into v_owner from products p
     where p.id = new.product_id and p.org_id = new.org_id;
    if not found then
      -- Normalise before the early return too, or a row whose product is in
      -- another org keeps a flag the operator half already decided about.
      if not v_needed then
        new.area_override := false; new.area_override_reason := null;
      end if;
      return new;
    end if;
    if not app_owner_covers_in_org(new.org_id, v_owner, new.node_id) then
      perform api_raise('not_offered_here',
        'That product does not belong to this part of the structure.',
        jsonb_build_object('kind', 'product', 'id', new.product_id,
                           'owner_node_id', v_owner, 'node_id', new.node_id));
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
  'D109 + D113. Refuses an assignment whose operator or product is not owned by an ancestor-or-self of its node. The OPERATOR half defers to assignments.area_override (a supervisor placing somebody outside their area, with a reason); the PRODUCT half has no override and migration 0029 §"why this can be SECURITY INVOKER" depends on that. Normalises the flag off when the row did not need it.';

-- ---------------------------------------------------------------------------
-- §3. `create_assignment` carries the override.
--
-- ⚠️ ADDING PARAMETERS MAKES A NEW FUNCTION, SO THE OLD ONE IS DROPPED — AND
-- `DROP FUNCTION` TAKES ITS GRANTS WITH IT (gotcha 2). Without the regrant at
-- the foot of this file, every caller gets `permission denied for function`
-- from a migration whose own tests would pass, because the suite's fixtures
-- run as the table owner. Dropping rather than leaving both signatures in
-- place is deliberate: two overloads differing only in trailing defaults is a
-- call site away from resolving to the one without the door.
-- ---------------------------------------------------------------------------
drop function if exists create_assignment(uuid, uuid, uuid, uuid, tstzrange, numeric, numeric, text, boolean, text);

CREATE OR REPLACE FUNCTION create_assignment(
  p_node_id uuid,
  p_operator_id uuid,
  p_run_id uuid,
  p_product_id uuid,
  p_timerange tstzrange,
  p_efficiency numeric DEFAULT 1.000,
  p_target_qty numeric DEFAULT NULL,
  p_target_unit text DEFAULT NULL,
  p_eligibility_override boolean DEFAULT false,
  p_override_reason text DEFAULT NULL,
  p_area_override boolean DEFAULT false,
  p_area_override_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org_id uuid;
  v_elig jsonb;
  v_assignment assignments%ROWTYPE;
  v_use_override boolean;
BEGIN
  IF p_timerange IS NULL OR isempty(p_timerange) THEN
    PERFORM api_raise('invalid_argument', 'p_timerange must be a non-empty range',
      jsonb_build_object('field', 'p_timerange', 'reason', 'null or empty'));
  END IF;
  IF num_nonnulls(p_run_id, p_product_id) <> 1 THEN
    PERFORM api_raise('invalid_argument', 'exactly one of p_run_id / p_product_id must be set',
      jsonb_build_object('field', 'p_run_id/p_product_id', 'reason', 'must set exactly one'));
  END IF;
  -- D113: refused HERE rather than by the table's CHECK, so the client gets
  -- `invalid_argument` naming the field instead of a bare 23514 it cannot read.
  IF p_area_override AND coalesce(btrim(p_area_override_reason), '') = '' THEN
    PERFORM api_raise('invalid_argument', 'an area override must say why',
      jsonb_build_object('field', 'p_area_override_reason', 'reason', 'required when p_area_override is true'));
  END IF;

  IF NOT app_can_edit_node(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'no edit rights on node', jsonb_build_object('node_id', p_node_id));
  END IF;

  SELECT org_id INTO v_org_id FROM nodes WHERE id = p_node_id;

  v_elig := check_eligibility(p_node_id, p_operator_id, p_timerange);

  IF NOT (v_elig->>'eligible')::boolean THEN
    IF v_elig->>'policy' = 'block' THEN
      -- block: no override is possible, regardless of p_eligibility_override.
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window under block policy',
        jsonb_build_object('operator_id', p_operator_id, 'node_id', p_node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    ELSIF NOT p_eligibility_override THEN
      -- warn, no override supplied: never silently allow it.
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window; override required under warn policy',
        jsonb_build_object('operator_id', p_operator_id, 'node_id', p_node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    END IF;
  END IF;

  -- eligibility_override is only meaningful when it actually overrode a
  -- genuine ineligibility under warn policy (the branch above already
  -- refused to reach here otherwise).
  v_use_override := NOT (v_elig->>'eligible')::boolean AND p_eligibility_override;

  INSERT INTO assignments (
    org_id, node_id, operator_id, run_id, product_id, timerange, efficiency,
    target_qty, target_unit, eligibility_override, override_reason,
    area_override, area_override_reason, created_by
  ) VALUES (
    v_org_id, p_node_id, p_operator_id, p_run_id, p_product_id, p_timerange, p_efficiency,
    p_target_qty, p_target_unit,
    v_use_override, CASE WHEN v_use_override THEN p_override_reason ELSE NULL END,
    -- Sent as asked; the trigger normalises it off if the row did not need it,
    -- which is why nothing here computes a `v_use_area_override` twin.
    p_area_override, CASE WHEN p_area_override THEN btrim(p_area_override_reason) ELSE NULL END,
    auth.uid()
  )
  RETURNING * INTO v_assignment;

  RETURN jsonb_build_object('assignment', to_jsonb(v_assignment), 'eligibility', v_elig);
END;
$function$;

-- ---------------------------------------------------------------------------
-- §4. `move_run` — the SECOND door, and the one that would have been missed.
--
-- Dragging a staffed run into another plant's cell updates `node_id` on every
-- crew row, so the guard fires once per crew member. Plumbing only
-- `create_assignment` would leave "place someone outside their area" working
-- from the operator panel and refusing from the board.
--
-- ⭐ AND IT PRE-CHECKS, LISTING EVERY AFFECTED PERSON, rather than letting the
-- trigger raise about whichever row it reached first. A run with five crew and
-- three outside their area would otherwise refuse three times, one name per
-- attempt. This mirrors the shape 0009 already uses for `block` policy —
-- *"aborts the whole move ... listing every affected operator"*.
-- ⚠️ THE PRE-CHECK CALLS `app_owner_covers`, THE SAME RULE THE TRIGGER ASKS.
-- It is not a second implementation and cannot drift from it; it exists only
-- to collect the names.
--
-- ⭐ AND IT IS `app_owner_covers`, NOT `app_owner_covers_in_org`, WHICH THE
-- SUITE TAUGHT ME. The trigger-side twin takes the tenant as a parameter and
-- 0028 granted it to NOBODY on purpose — that free parameter is the leak shape
-- 0023's review named. `move_run` is `SECURITY INVOKER`, so calling it from
-- here is `permission denied for function app_owner_covers_in_org`, which is
-- exactly what 60_api_test.sql reported on the first run of this migration.
--
-- The session-scoped twin gives the identical answer here, and that is a
-- proof rather than a hope: `app_can_edit_node(p_node_id)` above already
-- refused any caller for whom `app_current_org()` is NULL or differs from the
-- target node's org, so by this line `app_current_org() = v_org_id` and the
-- two functions test the same pair against the same tenant. Case A9 pins the
-- premise — no session reaches this code at all, it is refused earlier and
-- with `not_permitted`.
--
-- ⚠️ ONE REASON COVERS THE WHOLE MOVE, unlike `create_assignment` where one
-- reason covers one person. That is the honest shape of the gesture — the
-- supervisor is deciding about a move, not about five people individually —
-- and it is stated here so nobody reads the repeated reason as a bug.
-- ---------------------------------------------------------------------------
drop function if exists move_run(uuid, uuid, tstzrange);

CREATE OR REPLACE FUNCTION public.move_run(p_run_id uuid, p_node_id uuid, p_timerange tstzrange,
  p_area_override boolean DEFAULT false, p_area_override_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_run runs%ROWTYPE;
  v_old_node_id uuid;
  v_old_start timestamptz;
  v_delta interval;
  v_conflicting_run_id uuid;
  v_policy text;
  v_org_id uuid;
  v_warnings jsonb := '[]'::jsonb;
  v_updated_assignments jsonb;
  rec RECORD;
  v_elig jsonb;
  v_new_range tstzrange;
  v_outside jsonb := '[]'::jsonb;  -- D113
  v_reason text;                   -- D113
BEGIN
  IF p_timerange IS NULL OR isempty(p_timerange) THEN
    PERFORM api_raise('invalid_argument', 'p_timerange must be a non-empty range',
      jsonb_build_object('field', 'p_timerange', 'reason', 'null or empty'));
  END IF;
  -- D113: refused here rather than by the table CHECK, so the client gets
  -- `invalid_argument` naming the field instead of a bare 23514.
  IF p_area_override AND coalesce(btrim(p_area_override_reason), '') = '' THEN
    PERFORM api_raise('invalid_argument', 'an area override must say why',
      jsonb_build_object('field', 'p_area_override_reason', 'reason', 'required when p_area_override is true'));
  END IF;
  v_reason := btrim(p_area_override_reason);

  SELECT * INTO v_run FROM runs WHERE id = p_run_id;
  IF v_run.id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'run not found', jsonb_build_object('field', 'p_run_id', 'reason', 'not found'));
  END IF;
  v_old_node_id := v_run.node_id;
  v_old_start := lower(v_run.timerange);
  v_org_id := v_run.org_id;

  -- 1. Edit rights on both the source and target node.
  IF NOT app_can_edit_node(v_old_node_id) OR NOT app_can_edit_node(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'edit rights required on both source and target node',
      jsonb_build_object('node_id', p_node_id));
  END IF;

  -- 2. Target node must have no other overlapping active run.
  SELECT id INTO v_conflicting_run_id
  FROM runs
  WHERE node_id = p_node_id AND id <> p_run_id AND status <> 'cancelled' AND timerange && p_timerange
  LIMIT 1;
  IF v_conflicting_run_id IS NOT NULL THEN
    PERFORM api_raise('run_overlap', 'target node already has an overlapping active run',
      jsonb_build_object('node_id', p_node_id, 'timerange', p_timerange::text,
                          'conflicting_run_id', v_conflicting_run_id));
  END IF;

  v_delta := lower(p_timerange) - v_old_start;

  -- ---- D113: who on this crew does not belong at the target node? ----
  -- Asked here only so the refusal can NAME ALL OF THEM AT ONCE. Without it the
  -- trigger raises about whichever row it reached first, so a run with five
  -- crew and three outside their area refuses three times, one name per
  -- attempt. Same shape as the `block`-policy pre-check below, and for the
  -- same stated reason: abort the whole move, listing every affected operator.
  --
  -- ⚠️ `app_owner_covers`, NOT `app_owner_covers_in_org`. The trigger-side twin
  -- takes the tenant as a free parameter and 0028 granted it to NOBODY on
  -- purpose; this function is SECURITY INVOKER, so calling it here is
  -- `permission denied for function app_owner_covers_in_org` -- which is what
  -- 60_api_test.sql reported on this migration's first run. The session-scoped
  -- twin gives the identical answer, and that is a proof rather than a hope:
  -- the edit-rights check above already refused any caller whose
  -- `app_current_org()` is NULL or differs from the target node's org, so by
  -- this line the two functions test the same pair against the same tenant.
  IF NOT p_area_override THEN
    FOR rec IN
      SELECT a.operator_id, o.site_node_id AS owner_node_id, o.display_name
        FROM assignments a JOIN operators o ON o.id = a.operator_id
       WHERE a.run_id = p_run_id AND a.status <> 'cancelled'
    LOOP
      IF NOT app_owner_covers(rec.owner_node_id, p_node_id) THEN
        v_outside := v_outside || jsonb_build_object('id', rec.operator_id,
                                                     'name', rec.display_name,
                                                     'owner_node_id', rec.owner_node_id);
      END IF;
    END LOOP;
    IF jsonb_array_length(v_outside) > 0 THEN
      PERFORM api_raise('not_offered_here',
        'Some of this crew do not belong to that part of the structure.',
        jsonb_build_object('kind', 'operator', 'node_id', p_node_id, 'operators', v_outside));
    END IF;
  END IF;

  SELECT COALESCE(o.settings->>'eligibility_policy', 'warn') INTO v_policy FROM orgs o WHERE o.id = v_org_id;

  -- Under block: pre-check every crew member against the target node BEFORE
  -- writing anything, so a violation aborts the whole move with nothing
  -- changed (brief §5: "aborts the whole move ... listing every affected
  -- operator").
  IF v_policy = 'block' THEN
    FOR rec IN
      SELECT a.operator_id, a.timerange FROM assignments a
      WHERE a.run_id = p_run_id AND a.status <> 'cancelled'
    LOOP
      v_new_range := tstzrange(lower(rec.timerange) + v_delta, upper(rec.timerange) + v_delta);
      v_elig := check_eligibility(p_node_id, rec.operator_id, v_new_range);
      IF NOT (v_elig->>'eligible')::boolean THEN
        v_warnings := v_warnings || jsonb_build_object('operator_id', rec.operator_id,
                                                         'missing_skills', v_elig->'missing_skills');
      END IF;
    END LOOP;
    IF jsonb_array_length(v_warnings) > 0 THEN
      PERFORM api_raise('not_eligible', 'one or more crew members are not eligible for the target node',
        jsonb_build_object('node_id', p_node_id, 'operators', v_warnings, 'policy', v_policy));
    END IF;
    v_warnings := '[]'::jsonb;
  END IF;

  -- 3. Update the run FIRST -- order matters: assignments_check_run_consistency
  -- must see the run's new node_id when the assignment rows update next.
  UPDATE runs SET node_id = p_node_id, timerange = p_timerange WHERE id = p_run_id
    RETURNING * INTO v_run;

  -- 4/5. Every attached assignment follows: node_id -> target, timerange
  -- shifted by the run's start delta (duration preserved even if the
  -- assignment extended past the run's old bounds -- clamp nothing). Under
  -- warn, an ineligible crew member does not block the move; they are
  -- returned as a warning and marked overridden.
  FOR rec IN
    SELECT * FROM assignments WHERE run_id = p_run_id AND status <> 'cancelled'
  LOOP
    v_new_range := tstzrange(lower(rec.timerange) + v_delta, upper(rec.timerange) + v_delta);
    v_elig := check_eligibility(p_node_id, rec.operator_id, v_new_range);

    IF NOT (v_elig->>'eligible')::boolean THEN
      v_warnings := v_warnings || jsonb_build_object('operator_id', rec.operator_id,
                                                       'missing_skills', v_elig->'missing_skills');
      UPDATE assignments
        SET node_id = p_node_id, timerange = v_new_range,
            eligibility_override = true,
            override_reason = format('run moved to %s', (SELECT name FROM nodes WHERE id = p_node_id)),
            -- D113: one reason covers the whole move, unlike create_assignment
            -- where one reason covers one person -- the supervisor is deciding
            -- about a move, not about five people individually. The trigger
            -- turns the flag off again on the rows that did not need it.
            area_override = p_area_override,
            area_override_reason = CASE WHEN p_area_override THEN v_reason ELSE NULL END
        WHERE id = rec.id;
    ELSE
      UPDATE assignments
        SET node_id = p_node_id, timerange = v_new_range,
            area_override = p_area_override,
            area_override_reason = CASE WHEN p_area_override THEN v_reason ELSE NULL END
        WHERE id = rec.id;
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.timerange), '[]'::jsonb)
    INTO v_updated_assignments FROM assignments a WHERE a.run_id = p_run_id;

  RETURN jsonb_build_object('run', to_jsonb(v_run), 'assignments', v_updated_assignments,
                             'eligibility_warnings', v_warnings);
END;
$function$;

-- ---------------------------------------------------------------------------
-- §5. `apply_split_coverage` threads it through.
--
-- Same signature, so `CREATE OR REPLACE` and no grant dance. It writes its new
-- row by CALLING `create_assignment`, so the override has to be lifted out of
-- the `p_new_assignment` envelope and passed on — three layers, and the middle
-- one is exactly the sort of thing a change plumbs the first and third of.
-- ---------------------------------------------------------------------------
-- ⚠️ THE BODY BELOW IS `pg_get_functiondef`'s OUTPUT WITH ONE STRING
-- REPLACEMENT APPLIED, and the first attempt at this section was NOT. Writing
-- it out by hand from a grep of the parts that looked relevant silently dropped
-- its shape validation, its per-node edit-rights checks and the initialiser on
-- `v_new_json` -- the suite caught it as `null value in column "efficiency"`,
-- an error about none of those things. [[verification-standard]] rule 12 exists
-- for exactly this and I stepped over it. Extract, replace, assert the anchor
-- matched once, diff.
CREATE OR REPLACE FUNCTION public.apply_split_coverage(p_adjustments jsonb, p_new_assignment jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_adj jsonb;
  v_assignment_id uuid;
  v_efficiency numeric;
  v_node_id uuid;
  v_adjusted jsonb := '[]'::jsonb;
  v_new_json jsonb := 'null'::jsonb;
BEGIN
  -- ---- Validate shapes first, before touching any row. ----
  IF p_adjustments IS NULL OR jsonb_typeof(p_adjustments) <> 'array' THEN
    PERFORM api_raise('invalid_argument', 'p_adjustments must be a JSON array',
      jsonb_build_object('field', 'p_adjustments', 'reason', 'missing or not an array'));
  END IF;

  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments)
  LOOP
    IF (v_adj->>'assignment_id') IS NULL THEN
      PERFORM api_raise('invalid_argument', 'adjustment missing assignment_id',
        jsonb_build_object('field', 'assignment_id', 'reason', 'missing'));
    END IF;
    IF (v_adj->>'efficiency') IS NULL THEN
      PERFORM api_raise('invalid_argument', 'adjustment missing efficiency',
        jsonb_build_object('field', 'efficiency', 'reason', 'missing'));
    END IF;
  END LOOP;

  IF p_new_assignment IS NOT NULL THEN
    IF (p_new_assignment->>'node_id') IS NULL OR (p_new_assignment->>'operator_id') IS NULL
       OR (p_new_assignment->>'timerange') IS NULL THEN
      PERFORM api_raise('invalid_argument', 'p_new_assignment missing a required field',
        jsonb_build_object('field', 'p_new_assignment', 'reason', 'missing node_id/operator_id/timerange'));
    END IF;
  END IF;

  -- ---- Edit-rights check on every node touched, before any write. ----
  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments)
  LOOP
    SELECT node_id INTO v_node_id FROM assignments WHERE id = (v_adj->>'assignment_id')::uuid;
    IF v_node_id IS NULL OR NOT app_can_edit_node(v_node_id) THEN
      PERFORM api_raise('not_permitted', 'no edit rights on an adjusted assignment''s node',
        jsonb_build_object('node_id', v_node_id));
    END IF;
  END LOOP;
  IF p_new_assignment IS NOT NULL AND NOT app_can_edit_node((p_new_assignment->>'node_id')::uuid) THEN
    PERFORM api_raise('not_permitted', 'no edit rights on the new assignment''s node',
      jsonb_build_object('node_id', (p_new_assignment->>'node_id')::uuid));
  END IF;

  -- ---- Apply the adjustments FIRST, then the new assignment. ----
  -- The capacity trigger (assignments_capacity) fires per row: on UPDATE OF
  -- efficiency for the dial-downs below, and on INSERT for the new
  -- assignment. If the new assignment were inserted BEFORE the existing
  -- rows were dialled down, its capacity check would run against the
  -- un-adjusted (higher) peak and the whole transaction would be rejected
  -- even though the end state is legal -- adjust-then-insert is the entire
  -- reason this function exists instead of the client sending three
  -- separate writes. Do NOT reorder this: acceptance item 20 rolls back an
  -- explicit insert-before-adjust attempt to prove it fails.
  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments)
  LOOP
    v_assignment_id := (v_adj->>'assignment_id')::uuid;
    v_efficiency := (v_adj->>'efficiency')::numeric;
    UPDATE assignments SET efficiency = v_efficiency WHERE id = v_assignment_id;
    v_adjusted := v_adjusted || (SELECT to_jsonb(a) FROM assignments a WHERE a.id = v_assignment_id);
  END LOOP;

  IF p_new_assignment IS NOT NULL THEN
    v_new_json := create_assignment(
      (p_new_assignment->>'node_id')::uuid,
      (p_new_assignment->>'operator_id')::uuid,
      (p_new_assignment->>'run_id')::uuid,
      (p_new_assignment->>'product_id')::uuid,
      (p_new_assignment->>'timerange')::tstzrange,
      COALESCE((p_new_assignment->>'efficiency')::numeric, 1.000),
      (p_new_assignment->>'target_qty')::numeric,
      p_new_assignment->>'target_unit',
      COALESCE((p_new_assignment->>'eligibility_override')::boolean, false),
      p_new_assignment->>'override_reason',
      -- D113, and the layer a plumbing change forgets: this function writes its
      -- new row by CALLING create_assignment, so the override has to be lifted
      -- out of the envelope and passed on. Three layers -- the client's object
      -- literal, this extraction, and create_assignment's parameter -- and this
      -- is the middle one.
      COALESCE((p_new_assignment->>'area_override')::boolean, false),
      p_new_assignment->>'area_override_reason'
    );
    v_new_json := v_new_json->'assignment';
  END IF;

  RETURN jsonb_build_object('adjusted', v_adjusted, 'assignment', v_new_json);
END;
$function$;

-- ---------------------------------------------------------------------------
-- §6. Grants. Two functions were DROPPED and re-created above, so they are new
-- functions carrying PostgreSQL's default PUBLIC grant and none of their old
-- ones (gotcha 2). `apply_split_coverage` kept its signature and its grants.
-- ---------------------------------------------------------------------------
revoke execute on function create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text) from public;
revoke execute on function move_run(uuid,uuid,tstzrange,boolean,text) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text) to authenticated';
    execute 'grant execute on function move_run(uuid,uuid,tstzrange,boolean,text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text) from anon';
    execute 'revoke all on function move_run(uuid,uuid,tstzrange,boolean,text) from anon';
  end if;
end $$;

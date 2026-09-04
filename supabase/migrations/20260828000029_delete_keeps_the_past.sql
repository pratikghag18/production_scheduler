-- ============================================================================
-- 20260828000029_delete_keeps_the_past.sql — D110.
--
-- The maintainer, 28 August:
--
--   "When it is deleted, we give a warning to the user that all the
--    corresponding data will be deleted and encourage them deactivate to
--    retain the data instead. This will be handled by site admin so it their
--    call in the end."
--
-- and, settling the line this migration turns on:
--
--   "the row disappears from the list and from anything not yet started;
--    completed runs keep their record of it."
--
-- ----------------------------------------------------------------------------
-- WHAT "NOT YET STARTED" MEANS HERE, AND WHY IT IS THE CLOCK AND NOT `status`.
--
-- `runs.status` exists ('planned','active','done','cancelled') and nothing in
-- the product ever advances it: every run this system has created is still
-- 'planned', including the ones that finished last week. A delete that trusted
-- `status` would therefore destroy history rather than keep it — the exact
-- opposite of what it is for. So the line is drawn on the clock:
--
--   NOT YET STARTED  ==  lower(timerange) > now()
--
-- and everything else is kept. Note the direction of the NULL: an unbounded
-- lower bound makes `lower()` NULL, the comparison NULL, and the row falls to
-- the KEPT side. A row whose start we cannot name is not a row we delete.
--
-- ----------------------------------------------------------------------------
-- ⭐⭐ WHY THIS CAN BE `SECURITY INVOKER`, WHICH IS THE WHOLE SHAPE OF THE FILE.
--
-- Deleting a product deletes runs on cells the deleter never named. Before
-- D109 that was a genuine privilege question — a company-wide product could
-- sit on any plant's board, so a "delete this product" that reached those runs
-- would have to run as somebody bigger than its caller, and `SECURITY DEFINER`
-- would have been the only way to write it. D109 removed the precondition:
--
--   CLAIM. If the caller may delete owned row X, the caller may edit every
--   run and every assignment that references X.
--
--   PROOF. `<table>_delete` (0028 §8) admits two ways. If `app_is_admin()`,
--   the caller is a company admin and `app_can_edit_node` is true for every
--   node in the org by its own first branch. Otherwise `app_is_admin_for(o)`
--   for the owning node o, i.e. there is an admin grant path g with
--   `o.path <@ g`. Let r be the node of any run carrying X. D109's guard
--   (`app_guard_run_scope`, 0028 §4) admitted that run only if
--   `o.path @> r.path`, so `r.path <@ o.path <@ g`, so
--   `app_is_admin_on_path(r.path)` holds and `app_can_edit_node(r)` is true
--   (0019 §5). The same argument runs for assignments through
--   `app_guard_assignment_scope`, and for `node_skill_requirements` /
--   `node_shift_templates` through their own guards and
--   `app_is_admin_for(node_id)`. ∎
--
-- So RLS is left switched on underneath this migration's RPC and is the
-- second gate rather than a bypassed one. ⚠️ THE PROOF IS NOT LEFT AS AN
-- ARGUMENT: a refused DELETE removes zero rows and reports no error at all
-- (§19.63's "a USING clause merely filters"), so every destructive statement
-- below counts what it means to touch first and compares `ROW_COUNT`
-- afterwards, raising `not_permitted` on any difference. If the proof is ever
-- falsified the call fails loudly instead of half-deleting somebody's
-- schedule. Case D24 in `56_` is that comparison firing.
--
-- ⚠️ AND IT DEPENDS ON D109 CONTINUING TO HOLD. If a future migration
-- re-admits a row onto a node its owner does not cover, this function starts
-- silently under-deleting (the count guard turns it into a refusal, so the
-- symptom is "delete stopped working", not "delete leaked"). Re-read this
-- section before weakening any guard in 0028 §4.
--
-- ----------------------------------------------------------------------------
-- WHY TWO DIFFERENT MECHANISMS, AND THE LINE BETWEEN THEM.
--
-- Products and operators APPEAR IN HISTORY: a finished run says which part it
-- made, a finished assignment says who worked it. Deleting one of those must
-- leave the board still able to draw last week, so the row's identity is
-- copied onto the history that survives (§3) and the reference is released.
--
-- Trainings and shift patterns are PRESENT-TENSE CONFIGURATION: "this cell
-- requires a forklift licence", "this line runs pattern B". Nothing records
-- which pattern a cell ran in March, so there is no past to keep, and their
-- join rows go with the parent by ordinary `ON DELETE CASCADE` (§5) rather
-- than through bespoke code.
--
-- ⚠️ A CASCADE DELETES ROWS RLS WOULD NOT HAVE LET THE CALLER DELETE DIRECTLY,
-- because referential actions run as the table owner. That is ordinary FK
-- semantics — `shifts` has cascaded from `shift_templates` since 0005 — and it
-- matters here for a reason worth naming: `app_guard_operator_skill_scope`
-- (0028 §4) is COMPARABILITY, not containment, so a Plant-A-wide person may
-- legitimately hold a Line-1 training. A Line 1 site admin deleting that
-- training is not admin for that person, and `operator_skills_delete` would
-- refuse the row. The cascade is what stops "delete this training" from being
-- a dead end nobody in the org can complete. Nothing here widens who may
-- delete the training itself.
--
-- ----------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT DONE.
--
-- 1. `active` IS STILL ADVISORY, ON ALL FOUR TABLES. Nothing in the database
--    refuses a run of a deactivated product today, and this migration does not
--    start refusing one — it adds the missing columns so the four tables mean
--    the same thing, and leaves the meaning where it was. Making `active`
--    binding is a real decision (it would refuse a MOVE of an existing run of
--    a deactivated part, not just a new one) and it belongs to whoever asks
--    for it, not to a migration about deleting.
--
-- 2. NO SNAPSHOT AT SCHEDULING TIME. The copy is taken at DELETE time, so a
--    typo fixed in a product's name still fixes it everywhere including the
--    past, which is what people expect a rename to do. The cost is stated
--    rather than hidden: this system does not record what a run was called
--    when it was scheduled, only what its product is called now, or was
--    called when it was deleted.
--
-- 3. NO CHANGE TO `board_window`. `runs` and `assignments` are emitted with
--    `to_jsonb(r)` (0014 §6), so the four snapshot columns reach the client
--    the moment they exist. The board's fallback — draw the run's own
--    remembered sku when `product_id` is null — is client work, not this.
--
-- 4. THE PLAIN TABLE DELETE IS LEFT EXACTLY AS IT WAS. `DELETE FROM products`
--    still fails with 23503 against a scheduled product, which is what
--    `deleteProduct` in `src/lib/api/products.ts` documents and relies on.
--    The orchestrated delete is a new door, not a widening of that one, so a
--    caller that has not been taught D110 still cannot destroy history by
--    accident.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1. `active` on the two tables that never had it.
--
-- `products.active` and `operators.active` have existed since 0002. Skills and
-- shift templates were given none, so "we don't use that pattern any more" had
-- no expression short of deleting it — which is precisely the choice D110 says
-- an admin should not be forced into.
-- ---------------------------------------------------------------------------
alter table skills          add column active boolean not null default true;
alter table shift_templates add column active boolean not null default true;

comment on column skills.active is
  'False = retired: not offered when qualifying a person or requiring a training on a cell. ADVISORY — the database does not refuse an existing holding, and nothing here starts refusing one (see §1 of migration 0029). The same meaning as products.active and operators.active.';
comment on column shift_templates.active is
  'False = retired: not offered when attaching a pattern to a node. ADVISORY, exactly as skills.active — nodes already attached keep resolving to it.';

-- ---------------------------------------------------------------------------
-- §2. The history snapshot columns.
--
-- Nullable, and null is the normal state: they are written only when the row
-- they name is deleted. A non-null `product_sku` on a run therefore means
-- exactly one thing — "the product this run made no longer exists, and this is
-- what it was called".
-- ---------------------------------------------------------------------------
alter table runs
  add column product_sku         text,
  add column product_name        text,
  add column product_color_token text;

alter table assignments
  add column product_sku           text,
  add column product_name          text,
  add column product_color_token   text,
  add column operator_display_name text;

comment on column runs.product_sku is
  'D110 history snapshot. NULL while the product exists; set from products.sku at the moment the product is deleted, when product_id is released to NULL. Exactly one of product_id / product_sku is ever non-null (runs_product_identified).';
comment on column assignments.operator_display_name is
  'D110 history snapshot. NULL while the person exists; set from operators.display_name at the moment they are deleted, when operator_id is released to NULL. Exactly one of operator_id / operator_display_name is ever non-null (assignments_operator_identified).';

-- ---------------------------------------------------------------------------
-- §3. Releasing the references, and the checks that keep the row meaningful.
--
-- ⭐ THE CHECKS ARE THE POINT OF THIS SECTION, NOT THE `DROP NOT NULL`.
-- Dropping NOT NULL on its own would make "a run with no product at all" a
-- legal row, which is not a thing this schema should be able to say. Each
-- column is replaced by a rule of the same strength: a run names its product
-- either by id or by memory, never both and never neither.
--
-- `assignments_check` (0003: "a run-attached assignment inherits its product
-- from the run; a direct one carries its own; exactly one, never both, never
-- neither") extends without changing shape — the remembered sku is simply a
-- third way of naming the same one thing, so `num_nonnulls(...) = 1` still
-- states the whole rule.
-- ---------------------------------------------------------------------------
alter table runs alter column product_id drop not null;
alter table runs add constraint runs_product_identified
  check (num_nonnulls(product_id, product_sku) = 1);

alter table assignments alter column operator_id drop not null;
alter table assignments add constraint assignments_operator_identified
  check (num_nonnulls(operator_id, operator_display_name) = 1);

alter table assignments drop constraint assignments_check;
alter table assignments add constraint assignments_work_identified
  check (num_nonnulls(run_id, product_id, product_sku) = 1);

comment on constraint runs_product_identified on runs is
  'D110: a run always says what it made — by product_id while the product exists, by product_sku once it has been deleted. Never both, never neither.';
comment on constraint assignments_work_identified on assignments is
  'D5 (0003) extended by D110: an assignment names its work exactly once — a run, a product, or a deleted product remembered by sku.';
comment on constraint assignments_operator_identified on assignments is
  'D110: an assignment always says who worked it — by operator_id, or by the name remembered when they were deleted.';

-- ---------------------------------------------------------------------------
-- §4. Two triggers meet a NULL they could not previously see.
--
-- ⚠️ EXTRACTED FROM THE LIVE DATABASE with pg_get_functiondef, not from the
-- migration that first wrote them (0009 amended both; a copy taken from 0003
-- would silently revert that). The peak query in check_operator_capacity is
-- untouched — see 0009's warning and acceptance items 8/9.
-- ---------------------------------------------------------------------------

-- A departed person has no capacity to exceed. Without this early return the
-- trigger asks operator_peak_load about operator NULL, which matches no
-- assignment, so `peak` becomes the row's own efficiency alone — and an
-- assignment written at efficiency 1.5 under a cap of 1.0 would refuse to be
-- snapshotted, i.e. deleting a person would fail on the history it is trying
-- to keep.
CREATE OR REPLACE FUNCTION check_operator_capacity() RETURNS trigger AS $fn$
DECLARE
  cap numeric;
  peak numeric;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  -- D110: the operator has been deleted and this row is history now.
  IF NEW.operator_id IS NULL THEN RETURN NEW; END IF;

  -- D2: cap is configurable per org (orgs.settings->>'capacity_cap'), default 1.0.
  SELECT COALESCE((o.settings->>'capacity_cap')::numeric, 1.0) INTO cap
  FROM orgs o WHERE o.id = NEW.org_id;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operator_id::text, 42));
  -- Peak calculation lives in operator_peak_load() (brief P1-3a §4) so the
  -- trigger and capacity_probe() are provably the same implementation.
  peak := operator_peak_load(NEW.operator_id, NEW.timerange, NEW.efficiency, NEW.id);
  IF peak > cap THEN
    PERFORM api_raise('capacity_exceeded',
      format('capacity exceeded: operator %s would reach %s (cap %s)', NEW.operator_id, peak, cap),
      jsonb_build_object('operator_id', NEW.operator_id, 'peak', peak, 'cap', cap, 'timerange', NEW.timerange::text));
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- ⭐ A LATENT SHORT-CIRCUIT, FOUND BY GIVING IT A NULL. 0028's version reads
-- the operator's owner and does `if not found then return new; end if;` — the
-- right answer when the operator belongs to another tenant (that is the
-- composite FK's refusal to give, not this trigger's; see 10_'s case 6) but a
-- RETURN that also skips the product half below it. With operator_id NULL now
-- reachable, that would leave the product scope of a direct assignment
-- unchecked. The two halves are separated; the "not in this org" short-circuit
-- inside the operator half is kept exactly as it was, so no existing refusal
-- changes which error it raises. Case D22 pins the product half firing while
-- the operator id is NULL.
create or replace function app_guard_assignment_scope() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  if new.operator_id is not null then
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
  end if;

  -- An assignment carries EITHER a run or a product (assignments_work_identified),
  -- so this branch is only reached for the product-direct shape.
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

-- `app_guard_run_scope` needs no change and is left alone deliberately: its
-- own `select ... where p.id = new.product_id` finds nothing when the id is
-- NULL, so it already returns NEW, and there is nothing after the check for a
-- premature return to skip. Case D21 asserts that rather than assuming it.

-- ---------------------------------------------------------------------------
-- §5. Present-tense configuration follows its parent.
--
-- Four composite foreign keys re-created with ON DELETE CASCADE. They are pure
-- join rows: a qualification is meaningless without both the person and the
-- training, a requirement without the training, an attachment without the
-- pattern. See the header for why a cascade — and not the RPC — is what makes
-- "delete this training" completable by the admin who owns it.
--
-- `shifts` and `shift_breaks` already cascade (0005) and are untouched.
-- ---------------------------------------------------------------------------
alter table operator_skills drop constraint operator_skills_org_id_skill_id_fkey;
alter table operator_skills add constraint operator_skills_org_id_skill_id_fkey
  foreign key (org_id, skill_id) references skills (org_id, id) on delete cascade;

alter table operator_skills drop constraint operator_skills_org_id_operator_id_fkey;
alter table operator_skills add constraint operator_skills_org_id_operator_id_fkey
  foreign key (org_id, operator_id) references operators (org_id, id) on delete cascade;

alter table node_skill_requirements drop constraint node_skill_requirements_org_id_skill_id_fkey;
alter table node_skill_requirements add constraint node_skill_requirements_org_id_skill_id_fkey
  foreign key (org_id, skill_id) references skills (org_id, id) on delete cascade;

alter table node_shift_templates drop constraint node_shift_templates_org_id_template_id_fkey;
alter table node_shift_templates add constraint node_shift_templates_org_id_template_id_fkey
  foreign key (org_id, template_id) references shift_templates (org_id, id) on delete cascade;

-- ---------------------------------------------------------------------------
-- §6. The four owner tables become auditable.
--
-- `runs` and `assignments` have carried write_audit_log since 0007, so the
-- schedule this migration destroys is already recorded. The catalogue row
-- itself was not: after a delete, the only evidence a product ever existed was
-- the sku copied onto its own history. `audit_log.before` now holds the whole
-- row. Same trigger, same function, four more tables.
-- ---------------------------------------------------------------------------
create trigger products_audit
  after insert or update or delete on products
  for each row execute function write_audit_log();
create trigger operators_audit
  after insert or update or delete on operators
  for each row execute function write_audit_log();
create trigger skills_audit
  after insert or update or delete on skills
  for each row execute function write_audit_log();
create trigger shift_templates_audit
  after insert or update or delete on shift_templates
  for each row execute function write_audit_log();

-- ---------------------------------------------------------------------------
-- §7. `deletion_preview` — the counts the dialog names.
--
-- ONE function over four kinds rather than four functions, because the dialog
-- is one component with one shape to render and a second grant is a second
-- thing to get wrong. `p_kind` is a closed set and an unrecognised value is
-- `invalid_argument`, never a silent empty answer.
--
-- ⭐ THE PAYLOAD IS READ BY KEY AND ITS `what` VALUES ARE TABLE NAMES, NOT
-- ENGLISH. "3 runs" is a sentence the client builds; "runs" is a fact the
-- database states. Every `what` relevant to a kind is emitted even at count 0,
-- so the client renders one list and never has to ask whether a key is absent
-- because the count was zero or because the contract changed.
--
-- `removes` and `keeps` are both scoped to rows the deletion TOUCHES, which is
-- what makes them comparable: for a product they are the runs carrying it and
-- the assignments hanging off those runs, split by the clock.
--
-- SECURITY INVOKER: the counts are RLS-filtered reads, so this answers about
-- the caller's own visible world. A row in another tenant is not found at all
-- — the same answer as an id that does not exist, which is the answer a probe
-- should get.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION deletion_preview(p_kind text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now   timestamptz := now();
  v_name  text;
  v_code  text;
  v_active boolean;
  v_removes jsonb := '[]'::jsonb;
  v_keeps   jsonb := '[]'::jsonb;
  v_a int; v_b int; v_c int;
BEGIN
  IF p_kind NOT IN ('product', 'operator', 'skill', 'shift_template') THEN
    PERFORM api_raise('invalid_argument',
      'p_kind must be one of product, operator, skill, shift_template',
      jsonb_build_object('field', 'p_kind', 'reason', format('unrecognised kind %s', p_kind)));
  END IF;

  IF p_kind = 'product' THEN
    SELECT p.name, p.sku, p.active INTO v_name, v_code, v_active
      FROM products p WHERE p.id = p_id;
    IF v_name IS NULL THEN
      PERFORM api_raise('invalid_argument', 'product not found',
        jsonb_build_object('field', 'p_id', 'reason', 'not found'));
    END IF;

    SELECT count(*) INTO v_a FROM runs r
      WHERE r.product_id = p_id AND lower(r.timerange) > v_now;
    SELECT count(*) INTO v_b FROM assignments a
      WHERE (a.run_id IN (SELECT r.id FROM runs r
                           WHERE r.product_id = p_id AND lower(r.timerange) > v_now))
         OR (a.product_id = p_id AND lower(a.timerange) > v_now);
    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'runs', 'count', v_a),
      jsonb_build_object('what', 'assignments', 'count', v_b));

    SELECT count(*) INTO v_a FROM runs r
      WHERE r.product_id = p_id AND (lower(r.timerange) <= v_now OR lower(r.timerange) IS NULL);
    SELECT count(*) INTO v_b FROM assignments a
      WHERE (a.run_id IN (SELECT r.id FROM runs r
                           WHERE r.product_id = p_id
                             AND (lower(r.timerange) <= v_now OR lower(r.timerange) IS NULL)))
         OR (a.product_id = p_id
             AND (lower(a.timerange) <= v_now OR lower(a.timerange) IS NULL));
    v_keeps := jsonb_build_array(
      jsonb_build_object('what', 'runs', 'count', v_a),
      jsonb_build_object('what', 'assignments', 'count', v_b));

  ELSIF p_kind = 'operator' THEN
    SELECT o.display_name, o.employee_ref, o.active INTO v_name, v_code, v_active
      FROM operators o WHERE o.id = p_id;
    IF v_name IS NULL THEN
      PERFORM api_raise('invalid_argument', 'operator not found',
        jsonb_build_object('field', 'p_id', 'reason', 'not found'));
    END IF;

    SELECT count(*) INTO v_a FROM assignments a
      WHERE a.operator_id = p_id AND lower(a.timerange) > v_now;
    SELECT count(*) INTO v_b FROM operator_skills os WHERE os.operator_id = p_id;
    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'assignments', 'count', v_a),
      jsonb_build_object('what', 'operator_skills', 'count', v_b));

    SELECT count(*) INTO v_a FROM assignments a
      WHERE a.operator_id = p_id
        AND (lower(a.timerange) <= v_now OR lower(a.timerange) IS NULL);
    v_keeps := jsonb_build_array(
      jsonb_build_object('what', 'assignments', 'count', v_a));

  ELSIF p_kind = 'skill' THEN
    SELECT s.name, NULL::text, s.active INTO v_name, v_code, v_active
      FROM skills s WHERE s.id = p_id;
    IF v_name IS NULL THEN
      PERFORM api_raise('invalid_argument', 'skill not found',
        jsonb_build_object('field', 'p_id', 'reason', 'not found'));
    END IF;

    SELECT count(*) INTO v_a FROM operator_skills os WHERE os.skill_id = p_id;
    SELECT count(*) INTO v_b FROM node_skill_requirements q WHERE q.skill_id = p_id;
    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'operator_skills', 'count', v_a),
      jsonb_build_object('what', 'node_skill_requirements', 'count', v_b));
    -- Nothing records which training a finished run needed, so there is no
    -- past to keep. An empty `keeps` is the honest answer and the dialog says
    -- so, rather than the client inferring silence.
    v_keeps := '[]'::jsonb;

  ELSE -- shift_template
    SELECT t.name, NULL::text, t.active INTO v_name, v_code, v_active
      FROM shift_templates t WHERE t.id = p_id;
    IF v_name IS NULL THEN
      PERFORM api_raise('invalid_argument', 'shift template not found',
        jsonb_build_object('field', 'p_id', 'reason', 'not found'));
    END IF;

    SELECT count(*) INTO v_a FROM shifts s WHERE s.template_id = p_id;
    SELECT count(*) INTO v_b FROM shift_breaks b
      WHERE b.shift_id IN (SELECT s.id FROM shifts s WHERE s.template_id = p_id);
    SELECT count(*) INTO v_c FROM node_shift_templates nst WHERE nst.template_id = p_id;
    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'shifts', 'count', v_a),
      jsonb_build_object('what', 'shift_breaks', 'count', v_b),
      jsonb_build_object('what', 'node_shift_templates', 'count', v_c));
    v_keeps := '[]'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'kind', p_kind, 'id', p_id, 'name', v_name, 'code', v_code,
    'active', v_active, 'removes', v_removes, 'keeps', v_keeps);
END;
$$;

-- ---------------------------------------------------------------------------
-- §8. `delete_owned_row` — the delete itself.
--
-- Returns the SAME shape `deletion_preview` returns, with `deleted` added and
-- the counts being what actually happened. The dialog can therefore report the
-- truth rather than re-reading its own preview: between the two calls somebody
-- else may have scheduled a run, and a screen that says "3 runs removed"
-- because that is what it predicted is a screen that lies once a year.
--
-- ⚠️ THE ORDER IS LOAD-BEARING. Every count is taken BEFORE anything changes,
-- then future rows are deleted, and only then does the snapshot write over
-- whatever survives — which is exactly the started ones, with no predicate
-- needed to say so. Snapshotting first would stamp a name onto rows about to
-- be deleted and would release `product_id` on them, after which "delete the
-- future ones" could no longer find them at all.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION delete_owned_row(p_kind text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now    timestamptz := now();
  v_owner  uuid;
  v_name   text;
  v_code   text;
  v_colour text;
  v_active boolean;
  v_removes jsonb := '[]'::jsonb;
  v_keeps   jsonb := '[]'::jsonb;
  -- Every count below is taken before the first mutation. `v_got` is the only
  -- variable that moves afterwards, and every mutation compares against it.
  v_got     int;
  v_rm_runs int; v_rm_asg int; v_kp_runs int; v_kp_asg int;
  v_crew    int; -- assignments hanging off runs that are about to be deleted
  v_direct  int; -- assignments carrying the product themselves
  v_kp_crew int; -- assignments hanging off runs that are kept
  v_extra   int; -- operator_skills / node_skill_requirements / shift rows
  v_extra2  int;
BEGIN
  IF p_kind NOT IN ('product', 'operator', 'skill', 'shift_template') THEN
    PERFORM api_raise('invalid_argument',
      'p_kind must be one of product, operator, skill, shift_template',
      jsonb_build_object('field', 'p_kind', 'reason', format('unrecognised kind %s', p_kind)));
  END IF;

  -- Identity and owner, RLS-filtered: an id in another tenant is "not found",
  -- the same answer as an id that never existed.
  IF p_kind = 'product' THEN
    SELECT p.site_node_id, p.name, p.sku, p.active INTO v_owner, v_name, v_code, v_active
      FROM products p WHERE p.id = p_id;
  ELSIF p_kind = 'operator' THEN
    SELECT o.site_node_id, o.display_name, o.employee_ref, o.active INTO v_owner, v_name, v_code, v_active
      FROM operators o WHERE o.id = p_id;
  ELSIF p_kind = 'skill' THEN
    SELECT s.site_node_id, s.name, NULL::text, s.active INTO v_owner, v_name, v_code, v_active
      FROM skills s WHERE s.id = p_id;
  ELSE
    SELECT t.site_node_id, t.name, NULL::text, t.active INTO v_owner, v_name, v_code, v_active
      FROM shift_templates t WHERE t.id = p_id;
  END IF;

  IF v_owner IS NULL THEN
    PERFORM api_raise('invalid_argument', format('%s not found', p_kind),
      jsonb_build_object('field', 'p_id', 'reason', 'not found'));
  END IF;

  -- The same test the table's own DELETE policy applies (0028 §8). Asked here
  -- as well so the refusal is an error the screen can name, rather than a
  -- DELETE that quietly removes nothing.
  IF NOT (app_is_admin() OR app_is_admin_for(v_owner)) THEN
    PERFORM api_raise('not_permitted', 'no admin rights over the site this row belongs to',
      jsonb_build_object('node_id', v_owner));
  END IF;

  IF p_kind = 'product' THEN
    -- ---- every count, before anything moves -------------------------------
    SELECT count(*) INTO v_rm_runs FROM runs r
      WHERE r.product_id = p_id AND lower(r.timerange) > v_now;
    SELECT count(*) INTO v_crew FROM assignments a
      WHERE a.run_id IN (SELECT r.id FROM runs r
                          WHERE r.product_id = p_id AND lower(r.timerange) > v_now);
    SELECT count(*) INTO v_direct FROM assignments a
      WHERE a.product_id = p_id AND lower(a.timerange) > v_now;
    v_rm_asg := v_crew + v_direct;

    SELECT count(*) INTO v_kp_runs FROM runs r
      WHERE r.product_id = p_id AND (lower(r.timerange) <= v_now OR lower(r.timerange) IS NULL);
    SELECT count(*) INTO v_kp_crew FROM assignments a
      WHERE a.run_id IN (SELECT r.id FROM runs r
                          WHERE r.product_id = p_id
                            AND (lower(r.timerange) <= v_now OR lower(r.timerange) IS NULL));
    SELECT count(*) INTO v_extra FROM assignments a
      WHERE a.product_id = p_id AND (lower(a.timerange) <= v_now OR lower(a.timerange) IS NULL);
    v_kp_asg := v_kp_crew + v_extra;

    SELECT p.color_token INTO v_colour FROM products p WHERE p.id = p_id;

    -- ---- 1. the crew of every run that is about to go ---------------------
    DELETE FROM assignments a
      WHERE a.run_id IN (SELECT r.id FROM runs r
                          WHERE r.product_id = p_id AND lower(r.timerange) > v_now);
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_crew THEN
      PERFORM api_raise('not_permitted', 'cannot remove every assignment on the runs this would delete',
        jsonb_build_object('node_id', v_owner));
    END IF;

    -- ---- 2. the runs themselves -------------------------------------------
    DELETE FROM runs r WHERE r.product_id = p_id AND lower(r.timerange) > v_now;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_rm_runs THEN
      PERFORM api_raise('not_permitted', 'cannot remove every run this would delete',
        jsonb_build_object('node_id', v_owner));
    END IF;

    -- ---- 3. direct assignments carrying the product -----------------------
    DELETE FROM assignments a WHERE a.product_id = p_id AND lower(a.timerange) > v_now;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_direct THEN
      PERFORM api_raise('not_permitted', 'cannot remove every assignment this would delete',
        jsonb_build_object('node_id', v_owner));
    END IF;

    -- ---- 4. whatever still carries this product has started. Remember it. --
    UPDATE runs r SET product_id = NULL, product_sku = v_code,
                      product_name = v_name, product_color_token = v_colour
      WHERE r.product_id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_kp_runs THEN
      PERFORM api_raise('not_permitted', 'cannot keep the history of every run that used this',
        jsonb_build_object('node_id', v_owner));
    END IF;

    UPDATE assignments a SET product_id = NULL, product_sku = v_code,
                             product_name = v_name, product_color_token = v_colour
      WHERE a.product_id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_extra THEN
      PERFORM api_raise('not_permitted', 'cannot keep the history of every assignment that used this',
        jsonb_build_object('node_id', v_owner));
    END IF;

    -- ---- 5. the row itself -------------------------------------------------
    DELETE FROM products WHERE id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> 1 THEN
      PERFORM api_raise('not_permitted', 'the product itself could not be deleted',
        jsonb_build_object('node_id', v_owner));
    END IF;

    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'runs', 'count', v_rm_runs),
      jsonb_build_object('what', 'assignments', 'count', v_rm_asg));
    v_keeps := jsonb_build_array(
      jsonb_build_object('what', 'runs', 'count', v_kp_runs),
      jsonb_build_object('what', 'assignments', 'count', v_kp_asg));

  ELSIF p_kind = 'operator' THEN
    SELECT count(*) INTO v_rm_asg FROM assignments a
      WHERE a.operator_id = p_id AND lower(a.timerange) > v_now;
    SELECT count(*) INTO v_kp_asg FROM assignments a
      WHERE a.operator_id = p_id AND (lower(a.timerange) <= v_now OR lower(a.timerange) IS NULL);
    SELECT count(*) INTO v_extra FROM operator_skills os WHERE os.operator_id = p_id;

    DELETE FROM assignments a WHERE a.operator_id = p_id AND lower(a.timerange) > v_now;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_rm_asg THEN
      PERFORM api_raise('not_permitted', 'cannot remove every future assignment for this person',
        jsonb_build_object('node_id', v_owner));
    END IF;

    UPDATE assignments a SET operator_id = NULL, operator_display_name = v_name
      WHERE a.operator_id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_kp_asg THEN
      PERFORM api_raise('not_permitted', 'cannot keep the history of every assignment this person worked',
        jsonb_build_object('node_id', v_owner));
    END IF;

    -- operator_skills goes with them by ON DELETE CASCADE (section 5).
    DELETE FROM operators WHERE id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> 1 THEN
      PERFORM api_raise('not_permitted', 'the person could not be deleted',
        jsonb_build_object('node_id', v_owner));
    END IF;

    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'assignments', 'count', v_rm_asg),
      jsonb_build_object('what', 'operator_skills', 'count', v_extra));
    v_keeps := jsonb_build_array(
      jsonb_build_object('what', 'assignments', 'count', v_kp_asg));

  ELSIF p_kind = 'skill' THEN
    SELECT count(*) INTO v_extra  FROM operator_skills os WHERE os.skill_id = p_id;
    SELECT count(*) INTO v_extra2 FROM node_skill_requirements q WHERE q.skill_id = p_id;

    -- Both join tables cascade (section 5); nothing here reaches them directly,
    -- which is the whole reason a Line 1 admin can complete this at all.
    DELETE FROM skills WHERE id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> 1 THEN
      PERFORM api_raise('not_permitted', 'the training could not be deleted',
        jsonb_build_object('node_id', v_owner));
    END IF;

    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'operator_skills', 'count', v_extra),
      jsonb_build_object('what', 'node_skill_requirements', 'count', v_extra2));
    v_keeps := '[]'::jsonb;

  ELSE -- shift_template
    SELECT count(*) INTO v_extra  FROM shifts s WHERE s.template_id = p_id;
    SELECT count(*) INTO v_extra2 FROM shift_breaks b
      WHERE b.shift_id IN (SELECT s.id FROM shifts s WHERE s.template_id = p_id);
    SELECT count(*) INTO v_kp_asg FROM node_shift_templates nst WHERE nst.template_id = p_id;

    DELETE FROM shift_templates WHERE id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> 1 THEN
      PERFORM api_raise('not_permitted', 'the shift pattern could not be deleted',
        jsonb_build_object('node_id', v_owner));
    END IF;

    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'shifts', 'count', v_extra),
      jsonb_build_object('what', 'shift_breaks', 'count', v_extra2),
      jsonb_build_object('what', 'node_shift_templates', 'count', v_kp_asg));
    v_keeps := '[]'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'kind', p_kind, 'id', p_id, 'name', v_name, 'code', v_code,
    'active', v_active, 'removes', v_removes, 'keeps', v_keeps, 'deleted', true);
END;
$$;

comment on function deletion_preview(text, uuid) is
  'D110: what deleting this product / person / training / shift pattern would remove and what it would keep, as {kind,id,name,code,active,removes:[{what,count}],keeps:[{what,count}]}. `what` values are TABLE NAMES, read by key. SECURITY INVOKER, so the counts are the caller''s own visible world.';
comment on function delete_owned_row(text, uuid) is
  'D110: delete an owned row, keeping the past. Anything not yet started (lower(timerange) > now()) is removed; anything that has begun keeps the row with the deleted thing''s identity copied onto it. Returns deletion_preview''s shape with `deleted` and the counts that actually happened. SECURITY INVOKER — see migration 0029''s header for the proof that no escalation is needed, and for the ROW_COUNT guard that fires if it is ever wrong.';

-- ---------------------------------------------------------------------------
-- §9. Grants. PostgreSQL grants EXECUTE on a new function to PUBLIC by
-- default (0009 §6), so both are revoked explicitly before anything is given.
-- ---------------------------------------------------------------------------
revoke execute on function deletion_preview(text, uuid) from public;
revoke execute on function delete_owned_row(text, uuid) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function deletion_preview(text, uuid) to authenticated';
    execute 'grant execute on function delete_owned_row(text, uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function deletion_preview(text, uuid) from anon';
    execute 'revoke all on function delete_owned_row(text, uuid) from anon';
  end if;
end $$;

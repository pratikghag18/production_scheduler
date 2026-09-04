-- ============================================================================
-- 0032 — D114: the training record grows a sign-off, and supervisors can keep it.
--
-- THE MAINTAINER, 31 August, in one message that settled three things:
--
--   "I want the trainings to be able to updated by a CSV file as well, will
--    that matter in this question? Nobody else except admins sees the training
--    tab, right? I think a supervisor should be able to see operators and
--    trainings now that I think about it. The supervisor will be the one who
--    enters or uploads the training information."
--
-- ----------------------------------------------------------------------------
-- ⭐⭐ THE CSV IS WHAT DECIDED THE SIGN-OFF, AND IT DECIDED IT AGAINST THE
-- ANSWER I WAS ABOUT TO RECOMMEND.
--
-- Stage 22 asks for *"who signed this person off"*. The auditable-looking answer
-- is a foreign key to `user_profiles`. **A spreadsheet cannot carry one**, and
-- worse, the person who signs a training off routinely has no login at all — an
-- external assessor, a trainer from the machine vendor, a shift lead who never
-- opens this app. A profile reference would mean either inventing accounts for
-- people who will never sign in, or being unable to record the truth.
--
-- ⚠️ SO `signed_off_by` IS FREE TEXT, AND THAT IS NOT A WEAKER ANSWER — IT IS
-- THE ANSWER TO A DIFFERENT QUESTION. "Who signed this person off" and "who
-- typed this into the system" are two facts, and one column cannot hold both:
--
--     signed_off_by   the CLAIM, as recorded. From a form or a CSV, identically.
--     the audit log    WHO entered it. `write_audit_log` already exists (0029).
--
-- Collapsing them would make a CSV upload either impossible or a lie.
--
-- ----------------------------------------------------------------------------
-- ⭐ AND HALF THE RECORD WAS ALREADY THERE, UNREAD. `operator_skills` has
-- carried `certified_at` since it was created, and `src/lib/api/operators.ts`
-- says so in as many words: *"`certified_at` is deliberately not written:
-- nothing in this app reads it."* So "trained on" needs no column at all — it
-- needs a screen. This migration adds ONE field to the record, not two.
-- Same shape as `skills.active`, which shipped in 0029 and stayed dark until
-- the Trainings tab was built. **Two columns in two weeks that existed and did
-- nothing; it is worth asking what else is down there before adding more.**
--
-- ----------------------------------------------------------------------------
-- ⭐⭐ SUPERVISORS: THE PREDICATE ALREADY EXISTS AND IS ALREADY THE RIGHT ONE.
--
-- `app_can_edit_node(n)` is *company admin, OR site admin here, OR an org-wide
-- writer holding a grant that covers here* — which is exactly "a supervisor,
-- on their own branch". §19.75 chose it for "anyone who can schedule there"
-- and noted that **it adds no new permission concept**; the same is true here.
-- Training is recorded by whoever may already act at that place.
--
-- ⚠️ THE MAINTAINER CHOSE FULL CONTROL, NOT A NARROWER "record only" (asked and
-- answered, 31 Aug): a supervisor may create, rename and retire trainings on
-- their own branch, exactly as a site admin does, and not one node further.
-- The rejected option split creating a training TYPE from recording a HOLDING;
-- it is a real distinction and it is written here because if the training list
-- ever starts filling with "Forklift" and "Fork lift", this is the line to
-- revisit.
--
-- ⚠️ AND IT WIDENS DELETE TOO, WHICH IS THE SHARP EDGE. Deleting a training
-- cascades it off everyone holding it (0029 gave `operator_skills → skills`
-- ON DELETE CASCADE deliberately, to make the operation completable at all).
-- A supervisor can now do that on their branch. `deletion_preview` already
-- counts what goes, and the dialog already refuses to enable its buttons until
-- that answer arrives — so the guard is the screen's, and it exists.
--
-- ⚠️ `app_guard_operator_skill_scope` (0028 §4) IS UNTOUCHED and still decides
-- which trainings a given person may hold. Widening who may WRITE the row does
-- not widen which rows are legal, and those are separate questions.
--
-- ----------------------------------------------------------------------------
-- ⭐ CSV IDENTITY, AND IT IS PER OWNER FOR 0031's REASON.
-- `skills` had no `external_id`, so re-uploading a spreadsheet would have
-- created duplicates rather than updated rows — stage 23's missing-premise
-- problem, one table over. It gets `source` and `external_id` mirroring
-- `products` and `operators`, and uniqueness **per owner**, matching the name
-- rule 0031 just settled: two plants each importing their own `TRN-4471` is the
-- ordinary case, not a collision.
--
-- ⚠️ THE TWO EXISTING TABLES DISAGREE WITH EACH OTHER AND ARE LEFT ALONE.
-- `operators` is `unique (org_id, external_id)` — ORG-wide, the shape 0031 just
-- moved away from — and `products` has the column with **no uniqueness rule at
-- all**, which is exactly what stage 23 records as owed. Neither is this
-- migration's business, and both are now written down rather than discovered
-- mid-import.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The sign-off.
-- ---------------------------------------------------------------------------
alter table operator_skills add column signed_off_by text;

comment on column operator_skills.signed_off_by is
  'D114: who signed this person off, as recorded — FREE TEXT, and deliberately '
  'not a user_profiles reference. The signer is often an external assessor or a '
  'trainer with no login, and a CSV row cannot carry a profile id. This is the '
  'CLAIM; who entered it is the audit log''s answer, which is a different '
  'question. NULL means nobody recorded one, never "unsigned".';

comment on column operator_skills.certified_at is
  'D114: when the training was done. The column predates this migration by '
  'months and nothing had ever read or written it — the Trainings work is what '
  'gave it a screen. Distinct from created_at, which is when the ROW was made.';

-- ⚠️ NO CHECK TYING `signed_off_by` TO `certified_at`, and that is deliberate.
-- The obvious rule — "a sign-off needs a date" — would refuse a legitimate
-- half-known record, and the half-known record is the ordinary case when a
-- spreadsheet arrives with one column filled in. 0030's `area_override` has the
-- opposite treatment (an equivalence, enforced) because there the pair IS the
-- decision; here the two facts are independent and either may be known alone.

-- ---------------------------------------------------------------------------
-- 2. CSV identity for trainings.
-- ---------------------------------------------------------------------------
alter table skills add column source      text not null default 'manual';
alter table skills add column external_id text;

-- ⚠️ A PARTIAL INDEX, not a plain unique constraint. A unique already skips
-- NULLs, so the two behave identically today — but a partial index says WHY in
-- the schema itself, and it does not index the manual rows, which will be the
-- overwhelming majority and never have an external id at all.
create unique index skills_owner_external_id_unique
  on skills (org_id, site_node_id, external_id)
  where external_id is not null;

comment on column skills.external_id is
  'D114: the id this training carries in whatever system exported it. Unique '
  'PER OWNER (skills_owner_external_id_unique), matching the name rule 0031 '
  'settled: two plants each importing their own TRN-4471 is the ordinary case. '
  'NULL for anything created by hand.';

-- ---------------------------------------------------------------------------
-- 3. Who may keep the training record.
--
-- ⭐ `app_can_edit_node` rather than a new predicate. It already reads as
-- "company admin, site admin here, or a writer with a grant covering here", and
-- reusing it means training rights and scheduling rights cannot drift apart.
--
-- ⚠️ Safe in an INSERT WITH CHECK despite `app_is_admin_for`'s D85 warning
-- about reading `nodes`: that warning is about inserting INTO `nodes`, where
-- the row does not exist yet. `assignments_insert` has used
-- `app_can_edit_node(node_id)` in its own WITH CHECK since 0009.
-- ---------------------------------------------------------------------------
create or replace function app_can_edit_operator(p_operator_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  SELECT EXISTS (
    SELECT 1 FROM operators o
    WHERE o.id = p_operator_id
      AND o.org_id = app_current_org()
      AND app_can_edit_node(o.site_node_id)
  );
$$;

comment on function app_can_edit_operator(uuid) is
  'D114: may the caller keep this person''s record? The supervisor-capable twin '
  'of app_is_admin_for_operator, differing only in calling app_can_edit_node '
  'instead of app_is_admin_for. Kept as its own function so the two are '
  'comparable side by side rather than one being a hand-inlined variant.';

revoke all on function app_can_edit_operator(uuid) from public;
grant execute on function app_can_edit_operator(uuid) to authenticated;

drop policy skills_insert on skills;
drop policy skills_update on skills;
drop policy skills_delete on skills;

create policy skills_insert on skills for insert
  with check (org_id = app_current_org() and app_can_edit_node(site_node_id));
create policy skills_update on skills for update
  using (org_id = app_current_org() and app_can_edit_node(site_node_id))
  with check (org_id = app_current_org() and app_can_edit_node(site_node_id));
create policy skills_delete on skills for delete
  using (org_id = app_current_org() and app_can_edit_node(site_node_id));

drop policy operator_skills_insert on operator_skills;
drop policy operator_skills_update on operator_skills;
drop policy operator_skills_delete on operator_skills;

create policy operator_skills_insert on operator_skills for insert
  with check (org_id = app_current_org() and app_can_edit_operator(operator_id));
create policy operator_skills_update on operator_skills for update
  using (org_id = app_current_org() and app_can_edit_operator(operator_id))
  with check (org_id = app_current_org() and app_can_edit_operator(operator_id));
create policy operator_skills_delete on operator_skills for delete
  using (org_id = app_current_org() and app_can_edit_operator(operator_id));

-- ⚠️ `skills_select` and `operator_skills_select` ARE NOT TOUCHED. Reading is
-- already scoped by `app_can_read_owned` / `app_can_read_operator` (0026), and
-- a supervisor could always READ their branch. This migration changes who may
-- WRITE, which is the only half that was missing.

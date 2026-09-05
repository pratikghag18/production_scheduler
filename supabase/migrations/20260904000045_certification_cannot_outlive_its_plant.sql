-- ===========================================================================
-- 0045 - A CERTIFICATION CANNOT OUTLIVE THE PLANT IT WAS EARNED IN (R-326).
--
-- THE DECISION. The maintainer, asked whether cross-plant certifications should
-- be possible at all: "I do not want cross-plant certifications."
--
-- WHAT WAS ALREADY TRUE, AND IT IS MOST OF THE RULE. 0028's
-- `app_guard_operator_skill_scope` refuses to CREATE a holder row whose training
-- and person sit on different branches - "That training belongs to a different
-- part of the structure than this person." So the isolation is real, it is
-- enforced, and on this database there are zero rows that break it.
--
-- ⚠️ WHAT WAS MISSING IS THE OTHER HALF OF THE SAME SENTENCE: the invariant was
-- checked when the PAIRING was made and never again when either END moved.
-- `app_guard_skill_rehome` looked only at `node_skill_requirements` - which
-- CELLS demand the training - and `app_guard_operator_rehome` only at
-- `assignments`. Neither looked at `operator_skills`, and nothing on `operators`
-- clears a certification when somebody changes plant. So the state the insert
-- guard forbids was reachable by moving either end afterwards: refused at the
-- front door and permitted through the side one.
--
-- ⭐ WHY IT WAS WORTH FIXING WHILE NOTHING IS WRONG. The stranded rows are
-- INVISIBLE, not harmful: `skills_select` is scoped by
-- `app_can_read_owned(site_node_id)`, so the receiving plant's supervisor cannot
-- read the old plant's training and the certification has no column in their
-- matrix. They sign the person off again on their own training, which is what
-- the maintainer expected the app to do and what it does. The bite is deferred:
-- move the person BACK and the old rows resurface as live certifications,
-- carrying an `expires_at` nobody has looked at in the meantime. A certificate
-- that lapsed two years ago returning as current is the failure this closes.
--
-- ⛔⛔ THE TEST IS THE INSERT GUARD'S OWN, AND `app_owner_covers_in_org` IS THE
-- WRONG ONE. This is the only subtle thing in the file. The two rehome guards
-- reach for `app_owner_covers_in_org(org, owner, node)`, which is
-- ONE-DIRECTIONAL - `o.path @> n.path`, the owner must contain the node.
-- `app_guard_operator_skill_scope` asks a DIFFERENT question: containment in
-- EITHER direction. That difference is not an oversight in 0028, it is the rule:
-- a person owned by a whole plant may legitimately hold a training owned by one
-- of that plant's lines (the person's path contains the training's), and a
-- training owned by a plant may be held by a person owned by one line (the
-- training's contains the person's). Both are ordinary. A rehome guard written
-- with the narrower test would refuse moves that leave a pairing the insert
-- guard is perfectly happy with - a screen refusing what the server allows,
-- which is the failure CLAUDE.md section 4 names.
--
-- So the predicate is EXTRACTED INTO ONE FUNCTION and called from all three
-- places, rather than written out a second and third time. A rule that appears
-- three times is a bug with a delay on it; there is now one definition of "these
-- two owners are on the same branch" and the guards agree by construction rather
-- than by everyone remembering.
--
-- ⚠️ NOT RETYPED. Every body below was extracted with `pg_get_functiondef` from
-- the live database and changed only where this migration says. The predicate in
-- s1 is `app_guard_operator_skill_scope`'s own EXISTS, lifted verbatim with its
-- parameters renamed.
--
-- ⚠️ NO BACKFILL, DELIBERATELY, AND IT IS NOT AN OVERSIGHT. 0044 had to delete
-- rows before it could add its constraint, because a constraint cannot be
-- created over rows that violate it. These are TRIGGERS: they judge writes from
-- here on and say nothing about rows already present. There are none on this
-- database (checked), and if another database has some, silently deleting
-- somebody's certification history to make a guard tidy would be the wrong
-- trade - the rows are invisible rather than dangerous, and a person should
-- decide. `68_no_cross_plant_certification_test.sql` covers the guards.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- s1. The one definition of "these two owners sit on the same branch".
--
-- Extracted from `app_guard_operator_skill_scope` (0028), which asked it inline.
-- STABLE and SECURITY DEFINER for the same reason `app_owner_covers_in_org` is:
-- it reads `nodes` on behalf of a trigger that must see rows the caller's RLS
-- would hide, and it answers a question about structure, not about permission.
--
-- ⚠️ NULL-SAFE BY BEING FAIL-CLOSED. A null owner matches no row, so EXISTS is
-- false and every caller below reads that as "stranded" and refuses. That is the
-- right way round for a guard: `operators.site_node_id` and `skills.site_node_id`
-- are NOT NULL today, and if a later migration loosens one, this refuses rather
-- than waves the write through.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_owner_overlaps_in_org(p_org uuid, p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM nodes a, nodes b
     WHERE a.id = p_a AND b.id = p_b
       AND a.org_id = p_org AND b.org_id = p_org
       AND (a.path @> b.path OR b.path @> a.path)
  );
$$;

COMMENT ON FUNCTION app_owner_overlaps_in_org(uuid, uuid, uuid) IS
  'R-326: do these two owner nodes sit on one branch, in either direction? The '
  'test 0028 applies when a certification is GRANTED, now shared with the two '
  'rehome guards so that moving either end is judged by the same rule. Not '
  'app_owner_covers_in_org, which is one-directional and would refuse pairings '
  'the grant guard permits.';

-- ---------------------------------------------------------------------------
-- s2. The grant guard, now calling the shared predicate.
--
-- Extracted from 0028; the inline EXISTS is replaced by the call and NOTHING
-- ELSE changes - same lookups, same early returns, same error code, same
-- message, same detail payload. It is here so that there is one definition of
-- the rule rather than two that agree today.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_guard_operator_skill_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
declare v_skill uuid; v_op uuid;
begin
  select s.site_node_id into v_skill from skills s
   where s.id = new.skill_id and s.org_id = new.org_id;
  if not found then return new; end if;
  select o.site_node_id into v_op from operators o
   where o.id = new.operator_id and o.org_id = new.org_id;
  if not found then return new; end if;

  if not app_owner_overlaps_in_org(new.org_id, v_skill, v_op) then
    perform api_raise('not_offered_here',
      'That training belongs to a different part of the structure than this person.',
      jsonb_build_object('kind', 'operator_skill', 'id', new.skill_id,
                         'owner_node_id', v_skill, 'node_id', v_op));
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- s3. Moving a TRAINING may not strand the people who hold it.
--
-- Extracted from 0028 with the requirements check unchanged and a second check
-- added after it. Two separate counts and two separate messages on purpose: "the
-- cells that need it are elsewhere" and "the people who hold it are elsewhere"
-- are different problems with different fixes, and one merged sentence would
-- send the reader to the wrong screen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_guard_skill_rehome() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
declare v_stranded int; v_holders int;
begin
  select count(*) into v_stranded
    from node_skill_requirements q where q.skill_id = new.id
     and not app_owner_covers_in_org(new.org_id, new.site_node_id, q.node_id);
  if v_stranded > 0 then
    perform api_raise('owner_change_blocked',
      'This training is already required outside the site you are moving it to.',
      jsonb_build_object('kind', 'skill', 'id', new.id,
                         'new_owner_node_id', new.site_node_id, 'stranded', v_stranded));
  end if;

  -- R-326. `app_owner_overlaps_in_org`, not `app_owner_covers_in_org`: a person
  -- owned by the whole plant may hold a training owned by one of its lines, and
  -- the narrower test would refuse that move for a pairing the grant guard
  -- allows.
  select count(*) into v_holders
    from operator_skills os join operators o
      on o.id = os.operator_id and o.org_id = os.org_id
   where os.skill_id = new.id and os.org_id = new.org_id
     and not app_owner_overlaps_in_org(new.org_id, new.site_node_id, o.site_node_id);
  if v_holders > 0 then
    perform api_raise('owner_change_blocked',
      'People outside the site you are moving this training to already hold it. '
      'Remove their certification first, or move it somewhere that still covers them.',
      jsonb_build_object('kind', 'skill_holders', 'id', new.id,
                         'new_owner_node_id', new.site_node_id, 'stranded', v_holders));
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- s4. Moving a PERSON may not strand the trainings they hold.
--
-- The mirror of s3, and the half the maintainer's own example lands on: somebody
-- moves from Plant A to Plant B. Their Plant A certifications used to travel
-- with them, unread by anyone, until they moved back.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_guard_operator_rehome() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
declare v_stranded int; v_held int;
begin
  select count(*) into v_stranded
    from assignments a where a.operator_id = new.id
     and not app_owner_covers_in_org(new.org_id, new.site_node_id, a.node_id);
  if v_stranded > 0 then
    perform api_raise('owner_change_blocked',
      'This person is already assigned outside the site you are moving them to.',
      jsonb_build_object('kind', 'operator', 'id', new.id,
                         'new_owner_node_id', new.site_node_id, 'stranded', v_stranded));
  end if;

  -- R-326. Same predicate as s3 and as the grant guard.
  select count(*) into v_held
    from operator_skills os join skills s
      on s.id = os.skill_id and s.org_id = os.org_id
   where os.operator_id = new.id and os.org_id = new.org_id
     and not app_owner_overlaps_in_org(new.org_id, new.site_node_id, s.site_node_id);
  if v_held > 0 then
    perform api_raise('owner_change_blocked',
      'This person holds trainings that belong to the site you are moving them out of. '
      'Remove those certifications first; the new site records its own.',
      jsonb_build_object('kind', 'operator_trainings', 'id', new.id,
                         'new_owner_node_id', new.site_node_id, 'stranded', v_held));
  end if;
  return null;
end $$;

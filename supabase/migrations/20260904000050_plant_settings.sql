-- ============================================================================
-- Migration 0050: a setting is answered for a PLACE, not only for the company.
--
-- The maintainer, session 62: "These settings I think cannot be applied plant
-- wise which defeats the purpose of both options. Lets make it possible to
-- assign settings individually for each plant."
--
-- They are right, and the shape of the hole is exact. `eligibility_policy` has
-- lived in `orgs.settings` since 0001 and been readable in exactly one place --
-- the company's bag -- so a company running one strict plant and one permissive
-- one cannot say so. The warn/block switch 0049 finally gave them is therefore
-- company-wide or nothing, which is the sense in which it "defeats the purpose
-- of both options".
--
-- Implements: R-331. Refs: D109 (ownership is a scope at ANY level), 0040
-- (the per-node configuration table this is shaped after), 0049 (the org-wide
-- writer this mirrors), F-088 (the CHECK that cannot reject a null).
--
-- ----------------------------------------------------------------------------
-- ⭐ WHAT IS DELIBERATELY NOT HERE: THE OTHER FOUR KEYS.
--
-- `orgs.settings` also holds `capacity_cap`, `week_start`,
-- `default_snap_minutes` and `date_format`. None of them moves in this
-- migration, for two reasons stated so the absence is a decision on the record
-- rather than an oversight:
--
--   * `date_format` is a READER'S DISPLAY CONVENTION, not a plant's rule. It
--     decides how a date reads on the screen of whoever is signed in; a plant
--     does not have an opinion about it and giving it one would only mean the
--     same instant printing two ways in two tabs of the same board.
--
--   * The other three are read by the functions that decide whether a write is
--     ALLOWED. Moving five keys at once multiplies the risk on exactly those
--     functions, and a subtly wrong rewrite there is silently PERMISSIVE, which
--     is the worst failure this codebase has. One key, three call sites, one
--     test file.
--
-- The STORAGE and the RESOLVER below are generic. A second key costs: one
-- branch in `node_settings_value_check`, one branch in `set_node_setting`'s
-- validator, and the one line at the reader's call site that today says
-- `COALESCE(app_resolve_node_setting(node, 'eligibility_policy'), 'warn')`.
-- No new table, no new function, no new policy.
--
-- ----------------------------------------------------------------------------
-- ⭐ THE RESOLUTION RULE, AND WHY IT IS NOT "PER PLANT".
--
-- The nearest ancestor-or-self of the node that carries an answer; failing
-- that, the company's; failing that, the reader's own coded default.
--
-- The maintainer said "plant", and a plant is what the Settings screen will
-- offer. But `nodes.path` is an ltree and this app's model is already D109's
-- "ownership is a scope at ANY level" -- `resolve_shift_template` (0006) has
-- resolved shift patterns by nearest-ancestor since the beginning, and
-- `check_eligibility` itself gathers skill requirements by walking ancestors.
-- Answering "which plant" by walking the path costs exactly the same query as
-- answering "which node", and it generalises for free: an org that later wants
-- one strict LINE inside an otherwise permissive plant has it already, and a
-- structure with a level ABOVE plant (some orgs template one) is not a special
-- case. A rule that stopped at plants would have to KNOW which level is a
-- plant, and since 0014 that is a per-template question with no single answer.
--
-- A node with no plant above it is not a special case either: ancestor-OR-SELF
-- means a root node is its own nearest ancestor. A root with an override
-- answers from it; a root without one falls to the company's; an org that has
-- never set the company's falls to 'warn', which is 0001's own default and what
-- every reader COALESCEd to before this migration. So the no-override state of
-- an existing database is byte-for-byte what it was yesterday -- this migration
-- transforms no data and needs no `upgrade_0050_*.sql` row in verify-db.sh's
-- UPGRADE_CHECKS, exactly as 0037, 0038, 0049 and 0021 each recorded.
--
-- ----------------------------------------------------------------------------
-- ⛔ WHY A TABLE AND NOT A `settings jsonb` COLUMN ON `nodes`.
--
-- Because ABSENT and DELIBERATELY SET must not be the same state, and in a
-- jsonb bag they very nearly are.
--
-- F-088 measured it on this database: `settings->>'eligibility_policy'` reads
-- back SQL NULL both when the key is missing AND when the key is present with a
-- JSON null in it, and 0001's `check (settings->>'eligibility_policy' in
-- ('warn','block'))` CANNOT REJECT THE SECOND, because `NULL IN (...)` is NULL,
-- not FALSE, and a CHECK only refuses on FALSE. So a bag can hold a key that
-- looks set, reads as nothing, and passes the guard. Repeat that per node and
-- the Settings screen can no longer say which plant is overriding -- which is
-- the one thing the screen exists to say.
--
-- A table makes the distinction STRUCTURAL instead of conventional:
--
--     the row exists   -> this place has been given an answer
--     no row           -> this place inherits
--
-- and `value text NOT NULL` closes F-088's hole at the column rather than at a
-- CHECK, because NOT NULL is the separate thing you have to write. There is no
-- third state to represent and none to get wrong. Clearing an override is a
-- DELETE, which is a fact about the row rather than a magic value inside it.
--
-- It also buys the two things a jsonb column would have made awkward: its own
-- RLS (a plant's admin may set their own plant's rule and nobody else's, which
-- `nodes_update` could not express without also handing them the node row), and
-- a key column a second setting simply joins on.
--
-- ⚠️ NO AUDIT TRIGGER, on purpose and consistently: `audit_log` covers the
-- SCHEDULING entities (assignments, runs, operators, products, skills, shift
-- templates). Configuration is not audited anywhere in this repo -- neither
-- `orgs.settings` nor `node_product_cycle_times` (0040) is -- and adding it for
-- one config table alone would be a half-rule. Recorded so the absence is a
-- decision.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1. THE TABLE.
--
-- Shaped after node_product_cycle_times (0040 §1), which is itself shaped after
-- node_skill_requirements (0002): composite PK, `org_id` carried as D7
-- redundancy, a composite tenant FK so a row can never straddle two orgs (D3),
-- and ON DELETE CASCADE for 0040's stated reason -- `delete_node` (0020)
-- deletes its children by NAME and knows nothing about a table that shipped
-- after it, so without the cascade, deleting any plant that ever had a setting
-- would fail with a foreign-key error the user cannot act on. A setting is
-- configuration ABOUT a place, not history OF one; when the place is gone the
-- setting means nothing.
-- ---------------------------------------------------------------------------
create table node_settings (
  node_id    uuid not null,
  key        text not null,
  org_id     uuid not null references orgs(id),  -- D7
  value      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (node_id, key),
  foreign key (org_id, node_id) references nodes (org_id, id) on delete cascade,

  -- ⛔ THE PAIR OF CHECKS BELOW ONLY BITE BECAUSE `key` AND `value` ARE NOT
  -- NULL (F-088). A check constraint refuses a row when it evaluates to FALSE
  -- and ACCEPTS it when it evaluates to unknown, so `value in ('warn','block')`
  -- on a nullable column would admit a null and store a setting that is set to
  -- nothing. NOT NULL is the separate guard that makes the IN test meaningful.
  constraint node_settings_key_check
    check (key in ('eligibility_policy')),

  -- Per-key values, as a CASE with `else false` so an unknown key can never
  -- slip through with an unvalidated value. A second setting is one WHEN.
  constraint node_settings_value_check
    check (case key
             when 'eligibility_policy' then value in ('warn', 'block')
             else false
           end)
);

comment on table node_settings is
  'R-331: a setting given an answer at ONE place in the structure, overriding the company''s. The row IS the override -- no row means this place inherits, which is why the value column is NOT NULL and clearing is a DELETE rather than a magic value (F-088: a jsonb bag cannot tell "absent" from "set to null", and its CHECK cannot refuse the second). Resolved by app_resolve_node_setting: nearest ancestor-or-self with an answer, else orgs.settings, else the reader''s coded default. Today the only key is eligibility_policy; the table, the resolver and the writers are generic and a second key is one branch in each of three places.';

comment on column node_settings.key is
  'Which setting. Constrained to the keys this migration knows how to validate (node_settings_key_check) -- an unvalidated key would be a value nobody checks.';

comment on column node_settings.value is
  'The override, as text, NOT NULL. Validated per key by node_settings_value_check, which mirrors the same pair 0001''s orgs.settings CHECK names for eligibility_policy.';

create index node_settings_org_key_idx on node_settings (org_id, key);

create trigger node_settings_set_updated_at
  before update on node_settings
  for each row execute function set_updated_at();

alter table node_settings enable row level security;

-- GRANTS. 0008's `GRANT ... ON ALL TABLES` was a one-shot over the tables that
-- existed then, not a standing rule -- 0014, 0034 and 0040 each spell this out,
-- and 0034's header records the exact failure: a table created later arrives
-- with RLS policies and NO table privilege behind them, so an authenticated
-- caller gets `permission denied for table ...` (42501) before a policy is ever
-- consulted. Guarded by role existence so this still runs on a scratch Postgres
-- without the Supabase roles (the SQL test harness is exactly that).
do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select, insert, update, delete on node_settings to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on node_settings from anon';
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- §2. RLS -- read follows the node down, write needs an admin grant over it.
--
-- The node_product_cycle_times pattern (0040 §3) verbatim: `app_can_read_node`
-- for SELECT, `app_is_admin() or app_is_admin_for(node_id)` for every write.
-- `app_is_admin_for` is itself org-scoped and is `app_is_admin() or
-- app_is_admin_on_path(n.path)`, so a PLANT'S OWN ADMIN may set their plant's
-- rule and no other plant's -- which is what "assign settings individually for
-- each plant" has to mean once an org has more than one site admin.
--
-- `app_is_admin_for` is safe in a WITH CHECK here for D85's reason: `node_id`
-- names a row in a DIFFERENT table (`nodes`), so this is not the
-- self-referential read that breaks INSERT ... RETURNING.
-- ---------------------------------------------------------------------------
create policy node_settings_select on node_settings for select
  using (org_id = app_current_org() and app_can_read_node(node_id));

create policy node_settings_insert on node_settings for insert
  with check (org_id = app_current_org()
              and (app_is_admin() or app_is_admin_for(node_id)));

create policy node_settings_update on node_settings for update
  using (org_id = app_current_org()
         and (app_is_admin() or app_is_admin_for(node_id)))
  with check (org_id = app_current_org()
              and (app_is_admin() or app_is_admin_for(node_id)));

create policy node_settings_delete on node_settings for delete
  using (org_id = app_current_org()
         and (app_is_admin() or app_is_admin_for(node_id)));

-- ---------------------------------------------------------------------------
-- §3. THE RESOLVER.
--
-- `resolve_shift_template` (0006) is the shape, line for line: join the target
-- to its ancestors through the ltree, keep the deepest one that has a row.
-- Two deliberate differences from it, both about safety:
--
-- ⛔ SECURITY DEFINER, WHICH `resolve_shift_template` IS NOT. This is
-- `check_eligibility`'s own lesson, written into its body in 0023 and worth
-- repeating because getting it wrong here would reintroduce the same defect in
-- a new place. `nodes` is RLS-scoped. A supervisor granted `plant_1.assembly`
-- CANNOT READ THE PLANT ROOT, so an INVOKER resolver would walk an ancestry it
-- is not allowed to see, MISS THE PLANT'S OVERRIDE, and fall through to the
-- company's default. A plant set to `block` would be silently `warn` for
-- exactly the people who schedule against it all day -- a safety rule that
-- fails OPEN for its own users. What this function may ASK must not depend on
-- what its caller may LIST. `move_run` is SECURITY INVOKER and calls it, which
-- is why the grant below is to `authenticated` and not to nobody.
--
-- ⚠️ It leaks nothing worth having: it takes a node id and returns that node's
-- own org's answer for one key -- a `warn`/`block` string. There is no
-- cross-tenant mixing, because the ancestry join is `anc.org_id =
-- target.org_id` and the org fallback reads the node's OWN org, never
-- `app_current_org()`.
--
-- ⚠️ RETURNS NULL WHEN NOBODY HAS AN ANSWER, and that is on purpose: the coded
-- default belongs to the KEY, not to the resolver. `eligibility_policy`
-- defaults to `warn` (0001, design plan §6, R-014); a future `capacity_cap`
-- would default to 1.0. A resolver that invented a default would have to know
-- them all, and would answer 'warn' for a key that has nothing to do with
-- eligibility.
-- ---------------------------------------------------------------------------
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
      WHERE target.id = p_node_id
      ORDER BY nlevel(anc.path) DESC
      LIMIT 1),
    -- 2. The company's, from the node's OWN org.
    (SELECT o.settings->>p_key
       FROM nodes n JOIN orgs o ON o.id = n.org_id
      WHERE n.id = p_node_id)
  );
$$;

comment on function app_resolve_node_setting(uuid, text) is
  'R-331: what one setting says AT one node -- the nearest ancestor-or-self carrying an override (node_settings), else the node''s own org bag (orgs.settings), else NULL so the caller applies the default that belongs to that key. SECURITY DEFINER on purpose: nodes is RLS-scoped, and an INVOKER walk would miss an override on an ancestor the caller cannot read and fall through to the company default -- a safety rule failing open for exactly the people who use it most (the same defect 0023 fixed inside check_eligibility). Shaped after resolve_shift_template (0006).';

revoke execute on function app_resolve_node_setting(uuid, text) from public;

do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_resolve_node_setting(uuid, text) to authenticated';
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- §4. THE WRITERS -- 0049's shape, one node deeper.
--
-- Two functions, not one with a nullable argument. `set_node_setting(node, key,
-- NULL)` meaning "clear" would put the ambiguity §1 spent a table to remove
-- back into the API: a screen with a broken binding would silently return a
-- plant to inheriting instead of failing, and nobody would see it until someone
-- was scheduled onto work they are not certified for. Clearing is its own verb.
--
-- SECURITY **INVOKER**, for 0021 §4's and 0049's reason: the §2 policies are
-- the real gate and these must not be able to write a row a policy would
-- refuse. The `app_is_admin_for` pre-check exists to SHAPE the refusal, not to
-- authorise anything -- if the two ever disagreed, RLS wins. It is the SAME
-- predicate the policies name, which is why the INSERT half needs no post-write
-- outcome check (0037/0049's argument, unchanged).
--
-- ⛔ THE DELETE HALF DOES NEED ONE, AND THAT IS THE ONE DIFFERENCE FROM 0049.
-- An RLS-filtered DELETE removes zero rows and raises nothing (CLAUDE.md §4:
-- "a write that reports success can have changed nothing"). Zero rows is also
-- the perfectly legitimate outcome of clearing a plant that had no override, so
-- ROW_COUNT alone cannot tell a refusal from a no-op. The honest test is the
-- END STATE: read the row back and refuse if one survived.
--
-- ⚠️ WHY THESE VALIDATE VALUES THE TABLE ALREADY CHECKS -- 0049's argument
-- verbatim. `node_settings_value_check` would refuse a junk value too, but as
-- SQLSTATE 23514 naming a constraint, carrying no `field`, and saying the same
-- unreadable thing about every key. The explicit test below is what makes the
-- refusal a typed `invalid_argument`/PT400 naming the KEY, which is what
-- `toSchedulerError` turns into a sentence on the Settings screen.
-- ---------------------------------------------------------------------------
create or replace function set_node_setting(p_node_id uuid, p_key text, p_value text)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
DECLARE
  v_org_id uuid;
  v_stored text;
BEGIN
  -- The node first: "there is no such place" is not a permission answer, and
  -- app_node_exists_in_org is org-scoped so this leaks nothing outward.
  IF p_node_id IS NULL OR NOT app_node_exists_in_org(p_node_id) THEN
    PERFORM api_raise('invalid_argument', 'no such place in this company',
                      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  END IF;

  -- Permission next, and before the value is looked at: someone who may not
  -- change this plant learns nothing about which values are legal.
  IF NOT (app_is_admin() OR app_is_admin_for(p_node_id)) THEN
    PERFORM api_raise('not_permitted', 'only an admin of this place may change its settings',
                      jsonb_build_object('reason', 'not_admin', 'node_id', p_node_id));
  END IF;

  IF p_key IS NULL OR p_key NOT IN ('eligibility_policy') THEN
    PERFORM api_raise('invalid_argument', 'unknown setting',
                      jsonb_build_object('field', 'key', 'value', p_key));
  END IF;

  -- `field` is the KEY, so the client can point at the control the person
  -- actually touched -- the same thing 0049 does with 'eligibility_policy'.
  IF p_value IS NULL OR NOT (CASE p_key
                               WHEN 'eligibility_policy' THEN p_value IN ('warn', 'block')
                               ELSE false
                             END) THEN
    PERFORM api_raise('invalid_argument', 'unknown value for this setting',
                      jsonb_build_object('field', p_key, 'value', p_value));
  END IF;

  SELECT org_id INTO v_org_id FROM nodes WHERE id = p_node_id;

  INSERT INTO node_settings (node_id, key, org_id, value)
  VALUES (p_node_id, p_key, v_org_id, p_value)
  ON CONFLICT (node_id, key) DO UPDATE SET value = excluded.value;

  SELECT ns.value INTO v_stored
    FROM node_settings ns WHERE ns.node_id = p_node_id AND ns.key = p_key;

  RETURN jsonb_build_object(
    'node_id',     p_node_id,
    'key',         p_key,
    'value',       v_stored,
    'is_override', v_stored IS NOT NULL,
    'effective',   app_resolve_node_setting(p_node_id, p_key),
    'org_value',   (SELECT o.settings->>p_key FROM orgs o WHERE o.id = v_org_id)
  );
END $$;

comment on function set_node_setting(uuid, text, text) is
  'R-331: give ONE place its own answer for ONE setting, overriding whatever it inherits. Admin-gated by app_is_admin_for -- the plant''s own admin, not only the company''s -- and refuses with not_permitted rather than being the silent zero-row write a plain UPSERT would be under node_settings'' policies. Validates the key and the value itself so the refusal is invalid_argument/PT400 naming the key, not the table CHECK''s unreadable 23514. Returns the stored row beside the resolved effective value and the company''s, so the screen can say "this plant is set to X" rather than guessing. Clearing is clear_node_setting, deliberately a different verb.';

create or replace function clear_node_setting(p_node_id uuid, p_key text)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
DECLARE
  v_org_id uuid;
  v_left text;
BEGIN
  IF p_node_id IS NULL OR NOT app_node_exists_in_org(p_node_id) THEN
    PERFORM api_raise('invalid_argument', 'no such place in this company',
                      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  END IF;

  IF NOT (app_is_admin() OR app_is_admin_for(p_node_id)) THEN
    PERFORM api_raise('not_permitted', 'only an admin of this place may change its settings',
                      jsonb_build_object('reason', 'not_admin', 'node_id', p_node_id));
  END IF;

  IF p_key IS NULL OR p_key NOT IN ('eligibility_policy') THEN
    PERFORM api_raise('invalid_argument', 'unknown setting',
                      jsonb_build_object('field', 'key', 'value', p_key));
  END IF;

  SELECT org_id INTO v_org_id FROM nodes WHERE id = p_node_id;

  DELETE FROM node_settings WHERE node_id = p_node_id AND key = p_key;

  -- ⛔ ROW_COUNT WOULD BE A LIE HERE. Zero rows deleted is BOTH "RLS filtered
  -- me out" and "there was nothing to clear", and only one of those is fine.
  -- The end state tells them apart: if a row survived, the delete was refused
  -- and the caller must hear about it rather than watch the screen revert.
  SELECT ns.value INTO v_left
    FROM node_settings ns WHERE ns.node_id = p_node_id AND ns.key = p_key;
  IF v_left IS NOT NULL THEN
    PERFORM api_raise('not_permitted', 'the override could not be removed',
                      jsonb_build_object('reason', 'write_filtered', 'node_id', p_node_id));
  END IF;

  RETURN jsonb_build_object(
    'node_id',     p_node_id,
    'key',         p_key,
    'value',       NULL,
    'is_override', false,
    'effective',   app_resolve_node_setting(p_node_id, p_key),
    'org_value',   (SELECT o.settings->>p_key FROM orgs o WHERE o.id = v_org_id)
  );
END $$;

comment on function clear_node_setting(uuid, text) is
  'R-331: return ONE place to inheriting for ONE setting, by deleting its override row. A separate verb from set_node_setting on purpose -- "set to null" would put back the ambiguity between absent and deliberately set that the node_settings table exists to remove (F-088). Reads the row back after the DELETE because an RLS-filtered DELETE removes zero rows and raises nothing, and zero rows is also the honest outcome of clearing a place that had no override; the surviving row, not ROW_COUNT, is what tells a refusal from a no-op. Returns the value the place now inherits.';

revoke execute on function set_node_setting(uuid, text, text) from public;
revoke execute on function clear_node_setting(uuid, text) from public;

do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function set_node_setting(uuid, text, text) to authenticated';
    execute 'grant execute on function clear_node_setting(uuid, text) to authenticated';
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- §5. THE TWO READERS THAT DECIDE WHETHER A WRITE IS ALLOWED.
--
-- ⭐ ONLY THREE LIVE FUNCTIONS NAME `eligibility_policy` (measured against
-- pg_proc.prosrc, not remembered): `check_eligibility`, `move_run` and 0049's
-- writer `set_org_eligibility_policy`. The writer is about the COMPANY's value
-- and is correct as it stands. The other two are rewritten below.
--
-- ⭐ AND THE OTHER TWO CALLERS NEED NOTHING, WHICH WAS CHECKED RATHER THAN
-- ASSUMED. `create_assignment` never reads the bag: it calls
-- `check_eligibility` and branches on `v_elig->>'policy'`, the value that
-- function resolved -- so it follows the plant's rule the moment
-- `check_eligibility` does. `apply_split_coverage` does not consult eligibility
-- AT ALL (its only mention of the word is copying `eligibility_override` off
-- the caller's payload into the new row), so there is nothing in it to make
-- per-plant; that is a separate gap and not this migration's.
--
-- ⚠️ BOTH BODIES BELOW WERE EXTRACTED WITH `pg_get_functiondef` FROM THE LIVE
-- DATABASE AND HAVE EXACTLY ONE STATEMENT CHANGED EACH (CLAUDE.md §4, "extract,
-- never retype"). The statement that goes is the same in both:
--
--     SELECT COALESCE(o.settings->>'eligibility_policy', 'warn') INTO v_policy
--       FROM orgs o WHERE o.id = v_org_id;
--
-- and what replaces it resolves the identical value when no override exists
-- anywhere, because `app_resolve_node_setting` falls through to that same bag.
-- `v_org_id` is left assigned-but-now-unused in both, deliberately: shrinking
-- the diff to one statement is what makes this reviewable.
--
-- Same signatures, so these CREATE OR REPLACEs keep every existing grant and
-- the generated TypeScript for both RPCs is unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_eligibility(p_node_id uuid, p_operator_id uuid, p_timerange tstzrange)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org_id uuid;
  v_policy text;
  v_result jsonb;
BEGIN
  -- ⭐⭐ THE GATE THIS FUNCTION NEVER HAD, AND IT IS WHY 0023 COULD NOT NARROW
  -- THE READS. Until now this was SECURITY INVOKER and read `skills`,
  -- `operator_skills` AND `nodes` AS THE CALLER, so its answer depended on what
  -- the caller could LIST rather than on what is true. Two consequences, one of
  -- them live before this migration:
  --
  --   (a) 0023's stated hazard: narrow `skills`/`operator_skills` and a skill
  --       the caller cannot see drops out of `held`, lands in `missing`, flips
  --       `eligible` to false, and `create_assignment` refuses -- silently.
  --
  --   (b) ⚠️ THE ONE THAT WAS ALREADY BROKEN AND NOBODY HAD LOOKED: `required`
  --       walks ANCESTORS through `nodes`, which 0020 already scoped. A
  --       supervisor granted Assembly cannot read the Plant 1 root, so a skill
  --       requirement placed on the root DROPPED OUT OF THEIR ANSWER. Measured
  --       on a seeded database, same cell, same operator, same instant: the
  --       company admin got `eligible=false, missing=[CNC]` and Ana the
  --       supervisor got `eligible=true, missing=[]`. A SAFETY CHECK THAT
  --       FAILS OPEN FOR EXACTLY THE PEOPLE WHO USE IT MOST.
  --
  -- So the fix is not "keep the tables readable". It is that what this function
  -- may ASK about must stop depending on what its caller may LIST. DEFINER, and
  -- one explicit gate: you must be able to see the NODE you are asking about.
  -- `app_can_read_node` is the same predicate `runs_select` uses, so this
  -- refuses exactly when reading the run would have refused.
  IF NOT app_can_read_node(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'you cannot see that place',
      jsonb_build_object('field', 'p_node_id', 'reason', 'node not readable'));
  END IF;

  SELECT org_id INTO v_org_id FROM nodes WHERE id = p_node_id;
  -- ⭐ R-331 / migration 0050: THE POLICY IS RESOLVED FOR THIS NODE, not read
  -- once from the company bag. `app_resolve_node_setting` walks the node's own
  -- ltree ancestry, nearest ancestor-or-self first, and falls back to
  -- `orgs.settings->>'eligibility_policy'`; the coded default of 'warn' stays
  -- HERE, at the call site, because it belongs to this key and not to the
  -- resolver. With no override anywhere this is byte-for-byte the old answer.
  v_policy := COALESCE(app_resolve_node_setting(p_node_id, 'eligibility_policy'), 'warn');

  WITH required AS (
    SELECT DISTINCT nsr.skill_id
    FROM nodes target
    JOIN nodes anc ON target.path <@ anc.path AND anc.org_id = target.org_id
    JOIN node_skill_requirements nsr ON nsr.node_id = anc.id
    WHERE target.id = p_node_id
  ),
  held AS (
    SELECT os.skill_id, os.expires_at
    FROM operator_skills os
    WHERE os.operator_id = p_operator_id
  ),
  missing AS (
    SELECT r.skill_id FROM required r
    WHERE NOT EXISTS (SELECT 1 FROM held h WHERE h.skill_id = r.skill_id)
  ),
  expiring AS (
    -- An unbounded upper bound on the window counts as expiring for any
    -- non-null expires_at (brief §4): there is no finite date to compare
    -- against, so any real expiry falls "inside" an open-ended window.
    SELECT r.skill_id, h.expires_at
    FROM required r
    JOIN held h ON h.skill_id = r.skill_id
    WHERE h.expires_at IS NOT NULL
      AND (upper_inf(p_timerange) OR h.expires_at < upper(p_timerange)::date)
  )
  SELECT jsonb_build_object(
    'eligible', (SELECT count(*) FROM missing) = 0 AND (SELECT count(*) FROM expiring) = 0,
    'policy', v_policy,
    'missing_skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name))
      FROM missing m JOIN skills s ON s.id = m.skill_id
    ), '[]'::jsonb),
    'expiring_skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'expires_at', e.expires_at))
      FROM expiring e JOIN skills s ON s.id = e.skill_id
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$

;

comment on function check_eligibility(uuid, uuid, tstzrange) is
  'Unchanged from 0023 apart from one statement: `policy` is now resolved FOR THE NODE being asked about (app_resolve_node_setting -- nearest ancestor-or-self with an override, else the company bag, else warn) instead of read once from orgs.settings. R-331. With no override anywhere the answer is identical to 0023''s.';

CREATE OR REPLACE FUNCTION public.move_run(p_run_id uuid, p_node_id uuid, p_timerange tstzrange, p_area_override boolean DEFAULT false, p_area_override_reason text DEFAULT NULL::text)
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
  WHERE node_id = p_node_id AND id <> p_run_id AND timerange && p_timerange
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
       WHERE a.run_id = p_run_id
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

  -- ⭐ R-331 / migration 0050: THE POLICY IS RESOLVED FOR THIS NODE, not read
  -- once from the company bag. `app_resolve_node_setting` walks the node's own
  -- ltree ancestry, nearest ancestor-or-self first, and falls back to
  -- `orgs.settings->>'eligibility_policy'`; the coded default of 'warn' stays
  -- HERE, at the call site, because it belongs to this key and not to the
  -- resolver. With no override anywhere this is byte-for-byte the old answer.
  v_policy := COALESCE(app_resolve_node_setting(p_node_id, 'eligibility_policy'), 'warn');

  -- Under block: pre-check every crew member against the target node BEFORE
  -- writing anything, so a violation aborts the whole move with nothing
  -- changed (brief §5: "aborts the whole move ... listing every affected
  -- operator").
  IF v_policy = 'block' THEN
    FOR rec IN
      SELECT a.operator_id, a.timerange FROM assignments a
      WHERE a.run_id = p_run_id
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
    SELECT * FROM assignments WHERE run_id = p_run_id
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
$function$

;

comment on function move_run(uuid, uuid, tstzrange, boolean, text) is
  'Unchanged from 0030/D113 apart from one statement: the block/warn decision is resolved for the TARGET node (app_resolve_node_setting) instead of read once from orgs.settings, so moving a crew INTO a strict plant is refused while the same move inside a permissive one is allowed with warnings. R-331.';

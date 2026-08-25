-- ============================================================================
-- 0015 — create_node learns which hierarchy shape (D87 / brief P1-5f §5).
--
-- THE DEFECT, MEASURED (brief §4): migration 0014 (D86) moved level identity
-- from `(org_id, position)` to `(template_id, position)` everywhere except
-- here. `create_node` still resolved a level by `(org_id, position)` in both
-- branches. A CHILD's answer was determined even before this migration --
-- scope the lookup to the parent's own template -- but a ROOT create had no
-- parameter to name a shape at all, so with two templates in one org
-- `select ... into v_level_id from hierarchy_levels where org_id = v_org_id
-- and position = 0` picked an ARBITRARY row (`SELECT ... INTO` over a
-- multi-row result takes one row, tracking physical heap order -- not a
-- race, not stable, and flips after an ordinary re-save of the other
-- shape's level list; see design plan §19.19/§19.20 and the brief's §4.3).
-- The write succeeds silently, in an unpredictable shape, with no error --
-- `nodes_check_level_adjacency` cannot catch it because parent NULL / position
-- 0 satisfies the trigger for ANY template. There is no corruption risk (one
-- shape per org, which is every org today, behaves identically before and
-- after this migration) but a correct request -- "create a root in shape B"
-- -- could not be expressed through the API at all.
--
-- THE LIVE BODY IS IN MIGRATION 0011, NOT 0010 (brief §4.1). 0010 created
-- create_node; 0011 re-created it (`create or replace`) to route p_name
-- through `app_trim_ws` for the D80 whitespace-parity fix, and 0014 never
-- touches it. The body below was extracted programmatically from 0011 --
-- from `create or replace function create_node(` through the closing `$$;`,
-- 73 lines, md5 `a94c96336a0c942fc7624908410b1119` (trailing newline
-- stripped) -- and edited by STRING REPLACEMENT, not retyped from memory
-- (a 129-line function reconstructed from memory during D86 silently lost
-- six subqueries and its STABLE marker; verification standard rule 12). The
-- extraction was diffed against this migration's final body; every line
-- outside the four hunks below (the signature, the declare block, the root
-- branch, and the child branch's SELECT + new guard) is byte-identical to
-- 0011's create_node, including app_trim_ws, the blank-name raise, the
-- path-collision check, the D2 coalesce(p_sort_order, 0), and the returned
-- jsonb shape.
--
-- WHY p_template_id HAS A DEFAULT HERE AND save_hierarchy_levels's DOES NOT
-- (brief §5.2 -- this looks inconsistent and is not; recorded here so the
-- next reader does not "fix" one of them to match the other):
--   - save_hierarchy_levels EDITS an existing list. "The org's only
--     template" would be a GUESS about which list the admin meant, and
--     guessing which shape was exactly the failure D86 removed. No default.
--   - create_node AT THE ROOT creates something new. When the org holds
--     exactly one template, that template is not a guess -- it is the only
--     possible answer, and every existing caller (which passes three
--     arguments) stays correct with no client change. When it holds zero or
--     more than one, the function refuses rather than picking -- same
--     reasoning LevelEditor already applies client-side.
--
-- NO NEW ERROR CODES (brief §5.4). The closed set stays at twelve.
-- `invalid_argument` and `level_mismatch` carry every new failure,
-- distinguished by their DETAIL payload -- the same call D86 made for the
-- three template RPCs in 0014.
--
-- DROP, NEVER OVERLOAD (brief §5.1). Two `create_node` signatures visible
-- through PostgREST would be exactly the ambiguity D86 removed for
-- save_hierarchy_levels, and an un-updated client would keep silently
-- calling the 3-arg one. `drop function create_node(uuid,text,int)` also
-- drops that function's grants (Postgres does not carry EXECUTE privileges
-- across a drop/create of a differently-signed function) -- migration 0010's
-- REVOKE-from-PUBLIC / guarded-GRANT-to-authenticated idiom is reapplied
-- below for the new 4-arg signature, in 0010's own idiom, so the function
-- does not arrive back at the PUBLIC-execute default. T30 exists to catch
-- a missed grant block; T31 exists to catch an overload instead of a drop.
-- ============================================================================

drop function create_node(uuid, text, int);

create function create_node(p_parent_id uuid, p_name text, p_sort_order int default 0,
                            p_template_id uuid default null)
returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id               uuid;
  v_name                 text;
  v_parent_path          ltree;
  v_parent_position      int;
  v_parent_template_id   uuid;
  v_level_id             uuid;
  v_prospective_path     ltree;
  v_existing_node_id     uuid;
  v_node                 nodes%rowtype;
  v_resolved_template_id uuid;
  v_template_count       int;
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;

  v_org_id := app_current_org();
  v_name := app_trim_ws(p_name);
  if v_name = '' then
    perform api_raise('invalid_argument', 'name must not be blank',
      jsonb_build_object('field', 'p_name', 'reason', 'blank name'));
  end if;

  if p_parent_id is null then
    -- Root branch (D87 §5.3): resolve WHICH TEMPLATE this root belongs to
    -- before touching hierarchy_levels at all.
    if p_template_id is null then
      -- Two queries, not one: `min`/`max` have no aggregate defined for
      -- `uuid` (measured -- `min(uuid)` raises `42883, function min(uuid)
      -- does not exist`), so the count and the single surviving row's id
      -- cannot be fetched in the same `select ... into` the way an integer
      -- or text key could be.
      -- Count and pick in ONE statement, deliberately (design session, Aug 25).
      -- Two separate queries meant two org scopes to keep in sync, and deleting
      -- the scope from the PICK alone was caught by NOTHING in either suite: it
      -- makes `select ... into` arbitrary across every org's templates, which is
      -- the same unordered-single-row hazard D87 is about, one line over.
      -- NOT min(id): PostgreSQL has no min/max aggregate for uuid (42883). uuid
      -- HAS a btree ordering, so `order by` inside array_agg works and is also
      -- deterministic where a bare `select id into` was not.
      select count(*), (array_agg(id order by id))[1]
        into v_template_count, v_resolved_template_id
        from hierarchy_templates where org_id = v_org_id;
      if v_template_count <> 1 then
        perform api_raise('invalid_argument',
          'p_template_id is required: pass the id of the hierarchy template this root belongs to',
          jsonb_build_object('field', 'p_template_id',
            'reason', case when v_template_count = 0 then 'no templates' else 'ambiguous' end,
            'template_count', v_template_count));
      end if;
    else
      -- The `and org_id = v_org_id` is load-bearing and is NOT made
      -- redundant by RLS -- see brief §8.1's T22, which runs as the table
      -- owner (RLS bypassed) for exactly this reason.
      select id into v_resolved_template_id from hierarchy_templates
        where id = p_template_id and org_id = v_org_id;
      if v_resolved_template_id is null then
        perform api_raise('invalid_argument', 'hierarchy template not found',
          jsonb_build_object('field', 'p_template_id', 'reason', 'not found'));
      end if;
    end if;

    select id into v_level_id from hierarchy_levels
      where template_id = v_resolved_template_id and position = 0;
    if v_level_id is null then
      -- Ordinary, not exotic: create_hierarchy_template deliberately creates
      -- an EMPTY template (0014's own comment). Without this guard the
      -- insert below reaches nodes_check_level_adjacency with a NULL
      -- level_id and is refused with "node ... has no parent but its level
      -- is not position 0" -- a true statement about a level that does not
      -- exist, and a baffling thing for an admin to read.
      perform api_raise('level_mismatch', 'this hierarchy template has no levels yet',
        jsonb_build_object('template_id', v_resolved_template_id));
    end if;
    v_prospective_path := slugify(v_name)::ltree;
  else
    select path into v_parent_path from nodes where id = p_parent_id and org_id = v_org_id;
    if v_parent_path is null then
      perform api_raise('invalid_argument', 'parent node not found',
        jsonb_build_object('field', 'p_parent_id', 'reason', 'not found'));
    end if;

    -- Child branch (D87 §5.3): the parent's TEMPLATE is fixed by the parent,
    -- so its position and its template_id are read together, in the same
    -- single query 0011 already ran here.
    select hl.position, hl.template_id into v_parent_position, v_parent_template_id
      from nodes n join hierarchy_levels hl on hl.id = n.level_id
      where n.id = p_parent_id;

    if p_template_id is not null and p_template_id is distinct from v_parent_template_id then
      -- A child's shape is fixed by its parent, so p_template_id is not a
      -- choice here; accepting a contradicting one silently would let a
      -- caller believe it had chosen.
      perform api_raise('invalid_argument', 'p_template_id does not match the parent''s hierarchy template',
        jsonb_build_object('field', 'p_template_id', 'reason', 'not the parent''s template',
          'parent_template_id', v_parent_template_id));
    end if;

    select id into v_level_id
      from hierarchy_levels where template_id = v_parent_template_id and position = v_parent_position + 1;
    if v_level_id is null then
      perform api_raise('level_mismatch', 'no hierarchy level exists one position below the parent',
        jsonb_build_object('node_id', p_parent_id));
    end if;

    v_prospective_path := v_parent_path || slugify(v_name)::ltree;
  end if;

  select id into v_existing_node_id
    from nodes where org_id = v_org_id and path = v_prospective_path;
  if v_existing_node_id is not null then
    perform api_raise('path_collision', 'a node with this path already exists',
      jsonb_build_object('path', v_prospective_path::text, 'existing_node_id', v_existing_node_id));
  end if;

  -- D2 (found in design-session verification, Aug 25): an explicit NULL for
  -- p_sort_order bypasses the function signature's own `DEFAULT 0` (that
  -- default only applies when the argument is omitted entirely, not when a
  -- caller passes NULL outright), and an uncoalesced NULL insert raised a
  -- raw 23502 outside the closed error set. move_node already guards this
  -- correctly (coalesce(p_sort_order, sort_order)); create_node did not.
  insert into nodes (org_id, level_id, parent_id, name, sort_order)
    values (v_org_id, v_level_id, p_parent_id, v_name, coalesce(p_sort_order, 0))
    returning * into v_node;

  return jsonb_build_object(
    'id', v_node.id, 'name', v_node.name, 'path', v_node.path::text,
    'parent_id', v_node.parent_id, 'level_id', v_node.level_id,
    'sort_order', v_node.sort_order, 'active', v_node.active);
end;
$$;

-- ----------------------------------------------------------------------------
-- Grants (brief §5.5). Dropping create_node(uuid,text,int) drops its grants
-- with it; the new 4-arg function otherwise arrives at Postgres's PUBLIC
-- EXECUTE default. Same guarded idiom as migration 0010's own grant block
-- (guarded on pg_roles, so this file still applies on a scratch Postgres
-- that lacks the Supabase roles).
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION create_node(uuid,text,int,uuid) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION create_node(uuid,text,int,uuid) TO authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION create_node(uuid,text,int,uuid) FROM anon';
  END IF;
END $$;

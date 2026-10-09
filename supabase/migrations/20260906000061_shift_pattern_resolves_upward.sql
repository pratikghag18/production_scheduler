-- ============================================================================
-- 0061 --- THE SHIFT PATTERN RESOLVES UPWARD PAST A GRANT (DEF-0016, R-039).
--
-- THE DEFECT. A line supervisor granted only Line 1 of Plant A opened her
-- board and it had no shift pattern at all: no hatched break band, no dashed
-- shift boundary, no shift chips in the create form, and the create time
-- defaulting to 00:00-04:00 instead of snapping to a shift edge. Plant A's
-- template is attached at `plant_a` (the only node_shift_templates row under
-- Plant A); Line 1, Cell 1 and Cell 2 sit under it and inherit it. Measured
-- live at aca40d5:
--
--   as Ana  resolve_shift_template(line_1) -> NULL      board_window node_shift_map array(0)
--   as Dana resolve_shift_template(line_1) -> ac127431  board_window node_shift_map array(12)
--
-- THE RULE. R-039 / R-D101: a shift template attaches to any node and inherits
-- downward; the nearest ancestor with a template wins. Which pattern a node
-- RUNS is a question about the tree, not about what the caller may LIST. The
-- board of the person who schedules the line must draw the same breaks and
-- boundaries and offer the same chips as the plant admin's.
--
-- WHY DEFINER. `resolve_shift_template` (0005, last CREATE; 0023 only re-granted
-- it) was SECURITY INVOKER. It walks the ancestors with `target.path <@
-- anc.path` and joins `node_shift_templates`. Under Ana's session both the
-- ancestor node `plant_a` (nodes_select is `path <@ grant` --- descendants only)
-- and the attachment row on it (node_shift_templates_select is
-- app_can_read_node) are filtered away, so the walk finds nothing and the
-- resolver answers NULL for a node that does have a pattern. This is the same
-- "owned above the grant" hole that 0050 fixed for settings by making
-- app_resolve_node_setting SECURITY DEFINER, and that 0058 fixed for people
-- with app_operator_homes. 0023's own note foresaw this edit: it revoked the
-- function from public and granted it to authenticated precisely because "a
-- future change making it DEFINER would turn a harmless hole into a real one in
-- a single edit". The board_window map (0058) builds shift_templates and
-- node_shift_map straight off resolve_shift_template, so both keys follow once
-- the map does; the template's own row is already readable by her.
--
-- THE BOUNDARY. A DEFINER function that takes a node id and walks with RLS out
-- of the way MUST answer NULL for a node outside the caller's company and for a
-- node that does not exist --- the rule 0056 restated for DEF-0013 and 0020 s8.0
-- states for every definer helper: another company's node, and a uuid that
-- exists nowhere, get the same answer, nothing. So the org term goes on the
-- target scan, first, exactly as 0056 put 0020's org term verbatim on
-- app_node_is_plant_root's scan (the equivalent of app_node_exists_in_org(node)
-- inlined onto the row already being read). The ancestry join keeps its own
-- `anc.org_id = target.org_id`, so no cross-tenant node can enter the walk.
--
-- ⚠️ WHY THE ORG TERM IS GUARDED WITH `app_current_org() IS NULL OR ...`.
-- `app_current_org()` is NULL in OWNER CONTEXT (the superuser psql session, the
-- seed, a trusted backfill), and two committed cases call this resolver there
-- and expect a real answer: 30_shifts_test Case 18a-c and 56_delete D24 both
-- run resolve_shift_template AFTER `RESET ROLE`, as the owner, to prove
-- nearest-ancestor resolution and post-delete fallback. Those cases are RIGHT
-- --- owner-context resolution must keep working --- so the boundary applies
-- only when there IS a tenant to bound to. Every real caller reaches this over
-- PostgREST with a jwt, where app_current_org() is that caller's org and the
-- term fires; the NULL branch is the trusted, un-tenanted path and nothing
-- else. app_resolve_node_setting (0050) sidesteps this by never reading
-- app_current_org() at all, but it also carries no boundary --- this defect
-- asks for one, so the term is here and the NULL exemption is what keeps the
-- owner-context callers green.
--
-- ⚠️ Re-emitted WHOLE from 0005 by extraction (its clauses asserted present and
-- unique on the assembled text before writing). Two edits only: the header
-- gains `security definer set search_path = public, pg_temp`, and the WHERE
-- gains the org term as its first predicate. Signature unchanged
-- (resolve_shift_template(uuid) -> uuid), so board_window (0058) and every
-- other caller (SELECT ... resolve_shift_template(sn.id) in the board payload,
-- 0009/0014/0023/0025/0034/0040/0042/0048/0050/0051/0058) need no change; every
-- caller passes a node id and nothing else.
-- ============================================================================

create or replace function resolve_shift_template(p_node_id uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT nst.template_id
  FROM nodes target
  JOIN nodes anc ON target.path <@ anc.path AND anc.org_id = target.org_id
  JOIN node_shift_templates nst ON nst.node_id = anc.id
  WHERE (app_current_org() IS NULL OR target.org_id = app_current_org())
    AND target.id = p_node_id
  ORDER BY nlevel(anc.path) DESC
  LIMIT 1;
$$;

comment on function resolve_shift_template(uuid) is
  'R-039: which shift template a node RUNS --- the nearest ancestor-or-self carrying an attachment wins, along target.path <@ anc.path within the node''s own org, else NULL. SECURITY DEFINER since 0061 (DEF-0016): nodes and node_shift_templates are RLS-scoped, so an INVOKER walk misses a template attached on an ancestor the caller cannot read and answers NULL for a line that inherits the plant''s pattern --- the board of the supervisor who schedules the line loses its break band, shift boundaries and shift chips. Org-bounded: a node in another company, or a uuid that exists nowhere, resolves to NULL for a tenant caller (0020 s8.0, DEF-0013/0056), while owner context (app_current_org() NULL: the seed, superuser tests) resolves unbounded. Shape is 0050''s app_resolve_node_setting, which is DEFINER for the same reason.';

-- Grants, as 0050's helper: revoked from public, granted to authenticated (the
-- board payload runs it per node under the caller's session), never anon. 0023
-- already set exactly this; re-stated here so a reader of the last definition
-- sees the whole contract in one place and a later re-emission cannot drop it.
revoke execute on function resolve_shift_template(uuid) from public;

do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function resolve_shift_template(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function resolve_shift_template(uuid) from anon';
  end if;
end $do$;

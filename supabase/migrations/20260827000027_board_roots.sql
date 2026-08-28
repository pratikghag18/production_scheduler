-- ============================================================================
-- 0027 — WHERE THE BOARD OPENS: the top of what YOU can see
--
-- The board has always asked the server for one hardcoded path:
--
--   src/features/board/hooks/useRootPath.ts:14   const ORG_ROOT_PATH = "plant_1";
--
-- Every user, every session. Its own comment admits it -- "it is not derived
-- from the session/profile in any way yet" -- and it was fine for exactly as
-- long as there was one plant. 0026 made the consequence visible rather than
-- dangerous: the Plant 2 admin's board now asks for Plant 1 and the server
-- correctly hands back almost nothing, so she gets an EMPTY board instead of
-- SOMEBODY ELSE'S. This function is what lets the client stop asking the wrong
-- question.
--
-- ⭐⭐ AND THE OBVIOUS IMPLEMENTATION IS WRONG. "The roots you can see" --
-- `parent_id IS NULL` -- is the answer for a company admin and for a site
-- admin, and it is NOTHING AT ALL for a supervisor, because a grant sits on a
-- DEPARTMENT and `nodes_select` gives them that department and below, never
-- the root above it. Measured on a seeded database before this was written:
--
--   parent_id IS NULL          Ana (supervisor on Assembly) -> (nothing)
--   no VISIBLE parent          Ana -> Assembly
--                              Marco (supervisor on Machining) -> Machining
--                              Quinn (site admin, Plant 2)     -> Plant 2
--                              company admin                   -> Plant 1, Plant 2
--
-- **Ana's board is not broken today only because the constant happens to name
-- an ancestor of hers.** Replacing that constant with "your roots" would have
-- shipped a brand-new empty-board defect inside the fix for the old one.
--
-- So the question is not "which sites are you an admin of" and not "which
-- nodes are roots". It is: **which nodes can you see whose PARENT you cannot?**
-- That is the top of your visible forest, and it is the same answer for all
-- four shapes of person without special-casing any of them.
--
-- ⚠️ SECURITY INVOKER, AND DELIBERATELY SO -- THE OPPOSITE CHOICE FROM 0026.
-- Every helper 0026 added is DEFINER because the caller's own visibility was
-- the WRONG input to those questions. Here the caller's visibility IS the
-- question. The `NOT EXISTS` runs under `nodes_select` as the caller, so
-- "a parent I cannot see" is evaluated against exactly what the caller may
-- read, and this function can never return a node they could not already
-- SELECT for themselves. Making it DEFINER would silently turn it into "the
-- real roots of the org", which is a leak and is what case V5 pins.
-- ============================================================================

create or replace function visible_board_roots()
returns table (id uuid, name text, path text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  SELECT n.id, n.name, n.path::text
    FROM nodes n
   WHERE n.org_id = app_current_org()
     AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id = n.parent_id)
   -- ⚠️ ACTIVE FIRST, then path. Deactivated nodes are NOT excluded: a person
   -- whose only site has been deactivated would otherwise get an empty list
   -- and a board that cannot explain itself, which is a worse answer than an
   -- inactive plant they can still open. Ordering keeps an active one first,
   -- so the client's "default to the first" never lands on a dead site while a
   -- live one exists. `path` second so the order is total and stable.
   ORDER BY n.active DESC, n.path;
$$;

comment on function visible_board_roots() is
  'The top of the caller''s visible forest: every node they can read whose parent they cannot. The board opens on the first row. SECURITY INVOKER on purpose - the caller''s own visibility is the question, not an input to it.';

revoke execute on function visible_board_roots() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function visible_board_roots() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function visible_board_roots() from anon';
  end if;
end $$;

-- No UPGRADE_CHECKS row: this migration adds one function and transforms no
-- data. See 0026 §5 for the standing rule and why it is stated rather than
-- assumed.

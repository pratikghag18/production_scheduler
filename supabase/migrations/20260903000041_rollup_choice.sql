-- ============================================================================
-- Migration 0041: a node says whether it adds up its children's cycle times.
--
-- The maintainer, 3 Sept, on the roll-up shipped in 0040: "if two lines are
-- working the same products but are parallel jobs, then adding them to the
-- higher hierarchy does not make sense and is wrong... Some lines could be in
-- continuation of one another and some could be parallel to one another." Then,
-- asked how far to take it: "I want to be able to choose to add or not to add."
--
-- WHY THE SUM WAS WRONG, PRECISELY. R-317 rolled a node's descendants up by
-- adding them, on the reading that a sum is the LABOUR CONTENT of one unit.
-- That reading holds only when a unit passes through EVERY child. Two cells in
-- a line are sequential stations, so a unit really does cost 60 s + 90 s. Two
-- lines under an area are ALTERNATIVE ROUTES: a unit goes down one or the
-- other, and no unit ever costs both. Adding them produced a number describing
-- nothing — not a rate, and not labour content either. That is a stronger
-- objection than the one 0040's own header answered, and it is correct.
--
-- WHAT THIS STORES, AND WHAT IT DELIBERATELY DOES NOT. One nullable boolean per
-- node: does this node add up its children? NULL means nobody has said, and the
-- client resolves it (see below) rather than the column guessing. It is a plain
-- choice about arithmetic, not a model of the plant's routing: it cannot
-- describe one line feeding another while a third runs independently. That
-- needs real routing data and is already the Phase 3 queue item; pretending a
-- boolean covers it would be the same overreach as the sum it replaces.
--
-- ⚠️ NOTHING DERIVED FROM THIS REACHES A TARGET. R-316's derived target reads
-- the CELL's own cycle time and only ever did; the roll-up has always been
-- display. So a wrong setting here misleads a reader and corrupts nothing,
-- which is why a plain toggle is proportionate.
--
-- Implements: R-319. Refs: R-317 (the sum this qualifies), migration 0040.
-- ============================================================================

alter table nodes
  add column sums_children boolean;

comment on column nodes.sums_children is
  'R-319: does this node ADD UP its children''s standard cycle times? true when a unit passes through every child (a line''s sequential cells), false when the children are alternative routes (an area''s parallel lines). NULL means unset — the client resolves it, defaulting to true only for a node whose own children are the schedulable level, which is the one place summing is reliably right. Display only: no target, capacity or write is derived from it (R-316 reads the cell''s own cycle time). Not a routing model — it cannot express one line feeding another.';

-- No backfill, and that is the point of the column being NULLABLE. Writing a
-- guess into every existing row would make "the default happened to apply" and
-- "somebody chose this" indistinguishable the moment the default is revisited,
-- and it would leave nodes created later with a column default that cannot vary
-- by level. An unset node resolves on read instead; `create_node` is untouched.

-- No new RLS. `nodes_update` (0020) already gates every column of this table on
-- `app_is_admin() or app_is_admin_on_path(path)` — the same authority that
-- renames a node — and the column is covered by it. Nor is a new grant needed:
-- `nodes` predates 0008's one-shot GRANT, so the table privilege is long since
-- in place (that trap applies to tables CREATED after it, as 0034 and 0040 note).

-- ⚠️ The path-cascade trigger fires on `update of name, parent_id` only
-- (0001 §, deliberately), so setting this column rewrites no paths and touches
-- no descendant. It is a leaf edit in every sense.

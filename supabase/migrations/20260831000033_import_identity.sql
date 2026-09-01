-- ============================================================================
-- 0033 — the missing premises for CSV import (stage 23).
--
-- ⭐⭐ STAGE 23 IS BLOCKED ON THE DATABASE, NOT ON THE SCREEN, and this is the
-- measurement that says so. Before this migration:
--
--     table       external_id  source   unique index on external_id
--     operators   yes          yes      (org_id, external_id)            org-wide
--     skills      yes          yes      (org_id, site_node_id, ext_id)   per owner
--     products    yes          yes      **NONE**
--     nodes       **no**       **no**   —
--
-- Two different holes, and they fail differently:
--
--   * THE HIERARCHY CANNOT BE IMPORTED AT ALL. A spreadsheet row has nothing to
--     match a node against — no column carries the id the exporting system knows
--     the place by — so "import the structure" is not a hard feature, it is an
--     impossible one. This is the blocker the roadmap has recorded since the
--     stage was written.
--
--   * A PRODUCTS RE-IMPORT WOULD DUPLICATE RATHER THAN UPDATE. The column is
--     there and nothing stops two rows carrying the same code, so the second
--     upload of the same file doubles the catalog silently. 0032 recorded this
--     as owed, one table over, in as many words: *"`products` has the column
--     with no uniqueness rule at all, which is exactly what stage 23 records as
--     owed."* This is that debt being paid.
--
-- ----------------------------------------------------------------------------
-- ⭐⭐ THE TWO HALVES GET DIFFERENT ANSWERS ON PURPOSE, AND THE DIFFERENCE IS
-- THE WHOLE DESIGN.
--
--   `nodes`     ORG-WIDE.  A node has no owner above it — it IS the owner
--                          everything else hangs from. A place is identified
--                          within the company, and "Plant A's Plant B" is not a
--                          sentence. There is no scope to be per-owner within.
--
--   `products`  PER OWNER. A product is owned by a place (0023), and two plants
--                          may legitimately import the same code from their own
--                          systems. That is the ordinary case, not a collision.
--                          Settled for trainings in 0031 and mirrored into
--                          `skills` by 0032; `products` now follows the same
--                          rule, so the two owned lists agree.
--
-- ----------------------------------------------------------------------------
-- ⚠️⚠️ `operators` IS DELIBERATELY NOT TOUCHED, AND THE RESULT IS AN
-- INCONSISTENCY THAT AN IMPORTER HAS TO KNOW ABOUT.
--
-- `operators` answers "does this row already exist?" ORG-WIDE — `unique (org_id,
-- external_id)`, a plain table constraint from 0002, predating owned lists
-- entirely. Changing it is a separate decision with its own consequences: it
-- would let two plants each hold an `EMP-1044`, which may be right (two payroll
-- systems) or may be a person quietly duplicated across the roster. That is a
-- question about people, not about indexes, and it is not this migration's.
--
-- So after 0033 four tables answer the same question in three shapes:
--
--     operators   (org_id, external_id)                    org-wide, CONSTRAINT
--     nodes       (org_id, external_id)          partial   org-wide, index
--     products    (org_id, site_node_id, ext_id) partial   per owner, index
--     skills      (org_id, site_node_id, ext_id) partial   per owner, index
--
-- ⚠️ AN IMPORTER MUST MATCH ON A DIFFERENT KEY PER TABLE. The same spreadsheet
-- code appearing under two plants is TWO products and TWO trainings but ONE
-- operator — and the operator upload's second row is a 23505, not an update.
-- Written down here so it is a known shape rather than something discovered
-- mid-import, which is what 0032 asked for.
--
-- ----------------------------------------------------------------------------
-- ⚠️ A PARTIAL INDEX, NOT A PLAIN UNIQUE — the same choice 0032 made and for the
-- same reason. A unique constraint already skips NULLs, so the two behave
-- identically today. The partial form is chosen because it says WHY in the
-- schema itself ("this rule is about imported rows"), and because it does not
-- index the manual rows, which will be the overwhelming majority and will never
-- carry an external id at all. `operators` keeps its constraint form only
-- because it is pre-existing; a new table would get the index.
--
-- ⚠️ THE PRODUCTS INDEX CAN REFUSE TO BUILD, AND THAT IS THE CORRECT FAILURE.
-- `products.external_id` has never had a writer, so in practice every row is
-- NULL and the index builds over nothing. But a deployment that somehow holds
-- two products with the same code under one plant will see this migration ABORT
-- rather than pick a row to discard. Loud is the right answer: the duplicate is
-- a data question a person has to settle, and a migration that guessed would be
-- deleting a catalog entry somebody sells.
--
-- ⭐⭐ AND THE PER-OWNER RULE HAS NO ESCAPE HATCH, BECAUSE 0028 CLOSED IT FIRST.
-- A per-owner unique index over a NULLABLE owner column is a leaky rule: NULL is
-- not equal to itself in an index, so every unowned row would slip past it and a
-- re-import of the company-wide catalog would duplicate anyway. That is not the
-- situation here — 0028 §2 (D108) made `products.site_node_id` NOT NULL and said
-- why in as many words: *"there is no company-wide product."* Every product has
-- an owner, so the index covers the whole table.
--
-- ⚠️ THIS RULE THEREFORE LEANS ON A NEIGHBOURING ONE. If `site_node_id` is ever
-- made nullable again, THIS INDEX SILENTLY STOPS APPLYING to the rows that lose
-- their owner, with no error and no failing migration. Case W9 in
-- 60_import_identity_test.sql pins the NOT NULL for exactly that reason.
--
-- ⚠️ An owner may be ANY node, not only a root (0028: *"a product owned by Line
-- 1 is offered on Line 1 and nowhere else"*). So two LINES inside one plant may
-- also each import the same code as separate products. That follows from what
-- "owner" already means and is not a new decision here.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The hierarchy becomes importable at all.
--
-- ⭐ `source` mirrors `operators`/`products`/`skills` exactly — NOT NULL with a
-- 'manual' default — so every node that already exists comes out honestly
-- marked as entered by hand. A row claiming a provenance it never had is a lie
-- an import screen would then act on ("this came from the CSV, so the CSV may
-- overwrite it"), and it cannot be told apart afterwards.
-- ---------------------------------------------------------------------------
alter table nodes add column source      text not null default 'manual';
alter table nodes add column external_id text;

-- ⚠️ ORG-WIDE, and this is the line to revisit if it is ever wrong. A node has
-- no owner above it to be scoped within — it is what `site_node_id` points AT.
create unique index nodes_org_external_id_unique
  on nodes (org_id, external_id)
  where external_id is not null;

comment on column nodes.external_id is
  '0033: the id this place carries in whatever system exported it — the column '
  'whose absence made "import the hierarchy" impossible rather than merely '
  'unbuilt, because a spreadsheet row had nothing to match a node against. '
  'Unique ORG-WIDE (nodes_org_external_id_unique), unlike products and skills '
  'which are per owner: a node has no owner above it, and a place is identified '
  'within the company. NULL for anything created by hand.';

comment on column nodes.source is
  '0033: where this node came from — ''manual'' or the name of the import that '
  'made it. Mirrors operators/products/skills. Every node predating this '
  'migration is ''manual'', which is the truth about all of them.';

-- ---------------------------------------------------------------------------
-- 2. A products re-import updates instead of duplicating.
--
-- ⭐ The column has existed since 0002 and enforced nothing. This adds only the
-- rule; no column, no backfill, no data change — which is why the risk here is
-- entirely "does the index build over rows that already exist".
-- ---------------------------------------------------------------------------
create unique index products_owner_external_id_unique
  on products (org_id, site_node_id, external_id)
  where external_id is not null;

comment on column products.external_id is
  '0033: the id this product carries in whatever system exported it. Unique PER '
  'OWNER (products_owner_external_id_unique), matching skills and the name rule '
  '0031 settled: two plants each importing their own SKU-100 is the ordinary '
  'case, not a collision. The rule covers the whole table because 0028 made '
  'site_node_id NOT NULL — there is no unowned product to slip past it. ⚠️ NOT '
  'the same shape as operators.external_id, which is org-wide — an importer must '
  'match on a different key per table. NULL for anything created by hand.';

-- ⚠️ `products.sku` IS STILL `unique (org_id, sku)` — ORG-WIDE, from 0002, and
-- untouched here. So two plants importing the same code will each get their own
-- row only if they give it a distinct SKU; reusing the code AS the sku collides
-- on `products_org_id_sku_key` no matter what this index says. That is a real
-- constraint on how the import screen builds its rows and it is a separate
-- decision (is a sku a company-wide name or a plant's name?), left open on
-- purpose. Case W12 measures it so the importer is written knowing it.

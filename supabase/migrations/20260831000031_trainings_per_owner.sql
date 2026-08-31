-- ============================================================================
-- 0031 — D111a: a training's name is unique PER OWNER, not per company.
--
-- THE MAINTAINER, 31 August, on being shown that a site admin may create a
-- training but cannot name it anything another plant already used:
--
--   "It needs to be based on plant name I believe, to easily identify. Most of
--    the plants will have a document number which signifies the training…
--    but if they do share the same document number, a concatenation with plant
--    name should still be good enough."
--
-- The requirement is *tell them apart easily*. This migration delivers that by
-- moving the OWNER into the uniqueness rule rather than into the text, so the
-- plant is read from the column that already holds it and follows a rename for
-- free. The screen shows the owner beside the name; nothing is concatenated.
--
-- ----------------------------------------------------------------------------
-- ⭐⭐ WHAT WAS ACTUALLY BROKEN, AND IT WAS TWO RULES FROM DIFFERENT MIGRATIONS
-- DISAGREEING RATHER THAN EITHER ONE BEING WRONG.
--
--   naming   `unique (org_id, name)`                     — 0002, COMPANY-WIDE
--   reading  `app_can_read_owned(site_node_id)`          — 0026, YOUR BRANCH
--
-- Plant A creates "Forklift". Plant B's admin is refused with 23505 — and
-- cannot see, open, edit or reuse the row that refused them. The refusal names
-- something they have no way to reach. `skills_insert` (0028) has admitted
-- `app_is_admin_for(site_node_id)` since D108, so the PERMISSION to create was
-- already right; only the naming rule made it unusable.
--
-- ⭐ THE DEMO DATA HAS BEEN WORKING AROUND THIS BY HAND, and its own comment
-- says so: *"Trainings. Names are unique per ORG, so they carry the plant
-- letter."* Every seeded training is `A-Welding`, `B-Welding`, `C-Welding`.
-- That prefix is the workaround this migration removes the need for, and
-- `dev_demo.sql` drops it in the same change — the first proof the rule works.
--
-- ----------------------------------------------------------------------------
-- ⚠️ NO BACKFILL IS OWED, AND THE ARGUMENT IS NOT THE EVIDENCE.
-- Every existing row is unique on `(org_id, name)`, so it is trivially unique
-- on the strictly weaker `(org_id, site_node_id, name)` — the new constraint
-- admits a superset of what the old one did, and a WIDENING cannot orphan a
-- row. `upgrade_0031_trainings_per_owner.sql` proves it against real pre-0031
-- data anyway, because rule 5b says the argument is not the evidence.
--
-- ⚠️ AND THE WIDENING DIRECTION IS WHY THIS IS SAFE TO SHIP WITHOUT A LOCK
-- DANCE: nothing that was legal becomes illegal, so no existing INSERT, RPC or
-- screen can start failing on data it used to accept.
--
-- ----------------------------------------------------------------------------
-- ⚠️ `site_node_id` IS NOT NULL (0028 §, verified on the live database before
-- writing this), WHICH IS WHAT MAKES THE NEW CONSTRAINT MEAN ANYTHING.
-- A unique constraint skips rows where any column is NULL, so on a nullable
-- owner two company-wide trainings could both be called "Forklift" and neither
-- would collide. D108 removed company-wide from all four owned tables, so
-- every row has a real owner and every row is covered. **If a later migration
-- ever makes `site_node_id` nullable again, this constraint quietly stops
-- guarding the rows that need it most.** `58_`'s T7 pins that.
--
-- ----------------------------------------------------------------------------
-- ⚠️ WHAT THIS DELIBERATELY DOES NOT DO: enforce uniqueness per PLANT.
-- `site_node_id` is any node, so Line 1 and Line 2 inside one plant may now
-- each hold a "TRN-4471". That is a real loosening and it was weighed:
--   * enforcing per-plant needs a stored root column kept by a trigger, and it
--     goes stale the day a node is moved between plants;
--   * the client can warn instead, RELIABLY, because a plant admin can read
--     their whole plant — `findExistingSkillByName` is exactly that warning,
--     and it is honest at plant scope in a way it never was across plants.
-- **Database refuses per owner; screen warns per plant.** If the loosening ever
-- bites, the root column is an addition, not a redesign.
--
-- ⚠️ THE CONSTRAINT IS CASE-SENSITIVE, like every text unique in this schema.
-- "forklift" and "Forklift" under one owner are two storable rows. That is not
-- new and is not fixed here — the client treats a case-only match as a warning
-- rather than a refusal, which is the honest mirror of what the database does.
-- ============================================================================

-- `skills_org_id_name_key` is the system-generated name for the inline
-- `unique (org_id, name)` in 0002. Read off `pg_constraint` on the live
-- database rather than assumed, because a guessed constraint name is a
-- migration that fails on someone else's machine and not on mine.
alter table skills drop constraint skills_org_id_name_key;

alter table skills add constraint skills_owner_name_unique
  unique (org_id, site_node_id, name);

comment on constraint skills_owner_name_unique on skills is
  'D111a: a training name is unique within its owning node, not across the org. '
  'Two plants may each hold "Forklift"; one plant may not hold it twice. '
  'Depends on skills.site_node_id staying NOT NULL (D108) — a unique constraint '
  'skips NULL, so a nullable owner would silently stop guarding these rows.';

-- ⚠️ `unique (org_id, id)` STAYS. It is not redundant with the primary key and
-- it is not this rule: `operator_skills` and `node_skill_requirements` carry
-- composite foreign keys `(org_id, skill_id)` that reference it, which is how
-- a training and the row holding it are pinned to the same tenant. Dropping it
-- would remove the only thing stopping a cross-org reference (D3).

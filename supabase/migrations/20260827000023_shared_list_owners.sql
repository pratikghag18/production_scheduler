-- ============================================================================
-- 0023 — the shared lists get an owner, and a product gets a colour of its own.
--
-- THE MAINTAINER'S WORDS (D101/D102, design plan §19.59):
--   "The shift pattern will be per-site, we can have defaults but I'd rather
--    the site admin set them up for their site, same thing for colours."
--
-- THE TEST, unchanged since 0020 and it decides every line below:
-- **can a site admin do this without touching another site?** For a row in a
-- shared list the answer is yes exactly when the row is THEIRS, so every one of
-- these tables gains the same nullable `site_node_id` the structure got, with
-- the same meaning: NULL = company-wide.
--
-- ⭐ WHAT THIS MIGRATION CHANGES IS **WHO MAY EDIT**, AND NOTHING ELSE.
-- Every `_select` policy is left exactly as 0008 wrote it, org-wide. That is
-- not caution, it is a measured requirement:
--
--   `check_eligibility` (0009) is SECURITY INVOKER and reads `operator_skills`
--   and `skills` AS THE CALLER. A skill the caller cannot see drops out of its
--   `held` CTE, lands in `missing`, and flips `eligible` to false -- and
--   `create_assignment` gates on that. **A read narrowing would become a write
--   refusal one indirection along, with no error anywhere.**
--
-- It is also exactly what the maintainer said the rule was for shift patterns:
-- ownership decides who may EDIT a pattern, not which pattern applies. 0020 §12
-- took the same position for node attachments and said so.
--
-- ⛔ AND THIS MIGRATION DELIBERATELY DOES NOT BACKFILL OWNERSHIP.
-- Every row that exists today was created under the company-wide regime and is
-- correctly company-wide now; claiming it for a site would silently hand
-- somebody else's roster to a site admin. There is no ambiguity to resolve and
-- no ambiguity to resolve there. **§4's colour backfill IS a data transform,
-- though**, so it carries a row in `UPGRADE_CHECKS` and
-- `upgrade_0023_product_colour.sql` -- see §9 item 5, and note that writing
-- that file is what found the palette-width defect in §3.
--
-- (This paragraph said the opposite until an adversarial review caught it. A
-- migration is append-only; a header that lies is permanent. Rule 17's shape,
-- and the second time in two days a comment outlived the thing it described.)
--
-- NO THIRTEENTH ERROR CODE. Every refusal below is `invalid_argument` or the
-- policy's own silent zero rows, distinguished by the DETAIL `reason` key.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- §1. The owning site, on all four shared lists.
--
-- NULLABLE, and here that is the FEATURE rather than a concession to creation
-- order: an unowned row is the company-wide default the maintainer asked for. "We can
-- have defaults" and "NULL" are the same sentence.
--
-- The composite `(org_id, site_node_id)` foreign key is the D3 idiom every
-- child table here uses: it makes a cross-tenant reference structurally
-- impossible rather than merely policy-forbidden.
--
-- ⚠️ NO UNIQUE INDEX, and this is the one place copying 0020 verbatim would be
-- wrong. `hierarchy_templates` has one because a site has exactly ONE
-- structure. A site has MANY operators, products, skills and shift patterns.
--
-- ⚠️ AND `operators.home_node_id` IS NOT THIS COLUMN, however much it looks
-- like it. Measured: its FK admits ANY node in the org, every seeded value
-- points at a Department or a Work Cell rather than at a site, and it is read
-- by nothing anywhere -- not one policy, predicate or WHERE clause. It is a
-- roster-filter default that was never built. Renaming it into an owner would
-- fail §2's root check on every row in the seed.
-- ----------------------------------------------------------------------------
alter table operators       add column site_node_id uuid;
alter table products        add column site_node_id uuid;
alter table skills          add column site_node_id uuid;
alter table shift_templates add column site_node_id uuid;

alter table operators add constraint operators_org_id_site_node_id_fkey
  foreign key (org_id, site_node_id) references nodes (org_id, id);
alter table products add constraint products_org_id_site_node_id_fkey
  foreign key (org_id, site_node_id) references nodes (org_id, id);
alter table skills add constraint skills_org_id_site_node_id_fkey
  foreign key (org_id, site_node_id) references nodes (org_id, id);
alter table shift_templates add constraint shift_templates_org_id_site_node_id_fkey
  foreign key (org_id, site_node_id) references nodes (org_id, id);

-- Every write policy below filters on this pair, on every statement.
create index operators_org_site_idx       on operators (org_id, site_node_id);
create index products_org_site_idx        on products (org_id, site_node_id);
create index skills_org_site_idx          on skills (org_id, site_node_id);
create index shift_templates_org_site_idx on shift_templates (org_id, site_node_id);

comment on column operators.site_node_id is
  'The ROOT node whose site owns this operator (0023). NULL = company-wide: readable by everyone in the org and editable only by a company admin. NOT the same thing as home_node_id, which is an unenforced roster-filter default pointing at any node.';
comment on column products.site_node_id is
  'The ROOT node whose site owns this product (0023). NULL = company-wide.';
comment on column skills.site_node_id is
  'The ROOT node whose site owns this skill (0023). NULL = company-wide, which is the expected case: a qualification is not a place.';
comment on column shift_templates.site_node_id is
  'The ROOT node whose site owns this shift pattern (0023, D101). NULL = company-wide, so a company admin can seed a standard pattern once and each site adds its own alongside. Ownership decides who may EDIT the pattern, never which pattern a node RUNS -- that is still nearest-ancestor resolution through node_shift_templates.';


-- ----------------------------------------------------------------------------
-- §2. A site is a ROOT. Enforced, not assumed -- and enforced ONCE.
--
-- Nothing in §1 stops a row claiming a Work Cell as its "site", and a claim
-- like that would quietly widen a site admin's reach: `app_is_admin_for` would
-- answer for the cell, and the cell's admin would own a list the plant above it
-- uses. A CHECK constraint cannot look at another table, so this is a trigger.
--
-- ⭐ ONE function, four triggers, not four functions. 0020 wrote
-- `hierarchy_templates_check_site()` for a single table; four copies of it
-- would be D100's defect in SQL -- four correct declarations that drift. Every
-- one of these tables has `site_node_id` and `org_id` by the same names, which
-- is what makes one body legal on all four.
--
-- It fires on INSERT and on UPDATE OF site_node_id, org_id -- note the column
-- list. These rows are renamed and deactivated constantly; re-reading `nodes`
-- on every rename would be work for nothing.
--
-- ⭐⭐ SECURITY DEFINER, AND CASES Q6/Q9 ARE WHY. Written first as a plain
-- (INVOKER) trigger, exactly like 0020's, it resolved `nodes` AS THE CALLER --
-- so a site admin naming ANOTHER site's root got `not found` from this trigger
-- instead of a permission refusal from the policy. Measured: Q6 and Q9 came
-- back `PT400`, not `42501`.
--
-- Two things were wrong with that and the second is the worse one:
--   1. "not found" was a LIE about a node that exists — 0020 §8.0's exact
--      finding, one table over;
--   2. the trigger was answering the PERMISSION question and masking the
--      policy's own refusal, which would make every mutation of a WITH CHECK
--      term below look CAUGHT when it was the trigger catching it.
--
-- The division of labour this restores: **the trigger enforces a structural
-- invariant (the owner is a real root in this org); the POLICY decides whether
-- you may do it.** Q6 and Q9 assert `42501` precisely so the two cannot swap
-- jobs again.
--
-- ⚠️ And SECURITY DEFINER is safe HERE while 0020 §11 refused it for
-- `nodes_check_level_adjacency`: that trigger's body reaches D97's escape-hatch
-- gate, which reads `current_user`, and under DEFINER `current_user` is the
-- owner (gotcha 22). This body reads `nodes` and nothing else, and answers one
-- boolean about the caller's OWN org.
-- ----------------------------------------------------------------------------
create or replace function app_check_site_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_parent_id uuid; v_found boolean;
begin
  if new.site_node_id is null then
    return new;
  end if;

  select true, parent_id into v_found, v_parent_id
    from nodes where id = new.site_node_id and org_id = new.org_id;

  if v_found is not true then
    perform api_raise('invalid_argument', 'the owning site node was not found in this org',
      jsonb_build_object('field', 'site_node_id', 'reason', 'not found'));
  end if;

  if v_parent_id is not null then
    perform api_raise('invalid_argument',
      'this can only be owned by a top-level site, not by a node inside one',
      jsonb_build_object('field', 'site_node_id', 'reason', 'not a root node'));
  end if;

  return new;
end;
$$;

comment on function app_check_site_owner() is
  'Enforces that a shared list row is owned by a ROOT node in its own org (0023). SECURITY DEFINER so it can tell "no such node" from "a node you cannot see" -- the permission question belongs to the policy, not here. ⚠️ It is therefore a three-way oracle over node ids: a caller who may write ANY of these tables learns, for a uuid they cannot SELECT, whether it is absent, mid-tree, or a root that is not theirs (the last as a 42501 from the policy). Uuids are unguessable and a site admin already knows their own org has other sites, so this is recorded rather than closed.';

create trigger operators_check_site
  before insert or update of site_node_id, org_id on operators
  for each row execute function app_check_site_owner();
create trigger products_check_site
  before insert or update of site_node_id, org_id on products
  for each row execute function app_check_site_owner();
create trigger skills_check_site
  before insert or update of site_node_id, org_id on skills
  for each row execute function app_check_site_owner();
create trigger shift_templates_check_site
  before insert or update of site_node_id, org_id on shift_templates
  for each row execute function app_check_site_owner();


-- ----------------------------------------------------------------------------
-- §3. A product's colour belongs to the product (D102).
--
-- MEASURED BEFORE WRITING THIS, on the seeded database, and it is worse than
-- "the fifth product has no colour":
--
--   `board_window` emits products `ORDER BY p.sku` (0014:649); the client takes
--   the row's ORDINAL in that array modulo four (BoardGrid.tsx:182). So the
--   colour a product gets is its alphabetical position among its siblings.
--   Against the seed:
--
--     Gadget Z -> --product-1, whose comment says "Widget X"
--     Rework   -> --product-2, whose comment says "Widget Y"
--     Widget X -> --product-3, whose comment says "Gadget Z"
--     Widget Y -> --product-4, whose comment says "Rework"
--
--   **All four are wrong, and they have been since P1-1** -- tokens.css was
--   written from the mockup's INSERTION order and the server sorts by SKU.
--   Nobody noticed because every colour is still A colour.
--
-- A TOKEN NAME, NEVER A HEX. The board resolves `--product-N` through
-- tokens.css, so a theme change stays one edit, and a hex stored here would be
-- a colour that escapes `scaleAudit` the way D89's inline paddingLeft did. The
-- CHECK enforces the shape without the database needing to know how wide the
-- palette is.
-- ----------------------------------------------------------------------------
alter table products add column color_token text;

alter table products add constraint products_color_token_shape
  check (color_token is null or color_token ~ '^product-[1-9][0-9]*$');

comment on column products.color_token is
  'The palette token this product renders in, e.g. product-3 (0023, D102). NEVER a hex -- the board resolves it through tokens.css. NULL only transiently: app_pick_product_color() fills it on insert.';


-- The palette, in ONE place -- and it is FOUR TOKENS WIDE, deliberately, which
-- is not what this migration first said.
--
-- ⭐⭐ IT SHIPPED AT EIGHT AND `upgrade_0023_product_colour.sql` CAUGHT IT.
-- D102 says the palette grows past four, and widening it HERE alone is exactly
-- the wrong half of that change: `tokens.css` defines `--product-1` through
-- `--product-4` and nothing else, so the moment this function handed out
-- `product-5` the board resolved `var(--product-5)` to nothing and the product
-- rendered with NO COLOUR AT ALL -- strictly worse than the wrong one, which is
-- the whole complaint this column exists to answer.
--
-- Measured, not reasoned: with six products the upgrade test's V1 reported two
-- of six changing colour and V2 named the fifth as `product-5`. On a fresh
-- database nothing would have shown it, because the seed has exactly four.
--
-- **The palette is as wide as the stylesheet, and not one token wider.**
-- Widening it is this function AND `tokens.css` in the SAME commit -- case Q31
-- pins the size so one side cannot move without the other, and that case is
-- meant to be edited when the pair moves together.
--
-- Keeping it at four also makes the BACKFILL agree with the old client rule by
-- construction: least-used-in-scope over four tokens, walked in sku order, IS
-- the ordinal rule the client has used since P1-1, so an existing board does
-- not move (upgrade V1 asserts it).
--
-- ⚠️ THE TRIGGER PATH IS A DIFFERENT ORDER AND THE SEED WILL LOOK DIFFERENT.
-- A fresh `db:reset` has no products at backfill time, so §3's trigger assigns
-- as the seed INSERTS -- WX, WY, GZ, RW -> product-1..4 -- while the old client
-- rule sorts by sku and gives WX product-3. So on a reset database the four
-- seeded products change colour ONCE, when the client starts reading the
-- column. That is not a regression and it is worth knowing before it is
-- reported as one: insertion order is what `tokens.css`'s own comments have
-- always claimed (`--product-1 /* Widget X */`), and the sku ordering is what
-- made all four of those comments wrong. The reset path makes the file honest.
create or replace function app_product_palette() returns text[]
language sql immutable as $$
  SELECT ARRAY['product-1','product-2','product-3','product-4'];
$$;

comment on function app_product_palette() is
  'The product colour vocabulary (0023). EXACTLY as wide as tokens.css: handing out a token the stylesheet does not define renders a product with no colour. Widening the palette is this function AND tokens.css, in one commit, plus case Q31.';


-- ⭐ "A DETERMINISTIC DEFAULT WITHIN THE OWNER'S SCOPE", made literal.
--
-- The least-used token among the products sharing this row's owner, ties broken
-- by the palette's own order. Two properties this buys that the ordinal rule
-- never had:
--
--   1. inserting a product CANNOT change the colour of one that already exists,
--      because nothing is derived from position;
--   2. a site's palette is its own -- two sites can both have a product-1 and
--      neither re-shuffles the other, which is what "site's own" has to mean.
--
-- SECURITY DEFINER because the insert trigger must count rows the inserting
-- site admin may not read -- another site's products are none of their business
-- and they still must not be handed a colour already in use next door.
--
-- ⭐⭐ AND IT IS NOT CALLABLE BY ANYBODY. THIS IS THE FIX FOR A REAL LEAK.
--
-- The first version was SECURITY DEFINER, took the org as a free parameter, and
-- was GRANTED TO `authenticated` -- while its own comment claimed it was
-- "tenant-scoped internally in 0012's shape". An adversarial reviewer read it
-- and the comment was the opposite of the truth. It lives in `public`, so
-- PostgREST exposes it: any viewer in org 1 could call it with org 2's id, have
-- RLS bypassed by DEFINER, and read back which of another tenant's palette
-- slots were least used -- not rows, but the shape of a competitor's catalogue
-- modulo four. **D83/0012's finding, verbatim, in a new function.**
--
-- The obvious fix -- `where p_org_id = app_current_org()` -- was written, and
-- then measured to be WRONG: §4's backfill and `seed.sql` both run with no
-- session profile, so `app_current_org()` is NULL there and the guard would
-- have returned NULL into a NOT NULL column. A guard that breaks the only two
-- callers is not a guard.
--
-- So the boundary is a GRANT instead of a predicate: this function is revoked
-- from PUBLIC and granted to NOBODY, and §3's trigger below is SECURITY DEFINER
-- so it can reach it on an ordinary user's insert. That removes the PostgREST
-- surface entirely rather than narrowing it -- the only paths in are an INSERT
-- on `products`, which RLS already governs, and owner-context code.
--
-- ⚠️ A grant is a thing people delete (0019's X15: deleting a GRANT line was
-- caught by nothing until the REVOKE existed). Case Q35 asserts `authenticated`
-- CANNOT execute it, and mutation R27 deletes the revoke.
create or replace function app_pick_product_color(p_org_id uuid, p_site_node_id uuid)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT t.token
    FROM unnest(app_product_palette()) WITH ORDINALITY AS t(token, pos)
    LEFT JOIN products p
      ON p.color_token = t.token
     AND p.org_id = p_org_id
     AND p.site_node_id IS NOT DISTINCT FROM p_site_node_id
   GROUP BY t.token, t.pos
   ORDER BY count(p.id), t.pos
   LIMIT 1;
$$;

comment on function app_pick_product_color(uuid, uuid) is
  'The least-used palette token within one owner scope, ties broken by palette order (0023, D102). IS NOT DISTINCT FROM, so the company-wide scope (NULL owner) is a scope like any other. ⚠️ SECURITY DEFINER and DELIBERATELY GRANTED TO NOBODY -- it takes the org as a parameter and bypasses RLS, so an authenticated caller holding EXECUTE could read another tenant''s palette usage. Reachable only from products_set_color_token() (also DEFINER) and from owner-context code. Case Q35 pins that authenticated cannot execute it.';

-- SECURITY DEFINER so that an ordinary insert can reach the picker without the
-- picker being granted to anyone -- see the block above. It sets one field and
-- reads no session state, so gotcha 22 (`current_user` becoming the owner under
-- DEFINER) has nothing to bite on here.
create or replace function products_set_color_token() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.color_token is null then
    new.color_token := app_pick_product_color(new.org_id, new.site_node_id);
  end if;
  return new;
end;
$$;

-- INSERT only. Moving a product between sites deliberately does NOT re-colour
-- it: a product that changes colour because somebody re-assigned it is the
-- re-shuffle this whole section exists to stop.
create trigger products_set_color_token
  before insert on products
  for each row execute function products_set_color_token();


-- ----------------------------------------------------------------------------
-- §4. The one backfill, and why this one cannot be left to the client.
--
-- Ownership is NOT backfilled (see the header). Colour is, because the column
-- has to be non-null for every existing row the moment the client stops
-- deriving it from position -- otherwise a product renders with no colour at
-- all, which is worse than the wrong one.
--
-- ⚠️ AND ON `db:reset` THIS LOOP SEES NOTHING, which is correct and is the
-- reason §3's trigger exists rather than this statement being the whole
-- mechanism. `db:reset` applies every migration to an EMPTY schema and only
-- then runs `seed.sql`, so at backfill time there are no products -- the same
-- shape that left 0020's backfill a silent no-op with the suite entirely green.
-- Here both paths are covered and both call the SAME picker, so there is one
-- rule rather than two that must be kept in step.
--
-- `(created_at, sku)` is the closest thing this table records to insertion
-- order. Rows created in one statement tie and fall back to sku, so on the
-- seed this reproduces today's assignment exactly and an existing board does
-- not change colour under an upgrade.
-- ----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select id, org_id, site_node_id from products
            where color_token is null order by created_at, sku loop
    update products set color_token = app_pick_product_color(r.org_id, r.site_node_id)
     where id = r.id;
  end loop;
end $$;

-- ⭐ NOT NULL, AND ONLY HERE -- after the backfill has filled every existing row
-- and with §3's BEFORE INSERT trigger filling every future one.
--
-- The column shipped nullable and the comment on it said "NULL only
-- transiently". An adversarial reviewer showed that was untrue on the UPDATE
-- path: `update products set color_token = null` is a legal statement a site
-- admin may run on their own row, the CHECK explicitly permits NULL, and no
-- trigger fires on UPDATE -- so the product would render with NO COLOUR AT ALL,
-- which §3 calls strictly worse than the wrong one. Case Q23 was asserting an
-- invariant that nothing enforced.
--
-- It also retires a mutation: R23 (the trigger firing on UPDATE too) was
-- reported inert because the body only fills a NULL, and that reasoning was
-- only sound if a NULL could not be written. Now it cannot.
alter table products alter column color_token set not null;


-- ----------------------------------------------------------------------------
-- §5. Three predicates, for the three tables that do not carry the owner.
--
-- `shifts`, `shift_breaks` and `operator_skills` are not shared lists in their
-- own right -- they are the INSIDE of a row that is. A shift belongs to its
-- template; a break belongs to its shift; a skill-holding belongs to its
-- operator. Each asks its parent, and each reads a DIFFERENT table from the one
-- being written, so all three are safe in a WITH CHECK -- that is the whole of
-- D85's rule, stated the same way 0020 §12 states it.
--
-- Tenant-scoped internally, 0012's shape, so a caller that forgets its own org
-- term still cannot reach across a tenant.
-- ----------------------------------------------------------------------------
create or replace function app_is_admin_for_operator(p_operator_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM operators o
    WHERE o.id = p_operator_id
      AND o.org_id = app_current_org()
      AND (app_is_admin()
           OR (o.site_node_id IS NOT NULL AND app_is_admin_for(o.site_node_id)))
  );
$$;

comment on function app_is_admin_for_operator(uuid) is
  'May the caller administer this operator -- company admin of its org, or the site admin of the site that owns it (0023)? Tenant-scoped internally. Do NOT call from operators'' own INSERT WITH CHECK: it reads that table (D85). operator_skills is a different table, which is why it is safe there.';

create or replace function app_is_admin_for_shift_template(p_template_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM shift_templates t
    WHERE t.id = p_template_id
      AND t.org_id = app_current_org()
      AND (app_is_admin()
           OR (t.site_node_id IS NOT NULL AND app_is_admin_for(t.site_node_id)))
  );
$$;

comment on function app_is_admin_for_shift_template(uuid) is
  'May the caller administer this shift pattern -- company admin, or the admin of the site that owns it (0023, D101)? Tenant-scoped internally. Do NOT call from shift_templates'' own INSERT WITH CHECK (D85); shifts and node_shift_templates are different tables and are fine.';

-- Two hops, because `shift_breaks` carries `shift_id` and the owner lives on
-- the template above it. Written as its own function rather than a join in the
-- policy so the two-hop path exists in exactly one place.
create or replace function app_is_admin_for_shift(p_shift_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM shifts s
    WHERE s.id = p_shift_id
      AND s.org_id = app_current_org()
      AND app_is_admin_for_shift_template(s.template_id)
  );
$$;

comment on function app_is_admin_for_shift(uuid) is
  'May the caller administer this shift -- i.e. the pattern it belongs to (0023)? The two-hop break -> shift -> template path, in one place.';


-- ----------------------------------------------------------------------------
-- §6. The write policies. SEVEN tables, twenty-one policies.
--
-- Four carry the owner and ask `app_is_admin_for(site_node_id)` on the row's
-- own column; three ask their parent through §5.
--
-- ⚠️ AND THAT IS SAFE HERE FOR A REASON WORTH STATING PRECISELY, because
-- `app_is_admin_for`'s own COMMENT says "Do NOT call from an INSERT WITH CHECK".
-- That prohibition is about `nodes`: D85 is "a predicate that reads table X is
-- unsafe inside X's own INSERT WITH CHECK", and `app_is_admin_for` reads
-- `nodes`. Here the tables being written are `operators`, `products`, `skills`
-- and `shift_templates` -- **a different table from the one the predicate
-- reads**, every time. 0019 could not do this for `nodes` and used
-- `app_is_admin_on_path(path)` instead; an earlier draft of this comment cited
-- 0019 as the precedent it was following, which was the opposite of the truth.
-- 0020 §12 makes the same distinction for `node_shift_templates`.
--
-- UPDATE names its predicate TWICE on every table, so a site admin can neither
-- push one of their rows onto another site (WITH CHECK, the new row) nor claim
-- one that belongs elsewhere (USING, the old row). That symmetry is the
-- property 0019's S11 pins for nodes and it is worth a mutation each.
--
-- ⭐ INSERT IS A REAL WIDENING, NOT A NARROWING, AND THAT IS THE POINT.
-- Measured before writing: `app_is_admin()` reads `user_profiles.role`, the
-- ORG-WIDE flag, so today a site admin (org-wide `viewer` carrying an `admin`
-- grant) can write NOTHING in any of these seven tables -- not in their own
-- site, not anywhere. Every one of the twenty-one policies below hands them
-- something they did not have. Nothing here can regress a permission; the only
-- way to get this wrong is to hand out too much.
--
-- An INSERT with a NULL owner is company-admin-only on all seven, and that
-- falls out of the predicate rather than being a rule of its own: NULL has no
-- site to be an admin of. **Creating a company-wide default is not a site
-- admin's job; creating and editing their own is.**
--
-- ⛔ EVERY `_select` POLICY IS UNTOUCHED. See the header.
-- ----------------------------------------------------------------------------
drop policy operators_insert on operators;
drop policy operators_update on operators;
drop policy operators_delete on operators;

create policy operators_insert on operators for insert
  with check (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))));
create policy operators_update on operators for update
  using (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))))
  with check (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))));
create policy operators_delete on operators for delete
  using (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))));

drop policy products_insert on products;
drop policy products_update on products;
drop policy products_delete on products;

create policy products_insert on products for insert
  with check (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))));
create policy products_update on products for update
  using (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))))
  with check (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))));
create policy products_delete on products for delete
  using (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))));

drop policy skills_insert on skills;
drop policy skills_update on skills;
drop policy skills_delete on skills;

create policy skills_insert on skills for insert
  with check (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))));
create policy skills_update on skills for update
  using (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))))
  with check (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))));
create policy skills_delete on skills for delete
  using (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))));

drop policy shift_templates_insert on shift_templates;
drop policy shift_templates_update on shift_templates;
drop policy shift_templates_delete on shift_templates;

create policy shift_templates_insert on shift_templates for insert
  with check (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))));
create policy shift_templates_update on shift_templates for update
  using (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))))
  with check (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))));
create policy shift_templates_delete on shift_templates for delete
  using (org_id = app_current_org()
    and (app_is_admin() or (site_node_id is not null and app_is_admin_for(site_node_id))));

-- The inside of a shift pattern follows the pattern.
drop policy shifts_insert on shifts;
drop policy shifts_update on shifts;
drop policy shifts_delete on shifts;

create policy shifts_insert on shifts for insert
  with check (org_id = app_current_org() and app_is_admin_for_shift_template(template_id));
create policy shifts_update on shifts for update
  using (org_id = app_current_org() and app_is_admin_for_shift_template(template_id))
  with check (org_id = app_current_org() and app_is_admin_for_shift_template(template_id));
create policy shifts_delete on shifts for delete
  using (org_id = app_current_org() and app_is_admin_for_shift_template(template_id));

drop policy shift_breaks_insert on shift_breaks;
drop policy shift_breaks_update on shift_breaks;
drop policy shift_breaks_delete on shift_breaks;

create policy shift_breaks_insert on shift_breaks for insert
  with check (org_id = app_current_org() and app_is_admin_for_shift(shift_id));
create policy shift_breaks_update on shift_breaks for update
  using (org_id = app_current_org() and app_is_admin_for_shift(shift_id))
  with check (org_id = app_current_org() and app_is_admin_for_shift(shift_id));
create policy shift_breaks_delete on shift_breaks for delete
  using (org_id = app_current_org() and app_is_admin_for_shift(shift_id));

-- ⚠️ `operator_skills` GETS NO OWNER COLUMN OF ITS OWN, and that is a decision.
-- A row joining a Plant-1 operator to a company-wide skill has no derivable
-- owner, and 0020's precedent for exactly that shape was to leave it unowned
-- rather than pick arbitrarily. It follows the OPERATOR, because "who may say
-- what this person is qualified to do" is a question about the person.
drop policy operator_skills_insert on operator_skills;
drop policy operator_skills_update on operator_skills;
drop policy operator_skills_delete on operator_skills;

create policy operator_skills_insert on operator_skills for insert
  with check (org_id = app_current_org() and app_is_admin_for_operator(operator_id));
create policy operator_skills_update on operator_skills for update
  using (org_id = app_current_org() and app_is_admin_for_operator(operator_id))
  with check (org_id = app_current_org() and app_is_admin_for_operator(operator_id));
create policy operator_skills_delete on operator_skills for delete
  using (org_id = app_current_org() and app_is_admin_for_operator(operator_id));


-- ----------------------------------------------------------------------------
-- §7. Grants -- and one hole this migration is closing on the way past.
--
-- The REVOKE is the load-bearing half, not the GRANT: `authenticated` is a
-- member of PUBLIC and PostgreSQL grants EXECUTE to PUBLIC by default, so a
-- bare grant is decoration. 0019's mutation X15 proved it by deleting one and
-- being caught by nothing until the revoke existed.
--
-- ⭐ `resolve_shift_template(uuid)` HAS BEEN ANON-EXECUTABLE SINCE 0005.
-- D93 found four RPCs in exactly this state because 0014's grant block covered
-- a TABLE and not its functions; this is the fifth, and it has been sitting in
-- the shifts migration since the beginning. It is SECURITY INVOKER and 0008
-- revoked anon's table privileges, so the practical exposure is an error rather
-- than data -- but it costs one line, and §2 of the shifts survey is right that
-- a future change making it DEFINER would turn a harmless hole into a real one
-- in a single edit.
-- ----------------------------------------------------------------------------
-- ⭐ These two are granted to NOBODY. The revoke is the whole of their
-- protection: they are DEFINER, they take a tenant as an argument, and they are
-- reachable only from `products_set_color_token()` (DEFINER) and from
-- owner-context code such as §4's backfill and `seed.sql`.
revoke execute on function app_pick_product_color(uuid, uuid) from public;
revoke execute on function app_product_palette() from public;
revoke execute on function app_is_admin_for_operator(uuid) from public;
revoke execute on function app_is_admin_for_shift_template(uuid) from public;
revoke execute on function app_is_admin_for_shift(uuid) from public;
revoke execute on function resolve_shift_template(uuid) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_is_admin_for_operator(uuid) to authenticated';
    execute 'grant execute on function app_is_admin_for_shift_template(uuid) to authenticated';
    execute 'grant execute on function app_is_admin_for_shift(uuid) to authenticated';
    execute 'grant execute on function resolve_shift_template(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_pick_product_color(uuid, uuid) from anon';
    execute 'revoke all on function app_product_palette() from anon';
    execute 'revoke all on function app_is_admin_for_operator(uuid) from anon';
    execute 'revoke all on function app_is_admin_for_shift_template(uuid) from anon';
    execute 'revoke all on function app_is_admin_for_shift(uuid) from anon';
    execute 'revoke all on function resolve_shift_template(uuid) from anon';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- §8. `board_window` hands the colour over.
--
-- ⚠️ EXTRACTED WITH `pg_get_functiondef` FROM THE LIVE DATABASE AND EDITED BY
-- STRING REPLACEMENT, never retyped -- 0014's rule, and the reason is that a
-- hand-reproduction of a 138-line function is how a subquery goes missing. The
-- edit is ONE key added to the products object, asserted to match exactly once
-- before it was applied. `pg_get_functiondef`'s output carries NO TRAILING
-- SEMICOLON; the one below was appended by hand, which is the gotcha that has
-- already cost this project one `syntax error at or near "CREATE"`.
--
-- The extraction is from the LIVE definition -- migration 0014's, not 0009's.
-- 0009 also defines `board_window` and extracting from it would silently revert
-- D86's template half, which is decision-record-drift rule 3 and has happened
-- here before.
--
-- Adding a key is client-safe on its own: `parseProduct` destructures the keys
-- it knows and ignores the rest, so the board keeps working against this
-- migration with no client change at all. Reading the colour is the next
-- commit's job, and it deletes TWO copies of the ordinal rule --
-- `BoardGrid.tsx` and, separately, the legend in `BoardToolbar.tsx`.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.board_window(p_root_path ltree, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org_id uuid;
  v_window tstzrange;
  v_result jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_from and p_to must not be null',
      jsonb_build_object('field', 'p_from/p_to', 'reason', 'null bound'));
  END IF;
  IF p_from >= p_to THEN
    PERFORM api_raise('invalid_argument', 'p_from must be before p_to',
      jsonb_build_object('field', 'p_from', 'reason', 'p_from >= p_to'));
  END IF;
  IF p_to - p_from > interval '92 days' THEN
    PERFORM api_raise('invalid_argument', 'window exceeds 92 days',
      jsonb_build_object('field', 'p_to', 'reason', 'window exceeds 92 days'));
  END IF;

  v_org_id := app_current_org();
  v_window := tstzrange(p_from, p_to);

  WITH scoped_nodes AS (
    SELECT n.* FROM nodes n
    WHERE n.org_id = v_org_id AND n.path <@ p_root_path
  ),
  scoped_templates AS (
    SELECT DISTINCT hl.template_id
    FROM scoped_nodes sn JOIN hierarchy_levels hl ON hl.id = sn.level_id
  ),
  node_template_map AS (
    SELECT sn.id AS node_id, resolve_shift_template(sn.id) AS template_id
    FROM scoped_nodes sn
  )
  SELECT jsonb_build_object(
    'org', (SELECT jsonb_build_object('id', o.id, 'name', o.name, 'settings', o.settings)
            FROM orgs o WHERE o.id = v_org_id),

    'levels', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', hl.id, 'template_id', hl.template_id, 'position', hl.position,
               'name', hl.name, 'is_schedulable', hl.is_schedulable)
             ORDER BY hl.template_id, hl.position)
      FROM hierarchy_levels hl
      WHERE hl.org_id = v_org_id
        AND hl.template_id IN (SELECT template_id FROM scoped_templates)
    ), '[]'::jsonb),

    'nodes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', sn.id, 'parent_id', sn.parent_id, 'level_id', sn.level_id,
               'name', sn.name, 'path', sn.path::text, 'sort_order', sn.sort_order,
               'active', sn.active) ORDER BY sn.path)
      FROM scoped_nodes sn
    ), '[]'::jsonb),

    'runs', COALESCE((
      SELECT jsonb_agg(to_jsonb(r) ORDER BY r.timerange)
      FROM runs r
      WHERE r.node_id IN (SELECT id FROM scoped_nodes) AND r.timerange && v_window
    ), '[]'::jsonb),

    'assignments', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.timerange)
      FROM assignments a
      WHERE a.node_id IN (SELECT id FROM scoped_nodes) AND a.timerange && v_window
    ), '[]'::jsonb),

    'operators', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', op.id, 'home_node_id', op.home_node_id, 'display_name', op.display_name,
               'employee_ref', op.employee_ref, 'active', op.active,
               'skill_ids', COALESCE((
                 SELECT jsonb_agg(os.skill_id) FROM operator_skills os WHERE os.operator_id = op.id
               ), '[]'::jsonb)
             ) ORDER BY op.display_name)
      FROM operators op WHERE op.org_id = v_org_id
    ), '[]'::jsonb),

    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'active', p.active, 'color_token', p.color_token) ORDER BY p.sku)
      FROM products p WHERE p.org_id = v_org_id
    ), '[]'::jsonb),

    'skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
      FROM skills s WHERE s.org_id = v_org_id
    ), '[]'::jsonb),

    -- Scoped to nodes under p_root_path (not the whole org): every
    -- requirement relevant to a returned node is at or above some node
    -- already included in `nodes` (p_root_path itself is included, since
    -- ltree `<@` is reflexive), so this stays complete for any p_root_path
    -- while not leaking unrelated subtrees' skill config into a
    -- narrower-scoped board load.
    'node_skill_requirements', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('node_id', nsr.node_id, 'skill_id', nsr.skill_id)
               ORDER BY nsr.node_id, nsr.skill_id)
      FROM node_skill_requirements nsr
      WHERE nsr.node_id IN (SELECT id FROM scoped_nodes)
    ), '[]'::jsonb),

    'shift_templates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', st.id, 'name', st.name,
               'shifts', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', s.id, 'name', s.name, 'start_min', s.start_min, 'end_min', s.end_min,
                          'breaks', COALESCE((
                            SELECT jsonb_agg(jsonb_build_object(
                                     'id', b.id, 'name', b.name, 'start_min', b.start_min, 'end_min', b.end_min)
                                     ORDER BY b.start_min)
                            FROM shift_breaks b WHERE b.shift_id = s.id
                          ), '[]'::jsonb)
                        ) ORDER BY s.start_min)
                 FROM shifts s WHERE s.template_id = st.id
               ), '[]'::jsonb)
             ) ORDER BY st.name)
      FROM shift_templates st
      WHERE st.id IN (SELECT DISTINCT template_id FROM node_template_map WHERE template_id IS NOT NULL)
    ), '[]'::jsonb),

    'node_shift_map', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('node_id', ntm.node_id, 'template_id', ntm.template_id)
               ORDER BY ntm.node_id)
      FROM node_template_map ntm
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;


-- ============================================================================
-- §9. What 0023 deliberately does NOT do, so nobody finishes it later by
--     accident.
--
-- 1. **It does not narrow a single `_select` policy.** See the header: reads
--    stay org-wide because `check_eligibility` is SECURITY INVOKER and a read
--    narrowing becomes a silent write refusal. Narrowing reads is a real
--    question and it deserves its own migration, its own measurement of what
--    the board does when a row vanishes, and its own conversation. Case
--    Y11 asserts the reads are still org-wide, so that change cannot happen by
--    accident.
--
-- 2. **It does not give `operator_skills` an owner column.** §6 says why.
--
-- 3. **It does not touch `node_shift_templates`.** 0020 §12 already made
--    attaching a pattern to a node the node admin's job, and it must stay
--    possible to attach a COMPANY-WIDE pattern to a site's node -- that is what
--    "we can have defaults" buys. Constraining the attachment to the node's own
--    site would take the defaults away.
--
-- 4. **It does not re-colour a product that changes owner.** §3's trigger is
--    INSERT-only, on purpose.
--
-- 5. **It does not backfill ownership.** Every row that exists was created
--    company-wide and stays that way; ownership is set going forward.
--
--    ⚠️ THIS ITEM ORIGINALLY WENT ON TO SAY "and there is therefore no
--    `UPGRADE_CHECKS` row and no `upgrade_0023_*.sql`". That was wrong, and
--    case Q24 is what proved it: **§4's colour backfill IS a data transform**,
--    and the rule on that is unconditional. `upgrade_0023_product_colour.sql`
--    exists, it has a row in `UPGRADE_CHECKS`, and writing it immediately
--    found the palette-width defect in §3 that no fresh-database test could
--    have -- the seed has exactly four products and the bug needs five.
--    An absence argued for in a comment is not the same as an absence measured.
-- ============================================================================

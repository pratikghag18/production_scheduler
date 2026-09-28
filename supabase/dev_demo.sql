-- ============================================================================
-- supabase/dev_demo.sql — THE DEMO WORLD (D112).
--
-- *** LOCAL DEVELOPMENT ONLY. NEVER RUN THIS AGAINST A HOSTED PROJECT. ***
-- It DELETES data and sets a publicly-known password on five accounts.
--
-- ----------------------------------------------------------------------------
-- ⭐⭐ WHAT THIS FILE IS, AND WHY IT DELETES THE SEED'S WORLD.
--
-- Stated requirement, 28 Aug: *"Lets start fresh with brand new data for each
-- plant in the database now for operators and products assigned and locked in
-- to individual sites."*
--
-- `seed.sql` and this file now describe TWO DIFFERENT WORLDS on purpose:
--
--   seed.sql       the TEST FIXTURE. One plant, one structure, nine operators,
--                  four products, the Aisha 50/50 pair. `scripts/verify-db.sh`
--                  runs migrations + seed and nothing else, and about eighteen
--                  cases across eight files rest on org 1 holding EXACTLY ONE
--                  structure -- `90_hierarchy_template_test.sql`'s T32 exists
--                  precisely to assert that an omitted `p_template_id` resolves
--                  when there is only one candidate, and that path stops being
--                  reachable the moment a second plant exists. Measured when
--                  this was first tried: a second plant in the seed turns 8
--                  files and ~18 named cases red.
--
--   dev_demo.sql   THE DEMO WORLD. Three plants, everything owned, built with
--                  the real RPCs. This is what the running app shows.
--
-- So this file CLEARS ORG 1's seeded content and builds over the top. That is
-- deliberate and it is the only arrangement in which both files can be right:
-- the fixture stays the shape the suite needs, and the app stops showing a
-- one-plant world that cannot demonstrate a single rule D107-D109 added.
--
-- ⚠️ IT DOES NOT TOUCH ORG 2 (Contoso). That org is the cross-tenant fixture
-- and `80_cross_org_test.sql` depends on it.
--
-- ----------------------------------------------------------------------------
-- HOW TO RUN IT. `supabase/config.toml` lists it after `seed.sql`, so
-- `npm run db:reset` applies it automatically. To re-apply by hand: open
-- Supabase Studio at http://127.0.0.1:54323, SQL Editor, paste the whole file.
-- Success is silent; the assertions at the foot raise if anything is wrong.
--
-- Idempotent by construction -- it opens by deleting what it is about to
-- build, so re-running it produces the same world rather than a second copy.
--
-- ----------------------------------------------------------------------------
-- THE WORLD. Three plants, each the same shape, so a difference on screen is
-- always about the RULES and never about the data:
--
--   Plant A / Plant B / Plant C          (Site, not schedulable)
--     Area 1                             (Department)
--       Line 1  -> Cell 1, Cell 2        (Line -> Work Cell, schedulable)
--       Line 2  -> Cell 3, Cell 4
--     Area 2
--       Line 3  -> Cell 5, Cell 6
--
-- ⭐ AND NOT EVERYTHING IS OWNED BY A WHOLE PLANT. D109 says ownership is a
-- scope at ANY level, and a world where every row is owned by a root cannot
-- show it. So each plant has one part owned by a single LINE and one by a
-- single AREA, one person owned by a line, and Plant A has a training owned by
-- a line. Those are the rows that prove "offered on Line 1 and nowhere else".
--
-- THE CAST, password `devpassword`:
--
--   admin@example.test   company admin      -- sees all three plants
--   dana@example.test    site admin         -- Plant A
--   quinn@example.test   site admin         -- Plant B
--   rosa@example.test    site admin         -- Plant C
--   ana@example.test     supervisor         -- Plant A / Area 1 / LINE 1 only
--   marco@example.test   supervisor         -- Plant B / Area 1
--
-- ⭐ ANA IS GRANTED A LINE, NOT A PLANT, AND THAT IS THE POINT. D107's read
-- rule runs in BOTH directions: she must still see Plant A's plant-wide parts
-- (owner ABOVE her grant) or her board is empty, and she must NOT see Plant B's
-- anything. Signing in as her is the fastest way to check the rule by hand.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. CLEAR ORG 1. As the table owner, so RLS is not in the way.
--
-- Order is the foreign-key order read from `\d nodes`' "Referenced by" list,
-- not from memory. `nodes` is deleted last and by depth, because its own
-- `parent_id` self-reference is not deferrable.
-- ---------------------------------------------------------------------------
RESET ROLE;

DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
BEGIN
  DELETE FROM assignments             WHERE org_id = v_org;
  DELETE FROM runs                    WHERE org_id = v_org;
  DELETE FROM operator_skills         WHERE org_id = v_org;
  DELETE FROM node_skill_requirements WHERE org_id = v_org;
  DELETE FROM node_shift_templates    WHERE org_id = v_org;
  DELETE FROM shift_breaks            WHERE org_id = v_org;
  DELETE FROM shifts                  WHERE org_id = v_org;
  DELETE FROM shift_templates         WHERE org_id = v_org;
  DELETE FROM products                WHERE org_id = v_org;
  DELETE FROM operators               WHERE org_id = v_org;
  DELETE FROM skills                  WHERE org_id = v_org;
  DELETE FROM profile_grants          WHERE org_id = v_org;
  -- F-177 (18 Sept, session 179): two tables younger than this teardown point at
  -- the demo's rows -- a week template (0067) at a plant, an absence (0066) at a
  -- person -- and a re-seed after either had been written stopped at the node
  -- loop with "still referenced from table week_templates". Deleted here so the
  -- demo can be re-anchored on a stack that has been used.
  DELETE FROM week_templates          WHERE org_id = v_org;
  DELETE FROM absences                WHERE org_id = v_org;

  -- A structure that belongs to a site points AT a node, so break that link
  -- before the nodes go. The ORIGINAL 'Standard Plant' structure has no site
  -- and is kept: `create_node` copies it when a new root is created (0020 §10),
  -- so it is the seed corn for the three plants below.
  UPDATE hierarchy_templates SET site_node_id = NULL WHERE org_id = v_org;

  -- Deepest first. `nodes_org_id_parent_id_fkey` is checked per row.
  FOR i IN REVERSE 12..1 LOOP
    DELETE FROM nodes WHERE org_id = v_org AND nlevel(path) = i;
  END LOOP;

  -- Now the copied structures from any previous run of this file. The original
  -- is the one `seed.sql` inserted; everything else here was made by a
  -- `create_node` root call and has nothing left to describe.
  DELETE FROM hierarchy_levels
   WHERE org_id = v_org AND template_id <> '21000000-0000-0000-0000-000000000001';
  DELETE FROM hierarchy_templates
   WHERE org_id = v_org AND id <> '21000000-0000-0000-0000-000000000001';
END $$;

-- ---------------------------------------------------------------------------
-- 2. THE THREE PLANTS, built with `create_node` rather than by INSERT.
--
-- ⚠️ DIRECT INSERTS WOULD SKIP THE COPY-ON-ROOT-CREATE (0020 §10) and all
-- three plants would share one structure -- so renaming a level in Plant A
-- would silently rename it in B and C, which is the opposite of "each site is
-- its own instance of the app". `create_node` is SECURITY INVOKER, so this runs
-- as the company admin rather than as the table owner.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE d_fix (k text primary key, v uuid);

DO $$
DECLARE
  v_plant uuid; v_a1 uuid; v_a2 uuid; v_l1 uuid; v_l2 uuid; v_l3 uuid;
  v_letter text; v_i int := 0; v_c int;
  v_keys text[] := '{}';
  v_ids  uuid[] := '{}';
BEGIN
  -- ⚠️⚠️ NOTHING TOUCHES `d_fix` WHILE THE ROLE IS `authenticated`. A TEMP
  -- table is owned by the session user and `authenticated` cannot read or write
  -- it -- the refusal arrives as "permission denied for table d_fix", which
  -- reads exactly like an RLS failure in the code under test. That cost a
  -- debugging session in `53_read_scoping_test.sql` and it cost the first draft
  -- of this file too. The ids are accumulated in ARRAYS and written after the
  -- role is reset.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;

  FOREACH v_letter IN ARRAY ARRAY['A','B','C'] LOOP
    v_plant := (create_node(NULL, 'Plant ' || v_letter, v_i,
                            '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
    v_a1 := (create_node(v_plant, 'Area 1', 0)->>'id')::uuid;
    v_a2 := (create_node(v_plant, 'Area 2', 1)->>'id')::uuid;
    v_l1 := (create_node(v_a1, 'Line 1', 0)->>'id')::uuid;
    v_l2 := (create_node(v_a1, 'Line 2', 1)->>'id')::uuid;
    v_l3 := (create_node(v_a2, 'Line 3', 0)->>'id')::uuid;

    v_keys := v_keys || ARRAY[v_letter || ':plant', v_letter || ':area1',
                              v_letter || ':area2', v_letter || ':line1',
                              v_letter || ':line2', v_letter || ':line3'];
    v_ids  := v_ids  || ARRAY[v_plant, v_a1, v_a2, v_l1, v_l2, v_l3];

    FOR v_c IN 1..6 LOOP
      v_keys := v_keys || (v_letter || ':cell' || v_c);
      v_ids  := v_ids  || (create_node(
                             CASE WHEN v_c <= 2 THEN v_l1
                                  WHEN v_c <= 4 THEN v_l2
                                  ELSE v_l3 END,
                             'Cell ' || v_c,
                             (v_c - 1) % 2)->>'id')::uuid;
    END LOOP;

    v_i := v_i + 1;
  END LOOP;

  RESET ROLE;

  INSERT INTO d_fix (k, v)
  SELECT k, v FROM unnest(v_keys, v_ids) AS t(k, v);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'DEMO FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- ---------------------------------------------------------------------------
-- 3. THE PEOPLE. Two of the six are new accounts; the other four are the ones
-- `seed.sql` already created, re-homed into the new world.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-00000000dec1', 'dana@example.test'),
  ('00000000-0000-0000-0000-00000000dec2', 'quinn@example.test'),
  ('00000000-0000-0000-0000-00000000dec3', 'rosa@example.test'),
  -- Three VIEWERS, one per plant (the maintainer, 6 Sept: "create few dummy
  -- viewers for all plants"). R-346's viewer clause is what they exist to
  -- show: a viewer sees the board and nothing else -- no Operators panel, no
  -- create form, read-only pop-ups -- and reads only the people at their own
  -- places. Their grant is the plant root, role viewer.
  ('00000000-0000-0000-0000-00000000dec4', 'viva@example.test'),
  ('00000000-0000-0000-0000-00000000dec5', 'vito@example.test'),
  ('00000000-0000-0000-0000-00000000dec6', 'vina@example.test')
ON CONFLICT DO NOTHING;

-- ⭐ ORG-WIDE `viewer`, NOT `admin`, FOR THE THREE SITE ADMINS. One org-wide
-- `admin` and `app_is_admin()` short-circuits the first branch of every
-- predicate the site-instance model turns on -- they would demonstrate nothing.
-- Their entire authority comes from the grant below.
INSERT INTO user_profiles (id, org_id, user_id, role, default_create_mode) VALUES
  ('d0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000dec1', 'viewer', 'run'),
  ('d0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000dec2', 'viewer', 'run'),
  ('d0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000dec3', 'viewer', 'run'),
  ('d0000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000dec4', 'viewer', 'run'),
  ('d0000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000dec5', 'viewer', 'run'),
  ('d0000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000dec6', 'viewer', 'run')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;

DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
BEGIN
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
  SELECT 'd0000000-0000-0000-0000-000000000001', v, v_org, 'admin' FROM d_fix WHERE k = 'A:plant';
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
  SELECT 'd0000000-0000-0000-0000-000000000002', v, v_org, 'admin' FROM d_fix WHERE k = 'B:plant';
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
  SELECT 'd0000000-0000-0000-0000-000000000003', v, v_org, 'admin' FROM d_fix WHERE k = 'C:plant';
  -- The viewers: Viva on Plant A, Vito on Plant B, Vina on Plant C.
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
  SELECT 'd0000000-0000-0000-0000-000000000004', v, v_org, 'viewer' FROM d_fix WHERE k = 'A:plant';
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
  SELECT 'd0000000-0000-0000-0000-000000000005', v, v_org, 'viewer' FROM d_fix WHERE k = 'B:plant';
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
  SELECT 'd0000000-0000-0000-0000-000000000006', v, v_org, 'viewer' FROM d_fix WHERE k = 'C:plant';

  -- ⭐ Ana is granted a LINE, not a plant. She must still see Plant A's
  -- plant-wide parts (owner ABOVE her grant) and none of Plant B's.
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
  SELECT 'a0000000-0000-0000-0000-000000000002', v, v_org, 'supervisor' FROM d_fix WHERE k = 'A:line1';
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
  SELECT 'a0000000-0000-0000-0000-000000000003', v, v_org, 'supervisor' FROM d_fix WHERE k = 'B:area1';
END $$;

-- ---------------------------------------------------------------------------
-- 4. WHAT EACH PLANT OWNS.
--
-- Part numbers are unique per ORG (`unique (org_id, sku)`), so the plant is in
-- the number: PN-1xxx is Plant A, 2xxx Plant B, 3xxx Plant C. Colour is chosen
-- by a trigger (D102) and is deliberately not supplied here.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org uuid := '10000000-0000-0000-0000-000000000001';
  v_letter text; v_n int; v_plant uuid; v_line1 uuid; v_area2 uuid; v_cell5 uuid;
BEGIN
  FOREACH v_letter IN ARRAY ARRAY['A','B','C'] LOOP
    v_n     := ascii(v_letter) - ascii('A') + 1;   -- 1, 2, 3
    SELECT v INTO v_plant FROM d_fix WHERE k = v_letter || ':plant';
    SELECT v INTO v_line1 FROM d_fix WHERE k = v_letter || ':line1';
    SELECT v INTO v_area2 FROM d_fix WHERE k = v_letter || ':area2';
    SELECT v INTO v_cell5 FROM d_fix WHERE k = v_letter || ':cell5';

    -- D115 (0034): each product is company-wide; product_sites lists where it is
    -- made. Two made plant-wide, one by a LINE, one by an AREA -- the last two
    -- are what make "offered here and nowhere else" visible on screen.
    WITH ins AS (
      INSERT INTO products (org_id, sku, name) VALUES
        (v_org, 'PN-' || v_n || '001', 'Housing ' || v_letter),
        (v_org, 'PN-' || v_n || '002', 'Bracket ' || v_letter),
        (v_org, 'PN-' || v_n || '003', 'Line 1 Subassembly ' || v_letter),
        (v_org, 'PN-' || v_n || '004', 'Area 2 Frame ' || v_letter)
      RETURNING id, sku
    )
    INSERT INTO product_sites (org_id, product_id, node_id)
    SELECT v_org, id,
           CASE
             WHEN sku = 'PN-' || v_n || '003' THEN v_line1
             WHEN sku = 'PN-' || v_n || '004' THEN v_area2
             ELSE v_plant
           END
      FROM ins;

    -- Six people. Five belong to the plant; one belongs to Line 1 only, which
    -- is the operator half of the same rule. `home_node_id` must sit inside
    -- the owner's scope -- 0028 §4 refuses it otherwise.
    INSERT INTO operators (org_id, display_name, employee_ref, site_node_id, home_node_id)
    SELECT v_org,
           'Operator ' || v_letter || i,
           'EMP-' || v_n || lpad(i::text, 3, '0'),
           CASE WHEN i = 1 THEN v_line1 ELSE v_plant END,
           (SELECT v FROM d_fix WHERE k = v_letter || ':cell' || i)
      FROM generate_series(1, 6) AS i;

    -- ⭐⭐ TRAININGS, AND THE PLANT LETTER IS GONE FROM THE NAMES (0031 / D111a).
    -- This comment used to read "Names are unique per ORG, so they carry the
    -- plant letter" — a workaround for a rule that made a real screen unusable:
    -- a site admin could not name a training anything another plant had used,
    -- and could not see the row that refused them. `A-Welding` was this file
    -- doing by hand what every admin would otherwise have had to do by hand.
    --
    -- The names are unique PER OWNER now, so all three plants say `Welding` and
    -- mean their own. **That the demo needs no prefix is the point of 0031**, and
    -- three identical names sitting in one table is the proof it works.
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      (v_org, 'Welding',     v_plant),
      (v_org, 'Forklift',    v_plant),
      (v_org, 'Line 1 Cert', v_line1);
  END LOOP;

  -- ⭐⭐ D115: ONE PART MADE IN TWO PLANTS -- the case a single owner could not
  -- express and this whole migration exists for. A company-wide sku, offered in
  -- Plant A and Plant B and nowhere else. Dana (Plant A) and Quinn (Plant B) each
  -- see it in their catalogue; Rosa (Plant C) does not.
  WITH ins AS (
    INSERT INTO products (org_id, sku, name)
    VALUES (v_org, 'PN-9001', 'Common Fastener')
    RETURNING id
  )
  INSERT INTO product_sites (org_id, product_id, node_id)
  SELECT v_org, ins.id, pn.v
    FROM ins CROSS JOIN (SELECT v FROM d_fix WHERE k IN ('A:plant', 'B:plant')) AS pn;
END $$;

-- Who holds what. A person may only hold a training on their own branch
-- (0028 §4), so the Line-1 operator gets the Line-1 certificate and the
-- plant-wide people get the plant-wide trainings.
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001'; v_letter text;
BEGIN
  FOREACH v_letter IN ARRAY ARRAY['A','B','C'] LOOP
    INSERT INTO operator_skills (org_id, operator_id, skill_id, expires_at)
    SELECT v_org, o.id, s.id,
           CASE WHEN o.display_name LIKE '%3' THEN (now() + interval '20 days')::date END
      FROM operators o, skills s
     WHERE o.org_id = v_org AND s.org_id = v_org
       -- F-181 (18 Sept, session 179): the first person (Sam Patel on Plant A)
       -- holds Welding as well as the Line 1 Cert below, because the typed walk
       -- and the maintainer's own list put Sam on Cell 1, which requires it; the
       -- stack that passed the walk had that row from a lane's hand, not the
       -- seed, and a re-seed lost it. Tom Baker (5) stays the uncertified case.
       AND o.display_name IN ('Operator ' || v_letter || '1',
                              'Operator ' || v_letter || '2',
                              'Operator ' || v_letter || '3',
                              'Operator ' || v_letter || '4')
       -- ⚠⚠ THE OWNER IS PART OF THE LOOKUP NOW, AND HAS TO BE. All three
       -- plants hold a training called `Welding`, so `s.name = 'Welding'`
       -- alone matches three rows and would hand every plant's people every
       -- plant's ticket — which `app_guard_operator_skill_scope` (0028 §4)
       -- would then refuse, one row at a time, from a seed file. **A name is
       -- no longer an identifier; a name plus an owner is.**
       AND s.name = 'Welding'
       AND s.site_node_id = (SELECT v FROM d_fix WHERE k = v_letter || ':plant');

    INSERT INTO operator_skills (org_id, operator_id, skill_id)
    SELECT v_org, o.id, s.id
      FROM operators o, skills s
     WHERE o.org_id = v_org AND s.org_id = v_org
       AND o.display_name = 'Operator ' || v_letter || '1'
       AND s.name = 'Line 1 Cert'
       AND s.site_node_id = (SELECT v FROM d_fix WHERE k = v_letter || ':line1');
  END LOOP;
END $$;

-- A requirement on each plant's Line 1: every cell under it inherits it.
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001'; v_letter text;
BEGIN
  FOREACH v_letter IN ARRAY ARRAY['A','B','C'] LOOP
    INSERT INTO node_skill_requirements (org_id, node_id, skill_id)
    SELECT v_org, (SELECT v FROM d_fix WHERE k = v_letter || ':line1'), s.id
      FROM skills s
     WHERE s.org_id = v_org AND s.name = 'Welding'
       AND s.site_node_id = (SELECT v FROM d_fix WHERE k = v_letter || ':plant');
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. SHIFT PATTERNS. One per plant, owned by the plant, attached at the root
-- so every cell under it resolves to the same pattern.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org uuid := '10000000-0000-0000-0000-000000000001';
  v_letter text; v_plant uuid; v_tpl uuid;
BEGIN
  FOREACH v_letter IN ARRAY ARRAY['A','B','C'] LOOP
    SELECT v INTO v_plant FROM d_fix WHERE k = v_letter || ':plant';

    INSERT INTO shift_templates (org_id, name, site_node_id)
    VALUES (v_org, v_letter || ' — 3 × 8h', v_plant)
    RETURNING id INTO v_tpl;

    INSERT INTO shifts (org_id, template_id, name, start_min, end_min) VALUES
      (v_org, v_tpl, 'Shift 1', 360,  840),
      (v_org, v_tpl, 'Shift 2', 840,  1320),
      (v_org, v_tpl, 'Shift 3', 1320, 1800);

    INSERT INTO shift_breaks (org_id, shift_id, name, start_min, end_min)
    SELECT v_org, s.id, 'Lunch', s.start_min + 240, s.start_min + 270
      FROM shifts s WHERE s.template_id = v_tpl;

    INSERT INTO node_shift_templates (org_id, node_id, template_id)
    VALUES (v_org, v_plant, v_tpl);
  END LOOP;

  -- R-441 (18 Sept, session 179; the maintainer: "assign shifts to all operators
  -- randomly"): every demo person gets a band of the pattern their plant runs,
  -- the same on every seed -- the walks and the tester can name who is on
  -- which shift.
  -- ⚠️ 21 Sept (F-187): the pattern is the PLANT's, found by walking up from
  -- the person's own site to its root -- not by `st.site_node_id =
  -- o2.site_node_id`, which only ever matched people owned at the root. The
  -- one person per plant owned at Line 1 (EMP-x001, Sam Patel on Plant A)
  -- joined nothing and kept `home_shift_id` NULL, so the walk's own person
  -- showed "No shift" while R-441 promises every operator a home shift.
  -- ⭐ R-462 (DEF-0045, the maintainer, 28 Sept: "spread Plant A's people
  -- across all three shifts"). A hash of the employee ref (`abs(hashtext(...))
  -- % count(*)`) landed all six of Plant A's people on Shift 2 or 3, so the
  -- rail Ana (Line 1's supervisor) sees stood empty all of Shift 1's hours
  -- (06:00-14:00 Chicago) even though a band did cover "now" -- DEF-0045.
  -- Round-robin by EACH PLANT'S OWN employee-ref order is still deterministic
  -- (no `random()`, R-441's own promise) and covers every shift of every
  -- plant whenever a plant has at least as many people as shifts (6 and 3
  -- here): rank 1 gets the first shift by `start_min`, rank 2 the second, and
  -- so on, wrapping. `EMP-<n>001` -- the one person per plant owned at Line 1
  -- (Sam Patel on Plant A) -- sorts first within its own plant by
  -- construction (`lpad(i::text, 3, '0')`, i starting at 1), so this ALSO
  -- guarantees that person lands on the plant's own first shift (Shift 1)
  -- with no separate rule naming them -- exactly what Ana's rail needs.
  UPDATE operators o SET home_shift_id = pick.shift_id
    FROM (
      WITH ranked AS (
        -- ⚠️ Reviewer note (S194-C follow-up, 28 Sept): this ranks by
        -- `employee_ref` TEXT order, not by anything that names a person as
        -- "already placed" -- adding a demo operator whose ref SORTS BEFORE
        -- an existing one (an `EMP-<n>000`, say, or any ref that is not the
        -- next unused `EMP-<n>NNN` in sequence) re-ranks every person after
        -- it and moves them onto a DIFFERENT shift, silently, the next reset.
        -- A new demo operator's `employee_ref` must APPEND (the next unused
        -- number for its plant), never be inserted ahead of an existing one,
        -- or this comment's own promise about Sam Patel (EMP-<n>001, always
        -- rank 1, always Shift 1) stops being reliable for whoever reads it.
        SELECT o2.id AS operator_id, root.id AS root_id,
               row_number() OVER (PARTITION BY root.id ORDER BY o2.employee_ref) AS rnk
          FROM operators o2
          JOIN nodes own ON own.id = o2.site_node_id
          JOIN nodes root ON root.org_id = own.org_id AND root.parent_id IS NULL AND root.path @> own.path
         WHERE o2.org_id = v_org
      ),
      shifts_by_root AS (
        SELECT root.id AS root_id, array_agg(s.id ORDER BY s.start_min) AS shift_ids
          FROM nodes root
          JOIN shift_templates st ON st.org_id = v_org AND st.site_node_id = root.id
          JOIN shifts s ON s.template_id = st.id
         WHERE root.org_id = v_org AND root.parent_id IS NULL
         GROUP BY root.id
      )
      SELECT r.operator_id,
             sbr.shift_ids[1 + ((r.rnk - 1) % array_length(sbr.shift_ids, 1))] AS shift_id
        FROM ranked r
        JOIN shifts_by_root sbr ON sbr.root_id = r.root_id
    ) AS pick
   WHERE o.id = pick.operator_id;
END $$;

-- ---------------------------------------------------------------------------
-- 6. A WEEK OF SCHEDULE, so no board opens empty.
--
-- Anchored on the Monday of the current week IN THE DEMO PLANT'S ZONE, so it
-- is always the current week rather than a fixed date that drifts into the
-- past, and every hour below is the wall-clock hour it names in that zone.
--
-- ⭐ R-450 (the maintainer, 22 Sept: "The demo plant should be in Chicago
-- timezone"). Until then this block added '6 hours' to a UTC Monday, so the
-- seeded Shift 1 was 06:00 UTC, which read as 06:00 only while the plant had
-- no zone at all -- and as 01:00 the moment someone set Chicago on the
-- Settings tab (F-190: the typed walk wrote five hours off on a reset stack).
-- The zone is named ONCE (v_zone), the day is a plain local timestamp, and
-- each range is that local wall clock turned into an instant with AT TIME
-- ZONE, which is DST-correct (a 06:00 on the changeover Sunday is still
-- 06:00). Section 6b below sets the same zone company-wide, so the board
-- reads these rows back as the hours written here after every reset.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org uuid := '10000000-0000-0000-0000-000000000001';
  v_zone text := 'America/Chicago';
  v_letter text; v_day timestamp; v_cell uuid; v_run uuid; v_prod uuid;
  v_i int; v_d int; v_from timestamptz; v_to timestamptz;
  v_op uuid; v_start int; v_end int;
BEGIN
  -- Monday 00:00 of the current week, on the plant's own calendar.
  v_day := date_trunc('week', now() AT TIME ZONE v_zone);

  FOREACH v_letter IN ARRAY ARRAY['A','B','C'] LOOP
    FOR v_d IN 0..6 LOOP
      FOR v_i IN 1..4 LOOP
        SELECT v INTO v_cell FROM d_fix WHERE k = v_letter || ':cell' || v_i;

        -- ⚠️ THE PRODUCT MUST BE OFFERED HERE (0028 §4). Cells 1 and 2 are
        -- under Line 1, so they may run the Line-1 part; Cells 3 and 4 may not,
        -- and asking them to would raise `not_offered_here`. That refusal is
        -- the feature -- this file simply respects it.
        SELECT p.id INTO v_prod FROM products p
         WHERE p.org_id = v_org
           AND p.sku = 'PN-' || (ascii(v_letter) - ascii('A') + 1)
                       || (CASE WHEN v_i <= 2 AND v_d = 1 THEN '003' ELSE '001' END);

        -- ⭐ R-452 (23 Sept; the maintainer: "why is each and every assignment
        -- tagged as OT?"). The fixed 06:00-14:00 window below used to be
        -- Shift 1's hours for every cell, but R-441 puts each person onto
        -- Shift 1, 2 or 3 of the plant's pattern (a hash at the time; R-462,
        -- 28 Sept, replaced the hash with a round-robin, see §5 above) --
        -- Plant A's six people all landed on Shift 2 or 3 under that first
        -- hash, so every seeded block sat entirely outside its own operator's
        -- home band and `overtimeMinutes()` (read by AssignmentChip/
        -- DirectBlock) tagged all of it OT. The board was reading the seed
        -- correctly; the seed was contradicting itself. Each block now runs
        -- in the SEEDED OPERATOR's own home band instead.
        SELECT o.id, s.start_min, s.end_min INTO v_op, v_start, v_end
          FROM operators o
          JOIN shifts s ON s.id = o.home_shift_id
         WHERE o.org_id = v_org AND o.display_name = 'Operator ' || v_letter || v_i;

        -- §5's UPDATE (above, ~419-445) runs before this block and already
        -- RAISEs if any operator is left shiftless (~716); this is a second,
        -- local guard so a future reorder of §5 after §6 fails loudly here
        -- too, instead of silently seeding a NULL-band block that would read
        -- as all-day OT again.
        IF v_start IS NULL THEN
          RAISE EXCEPTION 'dev_demo: Operator % has no home shift while seeding its schedule (R-452)', v_letter || v_i;
        END IF;

        -- ⚠️ NO `status` COLUMN. Migration 0044 dropped `runs.status` (R-324);
        -- this line still named it for one session and the demo world stopped
        -- building here (DEF-0006). `dev_demo_test.sql` now applies this file
        -- on a runner, so the next dropped column fails loudly instead.
        -- The seeded operator's own home band on day v_d, as Chicago
        -- wall-clock instants (R-452) -- Shift 3 (1320-1800 minutes) crosses
        -- midnight into the next day, which is still one valid tstzrange.
        v_from := (v_day + (v_d || ' days')::interval + (v_start || ' minutes')::interval) AT TIME ZONE v_zone;
        v_to   := (v_day + (v_d || ' days')::interval + (v_end   || ' minutes')::interval) AT TIME ZONE v_zone;

        INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
        VALUES (v_org, v_cell, v_prod, tstzrange(v_from, v_to), 1)
        RETURNING id INTO v_run;

        INSERT INTO assignments (org_id, node_id, operator_id, run_id, timerange, efficiency)
        VALUES (v_org, v_cell, v_op, v_run, tstzrange(v_from, v_to), 1.000);
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 6b. THE DEMO COMPANY'S ZONE (R-450).
--
-- The company-wide fallback every plant inherits (0063: orgs.settings.timezone,
-- read by app_resolve_node_setting and board_window's COALESCE). Set here, in
-- the seed, so a reset never turns the demo back into a UTC plant; set at the
-- company rather than on each root so a fourth plant would inherit it too. The
-- hours in section 6 are written in this same zone (v_zone there and the
-- literal here are the one fact; D13 in dev_demo_test.sql holds them together).
-- ---------------------------------------------------------------------------
UPDATE orgs
   SET settings = COALESCE(settings, '{}'::jsonb) || '{"timezone": "America/Chicago"}'::jsonb
 WHERE id = '10000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 6a. PLANT A'S REAL NAMES (R-423, DEF-0034).
--
-- The maintainer, 15 Sept (session 174): "the operator names being A1, A2,
-- etc is a bit more challenging to understand vs actual people names, should
-- we try modifying plant A with actual people names?" That used to be a
-- standalone rename script, kept out of the seed and applied by hand against
-- this machine's database only -- no reset or e2e path ran it, so every
-- fresh stack kept "Operator A1".."Operator A6" and `e2e/linePeople.spec.ts`
-- and `e2e/viewerBoard.spec.ts` failed on every automated run (DEF-0034).
-- The maintainer, 21 Sept: "put the real names in the seed." So the standalone
-- script is deleted and this file names the six directly.
--
-- ⚠️ WHY THIS IS ITS OWN SECTION AND NOT PART OF THE LOOP IN §2/§4. Section 4
-- builds the six operators per plant as `'Operator ' || v_letter || i`, and
-- everything downstream of that INSERT keys on that exact display name: the
-- training grants above (lines ~354-357, ~371), the F-181 Welding row, and
-- the week of schedule's assignments (§6, `o.display_name = 'Operator ' ||
-- v_letter || v_i`). Renaming inside the loop would break every one of those
-- lookups for Plant A alone. So the rename happens here, AFTER the schedule
-- is built and keyed on the old names, and BEFORE the dev credentials below.
--
-- `employee_ref` is left exactly as it was -- it is the literal string
-- 'EMP-1001' .. 'EMP-1006', not a derived abbreviation like "A1": this seed
-- builds fresh, so there is no old name to guard the UPDATE on, and the EMP
-- refs are the key instead. `src/lib/command/resolve.ts` matches a spoken
-- person word against `displayName` first and `employeeRef` second (its
-- lines ~2062-2065), comparing against the ref field's actual contents -- so
-- nothing about voice resolution changes by keeping the refs.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001'; v_named int;
BEGIN
  UPDATE operators SET display_name = 'Sam Patel'
    WHERE org_id = v_org AND employee_ref = 'EMP-1001';
  UPDATE operators SET display_name = 'Maria Lopez'
    WHERE org_id = v_org AND employee_ref = 'EMP-1002';
  UPDATE operators SET display_name = 'John Kim'
    WHERE org_id = v_org AND employee_ref = 'EMP-1003';
  UPDATE operators SET display_name = 'Priya Shah'
    WHERE org_id = v_org AND employee_ref = 'EMP-1004';
  UPDATE operators SET display_name = 'Tom Baker'
    WHERE org_id = v_org AND employee_ref = 'EMP-1005';
  UPDATE operators SET display_name = 'Lena Novak'
    WHERE org_id = v_org AND employee_ref = 'EMP-1006';

  -- Pairwise, not two IN lists: six rows that each carry SOME real name would
  -- pass a looser count with two people swapped.
  SELECT count(*) INTO v_named
    FROM operators o
    JOIN (VALUES ('EMP-1001', 'Sam Patel'),   ('EMP-1002', 'Maria Lopez'),
                 ('EMP-1003', 'John Kim'),    ('EMP-1004', 'Priya Shah'),
                 ('EMP-1005', 'Tom Baker'),   ('EMP-1006', 'Lena Novak')) AS want(ref, name)
      ON want.ref = o.employee_ref AND want.name = o.display_name
   WHERE o.org_id = v_org;
  IF v_named <> 6 THEN
    RAISE EXCEPTION 'dev_demo: Plant A real names missing (R-423)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. DEV CREDENTIALS, password `devpassword`.
--
-- ⚠️ THE COLUMN LIST BELOW WAS EXTRACTED PROGRAMMATICALLY FROM `seed.sql`'s
-- OWN GoTrue BLOCK, NOT RETYPED (verification rule 12). Four of these columns
-- -- confirmation_token, recovery_token, email_change_token_new, email_change
-- -- have no database default, and GoTrue scans them into non-nullable Go
-- strings: leave any one NULL and sign-in fails with the generic "Database
-- error querying schema" before the password is ever checked. That cost a
-- debugging session once already; seed.sql records it at length.
-- ---------------------------------------------------------------------------
UPDATE auth.users AS u SET
  email                       = v.email,
  encrypted_password          = crypt('devpassword', gen_salt('bf')),
  email_confirmed_at          = now(),
  aud                         = 'authenticated',
  role                        = 'authenticated',
  instance_id                 = '00000000-0000-0000-0000-000000000000',
  confirmation_token          = '',
  recovery_token              = '',
  email_change_token_new      = '',
  email_change                = '',
  email_change_token_current  = '',
  phone_change                = '',
  phone_change_token          = '',
  reauthentication_token      = '',
  email_change_confirm_status = 0,
  raw_app_meta_data           = '{"provider":"email","providers":["email"]}'::jsonb,
  raw_user_meta_data          = '{}'::jsonb,
  is_super_admin              = false,
  created_at                  = COALESCE(u.created_at, now()),
  updated_at                  = now()
FROM (VALUES
  ('00000000-0000-0000-0000-00000000dec1'::uuid, 'dana@example.test'),
  ('00000000-0000-0000-0000-00000000dec2'::uuid, 'quinn@example.test'),
  ('00000000-0000-0000-0000-00000000dec3'::uuid, 'rosa@example.test'),
  ('00000000-0000-0000-0000-00000000dec4'::uuid, 'viva@example.test'),
  ('00000000-0000-0000-0000-00000000dec5'::uuid, 'vito@example.test'),
  ('00000000-0000-0000-0000-00000000dec6'::uuid, 'vina@example.test')
) AS v(id, email)
WHERE u.id = v.id;

INSERT INTO auth.identities
  (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
SELECT
  u.id::text, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email,
                     'email_verified', true, 'phone_verified', false),
  'email', now(), now(), now()
FROM auth.users u
WHERE u.id IN ('00000000-0000-0000-0000-00000000dec1',
               '00000000-0000-0000-0000-00000000dec2',
               '00000000-0000-0000-0000-00000000dec3',
               '00000000-0000-0000-0000-00000000dec4',
               '00000000-0000-0000-0000-00000000dec5',
               '00000000-0000-0000-0000-00000000dec6')
  AND NOT EXISTS (SELECT 1 FROM auth.identities i
                   WHERE i.user_id = u.id AND i.provider = 'email');

-- ---------------------------------------------------------------------------
-- 8. ASSERTIONS. A demo file that half-ran is worse than one that failed:
-- the screen looks plausible and the thing you were about to check is missing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org uuid := '10000000-0000-0000-0000-000000000001';
  v_roots int; v_nodes int; v_structs int; v_prod int; v_ops int;
  v_unowned int; v_narrow int; v_runs int; v_orphan int; v_logins int;
  v_placeless int; v_shared int; v_shiftless int;
BEGIN
  -- R-441 (F-187): every demo person has a home shift, the line-owned one
  -- included. NULL here means the shift pick above joined nothing for them.
  SELECT count(*) INTO v_shiftless FROM operators
   WHERE org_id = v_org AND home_shift_id IS NULL;
  SELECT count(*) INTO v_roots FROM nodes WHERE org_id = v_org AND parent_id IS NULL;
  SELECT count(*) INTO v_nodes FROM nodes WHERE org_id = v_org;
  -- one copied structure per plant, plus the original the copies came from
  SELECT count(*) INTO v_structs FROM hierarchy_templates WHERE org_id = v_org;
  SELECT count(*) INTO v_prod FROM products  WHERE org_id = v_org;
  SELECT count(*) INTO v_ops  FROM operators WHERE org_id = v_org;

  -- D108: nothing may be company-wide. Operators, skills and shift patterns keep
  -- their single owner; this can only fail if a future migration loosens the NOT
  -- NULL -- exactly when a demo full of unowned rows would stop being noticed.
  -- (D115: products no longer carry site_node_id -- their places are counted by
  -- v_placeless below.)
  SELECT count(*) INTO v_unowned FROM (
    SELECT site_node_id FROM operators WHERE org_id = v_org
    UNION ALL SELECT site_node_id FROM skills WHERE org_id = v_org
    UNION ALL SELECT site_node_id FROM shift_templates WHERE org_id = v_org
  ) x WHERE site_node_id IS NULL;

  -- D115: every product is offered in at least one plant. A placeless part is a
  -- legitimate STATE (a catalogue entry not yet assigned), but the demo has none
  -- -- one that appeared would mean a product_sites insert silently did nothing.
  SELECT count(*) INTO v_placeless FROM products p
   WHERE p.org_id = v_org
     AND NOT EXISTS (SELECT 1 FROM product_sites ps WHERE ps.product_id = p.id);

  -- ⭐ D115: the two-plant part is genuinely offered in two plants.
  SELECT count(*) INTO v_shared FROM product_sites ps
    JOIN products p ON p.id = ps.product_id
   WHERE p.org_id = v_org AND p.sku = 'PN-9001';

  -- ⭐ D109: at least one product place per plant sits BELOW a root (a line/area).
  -- Without this the world looks right and demonstrates only half the rule.
  SELECT count(*) INTO v_narrow
    FROM product_sites ps JOIN nodes n ON n.id = ps.node_id
   WHERE ps.org_id = v_org AND n.parent_id IS NOT NULL;

  SELECT count(*) INTO v_runs FROM runs WHERE org_id = v_org;

  -- and the invariant 0028/0034 exists for, over the whole demo world: every run
  -- uses a product offered in some plant that contains the run's node.
  SELECT count(*) INTO v_orphan
    FROM runs r
   WHERE r.org_id = v_org
     AND NOT EXISTS (
       SELECT 1 FROM product_sites ps
         JOIN nodes po ON po.id = ps.node_id
         JOIN nodes rn ON rn.id = r.node_id
        WHERE ps.product_id = r.product_id AND po.path @> rn.path);

  SELECT count(*) INTO v_logins FROM auth.users
   WHERE email IN ('admin@example.test','dana@example.test','quinn@example.test',
                   'rosa@example.test','ana@example.test','marco@example.test',
                   'viva@example.test','vito@example.test','vina@example.test')
     AND encrypted_password IS NOT NULL;

  IF v_roots <> 3 THEN RAISE EXCEPTION 'dev_demo: % root plants, expected 3', v_roots; END IF;
  IF v_nodes <> 36 THEN RAISE EXCEPTION 'dev_demo: % nodes, expected 36 (3 x 12: plant + 2 areas + 3 lines + 6 cells)', v_nodes; END IF;
  IF v_structs <> 4 THEN RAISE EXCEPTION 'dev_demo: % structures, expected 4 (one per plant + the original)', v_structs; END IF;
  IF v_prod <> 13 THEN RAISE EXCEPTION 'dev_demo: % products, expected 13 (12 per-plant + 1 shared across two plants, D115)', v_prod; END IF;
  IF v_ops <> 18 THEN RAISE EXCEPTION 'dev_demo: % operators, expected 18', v_ops; END IF;
  IF v_shiftless <> 0 THEN RAISE EXCEPTION 'dev_demo: % operators with no home shift, expected 0 (R-441, F-187)', v_shiftless; END IF;
  IF v_unowned <> 0 THEN RAISE EXCEPTION 'dev_demo: % company-wide operators/skills/patterns, expected 0 (D108)', v_unowned; END IF;
  IF v_placeless <> 0 THEN RAISE EXCEPTION 'dev_demo: % products offered in no plant, expected 0 (D115)', v_placeless; END IF;
  IF v_shared <> 2 THEN RAISE EXCEPTION 'dev_demo: the shared part is in % plants, expected 2 (D115)', v_shared; END IF;
  IF v_narrow < 6 THEN RAISE EXCEPTION 'dev_demo: only % product places below a root, expected >= 6 (D109)', v_narrow; END IF;
  IF v_runs <> 84 THEN RAISE EXCEPTION 'dev_demo: % runs, expected 84', v_runs; END IF;
  IF v_orphan <> 0 THEN RAISE EXCEPTION 'dev_demo: % runs use a product owned outside them', v_orphan; END IF;
  IF v_logins <> 9 THEN RAISE EXCEPTION 'dev_demo: % of 9 accounts have a password', v_logins; END IF;
END $$;

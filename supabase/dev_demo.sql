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
  ('00000000-0000-0000-0000-00000000dec3', 'rosa@example.test')
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
   '00000000-0000-0000-0000-00000000dec3', 'viewer', 'run')
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
       AND o.display_name IN ('Operator ' || v_letter || '2',
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
END $$;

-- ---------------------------------------------------------------------------
-- 6. A WEEK OF SCHEDULE, so no board opens empty.
--
-- Anchored on `date_trunc('week', now())`, so it is always the current week
-- rather than a fixed date that drifts into the past.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org uuid := '10000000-0000-0000-0000-000000000001';
  v_letter text; v_day timestamptz; v_cell uuid; v_run uuid; v_prod uuid;
  v_i int; v_d int;
BEGIN
  v_day := date_trunc('week', now());

  FOREACH v_letter IN ARRAY ARRAY['A','B','C'] LOOP
    FOR v_d IN 0..2 LOOP
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

        -- ⚠️ NO `status` COLUMN. Migration 0044 dropped `runs.status` (R-324);
        -- this line still named it for one session and the demo world stopped
        -- building here (DEF-0006). `dev_demo_test.sql` now applies this file
        -- on a runner, so the next dropped column fails loudly instead.
        INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
        VALUES (v_org, v_cell, v_prod,
                tstzrange(v_day + (v_d || ' days')::interval + interval '6 hours',
                          v_day + (v_d || ' days')::interval + interval '14 hours'),
                1)
        RETURNING id INTO v_run;

        INSERT INTO assignments (org_id, node_id, operator_id, run_id, timerange, efficiency)
        SELECT v_org, v_cell, o.id, v_run,
               tstzrange(v_day + (v_d || ' days')::interval + interval '6 hours',
                         v_day + (v_d || ' days')::interval + interval '14 hours'),
               1.000
          FROM operators o
         WHERE o.org_id = v_org AND o.display_name = 'Operator ' || v_letter || v_i;
      END LOOP;
    END LOOP;
  END LOOP;
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
  ('00000000-0000-0000-0000-00000000dec3'::uuid, 'rosa@example.test')
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
               '00000000-0000-0000-0000-00000000dec3')
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
  v_placeless int; v_shared int;
BEGIN
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
                   'rosa@example.test','ana@example.test','marco@example.test')
     AND encrypted_password IS NOT NULL;

  IF v_roots <> 3 THEN RAISE EXCEPTION 'dev_demo: % root plants, expected 3', v_roots; END IF;
  IF v_nodes <> 36 THEN RAISE EXCEPTION 'dev_demo: % nodes, expected 36 (3 x 12: plant + 2 areas + 3 lines + 6 cells)', v_nodes; END IF;
  IF v_structs <> 4 THEN RAISE EXCEPTION 'dev_demo: % structures, expected 4 (one per plant + the original)', v_structs; END IF;
  IF v_prod <> 13 THEN RAISE EXCEPTION 'dev_demo: % products, expected 13 (12 per-plant + 1 shared across two plants, D115)', v_prod; END IF;
  IF v_ops <> 18 THEN RAISE EXCEPTION 'dev_demo: % operators, expected 18', v_ops; END IF;
  IF v_unowned <> 0 THEN RAISE EXCEPTION 'dev_demo: % company-wide operators/skills/patterns, expected 0 (D108)', v_unowned; END IF;
  IF v_placeless <> 0 THEN RAISE EXCEPTION 'dev_demo: % products offered in no plant, expected 0 (D115)', v_placeless; END IF;
  IF v_shared <> 2 THEN RAISE EXCEPTION 'dev_demo: the shared part is in % plants, expected 2 (D115)', v_shared; END IF;
  IF v_narrow < 6 THEN RAISE EXCEPTION 'dev_demo: only % product places below a root, expected >= 6 (D109)', v_narrow; END IF;
  IF v_runs <> 36 THEN RAISE EXCEPTION 'dev_demo: % runs, expected 36', v_runs; END IF;
  IF v_orphan <> 0 THEN RAISE EXCEPTION 'dev_demo: % runs use a product owned outside them', v_orphan; END IF;
  IF v_logins <> 6 THEN RAISE EXCEPTION 'dev_demo: % of 6 accounts have a password', v_logins; END IF;
END $$;

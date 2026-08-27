-- ============================================================================
-- supabase/dev_demo.sql — the demo cast.
--
-- *** LOCAL DEVELOPMENT ONLY. NEVER RUN THIS AGAINST A HOSTED PROJECT. ***
-- It sets a single, publicly-known password on two accounts.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS FOR, AND WHY IT IS NOT IN `seed.sql`.
--
-- Migrations 0019-0021 built a permission model whose whole point is that a
-- SITE ADMIN runs one plant and provably nothing else. Before this file, that
-- model could not be seen in the running app at all: org 1 has ONE plant, and
-- every seeded person is either the company admin (who reaches everything, so
-- no rule applies to them) or a plain supervisor (who cannot open the admin
-- screen). There was nobody to sign in as and nothing to be excluded from.
--
-- ⛔ AND IT CANNOT GO IN THE SEED. MEASURED, not assumed: adding a second
-- plant to `seed.sql` and running the suite turns **8 test files and ~18
-- named cases red**, and the failures are not incidental. A whole family of
-- existing cases is built on the premise that org 1 holds exactly one
-- structure -- `90_hierarchy_template_test.sql`'s T32 exists precisely to
-- assert that an omitted `p_template_id` RESOLVES when there is only one, and
-- that path stops being reachable the moment a second plant exists. The
-- seed's one-plant shape is load-bearing for the suite, so the demo data
-- lives beside it rather than inside it.
--
-- ----------------------------------------------------------------------------
-- HOW TO RUN IT. After `npm run db:reset` (which wipes it, every time):
--
-- EASIEST, nothing to install: open Supabase Studio at
-- http://127.0.0.1:54323, click SQL Editor, and paste THIS WHOLE FILE in.
-- Studio ships with `supabase start`. Success is silent; the assertions at
-- the bottom raise an exception if anything is wrong.
--
-- Or from a shell, if you have a real psql:
--
--     psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--          -f supabase/dev_demo.sql
--
-- ⚠️ `postgresql-client-common` is NOT enough -- it installs the `psql`
-- WRAPPER and no client, so the wrapper reports "You must install at least
-- one postgresql-client-<version> package". The package you want is
-- `postgresql-client` (the metapackage), which pulls a real one in.
--
-- Idempotent by construction: re-running it builds no second Plant 2 and
-- duplicates no grant.
--
-- ----------------------------------------------------------------------------
-- THE CAST, and what each one demonstrates:
--
--   Dana   dana@example.test    org-wide VIEWER, admin grant on Plant 1
--   Quinn  quinn@example.test   org-wide VIEWER, admin grant on Plant 2
--
-- ⭐ BOTH ARE ORG-WIDE `viewer` ON PURPOSE. If either held the org-wide
-- `admin` role, `app_is_admin()` would short-circuit the first branch of
-- every predicate the site-instance model turns on, and they would
-- demonstrate nothing. Their entire authority comes from the grant. This is
-- the same property `46_`, `47_` and `48_` all rest on.
--
-- Signed in as Dana you should see: the admin screen opens; the structure
-- picker offers ONE shape (Plant 1's, not Plant 2's); the Access tab lists
-- the whole company and lets you change access to Plant 1; and your own
-- admin row refuses to be removed. Switch to Quinn and every one of those
-- answers moves to Plant 2.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. ⭐ REFUSE TO RUN IF THESE IDS BELONG TO SOMEBODY ELSE.
--
-- THIS CHECK EXISTS BECAUSE THE FIRST VERSION OF THIS FILE DID REAL DAMAGE.
-- It used `...b1` and `...b2` for its two accounts. Those are not free: the
-- seed hands them to org 2's company admin and to Sofia. `ON CONFLICT (id) DO
-- NOTHING` therefore skipped the INSERT silently, the credentials UPDATE below
-- RENAMED both of org 2's accounts, and the profile INSERT hung a second,
-- org-1 profile off each of them.
--
-- The visible damage was two orgs' worth: `user_profiles_select` admits a row
-- on `user_id = auth.uid()`, so signing in returned TWO profiles, and the
-- client reads that with `.maybeSingle()` -- which ERRORS on more than one row.
-- The session ended up with no profile at all: no Admin link for anyone, and a
-- board that reported "you may not have a grant on any node" to a site admin
-- who had one.
--
-- I assumed those ids were free instead of looking. This block is the looking.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(u.id::text || ' is already ' || coalesce(u.email, '(no email)'), ', ')
    INTO v_bad
    FROM auth.users u
   WHERE u.id IN ('00000000-0000-0000-0000-00000000dec1',
                  '00000000-0000-0000-0000-00000000dec2')
     AND u.email IS DISTINCT FROM (CASE u.id
           WHEN '00000000-0000-0000-0000-00000000dec1'::uuid THEN 'dana@example.test'
           ELSE 'quinn@example.test' END);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'dev_demo refuses to run: %. Run `npm run db:reset` first.', v_bad;
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 1. Plant 2, built through the REAL RPCs as org 1's company admin.
--
-- Direct INSERTs would skip `create_node`'s copy-on-root-create (0020 §10)
-- and quietly recreate the shared-structure state that migration 0020 exists
-- to end -- the demo would then be showing the bug rather than the fix.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_p2 uuid; v_dept uuid; v_line uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM nodes
              WHERE org_id = '10000000-0000-0000-0000-000000000001'
                AND parent_id IS NULL AND name = 'Plant 2') THEN
    RAISE NOTICE 'dev_demo: Plant 2 already exists, skipping';
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_p2   := (create_node(NULL,   'Plant 2',     1, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept := (create_node(v_p2,   'Fabrication', 0)->>'id')::uuid;
  v_line := (create_node(v_dept, 'Weld Line',   0)->>'id')::uuid;
  PERFORM create_node(v_line, 'Weld Cell 1', 0);
  PERFORM create_node(v_line, 'Weld Cell 2', 1);
  RESET ROLE;
  RAISE NOTICE 'dev_demo: Plant 2 created with its own copy of the Standard Plant shape';
END $$;

-- ----------------------------------------------------------------------------
-- 2. The two people.
-- ----------------------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-00000000dec1', 'dana@example.test'),
  ('00000000-0000-0000-0000-00000000dec2', 'quinn@example.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
  ('dec00000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000dec1','viewer'),
  ('dec00000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000dec2','viewer')
ON CONFLICT (id) DO NOTHING;

INSERT INTO profile_grants (profile_id, node_id, org_id, role)
VALUES ('dec00000-0000-0000-0000-000000000001',
        '30000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000001', 'admin')
ON CONFLICT (profile_id, node_id) DO NOTHING;

INSERT INTO profile_grants (profile_id, node_id, org_id, role)
SELECT 'dec00000-0000-0000-0000-000000000002', n.id,
       '10000000-0000-0000-0000-000000000001', 'admin'
  FROM nodes n
 WHERE n.org_id = '10000000-0000-0000-0000-000000000001'
   AND n.parent_id IS NULL AND n.name = 'Plant 2'
ON CONFLICT (profile_id, node_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. Dev credentials, password `devpassword`.
--
-- ⚠️ THE COLUMN LIST BELOW WAS EXTRACTED PROGRAMMATICALLY FROM `seed.sql`'s
-- OWN GoTrue BLOCK, NOT RETYPED (verification rule 12). Four of these columns
-- -- confirmation_token, recovery_token, email_change_token_new, email_change
-- -- have no database default, and GoTrue scans them into non-nullable Go
-- strings: leave any one NULL and sign-in fails with the generic "Database
-- error querying schema" before the password is ever checked. That cost a
-- debugging session once already; seed.sql records it at length.
-- ----------------------------------------------------------------------------
UPDATE auth.users AS u SET
  email                       = v.email,
  encrypted_password          = crypt('devpassword', gen_salt('bf')),
  email_confirmed_at          = now(),
  aud                         = 'authenticated',
  role                        = 'authenticated',
  instance_id                 = '00000000-0000-0000-0000-000000000000',
  -- the four with no default (the actual bug)
  confirmation_token          = '',
  recovery_token              = '',
  email_change_token_new      = '',
  email_change                = '',
  -- these do default to '' on INSERT, but are set explicitly so the row is
  -- correct even if a future default changes
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
  ('00000000-0000-0000-0000-00000000dec2'::uuid, 'quinn@example.test')
) AS v(id, email)
WHERE u.id = v.id;

-- GoTrue also expects an identities row per email-password account; without
-- it the user exists but has no linked credential provider.
INSERT INTO auth.identities
  (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
SELECT
  u.id::text, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email,
                     'email_verified', true, 'phone_verified', false),
  'email', now(), now(), now()
FROM auth.users u
WHERE u.id IN ('00000000-0000-0000-0000-00000000dec1',
               '00000000-0000-0000-0000-00000000dec2')
-- ⚠️ NO CONFLICT TARGET, ON PURPOSE. `auth.identities`' unique constraint is
-- GoTrue's, not this project's, and it has been renamed and re-spanned across
-- GoTrue versions -- naming columns here would infer a constraint that may not
-- exist on the reader's Supabase and fail with a syntax-level error rather
-- than doing nothing. A bare DO NOTHING works against any of them, and this
-- file cannot be tested against a real Supabase from the design container.
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- 4. Assert the demo is what it claims to be, rather than hoping.
--
-- Every line here is a property the demo would be USELESS without, and each
-- one has been silently wrong at some point in this project's history: a site
-- admin who is secretly an org-wide admin proves nothing; two plants sharing
-- one structure is the bug 0020 fixed; a missing identities row means the
-- account exists and cannot sign in.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_roots int; v_tpls int; v_dana text; v_quinn text; v_ids int; v_orgroles int; v_dupes int;
BEGIN
  SELECT count(*) INTO v_roots FROM nodes
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND parent_id IS NULL;
  SELECT count(DISTINCT hl.template_id) INTO v_tpls
    FROM nodes n JOIN hierarchy_levels hl ON hl.id = n.level_id
   WHERE n.org_id = '10000000-0000-0000-0000-000000000001' AND n.parent_id IS NULL;
  SELECT n.name INTO v_dana FROM profile_grants pg JOIN nodes n ON n.id = pg.node_id
   WHERE pg.profile_id = 'dec00000-0000-0000-0000-000000000001' AND pg.role = 'admin';
  SELECT n.name INTO v_quinn FROM profile_grants pg JOIN nodes n ON n.id = pg.node_id
   WHERE pg.profile_id = 'dec00000-0000-0000-0000-000000000002' AND pg.role = 'admin';
  SELECT count(*) INTO v_ids FROM auth.identities
   WHERE user_id IN ('00000000-0000-0000-0000-00000000dec1','00000000-0000-0000-0000-00000000dec2');
  SELECT count(*) INTO v_orgroles FROM user_profiles
   WHERE id::text LIKE 'dec00000%' AND role <> 'viewer';

  IF v_roots <> 2 THEN RAISE EXCEPTION 'dev_demo: expected 2 plants in org 1, found %', v_roots; END IF;
  IF v_tpls <> 2 THEN RAISE EXCEPTION 'dev_demo: the two plants share a structure (% distinct)', v_tpls; END IF;
  IF v_dana IS DISTINCT FROM 'Plant 1' THEN RAISE EXCEPTION 'dev_demo: Dana administers %', v_dana; END IF;
  IF v_quinn IS DISTINCT FROM 'Plant 2' THEN RAISE EXCEPTION 'dev_demo: Quinn administers %', v_quinn; END IF;
  IF v_ids <> 2 THEN RAISE EXCEPTION 'dev_demo: % identity rows, both accounts need one to sign in', v_ids; END IF;
  IF v_orgroles <> 0 THEN RAISE EXCEPTION 'dev_demo: a demo site admin holds an org-wide role -- they would prove nothing'; END IF;

  -- ⭐ ONE PROFILE PER ACCOUNT, and this is the assertion whose absence let the
  -- id collision ship. `user_profiles` is unique on (org_id, user_id), NOT on
  -- user_id -- so one auth account may legally hold a profile in two orgs, and
  -- the client's `.maybeSingle()` throws the moment it does. Counting the
  -- demo's own rows would never have noticed; counting rows PER ACCOUNT does.
  SELECT count(*) INTO v_dupes FROM (
    SELECT user_id FROM user_profiles
     WHERE user_id IN ('00000000-0000-0000-0000-00000000dec1',
                       '00000000-0000-0000-0000-00000000dec2')
     GROUP BY user_id HAVING count(*) > 1
  ) d;
  IF v_dupes <> 0 THEN
    RAISE EXCEPTION 'dev_demo: % demo account(s) hold a profile in more than one org -- sign-in will return no profile at all', v_dupes;
  END IF;

  RAISE NOTICE 'dev_demo OK: 2 plants, 2 structures, Dana runs Plant 1, Quinn runs Plant 2, both org-wide viewers';
END $$;

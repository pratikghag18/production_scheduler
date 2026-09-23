-- ============================================================================
-- dev_demo_test.sql — R-D112, "the demo world is three generic plants with
-- everything owned." The suite case that requirement never had.
--
-- ⭐ WHY THIS FILE EXISTS, AND WHY IT IS THE ONLY TEST WITHOUT A NUMBER.
--
-- `supabase/dev_demo.sql` is the fixture the running app shows — three plants,
-- a line-scoped supervisor, the world every by-hand check starts from — and it
-- was on NO runner's path. The SQL suite builds from the migrations and
-- `seed.sql`; vitest never touches SQL. So migration 0044 dropped `runs.status`
-- while line 414 of the demo still named it, and nothing anywhere went red.
-- The file died part-way through the next `db:reset`, after the plants, people
-- and products and before the runs: a HALF-BUILT world, which on screen reads
-- as a product with no data rather than a fixture that did not finish
-- (DEF-0006). R-D112 carried `verified_by: []`, which is how that was possible.
--
-- ⛔ THE MISSING NUMBER IS LOAD-BEARING, NOT AN OVERSIGHT. `tester-run.mjs` and
-- `scripts/run-sql-test.sh` run every `NN_*.sql` in this directory against ONE
-- shared scratch database, in order, WITHOUT rebuilding between files. This
-- file's fixture is `dev_demo.sql`, which opens by DELETING org 1's seeded
-- content — and about eighteen cases across eight files rest on org 1 holding
-- exactly one structure (`config.toml` records that measurement; 90_'s T32 is
-- the sharp one). A number here would poison every file sorted after it, and
-- every later single-file run besides, because the scratch database is rebuilt
-- only on demand. So this file is deliberately unnumbered, in the same way the
-- `upgrade_*` files are, and is reached only through `run-sql-test.sh --demo`,
-- which builds `sql_demo_db` for it and drops it afterwards.
--
-- ⚠️ HALF THE TEST HAPPENS BEFORE THIS FILE IS READ. `--demo` applies
-- `dev_demo.sql` under `ON_ERROR_STOP=1`, so an error at any line fails the
-- mode. That is the half that catches DEF-0006's shape, because the demo's OWN
-- twelve assertions sit at its FOOT and a file that dies at line 414 never
-- reaches them — a fixture cannot grade homework it did not finish.
--
-- What is left for this file is the half those assertions do not make, asked
-- from OUTSIDE the fixture rather than by it: the SHAPE of the three plants,
-- the ASSIGNMENTS (the statement immediately after the one that broke, and the
-- one nothing counts), ANA'S SINGLE LINE, the kept "Standard Plant", and org 2.
-- Where a case does overlap an assertion the demo already makes it is on
-- purpose and says so — a fixture asserting itself and a suite asserting the
-- fixture are not the same evidence.
--
-- Read-only throughout; no transaction to roll back.
-- ============================================================================

\echo 'D0 GUARD: this is the demo world, not the seed one'
DO $$
DECLARE v_roots int; v_names text;
BEGIN
  -- Without this every case below could pass by measuring nothing, or the file
  -- could be run by hand against the wrong database and report a clean sweep of
  -- a world it never saw. `run-sql-test.sh --demo` builds the right one.
  SELECT count(*), string_agg(name, ',' ORDER BY name) INTO v_roots, v_names
    FROM nodes
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND parent_id IS NULL;
  IF v_roots = 3 AND v_names = 'Plant A,Plant B,Plant C'
  THEN RAISE NOTICE 'PASS D0';
  ELSE RAISE NOTICE 'FAIL D0: % roots (%) — dev_demo.sql was not applied to this database',
                    v_roots, coalesce(v_names, 'none'); END IF;
END $$;

\echo 'D1: three identically shaped plants — Plant / Area / Line / Cell'
DO $$
DECLARE r record; v_bad text := '';
BEGIN
  -- Not a count of 36 nodes (the demo asserts that itself) but the SHAPE, per
  -- plant and per depth. A world with 36 nodes arranged wrongly passes the
  -- demo's own assertion and fails this one, which is the point of asking from
  -- outside. Depth is `nlevel(path)`: plant 1, area 2, line 3, cell 4.
  FOR r IN
    SELECT root.name AS plant,
           count(*) FILTER (WHERE nlevel(n.path) = 2) AS areas,
           count(*) FILTER (WHERE nlevel(n.path) = 3) AS lines_,
           count(*) FILTER (WHERE nlevel(n.path) = 4) AS cells,
           count(*) FILTER (WHERE nlevel(n.path) > 4) AS deeper
      FROM nodes root
      JOIN nodes n
        ON n.org_id = root.org_id AND root.path @> n.path AND n.id <> root.id
     WHERE root.org_id = '10000000-0000-0000-0000-000000000001'
       AND root.parent_id IS NULL
     GROUP BY root.name
     ORDER BY root.name
  LOOP
    IF r.areas <> 2 OR r.lines_ <> 3 OR r.cells <> 6 OR r.deeper <> 0 THEN
      v_bad := v_bad || format('%s(areas=%s lines=%s cells=%s deeper=%s) ',
                               r.plant, r.areas, r.lines_, r.cells, r.deeper);
    END IF;
  END LOOP;
  IF v_bad = '' THEN RAISE NOTICE 'PASS D1';
  ELSE RAISE NOTICE 'FAIL D1: not 2 areas / 3 lines / 6 cells: %', v_bad; END IF;
END $$;

\echo 'D2: each plant is its own instance — one structure per plant, none shared'
DO $$
DECLARE v_plants int; v_templates int;
BEGIN
  -- `create_node` copies the structure on root create (0020 §10). Direct
  -- INSERTs would leave all three plants pointing at ONE template, and renaming
  -- a level in Plant A would rename it in B and C. Counting DISTINCT templates
  -- across the roots is how you tell the two builds apart afterwards.
  SELECT count(*), count(DISTINCT l.template_id) INTO v_plants, v_templates
    FROM nodes n
    JOIN hierarchy_levels l ON l.id = n.level_id
   WHERE n.org_id = '10000000-0000-0000-0000-000000000001' AND n.parent_id IS NULL;
  IF v_plants = 3 AND v_templates = 3 THEN RAISE NOTICE 'PASS D2';
  ELSE RAISE NOTICE 'FAIL D2: % plants over % structures, expected 3 and 3',
                    v_plants, v_templates; END IF;
END $$;

\echo 'D3: the empty "Standard Plant" is kept as what a new root copies'
DO $$
DECLARE v_site uuid; v_used int; v_levels int;
BEGIN
  -- It must still exist, still belong to no site, and still have its levels —
  -- an original stripped of those is a structure a new root would copy as
  -- nothing. `dev_demo.sql` clears the site link of every OTHER template before
  -- deleting nodes, so "site_node_id IS NULL" alone would not tell them apart;
  -- what marks the original is that no node uses it.
  SELECT t.site_node_id INTO v_site
    FROM hierarchy_templates t WHERE t.id = '21000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_used
    FROM nodes n JOIN hierarchy_levels l ON l.id = n.level_id
   WHERE l.template_id = '21000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_levels
    FROM hierarchy_levels WHERE template_id = '21000000-0000-0000-0000-000000000001';
  IF v_site IS NULL AND v_used = 0 AND v_levels > 0 THEN RAISE NOTICE 'PASS D3';
  ELSE RAISE NOTICE 'FAIL D3: site=% nodes_using=% levels=% (want NULL, 0, >0)',
                    coalesce(v_site::text, 'NULL'), v_used, v_levels; END IF;
END $$;

\echo 'D4: nothing is company-wide — every operator, skill and pattern is owned (D108)'
DO $$
DECLARE v_unowned int;
BEGIN
  -- Overlaps the demo's own v_unowned assertion deliberately: that one can only
  -- run if the file reached its foot, and DEF-0006 is the case where it did not.
  SELECT count(*) INTO v_unowned FROM (
    SELECT site_node_id FROM operators
     WHERE org_id = '10000000-0000-0000-0000-000000000001'
    UNION ALL
    SELECT site_node_id FROM skills
     WHERE org_id = '10000000-0000-0000-0000-000000000001'
    UNION ALL
    SELECT site_node_id FROM shift_templates
     WHERE org_id = '10000000-0000-0000-0000-000000000001'
  ) x WHERE site_node_id IS NULL;
  IF v_unowned = 0 THEN RAISE NOTICE 'PASS D4';
  ELSE RAISE NOTICE 'FAIL D4: % company-wide rows, expected 0', v_unowned; END IF;
END $$;

\echo 'D5: ownership is a scope at any level — six or more rows owned BELOW a root (D109)'
DO $$
DECLARE v_narrow int;
BEGIN
  -- A world where everything is owned by a whole plant satisfies D4 and
  -- demonstrates nothing. These are the rows that prove "offered on Line 1 and
  -- nowhere else" is a state the app can even reach.
  SELECT count(*) INTO v_narrow
    FROM product_sites ps JOIN nodes n ON n.id = ps.node_id
   WHERE ps.org_id = '10000000-0000-0000-0000-000000000001'
     AND n.parent_id IS NOT NULL;
  IF v_narrow >= 6 THEN RAISE NOTICE 'PASS D5';
  ELSE RAISE NOTICE 'FAIL D5: only % product places below a root, expected >= 6', v_narrow; END IF;
END $$;

\echo 'D6 ⭐ THE WORLD REACHES ITS RUNS AND THEIR ASSIGNMENTS (DEF-0006)'
DO $$
DECLARE v_runs int; v_asg int; v_runless int; v_cells int;
BEGIN
  -- ⭐ THIS IS THE CASE THE DEFECT IS ABOUT. The demo counts its runs at the
  -- foot and counts its assignments NOWHERE — and the INSERT that broke was the
  -- statement immediately before them, so both were missing together and only
  -- one of them was ever going to be noticed. A board with runs and nobody on
  -- them looks as wrong as an empty one and is a different bug, so they are
  -- counted apart and then joined.
  SELECT count(*) INTO v_runs
    FROM runs WHERE org_id = '10000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_asg
    FROM assignments WHERE org_id = '10000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_runless
    FROM runs r
   WHERE r.org_id = '10000000-0000-0000-0000-000000000001'
     AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.run_id = r.id);
  -- and they are spread over the world rather than piled on one cell: three
  -- plants x four cells. A total of 84 on a single cell passes a bare count.
  SELECT count(DISTINCT node_id) INTO v_cells
    FROM runs WHERE org_id = '10000000-0000-0000-0000-000000000001';
  IF v_runs = 84 AND v_asg = 84 AND v_runless = 0 AND v_cells = 12
  THEN RAISE NOTICE 'PASS D6';
  ELSE RAISE NOTICE 'FAIL D6: runs=% (want 84) assignments=% (want 84) runs_with_nobody=% (want 0) cells=% (want 12)',
                    v_runs, v_asg, v_runless, v_cells; END IF;
END $$;

\echo 'D7: no run uses a product offered outside the plant it runs in'
DO $$
DECLARE v_orphan int;
BEGIN
  -- The invariant 0028/0034 exists for, over the whole demo world. R-D112 names
  -- it, and it is the one the runs loop could get wrong quietly — an
  -- `not_offered_here` refusal is loud, a run pointed at the wrong plant's part
  -- is not.
  SELECT count(*) INTO v_orphan
    FROM runs r
   WHERE r.org_id = '10000000-0000-0000-0000-000000000001'
     AND NOT EXISTS (
       SELECT 1 FROM product_sites ps
         JOIN nodes po ON po.id = ps.node_id
         JOIN nodes rn ON rn.id = r.node_id
        WHERE ps.product_id = r.product_id AND po.path @> rn.path);
  IF v_orphan = 0 THEN RAISE NOTICE 'PASS D7';
  ELSE RAISE NOTICE 'FAIL D7: % runs use a product owned outside them', v_orphan; END IF;
END $$;

\echo 'D8 ⭐ ANA IS GRANTED ONE LINE, NOT A PLANT'
DO $$
DECLARE v_grants int; v_depth int; v_role text; v_plant text;
BEGIN
  -- ⭐ R-D112 names this and NOTHING checked it — the demo's own assertions
  -- count passwords, not grants. Hers is the row D107's read rule is
  -- demonstrated with in both directions: she must still see Plant A's
  -- plant-wide parts (owner ABOVE her grant) and none of Plant B's. Granted a
  -- whole plant by accident, the app still works and the rule is simply no
  -- longer on display anywhere.
  SELECT count(*) INTO v_grants
    FROM profile_grants WHERE profile_id = 'a0000000-0000-0000-0000-000000000002';
  SELECT nlevel(n.path), g.role, root.name INTO v_depth, v_role, v_plant
    FROM profile_grants g
    JOIN nodes n ON n.id = g.node_id
    JOIN nodes root
      ON root.org_id = n.org_id AND root.parent_id IS NULL AND root.path @> n.path
   WHERE g.profile_id = 'a0000000-0000-0000-0000-000000000002';
  -- depth 3 is a Line; depth 1 would be the whole plant.
  IF v_grants = 1 AND v_depth = 3 AND v_role = 'supervisor' AND v_plant = 'Plant A'
  THEN RAISE NOTICE 'PASS D8';
  ELSE RAISE NOTICE 'FAIL D8: % grants, depth=% role=% plant=% (want 1, 3, supervisor, Plant A)',
                    v_grants, coalesce(v_depth::text, '-'), coalesce(v_role, '-'),
                    coalesce(v_plant, '-'); END IF;
END $$;

\echo 'D9: the six demo accounts can all sign in'
DO $$
DECLARE v_logins int;
BEGIN
  SELECT count(*) INTO v_logins FROM auth.users
   WHERE email IN ('admin@example.test', 'dana@example.test', 'quinn@example.test',
                   'rosa@example.test', 'ana@example.test', 'marco@example.test',
                   'viva@example.test', 'vito@example.test', 'vina@example.test')
     AND encrypted_password IS NOT NULL;
  IF v_logins = 9 THEN RAISE NOTICE 'PASS D9';
  ELSE RAISE NOTICE 'FAIL D9: % of 9 accounts have a password', v_logins; END IF;
END $$;

\echo 'D10: org 2 (Contoso) is untouched — it is the cross-tenant fixture'
DO $$
DECLARE v_nodes int;
BEGIN
  -- `dev_demo.sql` says it does not touch org 2 and `80_cross_org_test.sql`
  -- depends on that. A DELETE that lost its `org_id` predicate would empty it
  -- and nothing in this directory would notice, because 80_ runs against the
  -- OTHER database, where the demo never ran.
  SELECT count(*) INTO v_nodes
    FROM nodes WHERE org_id = '10000000-0000-0000-0000-000000000002';
  IF v_nodes > 0 THEN RAISE NOTICE 'PASS D10';
  ELSE RAISE NOTICE 'FAIL D10: org 2 has no nodes left — dev_demo reached across orgs'; END IF;
END $$;

\echo 'D11: Plant A''s six people carry real names, in the seed itself (R-423, DEF-0034)'
DO $$
DECLARE v_named int; v_placeholder int;
BEGIN
  -- The rename used to be a script no automated path ran, so a fresh stack
  -- kept "Operator A1".."Operator A6" and e2e/linePeople + e2e/viewerBoard
  -- failed (DEF-0034). The maintainer, 21 Sept: put the real names in the
  -- seed. This asks both directions: the six real names are on the six EMP
  -- refs, and no "Operator A#" placeholder survives anywhere in the org.
  -- Pairwise (ref, name), so two people swapped cannot pass as six named rows.
  SELECT count(*) INTO v_named
    FROM operators o
    JOIN (VALUES ('EMP-1001', 'Sam Patel'),   ('EMP-1002', 'Maria Lopez'),
                 ('EMP-1003', 'John Kim'),    ('EMP-1004', 'Priya Shah'),
                 ('EMP-1005', 'Tom Baker'),   ('EMP-1006', 'Lena Novak')) AS want(ref, name)
      ON want.ref = o.employee_ref AND want.name = o.display_name
   WHERE o.org_id = '10000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_placeholder FROM operators
   WHERE org_id = '10000000-0000-0000-0000-000000000001'
     AND display_name ~ '^Operator A[1-6]$';
  IF v_named = 6 AND v_placeholder = 0 THEN RAISE NOTICE 'PASS D11';
  ELSE RAISE NOTICE 'FAIL D11: % of 6 EMP-100x rows carry the real name, % Operator A# placeholders remain (want 6, 0)',
                    v_named, v_placeholder; END IF;
END $$;

\echo 'D12: every demo person has a home shift, the line-owned one included (R-441, F-187)'
DO $$
DECLARE v_shiftless int; v_line_owned int;
BEGIN
  -- The shift pick used to join the pattern on the person's OWN site, so the
  -- one person per plant owned at Line 1 (EMP-x001) got no shift at all and
  -- the rail read "No shift" for the walk's own person. Both directions: nobody
  -- is shiftless, and the line-owned people in particular carry one.
  SELECT count(*) INTO v_shiftless FROM operators
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND home_shift_id IS NULL;
  SELECT count(*) INTO v_line_owned FROM operators o
    JOIN nodes n ON n.id = o.site_node_id
   WHERE o.org_id = '10000000-0000-0000-0000-000000000001'
     AND n.parent_id IS NOT NULL AND o.home_shift_id IS NOT NULL;
  IF v_shiftless = 0 AND v_line_owned = 3 THEN RAISE NOTICE 'PASS D12';
  ELSE RAISE NOTICE 'FAIL D12: % people with no home shift (want 0), % line-owned people with one (want 3)',
                    v_shiftless, v_line_owned; END IF;
END $$;

\echo 'D13: the demo plant is in Chicago and each seeded block starts at its own operator''s home-shift minute (R-450, R-452, F-190)'
DO $$
DECLARE v_zone text; v_plant uuid; v_rows int; v_at_band int;
BEGIN
  -- The zone half is unchanged from F-190: the zone every plant resolves to
  -- after a reset. The hour half is now R-452's promise, not a fixed 06:00 --
  -- each seeded block starts at its OWN OPERATOR'S home-shift start_min, in
  -- that zone. A fixed Shift-1 window (the old seed) would fail the band half
  -- for anyone hashed onto Shift 2 or 3 (R-441) even though the zone half
  -- still passed.
  --
  -- The length half that used to live here (elapsed minutes = end_min -
  -- start_min) is DROPPED, not fixed in place: `extract(epoch FROM (upper -
  -- lower))` counts real elapsed minutes, which is wrong on a DST-changeover
  -- Saturday -- Shift 3 (22:00-06:00 Chicago) is 420 elapsed minutes in
  -- March and 540 in November while the seed is correct either way, so this
  -- case would FAIL a seed that had nothing wrong with it. D14 below already
  -- pins the band's upper edge too, by reconstructing it wall-clock (the same
  -- naive-then-AT-TIME-ZONE arithmetic the seed itself uses, not elapsed
  -- time), so the length check belongs there and only there.
  SELECT n.id INTO v_plant FROM nodes n
   WHERE n.org_id = '10000000-0000-0000-0000-000000000001' AND n.parent_id IS NULL AND n.name LIKE 'Plant A%';
  v_zone := app_resolve_node_setting(v_plant, 'timezone');
  SELECT count(*),
         count(*) FILTER (
           WHERE (extract(hour   FROM lower(a.timerange) AT TIME ZONE 'America/Chicago') * 60
                + extract(minute FROM lower(a.timerange) AT TIME ZONE 'America/Chicago'))::int = s.start_min
         )
    INTO v_rows, v_at_band
    FROM assignments a
    JOIN operators o ON o.id = a.operator_id
    JOIN shifts s ON s.id = o.home_shift_id
   WHERE a.org_id = '10000000-0000-0000-0000-000000000001';
  IF v_zone = 'America/Chicago' AND v_rows > 0 AND v_at_band = v_rows THEN RAISE NOTICE 'PASS D13';
  ELSE RAISE NOTICE 'FAIL D13: Plant A resolves to % (want America/Chicago); % of % seeded blocks start at their operator''s home-shift minute',
                    coalesce(v_zone, '(none)'), v_at_band, v_rows; END IF;
END $$;

\echo 'D14: no seeded assignment carries a minute of overtime outside its own operator''s home band (R-452)'
DO $$
DECLARE v_rows int; v_ot int;
BEGIN
  -- Recomputes, from the same assignment/operator/shift rows D13 reads but by
  -- a different route (rebuilding the band's own tstzrange from the
  -- assignment's local start day, rather than comparing minute-of-day), how
  -- much of each seeded range falls outside its operator's home band -- the
  -- same shape of question `overtimeMinutes()` asks on the board. Zero here
  -- is what R-452 promises; the old fixed 06:00-14:00 seed would show
  -- overtime on every block for a person hashed onto Shift 2 or 3.
  WITH bands AS (
    SELECT a.id, a.timerange,
           (date_trunc('day', lower(a.timerange) AT TIME ZONE 'America/Chicago')
             + (s.start_min || ' minutes')::interval) AT TIME ZONE 'America/Chicago' AS band_from,
           (date_trunc('day', lower(a.timerange) AT TIME ZONE 'America/Chicago')
             + (s.end_min   || ' minutes')::interval) AT TIME ZONE 'America/Chicago' AS band_to
      FROM assignments a
      JOIN operators o ON o.id = a.operator_id
      JOIN shifts s ON s.id = o.home_shift_id
     WHERE a.org_id = '10000000-0000-0000-0000-000000000001'
  )
  SELECT count(*),
         count(*) FILTER (WHERE lower(timerange) < band_from OR upper(timerange) > band_to)
    INTO v_rows, v_ot
    FROM bands;
  IF v_rows > 0 AND v_ot = 0 THEN RAISE NOTICE 'PASS D14';
  ELSE RAISE NOTICE 'FAIL D14: % of % seeded blocks have a minute outside their operator''s home band (want 0)',
                    v_ot, v_rows; END IF;
END $$;

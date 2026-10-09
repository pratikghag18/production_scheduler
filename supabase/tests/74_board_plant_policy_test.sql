-- ============================================================================
-- 74_board_plant_policy_test.sql — migration 0051, "the BOARD asks the plant,
-- not the company." (R-331, continued)
--
-- WHAT 0050 LEFT HALF DONE. 0050 made `eligibility_policy` resolvable per node
-- on the server: `check_eligibility`, `move_run`, `create_assignment` and
-- `apply_split_coverage` all read it through `app_resolve_node_setting` now, so
-- a plant set to `block` really is blocked. THE BOARD DID NOT KNOW.
-- `board_window` sent `org.settings` and nothing else, `boardIndex.ts` read
-- `eligibility_policy` out of that ONE bag, and `CreatePopover` applied the same
-- company-wide answer to every cell on the screen. On a plant set to `block`
-- the popover therefore offered an OVERRIDE TICK, the planner filled in a
-- reason, pressed Create, and the server refused it. A dead end -- exactly the
-- shape of F-087, which 0048 fixed for certificates the same day.
--
-- ⛔ AND THE OBVIOUS FIX IS THE WRONG ONE, WHICH IS WHY THIS FILE'S HEADLINE IS
-- A SUPERVISOR AND NOT AN ADMIN. Sending the raw `node_settings` rows and
-- resolving the ancestry in the browser FAILS OPEN. `board_window` is SECURITY
-- INVOKER and `node_settings_select` is gated on `app_can_read_node`, so a
-- supervisor granted a LINE never receives the row sitting on the PLANT ROOT
-- they cannot read. Their board would fall through to the company's `warn` and
-- offer overrides on a plant somebody deliberately set to `block` -- the safety
-- rule failing open for precisely the people who schedule against it all day,
-- which is the defect 0023 fixed inside `check_eligibility` and 0050's §3
-- header re-states at length.
--
-- ⭐⭐ SO N5 IS THE CASE THIS FILE EXISTS FOR, AND N5b IS THE HALF THAT MAKES IT
-- MEAN SOMETHING. N5b measures that Ana, a supervisor granted
-- `plant_1.assembly`, can read ZERO rows of `node_settings` and cannot see the
-- plant root at all -- so a browser-side resolver would have NOTHING to resolve
-- FROM. N5 then measures that her payload nevertheless carries `block` on every
-- cell, because `app_resolve_node_setting` is SECURITY DEFINER and the walk
-- happens on the server. ⚠️ A CASE THAT ONLY DROVE THE COMPANY ADMIN WOULD PASS
-- AGAINST THE BROKEN VERSION: a1 holds a grant on `plant_1` itself, reads the
-- override row, and resolves it correctly in the browser or anywhere else.
--
-- ⚠️ ONE PAYLOAD SPANS ONE PLANT, so "two plants, two answers, one payload" is
-- split in two here and both halves are asserted:
--   N3 -- two BRANCHES of one plant under different policies, in ONE payload.
--         This is the case a per-payload scalar cannot pass however it is
--         computed, and it is what forces the answer to be a per-node MAP.
--   N4 -- two PLANTS under different policies, one payload each, as the
--         maintainer described it. `board_window(p_root_path)` keeps
--         `n.path <@ p_root_path`, and `plant_1` and `plant_2` are separate
--         ltree roots with no common ancestor, so no single call can cover
--         both; the board opens one root at a time (`visible_board_roots`).
--
-- N7 is the E7 of this file: over a matrix of override placements, and for BOTH
-- roles, the policy the payload carries for a node is compared node by node with
-- the `policy` `check_eligibility` returns for that same node. A payload the
-- client cannot reach the server's own answer from fails N7 even when every
-- other case is green.
--
-- ⚠️ AS `authenticated` EVERYWHERE. `board_window` is SECURITY INVOKER, psql
-- connects as the superuser, who bypasses RLS entirely and whose
-- `app_current_org()` is NULL -- a case that forgets this measures nothing.
--
-- FIXTURE (built before the first savepoint, so no ROLLBACK TO reaches it):
--
--   plant_1                      30000000-...-0001  the seed's only plant
--     .assembly                  30000000-...-0002  Ana's grant, and hers alone
--       .line_1                  30000000-...-0004
--         .cell_1                30000000-...-0007
--       .line_2                  30000000-...-0005
--         .cell_4               3000000a-...-000a
--     .machining                 30000000-...-0003  Marco's grant
--       .cnc_line                30000000-...-0006
--         .cell_6               3000000a-...-000c
--   plant_2                      p_fix 'p2'         built through the real RPCs
--     .fabrication ... .weld_cell                   as 47 and 73 do
--
--   Elena  50000000-...-0004  holds NO training at all (so `check_eligibility`
--                             has something to be ineligible about)
--   a1     ...a1  company admin, granted plant_1
--   a2     ...a2  Ana, org-wide supervisor, granted plant_1.assembly ONLY
--
-- Everything is inside one BEGIN/ROLLBACK; each case is savepointed.
-- ============================================================================

BEGIN;

-- ⚠️ The GRANT is not decoration: half the cases read this table while
-- `SET LOCAL ROLE authenticated` is in force, and a temp table created by the
-- superuser is not readable by that role (73's own first red run said so).
CREATE TEMP TABLE p_fix (k text primary key, v uuid);
GRANT SELECT ON p_fix TO PUBLIC;

-- CNC is required at `plant_1.machining.cnc_line` by the seed and nowhere in
-- Assembly. Requiring it at `plant_1.assembly` TOO is what makes N5 a real
-- case rather than a string comparison: Ana's own cells then hold somebody the
-- server actually refuses, so "the payload says block" and "the server says
-- block AND not eligible" are asserted about the same person at the same cell.
-- Same device 73 uses, for the same reason.
INSERT INTO node_skill_requirements (node_id, skill_id, org_id)
VALUES ('30000000-0000-0000-0000-000000000002',
        '40000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000001');

DO $$
DECLARE v_p2 uuid; v_dept uuid; v_line uuid; v_cell uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_p2   := (create_node(NULL, 'Plant 2', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept := (create_node(v_p2,   'Fabrication', 0)->>'id')::uuid;
  v_line := (create_node(v_dept, 'Weld Line',   0)->>'id')::uuid;
  v_cell := (create_node(v_line, 'Weld Cell',   0)->>'id')::uuid;
  RESET ROLE;
  INSERT INTO p_fix (k, v) VALUES
    ('p2', v_p2), ('p2_dept', v_dept), ('p2_line', v_line), ('p2_cell', v_cell);
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- Helpers. `payload` fetches `board_window` AS a named person, with RLS in
-- force; `policy_of` and `policies` read ONLY the payload -- no table, no
-- `app_resolve_node_setting`, no `node_settings`. That restriction is the point:
-- these are the client, and what they cannot answer the client cannot answer.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.payload(p_user uuid, p_root ltree) RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  SET LOCAL ROLE authenticated;
  v := board_window(p_root, timestamptz '2026-10-01 00:00+00', timestamptz '2026-10-03 00:00+00');
  RESET ROLE;
  RETURN v;
END $fn$;

-- The one lookup `BoardPage` makes when it opens a popover on a cell.
CREATE FUNCTION pg_temp.policy_of(p_payload jsonb, p_node uuid) RETURNS text
LANGUAGE sql STABLE AS $fn$
  SELECT e->>'eligibility_policy'
  FROM jsonb_array_elements(p_payload->'node_policies') e
  WHERE (e->>'node_id')::uuid = p_node;
$fn$;

-- How many DISTINCT answers one payload carries, and which.
CREATE FUNCTION pg_temp.policies(p_payload jsonb) RETURNS text
LANGUAGE sql STABLE AS $fn$
  SELECT COALESCE(string_agg(DISTINCT e->>'eligibility_policy', ',' ORDER BY e->>'eligibility_policy'), '')
  FROM jsonb_array_elements(p_payload->'node_policies') e;
$fn$;

\echo 'N0 GUARD: the world every case below rests on'
SAVEPOINT sp_N0;
DO $$
DECLARE v_roots int; v_org text; v_a2 text; v_grant text; v_overrides int; v_elena int;
BEGIN
  SELECT count(*) INTO v_roots FROM nodes
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND parent_id IS NULL;
  SELECT settings->>'eligibility_policy' INTO v_org
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  SELECT role INTO v_a2 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a2';
  SELECT n.path::text INTO v_grant FROM profile_grants pg
    JOIN nodes n ON n.id = pg.node_id
   WHERE pg.profile_id = 'a0000000-0000-0000-0000-000000000002';
  SELECT count(*) INTO v_overrides FROM node_settings;
  SELECT count(*) INTO v_elena FROM operator_skills
   WHERE operator_id = '50000000-0000-0000-0000-000000000004';
  -- No override may exist yet, anywhere: this whole file measures the
  -- difference one makes, and a stray row would make N2 meaningless.
  IF v_roots = 2 AND v_org = 'warn' AND v_a2 = 'supervisor'
     AND v_grant = 'plant_1.assembly' AND v_overrides = 0 AND v_elena = 0
  THEN RAISE NOTICE 'PASS N0';
  ELSE RAISE NOTICE 'FAIL N0: roots=% org=% a2=% grant=% overrides=% elena_skills=%',
    v_roots, v_org, v_a2, v_grant, v_overrides, v_elena; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL N0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N0;

\echo 'N1 the key exists and answers for EVERY node the payload sends -- one entry per node, no more'
SAVEPOINT sp_N1;
DO $$
DECLARE v_pay jsonb; v_nodes int; v_pol int; v_matched int; v_bad int;
BEGIN
  v_pay := pg_temp.payload('00000000-0000-0000-0000-0000000000a1', 'plant_1'::ltree);
  SELECT count(*) INTO v_nodes FROM jsonb_array_elements(v_pay->'nodes');
  SELECT count(*) INTO v_pol FROM jsonb_array_elements(v_pay->'node_policies');
  -- ⚠️ A node with no entry is a cell the client cannot decide about. It must
  -- not happen, and the client's fallback for it is the STRICT answer, not the
  -- company's -- see `policyForNode` in boardIndex.ts.
  SELECT count(*) INTO v_matched
    FROM jsonb_array_elements(v_pay->'nodes') n
    JOIN jsonb_array_elements(v_pay->'node_policies') p
      ON (p->>'node_id') = (n->>'id');
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_pay->'node_policies') p
   WHERE p->>'eligibility_policy' NOT IN ('warn', 'block');
  IF v_nodes = 13 AND v_pol = 13 AND v_matched = 13 AND v_bad = 0
  THEN RAISE NOTICE 'PASS N1 (% nodes, % policies)', v_nodes, v_pol;
  ELSE RAISE NOTICE 'FAIL N1: nodes=% (want 13) policies=% matched=% bad_values=%',
    v_nodes, v_pol, v_matched, v_bad; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL N1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N1;

\echo 'N2 ✅ UNCHANGED BEHAVIOUR: with no override anywhere every node carries the company''s answer'
SAVEPOINT sp_N2;
DO $$
DECLARE v_pay jsonb; v_distinct text;
BEGIN
  v_pay := pg_temp.payload('00000000-0000-0000-0000-0000000000a1', 'plant_1'::ltree);
  v_distinct := pg_temp.policies(v_pay);
  -- The org is 'warn' (N0). Yesterday's board is today's board when nobody has
  -- overridden anything -- without this, a green N3 could be a payload that
  -- simply became stricter for everybody.
  IF v_distinct = 'warn'
  THEN RAISE NOTICE 'PASS N2';
  ELSE RAISE NOTICE 'FAIL N2: distinct policies in payload = [%] (want warn)', v_distinct; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL N2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N2;

\echo 'N3 ⭐ ONE PAYLOAD, TWO ANSWERS: a plant set to block with one department left on warn'
SAVEPOINT sp_N3;
DO $$
DECLARE v_pay jsonb; v_cell1 text; v_cell4 text; v_cell6 text; v_plant text; v_mach text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000003', 'eligibility_policy', 'warn');
  RESET ROLE;
  v_pay  := pg_temp.payload('00000000-0000-0000-0000-0000000000a1', 'plant_1'::ltree);
  v_plant := pg_temp.policy_of(v_pay, '30000000-0000-0000-0000-000000000001');
  v_mach  := pg_temp.policy_of(v_pay, '30000000-0000-0000-0000-000000000003');
  v_cell1 := pg_temp.policy_of(v_pay, '30000000-0000-0000-0000-000000000007'); -- assembly.line_1.cell_1
  v_cell4 := pg_temp.policy_of(v_pay, '3000000a-0000-0000-0000-00000000000a'); -- assembly.line_2.cell_4
  v_cell6 := pg_temp.policy_of(v_pay, '3000000a-0000-0000-0000-00000000000c'); -- machining.cnc_line.cell_6
  -- ⛔ THE CASE A SINGLE SCALAR CANNOT PASS. Cell 1 and Cell 6 are on the same
  -- board, in the same payload, in the same company -- and the popover must
  -- refuse an ineligible person on one and offer an override on the other.
  IF v_plant = 'block' AND v_mach = 'warn'
     AND v_cell1 = 'block' AND v_cell4 = 'block' AND v_cell6 = 'warn'
     AND pg_temp.policies(v_pay) = 'block,warn'
  THEN RAISE NOTICE 'PASS N3';
  ELSE RAISE NOTICE 'FAIL N3: plant=% machining=% cell1=% cell4=% cell6=% distinct=[%]',
    v_plant, v_mach, v_cell1, v_cell4, v_cell6, pg_temp.policies(v_pay); END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL N3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N3;

\echo 'N4 ⭐ TWO PLANTS, TWO ANSWERS: the maintainer''s sentence, one board each'
SAVEPOINT sp_N4;
DO $$
DECLARE v_p1 jsonb; v_p2 jsonb; v_c1 text; v_c2 text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
  RESET ROLE;
  v_p1 := pg_temp.payload('00000000-0000-0000-0000-0000000000a1', 'plant_1'::ltree);
  v_p2 := pg_temp.payload('00000000-0000-0000-0000-0000000000a1',
                          (SELECT path FROM nodes WHERE id = (SELECT v FROM p_fix WHERE k = 'p2')));
  v_c1 := pg_temp.policy_of(v_p1, '30000000-0000-0000-0000-000000000007');
  v_c2 := pg_temp.policy_of(v_p2, (SELECT v FROM p_fix WHERE k = 'p2_cell'));
  -- Plant 1 is strict; Plant 2, which nobody overrode, still reads the
  -- company's 'warn'. One company, one screen, two rules.
  IF v_c1 = 'block' AND v_c2 = 'warn'
     AND pg_temp.policies(v_p1) = 'block' AND pg_temp.policies(v_p2) = 'warn'
  THEN RAISE NOTICE 'PASS N4';
  ELSE RAISE NOTICE 'FAIL N4: plant1_cell=% plant2_cell=% p1=[%] p2=[%]',
    v_c1, v_c2, pg_temp.policies(v_p1), pg_temp.policies(v_p2); END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL N4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N4;

\echo 'N5b ⛔ THE GROUND N5 STANDS ON: a supervisor can see NEITHER the plant root NOR one override row'
SAVEPOINT sp_N5b;
DO $$
DECLARE v_roots int; v_rows int; v_own int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_roots FROM nodes WHERE id = '30000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_rows  FROM node_settings;
  SELECT count(*) INTO v_own   FROM nodes WHERE id = '30000000-0000-0000-0000-000000000002';
  RESET ROLE;
  -- ⭐ THIS IS THE WHOLE ARGUMENT FOR RESOLVING ON THE SERVER. Ana sees her own
  -- department fine (v_own = 1) and cannot see the plant root or the row on it
  -- (both 0). A browser given `node_settings` and told to walk the ancestry
  -- would find nothing here and fall through to the company's 'warn' -- and N5
  -- is what says the board does not.
  IF v_roots = 0 AND v_rows = 0 AND v_own = 1
  THEN RAISE NOTICE 'PASS N5b';
  ELSE RAISE NOTICE 'FAIL N5b: readable_plant_root=% (want 0) readable_overrides=% (want 0) readable_own_dept=% (want 1)',
    v_roots, v_rows, v_own; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL N5b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N5b;

\echo 'N5 ⭐⭐ THE CASE THIS FILE EXISTS FOR: the supervisor''s own board carries the plant''s block'
SAVEPOINT sp_N5;
DO $$
DECLARE v_pay jsonb; v_cell1 text; v_cell4 text; v_distinct text; v_n int; v_srv jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
  RESET ROLE;

  -- Ana's board: rooted at the ONLY place she may open, one level BELOW the
  -- node carrying the override.
  v_pay := pg_temp.payload('00000000-0000-0000-0000-0000000000a2', 'plant_1.assembly'::ltree);
  SELECT count(*) INTO v_n FROM jsonb_array_elements(v_pay->'node_policies');
  v_cell1   := pg_temp.policy_of(v_pay, '30000000-0000-0000-0000-000000000007');
  v_cell4   := pg_temp.policy_of(v_pay, '3000000a-0000-0000-0000-00000000000a');
  v_distinct := pg_temp.policies(v_pay);

  -- ...and the server's own answer for the same cell, asked as Ana, so the two
  -- are the SAME question and not merely two things that both say 'block'.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_srv := check_eligibility('30000000-0000-0000-0000-000000000007',
                             '50000000-0000-0000-0000-000000000004',
                             tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-01 14:00+00'));
  RESET ROLE;

  -- 8 nodes under and including plant_1.assembly. Every one of them 'block',
  -- inherited from a node Ana cannot read.
  IF v_n = 8 AND v_cell1 = 'block' AND v_cell4 = 'block' AND v_distinct = 'block'
     AND v_srv->>'policy' = 'block' AND (v_srv->>'eligible') = 'false'
  THEN RAISE NOTICE 'PASS N5';
  ELSE RAISE NOTICE 'FAIL N5: entries=% (want 8) cell1=% cell4=% distinct=[%] server_policy=% eligible=%',
    v_n, v_cell1, v_cell4, v_distinct, v_srv->>'policy', v_srv->>'eligible'; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL N5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N5;

\echo 'N6 NEAREST WINS, and the supervisor sees the split inside her own department'
SAVEPOINT sp_N6;
DO $$
DECLARE v_pay jsonb; v_l1 text; v_c1 text; v_c4 text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000004', 'eligibility_policy', 'warn'); -- line_1
  RESET ROLE;
  v_pay := pg_temp.payload('00000000-0000-0000-0000-0000000000a2', 'plant_1.assembly'::ltree);
  v_l1 := pg_temp.policy_of(v_pay, '30000000-0000-0000-0000-000000000004');
  v_c1 := pg_temp.policy_of(v_pay, '30000000-0000-0000-0000-000000000007'); -- under line_1
  v_c4 := pg_temp.policy_of(v_pay, '3000000a-0000-0000-0000-00000000000a'); -- under line_2
  -- A line's answer beats its plant's for its own cells and for nothing else.
  IF v_l1 = 'warn' AND v_c1 = 'warn' AND v_c4 = 'block'
  THEN RAISE NOTICE 'PASS N6';
  ELSE RAISE NOTICE 'FAIL N6: line_1=% cell_1=% cell_4=%', v_l1, v_c1, v_c4; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL N6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N6;

\echo 'N7 ⭐⭐ THE WHOLE POINT: over a matrix of overrides and BOTH roles, the payload equals check_eligibility node by node'
SAVEPOINT sp_N7;
DO $$
DECLARE
  v_pay jsonb; v_srv text; v_client text;
  v_case int; v_node uuid; v_user uuid; v_root ltree;
  v_checked int := 0; v_mismatch int := 0; v_warns int := 0; v_blocks int := 0;
  v_first text := '';
  v_win tstzrange := tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-01 14:00+00');
  v_users uuid[] := ARRAY['00000000-0000-0000-0000-0000000000a1',
                          '00000000-0000-0000-0000-0000000000a2']::uuid[];
  v_roots ltree[] := ARRAY['plant_1'::ltree, 'plant_1.assembly'::ltree]::ltree[];
  i int;
BEGIN
  -- Five worlds: nothing set; the plant strict; the plant strict with one
  -- department relaxed; a single line strict; the company itself flipped to
  -- 'block' with one plant relaxed (the inheritance running the other way).
  FOR v_case IN 1..5 LOOP
    PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
    SET LOCAL ROLE authenticated;
    DELETE FROM node_settings;
    UPDATE orgs SET settings = jsonb_set(settings, '{eligibility_policy}', '"warn"')
     WHERE id = '10000000-0000-0000-0000-000000000001';
    IF v_case = 2 THEN
      PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
    ELSIF v_case = 3 THEN
      PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
      PERFORM set_node_setting('30000000-0000-0000-0000-000000000002', 'eligibility_policy', 'warn');
    ELSIF v_case = 4 THEN
      PERFORM set_node_setting('30000000-0000-0000-0000-000000000004', 'eligibility_policy', 'block');
    ELSIF v_case = 5 THEN
      UPDATE orgs SET settings = jsonb_set(settings, '{eligibility_policy}', '"block"')
       WHERE id = '10000000-0000-0000-0000-000000000001';
      PERFORM set_node_setting('30000000-0000-0000-0000-000000000005', 'eligibility_policy', 'warn');
    END IF;
    RESET ROLE;

    FOR i IN 1..2 LOOP
      v_user := v_users[i];
      v_root := v_roots[i];
      v_pay  := pg_temp.payload(v_user, v_root);
      -- Every node the payload names, asked of the server as the same person.
      FOR v_node IN SELECT (e->>'id')::uuid FROM jsonb_array_elements(v_pay->'nodes') e LOOP
        v_client := pg_temp.policy_of(v_pay, v_node);
        PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
        SET LOCAL ROLE authenticated;
        v_srv := check_eligibility(v_node, '50000000-0000-0000-0000-000000000004', v_win)->>'policy';
        RESET ROLE;
        v_checked := v_checked + 1;
        IF v_srv = 'warn' THEN v_warns := v_warns + 1; ELSE v_blocks := v_blocks + 1; END IF;
        IF v_client IS DISTINCT FROM v_srv THEN
          v_mismatch := v_mismatch + 1;
          IF v_first = '' THEN
            v_first := format('case=%s user=%s node=%s server=%s payload=%s',
                              v_case, v_user, v_node, v_srv, coalesce(v_client, 'ABSENT'));
          END IF;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  -- ⚠️ THE TALLY IS PART OF THE ASSERTION: "no mismatches" is also what a
  -- payload that said 'warn' everywhere would report against a world that was
  -- never strict, so BOTH answers must actually occur.
  IF v_mismatch = 0 AND v_checked = 105 AND v_warns > 0 AND v_blocks > 0
  THEN RAISE NOTICE 'PASS N7 (% node/role pairs: % warn, % block, 0 disagreements)',
    v_checked, v_warns, v_blocks;
  ELSE RAISE NOTICE 'FAIL N7: checked=% mismatches=% warn=% block=% first=%',
    v_checked, v_mismatch, v_warns, v_blocks, v_first; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL N7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N7;

\echo 'N8 the rest of the payload is unchanged -- every other top-level key, and skill_expiries, still arrive'
SAVEPOINT sp_N8;
DO $$
DECLARE v_pay jsonb; v_missing text := ''; v_with_expiries int; v_ops int;
  v_keys text[] := ARRAY['org','levels','nodes','runs','assignments','operators','products',
                         'skills','node_skill_requirements','shift_templates','node_shift_map',
                         'cycle_times','node_policies'];
  k text;
BEGIN
  v_pay := pg_temp.payload('00000000-0000-0000-0000-0000000000a1', 'plant_1'::ltree);
  FOREACH k IN ARRAY v_keys LOOP
    IF NOT (v_pay ? k) THEN v_missing := v_missing || k || ' '; END IF;
  END LOOP;
  SELECT count(*) INTO v_ops FROM jsonb_array_elements(v_pay->'operators');
  -- 0048's key, added to this same function earlier today. Re-creating
  -- `board_window` in full to add ONE key is exactly how another gets dropped,
  -- so this case names the one most recently at risk.
  SELECT count(*) INTO v_with_expiries FROM jsonb_array_elements(v_pay->'operators') o
   WHERE jsonb_typeof(o->'skill_expiries') = 'array';
  IF v_missing = '' AND v_ops = 9 AND v_with_expiries = 9
     AND jsonb_typeof(v_pay->'products'->0->'offered_node_ids') = 'array'
     AND jsonb_typeof(v_pay->'shift_templates') = 'array'
  THEN RAISE NOTICE 'PASS N8';
  ELSE RAISE NOTICE 'FAIL N8: missing keys=[%] operators=% with_skill_expiries=% offered=%',
    v_missing, v_ops, v_with_expiries, jsonb_typeof(v_pay->'products'->0->'offered_node_ids'); END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL N8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N8;

\echo 'N9 another tenant''s override colours nothing here, and this one''s colours nothing there'
SAVEPOINT sp_N9;
DO $$
DECLARE v_pay jsonb; v_distinct text; v_b_nodes int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
  RESET ROLE;
  -- Org 2's own admin, org 2's own plant. `app_resolve_node_setting` reads the
  -- NODE's org, never `app_current_org()`, and org 2's bag is its own.
  v_pay := pg_temp.payload('00000000-0000-0000-0000-0000000000b1',
                           (SELECT path FROM nodes WHERE id = '3000000b-0000-0000-0000-000000000001'));
  SELECT count(*) INTO v_b_nodes FROM jsonb_array_elements(v_pay->'nodes');
  v_distinct := pg_temp.policies(v_pay);
  IF v_b_nodes > 0 AND v_distinct = 'warn'
  THEN RAISE NOTICE 'PASS N9';
  ELSE RAISE NOTICE 'FAIL N9: org2_nodes=% distinct=[%]', v_b_nodes, v_distinct; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL N9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N9;

ROLLBACK;

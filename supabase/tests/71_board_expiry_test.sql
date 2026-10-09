-- ============================================================================
-- 71_board_expiry_test.sql — migration 0048, "the board can tell a live
-- certificate from a lapsed one." (F-087)
--
-- THE DEFECT. `check_eligibility` has refused an operator whose certification
-- has run out since migration 0009: `expiring` is
-- `expires_at IS NOT NULL AND (upper_inf(p_timerange) OR expires_at <
-- upper(p_timerange)::date)`, and `eligible` is false when any exist.
-- `create_assignment` acts on that — outright under `block`, and under `warn`
-- unless an override is supplied.
--
-- ⛔ THE BOARD COULD NOT HAVE AGREED EVEN IF IT HAD TRIED. `board_window` sent
-- `operators[].skill_ids` — a BARE ARRAY OF IDS with no date on it — so the
-- client physically could not tell a live certificate from one that lapsed a
-- year ago. It drew the person as eligible, raised no warning, offered no
-- override tick, and Create then failed with a message about an override the
-- screen had no box for. A dead end, not a warning.
--
-- ⭐ SO THE SUBJECT OF THIS FILE IS NOT "DOES THE SERVER REFUSE" — it always
-- did. It is whether THE CLIENT IS TOLD ENOUGH TO REACH THE SERVER'S OWN
-- ANSWER, which is the same question 65 asks about parts. E7 is that question
-- put directly: a helper replays the client's arithmetic OVER `board_window`'s
-- PAYLOAD ALONE and its verdict is compared, case by case, with
-- `check_eligibility`'s. A payload the client cannot decide from fails E7 even
-- when every other case is green.
--
-- ⚠️ HALF THIS FILE IS CASES THAT MUST STILL BE ALLOWED. A rule that called
-- everybody lapsed would pass E1 and E5 and be far worse than no rule at all.
-- E2 (expires after the window), E3 (no expiry date at all), E4 (expires ON the
-- window's last day — `<`, not `<=`) and E6 (a dated certificate for a training
-- this cell does not ask for) are the four shapes that must come back ELIGIBLE.
-- E4 and E4b are a pair on purpose: they differ by one day and they are what
-- catches a `<=` typed where the server has `<`.
--
-- ⚠️ AS `authenticated`, because `board_window` is SECURITY INVOKER and psql
-- connects as the superuser, who bypasses RLS entirely. a1 is org 1's company
-- admin, granted `plant_1` (65's X0 measures that grant).
--
-- Fixture is the seed's: CNC is required at `plant_1.machining.cnc_line`, so
-- Cell 6 below it inherits it, and Maria holds CNC. Only the DATE on her row
-- moves from case to case, which is the one variable this file is about.
--
-- Everything is inside one BEGIN/ROLLBACK, each case savepointed.
-- ============================================================================

BEGIN;

-- The seed leaves `expires_at` NULL on every holder row, so the numbers below
-- are the whole fixture. Fixed dates, never `current_date`, so a case cannot
-- change meaning overnight.
--   window  W  = ['2026-10-01', '2026-10-03')  -> upper::date = 2026-10-03
--   Cell 6     = 3000000a-0000-0000-0000-00000000000c  (inherits CNC)
--   Maria      = 50000000-0000-0000-0000-000000000001  (holds CNC)
--   CNC        = 40000000-0000-0000-0000-000000000001
--   a1         = 00000000-0000-0000-0000-0000000000a1  (company admin)

-- A SECOND training, owned by Plant 1 and REQUIRED NOWHERE. E6 rests on it:
-- a certificate can be lapsed and irrelevant at the same time, and a client
-- that warned about every dated row it was sent would refuse half the plant.
INSERT INTO skills (id, org_id, name, site_node_id) VALUES
  ('e0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   'Expiry Test Training', '30000000-0000-0000-0000-000000000001');

INSERT INTO operator_skills (operator_id, skill_id, org_id, certified_at, expires_at)
VALUES ('50000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000001', DATE '2025-01-01', DATE '2026-01-01');

-- ⚠️ WHO IS ASKING, SET ONCE FOR THE WHOLE TRANSACTION. `check_eligibility` is
-- SECURITY DEFINER but gated on `app_can_read_node`, which resolves through
-- `auth.uid()` -- so a case that forgets this gets PT403 "you cannot see that
-- place" and measures nothing. `set_config(..., true)` is transaction-local and
-- every savepoint below is taken after this line, so it survives each
-- ROLLBACK TO. The fixture above deliberately ran BEFORE it, as the owner.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);

-- ---------------------------------------------------------------------------
-- THE CLIENT, REPLAYED. Everything below reads ONLY `board_window`'s payload —
-- no table, no `check_eligibility`, no `operator_skills`. It is deliberately
-- the same four steps `CreatePopover` takes:
--
--   required = node_skill_requirements unioned over the cell's ANCESTORS
--              (the payload's `nodes[].path`, which is what `skillsForNode`
--              walks);
--   held     = the operator's `skill_ids`;
--   missing  = required and not held;
--   lapsed   = required, held, and carrying a `skill_expiries` date that is
--              STRICTLY BEFORE the window's last calendar day in UTC — or any
--              date at all when the window has no upper bound.
--
-- ⚠️ THE DATE COMPARISON IS TEXT, ON PURPOSE. The client compares
-- `"YYYY-MM-DD" < "YYYY-MM-DD"` as JavaScript strings; for that fixed-width
-- zero-padded shape lexicographic order IS chronological order, and writing it
-- as text here means this helper would go red if the payload ever started
-- sending something a string compare cannot order.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.client_verdict(
  p_payload jsonb, p_node uuid, p_operator uuid, p_win tstzrange
) RETURNS jsonb LANGUAGE sql STABLE AS $fn$
  WITH nodes_p AS (
    SELECT (e->>'id')::uuid AS id, (e->>'path')::ltree AS path
    FROM jsonb_array_elements(p_payload->'nodes') e
  ),
  target AS (SELECT path FROM nodes_p WHERE id = p_node),
  req AS (
    SELECT DISTINCT (r->>'skill_id')::uuid AS skill_id
    FROM jsonb_array_elements(p_payload->'node_skill_requirements') r
    JOIN nodes_p a ON a.id = (r->>'node_id')::uuid
    WHERE (SELECT path FROM target) <@ a.path
  ),
  op AS (
    SELECT e FROM jsonb_array_elements(p_payload->'operators') e
    WHERE (e->>'id')::uuid = p_operator
  ),
  held AS (
    SELECT (s#>>'{}')::uuid AS skill_id FROM op, jsonb_array_elements(op.e->'skill_ids') s
  ),
  dated AS (
    SELECT (x->>'skill_id')::uuid AS skill_id, x->>'expires_at' AS expires_at
    FROM op, jsonb_array_elements(op.e->'skill_expiries') x
  ),
  end_day AS (
    SELECT CASE WHEN upper_inf(p_win) THEN NULL
                ELSE to_char(upper(p_win) AT TIME ZONE 'UTC', 'YYYY-MM-DD') END AS d
  ),
  missing AS (
    SELECT skill_id FROM req WHERE skill_id NOT IN (SELECT skill_id FROM held)
  ),
  lapsed AS (
    SELECT r.skill_id FROM req r JOIN dated d ON d.skill_id = r.skill_id
    WHERE (SELECT d FROM end_day) IS NULL OR d.expires_at < (SELECT d FROM end_day)
  )
  SELECT jsonb_build_object(
    'missing', (SELECT count(*) FROM missing),
    'lapsed',  (SELECT count(*) FROM lapsed),
    'eligible', (SELECT count(*) FROM missing) = 0 AND (SELECT count(*) FROM lapsed) = 0
  );
$fn$;

-- The payload, fetched once per case as a1 (RLS applies), for the same board
-- root the app opens.
CREATE FUNCTION pg_temp.payload() RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v := board_window('plant_1'::ltree, timestamptz '2026-10-01 00:00+00', timestamptz '2026-10-03 00:00+00');
  RESET ROLE;
  RETURN v;
END $fn$;

\echo 'E0 GUARD: the fixture is the world these cases describe'
SAVEPOINT sp_E0;
DO $$
DECLARE v_req int; v_holds int; v_exp date; v_cell ltree; v_line ltree;
BEGIN
  SELECT count(*) INTO v_req FROM node_skill_requirements
   WHERE node_id = '30000000-0000-0000-0000-000000000006'
     AND skill_id = '40000000-0000-0000-0000-000000000001';
  SELECT count(*), max(expires_at) INTO v_holds, v_exp FROM operator_skills
   WHERE operator_id = '50000000-0000-0000-0000-000000000001'
     AND skill_id = '40000000-0000-0000-0000-000000000001';
  SELECT path INTO v_cell FROM nodes WHERE id = '3000000a-0000-0000-0000-00000000000c';
  SELECT path INTO v_line FROM nodes WHERE id = '30000000-0000-0000-0000-000000000006';
  -- Maria holds CNC with NO date yet, CNC is required at the CNC line, and
  -- Cell 6 sits under it. Without this, a green case below could be a fixture
  -- that never asked anything.
  IF v_req = 1 AND v_holds = 1 AND v_exp IS NULL AND v_cell <@ v_line
  THEN RAISE NOTICE 'PASS E0';
  ELSE RAISE NOTICE 'FAIL E0: req=% holds=% expires=% cell=% line=%',
    v_req, v_holds, v_exp, v_cell, v_line; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_E0;

\echo 'E1 ⭐ THE DEFECT: a certificate that ran out BEFORE the window is refused by the server AND visible in the payload'
SAVEPOINT sp_E1;
DO $$
DECLARE v_elig jsonb; v_pay jsonb; v_client jsonb; v_date text;
BEGIN
  UPDATE operator_skills SET expires_at = DATE '2026-09-01'
   WHERE operator_id = '50000000-0000-0000-0000-000000000001'
     AND skill_id = '40000000-0000-0000-0000-000000000001';
  v_elig := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                              '50000000-0000-0000-0000-000000000001',
                              tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-01 14:00+00'));
  v_pay := pg_temp.payload();
  -- ⛔ THE HALF THAT WAS MISSING: the date has to BE in the payload. Before
  -- 0048 `skill_expiries` did not exist and this line is where the file went
  -- red, with the server's own answer beside it saying "not eligible".
  SELECT x->>'expires_at' INTO v_date
    FROM jsonb_array_elements(v_pay->'operators') o,
         jsonb_array_elements(o->'skill_expiries') x
   WHERE (o->>'id')::uuid = '50000000-0000-0000-0000-000000000001'
     AND (x->>'skill_id')::uuid = '40000000-0000-0000-0000-000000000001';
  v_client := pg_temp.client_verdict(v_pay, '3000000a-0000-0000-0000-00000000000c',
                                     '50000000-0000-0000-0000-000000000001',
                                     tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-01 14:00+00'));
  IF NOT (v_elig->>'eligible')::boolean
     AND jsonb_array_length(v_elig->'expiring_skills') = 1
     AND v_date = '2026-09-01'
     AND NOT (v_client->>'eligible')::boolean
     AND (v_client->>'lapsed')::int = 1
     AND (v_client->>'missing')::int = 0
  THEN RAISE NOTICE 'PASS E1';
  ELSE RAISE NOTICE 'FAIL E1: server=% payload_date=% client=%', v_elig, v_date, v_client; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E1;

\echo 'E2 ✅ MUST STILL BE ALLOWED: a certificate that runs out AFTER the window'
SAVEPOINT sp_E2;
DO $$
DECLARE v_elig jsonb; v_pay jsonb; v_client jsonb; v_date text;
BEGIN
  UPDATE operator_skills SET expires_at = DATE '2026-12-31'
   WHERE operator_id = '50000000-0000-0000-0000-000000000001'
     AND skill_id = '40000000-0000-0000-0000-000000000001';
  v_elig := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                              '50000000-0000-0000-0000-000000000001',
                              tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-01 14:00+00'));
  v_pay := pg_temp.payload();
  SELECT x->>'expires_at' INTO v_date
    FROM jsonb_array_elements(v_pay->'operators') o,
         jsonb_array_elements(o->'skill_expiries') x
   WHERE (o->>'id')::uuid = '50000000-0000-0000-0000-000000000001'
     AND (x->>'skill_id')::uuid = '40000000-0000-0000-0000-000000000001';
  v_client := pg_temp.client_verdict(v_pay, '3000000a-0000-0000-0000-00000000000c',
                                     '50000000-0000-0000-0000-000000000001',
                                     tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-01 14:00+00'));
  -- The date STILL arrives (the payload states the fact; it does not judge it),
  -- and both sides say eligible.
  IF (v_elig->>'eligible')::boolean
     AND jsonb_array_length(v_elig->'expiring_skills') = 0
     AND v_date = '2026-12-31'
     AND (v_client->>'eligible')::boolean
     AND (v_client->>'lapsed')::int = 0
  THEN RAISE NOTICE 'PASS E2';
  ELSE RAISE NOTICE 'FAIL E2: server=% payload_date=% client=%', v_elig, v_date, v_client; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E2;

\echo 'E3 ✅ MUST STILL BE ALLOWED: a certificate with no expiry date is not in skill_expiries at all'
SAVEPOINT sp_E3;
DO $$
DECLARE v_elig jsonb; v_pay jsonb; v_client jsonb; v_rows int; v_ids int;
BEGIN
  -- The seed's own state: expires_at NULL. Nothing is updated here on purpose.
  v_elig := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                              '50000000-0000-0000-0000-000000000001',
                              tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-01 14:00+00'));
  v_pay := pg_temp.payload();
  SELECT count(*) INTO v_rows
    FROM jsonb_array_elements(v_pay->'operators') o,
         jsonb_array_elements(o->'skill_expiries') x
   WHERE (o->>'id')::uuid = '50000000-0000-0000-0000-000000000001'
     AND (x->>'skill_id')::uuid = '40000000-0000-0000-0000-000000000001';
  -- ...while the id list still says she HOLDS it. "Trained, no renewal due" and
  -- "never trained" must not arrive as the same thing.
  SELECT count(*) INTO v_ids
    FROM jsonb_array_elements(v_pay->'operators') o,
         jsonb_array_elements(o->'skill_ids') s
   WHERE (o->>'id')::uuid = '50000000-0000-0000-0000-000000000001'
     AND (s#>>'{}')::uuid = '40000000-0000-0000-0000-000000000001';
  v_client := pg_temp.client_verdict(v_pay, '3000000a-0000-0000-0000-00000000000c',
                                     '50000000-0000-0000-0000-000000000001',
                                     tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-01 14:00+00'));
  IF (v_elig->>'eligible')::boolean AND v_rows = 0 AND v_ids = 1
     AND (v_client->>'eligible')::boolean
     AND (v_client->>'missing')::int = 0 AND (v_client->>'lapsed')::int = 0
  THEN RAISE NOTICE 'PASS E3';
  ELSE RAISE NOTICE 'FAIL E3: server=% dated_rows=% (want 0) id_rows=% (want 1) client=%',
    v_elig, v_rows, v_ids, v_client; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E3;

\echo 'E4 ✅ MUST STILL BE ALLOWED: expiring ON the window end date — the server compares with <, not <='
SAVEPOINT sp_E4;
DO $$
DECLARE v_elig jsonb; v_pay jsonb; v_client jsonb;
        v_win tstzrange := tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-03 00:00+00');
BEGIN
  UPDATE operator_skills SET expires_at = DATE '2026-10-03'
   WHERE operator_id = '50000000-0000-0000-0000-000000000001'
     AND skill_id = '40000000-0000-0000-0000-000000000001';
  v_elig := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                              '50000000-0000-0000-0000-000000000001', v_win);
  v_pay := pg_temp.payload();
  v_client := pg_temp.client_verdict(v_pay, '3000000a-0000-0000-0000-00000000000c',
                                     '50000000-0000-0000-0000-000000000001', v_win);
  IF (v_elig->>'eligible')::boolean AND (v_client->>'eligible')::boolean
  THEN RAISE NOTICE 'PASS E4';
  ELSE RAISE NOTICE 'FAIL E4: server=% client=%', v_elig, v_client; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E4;

\echo 'E4b ⭐ ONE DAY EARLIER IS REFUSED — E4 and this pair are what catch a <= typed for a <'
SAVEPOINT sp_E4b;
DO $$
DECLARE v_elig jsonb; v_pay jsonb; v_client jsonb;
        v_win tstzrange := tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-03 00:00+00');
BEGIN
  UPDATE operator_skills SET expires_at = DATE '2026-10-02'
   WHERE operator_id = '50000000-0000-0000-0000-000000000001'
     AND skill_id = '40000000-0000-0000-0000-000000000001';
  v_elig := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                              '50000000-0000-0000-0000-000000000001', v_win);
  v_pay := pg_temp.payload();
  v_client := pg_temp.client_verdict(v_pay, '3000000a-0000-0000-0000-00000000000c',
                                     '50000000-0000-0000-0000-000000000001', v_win);
  IF NOT (v_elig->>'eligible')::boolean AND NOT (v_client->>'eligible')::boolean
     AND (v_client->>'lapsed')::int = 1
  THEN RAISE NOTICE 'PASS E4b';
  ELSE RAISE NOTICE 'FAIL E4b: server=% client=%', v_elig, v_client; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E4b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E4b;

\echo 'E5 an OPEN-ENDED window makes any expiry date count as lapsed, on both sides'
SAVEPOINT sp_E5;
DO $$
DECLARE v_elig jsonb; v_pay jsonb; v_client jsonb;
        v_open tstzrange := tstzrange(timestamptz '2026-10-01 06:00+00', NULL);
BEGIN
  -- A date far in the future: nothing but `upper_inf` can make this lapsed.
  UPDATE operator_skills SET expires_at = DATE '2099-01-01'
   WHERE operator_id = '50000000-0000-0000-0000-000000000001'
     AND skill_id = '40000000-0000-0000-0000-000000000001';
  v_elig := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                              '50000000-0000-0000-0000-000000000001', v_open);
  v_pay := pg_temp.payload();
  v_client := pg_temp.client_verdict(v_pay, '3000000a-0000-0000-0000-00000000000c',
                                     '50000000-0000-0000-0000-000000000001', v_open);
  IF NOT (v_elig->>'eligible')::boolean AND NOT (v_client->>'eligible')::boolean
     AND (v_client->>'lapsed')::int = 1
  THEN RAISE NOTICE 'PASS E5';
  ELSE RAISE NOTICE 'FAIL E5: server=% client=%', v_elig, v_client; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E5;

\echo 'E5b ✅ MUST STILL BE ALLOWED: an open-ended window with NO expiry date is fine'
SAVEPOINT sp_E5b;
DO $$
DECLARE v_elig jsonb; v_pay jsonb; v_client jsonb;
        v_open tstzrange := tstzrange(timestamptz '2026-10-01 06:00+00', NULL);
BEGIN
  v_elig := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                              '50000000-0000-0000-0000-000000000001', v_open);
  v_pay := pg_temp.payload();
  v_client := pg_temp.client_verdict(v_pay, '3000000a-0000-0000-0000-00000000000c',
                                     '50000000-0000-0000-0000-000000000001', v_open);
  IF (v_elig->>'eligible')::boolean AND (v_client->>'eligible')::boolean
  THEN RAISE NOTICE 'PASS E5b';
  ELSE RAISE NOTICE 'FAIL E5b: server=% client=%', v_elig, v_client; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E5b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E5b;

\echo 'E6 ✅ MUST STILL BE ALLOWED: a LAPSED certificate for a training this cell does not ask for'
SAVEPOINT sp_E6;
DO $$
DECLARE v_elig jsonb; v_pay jsonb; v_client jsonb; v_date text;
        v_win tstzrange := tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-01 14:00+00');
BEGIN
  -- Maria's "Expiry Test Training" lapsed on 2026-01-01 (the fixture at the top
  -- of the file) and nothing requires it anywhere. The date is in the payload;
  -- it must not colour a cell that never asked for it.
  v_elig := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                              '50000000-0000-0000-0000-000000000001', v_win);
  v_pay := pg_temp.payload();
  SELECT x->>'expires_at' INTO v_date
    FROM jsonb_array_elements(v_pay->'operators') o,
         jsonb_array_elements(o->'skill_expiries') x
   WHERE (o->>'id')::uuid = '50000000-0000-0000-0000-000000000001'
     AND (x->>'skill_id')::uuid = 'e0000000-0000-0000-0000-000000000001';
  v_client := pg_temp.client_verdict(v_pay, '3000000a-0000-0000-0000-00000000000c',
                                     '50000000-0000-0000-0000-000000000001', v_win);
  IF (v_elig->>'eligible')::boolean AND v_date = '2026-01-01'
     AND (v_client->>'eligible')::boolean AND (v_client->>'lapsed')::int = 0
  THEN RAISE NOTICE 'PASS E6';
  ELSE RAISE NOTICE 'FAIL E6: server=% payload_date=% client=%', v_elig, v_date, v_client; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E6;

\echo 'E6b ⭐ NEVER TRAINED IS NOT THE SAME PROBLEM AS TRAINING LAPSED'
SAVEPOINT sp_E6b;
DO $$
DECLARE v_elig jsonb; v_pay jsonb; v_client jsonb; v_dated int; v_ids int;
        v_win tstzrange := tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-01 14:00+00');
BEGIN
  -- Elena holds nothing at all. The server reports her under `missing_skills`
  -- with `expiring_skills` empty, and the payload gives her neither a skill id
  -- nor a date -- so the client can tell "book a course" from "book a renewal"
  -- instead of collapsing both into "not eligible".
  v_elig := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                              '50000000-0000-0000-0000-000000000004', v_win);
  v_pay := pg_temp.payload();
  SELECT count(*) INTO v_dated
    FROM jsonb_array_elements(v_pay->'operators') o,
         jsonb_array_elements(o->'skill_expiries') x
   WHERE (o->>'id')::uuid = '50000000-0000-0000-0000-000000000004';
  SELECT count(*) INTO v_ids
    FROM jsonb_array_elements(v_pay->'operators') o,
         jsonb_array_elements(o->'skill_ids') s
   WHERE (o->>'id')::uuid = '50000000-0000-0000-0000-000000000004';
  v_client := pg_temp.client_verdict(v_pay, '3000000a-0000-0000-0000-00000000000c',
                                     '50000000-0000-0000-0000-000000000004', v_win);
  IF NOT (v_elig->>'eligible')::boolean
     AND jsonb_array_length(v_elig->'missing_skills') = 1
     AND jsonb_array_length(v_elig->'expiring_skills') = 0
     AND v_dated = 0 AND v_ids = 0
     AND (v_client->>'missing')::int = 1 AND (v_client->>'lapsed')::int = 0
  THEN RAISE NOTICE 'PASS E6b';
  ELSE RAISE NOTICE 'FAIL E6b: server=% dated=% ids=% client=%', v_elig, v_dated, v_ids, v_client; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E6b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E6b;

\echo 'E7 ⭐⭐ THE WHOLE POINT: over a matrix of dates and windows the payload-only verdict equals check_eligibility'
SAVEPOINT sp_E7;
DO $$
DECLARE
  v_pay jsonb; v_elig jsonb; v_client jsonb;
  v_date date; v_win tstzrange;
  v_mismatch int := 0; v_checked int := 0; v_refusals int := 0; v_allows int := 0;
  v_first text := '';
  v_dates date[] := ARRAY[NULL, DATE '2025-06-30', DATE '2026-10-01', DATE '2026-10-02',
                          DATE '2026-10-03', DATE '2026-10-04', DATE '2027-01-01']::date[];
  v_wins tstzrange[] := ARRAY[
    tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-01 14:00+00'),
    tstzrange(timestamptz '2026-10-02 22:00+00', timestamptz '2026-10-03 06:00+00'),
    tstzrange(timestamptz '2026-10-01 06:00+00', timestamptz '2026-10-03 00:00+00'),
    tstzrange(timestamptz '2026-10-01 06:00+00', NULL)
  ]::tstzrange[];
BEGIN
  FOREACH v_date IN ARRAY v_dates LOOP
    UPDATE operator_skills SET expires_at = v_date
     WHERE operator_id = '50000000-0000-0000-0000-000000000001'
       AND skill_id = '40000000-0000-0000-0000-000000000001';
    v_pay := pg_temp.payload();
    FOREACH v_win IN ARRAY v_wins LOOP
      v_elig := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                                  '50000000-0000-0000-0000-000000000001', v_win);
      v_client := pg_temp.client_verdict(v_pay, '3000000a-0000-0000-0000-00000000000c',
                                         '50000000-0000-0000-0000-000000000001', v_win);
      v_checked := v_checked + 1;
      IF (v_elig->>'eligible')::boolean THEN v_allows := v_allows + 1;
      ELSE v_refusals := v_refusals + 1; END IF;
      IF (v_elig->>'eligible')::boolean IS DISTINCT FROM (v_client->>'eligible')::boolean THEN
        v_mismatch := v_mismatch + 1;
        IF v_first = '' THEN
          v_first := format('expires=%s window=%s server=%s client=%s',
                            coalesce(v_date::text,'NULL'), v_win::text,
                            v_elig->>'eligible', v_client->>'eligible');
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  -- ⚠️ THE TALLY IS PART OF THE ASSERTION. "No mismatches" is also what a
  -- matrix that never refused anybody would report, so both halves must be
  -- non-empty for this case to mean what it says.
  IF v_mismatch = 0 AND v_checked = 28 AND v_refusals > 0 AND v_allows > 0
  THEN RAISE NOTICE 'PASS E7 (% pairs: % allowed, % refused, 0 disagreements)',
    v_checked, v_allows, v_refusals;
  ELSE RAISE NOTICE 'FAIL E7: checked=% mismatches=% allowed=% refused=% first=%',
    v_checked, v_mismatch, v_allows, v_refusals, v_first; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E7;

\echo 'E8 the key is on EVERY operator, and skill_ids is untouched beside it'
SAVEPOINT sp_E8;
DO $$
DECLARE v_pay jsonb; v_ops int; v_with_key int; v_maria_ids int; v_maria_dated int;
BEGIN
  v_pay := pg_temp.payload();
  SELECT count(*) INTO v_ops FROM jsonb_array_elements(v_pay->'operators');
  -- A key that is absent on the "nothing expires" rows is a key the parser
  -- cannot demand, and an optional field is how this bug gets back in.
  SELECT count(*) INTO v_with_key FROM jsonb_array_elements(v_pay->'operators') o
   WHERE jsonb_typeof(o->'skill_expiries') = 'array';
  SELECT count(*) INTO v_maria_ids
    FROM jsonb_array_elements(v_pay->'operators') o, jsonb_array_elements(o->'skill_ids') s
   WHERE (o->>'id')::uuid = '50000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_maria_dated
    FROM jsonb_array_elements(v_pay->'operators') o, jsonb_array_elements(o->'skill_expiries') x
   WHERE (o->>'id')::uuid = '50000000-0000-0000-0000-000000000001';
  -- Maria holds TWO trainings (CNC, undated; Expiry Test Training, dated), so
  -- the two lists must differ in length: the dated list is an annotation on a
  -- SUBSET, not a second copy of the id list.
  IF v_ops = 9 AND v_with_key = 9 AND v_maria_ids = 2 AND v_maria_dated = 1
  THEN RAISE NOTICE 'PASS E8';
  ELSE RAISE NOTICE 'FAIL E8: operators=% (want 9) with_key=% (want 9) maria_ids=% (want 2) maria_dated=% (want 1)',
    v_ops, v_with_key, v_maria_ids, v_maria_dated; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E8;

\echo 'E9 the rest of the payload is unchanged — every other top-level key still arrives'
SAVEPOINT sp_E9;
DO $$
DECLARE v_pay jsonb; v_missing text := '';
  v_keys text[] := ARRAY['org','levels','nodes','runs','assignments','operators','products',
                         'skills','node_skill_requirements','shift_templates','node_shift_map',
                         'cycle_times'];
  k text;
BEGIN
  v_pay := pg_temp.payload();
  FOREACH k IN ARRAY v_keys LOOP
    IF NOT (v_pay ? k) THEN v_missing := v_missing || k || ' '; END IF;
  END LOOP;
  -- `board_window` is a large function and every other key on it has a screen
  -- behind it. Re-creating it in full to add one key is exactly how one gets
  -- dropped, so this case says so out loud.
  IF v_missing = '' AND jsonb_typeof(v_pay->'products'->0->'offered_node_ids') = 'array'
  THEN RAISE NOTICE 'PASS E9';
  ELSE RAISE NOTICE 'FAIL E9: missing keys: [%] offered_node_ids=%',
    v_missing, jsonb_typeof(v_pay->'products'->0->'offered_node_ids'); END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E9;

ROLLBACK;

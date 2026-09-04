-- ============================================================================
-- 68_no_cross_plant_certification_test.sql — migration 0045, "a certification
-- cannot outlive the plant it was earned in." (R-326)
--
-- THE DECISION: *"I do not want cross-plant certifications."*
--
-- ⭐ WHAT THIS FILE IS REALLY FOR. The easy half — a move that strands a holder
-- is refused — is C1 and C2, and a guard that refused EVERY move would pass both
-- of them while being far worse than the one it replaces. So the file is built
-- around the cases that must still be ALLOWED: C3 and C4 are the two shapes of
-- legal overlap, C5 is a move with nobody in the way, and C7 is a person who
-- holds nothing. Without those four, a `return` typed in the wrong place looks
-- like a pass.
--
-- ⛔⛔ C3 IS THE CASE THE WHOLE MIGRATION TURNS ON, AND IT IS EASY TO MISS. The
-- two rehome guards already had `app_owner_covers_in_org`, which is
-- ONE-directional (the owner must contain the node). The grant guard
-- (`app_guard_operator_skill_scope`) asks for containment in EITHER direction,
-- because a person owned by a whole plant may legitimately hold a training owned
-- by one of that plant's lines. Reusing the narrower helper here would have
-- refused exactly that move — a rule stricter than the one the app enforces when
-- the certification is granted, which is a screen refusing what the server
-- allows. C3 moves a training DOWN into a department while its holder is owned
-- by the whole plant, and it must be ACCEPTED. It fails against
-- `app_owner_covers_in_org` and passes against `app_owner_overlaps_in_org`,
-- which is the only reason the new helper exists.
--
-- ⚠️ RUN AS THE TABLE OWNER, NOT AS A ROLE. RLS is not what is under test here;
-- the triggers are, and they fire for the owner too. Driving these through
-- `authenticated` would mean a refusal could come from the policy instead of the
-- guard and still look green. `55_ownership_scope_test.sql`'s node fixture is
-- borrowed for the second plant, which the seed does not have.
--
-- Everything is inside one BEGIN/ROLLBACK, each case savepointed.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE c_fix (k text primary key, v uuid);

-- The seed has ONE plant, so the second one is built here with `create_node`
-- (not INSERT -- a root create copies the structure, 0020 §10).
DO $$
DECLARE v_p2 uuid; v_dept2 uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_p2    := (create_node(NULL, 'Plant 2 (C)', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept2 := (create_node(v_p2, 'Fabrication C', 0)->>'id')::uuid;
  RESET ROLE;
  INSERT INTO c_fix (k, v) VALUES ('p2', v_p2), ('p2_dept', v_dept2);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- ---------------------------------------------------------------------------
-- ⛔⛔ PURPOSE-BUILT SUBJECTS, AND THE FIRST DRAFT OF THIS FILE PROVED WHY.
--
-- It reused the seed's Maria and its "CNC" training, and SIX of eight cases
-- failed -- none of them because of 0045. `node_skill_requirements` already
-- demands CNC on cells inside Plant 1, so `app_guard_skill_rehome`'s OLDER
-- check refused every training move before the new one was consulted; and
-- Maria carries a `home_node_id` in Plant 1, so `app_guard_operator_home`
-- refused every person move. Two guards standing in front of the one under
-- test, returning confident red for the wrong reason.
--
-- So the subjects here own nothing and are owed nothing: no requirement, no
-- assignment, no home cell. The only thing between them and a move is the rule
-- this file is about. A test that cannot fail for the reason it names is worth
-- as little as one that cannot fail at all.
-- ---------------------------------------------------------------------------
INSERT INTO skills (id, org_id, name, site_node_id) VALUES
  ('c0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   'Cert Test Training', '30000000-0000-0000-0000-000000000001');

-- Owned by Plant 2, for C6. Same org, so the composite FK is satisfied and a
-- refusal can only come from the guard.
INSERT INTO skills (id, org_id, name, site_node_id)
SELECT 'c0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
       'Cert Test Training P2', v FROM c_fix WHERE k = 'p2';

-- `home_node_id` left NULL on purpose -- see the block above.
INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
  ('c0000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001',
   'Cert Test Person', '30000000-0000-0000-0000-000000000001'),
  ('c0000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000001',
   'Cert Test Nobody', '30000000-0000-0000-0000-000000000001');

-- The pairing, made through the ordinary path so the GRANT guard accepts it. If
-- this INSERT ever starts failing the fixture is wrong and every case below is
-- meaningless rather than passing -- C0 exists to say so out loud.
INSERT INTO operator_skills (operator_id, skill_id, org_id, certified_at)
VALUES ('c0000000-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000001', current_date - 30);

\echo 'C0 GUARD: the fixture is the world these cases describe'
SAVEPOINT sp_C0;
DO $$
DECLARE v_holds int; v_op uuid; v_sk uuid;
BEGIN
  SELECT count(*) INTO v_holds FROM operator_skills
   WHERE operator_id = 'c0000000-0000-0000-0000-0000000000a1'
     AND skill_id = 'c0000000-0000-0000-0000-000000000001';
  SELECT site_node_id INTO v_op FROM operators WHERE id = 'c0000000-0000-0000-0000-0000000000a1';
  SELECT site_node_id INTO v_sk FROM skills    WHERE id = 'c0000000-0000-0000-0000-000000000001';
  -- Both owned by Plant 1, and the holder row exists. Without this a refusal
  -- below could be the fixture missing rather than the guard biting.
  IF v_holds = 1 AND v_op = '30000000-0000-0000-0000-000000000001'
                 AND v_sk = '30000000-0000-0000-0000-000000000001'
  THEN RAISE NOTICE 'PASS C0';
  ELSE RAISE NOTICE 'FAIL C0: holds=% operator_owner=% skill_owner=%', v_holds, v_op, v_sk; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C0;

\echo 'C1 ⭐ moving a TRAINING to another plant, while somebody holds it, is refused'
SAVEPOINT sp_C1;
DO $$
DECLARE v_err text := 'no error'; v_owner uuid;
BEGIN
  BEGIN
    UPDATE skills SET site_node_id = (SELECT v FROM c_fix WHERE k = 'p2')
     WHERE id = 'c0000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  SELECT site_node_id INTO v_owner FROM skills WHERE id = 'c0000000-0000-0000-0000-000000000001';
  -- ⚠️ THE ROW IS READ BACK. A trigger that raised and a trigger that quietly
  -- did nothing look identical from the caller if you only check for an error.
  IF v_err LIKE '%already hold it%' AND v_owner = '30000000-0000-0000-0000-000000000001'
  THEN RAISE NOTICE 'PASS C1';
  ELSE RAISE NOTICE 'FAIL C1: err=% owner_after=%', v_err, v_owner; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C1;

\echo 'C2 ⭐ moving a PERSON to another plant, while they hold a training, is refused'
SAVEPOINT sp_C2;
DO $$
DECLARE v_err text := 'no error'; v_owner uuid;
BEGIN
  BEGIN
    UPDATE operators SET site_node_id = (SELECT v FROM c_fix WHERE k = 'p2')
     WHERE id = 'c0000000-0000-0000-0000-0000000000a1';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  SELECT site_node_id INTO v_owner FROM operators WHERE id = 'c0000000-0000-0000-0000-0000000000a1';
  IF v_err LIKE '%belong to the site you are moving them out of%'
     AND v_owner = '30000000-0000-0000-0000-000000000001'
  THEN RAISE NOTICE 'PASS C2';
  ELSE RAISE NOTICE 'FAIL C2: err=% owner_after=%', v_err, v_owner; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C2;

\echo 'C3 ⛔ THE CASE THE HELPER EXISTS FOR: training moved DOWN inside the plant is ALLOWED'
SAVEPOINT sp_C3;
DO $$
DECLARE v_err text := 'no error'; v_owner uuid;
  v_assembly uuid := '30000000-0000-0000-0000-000000000002';
BEGIN
  -- Maria is owned by the whole of Plant 1; the training moves to Assembly,
  -- INSIDE Plant 1. The grant guard would accept this pairing (her path contains
  -- the training's), so the rehome guard must too. `app_owner_covers_in_org`
  -- would refuse it, which is why this case is here.
  BEGIN
    UPDATE skills SET site_node_id = v_assembly
     WHERE id = 'c0000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  SELECT site_node_id INTO v_owner FROM skills WHERE id = 'c0000000-0000-0000-0000-000000000001';
  IF v_err = 'no error' AND v_owner = v_assembly THEN RAISE NOTICE 'PASS C3';
  ELSE RAISE NOTICE 'FAIL C3: err=% owner_after=% (wanted the move to succeed)', v_err, v_owner; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C3;

\echo 'C4 the other direction of overlap: a person moved DOWN inside the plant is ALLOWED'
SAVEPOINT sp_C4;
DO $$
DECLARE v_err text := 'no error'; v_owner uuid;
  v_assembly uuid := '30000000-0000-0000-0000-000000000002';
BEGIN
  -- The mirror of C3 on the operator side: the training stays owned by Plant 1
  -- and Maria moves to Assembly under it. Still one branch, still legal.
  BEGIN
    UPDATE operators SET site_node_id = v_assembly
     WHERE id = 'c0000000-0000-0000-0000-0000000000a1';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  SELECT site_node_id INTO v_owner FROM operators WHERE id = 'c0000000-0000-0000-0000-0000000000a1';
  IF v_err = 'no error' AND v_owner = v_assembly THEN RAISE NOTICE 'PASS C4';
  ELSE RAISE NOTICE 'FAIL C4: err=% owner_after=% (wanted the move to succeed)', v_err, v_owner; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C4;

\echo 'C5 a training NOBODY holds still moves to another plant'
SAVEPOINT sp_C5;
DO $$
DECLARE v_err text := 'no error'; v_owner uuid; v_p2 uuid;
BEGIN
  SELECT v INTO v_p2 FROM c_fix WHERE k = 'p2';
  -- Same move as C1, with the holder removed first. If this fails, the guard is
  -- refusing the MOVE rather than the stranding, and C1 was proving nothing.
  DELETE FROM operator_skills WHERE skill_id = 'c0000000-0000-0000-0000-000000000001';
  BEGIN
    UPDATE skills SET site_node_id = v_p2 WHERE id = 'c0000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  SELECT site_node_id INTO v_owner FROM skills WHERE id = 'c0000000-0000-0000-0000-000000000001';
  IF v_err = 'no error' AND v_owner = v_p2 THEN RAISE NOTICE 'PASS C5';
  ELSE RAISE NOTICE 'FAIL C5: err=% owner_after=%', v_err, v_owner; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C5;

\echo 'C6 the grant guard is unchanged: a cross-plant certification still cannot be created'
SAVEPOINT sp_C6;
DO $$
DECLARE v_err text := 'no error'; v_n int; v_sk uuid;
BEGIN
  -- 0045 rewrote this function to call the shared predicate. Its behaviour must
  -- be identical, so the rule is re-asked from outside rather than assumed from
  -- the diff looking small.
  -- ⚠️ A PLANT 2 TRAINING IN THE SAME ORG, not another org's. The first draft
  -- reached for an org-2 training and passed -- on the composite FK
  -- `(org_id, skill_id)`, which refuses it long before any trigger runs. That
  -- is a green case pinning nothing.
  v_sk := 'c0000000-0000-0000-0000-000000000002';
  BEGIN
    INSERT INTO operator_skills (operator_id, skill_id, org_id)
    VALUES ('c0000000-0000-0000-0000-0000000000a1', v_sk,
            '10000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  SELECT count(*) INTO v_n FROM operator_skills
   WHERE operator_id = 'c0000000-0000-0000-0000-0000000000a1' AND skill_id = v_sk;
  IF v_err <> 'no error' AND v_n = 0 THEN RAISE NOTICE 'PASS C6';
  ELSE RAISE NOTICE 'FAIL C6: err=% rows=%', v_err, v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C6;

\echo 'C7 a person who holds nothing still moves to another plant'
SAVEPOINT sp_C7;
DO $$
DECLARE v_err text := 'no error'; v_owner uuid; v_p2 uuid;
BEGIN
  SELECT v INTO v_p2 FROM c_fix WHERE k = 'p2';
  DELETE FROM operator_skills WHERE operator_id = 'c0000000-0000-0000-0000-0000000000a2';
  DELETE FROM assignments     WHERE operator_id = 'c0000000-0000-0000-0000-0000000000a2';
  BEGIN
    UPDATE operators SET site_node_id = v_p2 WHERE id = 'c0000000-0000-0000-0000-0000000000a2';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  SELECT site_node_id INTO v_owner FROM operators WHERE id = 'c0000000-0000-0000-0000-0000000000a2';
  IF v_err = 'no error' AND v_owner = v_p2 THEN RAISE NOTICE 'PASS C7';
  ELSE RAISE NOTICE 'FAIL C7: err=% owner_after=%', v_err, v_owner; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C7;

ROLLBACK;

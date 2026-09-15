-- scripts/demo/rename-plant-a-operators.sql — R-423.
--
-- The maintainer, 15 Sept (session 174): "the operator names being A1, A2,
-- etc is a bit more challenging to understand vs actual people names, should
-- we try modifying plant A with actual people names?" — a recogniser hears
-- "Operator A3" as "operator a tree"; it hears "Priya Shah" as itself.
--
-- Plant A's six demo operators (`dev_demo.sql`'s v_letter = 'A' loop) live
-- only in this machine's database — there is no seed file in the repo that
-- creates them, so this is the one place the rename happens. It touches
-- `display_name` only. `employee_ref` is left exactly as it was: it is the
-- literal string 'EMP-1001' .. 'EMP-1006', never the short form "A1" .. "A6"
-- — src/lib/command/resolve.ts matches a spoken person word against
-- `displayName` first and `employeeRef` second (see its lines ~1574-1577 and
-- ~802-804), and it compares against the ref FIELD's actual contents, not a
-- derived abbreviation. So saying "A1" was never a working shortcut through
-- `employee_ref` before this script and is not one after it either — nothing
-- about voice resolution changes by keeping the refs.
--
-- Idempotent: each UPDATE is guarded by the OLD display_name too, so a
-- second run touches zero rows instead of erroring or re-writing anything.
--
-- Apply with:
--   docker exec -i supabase_db_production_scheduler psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/demo/rename-plant-a-operators.sql

BEGIN;

UPDATE operators SET display_name = 'Sam Patel'
  WHERE employee_ref = 'EMP-1001' AND display_name = 'Operator A1';

UPDATE operators SET display_name = 'Maria Lopez'
  WHERE employee_ref = 'EMP-1002' AND display_name = 'Operator A2';

UPDATE operators SET display_name = 'John Kim'
  WHERE employee_ref = 'EMP-1003' AND display_name = 'Operator A3';

UPDATE operators SET display_name = 'Priya Shah'
  WHERE employee_ref = 'EMP-1004' AND display_name = 'Operator A4';

UPDATE operators SET display_name = 'Tom Baker'
  WHERE employee_ref = 'EMP-1005' AND display_name = 'Operator A5';

UPDATE operators SET display_name = 'Lena Novak'
  WHERE employee_ref = 'EMP-1006' AND display_name = 'Operator A6';

COMMIT;

-- Show the result.
SELECT employee_ref, display_name FROM operators
  WHERE employee_ref IN ('EMP-1001', 'EMP-1002', 'EMP-1003', 'EMP-1004', 'EMP-1005', 'EMP-1006')
  ORDER BY employee_ref;

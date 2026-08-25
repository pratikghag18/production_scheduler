-- ============================================================================
-- Seed data — mirrors docs/mockups/model-hybrid.html (PRODUCTS, OPERATORS,
-- TREE, SHIFT_TEMPLATES, nodeShiftTemplates, PROFILES, runs, assignments)
-- exactly, per brief P1-2 §6.
--
-- Idempotent-safe under `supabase db reset`: this script assumes it is run
-- against an empty (freshly migrated) schema, as `supabase db reset` and
-- scripts/verify-db.sh both do. The auth.users / user_profiles /
-- profile_grants inserts additionally use ON CONFLICT DO NOTHING per the
-- brief, since those rows may pre-exist a signup flow in a real project.
--
-- D10 (design-plan §17 / brief §6): day 0 is anchored to the Monday of the
-- current week, in UTC — not the mockup's hardcoded Aug 17-19. Per-site
-- timezone is undecided; UTC is the honest placeholder (flagged again in
-- docs/schema.md).
-- ============================================================================

SET timezone = 'UTC';

-- seed_t(day, minute): local helper so ranges read like the mockup's T(1, 360).
-- day 0 = Monday of the current week (UTC), matching the mockup's day
-- numbering (0=Mon, 1=Tue, 2=Wed).
CREATE OR REPLACE FUNCTION seed_t(p_day int, p_minute int) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT date_trunc('week', current_date)::timestamptz + (p_day * 1440 + p_minute) * interval '1 minute';
$$;

-- ----------------------------------------------------------------------------
-- Org
-- ----------------------------------------------------------------------------
INSERT INTO orgs (id, name)
VALUES ('10000000-0000-0000-0000-000000000001', 'Northwind Manufacturing');

-- ----------------------------------------------------------------------------
-- Hierarchy levels: 0 Site, 1 Department, 2 Line, 3 Work Cell (schedulable).
-- The mockup starts at Department; design-plan §1's default vocabulary is
-- Site -> Department -> Line -> Work Cell, so the Site root is added here.
-- ----------------------------------------------------------------------------
-- D85: levels belong to a TEMPLATE, not directly to the org. One org may hold
-- several shapes; this is Northwind's only one, so its name is generic.
INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('21000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Standard Plant');

INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('20000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001', 0, 'Site', false),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001', 1, 'Department', false),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001', 2, 'Line', false),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001', 3, 'Work Cell', true);

-- ----------------------------------------------------------------------------
-- Nodes. Inserted parent-first so the path trigger (D6) resolves each row's
-- path from its already-inserted parent. path itself is never supplied.
-- ----------------------------------------------------------------------------
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000000', NULL, 'Plant 1');

INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Assembly'),
  ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Machining');

INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'Line 1'),
  ('30000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'Line 2'),
  ('30000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 'CNC Line');

INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('30000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004', 'Cell 1'),
  ('30000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004', 'Cell 2'),
  ('30000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004', 'Cell 3'),
  ('3000000a-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000005', 'Cell 4'),
  ('3000000a-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000005', 'Cell 5'),
  ('3000000a-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000006', 'Cell 6'),
  ('3000000a-0000-0000-0000-00000000000d', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000006', 'Cell 7');

DO $$ BEGIN
  IF (SELECT path FROM nodes WHERE id = '3000000a-0000-0000-0000-00000000000c') <> 'plant_1.machining.cnc_line.cell_6' THEN
    RAISE EXCEPTION 'seed assertion failed: Cell 6 path is %, expected plant_1.machining.cnc_line.cell_6',
      (SELECT path FROM nodes WHERE id = '3000000a-0000-0000-0000-00000000000c');
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Skills. D11: the CNC requirement attaches to the CNC Line node, not to
-- Cells 6/7 individually (equivalent in effect; exercises the ancestor
-- inheritance query in the seed itself).
-- ----------------------------------------------------------------------------
INSERT INTO skills (id, org_id, name)
VALUES ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'CNC');

INSERT INTO node_skill_requirements (node_id, skill_id, org_id)
VALUES ('30000000-0000-0000-0000-000000000006', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001');

-- ----------------------------------------------------------------------------
-- Operators (9)
-- ----------------------------------------------------------------------------
INSERT INTO operators (id, org_id, home_node_id, display_name, employee_ref, source) VALUES
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 'Maria', 'EMP-001', 'manual'),
  ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 'Raj',   'EMP-002', 'manual'),
  ('50000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 'Aisha', 'EMP-003', 'manual'),
  ('50000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'Elena', 'EMP-004', 'manual'),
  ('50000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'Tom',   'EMP-005', 'manual'),
  ('50000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'Ben',   'EMP-006', 'manual'),
  ('50000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'Lily',  'EMP-007', 'manual'),
  ('50000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'Sam',   'EMP-008', 'manual'),
  ('50000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'Noah',  'EMP-009', 'manual');

INSERT INTO operator_skills (operator_id, skill_id, org_id) VALUES
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001');

-- ----------------------------------------------------------------------------
-- Products — colors are a UI concern only (client maps sku -> --product-N
-- token, brief P1-1 §4); no color column here.
-- ----------------------------------------------------------------------------
INSERT INTO products (id, org_id, sku, name, source) VALUES
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'WX', 'Widget X', 'manual'),
  ('60000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'WY', 'Widget Y', 'manual'),
  ('60000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'GZ', 'Gadget Z', 'manual'),
  ('60000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'RW', 'Rework',   'manual');

-- ----------------------------------------------------------------------------
-- Shift templates, shifts, breaks — exact SHIFT_TEMPLATES constants from the
-- mockup, including the two overnight shifts (Shift 3, Nights).
-- ----------------------------------------------------------------------------
INSERT INTO shift_templates (id, org_id, name) VALUES
  ('70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '3 × 8h'),
  ('70000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '2 × 10h');

INSERT INTO shifts (id, org_id, template_id, name, start_min, end_min) VALUES
  ('71000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 'Shift 1', 360,  840),
  ('71000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 'Shift 2', 840,  1320),
  ('71000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 'Shift 3', 1320, 1800),
  ('71000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000002', 'Days',    360,  960),
  ('71000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000002', 'Nights',  960,  1560);

INSERT INTO shift_breaks (org_id, shift_id, name, start_min, end_min) VALUES
  -- Shift 1
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'Break 1', 480,  495),
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'Lunch',   600,  630),
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'Break 2', 720,  735),
  -- Shift 2
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000002', 'Break 1', 960,  975),
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000002', 'Lunch',   1080, 1110),
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000002', 'Break 2', 1200, 1215),
  -- Shift 3 (overnight, 22:00-06:00)
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000003', 'Break 1', 1440, 1455),
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000003', 'Lunch',   1560, 1590),
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000003', 'Break 2', 1680, 1695),
  -- Days
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000004', 'Break 1', 510,  525),
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000004', 'Lunch',   660,  690),
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000004', 'Break 2', 810,  825),
  -- Nights (overnight, 16:00-02:00)
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000005', 'Break 1', 1110, 1125),
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000005', 'Lunch',   1260, 1290),
  ('10000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000005', 'Break 2', 1410, 1425);

-- Attachments (nodeShiftTemplates): Assembly -> 3x8h, CNC Line -> 2x10h.
INSERT INTO node_shift_templates (node_id, org_id, template_id) VALUES
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000002');

-- ----------------------------------------------------------------------------
-- Runs (8) — mirrors the mockup's `runs` array exactly (day/minute pairs via
-- seed_t). r7 is Wed, unstaffed by design (no assignment references it).
-- ----------------------------------------------------------------------------
INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount) VALUES
  ('80000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', '60000000-0000-0000-0000-000000000001', tstzrange(seed_t(1,360),  seed_t(1,840)),  3),
  ('80000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', '60000000-0000-0000-0000-000000000002', tstzrange(seed_t(1,870),  seed_t(1,1320)), 1),
  ('80000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008', '60000000-0000-0000-0000-000000000001', tstzrange(seed_t(1,360),  seed_t(1,840)),  1),
  ('80000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000009', '60000000-0000-0000-0000-000000000003', tstzrange(seed_t(1,480),  seed_t(1,960)),  2),
  ('80000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000c', '60000000-0000-0000-0000-000000000003', tstzrange(seed_t(1,360),  seed_t(1,840)),  1),
  ('80000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000d', '60000000-0000-0000-0000-000000000004', tstzrange(seed_t(1,600),  seed_t(1,1080)), 2),
  ('80000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', '60000000-0000-0000-0000-000000000001', tstzrange(seed_t(2,360),  seed_t(2,840)),  3),
  ('80000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000c', '60000000-0000-0000-0000-000000000003', tstzrange(seed_t(0,360),  seed_t(0,840)),  1);

-- ----------------------------------------------------------------------------
-- Assignments (12) — run-attached inherit node_id from their run (enforced
-- by assignments_run_consistency); direct assignments carry cell + product.
-- Efficiencies converted from percent to the numeric scale (eff:50 -> 0.500).
-- Aisha's two 50% direct assignments on Cells 4 and 5, same window, are the
-- load-bearing capacity case: peak exactly 1.0, must insert cleanly.
-- ----------------------------------------------------------------------------
INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency, target_qty, target_unit) VALUES
  ('90000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', '50000000-0000-0000-0000-000000000004', '80000000-0000-0000-0000-000000000001', NULL, tstzrange(seed_t(1,360), seed_t(1,840)),  1.000, NULL, NULL),
  ('90000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', '50000000-0000-0000-0000-000000000005', '80000000-0000-0000-0000-000000000001', NULL, tstzrange(seed_t(1,360), seed_t(1,840)),  1.000, NULL, NULL),
  ('90000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', '50000000-0000-0000-0000-000000000004', '80000000-0000-0000-0000-000000000002', NULL, tstzrange(seed_t(1,870), seed_t(1,1320)), 1.000, NULL, NULL),
  ('90000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-000000000006', '80000000-0000-0000-0000-000000000003', NULL, tstzrange(seed_t(1,360), seed_t(1,840)),  1.000, 500, 'units'),
  ('90000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000009', '50000000-0000-0000-0000-000000000007', '80000000-0000-0000-0000-000000000004', NULL, tstzrange(seed_t(1,480), seed_t(1,960)),  1.000, NULL, NULL),
  ('90000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000009', '50000000-0000-0000-0000-000000000008', '80000000-0000-0000-0000-000000000004', NULL, tstzrange(seed_t(1,480), seed_t(1,960)),  0.500, NULL, NULL),
  ('90000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000c', '50000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000005', NULL, tstzrange(seed_t(1,360), seed_t(1,840)),  1.000, NULL, NULL),
  ('90000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000d', '50000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000006', NULL, tstzrange(seed_t(1,600), seed_t(1,1080)), 1.000, NULL, NULL),
  ('90000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000c', '50000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000008', NULL, tstzrange(seed_t(0,360), seed_t(0,840)),  1.000, NULL, NULL),
  -- direct assignments (run_id NULL, product_id set)
  ('9000000a-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000003', NULL, '60000000-0000-0000-0000-000000000002', tstzrange(seed_t(1,360), seed_t(1,720)), 0.500, NULL, NULL),
  ('9000000a-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000b', '50000000-0000-0000-0000-000000000003', NULL, '60000000-0000-0000-0000-000000000004', tstzrange(seed_t(1,360), seed_t(1,720)), 0.500, NULL, NULL),
  ('9000000a-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000b', '50000000-0000-0000-0000-000000000009', NULL, '60000000-0000-0000-0000-000000000004', tstzrange(seed_t(1,540), seed_t(1,660)), 0.750, NULL, NULL);

-- ----------------------------------------------------------------------------
-- Users and profiles (from PROFILES). auth.users inserts are LOCAL-DEV ONLY
-- — production identities come from Supabase Auth signup; this table is
-- shimmed here (and in tests/00_harness.sql) purely to give the FK and the
-- RLS tests something to point at.
-- ----------------------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'admin@northwind.example'),
  ('00000000-0000-0000-0000-0000000000a2', 'ana@northwind.example'),
  ('00000000-0000-0000-0000-0000000000a3', 'marco@northwind.example')
ON CONFLICT DO NOTHING;

INSERT INTO user_profiles (id, org_id, user_id, role, default_create_mode) VALUES
  ('a0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'admin',      'run'),
  ('a0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a2', 'supervisor', 'run'),
  ('a0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a3', 'supervisor', 'direct')
ON CONFLICT DO NOTHING;

INSERT INTO profile_grants (profile_id, node_id, org_id, can_edit) VALUES
  ('a0000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', true), -- Admin -> Plant 1 (root)
  ('a0000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', true), -- Ana -> Assembly
  ('a0000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', true)  -- Marco -> Machining
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- Seed assertion: the Aisha 50/50 pair must be present (acceptance #15).
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF (SELECT count(*) FROM assignments
        WHERE operator_id = '50000000-0000-0000-0000-000000000003'
          AND efficiency = 0.500
          AND node_id IN ('3000000a-0000-0000-0000-00000000000a', '3000000a-0000-0000-0000-00000000000b')) <> 2
  THEN
    RAISE EXCEPTION 'seed assertion failed: Aisha 50/50 pair on Cells 4/5 not found';
  END IF;
END $$;

-- ============================================================================
-- SECOND ORG — Contoso Fabrication (design session, Aug 25 2026).
--
-- WHY THIS EXISTS. Until now the seed had exactly ONE org, which meant no test
-- anywhere in this repo could catch a missing `org_id` filter: with a single
-- tenant, a query that forgets to scope by org returns exactly the same rows as
-- one that remembers. Every RLS test, every RPC test and every acceptance case
-- passed under that blind spot. Recorded as unverified since P1-5a (§19.5).
--
-- WHY EVERY NAME COLLIDES WITH ORG 1. This org is deliberately NOT a distinct
-- fixture. Its levels, nodes, product SKU, skill, shift template and employee
-- ref all reuse org 1's actual values, so its node paths are IDENTICAL:
-- `plant_1`, `plant_1.assembly`, `plant_1.assembly.line_1`,
-- `plant_1.assembly.line_1.cell_1`.
--
-- Every uniqueness constraint in this schema is `(org_id, ...)` -- `(org_id,
-- path)`, `(org_id, sku)`, `(org_id, name)`, `(org_id, position)` -- so all of
-- this is legal BY DESIGN, and that is precisely the point: a leak between
-- tenants is invisible when the two tenants look different, and unmissable
-- when they look the same. A query that filters on `path` alone gets two rows;
-- one that filters on `(org_id, path)` gets one.
--
-- `Cell Z` has no counterpart in org 1, so "org 1 must never see Cell Z" is a
-- single unambiguous assertion.
-- ============================================================================

INSERT INTO orgs (id, name)
VALUES ('10000000-0000-0000-0000-000000000002', 'Contoso Fabrication');

-- Same four level NAMES and positions as org 1. Uniqueness is now
-- (template_id, position), and the two orgs hold different templates, so the
-- collision the fixture depends on survives D85 unchanged.
INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('2100000b-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'Standard Plant');

INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('2000000b-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', '2100000b-0000-0000-0000-000000000001', 0, 'Site',      false),
  ('2000000b-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '2100000b-0000-0000-0000-000000000001', 1, 'Department',false),
  ('2000000b-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '2100000b-0000-0000-0000-000000000001', 2, 'Line',      false),
  ('2000000b-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', '2100000b-0000-0000-0000-000000000001', 3, 'Work Cell', true);

-- Parent-first, so the path trigger resolves each row from its parent.
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('3000000b-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '2000000b-0000-0000-0000-000000000000', NULL, 'Plant 1');

INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('3000000b-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '2000000b-0000-0000-0000-000000000001', '3000000b-0000-0000-0000-000000000001', 'Assembly');

INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('3000000b-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', '2000000b-0000-0000-0000-000000000002', '3000000b-0000-0000-0000-000000000002', 'Line 1');

INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('3000000b-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000002', '2000000b-0000-0000-0000-000000000003', '3000000b-0000-0000-0000-000000000004', 'Cell 1'),
  ('3000000b-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000002', '2000000b-0000-0000-0000-000000000003', '3000000b-0000-0000-0000-000000000004', 'Cell Z');

-- The collision is the fixture. Assert it rather than trusting it: if a future
-- schema change ever made paths globally unique, these inserts would fail and
-- every cross-org test would silently lose its teeth.
DO $$
DECLARE v_paths int; v_orgs int;
BEGIN
  SELECT count(*), count(DISTINCT org_id) INTO v_paths, v_orgs
    FROM nodes WHERE path = 'plant_1.assembly.line_1.cell_1';
  IF v_paths <> 2 OR v_orgs <> 2 THEN
    RAISE EXCEPTION 'seed assertion failed: expected the SAME path in 2 orgs, got % rows across % orgs', v_paths, v_orgs;
  END IF;
END $$;

-- Same skill NAME as org 1's (unique is (org_id, name)): 'CNC' in both.
INSERT INTO skills (id, org_id, name)
VALUES ('4000000b-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'CNC');

-- `employee_ref` carries NO uniqueness at all, so EMP-001 exists in both orgs.
INSERT INTO operators (id, org_id, home_node_id, display_name, employee_ref, source) VALUES
  ('5000000b-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '3000000b-0000-0000-0000-000000000007', 'Contoso Operator A', 'EMP-001', 'manual'),
  ('5000000b-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '3000000b-0000-0000-0000-000000000008', 'Contoso Operator B', 'EMP-002', 'manual');

INSERT INTO operator_skills (operator_id, skill_id, org_id) VALUES
  ('5000000b-0000-0000-0000-000000000001', '4000000b-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002');

-- Same SKU as org 1's Widget X (unique is (org_id, sku)) -- so 'WX' means a
-- DIFFERENT product in each org, which is the sharpest possible product leak.
INSERT INTO products (id, org_id, sku, name, source) VALUES
  ('6000000b-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'WX', 'Contoso Widget', 'manual');

-- Same template NAME as org 1's (unique is (org_id, name)).
INSERT INTO shift_templates (id, org_id, name) VALUES
  ('7000000b-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '3 × 8h');

INSERT INTO shifts (id, org_id, template_id, name, start_min, end_min) VALUES
  ('7000000b-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000002', '7000000b-0000-0000-0000-000000000001', 'Day', 360, 840);

INSERT INTO node_shift_templates (node_id, org_id, template_id) VALUES
  ('3000000b-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '7000000b-0000-0000-0000-000000000001');

-- One run and one assignment, in the same anchored week as org 1's, on a node
-- whose PATH is identical to an org-1 node that also has runs. A board query
-- that resolves rows by path instead of (org_id, path) returns both.
INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount) VALUES
  ('8000000b-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '3000000b-0000-0000-0000-000000000007', '6000000b-0000-0000-0000-000000000001', tstzrange(seed_t(1,360), seed_t(1,840)), 1);

INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency, target_qty, target_unit) VALUES
  ('9000000b-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '3000000b-0000-0000-0000-000000000007', '5000000b-0000-0000-0000-000000000001', '8000000b-0000-0000-0000-000000000001', NULL, tstzrange(seed_t(1,360), seed_t(1,840)), 1.000, NULL, NULL);

-- Users and profiles. LOCAL-DEV ONLY, same shim as org 1's block above.
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'admin@contoso.example'),
  ('00000000-0000-0000-0000-0000000000b2', 'sofia@contoso.example')
ON CONFLICT DO NOTHING;

INSERT INTO user_profiles (id, org_id, user_id, role, default_create_mode) VALUES
  ('a000000b-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b1', 'admin',      'run'),
  ('a000000b-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b2', 'supervisor', 'run')
ON CONFLICT DO NOTHING;

INSERT INTO profile_grants (profile_id, node_id, org_id, can_edit) VALUES
  ('a000000b-0000-0000-0000-000000000001', '3000000b-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', true),
  ('a000000b-0000-0000-0000-000000000002', '3000000b-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', true)
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- Seed assertion: org 2 is populated, and `Cell Z` is unique to it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_nodes int; v_cellz int;
BEGIN
  SELECT count(*) INTO v_nodes FROM nodes WHERE org_id = '10000000-0000-0000-0000-000000000002';
  IF v_nodes <> 5 THEN
    RAISE EXCEPTION 'seed assertion failed: org 2 has % nodes, expected 5', v_nodes;
  END IF;
  SELECT count(*) INTO v_cellz FROM nodes WHERE name = 'Cell Z';
  IF v_cellz <> 1 THEN
    RAISE EXCEPTION 'seed assertion failed: Cell Z must exist exactly once, found %', v_cellz;
  END IF;
END $$;

DROP FUNCTION seed_t(int, int);

-- ============================================================================
-- Brief P1-3b §7 — dev-only login credentials for the three seeded
-- profiles, so DevProfileSwitcher.tsx (a dev-only, import.meta.env.DEV
-- -gated component — never ships in a production build) can sign in
-- locally. Every board_window/capacity_probe/... RPC has EXECUTE revoked
-- from anon (migration 0009 §6), so signed-out the app can read nothing;
-- these three accounts are what makes RLS-gated data visible while
-- developing.
--
-- *** LOCAL DEVELOPMENT ONLY. NEVER RUN THIS AGAINST A HOSTED/PRODUCTION
-- SUPABASE PROJECT. *** It sets a single, publicly-known password
-- ('devpassword', in this file, in plain text) on three accounts.
--
-- ASSUMPTION (brief §7 vs. the auth.users rows already inserted above by
-- brief P1-2 §6): the brief names specific emails (admin@example.test /
-- ana@example.test / marco@example.test), but the existing rows use
-- *.northwind.example addresses under fixed ids
-- 00000000-...-a1/a2/a3. Rather than INSERTing three new, still-
-- uncredentialed, duplicate users under the brief's emails — which would
-- leave the existing FK-linked user_profiles/profile_grants rows pointing
-- at accounts that still can't sign in — this UPDATEs the existing three
-- rows by their fixed id: the email becomes the brief's literal value and
-- the password/confirmation fields are set in the same statement. This is
-- an append (three UPDATE statements after the original INSERT block
-- above), not a rewrite of that block, and an UPDATE keyed by primary key
-- is idempotent by construction, so re-running the seed stays safe.
--
-- Column values mirror how GoTrue writes a row for a local, already-
-- confirmed user (aud/role 'authenticated', instance_id all-zero,
-- email_confirmed_at set) so supabase-js's signInWithPassword treats these
-- exactly like normal accounts.
-- ============================================================================
-- CORRECTION (2026-08-22): the first version of this block set only the
-- fields we cared about and left confirmation_token, recovery_token,
-- email_change_token_new and email_change NULL -- those four are the only
-- token columns in auth.users with no database default. GoTrue scans them
-- into non-nullable Go strings, so loading any of these users failed with
-- the generic "Database error querying schema" and sign-in never got as far
-- as checking the password. Every such column is set to '' below. The
-- partial unique indexes on those columns exclude values matching
-- '^[0-9 ]*$', and '' matches, so three rows sharing '' is fine.
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
  ('00000000-0000-0000-0000-0000000000a1'::uuid, 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000a2'::uuid, 'ana@example.test'),
  ('00000000-0000-0000-0000-0000000000a3'::uuid, 'marco@example.test')
) AS v(id, email)
WHERE u.id = v.id;

-- GoTrue also expects an identities row per email-password account; without
-- it the user exists but has no linked credential provider.
INSERT INTO auth.identities
  (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
SELECT
  u.id::text,
  u.id,
  jsonb_build_object(
    'sub', u.id::text,
    'email', u.email,
    'email_verified', true,
    'phone_verified', false
  ),
  'email',
  now(), now(), now()
FROM auth.users u
WHERE u.id IN ('00000000-0000-0000-0000-0000000000a1',
               '00000000-0000-0000-0000-0000000000a2',
               '00000000-0000-0000-0000-0000000000a3')
ON CONFLICT (provider_id, provider) DO NOTHING;

DO $$ BEGIN
  IF (SELECT count(*) FROM auth.users
        WHERE id IN ('00000000-0000-0000-0000-0000000000a1',
                      '00000000-0000-0000-0000-0000000000a2',
                      '00000000-0000-0000-0000-0000000000a3')
          AND encrypted_password IS NOT NULL
          -- these four being NULL is what made GoTrue fail; assert loudly
          AND confirmation_token IS NOT NULL
          AND recovery_token IS NOT NULL
          AND email_change_token_new IS NOT NULL
          AND email_change IS NOT NULL) <> 3
  THEN
    RAISE EXCEPTION 'seed assertion failed: dev login credentials were not set on all three seeded users';
  END IF;
END $$;

DO $$ BEGIN
  IF (SELECT count(*) FROM auth.identities
        WHERE user_id IN ('00000000-0000-0000-0000-0000000000a1',
                          '00000000-0000-0000-0000-0000000000a2',
                          '00000000-0000-0000-0000-0000000000a3')
          AND provider = 'email') <> 3
  THEN
    RAISE EXCEPTION 'seed assertion failed: auth.identities rows missing for the three dev users';
  END IF;
END $$;

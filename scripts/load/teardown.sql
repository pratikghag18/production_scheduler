-- Remove everything scripts/load/fixture.sql created, and NOTHING else.
--
-- Every row it makes is reachable from two handles: the `load_plant` subtree and
-- operators whose employee_ref starts with LOAD-. Both are named explicitly here
-- rather than relying on cascades, so this can be read and checked before it is
-- run against a database somebody is using.
\set ON_ERROR_STOP on
BEGIN;

DELETE FROM assignments a
 WHERE a.node_id IN (SELECT id FROM nodes WHERE path <@ 'load_plant');
DELETE FROM runs r
 WHERE r.node_id IN (SELECT id FROM nodes WHERE path <@ 'load_plant');
DELETE FROM operators WHERE employee_ref LIKE 'LOAD-%';
DELETE FROM product_sites ps
 WHERE ps.node_id IN (SELECT id FROM nodes WHERE path <@ 'load_plant');
DELETE FROM profile_grants pg
 WHERE pg.node_id IN (SELECT id FROM nodes WHERE path <@ 'load_plant');
-- Deepest first, so no parent is removed while a child still points at it.
DELETE FROM nodes WHERE path <@ 'load_plant';

SELECT 'left behind: nodes' AS what, count(*) FROM nodes WHERE path <@ 'load_plant'
UNION ALL SELECT 'left behind: operators', count(*) FROM operators WHERE employee_ref LIKE 'LOAD-%';
COMMIT;

-- Is the runs/assignments cost the AGGREGATION, or the RLS policy on every row?
-- Same rows, same aggregation, same window -- once as superuser (RLS bypassed)
-- and once as the authenticated admin (policy evaluated per row).
\timing on

\echo '=== SUPERUSER: RLS bypassed ==='
SELECT count(*) FROM (
  SELECT jsonb_agg(to_jsonb(r) ORDER BY r.timerange) FROM runs r
   WHERE r.node_id IN (SELECT id FROM nodes WHERE path <@ 'load_plant')
     AND r.timerange && tstzrange(date_trunc('day',now())+interval '7 days',
                                  date_trunc('day',now())+interval '14 days')
) x;

SELECT count(*) FROM (
  SELECT jsonb_agg(to_jsonb(a) ORDER BY a.timerange) FROM assignments a
   WHERE a.node_id IN (SELECT id FROM nodes WHERE path <@ 'load_plant')
     AND a.timerange && tstzrange(date_trunc('day',now())+interval '7 days',
                                  date_trunc('day',now())+interval '14 days')
) x;

\echo '=== AUTHENTICATED: the same, with RLS ==='
BEGIN;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1',true) \g /dev/null
SET LOCAL ROLE authenticated;

SELECT count(*) FROM (
  SELECT jsonb_agg(to_jsonb(r) ORDER BY r.timerange) FROM runs r
   WHERE r.node_id IN (SELECT id FROM nodes WHERE path <@ 'load_plant')
     AND r.timerange && tstzrange(date_trunc('day',now())+interval '7 days',
                                  date_trunc('day',now())+interval '14 days')
) x;

SELECT count(*) FROM (
  SELECT jsonb_agg(to_jsonb(a) ORDER BY a.timerange) FROM assignments a
   WHERE a.node_id IN (SELECT id FROM nodes WHERE path <@ 'load_plant')
     AND a.timerange && tstzrange(date_trunc('day',now())+interval '7 days',
                                  date_trunc('day',now())+interval '14 days')
) x;

RESET ROLE;
ROLLBACK;

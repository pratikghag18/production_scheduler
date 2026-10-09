-- ============================================================================
-- 0056 --- THE PLANT-ROOT HELPER ANSWERS ONLY ABOUT THE CALLER'S COMPANY (DEF-0013, R-341).
--
-- 0054 added `app_node_is_plant_root`, SECURITY DEFINER, and its header said
-- it was "in the shape of `app_node_exists_in_org` (0020)". It was not, by one
-- term: 0020's helper is org-scoped (`n.org_id = app_current_org()`) and this
-- one was not, so any signed-in person holding another company's node id
-- could ask whether it is a plant root and get the true bit back --- over
-- PostgREST directly, and through the trigger, where a foreign leaf and a
-- foreign root came back with different error codes (PT400 from the trigger,
-- 42501 from the policy). One bit, about a uuid the caller already holds;
-- filed minor, and filed because the schema states the rule on every definer
-- helper (0020 s8.0, 65's X4-X6, session 73 on `set_node_setting`) and the
-- migration claimed to meet it.
--
-- The fix is the term, and only the term. The helper stays SECURITY DEFINER:
-- the 0054 header measured what an invoker helper does to 47's W28 (a foreign
-- root becomes invisible, the trigger speaks before the policy). With the
-- org term a foreign root is "not a root here", the same answer as a uuid
-- that exists nowhere, so the trigger refuses both with `admin_below_root`
-- and the policy is never reached for either. 77's AR10 asks the helper the
-- question directly, the way 65's X4-X6 ask theirs, so a later re-emission
-- cannot drop the term the way 0053 dropped 0022's guard (DEF-0011).
--
-- Body extracted from 0054 (the last definition) and edited by inserting the
-- one line; the org term is 0020's, verbatim.
-- ============================================================================

create or replace function app_node_is_plant_root(p_node_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM nodes n
     WHERE n.id = p_node_id AND n.parent_id IS NULL
       AND n.org_id = app_current_org()
  );
$$;

comment on function app_node_is_plant_root(uuid) is
  'True when the node exists IN THE CALLER''S COMPANY and has no parent --- a plant root, the only place an admin grant may sit (R-340). SECURITY DEFINER so the answer is about the node and not about what the caller can see (0054); org-scoped so another company''s root and a uuid that exists nowhere get the same answer, false (R-341, DEF-0013, 0056).';

revoke execute on function app_node_is_plant_root(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_node_is_plant_root(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_node_is_plant_root(uuid) from anon';
  end if;
end $$;

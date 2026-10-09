-- ============================================================================
-- 0053 — AN ADMIN GRANT BELONGS TO A PLANT, NOT TO A BRANCH INSIDE ONE.
--
-- The maintainer, session 71: *"the admin level should only be applied to the
-- plant root. If you make someone a site admin they automatically get access to
-- the whole site and not just to a particular hierarchy."* That is a product
-- rule about what the word "admin" MEANS here — it is the person who runs a
-- plant — and until now nothing enforced it at either end.
--
-- ⛔ WHY THIS IS A MIGRATION AND NOT A DROPDOWN CHANGE (DEF-0010, R-239). The
-- Access tab offered `admin` on any node the viewer administers, and
-- `set_site_member` accepted it, so a line-level admin was a person the product
-- could create. The Settings tab then had nothing to show them: its scope is a
-- PLANT, `readablePlants` keeps only `parent_id IS NULL`, and a line grant makes
-- no root readable — so `settingsScope` fell through to "company" and disabled
-- every control, for a reader whose write the server would have taken on their
-- own line. Hiding `admin` in the picker alone would leave the server accepting
-- what the screen refuses, which is R-239 broken in the other direction and is
-- the exact shape of DEF-0005 and DEF-0007. The rule has to be true on both
-- sides, and the server is the side that decides.
--
-- ⚠️ EVERY OTHER ROLE IS UNCHANGED AND STILL GOES ANYWHERE. `supervisor` and
-- `viewer` on a line or a cell are the whole point of the site-instance model
-- (D114, 0032) — a line supervisor is the ordinary case. This narrows one role,
-- the one that carries administrative authority over a place, to the level a
-- place is administered at.
--
-- ⭐ NO BACKFILL, BECAUSE THERE IS NOTHING TO BACK FILL. Measured before
-- writing this, on the live dev database:
--
--     select count(*) from profile_grants g join nodes n on n.id = g.node_id
--      where g.role = 'admin' and n.parent_id is not null;   ->  0
--
-- Neither `seed.sql` nor `dev_demo.sql` creates one. If a deployment ever has
-- them, this migration leaves them ALONE rather than deleting rows a person was
-- relying on: it refuses new ones and changes to them. Taking someone's access
-- away silently during a migration is worse than an inconsistency somebody can
-- see and fix on the Access tab.
--
-- Extracted from 0021 §4 and re-emitted whole with one block added, per
-- CLAUDE.md: never retype a function, and the last definition wins.
-- ============================================================================

create or replace function set_site_member(
  p_node_id    uuid,
  p_profile_id uuid,
  p_role       text
) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
DECLARE
  v_org   uuid;
  v_after text;
BEGIN
  IF NOT app_node_exists_in_org(p_node_id) THEN
    PERFORM api_raise('invalid_argument', 'no such node',
                      jsonb_build_object('node_id', p_node_id, 'reason', 'not found'));
  END IF;

  IF NOT app_is_admin_for(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'you do not administer this place',
                      jsonb_build_object('node_id', p_node_id));
  END IF;

  IF NOT app_profile_exists_in_org(p_profile_id) THEN
    PERFORM api_raise('invalid_argument', 'no such person',
                      jsonb_build_object('profile_id', p_profile_id, 'reason', 'not found'));
  END IF;

  IF p_role IS NULL OR p_role NOT IN ('admin', 'supervisor', 'viewer') THEN
    PERFORM api_raise('invalid_argument', 'unknown role',
                      jsonb_build_object('field', 'role', 'value', p_role));
  END IF;

  -- ⭐ 0053: `admin` ONLY AT A PLANT ROOT, and it sits here on purpose --
  -- AFTER "is that a real role" so an unknown word is still reported as an
  -- unknown word, and BEFORE the self-rule so the answer does not depend on
  -- who is asking. `invalid_argument` rather than `not_permitted`: the caller
  -- is allowed to administer this place, they have asked for a combination
  -- that does not exist.
  IF p_role = 'admin'
     AND EXISTS (SELECT 1 FROM nodes n
                  WHERE n.id = p_node_id AND n.parent_id IS NOT NULL) THEN
    PERFORM api_raise('invalid_argument',
                      'an admin runs a whole plant, so admin can only be given at a plant',
                      jsonb_build_object('field', 'role', 'value', p_role,
                                         'node_id', p_node_id,
                                         'reason', 'admin_below_root'));
  END IF;

  IF p_profile_id = app_current_profile_id()
     AND p_role <> 'admin'
     AND NOT app_is_admin()
     AND EXISTS (SELECT 1 FROM profile_grants pg
                  WHERE pg.profile_id = p_profile_id
                    AND pg.node_id    = p_node_id
                    AND pg.role       = 'admin') THEN
    PERFORM api_raise('not_permitted', 'you cannot take away your own admin access here',
                      jsonb_build_object('node_id', p_node_id, 'profile_id', p_profile_id,
                                         'reason', 'self'));
  END IF;

  v_org := app_current_org();

  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
       VALUES (p_profile_id, p_node_id, v_org, p_role)
  ON CONFLICT (profile_id, node_id) DO UPDATE SET role = EXCLUDED.role;

  SELECT pg.role INTO v_after
    FROM profile_grants pg
   WHERE pg.profile_id = p_profile_id AND pg.node_id = p_node_id;

  RETURN jsonb_build_object(
    'nodeId',    p_node_id,
    'profileId', p_profile_id,
    'role',      v_after
  );
END $$;

comment on function set_site_member(uuid, uuid, text) is
  'Give a person a role on this node''s subtree, or change the role they already hold there (0021 §4, narrowed by 0053). One row, so adding and re-roling are one function. Refuses unless the caller administers the node; refuses a site admin removing their OWN access here; and refuses `admin` anywhere but a plant root, because an admin runs a whole plant (DEF-0010). The row is read back so the returned role is what is stored, not an echo of the argument.';

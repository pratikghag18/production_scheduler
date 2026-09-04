-- ============================================================================
-- 0036 — A SITE ADMIN MAY MAKE (AND WHOLLY OWN) A PRODUCT AT THEIR OWN PLANT.
--
-- The maintainer, 2 Sept (D116). The Split (D115, 0034) put every act on the
-- shared product record — create, rename, recolour, delete — on the company
-- admin, and left a site admin only the list of makers (product_sites). The
-- maintainer reopened create: a part number is unique and there is little risk
-- in letting a plant admin add one.
--
-- But create is the BIRTH of the same company-wide identity that rename and
-- delete govern. Letting it cross the line alone would let a site admin MINT a
-- part they could then neither fix nor remove — company-wide litter only a
-- company admin could clear. So the whole lifecycle crosses together, bounded to
-- a part the site admin actually owns:
--
--   CREATE   -> a site admin creates AT a plant they administer, and the part is
--               dropped onto that plant in the same act (never an orphan).
--   RENAME   -> a site admin, but ONLY while every plant that makes the part is
--   RECOLOUR    one they administer. The moment a second plant adopts it, the
--   DELETE      identity is company-property again. A company admin: always.
--
-- app_can_edit_product_record(id) is that "sole administrator of all makers"
-- test, shared by the products UPDATE policy, the DELETE policy and the delete
-- RPC's pre-check, so the client, the policy and the RPC all decide it the same
-- way. Create is an RPC because an INSERT WITH CHECK on `products` cannot see the
-- plant — it lives in product_sites, written second — and app_is_admin_anywhere()
-- is VISIBILITY ONLY and must never authorise a write (0019 §5). The RPC gates on
-- app_is_admin_for(node), the honest per-plant test.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1. "Do I administer EVERY plant that makes this part?" — the shared test.
--
-- Company admin: always. Otherwise: the part has at least one maker plant, and
-- there is NO maker plant I do not administer (app_is_admin_for walks ancestors,
-- so a maker that is a LINE inside my plant counts). A part with no makers — an
-- orphan — is company-property, which matches the create rule that never leaves
-- one behind.
--
-- ⚠️ SECURITY DEFINER IS LOAD-BEARING, NOT A HABIT. The count of makers must be
-- the TRUE count, not the RLS-filtered one. If this read of product_sites went
-- through the caller's RLS, a maker plant the caller cannot read would vanish
-- from the "is there a maker I don't administer" check, and the caller would be
-- handed edit rights over a part another plant also makes. Definer sees every
-- maker; app_is_admin_for stays tenant-scoped, so a maker in another org counts
-- as one I don't administer and the answer is a safe `false`.
--
-- ⚠️ Reads `product_sites`, so it is safe in a policy USING/WITH CHECK on an
-- EXISTING product row — NOT in an INSERT WITH CHECK (D85). That is exactly why
-- create is an RPC (§4) and does not touch this function.
-- ---------------------------------------------------------------------------
create or replace function app_can_edit_product_record(p_product_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT app_is_admin() OR (
    EXISTS (SELECT 1 FROM product_sites ps WHERE ps.product_id = p_product_id)
    AND NOT EXISTS (
      SELECT 1 FROM product_sites ps
      WHERE ps.product_id = p_product_id
        AND NOT app_is_admin_for(ps.node_id)
    )
  );
$$;

comment on function app_can_edit_product_record(uuid) is
  'D116 (the maintainer, 2 Sept): may the caller change the shared product record — rename, recolour, delete? Company admin always; otherwise only when the part has at least one maker plant and the caller administers EVERY one (app_is_admin_for walks ancestors). An orphan part with no makers is company-property. SECURITY DEFINER is required: the maker count must be the true count, not the caller''s RLS-filtered view, or a maker on an unreadable plant would silently drop out of the "every plant" test. Reads product_sites -- safe in a policy on an existing row, NOT in an INSERT WITH CHECK (D85); create is create_product_at_node.';

-- ---------------------------------------------------------------------------
-- §2. RENAME and RECOLOUR — the products UPDATE policy widens from
-- app_is_admin() (0034 §9) to the shared test. setProductColor is a plain
-- products UPDATE, so colour follows the rename through the same policy.
-- ---------------------------------------------------------------------------
drop policy products_update on products;
create policy products_update on products for update
  using (org_id = app_current_org() and app_can_edit_product_record(id))
  with check (org_id = app_current_org() and app_can_edit_product_record(id));

-- ---------------------------------------------------------------------------
-- §3. DELETE — the products DELETE policy widens the same way. The destructive
-- work goes through delete_owned_row (SECURITY INVOKER), whose inner DELETE runs
-- under THIS policy; §5 re-emits that function so its friendly pre-check agrees.
-- ---------------------------------------------------------------------------
drop policy products_delete on products;
create policy products_delete on products for delete
  using (org_id = app_current_org() and app_can_edit_product_record(id));

-- ---------------------------------------------------------------------------
-- §4. CREATE — a site admin makes a part AT a plant they administer, and the
-- part is assigned to that plant in the same act. An RPC, because the plant the
-- create must be authorised against is not a column on `products`; the two
-- inserts (the record, then its first maker) are one transaction so a refused
-- assignment cannot leave a company-wide orphan behind.
--
-- SECURITY DEFINER, gated on app_is_admin_for(node) — the honest per-plant test
-- (true for a company admin too, so this is also a company admin's create-at-a-
-- plant path, though the company-admin screen keeps its plant-less direct
-- insert). The color_token is filled by the products_set_color_token trigger; a
-- duplicate sku raises 23505 and surfaces to the caller as DuplicateValue.
-- ---------------------------------------------------------------------------
create or replace function create_product_at_node(p_sku text, p_name text, p_node_id uuid)
returns products
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_org uuid := app_current_org();
  v_row products;
begin
  if not app_is_admin_for(p_node_id) then
    perform api_raise('not_permitted',
      'no admin rights over the plant this part would be made at',
      jsonb_build_object('node_id', p_node_id));
  end if;

  insert into products (org_id, sku, name)
    values (v_org, p_sku, p_name)
    returning * into v_row;

  insert into product_sites (org_id, product_id, node_id)
    values (v_org, v_row.id, p_node_id);

  return v_row;
end;
$$;

comment on function create_product_at_node(text, text, uuid) is
  'D116 (the maintainer, 2 Sept): create a shared product AND drop it onto one plant the caller administers, in one transaction so no company-wide orphan is left if the assignment is refused. Gated on app_is_admin_for(p_node_id) -- a company admin passes for any node, a site admin only for their own plant and its lines. SECURITY DEFINER (the two inserts bypass RLS, the gate authorises them). Colour is trigger-picked; a duplicate sku raises 23505.';

-- ---------------------------------------------------------------------------
-- §5. delete_owned_row — RE-EMITTED to change ONE thing: the product branch's
-- permission pre-check moves from app_is_admin() (0034 §10, the Split) to
-- app_can_edit_product_record(p_id), so a site admin may delete a part they
-- wholly make. Extracted with pg_get_functiondef from the live function; every
-- line but that block is byte-for-byte 0034.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_owned_row(p_kind text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY INVOKER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now    timestamptz := now();
  v_owner  uuid;
  v_found  boolean;
  v_name   text;
  v_code   text;
  v_colour text;
  v_active boolean;
  v_removes jsonb := '[]'::jsonb;
  v_keeps   jsonb := '[]'::jsonb;
  v_got     int;
  v_rm_runs int; v_rm_asg int; v_kp_runs int; v_kp_asg int;
  v_crew    int;
  v_direct  int;
  v_kp_crew int;
  v_extra   int;
  v_extra2  int;
BEGIN
  IF p_kind NOT IN ('product', 'operator', 'skill', 'shift_template') THEN
    PERFORM api_raise('invalid_argument',
      'p_kind must be one of product, operator, skill, shift_template',
      jsonb_build_object('field', 'p_kind', 'reason', format('unrecognised kind %s', p_kind)));
  END IF;

  -- Identity, RLS-filtered: an id in another tenant is "not found", the same
  -- answer as an id that never existed. A product has no owner node.
  IF p_kind = 'product' THEN
    SELECT true, NULL::uuid, p.name, p.sku, p.active INTO v_found, v_owner, v_name, v_code, v_active
      FROM products p WHERE p.id = p_id;
  ELSIF p_kind = 'operator' THEN
    SELECT true, o.site_node_id, o.display_name, o.employee_ref, o.active INTO v_found, v_owner, v_name, v_code, v_active
      FROM operators o WHERE o.id = p_id;
  ELSIF p_kind = 'skill' THEN
    SELECT true, s.site_node_id, s.name, NULL::text, s.active INTO v_found, v_owner, v_name, v_code, v_active
      FROM skills s WHERE s.id = p_id;
  ELSE
    SELECT true, t.site_node_id, t.name, NULL::text, t.active INTO v_found, v_owner, v_name, v_code, v_active
      FROM shift_templates t WHERE t.id = p_id;
  END IF;

  IF v_found IS NULL THEN
    PERFORM api_raise('invalid_argument', format('%s not found', p_kind),
      jsonb_build_object('field', 'p_id', 'reason', 'not found'));
  END IF;

  -- ⭐ D116 (the maintainer, 2 Sept). The Split (D115) let only a company admin
  -- delete a shared part. Now a site admin may too, but ONLY one they wholly
  -- make: app_can_edit_product_record is the "do I administer every plant that
  -- makes this" test, the same predicate the products UPDATE and DELETE policies
  -- use, so this pre-check and the RLS the INVOKER delete below runs under agree.
  -- The moment a second plant adopts the part its identity is company-property
  -- again and this refuses with the reason. The other three kinds keep their
  -- owner-scoped test.
  IF p_kind = 'product' THEN
    IF NOT app_can_edit_product_record(p_id) THEN
      PERFORM api_raise('not_permitted',
        'you do not administer every plant that makes this part',
        jsonb_build_object('node_id', NULL));
    END IF;
  ELSE
    IF NOT (app_is_admin() OR app_is_admin_for(v_owner)) THEN
      PERFORM api_raise('not_permitted', 'no admin rights over the site this row belongs to',
        jsonb_build_object('node_id', v_owner));
    END IF;
  END IF;

  IF p_kind = 'product' THEN
    -- ---- every count, before anything moves -------------------------------
    SELECT count(*) INTO v_rm_runs FROM runs r
      WHERE r.product_id = p_id AND lower(r.timerange) > v_now;
    SELECT count(*) INTO v_crew FROM assignments a
      WHERE a.run_id IN (SELECT r.id FROM runs r
                          WHERE r.product_id = p_id AND lower(r.timerange) > v_now);
    SELECT count(*) INTO v_direct FROM assignments a
      WHERE a.product_id = p_id AND lower(a.timerange) > v_now;
    v_rm_asg := v_crew + v_direct;

    SELECT count(*) INTO v_kp_runs FROM runs r
      WHERE r.product_id = p_id AND (lower(r.timerange) <= v_now OR lower(r.timerange) IS NULL);
    SELECT count(*) INTO v_kp_crew FROM assignments a
      WHERE a.run_id IN (SELECT r.id FROM runs r
                          WHERE r.product_id = p_id
                            AND (lower(r.timerange) <= v_now OR lower(r.timerange) IS NULL));
    SELECT count(*) INTO v_extra FROM assignments a
      WHERE a.product_id = p_id AND (lower(a.timerange) <= v_now OR lower(a.timerange) IS NULL);
    v_kp_asg := v_kp_crew + v_extra;

    SELECT p.color_token INTO v_colour FROM products p WHERE p.id = p_id;

    -- ---- 1. the crew of every run that is about to go ---------------------
    DELETE FROM assignments a
      WHERE a.run_id IN (SELECT r.id FROM runs r
                          WHERE r.product_id = p_id AND lower(r.timerange) > v_now);
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_crew THEN
      PERFORM api_raise('not_permitted', 'cannot remove every assignment on the runs this would delete',
        jsonb_build_object('node_id', v_owner));
    END IF;

    -- ---- 2. the runs themselves -------------------------------------------
    DELETE FROM runs r WHERE r.product_id = p_id AND lower(r.timerange) > v_now;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_rm_runs THEN
      PERFORM api_raise('not_permitted', 'cannot remove every run this would delete',
        jsonb_build_object('node_id', v_owner));
    END IF;

    -- ---- 3. direct assignments carrying the product -----------------------
    DELETE FROM assignments a WHERE a.product_id = p_id AND lower(a.timerange) > v_now;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_direct THEN
      PERFORM api_raise('not_permitted', 'cannot remove every assignment this would delete',
        jsonb_build_object('node_id', v_owner));
    END IF;

    -- ---- 4. whatever still carries this product has started. Remember it. --
    UPDATE runs r SET product_id = NULL, product_sku = v_code,
                      product_name = v_name, product_color_token = v_colour
      WHERE r.product_id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_kp_runs THEN
      PERFORM api_raise('not_permitted', 'cannot keep the history of every run that used this',
        jsonb_build_object('node_id', v_owner));
    END IF;

    UPDATE assignments a SET product_id = NULL, product_sku = v_code,
                             product_name = v_name, product_color_token = v_colour
      WHERE a.product_id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_extra THEN
      PERFORM api_raise('not_permitted', 'cannot keep the history of every assignment that used this',
        jsonb_build_object('node_id', v_owner));
    END IF;

    -- ---- 5. the row itself (product_sites cascades) -----------------------
    DELETE FROM products WHERE id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> 1 THEN
      PERFORM api_raise('not_permitted', 'the product itself could not be deleted',
        jsonb_build_object('node_id', v_owner));
    END IF;

    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'runs', 'count', v_rm_runs),
      jsonb_build_object('what', 'assignments', 'count', v_rm_asg));
    v_keeps := jsonb_build_array(
      jsonb_build_object('what', 'runs', 'count', v_kp_runs),
      jsonb_build_object('what', 'assignments', 'count', v_kp_asg));

  ELSIF p_kind = 'operator' THEN
    SELECT count(*) INTO v_rm_asg FROM assignments a
      WHERE a.operator_id = p_id AND lower(a.timerange) > v_now;
    SELECT count(*) INTO v_kp_asg FROM assignments a
      WHERE a.operator_id = p_id AND (lower(a.timerange) <= v_now OR lower(a.timerange) IS NULL);
    SELECT count(*) INTO v_extra FROM operator_skills os WHERE os.operator_id = p_id;

    DELETE FROM assignments a WHERE a.operator_id = p_id AND lower(a.timerange) > v_now;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_rm_asg THEN
      PERFORM api_raise('not_permitted', 'cannot remove every future assignment for this person',
        jsonb_build_object('node_id', v_owner));
    END IF;

    UPDATE assignments a SET operator_id = NULL, operator_display_name = v_name
      WHERE a.operator_id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_kp_asg THEN
      PERFORM api_raise('not_permitted', 'cannot keep the history of every assignment this person worked',
        jsonb_build_object('node_id', v_owner));
    END IF;

    DELETE FROM operators WHERE id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> 1 THEN
      PERFORM api_raise('not_permitted', 'the person could not be deleted',
        jsonb_build_object('node_id', v_owner));
    END IF;

    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'assignments', 'count', v_rm_asg),
      jsonb_build_object('what', 'operator_skills', 'count', v_extra));
    v_keeps := jsonb_build_array(
      jsonb_build_object('what', 'assignments', 'count', v_kp_asg));

  ELSIF p_kind = 'skill' THEN
    SELECT count(*) INTO v_extra  FROM operator_skills os WHERE os.skill_id = p_id;
    SELECT count(*) INTO v_extra2 FROM node_skill_requirements q WHERE q.skill_id = p_id;

    DELETE FROM skills WHERE id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> 1 THEN
      PERFORM api_raise('not_permitted', 'the training could not be deleted',
        jsonb_build_object('node_id', v_owner));
    END IF;

    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'operator_skills', 'count', v_extra),
      jsonb_build_object('what', 'node_skill_requirements', 'count', v_extra2));
    v_keeps := '[]'::jsonb;

  ELSE -- shift_template
    SELECT count(*) INTO v_extra  FROM shifts s WHERE s.template_id = p_id;
    SELECT count(*) INTO v_extra2 FROM shift_breaks b
      WHERE b.shift_id IN (SELECT s.id FROM shifts s WHERE s.template_id = p_id);
    SELECT count(*) INTO v_kp_asg FROM node_shift_templates nst WHERE nst.template_id = p_id;

    DELETE FROM shift_templates WHERE id = p_id;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> 1 THEN
      PERFORM api_raise('not_permitted', 'the shift pattern could not be deleted',
        jsonb_build_object('node_id', v_owner));
    END IF;

    v_removes := jsonb_build_array(
      jsonb_build_object('what', 'shifts', 'count', v_extra),
      jsonb_build_object('what', 'shift_breaks', 'count', v_extra2),
      jsonb_build_object('what', 'node_shift_templates', 'count', v_kp_asg));
    v_keeps := '[]'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'kind', p_kind, 'id', p_id, 'name', v_name, 'code', v_code,
    'active', v_active, 'removes', v_removes, 'keeps', v_keeps, 'deleted', true);
END;
$function$;

comment on function delete_owned_row(text, uuid) is
  'D110 + D115 + D116: delete an owned row, keeping the past. Anything not yet started is removed; anything begun keeps the row with the deleted thing''s identity copied onto it. A PRODUCT may be deleted by a company admin OR a site admin who administers every plant that makes it (D116, app_can_edit_product_record); the other three kinds keep the owner-scoped permission check. SECURITY INVOKER — see 0029''s header for the proof no escalation is needed.';

-- ---------------------------------------------------------------------------
-- §6. GRANTS. Both new functions are SECURITY DEFINER; authenticated needs
-- EXECUTE (the UPDATE/DELETE policies call the first, the create RPC is the
-- second), anon never. app_can_edit_product_record is called from inside policy
-- expressions, which check EXECUTE against the calling role, so the grant is
-- required for a policy read to succeed.
-- ---------------------------------------------------------------------------
revoke execute on function app_can_edit_product_record(uuid) from public;
revoke execute on function create_product_at_node(text, text, uuid) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_can_edit_product_record(uuid) to authenticated';
    execute 'grant execute on function create_product_at_node(text, text, uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_can_edit_product_record(uuid) from anon';
    execute 'revoke all on function create_product_at_node(text, text, uuid) from anon';
  end if;
end $$;

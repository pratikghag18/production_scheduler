-- ============================================================================
-- Migration 0007: audit log
-- Implements: design-plan.md §14.4 ("editing the past is allowed in v1 and
--   always audit-logged"), §17 D9 (admin-read-only in v1; writes only on
--   runs and assignments — the schedule mutations §14.4 promised to audit).
-- ============================================================================

CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES orgs(id),
  actor_id   uuid,                    -- auth.uid() at write time; NULL for seed/system writes
  table_name text NOT NULL,
  row_id     uuid NOT NULL,
  action     text NOT NULL CHECK (action IN ('insert','update','delete')),
  before     jsonb,
  after      jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_at_idx ON audit_log (org_id, at DESC);
CREATE INDEX audit_log_row_idx ON audit_log (table_name, row_id);

-- auth.uid() wrapped so it never throws when the auth schema/function is
-- absent (defensive; the harness and Supabase both provide it, but a bare
-- audit_current_actor() should degrade to NULL rather than fail a write).
create function audit_current_actor() returns uuid
language plpgsql stable as $$
begin
  return auth.uid();
exception when undefined_function or invalid_schema_name or undefined_table then
  return null;
end;
$$;

create function write_audit_log() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org_id uuid;
  v_row_id uuid;
begin
  if TG_OP = 'UPDATE' then
    -- Compare excluding updated_at: assignments/runs both carry an
    -- unconditional set_updated_at BEFORE trigger (migration 0003), which
    -- bumps updated_at on every UPDATE regardless of whether any other
    -- column changed. A literal to_jsonb(OLD) = to_jsonb(NEW) (as worded in
    -- the brief) would therefore never be true for any UPDATE, since
    -- updated_at always differs -- silently defeating the no-op skip this
    -- check exists for. Excluding the bookkeeping timestamp column is the
    -- only way both requirements (updated_at always bumps; a business-field
    -- no-op update writes no audit row) can hold at once.
    if (to_jsonb(OLD) - 'updated_at') = (to_jsonb(NEW) - 'updated_at') then
      return NEW;
    end if;
  end if;

  if TG_OP = 'DELETE' then
    v_org_id := OLD.org_id;
    v_row_id := OLD.id;
  else
    v_org_id := NEW.org_id;
    v_row_id := NEW.id;
  end if;

  insert into audit_log (org_id, actor_id, table_name, row_id, action, before, after)
  values (
    v_org_id,
    audit_current_actor(),
    TG_TABLE_NAME,
    v_row_id,
    lower(TG_OP),
    case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end,
    case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end
  );

  if TG_OP = 'DELETE' then
    return OLD;
  else
    return NEW;
  end if;
end;
$$;

-- v1 only audits runs and assignments (D9) — those are the schedule
-- mutations §14.4 promised to log.
create trigger runs_audit
  after insert or update or delete on runs
  for each row execute function write_audit_log();

create trigger assignments_audit
  after insert or update or delete on assignments
  for each row execute function write_audit_log();

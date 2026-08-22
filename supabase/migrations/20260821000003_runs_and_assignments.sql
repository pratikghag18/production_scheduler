-- ============================================================================
-- Migration 0003: runs and assignments
-- Implements: design-plan.md §3 (runs, assignments, query shape), §14.1
--   (hybrid A+B: run_id nullable, product_id nullable, exactly one set),
--   §14.2 (efficiency, target_qty, target_unit — folded into final shape),
--   §15.2 (a run's crew stays on the run's cell), §17 D3, D4, D5.
-- ============================================================================

-- A run: "this cell produces this product during this window."
create table runs (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id),
  node_id           uuid not null,   -- must be the schedulable level (app-enforced)
  product_id        uuid not null,
  timerange         tstzrange not null,
  planned_headcount int,
  status            text not null default 'planned'
    check (status in ('planned','active','done','cancelled')),
  notes             text,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id), -- D3: referenced by assignments
  foreign key (org_id, node_id)    references nodes (org_id, id),
  foreign key (org_id, product_id) references products (org_id, id)
);
create index runs_node_time_idx on runs using gist (node_id, timerange);
create trigger runs_set_updated_at
  before update on runs
  for each row execute function set_updated_at();

-- D4: the target cell must have no overlapping run when a run moves
-- (design-plan §15.2). A database invariant, not just a UI check.
alter table runs add constraint runs_no_overlap_on_node
  exclude using gist (node_id with =, timerange with &&)
  where (status <> 'cancelled');

-- An assignment: "this operator staffs this cell during this window."
create table assignments (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id),
  node_id             uuid not null,
  operator_id         uuid not null,
  run_id              uuid,                      -- model B: attached to a run
  product_id          uuid,                      -- model A: product carried directly
  timerange           tstzrange not null,
  status              text not null default 'planned',
  efficiency          numeric(4,3) not null default 1.000
    check (efficiency > 0 and efficiency <= 2),
  target_qty          numeric check (target_qty > 0),
  target_unit         text,
  eligibility_override boolean not null default false,
  override_reason     text,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- D5 (§14.1): a run-attached assignment inherits product from the run; a
  -- direct assignment carries its own. Exactly one, never both, never neither.
  check (num_nonnulls(run_id, product_id) = 1),
  foreign key (org_id, node_id)     references nodes (org_id, id),
  foreign key (org_id, operator_id) references operators (org_id, id),
  foreign key (org_id, run_id)      references runs (org_id, id),
  foreign key (org_id, product_id)  references products (org_id, id)
);

-- NOTE: no `no_double_booking` exclusion constraint here — the flat
-- exclusion constraint from design-plan §3 was superseded before it ever
-- shipped (§15.1). Migration 0004's `check_operator_capacity()` trigger owns
-- the operator double-booking / over-capacity invariant instead.

create index assignments_node_time_idx on assignments using gist (node_id, timerange);
create index assignments_operator_idx  on assignments (org_id, operator_id);
create index assignments_run_idx on assignments (run_id) where run_id is not null;

create trigger assignments_set_updated_at
  before update on assignments
  for each row execute function set_updated_at();

-- Keeps a run's crew on the run's cell when the run moves (§15.2): the API
-- moves run and crew together in one transaction; the database refuses a
-- half-completed move (crew left pointing at the run's old node).
create function assignments_check_run_consistency() returns trigger
language plpgsql as $$
declare
  v_run_node_id uuid;
begin
  if new.run_id is not null then
    select node_id into v_run_node_id from runs where id = new.run_id;
    if v_run_node_id is distinct from new.node_id then
      raise exception
        'assignment node_id % does not match run % node_id %',
        new.node_id, new.run_id, v_run_node_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger assignments_run_consistency
  before insert or update of run_id, node_id on assignments
  for each row execute function assignments_check_run_consistency();

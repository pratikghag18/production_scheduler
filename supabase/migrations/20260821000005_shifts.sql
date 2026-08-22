-- ============================================================================
-- Migration 0005: shifts
-- Implements: design-plan.md §16.1 (shift_templates, shifts, shift_breaks,
--   node_shift_templates; nearest-ancestor resolution), §16.3 (non-overlap
--   validation on save becomes a database invariant), §17 D7, D12.
-- ============================================================================

create table shift_templates (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id), -- D7
  name       text not null,
  updated_at timestamptz not null default now(),
  unique (org_id, name),
  unique (org_id, id) -- referenced by shifts, node_shift_templates
);
create trigger shift_templates_set_updated_at
  before update on shift_templates
  for each row execute function set_updated_at();

create table shifts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id), -- D7
  template_id uuid not null,
  name        text not null,
  start_min   smallint not null check (start_min >= 0 and start_min < 1440),
  end_min     smallint not null,
  updated_at  timestamptz not null default now(),
  check (end_min > start_min and end_min - start_min <= 1440),
  unique (org_id, id), -- referenced by shift_breaks
  foreign key (org_id, template_id) references shift_templates (org_id, id) on delete cascade
);
create trigger shifts_set_updated_at
  before update on shifts
  for each row execute function set_updated_at();

-- D12 / §16.3: shifts within one template must not overlap. Made a database
-- invariant so the admin editor is not the only thing enforcing it.
alter table shifts add constraint shifts_no_overlap_within_template
  exclude using gist (template_id with =, int4range(start_min, end_min) with &&);

create table shift_breaks (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id), -- D7
  shift_id   uuid not null,
  name       text not null default 'Break',
  start_min  smallint not null,
  end_min    smallint not null,
  updated_at timestamptz not null default now(),
  check (end_min > start_min),
  foreign key (org_id, shift_id) references shifts (org_id, id) on delete cascade
);
create trigger shift_breaks_set_updated_at
  before update on shift_breaks
  for each row execute function set_updated_at();
-- NOTE: "break lies inside its shift" stays application-validated (§16.1) —
-- not a database constraint in v1.

create table node_shift_templates (
  node_id     uuid primary key,
  org_id      uuid not null references orgs(id), -- D7
  template_id uuid not null,
  updated_at  timestamptz not null default now(),
  foreign key (org_id, node_id)     references nodes (org_id, id),
  foreign key (org_id, template_id) references shift_templates (org_id, id)
);
create trigger node_shift_templates_set_updated_at
  before update on node_shift_templates
  for each row execute function set_updated_at();

-- D12: nearest-ancestor-wins resolution, the same ltree mechanic as skill
-- requirements (§6).
create function resolve_shift_template(p_node_id uuid) returns uuid
language sql stable as $$
  SELECT nst.template_id
  FROM nodes target
  JOIN nodes anc ON target.path <@ anc.path AND anc.org_id = target.org_id
  JOIN node_shift_templates nst ON nst.node_id = anc.id
  WHERE target.id = p_node_id
  ORDER BY nlevel(anc.path) DESC
  LIMIT 1;
$$;

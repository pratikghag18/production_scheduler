-- ============================================================================
-- Migration 0002: people, products, skills
-- Implements: design-plan.md §3 (operators, products), §6 (skills,
--   operator_skills, node_skill_requirements), §17 D3 (composite tenant
--   FKs), D7 (org_id on join tables even though derivable).
-- ============================================================================

create table operators (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id),
  home_node_id uuid references nodes(id),
  display_name text not null,
  employee_ref text,
  source       text not null default 'manual',
  external_id  text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, external_id),
  unique (org_id, id), -- D3: referenced by assignments
  foreign key (org_id, home_node_id) references nodes (org_id, id)
);
create index operators_org_home_node_idx on operators (org_id, home_node_id);
create trigger operators_set_updated_at
  before update on operators
  for each row execute function set_updated_at();

create table products (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id),
  sku         text not null,
  name        text not null,
  source      text not null default 'manual',
  external_id text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, sku),
  unique (org_id, id) -- D3: referenced by runs, assignments
);
create trigger products_set_updated_at
  before update on products
  for each row execute function set_updated_at();

create table skills (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id),
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name),
  unique (org_id, id) -- D3: referenced by operator_skills, node_skill_requirements
);
create trigger skills_set_updated_at
  before update on skills
  for each row execute function set_updated_at();

create table operator_skills (
  operator_id  uuid not null,
  skill_id     uuid not null,
  org_id       uuid not null references orgs(id), -- D7
  certified_at date,
  expires_at   date, -- NULL = no expiry
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (operator_id, skill_id),
  foreign key (org_id, operator_id) references operators (org_id, id),
  foreign key (org_id, skill_id)    references skills (org_id, id)
);
create trigger operator_skills_set_updated_at
  before update on operator_skills
  for each row execute function set_updated_at();

-- Requirements attach to ANY node and inherit downward — a requirement on a
-- Line applies to every cell under it (nearest-ancestor union query, §6).
create table node_skill_requirements (
  node_id    uuid not null,
  skill_id   uuid not null,
  org_id     uuid not null references orgs(id), -- D7
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (node_id, skill_id),
  foreign key (org_id, node_id)  references nodes (org_id, id),
  foreign key (org_id, skill_id) references skills (org_id, id)
);
create trigger node_skill_requirements_set_updated_at
  before update on node_skill_requirements
  for each row execute function set_updated_at();

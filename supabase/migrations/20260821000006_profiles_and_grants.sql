-- ============================================================================
-- Migration 0006: profiles and grants
-- Implements: design-plan.md §14.3 (user_profiles, profile_grants — subtree
--   visibility and edit rights), §17 D1 (user_id uuid FK to auth.users
--   instead of a free-text user_ref), D3 (composite tenant FKs).
-- ============================================================================

create table user_profiles (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references orgs(id),
  user_id              uuid not null references auth.users(id) on delete cascade, -- D1
  role                 text not null default 'supervisor'
    check (role in ('admin','supervisor','viewer')),
  default_create_mode  text not null default 'run'
    check (default_create_mode in ('run','direct')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, user_id), -- D1
  unique (org_id, id)       -- D3: referenced by profile_grants
);
create index user_profiles_user_id_idx on user_profiles (user_id); -- every RLS check hits this
create trigger user_profiles_set_updated_at
  before update on user_profiles
  for each row execute function set_updated_at();

create table profile_grants (
  profile_id uuid not null,
  node_id    uuid not null,
  org_id     uuid not null references orgs(id), -- D7
  can_edit   boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (profile_id, node_id),
  foreign key (org_id, profile_id) references user_profiles (org_id, id),
  foreign key (org_id, node_id)    references nodes (org_id, id)
);
create index profile_grants_profile_id_idx on profile_grants (profile_id);
create trigger profile_grants_set_updated_at
  before update on profile_grants
  for each row execute function set_updated_at();

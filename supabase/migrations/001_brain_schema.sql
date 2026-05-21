-- Brain schema for cursor-sdk-chat (gbrain-inspired, simplified)

create extension if not exists "pgcrypto";

create table if not exists entities (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  slug text not null,
  type text not null,
  display_name text not null,
  aliases jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create index if not exists entities_workspace_type_idx on entities (workspace_id, type);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  source text not null,
  event_type text not null,
  title text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists events_workspace_occurred_idx on events (workspace_id, occurred_at desc);
create index if not exists events_source_idx on events (workspace_id, source);

create table if not exists facts (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  entity_id uuid references entities (id) on delete cascade,
  field text not null,
  value text not null,
  confidence real not null default 1.0,
  provenance text,
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists facts_workspace_entity_idx on facts (workspace_id, entity_id);

create table if not exists relationships (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  from_entity_id uuid not null references entities (id) on delete cascade,
  to_entity_id uuid not null references entities (id) on delete cascade,
  relationship_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, from_entity_id, to_entity_id, relationship_type)
);

create table if not exists workspace_context (
  workspace_id text primary key,
  current_focus text,
  compiled_summary text not null default '',
  updated_at timestamptz not null default now()
);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists entities_updated_at on entities;
create trigger entities_updated_at
  before update on entities
  for each row execute function set_updated_at();

drop trigger if exists facts_updated_at on facts;
create trigger facts_updated_at
  before update on facts
  for each row execute function set_updated_at();

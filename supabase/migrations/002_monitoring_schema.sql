-- Monitoring schema: Jira epic watchers + per-issue status snapshots.

create table if not exists monitored_epics (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  epic_key text not null,
  epic_summary text,
  jira_base_url text,
  telegram_chat_id text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  last_checked_at timestamptz,
  unique (workspace_id, epic_key)
);

create index if not exists monitored_epics_status_idx on monitored_epics (status);

create table if not exists monitored_issue_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  epic_key text not null,
  issue_key text not null,
  summary text,
  status text,
  assignee text,
  resolution text,
  is_epic boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (workspace_id, epic_key, issue_key)
);

create index if not exists monitored_issue_state_epic_idx
  on monitored_issue_state (workspace_id, epic_key);

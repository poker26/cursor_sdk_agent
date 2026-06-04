-- Per-epic Jira poll interval (milliseconds).

alter table monitored_epics
  add column if not exists poll_interval_ms bigint not null default 1800000;

comment on column monitored_epics.poll_interval_ms is
  'How often to poll this epic (ms). Default 30 min. Set via chat, e.g. «раз в сутки».';

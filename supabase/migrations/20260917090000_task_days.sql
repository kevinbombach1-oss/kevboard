-- Daily tasks, one row per planned day. Serves both as the sync source
-- between devices and as the history behind the task statistics; the
-- dashboard still works from localStorage and mirrors each day here.

create table public.task_days (
  day date primary key,                     -- planned day (6 AM boundary)
  tasks jsonb not null default '[]'::jsonb, -- the list as stored locally, incl. doneAt
  moved jsonb not null default '[]'::jsonb, -- pushed to the next day; count as not done
  rolled_over boolean not null default false, -- a device already carried this day forward
  updated_at timestamptz not null default now(),
  updated_by text                           -- device id of the last writer
);

alter table public.task_days enable row level security;
create policy authenticated_full_access on public.task_days for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.task_days to authenticated;
revoke all on public.task_days from anon;

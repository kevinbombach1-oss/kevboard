-- Streams, splits and the Strava connection behind the Laufen tab.

-- Raw per-second samples from the Strava streams API, one row per run.
create table public.run_streams (
  run_id uuid primary key references public.runs(id) on delete cascade,
  time integer[],
  distance real[],
  heartrate smallint[],
  velocity real[],
  cadence smallint[],
  altitude real[],
  latlng jsonb,            -- [[lat, lng], ...]
  created_at timestamptz not null default now()
);

-- Per-kilometre splits derived from the streams. The last split can be
-- shorter than 1000 m; distance_m says how long it really was.
create table public.run_splits (
  run_id uuid not null references public.runs(id) on delete cascade,
  km smallint not null check (km >= 1),
  distance_m real not null,
  duration_sec real not null,
  avg_hr real,
  elevation_diff real,
  primary key (run_id, km)
);

-- Fastest stretches inside each run, from the streams (not whole runs).
alter table public.runs
  add column if not exists best_1k_s real,
  add column if not exists best_5k_s real,
  add column if not exists best_10k_s real;

-- Max HR for the Karvonen zones; resting_hr already lives in settings.
alter table public.settings
  add column if not exists max_hr smallint check (max_hr between 100 and 240);

alter table public.run_streams enable row level security;
alter table public.run_splits enable row level security;
create policy authenticated_full_access on public.run_streams for all to authenticated using (true) with check (true);
create policy authenticated_full_access on public.run_splits for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.run_streams, public.run_splits to authenticated;
revoke all on public.run_streams, public.run_splits from anon;

-- Strava OAuth tokens and pending OAuth states. Only the edge function
-- (service role) touches these; the browser has no grants at all.
create table public.strava_tokens (
  id boolean primary key default true check (id),
  athlete_id bigint not null,
  athlete_name text,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text,
  last_sync_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.strava_oauth_states (
  state text primary key,
  return_to text not null,
  created_at timestamptz not null default now()
);

alter table public.strava_tokens enable row level security;
alter table public.strava_oauth_states enable row level security;
revoke all on public.strava_tokens, public.strava_oauth_states from anon, authenticated;

-- Prepares the existing runs table for the dashboard's Laufen tab and a
-- later Strava sync. The table already holds runs (and Swagtrain may write
-- to it), so it is extended rather than replaced: distance and duration
-- stay in metres and seconds, and km / pace are derived in the UI.

alter table public.runs
  add column if not exists strava_id bigint,
  add column if not exists source text not null default 'manual';

alter table public.runs
  add constraint runs_source_check check (source in ('manual', 'strava')),
  add constraint runs_strava_id_key unique (strava_id);

comment on column public.runs.strava_id is 'Strava activity id; null for runs entered by hand';
comment on column public.runs.source is 'Where the run came from: manual or strava';

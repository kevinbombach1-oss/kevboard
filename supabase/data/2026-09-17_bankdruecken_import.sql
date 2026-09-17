-- Bankdrücken-Sätze vom 12.06. bis 20.08.2026 nachtragen.
-- Pro Datum entsteht ein Workout mit einer Übung und zwei Arbeitssätzen.
--
-- Damals wurde nicht zwischen den Gyms unterschieden, und das Gewicht
-- bedeutet in beiden dasselbe. Die Sätze hängen deshalb an einem Gym
-- (Husum); im Dashboard zeigt der Filter "Alle" beide zusammen.

with data(d, set_index, weight_kg, reps) as (values
  (date '2026-06-12', 0, 80, 5),
  (date '2026-06-12', 1, 80, 7),
  (date '2026-06-19', 0, 80, 6),
  (date '2026-06-19', 1, 80, 5),
  (date '2026-07-03', 0, 80, 8),
  (date '2026-07-03', 1, 80, 8),
  (date '2026-07-09', 0, 80, 8),
  (date '2026-07-09', 1, 80, 6),
  (date '2026-08-03', 0, 85, 4),
  (date '2026-08-03', 1, 80, 8),
  (date '2026-08-07', 0, 85, 5),
  (date '2026-08-07', 1, 85, 5),
  (date '2026-08-11', 0, 85, 5),
  (date '2026-08-11', 1, 85, 5),
  (date '2026-08-14', 0, 85, 5),
  (date '2026-08-14', 1, 85, 6),
  (date '2026-08-20', 0, 85, 5),
  (date '2026-08-20', 1, 85, 6)
),
gym as (
  -- HIER das richtige Gym wählen:
  select id from gyms where name ilike '%Husum%' limit 1
),
ex as (
  select id from exercises where name = 'Bankdrücken' limit 1
),
days as (select distinct d from data),
new_workouts as (
  insert into workouts (gym_id, performed_at, finished_at)
  select (select id from gym),
         (d + time '12:00') at time zone 'Europe/Berlin',
         (d + time '13:00') at time zone 'Europe/Berlin'
  from days
  returning id, performed_at
),
new_we as (
  insert into workout_exercises (workout_id, exercise_id, position)
  select w.id, (select id from ex), 0 from new_workouts w
  returning id, workout_id
)
insert into workout_sets (workout_exercise_id, set_index, reps, weight_kg, is_warmup)
select new_we.id, data.set_index, data.reps, data.weight_kg, false
from data
join new_workouts w on ((w.performed_at at time zone 'Europe/Berlin')::date) = data.d
join new_we on new_we.workout_id = w.id;

-- Trainingstage markieren (wie beim übrigen Bestand).
insert into activity_days (day, kind, source)
select distinct d, 'training', 'import-2026-09-17'
from (values
  (date '2026-06-12'), (date '2026-06-19'), (date '2026-07-03'), (date '2026-07-09'),
  (date '2026-08-03'), (date '2026-08-07'), (date '2026-08-11'), (date '2026-08-14'),
  (date '2026-08-20')
) as t(d)
on conflict (day, kind) do nothing;

-- Kontrolle:
-- select w.performed_at::date, s.set_index, s.weight_kg, s.reps
-- from workout_sets s
-- join workout_exercises we on we.id = s.workout_exercise_id
-- join workouts w on w.id = we.workout_id
-- join exercises e on e.id = we.exercise_id
-- where e.name = 'Bankdrücken' and w.performed_at < '2026-08-22'
-- order by w.performed_at, s.set_index;

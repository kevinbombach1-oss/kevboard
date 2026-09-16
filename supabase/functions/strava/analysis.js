// Pure stream maths, kept free of Deno APIs so it can be tested in a browser.

// Cumulative moving time per sample. Strava's `time` stream keeps running
// while paused; the `moving` stream marks those samples, and splits and
// best efforts should not include the time spent standing at a light.
export function movingTime(time, moving) {
  const out = new Array(time.length);
  out[0] = 0;
  for (let i = 1; i < time.length; i++) {
    const dt = time[i] - time[i - 1];
    out[i] = out[i - 1] + (moving && moving[i] === false ? 0 : dt);
  }
  return out;
}

// Per-kilometre splits. Boundaries are interpolated between samples; the
// final partial kilometre is kept when it is at least 50 m long.
export function computeSplits(time, distance, heartrate, altitude, moving) {
  const n = Math.min(time.length, distance.length);
  if (n < 2) return [];
  const mt = movingTime(time.slice(0, n), moving);
  const splits = [];

  let km = 1;
  let startT = mt[0];
  let startAlt = altitude ? altitude[0] : null;
  let hrSum = 0, hrWeight = 0;

  const hrAvg = () => (hrWeight > 0 ? hrSum / hrWeight : null);

  for (let i = 1; i < n; i++) {
    const dt = mt[i] - mt[i - 1];
    if (heartrate && heartrate[i] != null && dt > 0) {
      hrSum += heartrate[i] * dt;
      hrWeight += dt;
    }
    while (distance[i] >= km * 1000 && distance[i] > distance[i - 1]) {
      const f = (km * 1000 - distance[i - 1]) / (distance[i] - distance[i - 1]);
      const t = mt[i - 1] + (mt[i] - mt[i - 1]) * f;
      const alt = altitude ? altitude[i - 1] + (altitude[i] - altitude[i - 1]) * f : null;
      splits.push({
        km,
        distance_m: 1000,
        duration_sec: round1(t - startT),
        avg_hr: roundOrNull(hrAvg()),
        elevation_diff: alt == null || startAlt == null ? null : round1(alt - startAlt)
      });
      startT = t;
      startAlt = alt;
      hrSum = 0; hrWeight = 0;
      km++;
    }
  }

  const rest = distance[n - 1] - (km - 1) * 1000;
  if (rest >= 50) {
    splits.push({
      km,
      distance_m: round1(rest),
      duration_sec: round1(mt[n - 1] - startT),
      avg_hr: roundOrNull(hrAvg()),
      elevation_diff: altitude && startAlt != null ? round1(altitude[n - 1] - startAlt) : null
    });
  }
  return splits;
}

// Fastest continuous stretch of `meters` anywhere in the run, in seconds of
// moving time, or null when the run is shorter. Two pointers over the
// distance stream; the start is interpolated so the stretch is exact.
export function bestEffort(time, distance, meters, moving) {
  const n = Math.min(time.length, distance.length);
  if (n < 2 || distance[n - 1] - distance[0] < meters) return null;
  const mt = movingTime(time.slice(0, n), moving);
  let best = Infinity;
  let i = 0;
  for (let j = 1; j < n; j++) {
    while (i + 1 < j && distance[j] - distance[i + 1] >= meters) i++;
    if (distance[j] - distance[i] < meters) continue;
    const target = distance[j] - meters;
    const span = distance[i + 1] - distance[i];
    const f = span > 0 ? (target - distance[i]) / span : 0;
    const tStart = mt[i] + (mt[i + 1] - mt[i]) * f;
    const t = mt[j] - tStart;
    if (t > 0 && t < best) best = t;
  }
  return best === Infinity ? null : round1(best);
}

function round1(v) { return Math.round(v * 10) / 10; }
function roundOrNull(v) { return v == null ? null : round1(v); }

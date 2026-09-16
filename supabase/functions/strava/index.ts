// Strava connection for the dashboard's Laufen tab.
//
//   GET  ?action=callback   Strava's OAuth redirect (no Supabase session)
//   POST { action: 'status' | 'connect' | 'sync' | 'disconnect' }
//        called from the dashboard with the logged-in user's JWT
//
// The client secret and the tokens never reach the browser: the secret is a
// function secret, and the tokens live in tables the browser has no grants on.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { bestEffort, computeSplits } from './analysis.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CLIENT_ID = Deno.env.get('STRAVA_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('STRAVA_CLIENT_SECRET') ?? '';
const CALLBACK_URL = `${SUPABASE_URL}/functions/v1/strava?action=callback`;

const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);
const STREAM_KEYS = 'time,distance,heartrate,velocity_smooth,cadence,altitude,latlng,moving';
// Strava allows 100 requests per 15 minutes; one sync call stays well below.
const MAX_LIST_PAGES = 5;
const STREAMS_PER_CALL = 15;
const STATE_TTL_MS = 15 * 60 * 1000;

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

class StravaError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  try {
    if (req.method === 'GET' && url.searchParams.get('action') === 'callback') {
      return await handleCallback(url);
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    // verify_jwt is off for the whole function because Strava's redirect
    // carries no session, so every other action checks the user itself.
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: userData, error: userError } = jwt
      ? await db.auth.getUser(jwt)
      : { data: { user: null }, error: new Error('missing token') };
    if (userError || !userData.user) return json({ error: 'Nicht angemeldet' }, 401);

    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case 'status': return json(await status());
      case 'connect': return json(await connect(body.return_to));
      case 'sync': return json(await sync());
      case 'disconnect': return json(await disconnect());
      default: return json({ error: 'Unbekannte Aktion' }, 400);
    }
  } catch (e) {
    const code = e instanceof StravaError ? 502 : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, code);
  }
});

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

function configured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

async function status() {
  const { data } = await db.from('strava_tokens').select('athlete_name, last_sync_at').maybeSingle();
  return {
    configured: configured(),
    connected: Boolean(data),
    athlete_name: data?.athlete_name ?? null,
    last_sync_at: data?.last_sync_at ?? null
  };
}

async function connect(returnTo: unknown) {
  if (!configured()) throw new Error('STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET fehlen in den Function-Secrets');
  if (typeof returnTo !== 'string') throw new Error('return_to fehlt');
  const target = new URL(returnTo);
  const local = target.hostname === 'localhost' || target.hostname === '127.0.0.1';
  if (target.protocol !== 'https:' && !(local && target.protocol === 'http:')) {
    throw new Error('return_to muss https sein');
  }

  const state = crypto.randomUUID();
  await db.from('strava_oauth_states').delete().lt('created_at', new Date(Date.now() - STATE_TTL_MS).toISOString());
  const { error } = await db.from('strava_oauth_states').insert({ state, return_to: target.toString() });
  if (error) throw error;

  const authorize = new URL('https://www.strava.com/oauth/authorize');
  authorize.searchParams.set('client_id', CLIENT_ID);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', CALLBACK_URL);
  authorize.searchParams.set('approval_prompt', 'auto');
  authorize.searchParams.set('scope', 'read,activity:read_all');
  authorize.searchParams.set('state', state);
  return { url: authorize.toString() };
}

// The state row proves the redirect belongs to a flow a logged-in user
// started; without it anyone could attach their own Strava account.
async function handleCallback(url: URL) {
  const state = url.searchParams.get('state') ?? '';
  const { data: row } = await db.from('strava_oauth_states').select('return_to, created_at').eq('state', state).maybeSingle();
  if (!row || Date.now() - new Date(row.created_at).getTime() > STATE_TTL_MS) {
    return new Response('Ungültiger oder abgelaufener Strava-Login. Bitte im Dashboard neu verbinden.', { status: 400 });
  }
  await db.from('strava_oauth_states').delete().eq('state', state);

  const back = (result: string) => Response.redirect(`${row.return_to.split('#')[0]}#strava=${result}`, 302);

  const code = url.searchParams.get('code');
  const scope = url.searchParams.get('scope') ?? '';
  if (url.searchParams.get('error') || !code) return back('abgelehnt');
  if (!scope.includes('activity:read')) return back('ohne-aktivitaeten');

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: 'authorization_code' })
  });
  if (!res.ok) return back('fehler');
  const tok = await res.json();

  const { error } = await db.from('strava_tokens').upsert({
    id: true,
    athlete_id: tok.athlete?.id,
    athlete_name: [tok.athlete?.firstname, tok.athlete?.lastname].filter(Boolean).join(' ') || null,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: new Date(tok.expires_at * 1000).toISOString(),
    scope,
    updated_at: new Date().toISOString()
  });
  return back(error ? 'fehler' : 'verbunden');
}

async function disconnect() {
  const { data } = await db.from('strava_tokens').select('access_token').maybeSingle();
  if (data) {
    // Best effort: revoke on Strava's side too. Runs already synced stay.
    await fetch('https://www.strava.com/oauth/deauthorize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${data.access_token}` }
    }).catch(() => {});
  }
  await db.from('strava_tokens').delete().eq('id', true);
  return { connected: false };
}

async function accessToken() {
  const { data: tok } = await db.from('strava_tokens').select('*').maybeSingle();
  if (!tok) throw new Error('Strava ist nicht verbunden');
  if (new Date(tok.expires_at).getTime() - Date.now() > 60_000) return tok.access_token as string;

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token
    })
  });
  if (!res.ok) throw new StravaError(`Token-Erneuerung fehlgeschlagen (${res.status})`, res.status);
  const fresh = await res.json();
  await db.from('strava_tokens').update({
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    expires_at: new Date(fresh.expires_at * 1000).toISOString(),
    updated_at: new Date().toISOString()
  }).eq('id', true);
  return fresh.access_token as string;
}

async function strava(path: string, token: string) {
  const res = await fetch(`https://www.strava.com/api/v3${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new StravaError(`Strava ${path.split('?')[0]} antwortet ${res.status}`, res.status);
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

const berlinDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' });

function runType(workoutType: number | null) {
  if (workoutType === 1) return 'race';
  if (workoutType === 2) return 'long';
  if (workoutType === 3) return 'tempo';
  return 'easy';
}

function intInRange(v: unknown, min: number, max: number) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  const r = Math.round(v);
  return r >= min && r <= max ? r : null;
}

async function sync() {
  const token = await accessToken();
  const result = {
    imported: 0, updated: 0, matched: 0,
    streams_fetched: 0, streams_remaining: 0,
    rate_limited: false
  };

  // 1. Activity list. Re-read a week before the newest synced run so late
  //    uploads and edits are picked up; on the first sync read everything.
  const { data: newest } = await db.from('runs').select('performed_at')
    .eq('source', 'strava').order('performed_at', { ascending: false }).limit(1).maybeSingle();
  const after = newest ? Math.floor(new Date(newest.performed_at).getTime() / 1000) - 7 * 86400 : 0;

  try {
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const acts = await strava(`/athlete/activities?after=${after}&per_page=100&page=${page}`, token);
      for (const act of acts) {
        if (!RUN_TYPES.has(act.sport_type ?? act.type)) continue;
        const outcome = await upsertActivity(act);
        if (outcome) result[outcome]++;
      }
      if (acts.length < 100) break;
    }

    // 2. Streams for runs that have none yet, newest first. A row with no
    //    samples marks activities Strava has no streams for, so they are
    //    not requested again on every sync.
    const { data: pending } = await db.from('runs')
      .select('id, strava_id, run_streams(run_id)')
      .eq('source', 'strava')
      .order('performed_at', { ascending: false });
    const missing = (pending ?? []).filter((r) => !r.run_streams);
    for (const run of missing.slice(0, STREAMS_PER_CALL)) {
      await fetchStreams(run.id, run.strava_id, token);
      result.streams_fetched++;
    }
    result.streams_remaining = Math.max(0, missing.length - result.streams_fetched);
  } catch (e) {
    if (e instanceof StravaError && e.status === 429) result.rate_limited = true;
    else throw e;
  }

  await db.from('strava_tokens').update({ last_sync_at: new Date().toISOString() }).eq('id', true);
  return result;
}

// Returns which counter the activity moved, or null when it was skipped.
async function upsertActivity(act: any): Promise<'imported' | 'updated' | 'matched' | null> {
  const distance = intInRange(act.distance, 100, 500000);
  const duration = intInRange(act.moving_time, 30, 200000);
  if (distance == null || duration == null) return null;

  const fields = {
    performed_at: act.start_date,
    distance_m: distance,
    duration_s: duration,
    avg_hr: intInRange(act.average_heartrate, 60, 240),
    elevation_gain_m: intInRange(act.total_elevation_gain, 0, 10000),
    strava_id: act.id,
    source: 'strava'
  };
  const day = berlinDay.format(new Date(act.start_date));
  await db.from('activity_days').upsert({ day, kind: 'lauf', source: 'strava' }, { onConflict: 'day,kind', ignoreDuplicates: true });

  const { data: known } = await db.from('runs').select('id').eq('strava_id', act.id).maybeSingle();
  if (known) {
    await db.from('runs').update(fields).eq('id', known.id);
    return 'updated';
  }

  // A run typed in by hand on the same day with about the same distance is
  // the same run: adopt it instead of creating a duplicate. Its run type
  // and notes are kept.
  const dayStart = new Date(new Date(act.start_date).getTime() - 36 * 3600_000).toISOString();
  const dayEnd = new Date(new Date(act.start_date).getTime() + 36 * 3600_000).toISOString();
  const { data: candidates } = await db.from('runs').select('id, performed_at, distance_m')
    .eq('source', 'manual').is('strava_id', null)
    .gte('performed_at', dayStart).lte('performed_at', dayEnd);
  const tolerance = Math.max(300, distance * 0.05);
  const twin = (candidates ?? []).find((r) =>
    berlinDay.format(new Date(r.performed_at)) === day && Math.abs(r.distance_m - distance) <= tolerance);
  if (twin) {
    await db.from('runs').update(fields).eq('id', twin.id);
    return 'matched';
  }

  const { error } = await db.from('runs').insert({
    ...fields,
    run_type: runType(act.workout_type ?? null),
    notes: act.name ? String(act.name).slice(0, 2000) : null
  });
  if (error) throw error;
  return 'imported';
}

async function fetchStreams(runId: string, stravaId: number, token: string) {
  let s: Record<string, { data: unknown[] }> = {};
  try {
    s = await strava(`/activities/${stravaId}/streams?keys=${STREAM_KEYS}&key_by_type=true`, token);
  } catch (e) {
    // 404: manual Strava entries have no streams. Anything else bubbles up.
    if (!(e instanceof StravaError && e.status === 404)) throw e;
  }

  const col = (k: string) => (s[k]?.data as any[]) ?? null;
  const time = col('time') as number[] | null;
  const distance = col('distance') as number[] | null;
  const heartrate = col('heartrate') as number[] | null;
  const altitude = col('altitude') as number[] | null;
  const moving = col('moving') as boolean[] | null;

  const { error } = await db.from('run_streams').upsert({
    run_id: runId,
    time,
    distance,
    heartrate,
    velocity: col('velocity_smooth'),
    cadence: col('cadence'),
    altitude,
    latlng: col('latlng')
  });
  if (error) throw error;

  if (!time || !distance) return;

  const splits = computeSplits(time, distance, heartrate, altitude, moving);
  await db.from('run_splits').delete().eq('run_id', runId);
  if (splits.length) {
    const { error: splitError } = await db.from('run_splits').insert(splits.map((sp) => ({ run_id: runId, ...sp })));
    if (splitError) throw splitError;
  }
  await db.from('runs').update({
    best_1k_s: bestEffort(time, distance, 1000, moving),
    best_5k_s: bestEffort(time, distance, 5000, moving),
    best_10k_s: bestEffort(time, distance, 10000, moving)
  }).eq('id', runId);
}

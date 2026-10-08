// server.js - Anti-Cheat Verified Speedrun Leaderboard Backend
//
// Anti-cheat layers:
//  1. Run seeds: only intact vanilla seeds may enter the leaderboard.
//  2. Live run tracking: while a run is going, the game reports its timer,
//     position and item count every couple of seconds. The server stamps each
//     report with its own clock and checks timer drift, movement speed,
//     heartbeat coverage and item counts. Failing a hard check marks the run
//     unverified.
//  3. Review: a run that would enter the top 10 stays hidden ("pending") until
//     a developer approves it after watching its replay. Devs can also remove
//     runs and ban players.
export const schema = `
  CREATE TABLE IF NOT EXISTS leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    final_time TEXT NOT NULL,
    elapsed_ms INTEGER NOT NULL,
    completion_percent INTEGER NOT NULL DEFAULT 100,
    items_collected INTEGER NOT NULL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leaderboard_time ON leaderboard (elapsed_ms ASC);

  CREATE TABLE IF NOT EXISTS run_sessions (
    run_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    total_items INTEGER NOT NULL DEFAULT 0,
    completion_percent INTEGER NOT NULL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 1,
    invalid_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_run_sessions_started ON run_sessions (started_at DESC);

  CREATE TABLE IF NOT EXISTS replay_claims (
    token TEXT PRIMARY KEY,
    leaderboard_id INTEGER NOT NULL,
    user_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS replays (
    user_key TEXT PRIMARY KEY,
    leaderboard_id INTEGER NOT NULL,
    video_url TEXT NOT NULL,
    data_url TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS run_seeds (
    leaderboard_id INTEGER PRIMARY KEY,
    seed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS run_track (
    run_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    beats INTEGER NOT NULL DEFAULT 0,
    last_elapsed INTEGER NOT NULL DEFAULT 0,
    last_x REAL,
    last_z REAL,
    dist REAL NOT NULL DEFAULT 0,
    bursts INTEGER NOT NULL DEFAULT 0,
    max_collected INTEGER NOT NULL DEFAULT 0,
    early_offset INTEGER,
    recent_offsets TEXT NOT NULL DEFAULT '[]',
    flags TEXT NOT NULL DEFAULT '[]',
    hard INTEGER NOT NULL DEFAULT 0,
    finish_elapsed INTEGER,
    finish_server_ms INTEGER
  );

  CREATE TABLE IF NOT EXISTS lb_review (
    leaderboard_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    reasons TEXT NOT NULL DEFAULT '[]',
    reviewed_by TEXT,
    reviewed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS banned_users (
    user_key TEXT PRIMARY KEY,
    username TEXT,
    banned_by TEXT,
    created_at INTEGER NOT NULL
  );
`;

const REPLAY_TOP_N = 10;
const REPLAY_MAX_MS = 5 * 60 * 1000;
const REPLAY_CLAIM_TTL = 30 * 60 * 1000;
const REVIEW_TOP_N = 10;           // runs that would place this high need a dev's approval
const MIN_PHYSICS_FLOOR_MS = 9500; // minimum possible time to complete any valid list

// ---- Live run tracking limits ----
const BEAT_MS = 2000;              // the game reports every 2 s
const TIMER_AHEAD_TOL_MS = 5000;   // timer may lead the server by the start request's lag
const TIMER_DRIFT_TOL_MS = 3000;   // how far the timer may fall behind the server clock over a run
const MAX_BURST_SPEED = 75;        // m/s; above every legit boost stack -> teleport
const MIN_TELEPORT_M = 40;         // ...and far enough that it isn't physics jitter
const WARN_SPEED = 40;             // m/s; legal only with stacked boosts, noted for reviewers
const MAX_AVG_SPEED = 14;          // m/s averaged over the whole run
const MIN_BEAT_COVERAGE = 0.5;     // share of expected heartbeats that must arrive

const DEVS = ["kotsoft", "memetemple", "rick_deckard"];
const isDev = (name) => !!name && DEVS.includes(String(name).toLowerCase());

const userKeyOf = (userId, username) => (userId ? String(userId) : String(username || ""));
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// ---- Leaderboard view ----
// This is the project's persistent env.DB, never a seed/revision/localStorage
// database. Keep the same tables and relative API contract across v37+ updates.
// Walks every surviving run fastest-first and builds two lists:
//  candidates: each player's best run that isn't removed (what the top would
//              be if every pending run were approved) - used for review & replays
//  shown:      what the public sees. Inside the top 10 only approved runs
//              appear; below it, verified pending runs appear immediately.
async function loadBoard(env) {
  const { results } = await env.DB.prepare(
    "SELECT l.id, l.user_id, l.username, l.final_time, l.elapsed_ms, l.completion_percent, l.items_collected, l.verified, l.created_at, " +
    "COALESCE(NULLIF(l.user_id, ''), l.username) AS user_key, r.status AS review_status, r.reasons AS review_reasons " +
    "FROM leaderboard l LEFT JOIN lb_review r ON r.leaderboard_id = l.id " +
    "WHERE r.status IS NULL OR r.status != 'removed' " +
    "ORDER BY l.elapsed_ms ASC, l.id ASC"
  ).all();
  const { results: bans } = await env.DB.prepare("SELECT user_key FROM banned_users").all();
  const banned = new Set((bans || []).map(b => b.user_key));

  const candidates = [], shown = [];
  const seenC = new Set(), seenS = new Set();
  for (const row of results || []) {
    if (banned.has(row.user_key)) continue;
    // Runs from before reviews existed have no review row: trust their verified flag.
    const approved = row.review_status === "approved" || (row.review_status == null && row.verified === 1);
    row.approved = approved;
    if (!seenC.has(row.user_key)) { seenC.add(row.user_key); candidates.push(row); }
    // At least 10 faster players ahead -> outside the reviewed zone.
    const showable = approved || (row.verified === 1 && candidates.length > REVIEW_TOP_N);
    if (showable && !seenS.has(row.user_key)) { seenS.add(row.user_key); shown.push(row); }
  }
  return { candidates, shown, banned };
}

function replayEligibleIds(board) {
  return new Set([...board.candidates.slice(0, REPLAY_TOP_N), ...board.shown.slice(0, REPLAY_TOP_N)].map(r => r.id));
}

// Replays only exist for runs in the (candidate or public) top 10; everything else is dropped.
async function pruneReplays(env) {
  const keep = [...replayEligibleIds(await loadBoard(env))];
  if (!keep.length) { await env.DB.prepare("DELETE FROM replays").run(); }
  else {
    await env.DB
      .prepare(`DELETE FROM replays WHERE leaderboard_id NOT IN (${keep.map(() => "?").join(",")})`)
      .bind(...keep)
      .run();
  }
  await env.DB.prepare("DELETE FROM replay_claims WHERE created_at < ?").bind(Date.now() - REPLAY_CLAIM_TTL).run();
}

async function claimIsLive(env, token) {
  if (!token) return null;
  const claim = await env.DB.prepare("SELECT * FROM replay_claims WHERE token = ?").bind(String(token)).first();
  if (!claim || Date.now() - claim.created_at > REPLAY_CLAIM_TTL) return null;
  return replayEligibleIds(await loadBoard(env)).has(claim.leaderboard_id) ? claim : null;
}

function isHttpsUrl(u) {
  try { return new URL(String(u)).protocol === "https:"; } catch { return false; }
}

// ---- Run seeds (mirror of src/run-seed.js; server.js must be self-contained) ----
function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, "0");
}

// Only an intact vanilla seed may enter the leaderboard.
function checkLeaderboardSeed(full) {
  const parts = String(full || "").trim().split(".");
  if (parts.length !== 3) return "Missing run seed.";
  const [prefix, payload, hash] = parts;
  if (prefix === "MMC1") return "Custom games do not count for the leaderboard.";
  const version = prefix === "MM2" ? 2 : prefix === "MMV1" ? 1 : null;
  if (!version) return "Unknown run seed.";
  if (hash53(`magmart-run-seed-v${version}|${prefix}|${payload}`, version) !== hash) return "Run seed hash mismatch.";
  let body;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((payload.length + 3) % 4);
    body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))));
  } catch { return "Run seed unreadable."; }
  if (!body || typeof body !== "object") return "Run seed unreadable.";
  if (version === 2) {
    if (body.m === 1) return "Custom games do not count for the leaderboard.";
    if (body.m !== 0) return "Invalid run seed mode.";
  }
  if (!Array.isArray(body.d) || body.d.length > 0 || body.b !== body.r) return "Run used non-vanilla rules.";
  return null;
}

// ---- Live run tracking ----
// Pure function: folds one heartbeat into the track row. `offset` is how far
// the server clock is ahead of the game's timer; network lag only ever makes
// it bigger, so the smallest recent offset is the honest one. A timer that is
// being slowed down makes the offset grow over the run.
function applyBeat(track, beat, serverElapsed) {
  const flags = parseJson(track.flags, []);
  const addFlag = (msg, hard, replacePrefix) => {
    if (replacePrefix) for (let i = flags.length - 1; i >= 0; i--) if (flags[i].startsWith(replacePrefix)) flags.splice(i, 1);
    if (!flags.includes(msg)) flags.push(msg);
    if (hard) track.hard = 1;
  };
  const t = Math.max(0, Math.round(Number(beat.t) || 0));
  const offset = serverElapsed - t;

  if (t > serverElapsed + TIMER_AHEAD_TOL_MS) addFlag("Timer ran ahead of the server clock", true);
  if (t + 250 < track.last_elapsed) addFlag("Timer went backwards", true);

  const recent = parseJson(track.recent_offsets, []);
  recent.push(offset);
  while (recent.length > 3) recent.shift();
  track.recent_offsets = JSON.stringify(recent);
  if (serverElapsed <= 12000) {
    track.early_offset = track.early_offset == null ? offset : Math.min(track.early_offset, offset);
  }
  const drift = track.early_offset == null ? 0 : Math.min(...recent) - track.early_offset;
  const prevDrift = flags.filter(f => f.startsWith("Timer fell ")).map(f => parseFloat(f.slice(11)) * 1000)[0] || 0;
  if (drift > TIMER_DRIFT_TOL_MS && drift > prevDrift) {
    addFlag(`Timer fell ${(drift / 1000).toFixed(1)}s behind the server clock`, true, "Timer fell ");
  }

  const x = Number(beat.x), z = Number(beat.z);
  if (Number.isFinite(x) && Number.isFinite(z)) {
    if (track.last_x != null && track.last_z != null) {
      const d = Math.hypot(x - track.last_x, z - track.last_z);
      const dt = Math.max(500, t - track.last_elapsed) / 1000;
      track.dist += d;
      const speed = d / dt;
      if (speed > MAX_BURST_SPEED && d > MIN_TELEPORT_M) {
        track.bursts += 1;
        addFlag(`Teleported ${d.toFixed(0)}m in ${dt.toFixed(1)}s`, true);
      } else if (speed > WARN_SPEED) {
        addFlag(`Moved very fast (${speed.toFixed(0)} m/s)`, false, "Moved very fast");
      }
    }
    track.last_x = x;
    track.last_z = z;
  }
  const c = Math.max(0, Math.min(500, Math.round(Number(beat.c) || 0)));
  track.max_collected = Math.max(track.max_collected, c);
  track.last_elapsed = Math.max(track.last_elapsed, t);
  track.beats += 1;
  track.flags = JSON.stringify(flags);
  return track;
}

// Pure function: final checks when a score is submitted. Returns reasons;
// `hard` reasons make the run unverified.
function finalChecks(track, claim) {
  const reasons = parseJson(track.flags, []).map(r => ({ r, hard: false }));
  const hard = (r) => reasons.push({ r, hard: true });
  if (track.hard) reasons.forEach(x => { x.hard = true; });
  if (track.finish_elapsed == null) hard("Run never reported its finish");
  else if (Math.abs(claim.elapsed_ms - track.finish_elapsed) > 100) hard("Submitted time differs from the reported finish");
  const expected = Math.floor(claim.elapsed_ms / BEAT_MS);
  if (track.beats < Math.floor(expected * MIN_BEAT_COVERAGE)) hard(`Only ${track.beats} of ~${expected} heartbeats arrived`);
  const avg = track.dist / Math.max(1, claim.elapsed_ms / 1000);
  if (avg > MAX_AVG_SPEED) hard(`Average speed ${avg.toFixed(1)} m/s`);
  if (claim.items_collected > track.max_collected) hard(`Claimed ${claim.items_collected} items, tracked ${track.max_collected}`);
  return reasons;
}

const TRACK_COLS = ["beats", "last_elapsed", "last_x", "last_z", "dist", "bursts", "max_collected", "early_offset", "recent_offsets", "flags", "hard", "finish_elapsed", "finish_server_ms"];
async function saveTrack(env, track) {
  await env.DB
    .prepare(`UPDATE run_track SET ${TRACK_COLS.map(c => `${c} = ?`).join(", ")} WHERE run_id = ?`)
    .bind(...TRACK_COLS.map(c => track[c] ?? null), track.run_id)
    .run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headerUserId = request.headers.get("x-websim-user-id") || "";
    const headerUsername = request.headers.get("x-websim-username") || "";

    // POST /api/run/start -> Issues a server-authenticated run session token
    if (request.method === "POST" && url.pathname === "/api/run/start") {
      try {
        const userId = headerUserId || ("anon_" + crypto.randomUUID());
        const body = await request.json().catch(() => ({}));
        const username = headerUsername || (body.username ? String(body.username).substring(0, 24) : "Speedrunner");
        const totalItems = typeof body.total_items === "number" ? body.total_items : 6;
        const startedAt = Date.now();
        const runId = "run_" + startedAt + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);

        await env.DB.batch([
          env.DB
            .prepare(
              "INSERT INTO run_sessions (run_id, user_id, username, started_at, total_items, completion_percent, verified) " +
              "VALUES (?, ?, ?, ?, ?, 0, 1)"
            )
            .bind(runId, userId, username, startedAt, totalItems),
          env.DB.prepare("INSERT INTO run_track (run_id, user_id) VALUES (?, ?)").bind(runId, userId),
          // Abandoned runs: drop sessions older than 6 hours.
          env.DB.prepare("DELETE FROM run_track WHERE run_id IN (SELECT run_id FROM run_sessions WHERE started_at < ?)").bind(startedAt - 6 * 3600 * 1000),
          env.DB.prepare("DELETE FROM run_sessions WHERE started_at < ?").bind(startedAt - 6 * 3600 * 1000),
        ]);

        return Response.json({ ok: true, run_id: runId, started_at: startedAt, beat_ms: BEAT_MS });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // POST /api/run/beat -> one live heartbeat {run_id, t, x, z, c, fin}
    if (request.method === "POST" && url.pathname === "/api/run/beat") {
      try {
        const body = await request.json().catch(() => ({}));
        const runId = String(body.run_id || "");
        const session = runId && await env.DB
          .prepare("SELECT user_id, started_at FROM run_sessions WHERE run_id = ?").bind(runId).first();
        if (!session) return Response.json({ ok: false }, { status: 404 });
        if (headerUserId && session.user_id !== headerUserId) return Response.json({ ok: false }, { status: 403 });
        const track = await env.DB.prepare("SELECT * FROM run_track WHERE run_id = ?").bind(runId).first();
        if (!track || track.finish_server_ms != null) return Response.json({ ok: true });

        const now = Date.now();
        applyBeat(track, body, now - session.started_at);
        if (body.fin) {
          track.finish_elapsed = Math.max(0, Math.round(Number(body.t) || 0));
          track.finish_server_ms = now;
        }
        await saveTrack(env, track);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // GET /api/leaderboard -> public fastest runs (1 per player). Devs also
    // get seeds, the review queue and the ban list.
    if (request.method === "GET" && url.pathname === "/api/leaderboard") {
      try {
        const board = await loadBoard(env);
        const dev = isDev(headerUsername);
        const pageSize = Math.max(10, Math.min(100, Math.floor(Number(url.searchParams.get('limit')) || 50)));
        const pages = Math.max(1, Math.ceil(board.shown.length / pageSize));
        const page = Math.max(1, Math.min(pages, Math.floor(Number(url.searchParams.get('page')) || 1)));
        const list = board.shown.slice(0, 50); // v37+ clients retain their original contract
        const entries = board.shown.slice((page - 1) * pageSize, page * pageSize);
        const ranks = new Map(board.shown.map((row, index) => [row.id, index + 1]));
        const isMine = row => headerUserId ? row.user_id === headerUserId
          : !!headerUsername && row.username.toLowerCase() === headerUsername.toLowerCase();
        const mine = board.shown.find(isMine) || null;
        const candidate = board.candidates.find(isMine) || null;
        const queue = dev ? board.candidates.slice(0, REVIEW_TOP_N + 5).filter(r => !r.approved) : [];
        const all = [...list, ...entries, ...queue, ...(mine ? [mine] : [])];

        const { results: replayRows } = await env.DB
          .prepare("SELECT leaderboard_id, video_url, data_url, duration_ms FROM replays")
          .all();
        const byId = new Map((replayRows || []).map(r => [r.leaderboard_id, r]));
        const eligible = replayEligibleIds(board);
        all.forEach(row => {
          const rep = eligible.has(row.id) ? byId.get(row.id) : null;
          if (rep) {
            row.replay_video_url = rep.video_url;
            row.replay_data_url = rep.data_url;
            row.replay_duration_ms = rep.duration_ms;
          }
        });

        const clean = (row, withDev) => {
          const out = {
            id: row.id, user_id: row.user_id, username: row.username, final_time: row.final_time,
            elapsed_ms: row.elapsed_ms, completion_percent: row.completion_percent,
            items_collected: row.items_collected, verified: row.verified, created_at: row.created_at,
            replay_video_url: row.replay_video_url, replay_data_url: row.replay_data_url,
            replay_duration_ms: row.replay_duration_ms,
            rank: ranks.get(row.id) || null,
          };
          if (withDev) {
            out.user_key = row.user_key;
            out.review_status = row.review_status || "legacy";
            out.review_reasons = parseJson(row.review_reasons || "[]", []);
            out.seed = row.seed || null;
          }
          return out;
        };

        if (dev && all.length) {
          const ids = [...new Set(all.map(r => r.id))];
          const { results: seedRows } = await env.DB
            .prepare(`SELECT leaderboard_id, seed FROM run_seeds WHERE leaderboard_id IN (${ids.map(() => "?").join(",")})`)
            .bind(...ids)
            .all();
          const seeds = new Map((seedRows || []).map(r => [r.leaderboard_id, r.seed]));
          all.forEach(row => { row.seed = seeds.get(row.id) || null; });
        }

        const top = list.map(r => clean(r, dev));
        const response = {
          top_times: top, top_scores: top, entries: entries.map(r => clean(r, dev)),
          total_players: board.shown.length, page, page_size: pageSize, pages,
          has_more: page < pages, scope: 'project-global', since_version: 37,
          my_best: mine ? clean(mine, dev) : null,
          my_status: mine ? 'ranked' : candidate ? (candidate.verified === 1 ? 'pending_review' : 'unverified') : 'no_run',
        };
        if (dev) {
          response.review_queue = queue.map(r => clean(r, true));
          const { results: bans } = await env.DB
            .prepare("SELECT user_key, username, banned_by, created_at FROM banned_users ORDER BY created_at DESC")
            .all();
          response.banned = bans || [];
        }
        return Response.json(response);
      } catch (err) {
        return Response.json({ error: err.message, top_times: [], top_scores: [] }, { status: 500 });
      }
    }

    // POST /api/dev/review {leaderboard_id, action: approve|remove|pending}
    if (request.method === "POST" && url.pathname === "/api/dev/review") {
      if (!isDev(headerUsername)) return Response.json({ error: "Forbidden" }, { status: 403 });
      try {
        const body = await request.json().catch(() => ({}));
        const id = Number(body.leaderboard_id);
        const status = { approve: "approved", remove: "removed", pending: "pending" }[body.action];
        if (!Number.isInteger(id) || !status) return Response.json({ error: "Bad request" }, { status: 400 });
        const existing = await env.DB.prepare("SELECT reasons FROM lb_review WHERE leaderboard_id = ?").bind(id).first();
        await env.DB
          .prepare("INSERT OR REPLACE INTO lb_review (leaderboard_id, status, reasons, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?, ?)")
          .bind(id, status, existing ? existing.reasons : "[]", headerUsername, Date.now())
          .run();
        await pruneReplays(env);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // POST /api/dev/ban {user_key, username, ban: true|false}
    if (request.method === "POST" && url.pathname === "/api/dev/ban") {
      if (!isDev(headerUsername)) return Response.json({ error: "Forbidden" }, { status: 403 });
      try {
        const body = await request.json().catch(() => ({}));
        const key = String(body.user_key || "").slice(0, 200);
        if (!key) return Response.json({ error: "Bad request" }, { status: 400 });
        if (body.ban === false) {
          await env.DB.prepare("DELETE FROM banned_users WHERE user_key = ?").bind(key).run();
        } else {
          if (isDev(body.username)) return Response.json({ error: "Cannot ban a developer" }, { status: 400 });
          await env.DB
            .prepare("INSERT OR REPLACE INTO banned_users (user_key, username, banned_by, created_at) VALUES (?, ?, ?, ?)")
            .bind(key, String(body.username || "").slice(0, 40), headerUsername, Date.now())
            .run();
        }
        await pruneReplays(env);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // POST /api/score -> Records a completed run after the anti-cheat checks
    if (request.method === "POST" && (url.pathname === "/api/score" || url.pathname === "/api/speedrun")) {
      try {
        const body = await request.json();
        const runId = String(body.run_id || "");
        const seed = String(body.seed || "").slice(0, 4000);
        const createdAt = Date.now();

        const session = runId && await env.DB
          .prepare("SELECT run_id, user_id, username, started_at, verified FROM run_sessions WHERE run_id = ?")
          .bind(runId)
          .first();
        const track = session && await env.DB.prepare("SELECT * FROM run_track WHERE run_id = ?").bind(runId).first();
        if (runId) {
          // Single-use run token.
          await env.DB.batch([
            env.DB.prepare("DELETE FROM run_sessions WHERE run_id = ?").bind(runId),
            env.DB.prepare("DELETE FROM run_track WHERE run_id = ?").bind(runId),
          ]);
        }

        const seedProblem = checkLeaderboardSeed(seed);
        if (seedProblem) return Response.json({ ok: false, rejected: true, reason: seedProblem });
        if (!session) return Response.json({ ok: false, rejected: true, reason: "Unknown or already used run session." });
        if (headerUserId && session.user_id !== headerUserId) {
          return Response.json({ ok: false, rejected: true, reason: "Run belongs to another player." });
        }

        // Identity comes from the session (set by the server at run start).
        const userId = session.user_id;
        const username = headerUsername || session.username;
        const { results: banRows } = await env.DB
          .prepare("SELECT user_key FROM banned_users WHERE user_key = ?").bind(userKeyOf(userId, username)).all();
        if (banRows && banRows.length) return Response.json({ ok: false, rejected: true, reason: "Banned from the leaderboard." });

        const finalTime = String(body.final_time || "00:00:00.00").slice(0, 16);
        const elapsedMs = typeof body.elapsed_ms === "number" ? Math.round(body.elapsed_ms) : 0;
        const completionPercent = typeof body.completion_percent === "number" ? body.completion_percent : 100;
        const itemsCollected = typeof body.items_collected === "number" ? body.items_collected : 0;

        const reasons = track ? finalChecks(track, { elapsed_ms: elapsedMs, items_collected: itemsCollected })
                              : [{ r: "No live tracking for this run", hard: true }];
        if (elapsedMs < MIN_PHYSICS_FLOOR_MS) reasons.push({ r: "Faster than physically possible", hard: true });
        const finishServerMs = track && track.finish_server_ms != null ? track.finish_server_ms : createdAt;
        if (elapsedMs > finishServerMs - session.started_at + 3500) reasons.push({ r: "Claimed more time than passed", hard: true });
        if (session.verified === 0) reasons.push({ r: "Session was invalidated", hard: true });
        const isVerified = reasons.some(x => x.hard) ? 0 : 1;

        const inserted = await env.DB
          .prepare(
            "INSERT INTO leaderboard (user_id, username, score, final_time, elapsed_ms, completion_percent, items_collected, verified, created_at) " +
            "VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?) RETURNING id"
          )
          .bind(userId, username, finalTime, elapsedMs, completionPercent, itemsCollected, isVerified, createdAt)
          .first();
        const entryId = inserted && inserted.id;
        if (entryId) {
          await env.DB.batch([
            env.DB
              .prepare("INSERT OR REPLACE INTO run_seeds (leaderboard_id, seed, created_at) VALUES (?, ?, ?)")
              .bind(entryId, seed, createdAt),
            env.DB
              .prepare("INSERT OR REPLACE INTO lb_review (leaderboard_id, status, reasons) VALUES (?, 'pending', ?)")
              .bind(entryId, JSON.stringify(reasons.map(x => (x.hard ? "⛔ " : "⚠️ ") + x.r))),
          ]);
        }

        // A run that would place in the top 10 (and is under 5 minutes) uploads
        // its recording so a developer can review it.
        let replayToken = null;
        let pendingReview = false;
        if (entryId && elapsedMs <= REPLAY_MAX_MS) {
          const board = await loadBoard(env);
          const mine = board.candidates.slice(0, REPLAY_TOP_N).find(r => r.id === entryId);
          if (mine) {
            pendingReview = true;
            replayToken = "rp_" + crypto.randomUUID();
            await env.DB
              .prepare("INSERT INTO replay_claims (token, leaderboard_id, user_key, created_at) VALUES (?, ?, ?, ?)")
              .bind(replayToken, entryId, mine.user_key, createdAt)
              .run();
          }
          await pruneReplays(env);
        }

        return Response.json({
          ok: true,
          verified: isVerified === 1,
          pending_review: pendingReview,
          leaderboard_id: entryId || null,
          replay_token: replayToken,
        });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // POST /api/replay/blob?token=&kind=video|data -> fallback storage for a recording file
    if (request.method === "POST" && url.pathname === "/api/replay/blob") {
      try {
        const claim = await claimIsLive(env, url.searchParams.get("token"));
        if (!claim) return Response.json({ error: "Not eligible" }, { status: 403 });
        const kind = url.searchParams.get("kind") === "data" ? "data" : "video";
        const contentType = request.headers.get("content-type") || (kind === "data" ? "application/gzip" : "video/webm");
        if (kind === "video" && !contentType.startsWith("video/")) return Response.json({ error: "Bad type" }, { status: 400 });
        const bytes = await request.arrayBuffer();
        if (!bytes.byteLength) return Response.json({ error: "Empty" }, { status: 400 });
        const { url: blobUrl } = await env.BLOB.put(`replay-${claim.leaderboard_id}-${kind}`, bytes, { contentType });
        return Response.json({ url: blobUrl });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // POST /api/replay -> attach an uploaded recording to the player's best run
    if (request.method === "POST" && url.pathname === "/api/replay") {
      try {
        const body = await request.json().catch(() => ({}));
        const claim = await claimIsLive(env, body.token);
        if (!claim) return Response.json({ error: "Not eligible" }, { status: 403 });
        if (!isHttpsUrl(body.video_url) || !isHttpsUrl(body.data_url)) {
          return Response.json({ error: "Bad urls" }, { status: 400 });
        }
        const duration = Math.max(0, Math.min(15 * 60 * 1000, Number(body.duration_ms) || 0));
        await env.DB.batch([
          env.DB.prepare("DELETE FROM replays WHERE user_key = ? OR leaderboard_id = ?").bind(claim.user_key, claim.leaderboard_id),
          env.DB
            .prepare("INSERT INTO replays (user_key, leaderboard_id, video_url, data_url, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(claim.user_key, claim.leaderboard_id, String(body.video_url), String(body.data_url), duration, Date.now()),
          env.DB.prepare("DELETE FROM replay_claims WHERE token = ?").bind(claim.token),
        ]);
        await pruneReplays(env);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// SPECTATOR MODE - realtime room
// Players in an active run register as broadcasters; spectators pick one and
// the room routes that player's live view (WebRTC signaling, JPEG fallback
// frames and the mirrored HUD) to them only.
// ---------------------------------------------------------------------------
const specPeers = new Map(); // conn.id -> peer record

function specPeer(conn) {
  let p = specPeers.get(conn.id);
  if (!p) {
    p = {
      id: conn.id,
      username: conn.username || null,
      live: false,
      startedAt: 0,
      w: 1280,
      h: 720,
      layout: "",
      watching: null,           // broadcaster id this conn is watching
      viewers: new Set(),       // conn ids watching this broadcaster
      jpegViewers: new Set(),   // viewers that need relayed JPEG frames
      hud: null,                // last HUD snapshot (for late joiners)
    };
    specPeers.set(conn.id, p);
  }
  return p;
}

function specGameInfo(p) {
  return {
    id: p.id,
    username: p.username,
    startedAt: p.startedAt,
    viewers: p.viewers.size,
    w: p.w,
    h: p.h,
    layout: p.layout,
  };
}

function specGameList(exceptId) {
  const out = [];
  for (const p of specPeers.values()) {
    if (p.live && p.id !== exceptId) out.push(specGameInfo(p));
  }
  out.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

// The room object is only handed to us per handler call, so every push to
// another connection goes through room.broadcast with an except-list that
// leaves exactly the intended recipients.
let SPEC_ROOM = null;

function specSendTo(ids, msg) {
  if (!SPEC_ROOM) return;
  const want = new Set(ids);
  if (!want.size) return;
  const except = [];
  for (const id of specPeers.keys()) if (!want.has(id)) except.push(id);
  try { SPEC_ROOM.broadcast(msg, { except }); } catch (e) { console.log("spec send failed", e && e.message); }
}

function specSendList() {
  // One list for everyone; each client drops its own game from it.
  if (!SPEC_ROOM) return;
  try { SPEC_ROOM.broadcast({ type: "spec:games", now: Date.now(), games: specGameList(null) }); } catch (_) {}
}

function specSend(id, msg) {
  specSendTo([id], msg);
}

function specStopWatching(viewer, reason) {
  const targetId = viewer.watching;
  if (!targetId) return;
  viewer.watching = null;
  const target = specPeers.get(targetId);
  if (!target) return;
  target.viewers.delete(viewer.id);
  target.jpegViewers.delete(viewer.id);
  specSend(target.id, {
    type: "spec:viewer-left",
    viewer: viewer.id,
    viewers: target.viewers.size,
    jpeg: target.jpegViewers.size,
  });
}

function specEndBroadcast(target, room) {
  for (const vid of target.viewers) {
    const v = specPeers.get(vid);
    if (v) v.watching = null;
  }
  specSendTo(target.viewers, { type: "spec:ended", id: target.id });
  target.viewers.clear();
  target.jpegViewers.clear();
  target.hud = null;
}

export const room = {
  async onConnect(conn, room, env) {
    SPEC_ROOM = room;
    specPeer(conn);
    conn.send({ type: "spec:welcome", id: conn.id, now: Date.now(), games: specGameList(conn.id) });
  },

  async onMessage(conn, message, room, env) {
    SPEC_ROOM = room;
    const me = specPeer(conn);
    let m;
    try { m = typeof message === "string" ? JSON.parse(message) : message; } catch { return; }
    if (!m || typeof m.type !== "string") return;

    switch (m.type) {
      case "spec:status": {
        const wasLive = me.live;
        me.live = !!m.live;
        if (me.live) {
          const elapsed = Math.max(0, Math.min(86400000, Number(m.elapsed) || 0));
          me.startedAt = Date.now() - elapsed;
          me.w = Math.max(200, Math.min(8000, Number(m.w) || 1280));
          me.h = Math.max(150, Math.min(8000, Number(m.h) || 720));
          me.layout = String(m.layout || "").slice(0, 40);
          if (me.watching) specStopWatching(me);
          specSendTo(me.viewers, { type: "spec:info", now: Date.now(), game: specGameInfo(me) });
        } else if (wasLive) {
          specEndBroadcast(me, room);
        }
        if (wasLive !== me.live || m.force) specSendList(room);
        break;
      }

      case "spec:ping":
        conn.send({
          type: "spec:pong",
          now: Date.now(),
          live: me.live,
          vids: me.live ? [...me.viewers] : [],
          viewers: me.viewers.size,
          jpeg: me.jpegViewers.size,
        });
        break;

      case "spec:list":
        conn.send({ type: "spec:games", now: Date.now(), games: specGameList(conn.id) });
        break;

      case "spec:watch": {
        const target = specPeers.get(String(m.target || ""));
        if (!target || !target.live || target.id === me.id) {
          conn.send({ type: "spec:watch-fail", reason: "That game has ended." });
          break;
        }
        if (me.watching && me.watching !== target.id) specStopWatching(me);
        me.watching = target.id;
        target.viewers.add(me.id);
        target.jpegViewers.add(me.id); // start on the relay until WebRTC takes over
        console.log("spec watch", me.id, "->", target.id, "viewers", target.viewers.size);
        conn.send({ type: "spec:watch-ok", now: Date.now(), game: specGameInfo(target), hud: target.hud });
        specSend(target.id, {
          type: "spec:viewer-join",
          viewer: me.id,
          username: me.username,
          viewers: target.viewers.size,
          jpeg: target.jpegViewers.size,
        });
        specSendList(room);
        break;
      }

      case "spec:unwatch":
        specStopWatching(me);
        specSendList(room);
        break;

      case "spec:mode": {
        const target = me.watching && specPeers.get(me.watching);
        if (!target) break;
        if (m.jpeg) target.jpegViewers.add(me.id);
        else target.jpegViewers.delete(me.id);
        specSend(target.id, { type: "spec:jpeg", jpeg: target.jpegViewers.size, viewers: target.viewers.size });
        break;
      }

      case "spec:quality": {
        const target = me.watching && specPeers.get(me.watching);
        const q = String(m.q || "");
        if (!target || !["sd", "hd", "max"].includes(q)) break;
        specSend(target.id, { type: "spec:quality", viewer: me.id, q });
        break;
      }

      case "spec:frame": {
        if (!me.live || typeof m.d !== "string" || m.d.length > 60000) break;
        const out = { type: "spec:frame", id: me.id, d: m.d };
        specSendTo(me.jpegViewers, out);
        break;
      }

      case "spec:audio": {
        if (!me.live || !me.viewers.size || typeof m.a !== "object" || !m.a) break;
        if (JSON.stringify(m.a).length > 30000) break;
        specSendTo(me.viewers, { type: "spec:audio", id: me.id, a: m.a });
        break;
      }

      case "spec:hud": {
        if (!me.live || typeof m.h !== "object" || !m.h) break;
        const size = JSON.stringify(m.h).length;
        if (size > 60000) break;
        me.hud = m.h;
        const out = { type: "spec:hud", id: me.id, h: m.h };
        specSendTo(me.viewers, out);
        break;
      }

      case "spec:rtc": {
        // Only relay signaling between a broadcaster and one of its viewers.
        const to = String(m.to || "");
        const other = specPeers.get(to);
        if (!other) break;
        const paired = (me.watching === to && other.viewers.has(me.id)) ||
                       (other.watching === me.id && me.viewers.has(to));
        if (!paired) break;
        const payload = JSON.stringify(m.data || null);
        if (payload.length > 30000) break;
        specSend(to, { type: "spec:rtc", from: me.id, data: m.data });
        break;
      }
    }
  },

  async onClose(conn, room, env) {
    SPEC_ROOM = room;
    const me = specPeers.get(conn.id);
    if (!me) return;
    specStopWatching(me);
    const wasLive = me.live;
    if (wasLive) specEndBroadcast(me, room);
    specPeers.delete(conn.id);
    specSendList(room);
  },
};

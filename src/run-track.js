// Live run tracking for the leaderboard anti-cheat (see server.js).
// While a leaderboard run is going, report the run timer, player position and
// item count every couple of seconds; the server stamps each report with its
// own clock. Reports are sent one at a time, in order.

let runId = null;
let sample = null;     // (final) => { t, x, z, c } | null
let beatTimer = null;
let queue = Promise.resolve();
let finished = false;

function send(payload) {
    const body = JSON.stringify({ run_id: runId, ...payload });
    queue = queue.then(() => fetch('/api/run/beat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
        signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
    }).catch(() => {}));
    return queue;
}

function beat() {
    if (!runId || finished) return;
    let s;
    try { s = sample(false); } catch (_) { return; }
    if (s) send(s);
}

// Begin tracking once the server has issued the run session.
export function startRunTrack(id, sampler, intervalMs = 2000) {
    stopRunTrack();
    runId = id;
    sample = sampler;
    finished = false;
    beat();
    beatTimer = setInterval(beat, Math.max(1000, intervalMs));
}

// The run clock stopped: send the final report. Resolves once it's delivered,
// so the score can be submitted after it.
export function finishRunTrack(finalElapsedMs) {
    if (!runId || finished) return queue;
    let s = null;
    try { s = sample(true); } catch (_) {}
    finished = true;
    if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
    return send({ ...(s || {}), t: Math.round(finalElapsedMs), fin: true });
}

export function stopRunTrack() {
    if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
    runId = null;
    finished = false;
}

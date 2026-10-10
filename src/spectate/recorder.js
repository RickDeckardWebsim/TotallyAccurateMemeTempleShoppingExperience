// Leaderboard replays: every official run is recorded locally (the exact
// rendered first-person view as video, plus a timeline of the mirrored HUD
// and audio playback). Nothing leaves the device unless the server says the
// finished run became this player's best inside the top 10. Failed runs and
// runs longer than 10 minutes are thrown away.

import { net } from './net.js';
import { captureHud, onScreenFrame } from './broadcast.js';

const FPS = 30;
const MAX_H = 720;
const BITRATE = 1_200_000;
const HUD_INTERVAL = 150;
const HUD_KEEPALIVE = 2000;
const TAIL_MS = 1800; // keep recording briefly after checkout to show the finish
// Wall-clock recording cap: pauses add real time on top of the 10 minute run limit.
const MAX_WALL_MS = 15 * 60 * 1000;

const composite = document.createElement('canvas');
const ctx = composite.getContext('2d', { alpha: false });

let rec = null;      // run currently being recorded
let pending = null;  // finished recording waiting for the server's verdict
let lastRun = null;  // this session's latest completed run, kept for export

function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    // Prefer MP4 when the browser can encode it: these recordings also play
    // on Safari/iPhones, rather than depending on the recorder's WebM codec.
    const list = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
    for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {} }
    return null;
}

function fitSize(w, h, maxH = MAX_H) {
    const s = Math.min(1, maxH / h);
    return [Math.max(2, Math.round(w * s) & ~1), Math.max(2, Math.round(h * s) & ~1)];
}

function canRecordRun() {
    return window.__ssGameState?.()?.replayEligible === true;
}

export function isRecording() { return !!rec && !rec.stopping && canRecordRun(); }

function now() { return rec ? performance.now() - rec.t0 : 0; }

export function recordAudio(snap) {
    if (!isRecording()) return;
    rec.audio.push([Math.round(now()), snap]);
}

function discard() {
    if (rec) {
        const r = rec;
        rec = null;
        r.cancelled = true;
        try { if (r.mr.state !== 'inactive') r.mr.stop(); } catch (_) {}
        try { r.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    }
}

function start() {
    // Enforce eligibility here too, even if a caller invokes the hook directly.
    if (!canRecordRun()) {
        if (rec?.stopAt) finish(); else discard();
        return;
    }
    // A finished run still in its short tail keeps its recording.
    if (rec && rec.stopAt) finish(); else discard();
    // Still record phone runs, using a small encode instead of disabling
    // their replays entirely. This does not change the game's render quality.
    const lowMem = typeof window.__lowMem === 'function' && window.__lowMem();
    const fps = lowMem ? 15 : FPS;
    const mime = pickMime();
    const gs = typeof window.__ssGameState === 'function' ? window.__ssGameState() : null;
    const canvas = gs && gs.renderer && gs.renderer.domElement;
    if (!mime || !canvas || !composite.captureStream) return;
    const [w, h] = fitSize(canvas.width || 1280, canvas.height || 720, lowMem ? 360 : MAX_H);
    composite.width = w;
    composite.height = h;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    let stream, mr;
    try {
        stream = composite.captureStream(fps);
        mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: lowMem ? 350_000 : BITRATE });
    } catch (e) {
        console.warn('[replay] recorder unavailable', e);
        return;
    }
    rec = {
        mr, stream, mime, fps,
        chunks: [],
        hud: [],
        audio: [],
        prevHud: null,
        lastHud: -1e9,
        lastHudKey: 0,
        lastFrame: 0,
        t0: performance.now(),
        stopAt: 0,
        stopping: false,
        w: window.innerWidth,
        h: window.innerHeight,
    };
    const recording = rec;
    // MediaRecorder emits its last chunk asynchronously. A quick restart
    // must not drop it or mix the previous run into the next recording.
    mr.ondataavailable = (e) => { if (!recording.cancelled && e.data?.size) recording.chunks.push(e.data); };
    mr.start(1000);
    tickHud(true);
}

// ---------------------------------------------------------------- capture
onScreenFrame((canvas) => {
    if (!isRecording() || !canvas.width) return;
    const t = performance.now();
    if (t - rec.lastFrame < 1000 / rec.fps - 2) return;
    rec.lastFrame = t;
    try {
        ctx.drawImage(canvas, 0, 0, composite.width, composite.height);
        const js = document.getElementById('jumpscare-canvas');
        if (js && js.width && js.offsetParent !== null && getComputedStyle(js).display !== 'none') {
            ctx.drawImage(js, 0, 0, composite.width, composite.height);
        }
        drawTimer(canvas);
    } catch (_) {}
});

// Burn the run timer into the video (for speedrun verification). It is drawn
// exactly where the on-screen timer sits, so in the in-game replay player the
// mirrored HUD timer covers it and nothing appears twice.
function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawTimer(canvas) {
    const el = document.getElementById('timer');
    const text = el ? (el.textContent || '').trim() : '';
    if (!text) return;
    const cr = canvas.getBoundingClientRect();
    if (!cr.width || !cr.height) return;
    const sx = composite.width / cr.width;
    const sy = composite.height / cr.height;
    let r = el.getBoundingClientRect();
    let x, y, w, h;
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') {
        x = (r.left - cr.left) * sx; y = (r.top - cr.top) * sy;
        w = r.width * sx; h = r.height * sy;
    } else {
        // Timer hidden by an overlay: keep a compact copy in the top-left corner.
        w = 190 * sx; h = 54 * sy; x = 12 * sx; y = 12 * sy;
    }
    const k = h / 54; // scale relative to the timer's usual height
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 12 * k;
    ctx.fillStyle = '#090d16';
    roundRect(x, y, w, h, 6 * k);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2 * k;
    ctx.strokeStyle = '#1e293b';
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#64748b';
    ctx.font = `700 ${Math.max(7, 10 * k)}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillText('⏱ TIME ELAPSED', x + w / 2, y + h * 0.28);
    ctx.fillStyle = '#39ff14';
    ctx.shadowColor = 'rgba(57,255,20,0.7)';
    ctx.shadowBlur = 8 * k;
    ctx.font = `bold ${Math.max(10, 24 * k)}px 'Share Tech Mono', 'Courier New', monospace`;
    ctx.fillText(text, x + w / 2, y + h * 0.64, w - 8 * k);
    ctx.restore();
}

const HUD_KEYS = ['w', 'h', 'cls', 'st', 'bcls', 'html', 'extra', 'cv'];

// HUD snapshots are stored as deltas: only the fields that changed.
function tickHud(force = false) {
    const t = now();
    if (!force && t - rec.lastHud < HUD_INTERVAL) return;
    rec.lastHud = t;
    const h = captureHud();
    if (!h) return;
    const prev = rec.prevHud;
    const delta = {};
    let changed = false;
    for (const k of HUD_KEYS) {
        const a = k === 'cv' ? JSON.stringify(h[k]) : h[k];
        const b = prev ? (k === 'cv' ? JSON.stringify(prev[k]) : prev[k]) : undefined;
        if (!prev || a !== b) { delta[k] = h[k]; changed = true; }
    }
    if (!changed && t - rec.lastHudKey < HUD_KEEPALIVE) return;
    rec.lastHudKey = t;
    rec.prevHud = h;
    rec.hud.push([Math.round(t), delta]);
}

async function finish() {
    const r = rec;
    if (!r || r.stopping) return;
    r.stopping = true;
    const duration = Math.round(performance.now() - r.t0);
    await new Promise((resolve) => {
        r.mr.onstop = resolve;
        try { r.mr.stop(); } catch (_) { resolve(); }
    });
    try { r.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    if (rec === r) rec = null;
    if (r.cancelled || duration > MAX_WALL_MS + TAIL_MS + 4000 || !r.chunks.length) {
        if (pending?.rec === r) pending = null;
        return;
    }
    const entry = r.pending || { rec: r, claim: undefined };
    entry.video = new Blob(r.chunks, { type: r.mime.split(';')[0] });
    lastRun = { video: entry.video, at: Date.now(), time: r.finalTime || '' };
    entry.data = { v: 1, w: r.w, h: r.h, dur: duration, hud: r.hud, audio: r.audio };
    if (!pending || pending.rec === r) pending = entry;
    maybeUpload(entry);
}

// ---------------------------------------------------------------- upload
async function gzip(text) {
    if (typeof CompressionStream === 'undefined') return new Blob([text], { type: 'application/json' });
    const s = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Blob([await new Response(s).arrayBuffer()], { type: 'application/gzip' });
}

async function uploadFile(blob, name, kind, token) {
    try {
        if (window.websim && typeof window.websim.upload === 'function') {
            const url = await window.websim.upload(new File([blob], name, { type: blob.type }));
            if (url) return url;
        }
    } catch (e) {
        console.warn('[replay] websim.upload failed, using backend', e);
    }
    const res = await fetch(`/api/replay/blob?token=${encodeURIComponent(token)}&kind=${kind}`, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'application/octet-stream' },
        body: blob,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.url) throw new Error(j.error || 'upload failed');
    return j.url;
}

async function maybeUpload(p = pending) {
    if (!p || !p.video || p.claim === undefined || p.uploading) return;
    if (!p.claim) { if (pending === p) pending = null; return; }
    p.uploading = true;
    const token = p.claim.replay_token;
    try {
        const ext = p.video.type.includes('mp4') ? 'mp4' : 'webm';
        const dataBlob = await gzip(JSON.stringify(p.data));
        const dataName = dataBlob.type === 'application/gzip' ? 'replay.json.gz' : 'replay.json';
        const [videoUrl, dataUrl] = await Promise.all([
            uploadFile(p.video, `replay.${ext}`, 'video', token),
            uploadFile(dataBlob, dataName, 'data', token),
        ]);
        const res = await fetch('/api/replay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, video_url: videoUrl, data_url: dataUrl, duration_ms: p.data.dur }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'save failed');
        console.log('[replay] saved to leaderboard');
    } catch (e) {
        console.warn('[replay] could not save replay', e);
    } finally {
        if (pending === p) pending = null;
    }
}

// ---------------------------------------------------------------- game hooks
window.__replayRunStarted = () => start();

window.__replayRunEnded = (success, finalTime) => {
    if (!rec) return;
    if (!canRecordRun() || !success || now() > MAX_WALL_MS) { discard(); pending = null; return; }
    rec.finalTime = finalTime || '';
    rec.stopAt = performance.now() + TAIL_MS;
    const entry = { rec, claim: undefined };
    rec.pending = pending = entry;
    // Tie the delayed score response to THIS recording, even if the player
    // has already started another run before the upload claim arrives.
    return claim => {
        entry.claim = claim?.replay_token ? claim : null;
        maybeUpload(entry);
    };
};

window.__replayClaim = (claim) => {
    if (!pending) return;
    pending.claim = claim && claim.replay_token ? claim : null;
    maybeUpload();
};

// Export: the player's own latest finished run from this session.
window.__replayLocalRun = () => lastRun;
window.__replayDownloadLocal = () => {
    if (!lastRun) return;
    const ext = lastRun.video.type.includes('mp4') ? 'mp4' : 'webm';
    const stamp = (lastRun.time || '').replace(/[^0-9]+/g, '-').replace(/^-|-$/g, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(lastRun.video);
    a.download = `MagMart-run${stamp ? '-' + stamp : ''}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

net.onFrame((t) => {
    if (!rec || rec.stopping) return;
    const gs = typeof window.__ssGameState === 'function' ? window.__ssGameState() : null;
    const live = !!(gs && gs.live);
    if (rec.stopAt) {
        if (t >= rec.stopAt || !live) finish();
        else tickHud();
        return;
    }
    if (!canRecordRun()) { discard(); pending = null; return; }
    // Left the run without finishing it, or exceeded the recording safety cap.
    if (!live || now() > MAX_WALL_MS) { discard(); pending = null; return; }
    tickHud();
});

// Leaderboard replay player: plays a top-10 player's recorded best run as
// they saw it — the recorded first-person video, their HUD rebuilt on top
// from the recorded timeline, and the game's sounds replayed in sync.

import { startAudioMirror, stopAudioMirror, applyAudioSnapshot, clearMirrors, holdMirrors } from './audio.js';
import { hudSrcdoc, writeHud } from './hud-frame.js';
import { net } from './net.js';

const el = document.createElement('div');
el.id = 'rp-viewer';
el.className = 'hidden';
el.innerHTML = `
    <div class="ss-stage">
        <div class="ss-world"><video class="rp-video on" muted playsinline preload="auto" data-ss-mirror="1"></video></div>
        <iframe class="ss-hud" sandbox="allow-same-origin" tabindex="-1" aria-hidden="true"></iframe>
        <div class="ss-wait hidden"><div class="ss-spinner"></div><span>Loading replay…</span></div>
    </div>
    <div class="ss-bar">
        <a class="ss-who" target="_blank" rel="noopener"><img alt=""><span></span></a>
        <span class="ss-badge rp-badge"></span>
        <button type="button" class="rp-play" aria-label="Pause">❚❚</button>
        <input type="range" class="rp-seek" min="0" max="1000" value="0" step="1" aria-label="Seek">
        <span class="ss-time rp-time">0:00 / 0:00</span>
        <button type="button" class="rp-retry hidden">Retry</button>
        <button type="button" class="ss-leave">Leave</button>
    </div>`;
document.body.appendChild(el);

const stageEl = el.querySelector('.ss-stage');
const worldEl = el.querySelector('.ss-world');
const video = el.querySelector('.rp-video');
const hudFrame = el.querySelector('.ss-hud');
const waitEl = el.querySelector('.ss-wait');
const waitText = waitEl.querySelector('span');
const whoEl = el.querySelector('.ss-who');
const badgeEl = el.querySelector('.rp-badge');
const playBtn = el.querySelector('.rp-play');
const seekEl = el.querySelector('.rp-seek');
const timeEl = el.querySelector('.rp-time');
const retryBtn = el.querySelector('.rp-retry');

const st = {
    open: false,
    data: null,
    dur: 1,
    recordedDur: 0,
    timelineDur: 0,
    w: 1280,
    h: 720,
    hudReady: false,
    hudIdx: 0,        // next HUD delta to apply
    hud: {},          // accumulated HUD state
    hudDirty: false,
    audioIdx: 0,      // next audio snapshot to apply
    lastT: 0,
    ended: false,
    seeking: false,
    token: 0,
    entry: null,
    controller: null,
    waitingSince: 0,
    blocked: false,
    failed: false,
};

function message(text, retry = false) {
    waitText.textContent = text;
    waitEl.classList.remove('hidden');
    retryBtn.classList.toggle('hidden', !retry);
}
function fail(text) {
    st.failed = true;
    st.waitingSince = 0;
    video.pause();
    holdMirrors(true);
    message(text, true);
    renderPlay();
}

function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function positiveMs(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function updateDuration() {
    if (!st.open) return;
    const current = positiveMs(video.currentTime * 1000);
    let seekableEnd = 0;
    try {
        const ranges = video.seekable;
        if (ranges.length) seekableEnd = positiveMs(ranges.end(ranges.length - 1) * 1000);
    } catch (_) {}
    // A fragmented recording can initially report only its first few seconds.
    // Never shrink the known full recording/timeline to that partial metadata,
    // or treat the currently buffered portion as the end of the replay.
    st.dur = video.ended && current ? current : Math.max(1, st.dur,
        st.recordedDur, st.timelineDur, positiveMs(video.duration * 1000), current, seekableEnd);
    if (!st.seeking) {
        seekEl.value = String(Math.round(Math.min(1, current / st.dur) * 1000));
        timeEl.textContent = `${fmt(current)} / ${fmt(st.dur)}`;
    }
}

function layout() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const s = Math.min(vw / st.w, vh / st.h);
    stageEl.style.width = `${Math.round(st.w * s)}px`;
    stageEl.style.height = `${Math.round(st.h * s)}px`;
    hudFrame.style.width = `${st.w}px`;
    hudFrame.style.height = `${st.h}px`;
    hudFrame.style.transform = `scale(${s})`;
}
window.addEventListener('resize', () => { if (st.open) layout(); });

async function loadData(url, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error('replay data unavailable');
    const buf = new Uint8Array(await res.arrayBuffer());
    let text;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
        if (typeof DecompressionStream === 'undefined') throw new Error('HUD decompression unavailable');
        const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
        text = await new Response(s).text();
    } else {
        text = new TextDecoder().decode(buf);
    }
    const d = JSON.parse(text);
    const hud = Array.isArray(d.hud) ? d.hud : [];
    const audio = Array.isArray(d.audio) ? d.audio : [];
    return {
        w: Number(d.w) || 1280,
        h: Number(d.h) || 720,
        dur: Math.max(positiveMs(d.dur), positiveMs(hud.at(-1)?.[0]), positiveMs(audio.at(-1)?.[0])),
        hud,
        audio,
    };
}

// ------------------------------------------------------------- timeline
function flushHud() {
    if (!st.hudDirty || !st.hudReady) return;
    const h = st.hud;
    if (h.w && h.h && (h.w !== st.w || h.h !== st.h)) { st.w = h.w; st.h = h.h; layout(); }
    const cv = h.cv || {};
    worldEl.style.filter = cv.f || '';
    worldEl.style.transform = cv.t || '';
    worldEl.style.opacity = cv.o || '';
    if (writeHud(hudFrame, h)) st.hudDirty = false;
}

function advance(tMs) {
    const d = st.data;
    if (!d) return;
    if (tMs < st.lastT - 50) rewind(tMs);
    st.lastT = tMs;
    while (st.hudIdx < d.hud.length && d.hud[st.hudIdx][0] <= tMs) {
        Object.assign(st.hud, d.hud[st.hudIdx][1]);
        st.hudIdx++;
        st.hudDirty = true;
    }
    flushHud();
    while (st.audioIdx < d.audio.length && d.audio[st.audioIdx][0] <= tMs) {
        const [t, snap] = d.audio[st.audioIdx++];
        // Skip stale snapshots when catching up; only the newest one matters.
        const next = d.audio[st.audioIdx];
        if (next && next[0] <= tMs && !(snap.x && snap.x.length)) continue;
        applyAudioSnapshot(snap, video.paused ? 0 : (tMs - t) / 1000);
    }
    if (video.paused || video.readyState < 3) holdMirrors(true);
}

// Jump anywhere: rebuild HUD state from the start and restart the audio
// from the newest snapshot at or before the target time.
function rewind(tMs) {
    const d = st.data;
    st.hud = {};
    st.hudIdx = 0;
    while (st.hudIdx < d.hud.length && d.hud[st.hudIdx][0] <= tMs) Object.assign(st.hud, d.hud[st.hudIdx++][1]);
    st.hudDirty = true;
    clearMirrors();
    let i = 0;
    while (i < d.audio.length && d.audio[i][0] <= tMs) i++;
    st.audioIdx = i;
    if (i > 0) {
        const [t, snap] = d.audio[i - 1];
        applyAudioSnapshot({ p: snap.p || [], x: [] }, (tMs - t) / 1000);
        if (video.paused) holdMirrors(true);
    }
    st.lastT = tMs;
    flushHud();
}

// ------------------------------------------------------------- controls
function setPlaying(on) {
    if (on) {
        if (st.ended) { st.ended = false; video.currentTime = 0; rewind(0); }
        const token = st.token;
        st.blocked = false;
        st.waitingSince = performance.now();
        // Do not await play(): stalled/invalid media can leave that promise
        // pending forever. Media events and the watchdog own the loading UI.
        video.play().then(() => {
            if (!st.open || token !== st.token) return;
            st.failed = false;
            holdMirrors(false);
            renderPlay();
        }).catch(e => {
            if (!st.open || token !== st.token) return;
            if (e.name === 'AbortError') return;
            if (e.name === 'NotAllowedError') {
                st.blocked = true;
                st.waitingSince = 0;
                message('Press Play to watch this replay.');
                renderPlay();
            } else fail('This recording cannot play in this browser. Try Retry or another browser.');
        });
    } else {
        video.pause();
        holdMirrors(true);
    }
    renderPlay();
}
function renderPlay() {
    const playing = !video.paused && !st.ended;
    playBtn.textContent = st.ended ? '↻' : playing ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', st.ended ? 'Replay' : playing ? 'Pause' : 'Play');
}

playBtn.onclick = () => { setPlaying(video.paused || st.ended); playBtn.blur(); };
stageEl.addEventListener('click', () => { if (st.open && st.data) setPlaying(video.paused || st.ended); });
video.addEventListener('ended', () => { st.ended = true; updateDuration(); holdMirrors(true); renderPlay(); });
video.addEventListener('waiting', () => {
    if (st.open && !st.blocked && !st.failed) {
        st.waitingSince ||= performance.now();
        message('Buffering…');
        holdMirrors(true);
    }
});
video.addEventListener('playing', () => {
    if (!st.open) return;
    st.waitingSince = 0; st.blocked = false; st.failed = false;
    waitEl.classList.add('hidden'); retryBtn.classList.add('hidden');
    holdMirrors(false); renderPlay();
});
video.addEventListener('pause', () => { holdMirrors(true); renderPlay(); });
video.addEventListener('error', () => { if (st.open && video.getAttribute('src')) fail('The recording could not be loaded. Press Retry to try again.'); });
for (const type of ['loadedmetadata', 'durationchange', 'progress', 'timeupdate']) {
    video.addEventListener(type, updateDuration);
}
video.addEventListener('seeked', () => { if (!video.paused) waitEl.classList.add('hidden'); });

seekEl.addEventListener('input', () => {
    if (!st.data) return;
    st.seeking = true;
    const t = (Number(seekEl.value) / 1000) * st.dur;
    st.ended = false;
    try { video.currentTime = t / 1000; } catch (_) {}
    rewind(t);
    timeEl.textContent = `${fmt(t)} / ${fmt(st.dur)}`;
    renderPlay();
});
seekEl.addEventListener('change', () => { st.seeking = false; seekEl.blur(); });

el.querySelector('.ss-leave').onclick = () => close();
retryBtn.onclick = () => { const entry = st.entry; if (entry) open(entry); };

// Keep the game underneath from reacting to input while a replay is open.
for (const type of ['keydown', 'keyup']) {
    window.addEventListener(type, (e) => {
        if (!st.open) return;
        e.stopImmediatePropagation();
        if (type !== 'keydown') return;
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === ' ') { e.preventDefault(); if (st.data) setPlaying(video.paused || st.ended); }
    }, true);
}
for (const type of ['mousedown', 'mouseup', 'click', 'pointerdown', 'wheel', 'contextmenu']) {
    el.addEventListener(type, (e) => e.stopPropagation());
}

// --------------------------------------------------------------- open/close
async function open(entry) {
    if (!entry || !entry.replay_video_url) return;
    if (st.open) close();
    const token = ++st.token;
    st.open = true;
    // Video is usable even if an older run's optional HUD/audio file is gone.
    st.data = { hud: [], audio: [] };
    st.entry = entry;
    st.controller = new AbortController();
    st.waitingSince = performance.now();
    st.blocked = false; st.failed = false; st.seeking = false;
    st.ended = false;
    st.hud = {};
    st.hudIdx = 0;
    st.audioIdx = 0;
    st.lastT = 0;
    st.w = 1280; st.h = 720;
    st.recordedDur = positiveMs(entry.replay_duration_ms);
    st.timelineDur = 0;
    st.dur = Math.max(1, st.recordedDur);

    try { document.exitPointerLock?.(); } catch (_) {}
    const name = entry.username || 'Shopper';
    whoEl.querySelector('img').src = `https://images.websim.com/avatar/${encodeURIComponent(name)}`;
    whoEl.querySelector('span').textContent = `@${name}`;
    whoEl.href = `https://websim.com/@${encodeURIComponent(name)}`;
    badgeEl.textContent = `🏆 #${entry.rank || '?'} · ${entry.final_time || ''}`;
    seekEl.value = 0;
    timeEl.textContent = `0:00 / ${fmt(st.dur)}`;
    waitText.textContent = 'Loading replay…';
    waitEl.classList.remove('hidden');
    retryBtn.classList.add('hidden');
    worldEl.style.filter = worldEl.style.transform = worldEl.style.opacity = '';
    layout();

    st.hudReady = false;
    hudFrame.onload = () => { st.hudReady = true; flushHud(); };
    hudFrame.srcdoc = hudSrcdoc();

    el.classList.remove('hidden');
    document.body.classList.add('rp-watching');
    startAudioMirror('replay');
    renderPlay();

    try {
        // Resolve a fresh, public recording by run ID, not the viewer's own
        // upload/admin permissions or a stale leaderboard page index.
        let recording = entry;
        if (Number.isInteger(Number(entry.id)) && Number(entry.id) > 0) {
            const res = await fetch(`/api/replay/${Number(entry.id)}`, { cache: 'no-store', signal: st.controller.signal });
            const metadata = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(metadata.error || 'Recording unavailable.');
            recording = { ...entry, ...metadata };
        }
        if (token !== st.token) return;
        st.recordedDur = Math.max(st.recordedDur, positiveMs(recording.replay_duration_ms));
        st.dur = Math.max(st.dur, st.recordedDur);
        video.src = recording.replay_video_url;
        video.load();
        setPlaying(true);
        // Fetch the timeline in parallel; it must NEVER gate video playback.
        if (recording.replay_data_url) loadData(recording.replay_data_url, st.controller.signal).then(data => {
            if (token !== st.token) return;
            st.data = data;
            st.timelineDur = data.dur;
            updateDuration();
            st.w = data.w; st.h = data.h;
            layout(); rewind(video.currentTime * 1000);
        }).catch(e => {
            if (token === st.token && e.name !== 'AbortError') console.warn('[replay] optional HUD/audio unavailable; playing video', e);
        });
    } catch (e) {
        if (token !== st.token || st.failed) return;
        console.warn('[replay] load failed', e);
        fail(e.message || 'This replay could not be loaded.');
    }
}

function close() {
    if (!st.open) return;
    st.open = false;
    st.token++;
    st.controller?.abort(); st.controller = null;
    st.data = null;
    video.pause();
    video.removeAttribute('src');
    try { video.load(); } catch (_) {}
    hudFrame.onload = null;
    hudFrame.removeAttribute('srcdoc');
    stopAudioMirror();
    el.classList.add('hidden');
    document.body.classList.remove('rp-watching');
}

window.__replayWatch = open;

net.onFrame(() => {
    if (!st.open || !st.data) return;
    if (st.waitingSince && performance.now() - st.waitingSince > 15000) {
        st.controller?.abort();
        fail('Loading timed out. Press Retry to reconnect, or Leave to return to the leaderboard.');
    }
    const t = video.currentTime * 1000;
    if (!st.seeking) {
        updateDuration();
        advance(t);
    }
});

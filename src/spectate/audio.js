// Spectator audio. The game plays its sounds through <audio> elements using
// the project's own files, so rather than streaming raw audio we mirror the
// player's playback state (which file, position, volume, loop, rate) and the
// spectator plays the same files locally, in sync, at full quality.

import { net } from './net.js';
import { isStreaming } from './broadcast.js';
import { isRecording, recordAudio } from './recorder.js';

// ------------------------------------------------------------- broadcaster
const ids = new WeakMap();
const active = new Set();   // elements that played since they were last reported
const paused = new Set();   // elements paused by the game (not naturally ended)
let nextId = 1;
let dirty = false;
let lastSent = 0;
let lastJson = '';

function idOf(el) {
    let id = ids.get(el);
    if (!id) { id = nextId++; ids.set(el, id); }
    return id;
}

// Send the path the game used (e.g. "Shopping.mp3") so the spectator's page
// resolves it exactly like the player's page did, whatever host serves assets.
function shareableSrc(el) {
    const raw = el.getAttribute('src') || el.currentSrc || el.src || '';
    if (!raw || raw.startsWith('blob:')) return null;
    return raw.length > 600 ? null : raw;
}

function safeMirrorUrl(s) {
    if (typeof s !== 'string' || !s) return null;
    try {
        const u = new URL(s, document.baseURI);
        return (u.protocol === 'https:' || u.protocol === 'http:') ? s : null;
    } catch (_) { return null; }
}

function isMirror(el) { return el.dataset && el.dataset.ssMirror === '1'; }

const origPlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function (...args) {
    // While spectating, the spectator's own game/menu audio stays silent.
    if (mirrorTarget && !isMirror(this)) {
        if (!pausedLocal.includes(this)) pausedLocal.push(this);
        return Promise.resolve();
    }
    if (!(this instanceof HTMLVideoElement) && !isMirror(this)) {
        idOf(this);
        active.add(this);
        paused.delete(this);
        dirty = true;
    }
    return origPlay.apply(this, args);
};
const origPause = HTMLMediaElement.prototype.pause;
HTMLMediaElement.prototype.pause = function (...args) {
    if (active.has(this)) { paused.add(this); dirty = true; }
    return origPause.apply(this, args);
};

function snapshot() {
    const playing = [];
    const stopped = [];
    for (const el of active) {
        if (!el.paused && !el.ended) {
            const s = shareableSrc(el);
            if (!s) continue;
            playing.push({
                i: idOf(el),
                s,
                v: el.muted ? 0 : Math.round(el.volume * 100) / 100,
                l: el.loop ? 1 : 0,
                t: Math.round(el.currentTime * 100) / 100,
                r: el.playbackRate !== 1 ? Math.round(el.playbackRate * 100) / 100 : undefined,
            });
        } else {
            if (paused.has(el)) stopped.push(idOf(el));
            active.delete(el);
            paused.delete(el);
        }
    }
    return { p: playing, x: stopped };
}

net.onFrame((now) => {
    const streaming = isStreaming();
    const recording = isRecording();
    if (!streaming && !recording) {
        if (active.size > 200) active.clear();
        return;
    }
    // Immediately after a play/pause (so short SFX aren't missed), else 4 Hz.
    const interval = dirty ? 60 : 250;
    if (now - lastSent < interval) return;
    const snap = snapshot();
    // Positions change constantly; compare without them for the keepalive check.
    const key = JSON.stringify(snap.p.map(a => [a.i, a.v, a.l, a.r])) + JSON.stringify(snap.x);
    if (!dirty && key === lastJson && now - lastSent < 1500) return;
    dirty = false;
    lastJson = key;
    lastSent = now;
    if (streaming) net.send({ type: 'spec:audio', a: snap });
    if (recording) recordAudio(snap);
});

// ------------------------------------------------------------- spectator
const mirrors = new Map(); // remote id -> <audio>
let mirrorTarget = null;
let pausedLocal = [];      // the spectator's own sounds (menu music) paused while watching

function stopMirror(id) {
    const el = mirrors.get(id);
    if (!el) return;
    mirrors.delete(id);
    try { origPause.call(el); el.removeAttribute('src'); el.load(); } catch (_) {}
}

export function startAudioMirror(targetId) {
    stopAudioMirror();
    mirrorTarget = targetId;
    // Silence the spectator's own menu audio so only the player's game is heard.
    pausedLocal = [];
    document.querySelectorAll('audio, video').forEach(el => {
        if (!isMirror(el) && !el.paused) { pausedLocal.push(el); origPause.call(el); }
    });
    for (const el of active) {
        if (!el.paused && !pausedLocal.includes(el)) { pausedLocal.push(el); origPause.call(el); }
    }
}

export function stopAudioMirror() {
    mirrorTarget = null;
    [...mirrors.keys()].forEach(stopMirror);
    // Only resume looping audio (menu music); one-shot UI sounds stay stopped.
    pausedLocal.forEach(el => { if (el.loop) { try { origPlay.call(el).catch(() => {}); } catch (_) {} } });
    pausedLocal = [];
}

// Autoplay safety net: if the browser refused, the next click/tap/key in the
// viewer resumes every mirrored sound that should be playing.
let blocked = false;
function unlock() {
    if (!blocked || !mirrorTarget) return;
    blocked = false;
    for (const el of mirrors.values()) if (el.paused) origPlay.call(el).catch(() => {});
}
window.addEventListener('pointerdown', unlock, true);
window.addEventListener('keydown', unlock, true);

// Silence and drop every mirrored sound (used when a replay seeks).
export function clearMirrors() { [...mirrors.keys()].forEach(stopMirror); }

// Pause/resume mirrored sounds in place (replay pause).
export function holdMirrors(hold) {
    for (const el of mirrors.values()) {
        if (hold) origPause.call(el);
        else origPlay.call(el).catch(() => {});
    }
}

net.on('spec:audio', (msg) => {
    if (!mirrorTarget || msg.id !== mirrorTarget || !msg.a) return;
    applyAudioSnapshot(msg.a);
});

// Bring the mirrored sounds in line with one playback snapshot. `ahead` is
// how many seconds of the snapshot's time have already passed (replays).
export function applyAudioSnapshot(a, ahead = 0) {
    if (!mirrorTarget || !a) return;
    const { p = [], x = [] } = a;
    x.forEach(stopMirror);
    for (const a of p) {
        const src = safeMirrorUrl(a.s);
        if (!src) continue;
        let el = mirrors.get(a.i);
        if (el && el.dataset.ssSrc !== src) { stopMirror(a.i); el = null; }
        const t = (Number(a.t) || 0) + ahead * (Number(a.r) || 1);
        if (!el) {
            el = new Audio();
            el.dataset.ssMirror = '1';
            el.dataset.ssSrc = src;
            el.src = src;
            el.preload = 'auto';
            mirrors.set(a.i, el);
            el.addEventListener('ended', () => { if (mirrors.get(a.i) === el) mirrors.delete(a.i); });
            try { el.currentTime = t; } catch (_) {}
        } else if (Math.abs(el.currentTime - t) > 0.4 && (a.l || t < (el.duration || Infinity))) {
            // Resync long tracks that drifted (music, ambience loops).
            try { el.currentTime = t; } catch (_) {}
        }
        el.volume = Math.max(0, Math.min(1, Number(a.v) || 0));
        el.loop = !!a.l;
        el.playbackRate = Number(a.r) || 1;
        if (el.paused) origPlay.call(el).catch((e) => {
            if (e && e.name === 'NotAllowedError') blocked = true;
        });
    }
}

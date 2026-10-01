// Every sound in the game goes through one Web Audio graph instead of a separate <audio> element each.
//
// createSound(src) returns an object that answers the same calls the game already makes on an
// <audio> element (play, pause, currentTime, volume, loop, muted, paused, cloneNode), so code
// that plays sounds doesn't change. What's different underneath:
//  - Sounds are played from small MP3s that tools/pack-sfx.mjs builds from the original files (src/sfx-pack.js
//    says which file and where in it). The sounds a normal run uses share one, sfx/pack.mp3, fetched and
//    decoded once the menu is up (loadSoundPacks); each event sound (nuke, side quests, freezer...) has its own
//    in sfx/packed/, downloaded after that (prefetchSoundFiles) but decoded only the first time it plays, so
//    memory only goes to what a run uses. The same sound can overlap
//    itself (cloneNode is cheap), loops loop without a gap, and a sound that isn't listed (new, say) loads
//    and decodes its own file on its first play.
//  - Music and other long MP3s ({stream: true}) stream from an <audio> element, routed through a gain node,
//    so they don't sit decoded in memory.
//  - Volume is a gain node in both cases. iPhones ignore <audio>.volume entirely (every sound
//    plays at full level there, fades and distance included); a gain node works everywhere.
//  - Two pools: plain sounds (UI, the player's own) and spatial ones ({spatial: true}), which sit at a
//    position in the world and are heard from the camera (setListener each frame): quieter with
//    distance, panned left/right. Each pool has a cap on voices playing at once; when it's full the
//    oldest voice in it fades out to make room.
//  - Everything meets in one bus with a limiter, so a pile-up of sounds can't clip.
// Browsers keep audio silent until the first tap or key press; unlock() runs on those.

import { SFX_PACK } from './sfx-pack.js';

const AC = window.AudioContext || window.webkitAudioContext;
const ctx = AC ? new AC() : null;
let bus = null;
let gestureAt = -1e9; // the last tap or key press (what lets a browser start audio)
// Audio still locked (no tap or key press yet): a one-shot would only come out late, piled up with the
// others, once it unlocks. Those are skipped; loops and music wait and start then.
const locked = () => ctx.state !== 'running' && performance.now() - gestureAt > 1000;
const POOLS = { plain: { cap: 32, live: [] }, spatial: { cap: 24, live: [] } };
if (ctx) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.002; limiter.release.value = 0.12;
    limiter.connect(ctx.destination);
    bus = ctx.createGain();
    bus.connect(limiter);
    if (/[?&]mute\b/.test(location.search)) bus.gain.value = 0; // ?mute: silent (automated tests)
    const unlock = () => { gestureAt = performance.now(); if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'touchend', 'keydown', 'click']) addEventListener(ev, unlock, true);
}

// One decode per file, shared by every sound (and clone) that plays it.
const decoded = new Map();
function decode(src) {
    if (!decoded.has(src)) {
        const bytes = fetched.get(src) || fetch(src).then(r => { if (!r.ok) throw new Error(`${r.status} ${src}`); return r.arrayBuffer(); });
        fetched.delete(src); // (decoding takes the bytes over)
        const p = bytes.then(b => new Promise((ok, fail) => ctx.decodeAudioData(b, ok, fail)));
        p.catch(() => decoded.delete(src)); // a failed load can be tried again later
        decoded.set(src, p);
    }
    return decoded.get(src);
}
const href = (src) => { try { return new URL(src, document.baseURI).href; } catch (_) { return src; } };
// The packs: {mark, load, sounds: {name: [file, start, duration]}} (seconds). Decoders may shift a whole file by
// a few ms (MP3 start padding, which browsers trim differently), so each file starts with a click at `mark`
// seconds; where it's found in the decoded audio says how far everything in it moved.
const packed = new Map(Object.entries(SFX_PACK?.sounds || {}).map(([k, v]) => [href(k), v]));
const packs = new Map();
function loadPack(file) {
    if (!packs.has(file)) packs.set(file, decode(file).then(b => {
        const x = b.getChannelData(0), end = Math.min(x.length, b.sampleRate);
        let i = 0; while (i < end && Math.abs(x[i]) < 0.3) i++;
        return { b, shift: i < end ? i / b.sampleRate - SFX_PACK.mark : 0 };
    }));
    return packs.get(file);
}
/** Fetch and decode the sounds every run uses (sfx/pack.mp3). Resolves when they're ready to play. */
export function loadSoundPacks() {
    return ctx ? Promise.all((SFX_PACK?.load || []).map((f) => loadPack(f))).then(() => {}, () => {}) : Promise.resolve();
}
// Event sounds' files, fetched ahead (prefetchSoundFiles) and decoded on their first play.
const fetched = new Map();
/** Quietly download every other sound file now, so an event's sound never waits on the network mid-run. */
export function prefetchSoundFiles() {
    if (!ctx) return;
    const files = new Set(Object.values(SFX_PACK?.sounds || {}).map((v) => v[0]));
    for (const f of files) {
        if ((SFX_PACK.load || []).includes(f) || fetched.has(f) || decoded.has(f)) continue;
        const p = fetch(f, { priority: 'low' }).then((r) => { if (!r.ok) throw new Error(`${r.status} ${f}`); return r.arrayBuffer(); });
        p.catch(() => fetched.delete(f));
        fetched.set(f, p);
    }
}
/** Is this file in the pack (played from memory) rather than a file of its own? */
export function isPacked(src) { return packed.has(href(src)); }
// Where a sound's audio is: {b: buffer, start, dur} (a stretch of the pack, or all of its own file)
const segments = new Map();
function segmentFor(src) {
    if (!segments.has(src)) {
        const at = packed.get(href(src));
        const p = at ? loadPack(at[0]).then(({ b, shift }) => ({ b, start: Math.max(0, at[1] + shift), dur: at[2] }))
            : decode(src).then(b => ({ b, start: 0, dur: b.duration }));
        p.catch(() => segments.delete(src));
        segments.set(src, p);
    }
    return segments.get(src);
}

// Spectating and replays are told about every play and pause (tapSounds); while watching someone,
// tap.play returns false and the viewer's own sounds stay quiet.
let tap = null;
export function tapSounds(t) { tap = t; }
const MAX_VOLUME = 4; // above 1 boosts (the bus limiter keeps it from clipping)

function fadeOut(v) {
    for (const p of Object.values(POOLS)) { const k = p.live.indexOf(v); if (k >= 0) p.live.splice(k, 1); }
    v.source.onended = null;
    try { v.gain.gain.cancelScheduledValues(ctx.currentTime); v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.005); v.source.stop(ctx.currentTime + 0.03); } catch (_) {}
    setTimeout(() => { try { v.gain.disconnect(); v.panner?.disconnect(); } catch (_) {} }, 80);
}
function setPos(node, p) {
    if (!p) return;
    if (node.positionX) { node.positionX.value = p.x; node.positionY.value = p.y; node.positionZ.value = p.z; }
    else node.setPosition(p.x, p.y, p.z);
}

class BufferSound {
    constructor(src, opts = {}) {
        this.src = src;
        // spatial: true, or {refDistance, rolloff, maxDistance}; position: {x, y, z} (setPosition)
        this.spatial = opts.spatial ? (opts.spatial === true ? {} : opts.spatial) : null;
        this.position = opts.position || null;
        this.loop = !!opts.loop;
        this._volume = opts.volume ?? 1;
        this._muted = false;
        this.paused = true;
        this._offset = 0;     // where play() starts from (seconds)
        this._voice = null;   // {source, gain, startedAt, offset}
        this._duration = NaN;
        this._rate = 1;
        this._want = 0;       // play() calls waiting for the decode (a pause() in between cancels them)
        // (a sound in sfx/pack.mp3 is decoded with it, at page load; any other on its first play)
    }
    get duration() { return this._duration; }
    /** Playback speed (1 = as recorded; higher is faster and higher-pitched); glides on a playing voice. */
    get playbackRate() { return this._rate; }
    set playbackRate(r) {
        this._rate = Math.max(0.25, Math.min(4, +r || 1));
        if (this._voice) this._voice.source.playbackRate.setTargetAtTime(this._rate, ctx.currentTime, 0.05);
    }
    get volume() { return this._volume; }
    set volume(v) {
        this._volume = Math.max(0, Math.min(MAX_VOLUME, +v || 0));
        if (this._voice) this._voice.gain.gain.setTargetAtTime(this._level(), ctx.currentTime, 0.015);
    }
    get muted() { return this._muted; }
    set muted(m) { this._muted = !!m; this.volume = this._volume; }
    _level() { return this._muted ? 0 : this._volume; }
    get currentTime() {
        const v = this._voice;
        if (!v) return this._offset;
        const t = v.offset + (ctx.currentTime - v.startedAt) * this._rate;
        return this.loop ? t % v.dur : Math.min(t, v.dur);
    }
    set currentTime(t) {
        this._offset = Math.max(0, +t || 0);
        if (this._voice) { this._stopVoice(); this._start(); } // a seek while playing keeps playing
    }
    play() {
        if (!ctx) return Promise.resolve();
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        if (!this.paused && this._voice) return Promise.resolve();
        if (tap && !this.mirror && tap.play(this) === false) return Promise.resolve();
        this.paused = false;
        const ticket = ++this._want;
        return segmentFor(this.src).then(() => { if (ticket === this._want && !this.paused && !this._voice) this._start(); }, () => { this.paused = true; });
    }
    pause() {
        if (tap && !this.mirror && !this.paused) tap.pause(this);
        this._want++;
        if (this._voice) { this._offset = this.currentTime; this._stopVoice(); }
        this.paused = true;
    }
    cloneNode() { const c = new BufferSound(this.src, { loop: this.loop, volume: this._volume, spatial: this.spatial, position: this.position }); c.muted = this._muted; return c; }
    _start() {
        segmentFor(this.src).then(({ b, start, dur }) => {
            if (this.paused || this._voice) return;
            if (!this.loop && locked()) { this.paused = true; return; }
            const source = ctx.createBufferSource(), gain = ctx.createGain();
            source.buffer = b; this._duration = dur; source.playbackRate.value = this._rate;
            if (this.loop) { source.loop = true; source.loopStart = start; source.loopEnd = start + dur; }
            gain.gain.value = this._level();
            source.connect(gain);
            let panner = null;
            if (this.spatial) {
                panner = ctx.createPanner();
                panner.panningModel = 'equalpower'; panner.distanceModel = 'inverse';
                panner.refDistance = this.spatial.refDistance ?? 4; panner.rolloffFactor = this.spatial.rolloff ?? 1;
                panner.maxDistance = this.spatial.maxDistance ?? 80;
                setPos(panner, this.position);
                gain.connect(panner); panner.connect(bus);
            } else gain.connect(bus);
            const offset = this._offset >= dur ? 0 : this._offset;
            const voice = { source, gain, panner, startedAt: ctx.currentTime, offset, dur, owner: this };
            const pool = POOLS[this.spatial ? 'spatial' : 'plain'];
            source.onended = () => {
                const k = pool.live.indexOf(voice); if (k >= 0) pool.live.splice(k, 1);
                if (this._voice !== voice) return;
                this._voice = null; this.paused = true; this._offset = dur; // as <audio> does at its end
                try { gain.disconnect(); panner?.disconnect(); } catch (_) {}
                this.onended?.();
            };
            if (this.loop) source.start(0, start + offset); else source.start(0, start + offset, dur - offset);
            this._voice = voice;
            // full pool: the oldest voice in it makes room
            pool.live.push(voice);
            while (pool.live.length > pool.cap) { const old = pool.live.shift(); old.owner._voice === old ? old.owner.pause() : fadeOut(old); }
        }, () => { this.paused = true; });
    }
    _stopVoice() {
        const v = this._voice; this._voice = null;
        if (v) fadeOut(v);
    }
    /**
     * Play only [start, end) seconds of this sound, as an extra voice alongside anything it's playing
     * (one footstep out of a file of them). rate: playback speed (pitch variation).
     */
    playSlice(start, end, { rate = 1 } = {}) {
        if (!ctx) return;
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        segmentFor(this.src).then(({ b, start: at, dur }) => {
            if (locked()) return;
            const source = ctx.createBufferSource(), gain = ctx.createGain(), t = ctx.currentTime;
            const from = Math.max(0, Math.min(start, dur - 0.01)), span = Math.max(0.01, Math.min(end, dur) - from), len = span / rate;
            source.buffer = b; source.playbackRate.value = rate;
            gain.gain.setValueAtTime(this._level(), t);
            gain.gain.setValueAtTime(this._level(), t + len * 0.85);
            gain.gain.linearRampToValueAtTime(0, t + len); // (a slice can end mid-sound: fade, don't click)
            source.connect(gain); gain.connect(bus);
            const voice = { source, gain, panner: null, owner: { _voice: null } }, pool = POOLS.plain;
            source.onended = () => { const k = pool.live.indexOf(voice); if (k >= 0) pool.live.splice(k, 1); try { gain.disconnect(); } catch (_) {} };
            source.start(t, at + from, span);
            pool.live.push(voice);
            while (pool.live.length > pool.cap) { const old = pool.live.shift(); old.owner._voice === old ? old.owner.pause() : fadeOut(old); }
        }).catch(() => {});
    }
    /** Where a spatial sound is ({x, y, z}); moves a voice that's playing too. */
    setPosition(x, y, z) {
        this.position = { x, y, z };
        if (this._voice?.panner) setPos(this._voice.panner, this.position);
    }
}

// Long sounds: the element streams; its level is a gain node (element volume stays at 1).
class StreamSound {
    constructor(src, opts = {}) {
        this.src = src;
        this.el = new Audio(src);
        this.el.loop = !!opts.loop;
        this.el.preload = 'none';
        this._volume = opts.volume ?? 1;
        this._muted = false;
        this.gain = null;
        if (ctx) {
            try {
                this.gain = ctx.createGain();
                ctx.createMediaElementSource(this.el).connect(this.gain);
                this.gain.connect(bus);
            } catch (_) { this.gain = null; }
        }
        this._apply();
    }
    _apply() {
        const level = this._muted ? 0 : this._volume;
        if (this.gain) { this.gain.gain.setTargetAtTime(level, ctx.currentTime, 0.015); this.el.volume = 1; }
        else this.el.volume = level;
    }
    get volume() { return this._volume; }
    set volume(v) { this._volume = Math.max(0, Math.min(this.gain ? MAX_VOLUME : 1, +v || 0)); this._apply(); }
    get muted() { return this._muted; }
    set muted(m) { this._muted = !!m; this._apply(); }
    get loop() { return this.el.loop; }
    set loop(l) { this.el.loop = !!l; }
    get paused() { return this.el.paused; }
    get duration() { return this.el.duration; }
    get currentTime() { return this.el.currentTime; }
    set currentTime(t) { try { this.el.currentTime = t; } catch (_) {} }
    get playbackRate() { return this.el.playbackRate; }
    set playbackRate(r) { this.el.playbackRate = r; }
    set onended(f) { this.el.onended = f; }
    play() {
        if (tap && !this.mirror && tap.play(this) === false) return Promise.resolve();
        if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
        return this.el.play();
    }
    pause() { if (tap && !this.mirror && !this.el.paused) tap.pause(this); this.el.pause(); }
    cloneNode() { const c = new StreamSound(this.src, { loop: this.loop, volume: this._volume }); c.muted = this._muted; return c; }
    /** Done with it: stop downloading and let it go. */
    release() {
        this.pause();
        try { this.el.removeAttribute('src'); this.el.load(); this.gain?.disconnect(); } catch (_) {}
    }
}

/** A sound for `src`. opts: {volume, loop, stream, spatial, position} — stream for long sounds (music, ambience). */
export function createSound(src, opts = {}) {
    if (!ctx) { const a = new Audio(src); a.loop = !!opts.loop; a.volume = Math.min(1, opts.volume ?? 1); a.release = () => { a.pause(); a.removeAttribute('src'); a.load(); }; return a; }
    return opts.stream && !isPacked(src) ? new StreamSound(src, opts) : new BufferSound(src, opts);
}

/** The ears: where the camera is and which way it faces (call once a frame). */
const _fwd = { x: 0, y: 0, z: -1 };
export function setListener(camera) {
    if (!ctx || !camera) return;
    const L = ctx.listener, p = camera.getWorldPosition ? camera.getWorldPosition(_tmpV ||= new camera.position.constructor()) : camera.position;
    const e = camera.matrixWorld.elements; // forward = -Z column, up = Y column
    _fwd.x = -e[8]; _fwd.y = -e[9]; _fwd.z = -e[10];
    if (L.positionX) {
        const t = ctx.currentTime;
        L.positionX.setTargetAtTime(p.x, t, 0.02); L.positionY.setTargetAtTime(p.y, t, 0.02); L.positionZ.setTargetAtTime(p.z, t, 0.02);
        L.forwardX.setTargetAtTime(_fwd.x, t, 0.02); L.forwardY.setTargetAtTime(_fwd.y, t, 0.02); L.forwardZ.setTargetAtTime(_fwd.z, t, 0.02);
        L.upX.value = e[4]; L.upY.value = e[5]; L.upZ.value = e[6];
    } else {
        L.setPosition(p.x, p.y, p.z); L.setOrientation(_fwd.x, _fwd.y, _fwd.z, e[4], e[5], e[6]);
    }
}
let _tmpV = null;


export const audioContext = ctx;

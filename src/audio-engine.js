// Sound effects through one Web Audio graph instead of a separate <audio> element each.
//
// createSound(src) returns an object that answers the same calls the game already makes on an
// <audio> element (play, pause, currentTime, volume, loop, muted, paused, cloneNode), so code
// that plays sounds doesn't change. What's different underneath:
//  - Short sounds are decoded once per file and played from that buffer: the same sound can
//    overlap itself (cloneNode is cheap), and starting one has no network or decode delay after
//    the first time.
//  - Long sounds ({stream: true}: drones, ambience, sirens) still stream from an <audio>
//    element, but routed through a gain node, so they don't sit decoded in memory.
//  - Volume is a gain node in both cases. iPhones ignore <audio>.volume entirely (every sound
//    plays at full level there, fades and distance included); a gain node works everywhere.
//  - Two pools: plain sounds (UI, the player's own) and spatial ones ({spatial: true}), which sit at a
//    position in the world and are heard from the camera (setListener each frame): quieter with
//    distance, panned left/right. Each pool has a cap on voices playing at once; when it's full the
//    oldest voice in it fades out to make room.
//  - Everything meets in one bus with a limiter, so a pile-up of sounds can't clip.
// Browsers keep audio silent until the first tap or key press; unlock() runs on those.

const AC = window.AudioContext || window.webkitAudioContext;
const ctx = AC ? new AC() : null;
let bus = null;
const POOLS = { plain: { cap: 32, live: [] }, spatial: { cap: 24, live: [] } };
if (ctx) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.002; limiter.release.value = 0.12;
    limiter.connect(ctx.destination);
    bus = ctx.createGain();
    bus.connect(limiter);
    if (/[?&]mute\b/.test(location.search)) bus.gain.value = 0; // ?mute: silent (automated tests)
    const unlock = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'touchend', 'keydown', 'click']) addEventListener(ev, unlock, true);
}

// One decode per file, shared by every sound (and clone) that plays it.
const buffers = new Map();
function bufferFor(src) {
    if (!buffers.has(src)) {
        const p = fetch(src)
            .then(r => { if (!r.ok) throw new Error(`${r.status} ${src}`); return r.arrayBuffer(); })
            .then(b => new Promise((ok, fail) => ctx.decodeAudioData(b, ok, fail)));
        p.catch(() => buffers.delete(src)); // a failed load can be tried again later
        buffers.set(src, p);
    }
    return buffers.get(src);
}

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
        this._want = 0;       // play() calls waiting for the decode (a pause() in between cancels them)
        // (decoded on first play, or ahead of time by preloadSounds)
    }
    get duration() { return this._duration; }
    get volume() { return this._volume; }
    set volume(v) {
        this._volume = Math.max(0, Math.min(1, +v || 0));
        if (this._voice) this._voice.gain.gain.setTargetAtTime(this._level(), ctx.currentTime, 0.015);
    }
    get muted() { return this._muted; }
    set muted(m) { this._muted = !!m; this.volume = this._volume; }
    _level() { return this._muted ? 0 : this._volume; }
    get currentTime() {
        const v = this._voice;
        if (!v) return this._offset;
        const t = v.offset + (ctx.currentTime - v.startedAt);
        return this.loop && v.source.buffer ? t % v.source.buffer.duration : Math.min(t, v.source.buffer?.duration ?? t);
    }
    set currentTime(t) {
        this._offset = Math.max(0, +t || 0);
        if (this._voice) { this._stopVoice(); this._start(); } // a seek while playing keeps playing
    }
    play() {
        if (!ctx) return Promise.resolve();
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        if (!this.paused && this._voice) return Promise.resolve();
        this.paused = false;
        const ticket = ++this._want;
        return bufferFor(this.src).then(() => { if (ticket === this._want && !this.paused && !this._voice) this._start(); }, () => { this.paused = true; });
    }
    pause() {
        this._want++;
        if (this._voice) { this._offset = this.currentTime; this._stopVoice(); }
        this.paused = true;
    }
    cloneNode() { const c = new BufferSound(this.src, { loop: this.loop, volume: this._volume, spatial: this.spatial, position: this.position }); c.muted = this._muted; return c; }
    _start() {
        bufferFor(this.src).then(b => {
            if (this.paused || this._voice) return;
            const source = ctx.createBufferSource(), gain = ctx.createGain();
            source.buffer = b; source.loop = this.loop; this._duration = b.duration;
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
            const offset = this._offset >= b.duration ? 0 : this._offset;
            const voice = { source, gain, panner, startedAt: ctx.currentTime, offset, owner: this };
            const pool = POOLS[this.spatial ? 'spatial' : 'plain'];
            source.onended = () => {
                const k = pool.live.indexOf(voice); if (k >= 0) pool.live.splice(k, 1);
                if (this._voice !== voice) return;
                this._voice = null; this.paused = true; this._offset = b.duration; // as <audio> does at its end
                try { gain.disconnect(); panner?.disconnect(); } catch (_) {}
            };
            source.start(0, offset);
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
    set volume(v) { this._volume = Math.max(0, Math.min(1, +v || 0)); this._apply(); }
    get muted() { return this._muted; }
    set muted(m) { this._muted = !!m; this._apply(); }
    get loop() { return this.el.loop; }
    set loop(l) { this.el.loop = !!l; }
    get paused() { return this.el.paused; }
    get duration() { return this.el.duration; }
    get currentTime() { return this.el.currentTime; }
    set currentTime(t) { try { this.el.currentTime = t; } catch (_) {} }
    play() { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); return this.el.play(); }
    pause() { this.el.pause(); }
    cloneNode() { const c = new StreamSound(this.src, { loop: this.loop, volume: this._volume }); c.muted = this._muted; return c; }
}

/** A sound for `src`. opts: {volume, loop, stream} — stream for long sounds (ambience, drones). */
export function createSound(src, opts = {}) {
    if (!ctx) { const a = new Audio(src); a.loop = !!opts.loop; a.volume = opts.volume ?? 1; return a; }
    return opts.stream ? new StreamSound(src, opts) : new BufferSound(src, opts);
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

/** Decode these now, so their first play has no delay. */
export function preloadSounds(srcs) { if (ctx) for (const s of srcs) bufferFor(s).catch(() => {}); }

export const audioContext = ctx;

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
//  - Everything meets in one bus with a limiter, so a pile-up of sounds can't clip.
// Browsers keep audio silent until the first tap or key press; unlock() runs on those.

const AC = window.AudioContext || window.webkitAudioContext;
const ctx = AC ? new AC() : null;
let bus = null;
if (ctx) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.002; limiter.release.value = 0.12;
    limiter.connect(ctx.destination);
    bus = ctx.createGain();
    bus.connect(limiter);
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

class BufferSound {
    constructor(src, opts = {}) {
        this.src = src;
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
    cloneNode() { const c = new BufferSound(this.src, { loop: this.loop, volume: this._volume }); c.muted = this._muted; return c; }
    _start() {
        bufferFor(this.src).then(b => {
            if (this.paused || this._voice) return;
            const source = ctx.createBufferSource(), gain = ctx.createGain();
            source.buffer = b; source.loop = this.loop; this._duration = b.duration;
            gain.gain.value = this._level();
            source.connect(gain); gain.connect(bus);
            const offset = this._offset >= b.duration ? 0 : this._offset;
            const voice = { source, gain, startedAt: ctx.currentTime, offset };
            source.onended = () => {
                if (this._voice !== voice) return;
                this._voice = null; this.paused = true; this._offset = b.duration; // as <audio> does at its end
                try { gain.disconnect(); } catch (_) {}
            };
            source.start(0, offset);
            this._voice = voice;
        }, () => { this.paused = true; });
    }
    _stopVoice() {
        const v = this._voice; this._voice = null;
        if (!v) return;
        v.source.onended = null;
        try { v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.005); v.source.stop(ctx.currentTime + 0.03); } catch (_) {}
        setTimeout(() => { try { v.gain.disconnect(); } catch (_) {} }, 80);
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

/** Decode these now, so their first play has no delay. */
export function preloadSounds(srcs) { if (ctx) for (const s of srcs) bufferFor(s).catch(() => {}); }

export const audioContext = ctx;

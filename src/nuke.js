// Nuclear Fallout — the rarest RNG event.
// Siren (30s) -> bomb drops far away -> mushroom cloud + rumbling ->
// shockwave. Anyone outside the restroom is obliterated; hide in the
// restroom and you wake up to a charred wasteland where only the
// mountain (and the restroom) remain.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { buildAftermath, updateAftermath, aftermathWindVolume, disposeAftermath } from './nuke-aftermath.js';

// Timeline (seconds from trigger)
const SIREN_END = 30;
const DROP_START = 30.5;
const DROP_TIME = 5;
const DETONATE = DROP_START + DROP_TIME;     // 35.5
const WAVE_TRAVEL = 12;                       // seconds from detonation to store
const BLACKOUT_TIME = 8;

// Far off to the north-west, clear of the mountain so the cloud fills the horizon.
export const BLAST = { x: -470, z: -430 };

let phase = 'idle';          // idle | siren | drop | blast | dead | blackout | aftermath
let t = 0;
let phaseT = 0;
let ctxRef = null;
let group = null;
let bomb = null;
let cloud = null;
let wave = null;
let waveSpeed = 60;
let overlay = null;
let sounds = {};
let shakeAmt = 0;
let bannerShrunk = false;
let dropWhistled = false;

const sfxVol = () => Math.max(0, Math.min(1, CONFIG.SFX_VOLUME ?? 0.7));
const clamp01 = v => Math.max(0, Math.min(1, v));
const smooth = v => { v = clamp01(v); return v * v * (3 - 2 * v); };

export function isNukeActive() { return phase !== 'idle'; }
// Once the countdown starts every other event is off.
export function isNukeLockdown() { return phase !== 'idle'; }
// Normal gameplay (customers, items, interactions) is gone.
export function isWorldFrozen() { return phase === 'blackout' || phase === 'aftermath' || phase === 'dead'; }
export function isAftermath() { return phase === 'aftermath' || phase === 'blackout'; }
export function isMovementLocked() { return phase === 'blackout' || phase === 'dead'; }

function makeAudio(src, loop = false) {
    const a = new Audio(src);
    a.loop = loop;
    a.preload = 'auto';
    return a;
}

function play(a, vol, restart = true) {
    if (!a) return;
    try {
        a.volume = clamp01(vol);
        if (restart) a.currentTime = 0;
        a.play().catch(() => {});
    } catch (_) {}
}

function stopSound(a) {
    if (!a) return;
    try { a.pause(); a.currentTime = 0; } catch (_) {}
}

function stopAllSounds() {
    Object.values(sounds).forEach(stopSound);
    setApproachGain(0);
}

// The approaching shockwave roar is routed through Web Audio so it can be
// pushed well past the 1.0 volume cap of a plain <audio> element.
let audioCtx = null;
let approachGain = null;
function boostApproach(a) {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        if (!a._nukeBoosted) {
            const src = audioCtx.createMediaElementSource(a);
            approachGain = audioCtx.createGain();
            approachGain.gain.value = 0;
            const comp = audioCtx.createDynamicsCompressor();
            comp.threshold.value = -6;
            comp.ratio.value = 4;
            src.connect(approachGain).connect(comp).connect(audioCtx.destination);
            a._nukeBoosted = true;
        }
        a.volume = 1;
    } catch (_) { approachGain = null; }
}
function setApproachGain(g) {
    if (approachGain && audioCtx) {
        approachGain.gain.setTargetAtTime(g, audioCtx.currentTime, 0.08);
    } else if (sounds.approach) {
        sounds.approach.volume = clamp01(g);
    }
}

// ---------------------------------------------------------------- overlay
function buildOverlay() {
    const el = document.createElement('div');
    el.id = 'nuke-overlay';
    el.innerHTML = `
        <div class="nuke-banner">
            <div class="nuke-banner-icon">☢</div>
            <div class="nuke-banner-title">A NUCLEAR FALLOUT IS IMMINENT.</div>
            <div class="nuke-banner-sub">TAKE COVER!</div>
        </div>
        <div class="nuke-tint"></div>
        <div class="nuke-flash"></div>
        <div class="nuke-wipe"></div>
        <div class="nuke-black"></div>
    `;
    (document.getElementById('game-container') || document.body).appendChild(el);
    return el;
}

// Overlay layers are looked up once per overlay and reused (setLayer runs every frame during the blast).
const layerCache = new Map();
let layerCacheOwner = null;
function setLayer(sel, opacity, transitionMs = null) {
    if (layerCacheOwner !== overlay) { layerCache.clear(); layerCacheOwner = overlay; }
    let layer = layerCache.get(sel);
    if (layer === undefined || (layer && !layer.isConnected)) {
        layer = overlay?.querySelector(sel) || null;
        if (overlay) layerCache.set(sel, layer);
    }
    if (!layer) return;
    if (transitionMs !== null) layer.style.transition = `opacity ${transitionMs}ms ease`;
    layer.style.opacity = String(opacity);
}

// ---------------------------------------------------------------- 3D pieces
function buildBomb() {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x4b5320, fog: false });
    const dark = new THREE.MeshLambertMaterial({ color: 0x1f2415, fog: false });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 22, 16), mat);
    g.add(body);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    nose.rotation.x = Math.PI;
    nose.position.y = -11;
    g.add(nose);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(4, 8, 16), mat);
    tail.position.y = 15;
    g.add(tail);
    for (let i = 0; i < 4; i++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.6, 8, 9), dark);
        fin.position.y = 17;
        fin.rotation.y = (i * Math.PI) / 2;
        fin.position.x = Math.cos(i * Math.PI / 2) * 0.01;
        g.add(fin);
    }
    const band = new THREE.Mesh(new THREE.CylinderGeometry(4.1, 4.1, 1.5, 16), new THREE.MeshBasicMaterial({ color: 0xfacc15, fog: false }));
    band.position.y = -4;
    g.add(band);
    g.visible = false;
    return g;
}

// Mushroom cloud built from one instanced mesh of puffs.
function buildCloud() {
    const COUNT = 260;
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xff7a1a, emissiveIntensity: 1.5, fog: false });
    const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const puffs = [];
    for (let i = 0; i < COUNT; i++) {
        let role;
        if (i < 70) role = 'stem';
        else if (i < 150) role = 'ring';
        else if (i < 210) role = 'dome';
        else role = 'base';
        puffs.push({
            role,
            a: Math.random() * Math.PI * 2,
            u: Math.random(),
            v: Math.random(),
            s: 0.7 + Math.random() * 0.6,
            spin: (Math.random() - 0.5) * 0.4
        });
    }
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    const fireball = new THREE.Mesh(
        new THREE.SphereGeometry(1, 32, 20),
        new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 1, fog: false })
    );
    const g = new THREE.Group();
    g.add(mesh, fireball);
    g.position.set(BLAST.x, 0, BLAST.z);
    g.visible = false;
    return { group: g, mesh, puffs, fireball, age: 0 };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _e = new THREE.Euler();
const FB_WHITE = new THREE.Color(0xfff8e0);
const FIRE = new THREE.Color(0xffb347);
const HOT = new THREE.Color(0xff5a1f);
const SMOKE = new THREE.Color(0x8c7a6b);
const DARK_SMOKE = new THREE.Color(0x5a4d44);

function updateCloud(dt) {
    if (!cloud) return;
    cloud.age += dt;
    const a = cloud.age;
    const grow = smooth(a / 14);             // overall rise
    const H = 40 + 330 * grow;               // cap height
    const capR = 40 + 150 * smooth(a / 16);
    const heat = Math.max(0, 1 - a / 18);    // fire -> smoke

    // Fireball: blinding at first, rises into the cap
    const fb = cloud.fireball;
    const fbScale = 20 + 70 * smooth(a / 2.5);
    fb.scale.setScalar(fbScale * (1 - 0.4 * smooth((a - 3) / 8)));
    fb.position.y = Math.max(fbScale * 0.6, H * 0.9);
    fb.material.opacity = Math.max(0, 1 - a / 9);
    fb.material.color.lerpColors(FB_WHITE, HOT, clamp01(a / 5));
    fb.visible = fb.material.opacity > 0.01;
    cloud.mesh.material.emissiveIntensity = 1.6 * heat;

    const puffs = cloud.puffs;
    for (let i = 0; i < puffs.length; i++) {
        const pf = puffs[i];
        const ang = pf.a + a * pf.spin * 0.25;
        let x = 0, y = 0, z = 0, sc = 1;
        const hotness = heat;
        if (pf.role === 'stem') {
            const h = pf.u * H * 0.92;
            const r = (10 + 18 * (1 - pf.u)) * (0.4 + 0.6 * grow) * pf.v;
            x = Math.cos(ang) * r; z = Math.sin(ang) * r; y = h;
            sc = (14 + 16 * (1 - pf.u) + 10 * pf.v) * (0.5 + 0.5 * grow);
            _c.lerpColors(DARK_SMOKE, FIRE, clamp01(hotness * (1.3 - pf.u)));
        } else if (pf.role === 'ring') {
            // Rolling torus: points orbit the ring's tube
            const roll = pf.u * Math.PI * 2 + a * 0.6;
            const tube = capR * 0.32;
            const rr = capR * 0.75 + Math.cos(roll) * tube;
            x = Math.cos(ang) * rr; z = Math.sin(ang) * rr;
            y = H + Math.sin(roll) * tube * 0.8;
            sc = (tube * 0.55) * pf.s;
            _c.lerpColors(SMOKE, FIRE, clamp01(hotness * (0.6 + 0.5 * Math.sin(roll))));
        } else if (pf.role === 'dome') {
            const phi = pf.u * Math.PI * 0.5;
            const rr = capR * 0.7 * Math.cos(phi);
            x = Math.cos(ang) * rr; z = Math.sin(ang) * rr;
            y = H + capR * 0.25 + Math.sin(phi) * capR * 0.45;
            sc = capR * 0.28 * pf.s;
            _c.lerpColors(SMOKE, FIRE, clamp01(hotness * 0.8 * (1 - pf.u)));
        } else {
            // Ground base surge
            const rr = (20 + 260 * smooth(a / 12)) * (0.5 + 0.5 * pf.u);
            x = Math.cos(ang) * rr; z = Math.sin(ang) * rr;
            y = 6 + pf.v * 18;
            sc = (12 + 18 * pf.s) * (0.4 + 0.6 * smooth(a / 6));
            _c.lerpColors(DARK_SMOKE, HOT, clamp01(hotness * 0.5));
        }
        _p.set(x, y, z);
        _q.setFromEuler(_e.set(pf.u * 6, ang, pf.v * 6));
        _s.setScalar(Math.max(0.01, sc));
        _m.compose(_p, _q, _s);
        cloud.mesh.setMatrixAt(i, _m);
        cloud.mesh.setColorAt(i, _c);
    }
    cloud.mesh.instanceMatrix.needsUpdate = true;
    if (cloud.mesh.instanceColor) cloud.mesh.instanceColor.needsUpdate = true;
}

function buildWave() {
    const g = new THREE.Group();
    const wallMat = new THREE.MeshBasicMaterial({
        color: 0xc7885a, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, fog: false
    });
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.04, 1, 96, 1, true), wallMat);
    wall.position.y = 0.5;
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffc27a, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false, fog: false
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 96), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.3;
    g.add(wall, ring);
    g.position.set(BLAST.x, 0, BLAST.z);
    g.visible = false;
    return { group: g, wall, ring, r: 0 };
}

// ---------------------------------------------------------------- lifecycle
export function startNuke(ctx) {
    if (phase !== 'idle') return false;
    ctxRef = ctx;
    phase = 'siren';
    t = 0; phaseT = 0; shakeAmt = 0;
    bannerShrunk = false; dropWhistled = false;

    sounds = {
        alert: makeAudio('sfx/nuke_alert.wav'),
        siren: makeAudio('sfx/nuke_siren.wav', true),
        screams: makeAudio('sfx/nuke_screams.wav', true),
        whistle: makeAudio('sfx/nuke_whistle.wav'),
        boom: makeAudio('sfx/nuke_boom.wav'),
        rumble: makeAudio('sfx/nuke_rumble.wav', true),
        shock: makeAudio('sfx/nuke_shockwave.wav'),
        approach: makeAudio('sfx/nuke_approach.wav', true),
        wind: makeAudio('sfx/nuke_wind.wav', true),
        fire: makeAudio('sfx/thermostat_fire.wav', true)
    };

    overlay = buildOverlay();
    requestAnimationFrame(() => overlay?.classList.add('show-banner'));

    group = new THREE.Group();
    group.userData.nukeKeep = true;
    bomb = buildBomb();
    cloud = buildCloud();
    wave = buildWave();
    group.add(bomb, cloud.group, wave.group);
    ctx.scene.add(group);

    play(sounds.alert, sfxVol());
    play(sounds.siren, Math.min(1, sfxVol() * 1.25));
    play(sounds.screams, sfxVol() * 0.45);
    return true;
}

function playerDistToBlast() {
    const p = ctxRef?.getPlayerPos?.();
    if (!p) return 600;
    return Math.hypot(p.x - BLAST.x, p.z - BLAST.z);
}

function pauseAll(paused) {
    Object.values(sounds).forEach(a => {
        if (!a || a.currentTime === 0 && a.paused) return;
        try {
            if (paused) { if (!a.paused) { a._nukeWasPlaying = true; a.pause(); } }
            else if (a._nukeWasPlaying) { a._nukeWasPlaying = false; a.play().catch(() => {}); }
        } catch (_) {}
    });
}

let wasPaused = false;
export function updateNuke(delta, now, ctx) {
    if (phase === 'idle') return;
    ctxRef = ctx;
    const dt = Math.min(0.1, delta || 0.016);
    const paused = !!ctx.paused && phase !== 'aftermath' && phase !== 'blackout' && phase !== 'dead';
    if (paused !== wasPaused) { pauseAll(paused); wasPaused = paused; }
    if (paused) return;
    if (ctx.isGameOver?.() && phase !== 'dead' && phase !== 'blackout' && phase !== 'aftermath') {
        // Run ended some other way (e.g. checked out in time): stand down.
        resetNuke();
        return;
    }
    t += dt;
    phaseT += dt;

    if (!bannerShrunk && t > 7) {
        bannerShrunk = true;
        overlay?.classList.add('banner-small');
    }

    if (phase === 'siren') {
        // Siren fades in its last two seconds
        if (t > SIREN_END - 2) sounds.siren.volume = clamp01(Math.min(1, sfxVol() * 1.25) * (SIREN_END - t) / 2);
        if (t >= SIREN_END) stopSound(sounds.siren);
        if (t >= DROP_START) { phase = 'drop'; phaseT = 0; bomb.visible = true; }
        shakeAmt = 0;
    }

    if (phase === 'drop') {
        if (!dropWhistled) { dropWhistled = true; play(sounds.whistle, sfxVol()); }
        const k = clamp01(phaseT / DROP_TIME);
        const y = 520 * (1 - k * k);
        bomb.position.set(BLAST.x + 60 * (1 - k), y, BLAST.z + 30 * (1 - k));
        bomb.rotation.set(0, 0, -0.35 * (1 - k));
        sounds.screams.volume = clamp01(sfxVol() * (0.45 + 0.25 * k));
        if (phaseT >= DROP_TIME) detonate();
    } else if (phase === 'blast') {
        updateCloud(dt);
        // Shockwave expands toward the store
        const dist = playerDistToBlast();
        wave.r += waveSpeed * dt;
        wave.group.visible = true;
        const h = 30 + 60 * clamp01(wave.r / 400);
        wave.wall.scale.set(wave.r, h, wave.r);
        wave.wall.position.y = h / 2;
        wave.ring.scale.setScalar(wave.r);
        const closeness = 1 - clamp01((dist - wave.r) / 500);   // 0 far .. 1 at impact
        shakeAmt = 0.02 + 0.09 * closeness * closeness;
        sounds.rumble.volume = clamp01(sfxVol() * (0.45 + 0.55 * closeness));
        // Deep roar swells from a murmur to deafening as the wave closes in
        const swell = 0.12 + 0.88 * Math.pow(closeness, 2.2);
        setApproachGain(sfxVol() * 3.2 * swell);
        setLayer('.nuke-tint', 0.25 + 0.35 * closeness);
        if (wave.r >= dist) impact();
    } else if (phase === 'dead') {
        shakeAmt = Math.max(0, 0.35 * (1 - phaseT / 1.4));
        if (cloud) updateCloud(dt);
    } else if (phase === 'blackout') {
        shakeAmt = 0;
        if (phaseT > 0.5 && !ctx._aftermathBuilt) {
            ctx._aftermathBuilt = true;
            ctx.onBuildAftermath?.();
            // Swap the wreckage in
            disposeBlastPieces();
            buildAftermath(ctx);
        }
        const fade = clamp01(1 - phaseT / BLACKOUT_TIME);
        sounds.rumble.volume = clamp01(sfxVol() * 0.3 * fade);
        if (phaseT >= BLACKOUT_TIME) {
            phase = 'aftermath';
            phaseT = 0;
            stopSound(sounds.rumble);
            setLayer('.nuke-black', 0, 3500);
            setLayer('.nuke-tint', 0, 3500);
            play(sounds.wind, 0);
            play(sounds.fire, 0);
            ctx.onSurvived?.();
        }
    } else if (phase === 'aftermath') {
        const p = ctx.getPlayerPos?.();
        const fadeIn = clamp01(phaseT / 4);
        const { wind, fire } = aftermathWindVolume(p);
        sounds.wind.volume = clamp01(sfxVol() * wind * fadeIn);
        sounds.fire.volume = clamp01(sfxVol() * fire * fadeIn);
        updateAftermath(dt, now, p);
    }
}

function detonate() {
    phase = 'blast';
    phaseT = 0;
    bomb.visible = false;
    cloud.group.visible = true;
    cloud.age = 0;
    wave.r = 0;
    // Tune the wave so it takes ~WAVE_TRAVEL seconds to reach the store
    waveSpeed = Math.hypot(BLAST.x, BLAST.z) / WAVE_TRAVEL;
    stopSound(sounds.whistle);
    play(sounds.boom, sfxVol());
    play(sounds.rumble, sfxVol() * 0.45);
    boostApproach(sounds.approach);
    setApproachGain(0);
    play(sounds.approach, approachGain ? 1 : 0.1);
    // Blinding flash
    setLayer('.nuke-flash', 1, 60);
    setTimeout(() => setLayer('.nuke-flash', 0, 3200), 220);
    ctxRef?.onDetonate?.();
}

function impact() {
    const survived = !!ctxRef?.isInShelter?.();
    stopSound(sounds.screams);
    stopSound(sounds.boom);
    stopSound(sounds.approach);
    setApproachGain(0);
    overlay?.classList.remove('show-banner');
    overlay?.classList.add('banner-gone');
    if (survived) {
        phase = 'blackout';
        phaseT = 0;
        ctxRef._aftermathBuilt = false;
        play(sounds.shock, sfxVol() * 0.55);
        setLayer('.nuke-black', 1, 120);
        ctxRef?.onShelteredImpact?.();
    } else {
        phase = 'dead';
        phaseT = 0;
        play(sounds.shock, sfxVol());
        overlay?.classList.add('wipe');
        setLayer('.nuke-wipe', 1, 250);
        ctxRef?.onUnshelteredImpact?.();
        setTimeout(() => {
            setLayer('.nuke-black', 1, 500);
            setTimeout(() => {
                stopSound(sounds.rumble);
                if (phase !== 'dead') return;
                ctxRef?.onObliterated?.();
            }, 2400);
        }, 700);
    }
}

// Screen-shake amount the camera code applies. The returned object is reused
// every frame; callers read it immediately and must not keep it.
const _shake = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0 };
export function getNukeShake(now) {
    if (shakeAmt <= 0) return null;
    const s = shakeAmt;
    _shake.x = (Math.sin(now * 0.041) + Math.cos(now * 0.067) * 0.6) * s;
    _shake.y = (Math.sin(now * 0.053) + Math.sin(now * 0.091) * 0.4) * s * 0.6;
    _shake.z = (Math.cos(now * 0.047) + Math.sin(now * 0.073) * 0.5) * s;
    _shake.pitch = Math.sin(now * 0.05) * s * 0.25;
    _shake.yaw = Math.cos(now * 0.043) * s * 0.25;
    return _shake;
}

function disposeBlastPieces() {
    if (!group) return;
    group.removeFromParent();
    group.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
    group = null; bomb = null; cloud = null; wave = null;
}

export function resetNuke() {
    stopAllSounds();
    disposeBlastPieces();
    disposeAftermath();
    overlay?.remove();
    overlay = null;
    phase = 'idle';
    t = 0; phaseT = 0; shakeAmt = 0;
    wasPaused = false;
    ctxRef = null;
}

// Overlay for the black-out/death screen stays until the fail overlay covers it.
export function clearNukeOverlay() {
    overlay?.remove();
    overlay = null;
}


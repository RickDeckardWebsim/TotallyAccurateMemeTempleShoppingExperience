// Thermostat Malfunction RNG event.
// The store swings from scorching (2x speed, sweat, flames that block you)
// to freezing (0.5x speed, frost, solid ice cubes) over 30-40 seconds.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CONFIG } from '../config.js';

const SPOT_HALF = 0.9;          // half-size of each blocking spot (units)
const PLAYER_CLEARANCE = 1.9;   // don't make a spot solid while the player overlaps it
const CART_CLEARANCE = 2.1;

let active = false;
let occurred = false;
let elapsed = 0;
let duration = 35;
let temp = 0;                   // -1 (frozen) .. 1 (scorching)
let spots = [];
let overlay = null;
let sceneRef = null;
let worldRef = null;
let audioRef = null;
let nextIceCrack = 0;

const clamp01 = v => Math.max(0, Math.min(1, v));
const smooth = v => { v = clamp01(v); return v * v * (3 - 2 * v); };

// Temperature curve: ramp up to hot, hold, slow drift to cold, hold, recover.
function tempAt(p) {
    if (p < 0.08) return smooth(p / 0.08);
    if (p < 0.32) return 1;
    if (p < 0.68) return 1 - 2 * smooth((p - 0.32) / 0.36);
    if (p < 0.92) return -1;
    return -1 + smooth((p - 0.92) / 0.08);
}

export function isThermostatActive() { return active; }
export function thermostatOccurred() { return occurred; }

// 2x when fully hot, 0.5x when fully cold, smooth in between.
export function getThermostatSpeedMultiplier() {
    return active ? Math.pow(2, temp) : 1;
}

function buildOverlay() {
    const el = document.createElement('div');
    el.id = 'thermostat-overlay';
    el.innerHTML = `
        <div class="thermo-heat"></div>
        <div class="thermo-sweat"></div>
        <div class="thermo-frost"></div>
    `;
    const sweat = el.querySelector('.thermo-sweat');
    for (let i = 0; i < 14; i++) {
        const d = document.createElement('span');
        d.className = 'thermo-drop';
        const edge = Math.random() < 0.5 ? Math.random() * 22 : 78 + Math.random() * 22;
        d.style.left = `${Math.random() < 0.7 ? edge : 10 + Math.random() * 80}%`;
        d.style.setProperty('--size', `${10 + Math.random() * 14}px`);
        d.style.setProperty('--dur', `${3.5 + Math.random() * 4}s`);
        d.style.animationDelay = `${-Math.random() * 7}s`;
        sweat.appendChild(d);
    }
    const gc = document.getElementById('game-container') || document.body;
    // Insert before the HUD so it always sits beneath the list and alerts.
    const ui = document.getElementById('ui-container');
    if (ui && ui.parentNode === gc) gc.insertBefore(el, ui);
    else gc.appendChild(el);
    return el;
}

function makeFlame() {
    const g = new THREE.Group();
    const cols = [0xff3b00, 0xff7a00, 0xffc233];
    const tongues = [];
    for (let i = 0; i < 7; i++) {
        const layer = i % 3;
        const h = 1.5 - layer * 0.35 + Math.random() * 0.3;
        const geom = new THREE.ConeGeometry(0.32 - layer * 0.07, h, 10, 1, true);
        geom.translate(0, h / 2, 0);
        const mat = new THREE.MeshBasicMaterial({
            color: cols[layer], transparent: true, opacity: 0.85 - layer * 0.1,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
        });
        const m = new THREE.Mesh(geom, mat);
        const a = Math.random() * Math.PI * 2;
        const r = layer === 2 ? Math.random() * 0.25 : 0.25 + Math.random() * 0.45;
        m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        m.userData.phase = Math.random() * Math.PI * 2;
        m.userData.speed = 7 + Math.random() * 6;
        g.add(m);
        tongues.push(m);
    }
    const glow = new THREE.Mesh(
        new THREE.CircleGeometry(1.05, 24),
        new THREE.MeshBasicMaterial({ color: 0xff5a00, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.02;
    g.add(glow);
    g.userData.tongues = tongues;
    g.userData.glow = glow;
    return g;
}

let iceMat = null;
function makeIce() {
    if (!iceMat) {
        iceMat = new THREE.MeshStandardMaterial({
            color: 0xcdefff, emissive: 0x4aa8ff, emissiveIntensity: 0.18,
            roughness: 0.08, metalness: 0.05, transparent: true, opacity: 0.82
        });
    }
    const g = new THREE.Group();
    const s = 1.7 + Math.random() * 0.2;
    const cube = new THREE.Mesh(new RoundedBoxGeometry(s, s * 0.95, s, 3, 0.18), iceMat);
    cube.position.y = s * 0.475;
    cube.rotation.set((Math.random() - 0.5) * 0.12, Math.random() * Math.PI, (Math.random() - 0.5) * 0.12);
    cube.castShadow = true;
    g.add(cube);
    return g;
}

function pickSpots(ctx, count) {
    const out = [];
    const { isWalkable, navGrid, shelfUnits = [], playerPos } = ctx;
    for (let tries = 0; tries < 400 && out.length < count; tries++) {
        const x = -24 + Math.random() * 48;
        const z = -22 + Math.random() * 46;
        if (Math.hypot(x - 15, z + 15) < 6) continue;        // checkout
        if (z < -20 && Math.abs(x) < 6) continue;              // entrance
        if (playerPos && Math.hypot(x - playerPos.x, z - playerPos.z) < 4) continue;
        if (out.some(s => Math.hypot(s.x - x, s.z - z) < 4.5)) continue;
        if (shelfUnits.some(u => Math.hypot(x - u.position.x, z - u.position.z) < 2.2)) continue;
        let ok = true;
        if (isWalkable && navGrid) {
            for (const [ox, oz] of [[0, 0], [1.3, 0], [-1.3, 0], [0, 1.3], [0, -1.3]]) {
                if (!isWalkable(navGrid, x + ox, z + oz)) { ok = false; break; }
            }
        }
        if (ok) out.push({ x, z });
    }
    return out;
}

function stopThermostatAudio() {
    if (!audioRef) return;
    for (const audio of [audioRef.thermostatFire, audioRef.thermostatWind, audioRef.thermostatIceCrack]) {
        // Already stopped: skip (this runs every frame while paused)
        if (!audio || (audio.paused && audio.currentTime === 0)) continue;
        audio.pause();
        audio.currentTime = 0;
    }
}

function updateThermostatAudio(heat, cold) {
    if (!audioRef) return;
    for (const [audio, intensity, level] of [
        [audioRef.thermostatFire, heat, 0.65],
        [audioRef.thermostatWind, cold, 0.7]
    ]) {
        if (!audio) continue;
        audio.volume = Math.min(1, CONFIG.SFX_VOLUME * level * intensity);
        if (intensity > 0.02 && CONFIG.SFX_VOLUME > 0) {
            if (audio.paused) audio.play().catch(() => {});
        } else if (!audio.paused) {
            audio.pause();
        }
    }
    if (cold > 0.65 && elapsed >= nextIceCrack) {
        const crack = audioRef.thermostatIceCrack;
        if (crack) {
            crack.volume = Math.min(1, CONFIG.SFX_VOLUME * 0.55 * cold);
            crack.currentTime = 0;
            if (CONFIG.SFX_VOLUME > 0) crack.play().catch(() => {});
        }
        nextIceCrack = elapsed + 4 + Math.random() * 2;
    }
}

export function startThermostatEvent(ctx) {
    if (active || !ctx.scene || !ctx.world) return false;
    resetThermostat();
    sceneRef = ctx.scene;
    worldRef = ctx.world;
    active = true;
    occurred = true;
    elapsed = 0;
    temp = 0;
    duration = 30 + Math.random() * 10;
    audioRef = ctx.soundEffects;
    nextIceCrack = 0;

    overlay = buildOverlay();

    spots = pickSpots(ctx, 9 + Math.floor(Math.random() * 4)).map(({ x, z }) => {
        const flame = makeFlame();
        const ice = makeIce();
        flame.position.set(x, 0, z);
        ice.position.set(x, 0, z);
        flame.scale.setScalar(0.001);
        ice.scale.setScalar(0.001);
        flame.visible = ice.visible = false;
        sceneRef.add(flame, ice);
        const body = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(SPOT_HALF, 1.2, SPOT_HALF)) });
        body.position.set(x, 1.2, z);
        body.collisionFilterGroup = 2;
        body.collisionFilterMask = 1 | 2 | 4 | 8;
        return { x, z, flame, ice, body, solid: false, flameS: 0, iceS: 0, delay: Math.random() * 0.12 };
    });
    return true;
}

function setSolid(spot, want, ctx) {
    if (want === spot.solid) return;
    if (want) {
        const p = ctx.playerPos, c = ctx.cartPos;
        if (p && Math.hypot(p.x - spot.x, p.z - spot.z) < PLAYER_CLEARANCE) return;
        if (c && Math.hypot(c.x - spot.x, c.z - spot.z) < CART_CLEARANCE) return;
        worldRef?.addBody(spot.body);
    } else {
        worldRef?.removeBody(spot.body);
    }
    spot.solid = want;
}

export function updateThermostat(delta, ctx) {
    if (!active) return;
    if (ctx.paused) {
        stopThermostatAudio();
        return;
    }
    const dt = Math.min(0.1, delta || 0);
    elapsed += dt;
    const p = elapsed / duration;
    if (p >= 1) { resetThermostat(); ctx.onEnd?.(); return; }
    temp = tempAt(p);

    const heat = clamp01(temp), cold = clamp01(-temp);
    updateThermostatAudio(heat, cold);
    if (overlay) {
        const heatStr = heat.toFixed(3), coldStr = cold.toFixed(3);
        if (overlay._heat !== heatStr) { overlay._heat = heatStr; overlay.style.setProperty('--heat', heatStr); }
        if (overlay._cold !== coldStr) { overlay._cold = coldStr; overlay.style.setProperty('--cold', coldStr); }
    }

    const t = performance.now() / 1000;
    const k = 1 - Math.exp(-dt * 4);  // smooth follow
    for (const s of spots) {
        // Flames lick up once it's hot; ice grows in as it freezes.
        const flameTarget = smooth((heat - 0.35 - s.delay) / 0.4);
        const iceTarget = smooth((cold - 0.35 - s.delay) / 0.4);
        s.flameS += (flameTarget - s.flameS) * k;
        s.iceS += (iceTarget - s.iceS) * k;

        s.flame.visible = s.flameS > 0.01;
        if (s.flame.visible) {
            s.flame.scale.set(s.flameS, s.flameS, s.flameS);
            for (const m of s.flame.userData.tongues) {
                const f = 0.8 + 0.25 * Math.sin(t * m.userData.speed + m.userData.phase) + 0.1 * Math.sin(t * 23 + m.userData.phase * 3);
                m.scale.set(1 + 0.1 * Math.sin(t * 9 + m.userData.phase), f, 1);
                m.rotation.y = t * 0.8 + m.userData.phase;
            }
            s.flame.userData.glow.material.opacity = 0.3 + 0.15 * Math.sin(t * 11 + s.x);
        }
        s.ice.visible = s.iceS > 0.01;
        if (s.ice.visible) {
            // Melting: squashes vertically first near the end.
            const melt = p > 0.9 ? s.iceS : 1;
            s.ice.scale.set(s.iceS, s.iceS * melt, s.iceS);
        }
        setSolid(s, s.flameS > 0.55 || s.iceS > 0.55, ctx);
    }
}

export function resetThermostat() {
    stopThermostatAudio();
    audioRef = null;
    for (const s of spots) {
        if (s.solid) worldRef?.removeBody(s.body);
        for (const g of [s.flame, s.ice]) {
            g.removeFromParent();
            g.traverse(o => {
                if (!o.isMesh) return;
                o.geometry?.dispose();
                if (o.material !== iceMat) o.material?.dispose();
            });
        }
    }
    spots = [];
    overlay?.remove();
    overlay = null;
    active = false;
    temp = 0;
    elapsed = 0;
}

export function clearThermostatStats() { occurred = false; }

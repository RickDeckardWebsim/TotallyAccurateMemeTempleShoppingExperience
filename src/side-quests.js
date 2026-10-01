// Side quests ("Other Tasks"): bathroom, returns, spare change, free sample, drive home.
// game.js owns the world; this module talks to it through the `api` object passed to initSideQuests.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { buildCarModel } from './car-skins.js';
import { equippedCarSkin } from './shop.js';
import { createSound } from './audio-engine.js';

const BATH = { x0: 30, doorZ: -27.9, zMin: -30, zMax: -21.5 };
const DESK = { x: -22, z: -24, topY: 1.2, hx: 1.82, hz: 0.92 };
const CHANGE_GOAL = 100; // cents

let api = null;
let S = null;
let hudEl = null;

const sounds = {};
function loadSound(name, src, loop = false) {
    sounds[name] = createSound(src, { loop });
}
loadSound('pee', 'sfx/pee_stream.wav', true);
loadSound('flush', 'sfx/toilet_flush.wav');
loadSound('pop', 'sfx/target_pop.wav');
loadSound('eat', 'sfx/eat_sample.wav');
loadSound('crank', 'sfx/car_crank.wav', true);
loadSound('start', 'sfx/car_start.wav');
loadSound('drive', 'sfx/car_drive.wav', true);
loadSound('thud', 'sfx/cart_drop.wav');
loadSound('coin', 'sfx/money_pickup.wav');

function play(name, vol = 1, clone = false) {
    const base = sounds[name];
    if (!base) return null;
    const a = clone ? base.cloneNode() : base;
    try {
        a.volume = Math.max(0, Math.min(1, (api?.sfxVolume ?? 0.7) * vol));
        if (!clone) a.currentTime = 0;
        a.play().catch(() => {});
    } catch (_) {}
    return a;
}
function stop(name) {
    const a = sounds[name];
    if (a) { try { a.pause(); a.currentTime = 0; } catch (_) {} }
}

export function initSideQuests(apiObject) {
    api = apiObject;
}

// ---------------------------------------------------------------- state

function freshState() {
    return {
        enabled: false,
        movementLocked: false,
        cinematic: false,
        lastWarnAt: 0,
        bathroom: { done: false, game: null },
        returns: { lastThrowAt: 0, names: [], done: 0, mode: false, held: null, charging: false, chargePhase: 0, charge: 0, flying: null, landed: [], nextAt: 0 },
        change: null, // { cents }
        sample: { done: false, eaten: 0, wantsMore: false, eating: null },
        car: { spot: null, group: null, body: null, marker: null, stage: null, t: 0, crankTime: 0, path: null, camFrom: null, loadingEl: null }
    };
}
S = freshState();

export function resetSideQuests() {
    if (S) {
        cleanupPee();
        cleanupReturnMeshes();
        S.car.loadingEl?.remove();
    }
    Object.keys(sounds).forEach(stop);
    S = freshState();
    hideHud();
}

export function setupSideQuestsRun({ enabled, carSpots }) {
    resetSideQuests();
    S.enabled = !!enabled;
    if (!S.enabled) return;

    // Returns: 1-3 items brought from home that are not on the grocery list.
    const listNames = new Set((api.shoppingList || []).map(i => i?.name));
    const pool = (api.items || []).filter(it => it && it.name && it.name !== 'Gum' && !listNames.has(it.name));
    const count = fixedOrRandom('RETURN_ITEM_COUNT', 1, 3);
    for (let i = 0; i < count && pool.length; i++) {
        S.returns.names.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].name);
    }
    if (!S.returns.names.length) S.returns.names.push('Receipt Box');

    // Spare change only shows up in 10% of runs.
    if (rollChance('SPARE_CHANGE_CHANCE', 10)) S.change = { cents: 0 };

    // No booth could be placed -> no sample task this run.
    if (!getBooth()) S.sample.done = true;

    buildPlayerCar(carSpots || []);
    api.refreshList();
}

export function sideQuestsEnabled() { return !!S?.enabled; }
export function getSideQuestStats() {
    if (!S?.enabled) return null;
    return {
        restroomDone: S.bathroom.done,
        returnsDone: S.returns.done,
        returnsTotal: S.returns.names.length,
        changeCents: S.change ? S.change.cents : null,
        sampleEaten: S.sample.eaten,
        sampleAvailable: !!getBooth(),
        droveHome: S.car.stage === 'done'
    };
}
export function isMovementLocked() { return !!(S?.movementLocked || S?.cinematic); }
export function isCinematic() { return !!S?.cinematic; }
export function capturesClick() {
    return !!(S?.enabled && (S.returns.mode || performance.now() - S.returns.lastThrowAt < 400));
}

function returnsComplete() { return S.returns.done >= S.returns.names.length; }
function changeComplete() { return !S.change || S.change.cents >= CHANGE_GOAL; }
function otherTasksDone() {
    return S.bathroom.done && returnsComplete() && changeComplete() && S.sample.done;
}

function remainingTaskNames() {
    const r = [];
    if (!api.purchaseComplete) r.push('pay for your groceries');
    if (!S.bathroom.done) r.push('use the restroom');
    if (!returnsComplete()) r.push('return items at the Information Desk');
    if (!changeComplete()) r.push('get spare change');
    if (!S.sample.done) r.push('get a free sample');
    return r;
}

// ---------------------------------------------------------------- list page

const money = c => `$${(c / 100).toFixed(2)}`;

export function renderOtherTasksHtml() {
    if (!S.enabled) return '';
    const row = (done, label, right = '', locked = false) => `
        <div class="list-item ${done ? 'collected' : ''} ${locked ? 'locked' : ''}">
            <span><span class="list-check">${done ? '✓' : locked ? '🔒' : ''}</span>${label}</span>
            <span>${right}</span>
        </div>`;
    const r = S.returns;
    let html = '<h3>📝 Other Tasks</h3>';
    html += row(S.bathroom.done, 'Use the restroom');
    html += row(returnsComplete(), `Return ${r.names.length === 1 ? r.names[0] : r.names.length + ' items'} at the Information Desk`, `(${r.done}/${r.names.length})`);
    if (S.change) html += row(changeComplete(), 'Ask for spare change', `(${money(Math.min(S.change.cents, CHANGE_GOAL))}/${money(CHANGE_GOAL)})`);
    html += row(S.sample.done, 'Get a free sample', !S.sample.done && S.sample.wantsMore ? 'another!' : '');
    const carReady = api.purchaseComplete && otherTasksDone();
    html += row(S.car.stage === 'done', 'Load groceries & leave in your car', '', !carReady);
    if (r.names.length > 1 && !returnsComplete()) {
        html += `<div class="list-note">${r.names.join(', ')}</div>`;
    }
    return html;
}

// ---------------------------------------------------------------- HUD

let hudHtml = '';
function showHud(title, frac = null, sub = '') {
    if (!hudEl) {
        hudEl = document.createElement('div');
        hudEl.id = 'sq-hud';
        document.getElementById('game-container')?.appendChild(hudEl);
    }
    const html = `<div class="sq-title">${title}</div>` +
        (frac !== null ? `<div class="sq-bar"><div style="width:${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%"></div></div>` : '') +
        (sub ? `<div class="sq-sub">${sub}</div>` : '');
    // Called every frame by minigames: only touch the DOM when the content changes.
    if (html !== hudHtml) { hudEl.innerHTML = html; hudHtml = html; }
    hudEl.classList.add('visible');
}
function hideHud() { hudEl?.classList.remove('visible'); }

function warn(msg, ms = 2400) {
    const now = performance.now();
    if (now - S.lastWarnAt < 2600) return;
    S.lastWarnAt = now;
    api.displayMessage(msg, ms);
}

// ---------------------------------------------------------------- helpers

function flatDist(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }
function rollChance(key, fallback) {
    return Math.random() * 100 < Math.max(0, Math.min(100, Number(api.config?.[key] ?? fallback)));
}
function fixedOrRandom(key, min, max) {
    const fixed = api.config?.[key];
    return fixed == null ? min + Math.floor(Math.random() * (max - min + 1))
        : Math.max(min, Math.min(max, Math.round(Number(fixed) || min)));
}
function getBooth() { return api.sampleBooths?.[0] || null; }
function lookDir() {
    const d = new THREE.Vector3();
    api.camera.getWorldDirection(d);
    return d;
}

function nearToilet() {
    const t = api.toilet, p = api.playerBody?.position;
    if (!t || !p) return false;
    return flatDist(p.x, p.z, t.position.x, t.position.z - 0.5) < 1.55 && p.x > 32.3;
}
function nearDesk(range = 2.2) {
    const p = api.playerBody?.position;
    if (!p) return false;
    const dx = Math.max(0, Math.abs(p.x - DESK.x) - DESK.hx);
    const dz = Math.max(0, Math.abs(p.z - DESK.z) - DESK.hz);
    return Math.hypot(dx, dz) < range;
}
function nearBooth() {
    const b = getBooth(), p = api.playerBody?.position;
    return !!(b && p && flatDist(p.x, p.z, b.position.x, b.position.z) < 3.0);
}
function nearCar() {
    const c = S.car, p = api.playerBody?.position;
    return !!(c.group && p && !c.stage && flatDist(p.x, p.z, c.group.position.x, c.group.position.z) < 3.6);
}
function customerForChange() {
    if (!S.change || changeComplete()) return null;
    const hit = api.findCustomerUnderCrosshair?.();
    if (!hit?.customer || hit.customer.isTweaker) return null;
    return hit.customer;
}

// Build a throwable/display mesh for a store item template.
function buildItemMesh(name, maxDim = 0.42) {
    const tpl = (api.items || []).find(it => it?.name === name);
    let raw = null;
    try { if (tpl && typeof tpl.model === 'function') raw = tpl.model(); } catch (_) { raw = null; }
    if (!raw) {
        raw = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.28, 0.25),
            new THREE.MeshStandardMaterial({ color: tpl?.color || 0xc08a4f, roughness: 0.7 }));
    }
    const wrap = new THREE.Group();
    wrap.add(raw);
    const box = new THREE.Box3().setFromObject(raw);
    const size = new THREE.Vector3(), center = new THREE.Vector3();
    box.getSize(size); box.getCenter(center);
    raw.position.sub(center);
    const s = maxDim / Math.max(size.x, size.y, size.z, 0.01);
    wrap.scale.setScalar(s);
    size.multiplyScalar(s);
    wrap.traverse(o => { if (o.isMesh) o.castShadow = true; });
    return { mesh: wrap, half: new CANNON.Vec3(Math.max(0.05, size.x / 2), Math.max(0.05, size.y / 2), Math.max(0.05, size.z / 2)) };
}

// ---------------------------------------------------------------- hover + interact

export function getHoverText() {
    if (!S?.enabled || S.cinematic || S.bathroom.game || api.heldItem) return null;
    if (S.returns.mode && S.returns.held) return null;
    const key = api.keyName('interact');
    if (!S.bathroom.done && nearToilet()) return `🚽 Toilet [${key} to pee]`;
    if (!returnsComplete() && nearDesk()) return `📦 Information Desk — Return items [${key}]`;
    if (!S.sample.done && !S.sample.eating && nearBooth()) return `🧀 Free Samples [${key} to eat]`;
    if (nearCar()) return `🚗 Your Car [${key} to drive home]`;
    if (customerForChange()) return `🪙 Ask for spare change [${key}]`;
    return null;
}

// Called on interact keydown. Returns true if the side-quest system used the press.
export function onInteractDown(event) {
    if (!S?.enabled || !api.gameStarted || api.isCheckout || api.gameOver) return false;
    if (S.cinematic || S.bathroom.game) return true;
    if (S.returns.mode && S.returns.held) {
        if (!event?.repeat) beginCharge();
        return true;
    }
    if (api.heldItem) return false;
    if (!S.bathroom.done && nearToilet()) { startPee(); return true; }
    if (!returnsComplete() && nearDesk()) { startReturnMode(); return true; }
    if (!S.sample.done && nearBooth()) {
        if (!S.sample.eating) startEating();
        return true;
    }
    if (nearCar()) { tryEnterCar(); return true; }
    const cust = customerForChange();
    if (cust) { askForChange(cust); return true; }
    return false;
}
export function onInteractUp() {
    if (S?.returns.charging) releaseThrow();
}
function onMouseDown(e) {
    if (e.button !== 0 || !api?.controls?.isLocked || api.gamePaused) return;
    if (capturesClick()) beginCharge();
}
function onMouseUp(e) {
    if (e.button === 0 && S?.returns.charging) releaseThrow();
}
document.addEventListener('mousedown', onMouseDown);
document.addEventListener('mouseup', onMouseUp);

// ---------------------------------------------------------------- bathroom

function startPee() {
    const toilet = api.toilet;
    if (!toilet) return;
    const n = fixedOrRandom('RESTROOM_TARGETS', 3, 6);
    const chosenDuration = api.config?.RESTROOM_DURATION == null
        ? 4 + Math.random() * 7 : fixedOrRandom('RESTROOM_DURATION', 4, 14);
    // Allow enough time for all targets to appear, while keeping the round brisk.
    const duration = Math.max(chosenDuration, 1.5 + n * 1.4);
    const times = [0.4];
    for (let i = 1; i < n; i++) times.push(0.8 + Math.random() * Math.max(0.5, duration * 0.6 - 0.8));
    times.sort((a, b) => a - b);

    const meshes = [];
    toilet.traverse(o => { if (o.isMesh) meshes.push(o); });
    const stream = new THREE.Mesh(new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({ color: 0xf2dc4a, transparent: true, opacity: 0.85 }));
    stream.frustumCulled = false;
    api.scene.add(stream);

    S.bathroom.game = {
        t: 0, duration, n, times, spawned: 0, hits: 0, markers: [], meshes, stream, drops: [],
        dropGeo: new THREE.SphereGeometry(0.012, 5, 4),
        dropMat: new THREE.MeshBasicMaterial({ color: 0xf6e67a, transparent: true, opacity: 0.9 }),
        aim: new THREE.Vector3()
    };
    S.movementLocked = true;
    play('pee', 0.55);
    api.displayMessage('💦 Hit every target on the toilet to finish!', 2600);
}

let targetTexture = null;
function getTargetTexture() {
    if (targetTexture) return targetTexture;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const rings = ['#ef4444', '#ffffff', '#ef4444', '#ffffff', '#ef4444'];
    rings.forEach((col, i) => {
        ctx.beginPath();
        ctx.arc(64, 64, 60 - i * 12, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
    });
    ctx.lineWidth = 4; ctx.strokeStyle = '#111827';
    ctx.beginPath(); ctx.arc(64, 64, 60, 0, Math.PI * 2); ctx.stroke();
    targetTexture = new THREE.CanvasTexture(c);
    targetTexture.colorSpace = THREE.SRGBColorSpace;
    return targetTexture;
}

function spawnPeeMarker(g) {
    const ray = new THREE.Raycaster();
    const eye = api.camera.position.clone();
    const box = new THREE.Box3().setFromObject(api.toilet);
    let point = null;
    for (let attempt = 0; attempt < 80 && !point; attempt++) {
        const target = new THREE.Vector3(
            THREE.MathUtils.lerp(box.min.x, box.max.x, Math.random()),
            THREE.MathUtils.lerp(box.min.y, box.max.y, Math.random()),
            THREE.MathUtils.lerp(box.min.z, box.max.z, Math.random()));
        ray.set(eye, target.sub(eye).normalize());
        const hit = ray.intersectObjects(g.meshes, false)[0];
        if (!hit) continue;
        const spaced = g.markers.every(m => m.pos.distanceTo(hit.point) > 0.16);
        if (spaced || attempt > 60) point = hit.point.clone();
    }
    if (!point) point = api.toilet.localToWorld(new THREE.Vector3(0, 0.74, -0.54));
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: getTargetTexture(), depthTest: false, transparent: true }));
    sprite.renderOrder = 999;
    sprite.position.copy(point);
    sprite.scale.setScalar(0.001);
    api.scene.add(sprite);
    g.markers.push({ pos: point, sprite, hit: false, age: 0, popT: 0 });
}

// Scratch objects for the per-frame pee stream.
const _UP = new THREE.Vector3(0, 1, 0);
const _PEE_HIP_OFFSET = new THREE.Vector3(0, -1.05, 0);
const _PEE_ARC_OFFSET = new THREE.Vector3(0, 0.22, 0);
const _peeDir = new THREE.Vector3();
const _peeRight = new THREE.Vector3();
const _peeUp = new THREE.Vector3();
const _peeFlat = new THREE.Vector3();
const _peeRay = new THREE.Raycaster(undefined, undefined, 0, 4);

function updatePee(dt, now) {
    const g = S.bathroom.game;
    if (!g) return;
    g.t += dt;
    if (g.t >= g.duration) {
        cleanupPee();
        stop('pee');
        S.movementLocked = false;
        hideHud();
        api.displayMessage('💦 Time ran out! Use the toilet to try again.', 2400);
        return;
    }
    while (g.spawned < g.n && g.t >= g.times[g.spawned]) {
        spawnPeeMarker(g);
        g.spawned++;
    }

    // Stream: from the hips to wherever the (slightly wobbly) crosshair lands.
    const cam = api.camera;
    const dir = cam.getWorldDirection(_peeDir);
    const right = _peeRight.crossVectors(dir, _UP).normalize();
    const up = _peeUp.crossVectors(right, dir).normalize();
    const wob = now * 0.001;
    dir.addScaledVector(right, Math.sin(wob * 2.3) * 0.018 + Math.sin(wob * 5.7) * 0.008)
       .addScaledVector(up, Math.cos(wob * 3.1) * 0.014).normalize();
    const flat = _peeFlat.set(dir.x, 0, dir.z).normalize();
    const origin = cam.position.clone().add(_PEE_HIP_OFFSET).addScaledVector(flat, 0.3);
    _peeRay.set(cam.position, dir);
    const hit = _peeRay.intersectObjects(g.meshes, false)[0];
    let end;
    if (hit) end = hit.point;
    else if (dir.y < -0.05) end = cam.position.clone().addScaledVector(dir, (cam.position.y - 0.01) / -dir.y);
    else end = cam.position.clone().addScaledVector(dir, 2.5);
    g.aim.copy(end);

    const ctrl = origin.clone().lerp(end, 0.35).add(_PEE_ARC_OFFSET);
    const curve = new THREE.QuadraticBezierCurve3(origin, ctrl, end);
    g.stream.geometry.dispose();
    g.stream.geometry = new THREE.TubeGeometry(curve, 18, 0.011, 5, false);

    // Splash droplets
    for (let i = 0; i < 2; i++) {
        const d = new THREE.Mesh(g.dropGeo, g.dropMat);
        d.position.copy(end);
        d.userData.v = new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.6 + Math.random() * 0.9, (Math.random() - 0.5) * 1.2);
        d.userData.life = 0.3 + Math.random() * 0.15;
        api.scene.add(d);
        g.drops.push(d);
    }
    for (let i = g.drops.length - 1; i >= 0; i--) {
        const d = g.drops[i];
        d.userData.life -= dt;
        d.userData.v.y -= 9 * dt;
        d.position.addScaledVector(d.userData.v, dt);
        if (d.userData.life <= 0) { api.scene.remove(d); g.drops.splice(i, 1); }
    }

    // Targets
    for (const m of g.markers) {
        m.age += dt;
        if (!m.hit) {
            const s = Math.min(1, m.age * 5) * (0.12 + Math.sin(m.age * 7) * 0.012);
            m.sprite.scale.setScalar(s);
            if (end.distanceTo(m.pos) < 0.09) {
                m.hit = true;
                g.hits++;
                play('pop', 0.6, true);
            }
        } else if (m.sprite.parent) {
            m.popT += dt;
            m.sprite.scale.setScalar(0.12 + m.popT * 0.8);
            m.sprite.material.opacity = Math.max(0, 1 - m.popT * 4);
            if (m.popT > 0.25) api.scene.remove(m.sprite);
        }
    }

    const left = Math.max(0, 1 - g.t / g.duration);
    showHud(`💦 Targets ${g.hits}/${g.n}`, left);

    if (g.hits >= g.n) finishPee();
}

function cleanupPee() {
    const g = S?.bathroom.game;
    if (!g) return;
    g.markers.forEach(m => m.sprite.parent?.remove(m.sprite));
    g.drops.forEach(d => d.parent?.remove(d));
    g.stream.parent?.remove(g.stream);
    g.stream.geometry.dispose();
    S.bathroom.game = null;
}

function finishPee() {
    cleanupPee();
    stop('pee');
    play('flush', 0.6);
    S.bathroom.done = true;
    S.movementLocked = false;
    hideHud();
    api.displayMessage('🚽 Restroom break done!', 2200);
    api.refreshList();
}

// ---------------------------------------------------------------- returns (info desk)

// Where the player stands to toss returns: a random distance back from the
// customer side of the counter (re-rolled for every item), so each toss needs
// a different amount of power.
const THROW_BACK_MIN = 1.4;
const THROW_BACK_MAX = 2.8;
function rollThrowDistance() {
    const fixed = api.config?.RETURN_THROW_DISTANCE;
    if (fixed != null && Number.isFinite(Number(fixed))) {
        return Math.max(THROW_BACK_MIN, Math.min(THROW_BACK_MAX, Number(fixed)));
    }
    return THROW_BACK_MIN + Math.random() * (THROW_BACK_MAX - THROW_BACK_MIN);
}
function throwSpot(back) {
    const p = api.playerBody.position;
    const x = Math.max(DESK.x - DESK.hx + 0.5, Math.min(DESK.x + DESK.hx - 0.5, p.x));
    return { x, z: DESK.z + DESK.hz + back };
}

// Glide to a freshly rolled throw spot and turn to face the desk.
function stepToThrowSpot() {
    const r = S.returns;
    const from = api.playerBody.position;
    const to = throwSpot(rollThrowDistance());
    const look = api.getLook ? api.getLook() : { yaw: 0, pitch: 0 };
    const toYaw = Math.atan2(-(DESK.x - to.x), -(DESK.z - to.z));
    let dYaw = toYaw - look.yaw;
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw)); // shortest turn
    r.stepBack = { t: 0, fx: from.x, fz: from.z, tx: to.x, tz: to.z, y0: look.yaw, dy: dYaw, p0: look.pitch, p1: -0.12 };
}

function startReturnMode() {
    const r = S.returns;
    if (r.mode) return;
    r.mode = true;
    S.movementLocked = true;
    if (!r.flying) giveNextReturnItem();
    api.displayMessage(`📦 Hold ${api.keyName('interact')} to charge, release to toss it onto the desk. ${api.keyName('jump')} to step away.`, 3600);
}

function exitReturnMode(msg) {
    const r = S.returns;
    if (r.held) { api.scene.remove(r.held.mesh); r.held = null; }
    r.charging = false;
    r.mode = false;
    r.stepBack = null;
    S.movementLocked = false;
    hideHud();
    if (msg) warn(msg);
}

// Jump while tossing returns = step away from the desk.
export function onJump() {
    if (!S?.enabled || !S.returns.mode) return false;
    exitReturnMode('📦 Come back to the Information Desk to finish your returns.');
    return true;
}

function giveNextReturnItem() {
    const r = S.returns;
    if (returnsComplete() || r.held) return;
    const name = r.names[r.done];
    const built = buildItemMesh(name);
    built.name = name;
    r.held = built;
    // New item, new distance.
    if (r.mode) stepToThrowSpot();
    api.scene.add(built.mesh);
}

function beginCharge() {
    const r = S.returns;
    if (!r.held || r.charging) return;
    r.charging = true;
    r.chargePhase = 0;
    r.charge = 0;
}

function releaseThrow() {
    const r = S.returns;
    if (!r.charging || !r.held) { r.charging = false; return; }
    r.charging = false;
    r.lastThrowAt = performance.now();
    const held = r.held;
    r.held = null;
    // Light underhand lob: aim left/right with the view, distance comes from
    // the power bar. ~50-95% power lands on the counter from the throw spot;
    // too little falls short, full power sails past it.
    const look = lookDir();
    const flat = new THREE.Vector3(look.x, 0, look.z);
    if (flat.lengthSq() < 1e-4) flat.set(0, 0, -1);
    flat.normalize();
    const c = r.charge;
    const horiz = 0.4 + c * 5.0;
    const up = 1.6 + c * 1.4;
    const body = new CANNON.Body({ mass: 1, shape: new CANNON.Box(held.half), linearDamping: 0.12, angularDamping: 0.4 });
    body.position.set(held.mesh.position.x, held.mesh.position.y, held.mesh.position.z);
    body.quaternion.set(held.mesh.quaternion.x, held.mesh.quaternion.y, held.mesh.quaternion.z, held.mesh.quaternion.w);
    body.velocity.set(flat.x * horiz, up, flat.z * horiz);
    body.angularVelocity.set((Math.random() - 0.5) * 2.5, (Math.random() - 0.5) * 2.5, (Math.random() - 0.5) * 2.5);
    api.world.addBody(body);
    let bumped = false;
    body.addEventListener('collide', () => { if (!bumped) { bumped = true; play('thud', 0.5, true); } });
    r.flying = {
        ...held, body, t: 0, still: 0, failT: 0,
        previousPosition: new CANNON.Vec3(body.position.x, body.position.y, body.position.z)
    };
    hideHud();
}

const _heldDir = new THREE.Vector3();
const _heldRight = new THREE.Vector3();
const _HELD_DROP = new THREE.Vector3(0, -0.28, 0);
function updateReturns(dt) {
    const r = S.returns;
    const cam = api.camera;
    // Glide back to the throw spot and turn toward the desk.
    const sb = r.stepBack;
    if (r.mode && sb && api.playerBody) {
        sb.t = Math.min(1, sb.t + dt / 0.45);
        const e = 1 - Math.pow(1 - sb.t, 3);
        const pb = api.playerBody;
        pb.position.x = sb.fx + (sb.tx - sb.fx) * e;
        pb.position.z = sb.fz + (sb.tz - sb.fz) * e;
        pb.velocity.x = 0; pb.velocity.z = 0;
        api.setLook?.(sb.y0 + sb.dy * e, sb.p0 + (sb.p1 - sb.p0) * e);
        if (sb.t >= 1) r.stepBack = null;
    }
    if (r.mode && api.playerBody) { api.playerBody.velocity.x = 0; api.playerBody.velocity.z = 0; }

    if (r.mode && r.held) {
        if (!nearDesk(5)) {
            exitReturnMode('📦 Come back to the Information Desk to finish your returns.');
        } else {
            const dir = cam.getWorldDirection(_heldDir);
            const right = _heldRight.crossVectors(dir, _UP).normalize();
            const pull = r.charging ? r.charge * 0.18 : 0;
            r.held.mesh.position.copy(cam.position).addScaledVector(dir, 0.75 - pull).addScaledVector(right, 0.22).add(_HELD_DROP);
            r.held.mesh.quaternion.copy(cam.quaternion);
            if (r.charging) {
                r.chargePhase += dt * 0.9;
                const ph = r.chargePhase % 2;
                r.charge = ph < 1 ? ph : 2 - ph;
                showHud(`📦 Power`, r.charge, `Returning ${r.held.name} (${r.done + 1}/${r.names.length})`);
            } else {
                showHud(`📦 Return ${r.held.name}`, null, `Hold ${api.keyName('interact')} to charge, release to toss • ${api.keyName('jump')} to step away`);
            }
        }
    }

    const f = r.flying;
    if (f) {
        f.t += dt;
        const p = f.body.position;
        // Fast throws can cross the countertop between physics steps. Check the
        // full path since the previous frame so an item cannot tunnel through it.
        const previous = f.previousPosition;
        const landingY = DESK.topY + f.half.y;
        if (previous && previous.y >= landingY && p.y < landingY) {
            const fraction = (previous.y - landingY) / (previous.y - p.y);
            const hitX = previous.x + (p.x - previous.x) * fraction;
            const hitZ = previous.z + (p.z - previous.z) * fraction;
            if (Math.abs(hitX - DESK.x) <= DESK.hx - f.half.x &&
                Math.abs(hitZ - DESK.z) <= DESK.hz - f.half.z) {
                p.set(hitX, landingY + 0.005, hitZ);
                f.body.velocity.set(0, 0, 0);
                f.body.angularVelocity.set(0, 0, 0);
                f.body.aabbNeedsUpdate = true;
            }
        }
        if (f.previousPosition) f.previousPosition.set(p.x, p.y, p.z);
        else f.previousPosition = new CANNON.Vec3(p.x, p.y, p.z);
        f.mesh.position.copy(p);
        f.mesh.quaternion.copy(f.body.quaternion);
        const onDesk = Math.abs(p.x - DESK.x) < DESK.hx && Math.abs(p.z - DESK.z) < DESK.hz && p.y > DESK.topY && p.y < DESK.topY + 0.9;
        const speed = f.body.velocity.length();
        if (onDesk && speed < 0.35) {
            // Keep returned items from slowly sliding off the counter after landing.
            f.body.velocity.x *= 0.7;
            f.body.velocity.z *= 0.7;
            f.still += dt;
        } else f.still = 0;
        const fell = p.y < DESK.topY - 0.15 || f.t > 7;
        if (fell) f.failT += dt;
        if (f.still > 0.9) {
            f.body.type = CANNON.Body.STATIC;
            f.body.mass = 0;
            f.body.updateMassProperties();
            f.body.velocity.set(0, 0, 0);
            f.body.angularVelocity.set(0, 0, 0);
            r.landed.push(f);
            r.flying = null;
            r.done++;
            play('coin', 0.5, true);
            if (returnsComplete()) {
                r.mode = false;
                S.movementLocked = false;
                hideHud();
                api.displayMessage('📦 "All returned, thanks!" — Returns complete!', 2600);
            } else {
                api.displayMessage(`📦 "Got it!" (${r.done}/${r.names.length})`, 1600);
                if (r.mode) setTimeout(() => { if (S.returns === r && r.mode) giveNextReturnItem(); }, 450);
            }
            api.refreshList();
        } else if (f.failT > 0.7) {
            api.world.removeBody(f.body);
            api.scene.remove(f.mesh);
            r.flying = null;
            if (r.mode) {
                api.displayMessage("😬 It didn't stay on the desk — try again!", 1800);
                giveNextReturnItem();
            }
        }
    }
}

function cleanupReturnMeshes() {
    const r = S?.returns;
    if (!r) return;
    if (r.held) api?.scene?.remove(r.held.mesh);
    if (r.flying) { api?.scene?.remove(r.flying.mesh); try { api.world.removeBody(r.flying.body); } catch (_) {} }
}

// ---------------------------------------------------------------- spare change

const DENIALS = ['"Sorry, no change."', '"Not today, pal."', '"Get a job!"', '"I only have cards."', '*pretends not to hear you*', '"Ask someone else."'];
function askForChange(cust) {
    // A customer interaction must never award money outside the active task.
    if (!S.change || changeComplete()) return;
    const now = performance.now();
    if (now < (cust._changeAskedUntil || 0)) {
        warn('🙄 They just told you. Try someone else!');
        return;
    }
    cust._changeAskedUntil = now + 4000;
    if (!rollChance('CHANGE_GIVEN_CHANCE', 50)) {
        api.displayMessage(`🙅 ${DENIALS[Math.floor(Math.random() * DENIALS.length)]}`, 2000);
        return;
    }
    const cents = [25, 25, 50, 50, 100][Math.floor(Math.random() * 5)];
    S.change.cents += cents;
    api.addSavings(cents);
    play('coin', 0.7, true);
    api.displayMessage(changeComplete()
        ? `🪙 Got ${money(cents)}! Spare change task complete!`
        : `🪙 A customer gave you ${money(cents)}! (${money(S.change.cents)}/${money(CHANGE_GOAL)})`, 2400);
    api.refreshList();
}

// ---------------------------------------------------------------- free sample

function startEating() {
    if (S.sample.done || S.sample.eaten >= 2) return;
    const booth = getBooth();
    const pieces = (booth?.userData.samplePieces || []).filter(p => p.visible);
    if (!pieces.length) { finishSampleTask('🧀 The tray is empty — you ate them all!'); return; }
    const piece = pieces[Math.floor(Math.random() * pieces.length)];
    piece.visible = false;
    S.sample.eating = { t: 0, dur: 2 + Math.random() };
    play('eat', 0.8);
}

function updateEating(dt) {
    const e = S.sample.eating;
    if (!e) return;
    e.t += dt;
    showHud('😋 Eating sample…', e.t / e.dur);
    if (e.t < e.dur) return;
    S.sample.eating = null;
    S.sample.eaten++;
    hideHud();
    const left = (getBooth()?.userData.samplePieces || []).filter(p => p.visible).length;
    if (S.sample.eaten >= 2) {
        finishSampleTask('🧀 Delicious. Free sample done!');
    } else if (left === 0) {
        finishSampleTask('🧀 You cleaned out the whole tray!');
    } else if (rollChance('MORE_SAMPLES_CHANCE', 50)) {
        S.sample.wantsMore = true;
        api.displayMessage('🤤 So good… you NEED another one!', 2400);
        api.refreshList();
    } else {
        finishSampleTask('🧀 Delicious. Free sample done!');
    }
}

function finishSampleTask(msg) {
    S.sample.done = true;
    S.sample.wantsMore = false;
    api.displayMessage(msg, 2400);
    api.refreshList();
}

// ---------------------------------------------------------------- car

function buildPlayerCar(spots) {
    if (!spots.length) spots = [{ x: 7.8, z: -52.2, heading: Math.PI }];
    const spot = spots[Math.floor(Math.random() * spots.length)];
    const { group: g, half } = buildCarModel(equippedCarSkin());
    g.position.set(spot.x, 0, spot.z);
    g.rotation.y = spot.heading;
    api.scene.add(g);

    // Floating marker so the car is easy to find from the entrance.
    const marker = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.7, 16), new THREE.MeshBasicMaterial({ color: 0x22c55e }));
    cone.rotation.x = Math.PI;
    marker.add(cone);
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#14532d'; ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 36px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('YOUR CAR', 128, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
    label.scale.set(2.2, 0.55, 1);
    label.position.y = 0.85;
    marker.add(label);
    marker.position.set(spot.x, 3.2, spot.z);
    api.scene.add(marker);

    const body = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(...half)) });
    body.position.set(spot.x, half[1], spot.z);
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), spot.heading);
    api.world.addBody(body);

    Object.assign(S.car, { spot, group: g, body, marker });
}

function tryEnterCar() {
    const left = remainingTaskNames();
    if (left.length) {
        api.displayMessage(`🚗 Not yet! You still need to ${left.join(', ')}.`, 3200);
        return;
    }
    const car = S.car;
    api.detachCart();
    S.cinematic = true;
    S.movementLocked = true;
    if (api.arm) api.arm.visible = false;
    car.camFrom = api.camera.position.clone();
    car.camQuat = api.camera.quaternion.clone();
    car.marker.visible = false;
    car.stage = 'loading';
    api.controls?.unlock();
    startTrunkLoading();
}

function startTrunkLoading() {
    const car = S.car;
    const names = (api.shoppingList || []).flatMap(item =>
        Array(Math.min(item.quantity || 1, 2)).fill(item.name));
    const groceries = names.slice(0, 6);
    if (!groceries.length) groceries.push('Groceries');
    const overlay = document.createElement('div');
    overlay.id = 'trunk-loading';
    overlay.innerHTML = `<div class="trunk-scene">
        <div class="trunk-heading">Load the trunk <span class="trunk-count">0/${groceries.length}</span></div>
        <div class="trunk-lid">TRUNK</div>
        <div class="trunk-dropzone"><span>SWIPE GROCERIES HERE ↑</span><div class="trunk-loaded"></div></div>
        <div class="trunk-bumper"></div>
        <div class="trunk-groceries"></div>
        <div class="trunk-hint">Swipe each bag into the trunk</div>
    </div>`;
    document.getElementById('game-container').appendChild(overlay);
    car.loadingEl = overlay;
    const tray = overlay.querySelector('.trunk-groceries');
    const trunk = overlay.querySelector('.trunk-dropzone');
    let loaded = 0;
    groceries.forEach(name => {
        const bag = document.createElement('div');
        bag.className = 'trunk-bag';
        bag.innerHTML = `<span class="trunk-bag-icon">🛍️</span><span class="trunk-bag-name"></span>`;
        bag.querySelector('.trunk-bag-name').textContent = name;
        bag.setAttribute('aria-label', `Swipe ${name} into trunk`);
        tray.appendChild(bag);
        let startX, startY;
        bag.addEventListener('pointerdown', event => {
            if (api.gamePaused) return;
            event.preventDefault();
            startX = event.clientX;
            startY = event.clientY;
            bag.setPointerCapture(event.pointerId);
            bag.classList.add('dragging');
        });
        bag.addEventListener('pointermove', event => {
            if (!bag.hasPointerCapture(event.pointerId)) return;
            bag.style.transform = `translate(${event.clientX - startX}px, ${event.clientY - startY}px)`;
        });
        bag.addEventListener('pointerup', event => {
            if (!bag.hasPointerCapture(event.pointerId)) return;
            bag.releasePointerCapture(event.pointerId);
            bag.classList.remove('dragging');
            const rect = trunk.getBoundingClientRect();
            const inside = event.clientX >= rect.left - 35 && event.clientX <= rect.right + 35 &&
                event.clientY >= rect.top - 35 && event.clientY <= rect.bottom + 35;
            if (!inside) {
                bag.style.transform = '';
                return;
            }
            loaded++;
            bag.remove();
            const stowed = document.createElement('span');
            stowed.textContent = '🛍️';
            trunk.querySelector('.trunk-loaded').appendChild(stowed);
            overlay.querySelector('.trunk-count').textContent = `${loaded}/${groceries.length}`;
            play('thud', 0.35, true);
            if (loaded === groceries.length) {
                overlay.remove();
                car.loadingEl = null;
                startCarEngine();
            }
        });
        bag.addEventListener('pointercancel', () => {
            bag.classList.remove('dragging');
            bag.style.transform = '';
        });
    });
}

function startCarEngine() {
    const car = S.car;
    car.stage = 'crank';
    car.t = 0;
    car.crankTime = rollChance('CAR_TROUBLE_CHANCE', 50) ? 1.5 + Math.random() * 3.5 : 0;
    try { api.world.removeBody(car.body); } catch (_) {}
    if (car.crankTime > 0) {
        play('crank', 0.8);
        api.displayMessage('🔑 Come on… start!', 2000);
    }
    showHud('🔑 Starting car…');
}

function carForward(h) { return new THREE.Vector3(Math.sin(h), 0, Math.cos(h)); }

function updateCar(dt, now) {
    const car = S.car;
    if (car.marker && car.marker.visible) {
        car.marker.position.y = 3.2 + Math.sin(now * 0.004) * 0.25;
        car.marker.rotation.y += dt * 1.5;
        car.marker.children[0].material.color.setHex(api.purchaseComplete && otherTasksDone() ? 0x22c55e : 0x9ca3af);
    }
    if (!car.stage) return;
    if (car.stage === 'loading') return;
    car.t += dt;
    const g = car.group;
    const fwd0 = carForward(car.spot.heading);

    if (car.stage === 'crank') {
        g.position.x = car.spot.x + (car.crankTime ? (Math.random() - 0.5) * 0.03 : 0);
        if (car.t >= car.crankTime) {
            stop('crank');
            play('start', 0.8);
            api.stopRunTimer();
            car.stage = 'idle';
            car.t = 0;
            hideHud();
            api.displayMessage('🚗 Vroom! Heading home…', 2200);
        }
    } else if (car.stage === 'idle') {
        g.position.x = car.spot.x + (Math.random() - 0.5) * 0.012;
        if (car.t > 0.9) {
            const side = new THREE.Vector3(fwd0.z, 0, -fwd0.x);
            if (Math.random() < 0.5) side.negate();
            const p0 = new THREE.Vector3(car.spot.x, 0, car.spot.z);
            const p1 = p0.clone().addScaledVector(fwd0, 7);
            const p2 = p1.clone().addScaledVector(side, 40);
            car.path = new THREE.QuadraticBezierCurve3(p0, p1, p2);
            car.stage = 'drive';
            car.t = 0;
            play('drive', 0.8);
        }
    } else if (car.stage === 'drive') {
        const dur = 4.2;
        const u = Math.min(1, car.t / dur);
        const e = u * u * (1.6 - 0.6 * u); // gentle acceleration
        const pos = car.path.getPoint(Math.min(1, e));
        const tan = car.path.getTangent(Math.min(0.999, e));
        g.position.set(pos.x, 0, pos.z);
        g.rotation.y = Math.atan2(tan.x, tan.z);
        if (u >= 1) {
            car.stage = 'done';
            S.cinematic = false;
            api.finishRun();
            return;
        }
    }

    // Chase camera behind the car
    const f = carForward(g.rotation.y);
    const want = g.position.clone().addScaledVector(f, -7.5).add(new THREE.Vector3(0, 3.4, 0));
    const look = g.position.clone().add(new THREE.Vector3(0, 0.9, 0));
    const blend = Math.min(1, (car.stage === 'crank' ? car.t : 1) / 0.8);
    const cam = api.camera;
    if (car.stage === 'crank' && blend < 1) {
        cam.position.lerpVectors(car.camFrom, want, blend * blend * (3 - 2 * blend));
    } else {
        cam.position.lerp(want, Math.min(1, dt * 5));
    }
    cam.lookAt(look);
}

// ---------------------------------------------------------------- per-frame

export function updateSideQuests(dt, now) {
    if (!S?.enabled || !api.playerBody) return;
    dt = Math.min(dt || 0.016, 0.05);
    if (api.gamePaused || api.isCheckout) return;

    // Carts aren't allowed in the restroom.
    const p = api.playerBody.position;
    const cart = api.cartObject;
    if (api.cartAttached && cart && !S.cinematic) {
        const c = cart.position;
        const inBathZ = z => z > BATH.zMin && z < BATH.zMax;
        if (c.x > BATH.x0 - 0.9 && inBathZ(c.z) && Math.abs(c.z - BATH.doorZ) < 1.8) {
            p.x -= c.x - (BATH.x0 - 0.9);
            if (api.playerBody.velocity.x > 0) api.playerBody.velocity.x = 0;
            warn(`🚫 No carts in the restroom! Detach it first [${api.keyName('cart')}].`);
        }
        if (p.x > BATH.x0 + 0.2 && inBathZ(p.z)) {
            api.detachCart();
            warn('🚫 No carts in the restroom!');
        }
    }

    if (S.bathroom.game) {
        api.playerBody.velocity.x = 0;
        api.playerBody.velocity.z = 0;
        updatePee(dt, now);
    }
    updateReturns(dt);
    updateEating(dt);
    updateCar(dt, now);
}

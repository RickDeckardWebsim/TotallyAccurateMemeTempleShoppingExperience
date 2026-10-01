// The wasteland left behind after the Nuclear Fallout event.
// Everything except the restroom annex and the mountain is replaced with
// charred rubble, twisted steel, burnt planks, smoldering fires and ash.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { buildRelics, inRelicZone } from './nuke-relics.js';

const BATH = { x0: 30, x1: 36.5, z0: -30.5, z1: -21 };
// Keep the restroom and the path out of its door clear of solid debris
const CLEAR = { x0: 23.5, x1: 37.5, z0: -32.5, z1: -20 };
const MOUNTAIN = { x: 35, z: -270, r: 205 };

let root = null;
let fires = [];        // { sprites:[], light, x, z, base }
let smoke = [];        // { sprite, x, z, age, life, speed, drift, size }
let ash = null;
let bathLight = null;
let bodies = [];
let worldRef = null;
let nearFires = [];

let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const range = (a, b) => a + (b - a) * rnd();
const pick = arr => arr[Math.floor(rnd() * arr.length)];

const inClearBox = (x, z, pad = 0) => x > CLEAR.x0 - pad && x < CLEAR.x1 + pad && z > CLEAR.z0 - pad && z < CLEAR.z1 + pad;
// Rubble also stays off the relics (sign, shelf) so they read clearly
const inClear = (x, z, pad = 0) => inClearBox(x, z, pad) || inRelicZone(x, z);
const inBath = (x, z) => x > BATH.x0 - 0.3 && x < BATH.x1 && z > BATH.z0 && z < BATH.z1;
const inMountain = (x, z) => Math.hypot(x - MOUNTAIN.x, z - MOUNTAIN.z) < MOUNTAIN.r;

// ------------------------------------------------------------ textures
function canvasTex(size, draw, rep = 1) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rep, rep);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function groundTexture() {
    return canvasTex(512, (ctx, s) => {
        ctx.fillStyle = '#2a2521';
        ctx.fillRect(0, 0, s, s);
        for (let i = 0; i < 14000; i++) {
            const v = 20 + rnd() * 50;
            ctx.fillStyle = `rgba(${v + 8},${v + 2},${v - 4},${0.2 + rnd() * 0.35})`;
            const r = 1 + rnd() * 3;
            ctx.fillRect(rnd() * s, rnd() * s, r, r);
        }
        // scorch blotches + ash streaks
        for (let i = 0; i < 40; i++) {
            const x = rnd() * s, y = rnd() * s, r = 20 + rnd() * 70;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            const dark = rnd() < 0.6;
            g.addColorStop(0, dark ? 'rgba(8,6,5,0.55)' : 'rgba(110,100,92,0.25)');
            g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
    }, 60);
}

function flameTexture() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 92, 2, 32, 80, 60);
    g.addColorStop(0, 'rgba(255,245,200,1)');
    g.addColorStop(0.25, 'rgba(255,190,70,0.95)');
    g.addColorStop(0.55, 'rgba(240,90,20,0.6)');
    g.addColorStop(1, 'rgba(120,20,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(32, 2);
    ctx.bezierCurveTo(60, 50, 64, 90, 32, 126);
    ctx.bezierCurveTo(0, 90, 4, 50, 32, 2);
    ctx.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function smokeTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    for (let i = 0; i < 7; i++) {
        const x = 40 + rnd() * 48, y = 40 + rnd() * 48, r = 26 + rnd() * 30;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(60,55,50,0.45)');
        g.addColorStop(1, 'rgba(60,55,50,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 128, 128);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

// ------------------------------------------------------------ helpers
function addCollider(hx, hy, hz, x, y, z, quat = null) {
    if (inClearBox(x, z, 0.8)) return;
    const b = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(hx, hy, hz)) });
    b.position.set(x, y, z);
    if (quat) b.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    worldRef.addBody(b);
    bodies.push(b);
}

// Batch of boxes sharing one material -> single InstancedMesh.
function boxBatch(list, mat, colors = null) {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, list.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    list.forEach((b, i) => {
        q.setFromEuler(new THREE.Euler(b.rx || 0, b.ry || 0, b.rz || 0));
        m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.w, b.h, b.d));
        mesh.setMatrixAt(i, m);
        if (colors) mesh.setColorAt(i, col.set(pick(colors)).multiplyScalar(0.75 + rnd() * 0.45));
        if (b.solid) addCollider(b.w / 2, b.h / 2, b.d / 2, b.x, b.y, b.z, q.clone());
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
}

// ------------------------------------------------------------ build
export function buildAftermath(ctx) {
    disposeAftermath();
    seed = 424242 + Math.floor(Math.random() * 1000);
    const { scene, world } = ctx;
    worldRef = world;

    // 1. Remove everything that isn't the restroom, the mountain or core lights.
    const keepLights = new Set(Object.values(ctx.lights || {}));
    scene.children.slice().forEach(obj => {
        if (obj === ctx.camera || obj.userData?.nukeKeep || keepLights.has(obj)) return;
        if (Array.from(keepLights).some(l => l.target === obj)) return;
        scene.remove(obj);
    });
    world.bodies.slice().forEach(b => {
        if (!ctx.keepBodies.has(b)) world.removeBody(b);
    });

    // 2. Scorch the outside faces of the restroom (tiles inside stay clean).
    const charred = new THREE.MeshStandardMaterial({ color: 0x2b2420, roughness: 1, metalness: 0 });
    scene.children.forEach(obj => {
        if (!obj.userData?.nukeBathroom) return;
        obj.traverse(o => {
            if (!o.isMesh) return;
            if (Array.isArray(o.material)) {
                o.material = o.material.map(mt => ctx.bathroomMats.has(mt) ? mt : charred);
            } else if (o.material && !ctx.bathroomMats.has(o.material) && o.userData.nukeOutside) {
                o.material = charred;
            }
        });
    });

    // 3. Sky, fog and light: choking brown haze.
    const hazeColor = new THREE.Color(0x4a3b31);
    scene.background = new THREE.Color(0x3d302a);
    scene.environment = null;
    scene.fog = new THREE.Fog(hazeColor, 18, 560);
    const L = ctx.lights || {};
    if (L.ambientLight) { L.ambientLight.color.set(0x8a6b58); L.ambientLight.intensity = 0.32; }
    if (L.hemiLight) { L.hemiLight.color.set(0x8c6a52); L.hemiLight.groundColor.set(0x1a1310); L.hemiLight.intensity = 0.55; }
    if (L.sunLight) { L.sunLight.color.set(0xff8a4c); L.sunLight.intensity = 0.7; }
    if (L.fillLight) { L.fillLight.color.set(0x6b4a3a); L.fillLight.intensity = 0.15; }

    root = new THREE.Group();
    root.userData.nukeKeep = true;
    scene.add(root);

    // Dim flickering bulb left in the restroom
    bathLight = new THREE.PointLight(0xffe2b0, 6, 9, 1.4);
    bathLight.position.set(33.2, 3.7, -25.8);
    root.add(bathLight);

    // 4. Ground: charred earth everywhere + the store's cracked slab
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800),
        new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 1, metalness: 0 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    root.add(ground);
    const slab = new THREE.Mesh(new THREE.PlaneGeometry(61, 61),
        new THREE.MeshStandardMaterial({ color: 0x3a3632, roughness: 1 }));
    slab.rotation.x = -Math.PI / 2;
    slab.position.y = 0.0;
    slab.receiveShadow = true;
    root.add(slab);
    // Scorch decals / ash piles
    const scorchMat = new THREE.MeshBasicMaterial({ color: 0x0c0a09, transparent: true, opacity: 0.55, depthWrite: false });
    for (let i = 0; i < 40; i++) {
        const x = range(-90, 90), z = range(-130, 60);
        if (inClear(x, z)) continue;
        const s = new THREE.Mesh(new THREE.CircleGeometry(range(1.5, 6), 12), scorchMat);
        s.rotation.x = -Math.PI / 2;
        s.position.set(x, 0.015 + i * 0.0003, z);
        root.add(s);
    }

    const CONCRETE = [0x5b5650, 0x4a4541, 0x3b3733, 0x6b655e, 0x2e2a27];
    const WOOD = [0x2a1a10, 0x1c120b, 0x3b2616, 0x140d08];
    const STEEL = [0x3a2a22, 0x4a3326, 0x2b2522, 0x5a3a28];

    // 5. Concrete chunks: dense inside the old store footprint, sparse beyond
    const chunks = [];
    const addChunk = (x, z, big) => {
        if (inClear(x, z) || inBath(x, z) || inMountain(x, z)) return;
        const w = big ? range(1.2, 3.2) : range(0.25, 1.1);
        const h = big ? range(0.5, 1.6) : range(0.15, 0.7);
        const d = big ? range(1.0, 2.8) : range(0.25, 1.1);
        chunks.push({ x, z, y: h * 0.35, w, h, d, rx: range(-0.4, 0.4), ry: range(0, Math.PI), rz: range(-0.4, 0.4), solid: big });
    };
    for (let i = 0; i < 380; i++) addChunk(range(-33, 33), range(-33, 33), rnd() < 0.18);
    // Piles hugging the old wall lines
    for (let i = 0; i < 160; i++) {
        const side = Math.floor(rnd() * 4), u = range(-31, 31), off = range(-2.5, 2.5);
        const [x, z] = side === 0 ? [u, -30 + off] : side === 1 ? [u, 30 + off] : side === 2 ? [-30 + off, u] : [30 + off, u];
        addChunk(x, z, rnd() < 0.3);
    }
    for (let i = 0; i < 320; i++) {
        const a = rnd() * Math.PI * 2, r = range(36, 150);
        addChunk(Math.cos(a) * r, Math.sin(a) * r * 1.1 - 20, rnd() < 0.1);
    }
    boxBatch(chunks, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98 }), CONCRETE);

    // 6. Charred wooden planks and beams
    const planks = [];
    for (let i = 0; i < 230; i++) {
        const inside = i < 170;
        const a = rnd() * Math.PI * 2, r = inside ? 0 : range(34, 90);
        const x = inside ? range(-32, 32) : Math.cos(a) * r;
        const z = inside ? range(-32, 32) : Math.sin(a) * r - 15;
        if (inClear(x, z) || inBath(x, z)) continue;
        const len = range(1.5, 4.5);
        const lean = rnd() < 0.25;
        planks.push({
            x, z, y: lean ? len * 0.3 : range(0.08, 0.5), w: range(0.1, 0.22), h: range(0.18, 0.32), d: len,
            ry: range(0, Math.PI), rx: lean ? range(0.5, 1.0) : range(-0.12, 0.12), rz: range(-0.2, 0.2)
        });
    }
    boxBatch(planks, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, emissive: 0x220800, emissiveIntensity: 0.25 }), WOOD);

    // 7. Twisted steel: fallen I-beams, broken standing columns, bent ones
    const steel = [];
    const steelMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0.55 });
    for (let i = 0; i < 48; i++) {
        const x = range(-31, 31), z = range(-31, 31);
        if (inClear(x, z, 1.5) || inBath(x, z)) continue;
        const len = range(5, 13);
        const pitch = rnd() < 0.45 ? range(0.12, 0.6) : range(-0.05, 0.05);
        steel.push({ x, z, y: 0.3 + Math.sin(pitch) * len * 0.5, w: 0.32, h: 0.5, d: len, ry: range(0, Math.PI), rx: pitch, solid: pitch < 0.1 });
    }
    // Standing columns from the old roof grid, snapped at different heights
    for (let gx = -20; gx <= 20; gx += 10) {
        for (let gz = -20; gz <= 20; gz += 10) {
            if (rnd() < 0.35) continue;
            const x = gx + range(-0.6, 0.6), z = gz + range(-0.6, 0.6);
            if (inClear(x, z, 1)) continue;
            const h = range(1.5, 7.5);
            const tilt = range(-0.2, 0.2);
            steel.push({ x, z, y: h / 2, w: 0.42, h, d: 0.42, rz: tilt, rx: range(-0.1, 0.1), solid: true });
            // Bent top section
            if (rnd() < 0.55) {
                const bend = range(0.6, 1.3) * (rnd() < 0.5 ? 1 : -1);
                const seg = range(1.5, 3.5);
                steel.push({ x: x + Math.sin(bend) * seg * 0.5 - Math.sin(tilt) * h * 0.5, z, y: h + Math.cos(bend) * seg * 0.45, w: 0.4, h: seg, d: 0.4, rz: -bend });
            }
        }
    }
    // Scorched shelf skeletons
    for (let i = 0; i < 12; i++) {
        const x = range(-24, 18), z = range(-22, 24);
        if (inClear(x, z, 2)) continue;
        const ry = range(0, Math.PI), fall = range(0.3, 1.4);
        const c = Math.cos(ry), s = Math.sin(ry);
        for (let k = 0; k < 4; k++) {
            const off = (k - 1.5) * 0.7;
            steel.push({ x: x + c * off, z: z - s * off, y: 0.6 + k * 0.12, w: 0.08, h: 0.08, d: 3.2, ry: ry + Math.PI / 2, rx: fall * 0.2 });
        }
        steel.push({ x, z, y: 0.35, w: 2.4, h: 0.05, d: 0.9, ry, rz: range(-0.3, 0.3), rx: range(-0.2, 0.2) });
    }
    boxBatch(steel, steelMat, STEEL);

    // 8. Jagged wall stubs along the old store perimeter (never the restroom side)
    const walls = [];
    const stubRun = (x0, z0, x1, z1) => {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const ry = Math.atan2(x1 - x0, z1 - z0);
        let u = 0;
        while (u < len) {
            const seg = range(1.2, 4.5);
            if (rnd() < 0.55) {
                const k = (u + seg / 2) / len;
                const x = x0 + (x1 - x0) * k, z = z0 + (z1 - z0) * k;
                if (!inClear(x, z, 0.5) && !inBath(x, z)) {
                    const h = range(0.4, rnd() < 0.2 ? 4.2 : 2.2);
                    walls.push({ x, z, y: h / 2, w: 0.5, h, d: seg, ry, rx: range(-0.06, 0.06), solid: true });
                }
            }
            u += seg + range(0.2, 2.5);
        }
    };
    stubRun(-30, -30, 30, -30);
    stubRun(-30, 30, 30, 30);
    stubRun(-30, -30, -30, 30);
    stubRun(30, -19, 30, 30);
    boxBatch(walls, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }), [0x4a3c34, 0x3a302b, 0x5a4a40, 0x2a221e]);

    // 9. Relics: MagMart sign, toppled shelf, scorched products, car remnants
    buildRelics(root, ctx, {
        rnd, range, pick, addCollider,
        isFree: (x, z) => !inClear(x, z, 1) && !inBath(x, z)
    });

    // Snapped light poles
    const poles = [];
    for (let i = 0; i < 9; i++) {
        const x = range(-50, 50), z = range(-45, -110);
        const fallen = rnd() < 0.6;
        const h = fallen ? range(5, 8) : range(1.5, 4);
        poles.push(fallen
            ? { x, z, y: 0.2, w: 0.22, h: 0.22, d: h, ry: range(0, Math.PI) }
            : { x, z, y: h / 2, w: 0.25, h, d: 0.25, rz: range(-0.25, 0.25), solid: true });
    }
    boxBatch(poles, steelMat, [0x2a2522, 0x3a2a22]);

    // 10. Distant ruins where the city skyline stood
    const ruins = [], mounds = [];
    for (let i = 0; i < 46; i++) {
        const a = rnd() * Math.PI * 2, r = range(150, 440);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (inMountain(x, z) || Math.hypot(x, z) < 130) continue;
        const bw = range(12, 30), bd = range(12, 30), bh = range(8, 55);
        const ry = range(0, Math.PI);
        const c = Math.cos(ry), s = Math.sin(ry);
        mounds.push({ x, z, r: Math.max(bw, bd) * 0.75, h: range(4, 12) });
        // Skeleton columns at the corners, broken to random heights
        [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1]].forEach(([u, v]) => {
            if (rnd() < 0.3) return;
            const lx = u * bw / 2, lz = v * bd / 2;
            const h = bh * range(0.3, 1);
            ruins.push({ x: x + lx * c + lz * s, z: z - lx * s + lz * c, y: h / 2, w: 1.1, h, d: 1.1, ry, rz: range(-0.12, 0.12) });
        });
        // A few floor girders still hanging on
        for (let f = 0; f < 3; f++) {
            if (rnd() < 0.4) continue;
            const y = bh * range(0.2, 0.7);
            ruins.push({ x, z, y, w: bw * range(0.5, 1), h: 0.8, d: 0.8, ry, rz: range(-0.35, 0.35) });
        }
    }
    boxBatch(ruins, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.3 }), [0x241c18, 0x2e231d, 0x1a1512]);
    const moundMat = new THREE.MeshStandardMaterial({ color: 0x2c2420, roughness: 1, flatShading: true });
    mounds.forEach(m => {
        const mesh = new THREE.Mesh(new THREE.ConeGeometry(m.r, m.h, 7), moundMat);
        mesh.position.set(m.x, m.h / 2 - 0.5, m.z);
        mesh.rotation.y = rnd() * 3;
        root.add(mesh);
    });

    // 11. Fires: near ones light the rubble, distant ones glow on the horizon
    const flameTex = flameTexture();
    const smokeTex = smokeTexture();
    const flameMat = new THREE.SpriteMaterial({ map: flameTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    const farFlameMat = new THREE.SpriteMaterial({ map: flameTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, opacity: 0.8 });
    const smokeMat = new THREE.SpriteMaterial({ map: smokeTex, depthWrite: false, transparent: true });

    const addFire = (x, z, size, far, withLight) => {
        const f = { sprites: [], light: null, x, z, base: size, far };
        const n = far ? 2 : 4;
        for (let k = 0; k < n; k++) {
            const sp = new THREE.Sprite(far ? farFlameMat : flameMat);
            sp.position.set(x + range(-0.5, 0.5) * size, size * 0.5, z + range(-0.5, 0.5) * size);
            sp.userData.phase = rnd() * 10;
            sp.userData.w = size * range(0.6, 1.1);
            sp.userData.h = size * range(1.2, 1.9);
            root.add(sp);
            f.sprites.push(sp);
        }
        if (withLight) {
            f.light = new THREE.PointLight(0xff7a2a, 14, size * 9, 1.5);
            f.light.position.set(x, size * 0.8, z);
            root.add(f.light);
        }
        fires.push(f);
        if (!far) nearFires.push(f);
        // Smoke column
        const puffs = far ? 3 : 5;
        for (let k = 0; k < puffs; k++) {
            const sp = new THREE.Sprite(smokeMat.clone());
            const life = range(6, 11);
            const s = { sprite: sp, x, z, age: rnd() * life, life, speed: far ? range(6, 10) : range(1.2, 2.2), drift: range(0.5, 1.5), size: far ? size * 3 : size * 2.2 };
            if (far) sp.material.fog = false;
            root.add(sp);
            smoke.push(s);
        }
    };
    const nearSpots = [];
    for (let i = 0; i < 16; i++) {
        const x = range(-32, 32), z = range(-60, 32);
        if (inClear(x, z, 2) || inBath(x, z)) continue;
        nearSpots.push([x, z]);
    }
    nearSpots.forEach(([x, z], i) => addFire(x, z, range(0.9, 2.0), false, i < 4));
    for (let i = 0; i < 38; i++) {
        const a = rnd() * Math.PI * 2, r = range(120, 450);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (inMountain(x, z)) continue;
        addFire(x, z, range(6, 16), true, false);
    }

    // 12. Falling ash around the player
    const ASH = 1400;
    const pos = new Float32Array(ASH * 3);
    for (let i = 0; i < ASH; i++) {
        pos[i * 3] = range(-40, 40);
        pos[i * 3 + 1] = range(0, 22);
        pos[i * 3 + 2] = range(-40, 40);
    }
    const ashGeo = new THREE.BufferGeometry();
    ashGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    ash = new THREE.Points(ashGeo, new THREE.PointsMaterial({ color: 0xb9aea4, size: 0.07, transparent: true, opacity: 0.8, depthWrite: false }));
    ash.frustumCulled = false;
    root.add(ash);
}

// ------------------------------------------------------------ update
const inBathroom = p => p && p.x > 30.2 && p.x < 35.8 && p.z > -29.8 && p.z < -21.7;

export function updateAftermath(dt, now, playerPos) {
    if (!root) return;
    const t = now * 0.001;
    fires.forEach(f => {
        f.sprites.forEach((sp, k) => {
            const ph = sp.userData.phase;
            const flick = 0.82 + 0.18 * Math.sin(t * 9 + ph) + 0.1 * Math.sin(t * 23 + ph * 2);
            sp.scale.set(sp.userData.w * (0.9 + 0.1 * Math.sin(t * 7 + ph)), sp.userData.h * flick, 1);
            sp.position.y = sp.scale.y * 0.42;
        });
        if (f.light) f.light.intensity = 10 + 5 * Math.sin(t * 11 + f.x) + 3 * Math.sin(t * 27 + f.z);
    });
    smoke.forEach(s => {
        s.age += dt;
        if (s.age > s.life) s.age -= s.life;
        const k = s.age / s.life;
        const sz = s.size * (0.6 + 1.8 * k);
        s.sprite.scale.set(sz, sz, 1);
        s.sprite.position.set(s.x + k * s.drift * 6, s.size * 0.5 + s.age * s.speed, s.z + k * s.drift * 2);
        s.sprite.material.opacity = Math.sin(k * Math.PI) * 0.8;
    });
    if (bathLight) {
        const buzz = Math.sin(t * 50) > 0.97 || (Math.sin(t * 0.7) > 0.93 && Math.sin(t * 31) > 0);
        bathLight.intensity = buzz ? 0.6 : 6;
    }
    if (ash && playerPos) {
        const a = ash.geometry.attributes.position;
        const arr = a.array;
        for (let i = 0; i < arr.length; i += 3) {
            arr[i] += (0.6 + Math.sin(t + i) * 0.3) * dt;
            arr[i + 1] -= (0.35 + (i % 7) * 0.05) * dt;
            arr[i + 2] += Math.cos(t * 0.5 + i) * 0.2 * dt;
            // Wrap around the player
            if (arr[i + 1] < 0) arr[i + 1] += 22;
            if (arr[i] - playerPos.x > 40) arr[i] -= 80;
            if (arr[i] - playerPos.x < -40) arr[i] += 80;
            if (arr[i + 2] - playerPos.z > 40) arr[i + 2] -= 80;
            if (arr[i + 2] - playerPos.z < -40) arr[i + 2] += 80;
        }
        a.needsUpdate = true;
        // Ash doesn't fall inside the restroom
        ash.visible = !inBathroom(playerPos);
    }
}

// Wind is muffled inside the restroom; fire crackle depends on the nearest fire.
export function aftermathWindVolume(p) {
    if (!p) return { wind: 0.4, fire: 0 };
    const inside = inBathroom(p);
    let nearest = Infinity;
    nearFires.forEach(f => { nearest = Math.min(nearest, Math.hypot(p.x - f.x, p.z - f.z)); });
    const fire = Math.max(0, 1 - nearest / 14) * (inside ? 0.15 : 0.7);
    return { wind: inside ? 0.3 : 0.9, fire };
}

export function disposeAftermath() {
    if (root) {
        root.removeFromParent();
        root.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.map?.dispose(); m.dispose(); });
        });
    }
    if (worldRef) bodies.forEach(b => { try { worldRef.removeBody(b); } catch (_) {} });
    root = null; fires = []; smoke = []; ash = null; bathLight = null; bodies = []; nearFires = []; worldRef = null;
}

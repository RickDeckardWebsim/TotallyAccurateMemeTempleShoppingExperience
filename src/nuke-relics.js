// Recognisable relics half-buried in the nuclear wasteland: the MagMart sign
// by the restroom, a toppled shelf, scorched products and burnt-out cars.
import * as THREE from 'three';
import { addMagMartLogo3D } from './magmart-logo-3d.js';
import { buildCarModel } from './car-skins.js';

// Keep-out zones the random rubble avoids so the relics stay readable.
export const RELIC_ZONES = [
    { x: 21.5, z: -20.5, r: 4.2 }, // MagMart sign, just outside the restroom door
    { x: 2, z: 6, r: 4.8 }         // toppled shelf
];
export const inRelicZone = (x, z) => RELIC_ZONES.some(k => Math.hypot(x - k.x, z - k.z) < k.r);

const SOOT = new THREE.Color(0x140e0a);
const EMBER = new THREE.Color(0x3a1406);

// Clone every material and bake in scorching: darkened towards soot, matte.
function char(obj, amount) {
    obj.traverse(o => {
        if (!o.isMesh) return;
        const conv = m => {
            const c = m.clone();
            if (c.color) c.color.lerp(SOOT, amount);
            if (c.emissive) { c.emissive.multiplyScalar(1 - amount); c.emissiveIntensity = (c.emissiveIntensity ?? 1) * (1 - amount); }
            if ('roughness' in c) c.roughness = Math.min(1, (c.roughness ?? 0.5) + amount * 0.6);
            if ('metalness' in c) c.metalness = (c.metalness ?? 0) * (1 - amount * 0.5);
            if (c.transparent && c.opacity < 1) c.opacity = Math.min(1, c.opacity + amount * 0.4);
            return c;
        };
        o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
        o.castShadow = true;
        o.receiveShadow = true;
    });
}

// Sink an object so `frac` of its (rotated) height is underground.
function bury(obj, frac) {
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const h = box.max.y - box.min.y;
    obj.position.y += -box.min.y - h * frac;
}

// Normalise a model so its largest dimension is `size`, centred on the origin.
function fit(model, size) {
    const box = new THREE.Box3().setFromObject(model);
    const dim = new THREE.Vector3();
    box.getSize(dim);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const k = size / Math.max(0.001, dim.x, dim.y, dim.z);
    model.position.sub(center).multiplyScalar(k);
    model.scale.multiplyScalar(k);
    const g = new THREE.Group();
    g.add(model);
    return g;
}

export function buildRelics(root, ctx, { rnd, range, pick, addCollider, isFree }) {
    const dirtMat = new THREE.MeshStandardMaterial({ color: 0x241c17, roughness: 1, flatShading: true });
    const mound = (x, z, r, h) => {
        const m = new THREE.Mesh(new THREE.SphereGeometry(1, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2), dirtMat);
        m.scale.set(r * range(0.85, 1.15), h, r * range(0.85, 1.15));
        m.rotation.y = rnd() * 6;
        m.position.set(x, -0.02, z);
        m.receiveShadow = true;
        root.add(m);
    };
    const shardMat = new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 1 });
    const shard = (x, z, w, d, mat = shardMat) => {
        const s = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), mat);
        s.position.set(x, 0.05, z);
        s.rotation.set(range(-0.3, 0.3), rnd() * 6, range(-0.3, 0.3));
        s.castShadow = true;
        root.add(s);
    };

    // ---------------------------------------------------- MagMart sign
    {
        const { x, z } = RELIC_ZONES[0];
        const boardMat = new THREE.MeshStandardMaterial({ color: 0x2b2826, roughness: 0.95, metalness: 0.2 });
        const board = new THREE.Mesh(new THREE.BoxGeometry(6.4, 1.8, 0.22), boardMat);
        addMagMartLogo3D(board, false);
        // Halo glow is long dead; letters are scorched but readable
        board.traverse(o => {
            if (o.isMesh && o.material?.isMeshBasicMaterial) o.visible = false;
        });
        char(board, 0.42);
        const sign = new THREE.Group();
        sign.add(board);
        // Face tipped up towards the sky, nose-diving into the dirt at one corner
        board.rotation.set(-1.08, 0, 0.2);
        sign.rotation.y = Math.PI / 2 + 0.35;          // readable walking out of the restroom
        sign.position.set(x, 0, z);
        root.add(sign);
        bury(sign, 0.38);
        mound(x - 0.4, z - 1.2, 2.2, 0.55);
        mound(x + 0.6, z + 1.8, 1.4, 0.35);
        // Snapped-off chunk of the board and its bent support posts
        const chunk = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 0.22), boardMat);
        chunk.position.set(x + 2.3, 0.18, z + 3.0);
        chunk.rotation.set(-1.4, 0.7, 0.3);
        chunk.castShadow = true;
        root.add(chunk);
        const postMat = new THREE.MeshStandardMaterial({ color: 0x3a2a22, roughness: 0.8, metalness: 0.5 });
        [[-1.6, 0.9], [1.2, -0.7]].forEach(([ox, oz], i) => {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.2, 8), postMat);
            post.position.set(x + ox, 0.35, z + oz);
            post.rotation.set(1.3 + i * 0.15, i ? 0.9 : -0.6, 0.4);
            post.castShadow = true;
            root.add(post);
        });
        for (let i = 0; i < 6; i++) shard(x + range(-3, 3), z + range(-3, 3), range(0.2, 0.6), range(0.15, 0.5), boardMat);
        addCollider(2.8, 0.4, 0.8, x, 0.4, z, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, sign.rotation.y, 0)));
    }

    // ---------------------------------------------------- toppled shelf
    {
        const { x, z } = RELIC_ZONES[1];
        const W = 8, H = 4.8, D = 1.6;
        const wood = new THREE.MeshStandardMaterial({ color: 0x8a6345, roughness: 1 });
        const dark = new THREE.MeshStandardMaterial({ color: 0x5e412a, roughness: 1 });
        const shelf = new THREE.Group();
        const part = (w, h, d, mat, px, py, pz, rx = 0, ry = 0, rz = 0) => {
            const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
            m.position.set(px, py, pz);
            m.rotation.set(rx, ry, rz);
            shelf.add(m);
            return m;
        };
        part(0.08, H, D, wood, -W / 2, H / 2, 0);
        part(0.08, H * 0.62, D, wood, W / 2, H * 0.31, 0, 0, 0, 0.05);      // snapped side
        part(W - 0.2, H * 0.8, 0.06, wood, -0.3, H * 0.42, -D / 2 + 0.05, 0.02, 0, 0.04);
        part(W, 0.22, D, dark, 0, 0.11, 0);
        [1.1, 2.2, 3.3].forEach((y, i) => {
            const sag = i === 1 ? 0.25 : 0;
            part(i === 2 ? W * 0.55 : W - 0.2, 0.06, D - 0.1, wood, i === 2 ? -W * 0.2 : 0, y, 0.02, 0, 0, sag * (rnd() < 0.5 ? 1 : -1));
        });
        part(W * 0.5, 0.12, D + 0.04, dark, -W * 0.25, H - 0.06, 0);
        char(shelf, 0.72);
        // Fallen on its back, one end driven into the ground
        shelf.rotation.set(-1.25, 0.6, 0.12, 'YXZ');
        shelf.position.set(x, 0, z);
        root.add(shelf);
        bury(shelf, 0.3);
        mound(x + 2.4, z - 1.2, 2.4, 0.6);
        mound(x - 2.6, z + 1.4, 1.6, 0.4);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.6, 0));
        addCollider(3.8, 0.5, 1.4, x, 0.5, z, q);
    }

    // ---------------------------------------------------- scorched products
    const names = ['Milk', 'Cereal', 'Soda', 'Canned Goods', 'Watermelon', 'Toilet paper', 'Ketchup',
        'Dog food', 'Toys', 'Coffee', 'Pizza', 'Batteries', 'Water bottles', 'Shampoo', 'Bread', 'Peanut Butter'];
    const spots = [];
    // A few spilled around the toppled shelf, the rest across the old aisles
    for (let i = 0; i < 4; i++) spots.push([RELIC_ZONES[1].x + range(-4.5, 4.5), RELIC_ZONES[1].z + range(2.5, 4.5)]);
    for (let tries = 0; spots.length < 18 && tries < 200; tries++) {
        const sx = range(-27, 26), sz = range(-27, 27);
        if (!isFree(sx, sz) || spots.some(([a, b]) => Math.hypot(a - sx, b - sz) < 4)) continue;
        spots.push([sx, sz]);
    }
    spots.forEach(([sx, sz], i) => {
        const raw = ctx.makeItemModel?.(names[i % names.length]);
        if (!raw) return;
        const item = fit(raw, range(0.6, 1.0));
        char(item, range(0.5, 0.72));
        // Crushed a little, knocked over
        item.scale.set(range(0.95, 1.1), range(0.72, 0.92), range(0.95, 1.1));
        item.rotation.set(range(-1.4, 1.4), rnd() * 6, range(-1.4, 1.4));
        item.position.set(sx, 0, sz);
        root.add(item);
        bury(item, range(0.22, 0.45));
        mound(sx, sz, range(0.45, 0.75), range(0.12, 0.22));
    });

    // ---------------------------------------------------- car remnants
    const skins = ['default', 'sedan', 'smart', 'lambo', 'default', 'sedan', 'default'];
    for (let i = 0; i < skins.length; i++) {
        const cx = range(-42, 42), cz = range(-50, -100);
        let car;
        try { car = buildCarModel(skins[i]).group; } catch (_) { continue; }
        // Strip away panels, glass and wheels: only a gutted shell is left
        const parts = [];
        car.traverse(o => { if (o.isMesh) parts.push(o); });
        parts.forEach(o => {
            const m0 = Array.isArray(o.material) ? o.material[0] : o.material;
            const glass = m0 && (m0.transparent || (m0.roughness < 0.15 && m0.metalness >= 0.6));
            if (glass || rnd() < 0.35) o.visible = false;
        });
        char(car, range(0.78, 0.9));
        car.traverse(o => {
            if (!o.isMesh || rnd() > 0.25) return;
            (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.emissive?.copy(EMBER));
        });
        car.scale.set(1, range(0.6, 0.8), 1);          // roof crushed in
        car.rotation.set(range(-0.25, 0.25), rnd() * 6, rnd() < 0.2 ? Math.PI * 0.92 : range(-0.3, 0.3), 'YXZ');
        car.position.set(cx, 0, cz);
        root.add(car);
        bury(car, range(0.25, 0.4));
        mound(cx, cz, 2.6, 0.35);
        for (let k = 0; k < 4; k++) shard(cx + range(-3, 3), cz + range(-3, 3), range(0.3, 0.9), range(0.2, 0.7));
        addCollider(1.0, 0.5, 2.0, cx, 0.4, cz, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, car.rotation.y, 0)));
    }
}

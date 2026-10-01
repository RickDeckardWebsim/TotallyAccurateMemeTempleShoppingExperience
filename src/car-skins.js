// Player car models. Front faces +Z. Each builder returns { group, half } where
// `half` is the collider half-extents [x, y, z].
import * as THREE from 'three';

const std = (color, roughness = 0.4, metalness = 0.3) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
const glassMat = () => new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.08, metalness: 0.7 });
const tireMat = () => new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
const lampMat = color => new THREE.MeshBasicMaterial({ color });

function kit() {
    const g = new THREE.Group();
    const add = (geo, mat, x = 0, y = 0, z = 0) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.castShadow = true;
        g.add(m);
        return m;
    };
    const box = (w, h, d, mat, x, y, z) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
    // Side profile given as [z, y] points, extruded across the car's width.
    const profile = (pts, width, mat) => {
        const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
        const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
        geo.translate(0, 0, -width / 2);
        geo.rotateY(-Math.PI / 2);
        return add(geo, mat);
    };
    const wheels = (r, w, x, zs, rimColor = 0xc7ccd3) => {
        const tg = new THREE.CylinderGeometry(r, r, w, 18);
        const rg = new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 14);
        const tm = tireMat(), rm = std(rimColor, 0.25, 0.8);
        for (const z of zs) for (const sx of [-1, 1]) {
            add(tg, tm, sx * x, r, z).rotation.z = Math.PI / 2;
            add(rg, rm, sx * x, r, z).rotation.z = Math.PI / 2;
        }
    };
    return { g, add, box, profile, wheels };
}

function buildDefault() {
    const { g, box, wheels } = kit();
    const paint = std(0x0ea5a4, 0.3, 0.5);
    box(1.9, 0.58, 4.2, paint, 0, 0.62, 0);
    box(1.6, 0.52, 2.3, glassMat(), 0, 1.08, -0.15);
    box(1.5, 0.06, 2.1, paint, 0, 1.36, -0.15);
    wheels(0.34, 0.26, 0.9, [1.35, -1.35]);
    for (const sx of [-0.6, 0.6]) {
        box(0.5, 0.14, 0.06, lampMat(0xfff7d6), sx, 0.7, 2.11);
        box(0.5, 0.14, 0.06, lampMat(0xdc2626), sx, 0.7, -2.11);
    }
    return { group: g, half: [0.95, 0.8, 2.1] };
}

// Boxy three-box family sedan with chrome trim and a blue oval badge.
function buildSedan() {
    const { g, add, box, profile, wheels } = kit();
    const W = 1.86, L = 2.45;
    const paint = std(0x1d3b6e, 0.3, 0.55);
    const chrome = std(0xdfe4ea, 0.15, 0.95);
    profile([[-L, 0.32], [L, 0.32], [L, 0.72], [L - 0.1, 0.86], [1.2, 0.92], [-1.45, 0.92], [-L + 0.08, 0.9], [-L, 0.8]], W, paint);
    profile([[1.12, 0.9], [0.4, 1.36], [-0.95, 1.36], [-1.55, 0.9]], W - 0.2, glassMat());
    box(1.52, 0.06, 1.38, paint, 0, 1.38, -0.28);
    for (const sx of [-1, 1]) box(0.08, 0.5, 0.06, paint, sx * (W / 2 - 0.13), 1.13, -0.28); // B-pillars
    // Chrome bumpers, side strips, grille
    box(W + 0.04, 0.14, 0.12, chrome, 0, 0.42, L + 0.02);
    box(W + 0.04, 0.14, 0.12, chrome, 0, 0.42, -L - 0.02);
    for (const sx of [-1, 1]) box(0.02, 0.05, 3.2, chrome, sx * (W / 2 + 0.005), 0.62, 0);
    box(1.0, 0.2, 0.04, std(0x2a2f36, 0.5, 0.4), 0, 0.64, L + 0.01);
    const badge = add(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 20), std(0x1e4fbf, 0.2, 0.6), 0, 0.64, L + 0.04);
    badge.rotation.x = Math.PI / 2;
    badge.scale.set(1.6, 1, 0.75);
    for (const sx of [-1, 1]) {
        box(0.34, 0.16, 0.05, lampMat(0xfff4bf), sx * 0.7, 0.66, L + 0.01);
        box(0.36, 0.2, 0.05, lampMat(0xdc2626), sx * 0.66, 0.66, -L - 0.01);
    }
    wheels(0.36, 0.26, 0.86, [1.5, -1.5]);
    return { group: g, half: [0.93, 0.8, 2.45] };
}

// Tiny tall two-seater: black safety cell, bright body panels.
function buildSmart() {
    const { g, box, profile, wheels } = kit();
    const W = 1.6, L = 1.35;
    const paint = std(0x84cc16, 0.3, 0.35);
    const frame = std(0x1f2937, 0.45, 0.4);
    profile([[-L, 0.26], [L, 0.26], [L + 0.03, 0.62], [1.18, 0.88], [0.8, 0.98], [-L + 0.05, 0.98], [-L, 0.9]], W, paint);
    profile([[0.78, 0.96], [0.15, 1.62], [-1.22, 1.62], [-1.3, 0.96]], W - 0.14, glassMat());
    box(W - 0.2, 0.08, 1.42, frame, 0, 1.65, -0.54);
    // Tridion cell: roof rails, B-pillars, rockers
    for (const sx of [-1, 1]) {
        box(0.06, 0.72, 0.22, frame, sx * (W / 2 - 0.05), 1.28, -0.35);
        box(0.06, 0.18, 2.3, frame, sx * (W / 2 + 0.01), 0.36, 0);
        box(0.36, 0.14, 0.05, lampMat(0xfff4bf), sx * 0.5, 0.72, L + 0.02);
        box(0.18, 0.3, 0.05, lampMat(0xdc2626), sx * 0.62, 0.72, -L - 0.01);
    }
    box(W - 0.16, 0.08, 0.06, frame, 0, 0.98, -L - 0.01);
    box(W + 0.02, 0.16, 0.1, frame, 0, 0.34, L + 0.02);
    box(W + 0.02, 0.16, 0.1, frame, 0, 0.34, -L - 0.02);
    wheels(0.3, 0.24, 0.74, [0.9, -0.92]);
    return { group: g, half: [0.8, 0.85, 1.35] };
}

// Low wedge supercar with side intakes and a rear wing.
function buildLambo() {
    const { g, box, profile, wheels } = kit();
    const W = 2.0, L = 2.3;
    const paint = std(0xff6a00, 0.22, 0.6);
    const carbon = std(0x16181c, 0.5, 0.4);
    profile([[-L, 0.22], [L, 0.22], [L + 0.04, 0.4], [1.3, 0.7], [-1.9, 0.86], [-L, 0.8]], W, paint);
    profile([[1.0, 0.74], [-0.05, 1.12], [-0.95, 1.12], [-1.85, 0.86]], W - 0.46, glassMat());
    box(W - 0.6, 0.05, 0.9, paint, 0, 1.14, -0.5);
    for (const sx of [-1, 1]) {
        // Side intakes
        profile([[-0.4, 0.42], [-1.3, 0.42], [-1.3, 0.72], [-0.7, 0.72]], 0.04, carbon).position.x = sx * (W / 2 + 0.01);
        // Wing posts
        box(0.06, 0.24, 0.12, carbon, sx * 0.65, 0.96, -2.05);
        // Slim angled headlights
        box(0.5, 0.03, 0.3, lampMat(0xfff4bf), sx * 0.6, 0.53, 1.95).rotation.x = 0.28;
    }
    box(1.8, 0.05, 0.4, carbon, 0, 1.1, -2.1); // wing
    box(W - 0.3, 0.08, 0.05, lampMat(0xdc2626), 0, 0.68, -L - 0.01);
    box(W - 0.2, 0.12, 0.1, carbon, 0, 0.28, L + 0.03); // front splitter
    wheels(0.37, 0.32, 0.9, [1.45, -1.4], 0xfbbf24);
    return { group: g, half: [1.0, 0.6, 2.3] };
}

// Noah's ark on wheels: wooden hull, a little cabin with a pitched roof,
// portholes, and a pair of animals peeking over the rail.
function buildBoat() {
    const { g, add, box, profile, wheels } = kit();
    const W = 1.8;
    const wood = std(0x8b5a2b, 0.85, 0.05);
    const darkWood = std(0x5c3a1a, 0.9, 0.05);
    const roof = std(0x6b3f1d, 0.8, 0.05);
    // Hull: pointed bow and stern rising up from the wheels.
    profile([[-1.7, 0.4], [1.7, 0.4], [2.15, 1.05], [2.1, 1.12], [-2.1, 1.12], [-2.15, 1.05]], W, wood);
    for (const y of [0.62, 0.84]) for (const sx of [-1, 1]) box(0.02, 0.04, 3.6, darkWood, sx * (W / 2 + 0.005), y, 0);
    box(W + 0.06, 0.08, 4.2, darkWood, 0, 1.14, 0); // deck rail
    // Cabin
    box(1.3, 0.62, 2.2, std(0xb07a3f, 0.85, 0.05), 0, 1.49, -0.15);
    profile([[0.95, 1.8], [-1.25, 1.8], [-1.25, 1.84], [-0.15, 2.3], [0.95, 1.84]], 0.02, roof); // gable ends
    for (const sx of [-1, 1]) {
        const panel = box(0.9, 0.05, 2.5, roof, sx * 0.37, 2.02, -0.15);
        panel.rotation.z = sx * -0.55;
        // Portholes
        for (const z of [-0.8, -0.15, 0.5]) {
            const hole = add(new THREE.CylinderGeometry(0.11, 0.11, 0.03, 14), glassMat(), sx * 0.66, 1.52, z);
            hole.rotation.z = Math.PI / 2;
        }
    }
    box(0.5, 0.5, 0.04, darkWood, 0, 1.43, 0.96); // front door
    // Two giraffe-ish necks and a pair of sheep poking out on deck
    const giraffe = std(0xe8b04a, 0.8, 0), spot = std(0x7a4b1a, 0.8, 0), wool = std(0xf5f5f0, 0.95, 0);
    for (const sx of [-0.25, 0.25]) {
        box(0.1, 0.8, 0.1, giraffe, sx, 1.55, 1.6);
        box(0.14, 0.12, 0.26, giraffe, sx, 2.0, 1.67);
        box(0.04, 0.06, 0.04, spot, sx + 0.051, 1.6, 1.62);
    }
    for (const sx of [-0.4, 0.4]) add(new THREE.SphereGeometry(0.17, 10, 8), wool, sx, 1.26, -1.6);
    for (const sx of [-0.6, 0.6]) {
        box(0.3, 0.12, 0.05, lampMat(0xfff4bf), sx, 0.72, 2.0);
        box(0.3, 0.12, 0.05, lampMat(0xdc2626), sx, 0.72, -2.0);
    }
    wheels(0.34, 0.26, 0.9, [1.35, -1.35]);
    return { group: g, half: DEFAULT_HALF };
}

const BUILDERS = { sedan: buildSedan, smart: buildSmart, lambo: buildLambo, boat: buildBoat };
const DEFAULT_HALF = [0.95, 0.8, 2.1];

// Skins are cosmetic only: every car uses the default car's collider so no
// skin is easier (or harder) to reach and get into.
export function buildCarModel(skin) {
    const { group } = (BUILDERS[skin] || buildDefault)();
    return { group, half: [...DEFAULT_HALF] };
}

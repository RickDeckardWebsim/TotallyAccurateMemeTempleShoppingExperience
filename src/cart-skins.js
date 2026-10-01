// Cosmetic cart skins. Everything here is purely visual: the added meshes
// ignore raycasts and the cart's physics / occlusion hull are never touched,
// so every skin handles exactly like the default cart.
import * as THREE from 'three';

const FINISHES = {
    //         chrome                  accent (body color)     dark metal
    golden:  [[0xFFD65A, 0.23, 0.78], [0xD99B18, 0.26, 0.58], [0x96600D, 0.3, 0.7]],
    diamond: [[0xE6FBFF, 0.04, 1.0],  [0x9EE8FF, 0.05, 0.9],  [0x7FB6CC, 0.12, 0.9]],
    racecar: [[0xF4F4F4, 0.3, 0.2],   [0xE01414, 0.22, 0.35], [0x1A1A1A, 0.45, 0.5]]
};

export function applyCartFinish(materials, cartColor, skin) {
    const [chrome, accent, dark] = materials;
    const f = FINISHES[skin] || [[0xd8d8d8, 0.2, 0.85], [cartColor, 0.35, 0.2], [0x444444, 0.5, 0.7]];
    [chrome, accent, dark].forEach((m, i) => {
        m.color.setHex(f[i][0]);
        m.roughness = f[i][1];
        m.metalness = f[i][2];
        m.emissive?.setHex(skin === 'diamond' && i < 2 ? 0x16404d : 0x000000);
    });
}

const noRaycast = () => {};

function decorKit() {
    const g = new THREE.Group();
    g.name = 'cartSkinDecor';
    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.rotation.set(rx, ry, rz);
        m.raycast = noRaycast;
        g.add(m);
        return m;
    };
    const box = (w, h, d, mat, x, y, z, rx, ry, rz) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx, ry, rz);
    return { g, add, box };
}

// Small crystal clusters poking out of the rims and frame.
function buildDiamond() {
    const { g, add } = decorKit();
    const crystal = new THREE.MeshStandardMaterial({
        color: 0xdff8ff, roughness: 0.02, metalness: 0.35, emissive: 0x3aa6c9, emissiveIntensity: 0.35,
        transparent: true, opacity: 0.88
    });
    const geo = new THREE.OctahedronGeometry(1, 0);
    const spots = [
        [-0.36, 0.93, 0.35, 0.2, 0.3, 0.5], [0.36, 0.93, -0.2, -0.3, 0.4, -0.5], [0.2, 0.94, 0.54, 0.6, 0, 0.2],
        [-0.25, 0.93, -0.54, -0.5, 0.2, 0], [0.36, 0.6, 0.3, 0, 0, -1.2], [-0.36, 0.55, -0.1, 0, 0, 1.2],
        [0, 0.62, 0.56, 1.2, 0, 0], [-0.36, 0.95, -0.05, 0.1, 0.9, 0.7], [0.3, 0.2, 0.3, 0, 0, -0.9]
    ];
    spots.forEach(([x, y, z, rx, ry, rz], i) => {
        const s = 0.035 + (i % 3) * 0.012;
        add(geo, crystal, x, y, z, rx, ry, rz).scale.set(s * 0.7, s * 1.9, s * 0.7);
        add(geo, crystal, x + 0.02, y + 0.01, z - 0.02, rx + 0.5, ry, rz - 0.4).scale.set(s * 0.45, s * 1.2, s * 0.45);
    });
    return g;
}

// Rear spoiler, side wings, nose splitter, racing stripe and a number roundel.
function buildRacecar() {
    const { g, add, box } = decorKit();
    const red = new THREE.MeshStandardMaterial({ color: 0xe01414, roughness: 0.25, metalness: 0.3 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf8f8f8, roughness: 0.3, metalness: 0.1 });
    const black = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.5, metalness: 0.4 });
    // Spoiler above the handle end
    for (const sx of [-0.26, 0.26]) box(0.03, 0.2, 0.05, black, sx, 1.04, -0.5);
    box(0.84, 0.03, 0.18, red, 0, 1.15, -0.52, -0.12);
    for (const sx of [-0.43, 0.43]) box(0.02, 0.1, 0.22, white, sx, 1.13, -0.52);
    // Side wings
    for (const s of [-1, 1]) {
        box(0.18, 0.02, 0.5, red, s * 0.46, 0.5, 0.02, 0, 0, s * -0.12);
        box(0.02, 0.07, 0.5, white, s * 0.55, 0.52, 0.02);
    }
    // Front splitter + white stripe down the nose
    box(0.8, 0.025, 0.14, black, 0, 0.3, 0.62);
    box(0.14, 0.58, 0.012, white, 0, 0.63, 0.555);
    // Number roundel on each side
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(64, 64, 60, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#111'; ctx.font = 'bold 76px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('7', 64, 68);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const decal = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    for (const s of [-1, 1]) add(new THREE.PlaneGeometry(0.26, 0.26), decal, s * 0.375, 0.64, 0.05, 0, s * Math.PI / 2, 0);
    return g;
}

// A chunky, slightly wrong cart: flat boxes, misaligned panels, wheels that
// don't quite touch the floor, and one floating orphan polygon.
function buildLowQuality() {
    const { g, box, add } = decorKit();
    const flat = hex => new THREE.MeshLambertMaterial({ color: hex, flatShading: true });
    const grey = flat(0x9a9a9a), red = flat(0xff0000), black = flat(0x000000), mystery = flat(0xff00ff);
    box(0.74, 0.08, 1.08, grey, 0, 0.36, 0.03);          // floor
    box(0.06, 0.55, 1.1, grey, -0.37, 0.64, 0.01, 0, 0, 0.04);
    box(0.06, 0.5, 1.02, grey, 0.39, 0.62, 0.06, 0, 0.03, 0);
    box(0.8, 0.58, 0.06, red, 0.02, 0.63, 0.55);          // front panel sticking out
    box(0.72, 0.42, 0.06, grey, 0, 0.58, -0.47, 0.1);
    box(0.9, 0.08, 0.08, red, 0, 0.98, -0.72);           // handle
    for (const sx of [-0.4, 0.4]) box(0.05, 0.62, 0.05, grey, sx, 0.68, -0.62, -0.3);
    box(0.7, 0.05, 0.9, black, 0, 0.18, 0);
    const wheel = new THREE.BoxGeometry(0.06, 0.14, 0.14);
    [[-0.34, 0.12, 0.42], [0.36, 0.09, 0.42], [-0.34, 0.1, -0.42], [0.33, 0.15, -0.45]]
        .forEach(([x, y, z], i) => box(0.06, 0.14, 0.14, black, x, y, z, i * 0.4).geometry = wheel);
    add(new THREE.TetrahedronGeometry(0.06), mystery, 0.22, 1.18, 0.3, 0.4, 0.8, 0);
    return g;
}

const DECOR = { diamond: buildDiamond, racecar: buildRacecar, lowQuality: buildLowQuality };

// Swap the skin on an existing cart group built by buildWireCartGroup.
export function applyCartSkin(cart3D, cartColor, skin) {
    if (!cart3D) return;
    const mesh = cart3D.children.find(child => child.isMesh);
    if (mesh) {
        applyCartFinish(mesh.material, cartColor, skin);
        // The low-quality model replaces the wire cart visually; the original
        // mesh stays in place (hidden) so raycasts still hit the same shape.
        // (three.js raycasting ignores `visible`).
        mesh.visible = skin !== 'lowQuality';
    }
    const old = cart3D.getObjectByName('cartSkinDecor');
    if (old) {
        old.traverse(o => { o.geometry?.dispose(); });
        cart3D.remove(old);
    }
    const build = DECOR[skin];
    if (build) cart3D.add(build());
}

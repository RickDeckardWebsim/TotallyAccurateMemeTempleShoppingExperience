// Cosmetic customer outfits. They only recolor or add meshes to the customer
// model; added meshes ignore raycasts and the physics body is never touched,
// so the hitbox is identical for every skin.
//
// Customer model (see createCustomer in game.js), front faces +Z:
//   head:  sphere r=0.2 at y=1.8 (eyes at z≈0.165)
//   torso: cylinder r=0.35 top / 0.3 bottom, height 0.8, centered y=1.2
//   legs:  cylinders r=0.09 at x=±0.18, height 0.8, centered y=0.4
import * as THREE from 'three';

const noRaycast = () => {};
const pick = list => list[Math.floor(Math.random() * list.length)];
const std = (color, roughness = 0.7, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });

function adder(parent) {
    return (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.rotation.set(rx, ry, rz);
        m.raycast = noRaycast;
        parent.add(m);
        return m;
    };
}

function recolor(cust, { body, legs, head }) {
    if (body != null) cust.bodyMesh.material.color.setHex(body);
    if (legs != null) cust.leftLeg.material.color.setHex(legs);
    if (head != null) cust.head.material.color.setHex(head);
}

// ------------------------------------------------------------------ suits
const SUIT_COLORS = [0x1f2937, 0x1e2a44, 0x2b2b2b, 0x3a3f47, 0x3b2f2a];
const TIE_COLORS = [0xb91c1c, 0x1d4ed8, 0x7c3aed, 0x0f766e, 0xca8a04];

function suits(cust) {
    const suit = pick(SUIT_COLORS);
    recolor(cust, { body: suit, legs: suit });
    const add = adder(cust.bodyMesh);
    const shirt = std(0xf8fafc, 0.6);
    shirt.side = THREE.DoubleSide;
    const v = new THREE.Shape();
    v.moveTo(-0.13, 0); v.lineTo(0.13, 0); v.lineTo(0, -0.34); v.closePath();
    add(new THREE.ShapeGeometry(v), shirt, 0, 0.39, 0.345, -0.06);
    add(new THREE.TorusGeometry(0.2, 0.035, 6, 20), shirt, 0, 0.4, 0, Math.PI / 2);
    const tie = std(pick(TIE_COLORS), 0.5);
    add(new THREE.BoxGeometry(0.06, 0.05, 0.03), tie, 0, 0.35, 0.35);
    add(new THREE.CylinderGeometry(0.035, 0.012, 0.3, 4), tie, 0, 0.18, 0.34, Math.PI, Math.PI / 4);
    const button = std(0x0b0b0b, 0.4);
    for (const y of [-0.08, -0.2]) add(new THREE.SphereGeometry(0.018, 8, 6), button, 0.07, y, 0.325);
}

// --------------------------------------------------------------- costumes
function dinosaur(cust) {
    const red = 0xd62828;
    recolor(cust, { body: red, legs: red, head: red });
    const belly = std(0xf7c59f), spike = std(0xffd23f, 0.5), tooth = std(0xffffff, 0.4), dark = std(0x8c1c13);
    const head = adder(cust.head);
    head(new THREE.BoxGeometry(0.26, 0.14, 0.2), std(red), 0, -0.06, 0.2); // snout
    for (const x of [-0.08, -0.03, 0.03, 0.08]) head(new THREE.ConeGeometry(0.018, 0.04, 4), tooth, x, -0.14, 0.28, Math.PI);
    for (const x of [-0.05, 0.05]) head(new THREE.SphereGeometry(0.014, 6, 6), dark, x, -0.01, 0.3);
    const body = adder(cust.bodyMesh);
    body(new THREE.CylinderGeometry(0.2, 0.18, 0.62, 12, 1, true, -Math.PI / 2.4, Math.PI / 1.2), belly, 0, -0.03, 0.14);
    // Spikes down the back of the head and torso
    [[cust.head, 0.2, 0], [cust.head, 0.12, -0.14], [cust.bodyMesh, 0.3, -0.33], [cust.bodyMesh, 0.08, -0.32], [cust.bodyMesh, -0.14, -0.31]]
        .forEach(([p, y, z], i) => adder(p)(new THREE.ConeGeometry(0.06, 0.14, 4), spike, 0, y, z, -0.6 - (i < 2 ? 0.4 : 0.9)));
    // Tail
    body(new THREE.ConeGeometry(0.16, 0.7, 10), std(red), 0, -0.36, -0.52, -1.25);
}

function clown(cust) {
    const suit = pick([0x7c3aed, 0x2563eb, 0x16a34a, 0xf59e0b]);
    recolor(cust, { body: suit, legs: 0xfacc15 });
    const head = adder(cust.head), body = adder(cust.bodyMesh);
    head(new THREE.SphereGeometry(0.055, 12, 10), std(0xe11d48, 0.3), 0, -0.03, 0.2); // nose
    const wig = std(pick([0xf97316, 0xec4899, 0x22d3ee, 0x84cc16]), 0.95);
    for (const [x, y, z] of [[-0.18, 0.08, -0.02], [0.18, 0.08, -0.02], [-0.14, 0.14, -0.1], [0.14, 0.14, -0.1], [0, 0.17, -0.1]])
        head(new THREE.SphereGeometry(0.1, 10, 8), wig, x, y, z);
    const smile = new THREE.TorusGeometry(0.07, 0.014, 6, 14, Math.PI);
    head(smile, std(0xe11d48, 0.5), 0, -0.08, 0.175, 0, 0, Math.PI);
    const ruff = std(0xffffff, 0.8);
    for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        body(new THREE.SphereGeometry(0.08, 8, 6), ruff, Math.sin(a) * 0.3, 0.4, Math.cos(a) * 0.3);
    }
    const dotColors = [0xef4444, 0xfacc15, 0xffffff, 0x22d3ee];
    [[-0.1, 0.2], [0.12, 0.08], [-0.06, -0.12], [0.1, -0.25], [0, 0.0]].forEach(([x, y], i) =>
        body(new THREE.SphereGeometry(0.04, 8, 6), std(dotColors[i % 4], 0.5), x, y, 0.315 + y * 0.03));
    for (const y of [0.2, -0.05]) body(new THREE.SphereGeometry(0.045, 8, 6), std(0xef4444, 0.5), 0, y, -0.33);
}

function ghost(cust) {
    // A white sheet over the whole body, with two eye holes. The original head
    // is made invisible (it would poke through) but stays in place so the
    // slap/crosshair hitbox is unchanged.
    cust.head.material.visible = false;
    const pts = [[0, 2.04], [0.12, 2.02], [0.21, 1.95], [0.25, 1.82], [0.3, 1.66], [0.38, 1.58], [0.4, 1.2], [0.43, 0.6], [0.47, 0.14]]
        .map(([r, y]) => new THREE.Vector2(r, y));
    const sheetGeo = new THREE.LatheGeometry(pts, 24);
    // Wavy hem
    const pos = sheetGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) < 0.2) pos.setY(i, 0.14 + Math.sin(Math.atan2(pos.getZ(i), pos.getX(i)) * 6) * 0.05);
    }
    sheetGeo.computeVertexNormals();
    const sheet = std(0xf8fafc, 0.9);
    sheet.side = THREE.DoubleSide;
    const add = adder(cust);
    add(sheetGeo, sheet);
    const hole = new THREE.MeshBasicMaterial({ color: 0x111111 });
    for (const x of [-0.08, 0.08]) {
        add(new THREE.CircleGeometry(0.04, 14), hole, x, 1.85, 0.235).scale.set(0.8, 1.25, 1);
    }
    add(new THREE.CircleGeometry(0.03, 12), hole, 0, 1.74, 0.28).scale.set(1, 1.4, 1);
}

function robot(cust) {
    const metal = std(0x9ca3af, 0.3, 0.8), darkMetal = std(0x4b5563, 0.4, 0.7);
    recolor(cust, { body: 0x9ca3af, legs: 0x6b7280 });
    cust.bodyMesh.material.metalness = 0.8;
    cust.bodyMesh.material.roughness = 0.3;
    const head = adder(cust.head), body = adder(cust.bodyMesh);
    head(new THREE.BoxGeometry(0.46, 0.42, 0.46), metal); // encloses the round head
    const glow = new THREE.MeshBasicMaterial({ color: pick([0x22d3ee, 0xef4444, 0x84cc16]) });
    for (const x of [-0.1, 0.1]) head(new THREE.BoxGeometry(0.1, 0.05, 0.02), glow, x, 0.04, 0.235);
    head(new THREE.BoxGeometry(0.2, 0.04, 0.02), darkMetal, 0, -0.1, 0.235);
    head(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 6), darkMetal, 0, 0.29, 0);
    head(new THREE.SphereGeometry(0.035, 10, 8), glow, 0, 0.38, 0);
    for (const x of [-0.24, 0.24]) head(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 12), darkMetal, x, 0, 0, 0, 0, Math.PI / 2);
    body(new THREE.BoxGeometry(0.3, 0.26, 0.04), darkMetal, 0, 0.08, 0.33);
    [0xef4444, 0xfacc15, 0x22c55e].forEach((c, i) =>
        body(new THREE.SphereGeometry(0.022, 8, 6), new THREE.MeshBasicMaterial({ color: c }), -0.08 + i * 0.08, 0.13, 0.355));
    for (const y of [0.0, -0.04]) body(new THREE.BoxGeometry(0.22, 0.012, 0.012), glow, 0, y, 0.355);
}

const COSTUMES = [dinosaur, clown, ghost, robot];

// Flowing rainbow fabric, retaining the standard material's light and shadows.
function rainbowShader(cust) {
    const time = { value: 0 };
    const phase = { value: Math.random() };
    const materials = new Set([cust.bodyMesh.material, cust.leftLeg.material, cust.rightLeg.material]);
    for (const material of materials) {
        material.color.setHex(0xffffff);
        material.roughness = 0.45;
        material.metalness = 0.12;
        material.onBeforeCompile = shader => {
            shader.uniforms.rainbowTime = time;
            shader.uniforms.rainbowPhase = phase;
            shader.vertexShader = 'varying vec3 vRainbowPosition;\n' + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
                '#include <begin_vertex>\nvRainbowPosition = position;');
            shader.fragmentShader = `
                uniform float rainbowTime;
                uniform float rainbowPhase;
                varying vec3 vRainbowPosition;
            ` + shader.fragmentShader;
            shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
                #include <color_fragment>
                float rainbowHue = vRainbowPosition.y * 0.65
                    + vRainbowPosition.x * 0.3 + rainbowTime * 0.12 + rainbowPhase;
                vec3 rainbow = clamp(abs(fract(rainbowHue + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0))
                    * 6.0 - 3.0) - 1.0, 0.0, 1.0);
                diffuseColor.rgb = mix(vec3(0.06), vec3(1.0), rainbow);
            `);
        };
        material.customProgramCacheKey = () => 'rainbow-fabric-v1';
        material.needsUpdate = true;
    }
    // Render callbacks avoid timers or a registry that could survive a session.
    for (const mesh of [cust.bodyMesh, cust.leftLeg, cust.rightLeg]) {
        mesh.onBeforeRender = () => { time.value = (performance.now() / 1000) % 1000; };
    }
}

// ----------------------------------------------------------- squid game
let tracksuitStripe;
function squidGame(cust) {
    const teal = 0x1f8a78;
    recolor(cust, { body: teal, legs: teal });
    tracksuitStripe ||= std(0xf8fafc, 0.6);
    const body = adder(cust.bodyMesh);
    for (const s of [-1, 1]) {
        body(new THREE.BoxGeometry(0.02, 0.78, 0.05), tracksuitStripe, s * 0.33, 0, 0);
        adder(s < 0 ? cust.leftLeg : cust.rightLeg)(new THREE.BoxGeometry(0.02, 0.78, 0.04), tracksuitStripe, s * 0.09, 0, 0);
    }
    // Zipper line
    body(new THREE.BoxGeometry(0.012, 0.76, 0.01), std(0x0f4f45), 0, 0, 0.334);
    body(new THREE.TorusGeometry(0.19, 0.03, 6, 20), std(0x17695c), 0, 0.4, 0, Math.PI / 2);
    // Number patch
    const number = String(1 + Math.floor(Math.random() * 456)).padStart(3, '0');
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, 128, 64);
    ctx.fillStyle = '#111'; ctx.font = 'bold 50px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(number, 64, 35);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    body(new THREE.PlaneGeometry(0.16, 0.08), new THREE.MeshBasicMaterial({ map: tex }), 0.13, 0.18, 0.318, 0, 0.4);
}

const DRESSERS = {
    rainbowShader,
    suits,
    costumes: cust => pick(COSTUMES)(cust),
    squidGame
};

// cust: the customer group (needs .head, .bodyMesh, .leftLeg, .rightLeg).
export function dressCustomer(cust, skin) {
    DRESSERS[skin]?.(cust);
}

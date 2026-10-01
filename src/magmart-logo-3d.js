import * as THREE from 'three';
import { MAGMART_LOGO } from './magmart-logo-data.js';

// Builds an extruded 3D MagMart logo from the traced vector data and mounts it
// on the face(s) of `parent` (a BoxGeometry mesh), sized to fit its face.
export function addMagMartLogo3D(parent, bothSides = true) {
    const p = parent.geometry?.parameters || {};
    const faceW = p.width || 3, faceH = p.height || 1, halfDepth = (p.depth || 0.1) / 2;
    const { w: W, h: H } = MAGMART_LOGO;

    const logoW = Math.min(faceW * 0.92, faceH * 0.94 * (W / H));
    const s = logoW / W;
    const toVec = ([x, y]) => new THREE.Vector2((x - W / 2) * s, (H / 2 - y) * s);

    const toShapes = (list) => list.map(({ outer, holes }) => {
        const shape = new THREE.Shape(outer.map(toVec));
        holes.forEach(h => shape.holes.push(new THREE.Path(h.map(toVec))));
        return shape;
    });

    const extrude = (list, depth, bevel) => {
        const geo = new THREE.ExtrudeGeometry(toShapes(list), {
            depth,
            bevelEnabled: true,
            bevelThickness: bevel,
            bevelSize: bevel * 0.6,
            bevelOffset: 0,
            bevelSegments: 3,
            curveSegments: 1
        });
        geo.computeVertexNormals();
        return geo;
    };

    // [face material, side material]
    const mats = (face, side, emissive, ei) => [
        new THREE.MeshStandardMaterial({ color: face, emissive, emissiveIntensity: ei, roughness: 0.35, metalness: 0.15 }),
        new THREE.MeshStandardMaterial({ color: side, roughness: 0.5, metalness: 0.4 })
    ];

    const letterDepth = 0.16;
    const parts = [
        { geo: extrude(MAGMART_LOGO.yellow, letterDepth, 0.025), mat: mats(0xEEB201, 0xB98600, 0xEEB201, 0.35) },
        { geo: extrude(MAGMART_LOGO.mag, letterDepth, 0.025), mat: mats(0x9C9C9E, 0x6E6E72, 0x9C9C9E, 0.18) },
        { geo: extrude(MAGMART_LOGO.products, letterDepth * 0.55, 0.015), mat: mats(0x242324, 0x151415, 0x000000, 0) }
    ];

    // Soft white halo behind the letters, matching the glow in the artwork.
    const halo = makeHalo(logoW, logoW * H / W);

    const buildFace = () => {
        const g = new THREE.Group();
        parts.forEach(({ geo, mat }) => {
            const m = new THREE.Mesh(geo, mat);
            m.castShadow = true;
            g.add(m);
        });
        const haloMesh = new THREE.Mesh(halo.geo, halo.mat);
        haloMesh.position.z = -0.02; // sits just above the sign face, behind the letters
        g.add(haloMesh);
        return g;
    };

    const front = buildFace();
    front.position.z = halfDepth + 0.03; // clear of the back bevel
    parent.add(front);

    if (bothSides) {
        const back = buildFace();
        back.position.z = -halfDepth - 0.03;
        back.rotation.y = Math.PI;
        parent.add(back);
    }
}

function makeHalo(w, h) {
    const { w: W, h: H } = MAGMART_LOGO;
    const pad = 12, k = 2;
    const c = document.createElement('canvas');
    c.width = (W + pad * 2) * k;
    c.height = (H + pad * 2) * k;
    const ctx = c.getContext('2d');
    ctx.setTransform(k, 0, 0, k, pad * k, pad * k);

    const path = new Path2D();
    [...MAGMART_LOGO.yellow, ...MAGMART_LOGO.mag, ...MAGMART_LOGO.products].forEach(({ outer }) => {
        outer.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
        path.closePath();
    });

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineJoin = 'round';
    ctx.filter = 'blur(7px)';
    ctx.lineWidth = 10;
    ctx.stroke(path);
    ctx.fill(path);
    ctx.filter = 'blur(2px)';
    ctx.lineWidth = 5;
    ctx.stroke(path);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sx = w / W;
    return {
        geo: new THREE.PlaneGeometry((W + pad * 2) * sx, (H + pad * 2) * sx),
        mat: new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
            toneMapped: false
        })
    };
}

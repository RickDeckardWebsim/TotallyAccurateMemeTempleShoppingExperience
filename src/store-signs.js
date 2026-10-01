import * as THREE from 'three';
import { DEPARTMENTS, describeStoreAisles } from './store-layout.js';

// Static, shared geometry/materials per layout; no lights, shadows, physics or
// animation. Each aisle uses one small texture shared by both end signs.
export function addStoreWayfinding(scene, shelfUnits, ceilingHeight, registerCullable) {
    const aisles = describeStoreAisles(shelfUnits.map(u => u.userData));
    const panelGeo = new THREE.BoxGeometry(3.2, 0.9, 0.06);
    const faceGeo = new THREE.PlaneGeometry(3.12, 0.82);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x252c30, roughness: 0.8 });
    const signY = 4.25, rodH = ceilingHeight - signY - 0.45;
    const rodGeo = new THREE.CylinderGeometry(0.012, 0.012, rodH, 4);
    const stripGeo = new THREE.BoxGeometry(1, 0.1, 0.025);
    const floorGeo = new THREE.PlaneGeometry(3.2, 0.14);
    const accents = new Map(DEPARTMENTS.map(d => [d.color, new THREE.MeshBasicMaterial({ color: d.color })]));
    const aisleByNumber = new Map(aisles.map(info => [info.aisle, info]));

    shelfUnits.forEach(unit => {
        const info = aisleByNumber.get(unit.userData.aisle);
        if (!info) return;
        const strip = new THREE.Mesh(stripGeo, accents.get(info.color));
        strip.scale.x = unit.userData.width - 0.3;
        // Don't cover the existing freezer lightbox lettering.
        const stripY = unit.userData.isFreezer ? -unit.userData.height / 2 + 0.1 : unit.userData.height / 2 - 0.19;
        strip.position.set(0, stripY, unit.userData.direction * (unit.userData.depth / 2 + 0.04));
        unit.add(strip);
    });

    aisles.forEach(info => {
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 160;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = info.color; ctx.fillRect(0, 0, 512, 160);
        ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = 'bold 44px Arial'; ctx.fillText(`AISLE ${info.aisle}`, 256, 43);
        ctx.font = 'bold 28px Arial'; ctx.fillText(info.label, 256, 96, 475);
        ctx.font = '18px Arial'; ctx.fillText('MIXED STOCK - CHECK EVERY TIER', 256, 138, 475);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const faceMat = new THREE.MeshBasicMaterial({ map: texture });
        const floorMat = new THREE.MeshBasicMaterial({ color: info.color });
        info.ends.forEach(z => {
            const sign = new THREE.Group();
            sign.add(new THREE.Mesh(panelGeo, frameMat));
            for (const side of [-1, 1]) {
                const face = new THREE.Mesh(faceGeo, faceMat);
                face.position.z = side * 0.035;
                if (side === -1) face.rotation.y = Math.PI;
                sign.add(face);
                const rod = new THREE.Mesh(rodGeo, frameMat);
                rod.position.set(side * 1.15, 0.45 + rodH / 2, 0);
                sign.add(rod);
            }
            sign.position.set(info.x, signY, z);
            scene.add(sign); registerCullable(sign, 3.5);
            const threshold = new THREE.Mesh(floorGeo, floorMat);
            threshold.rotation.x = -Math.PI / 2;
            threshold.position.set(info.x, 0.018, z);
            scene.add(threshold); registerCullable(threshold, 2);
        });
    });

    // Entrance directory lists only departments/aisles actually present.
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#202c30'; ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 34px Arial'; ctx.fillText('MAGMART DIRECTORY', 24, 54);
    ctx.font = '22px Arial'; ctx.fillStyle = '#b7c3c7'; ctx.fillText('Section hints - stock stays mixed', 24, 88);
    aisles.forEach((info, i) => {
        const y = 130 + i * 57;
        ctx.fillStyle = info.color; ctx.fillRect(24, y - 18, 8, 36);
        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 24px Arial';
        ctx.fillText(`${info.aisle}  ${info.label}`, 44, y + 7, 442);
    });
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
    board.rotation.y = Math.PI;
    board.position.set(-8, 2.9, -29.55);
    scene.add(board); registerCullable(board, 3);
}

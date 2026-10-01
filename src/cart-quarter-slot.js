import * as THREE from 'three';

// Custom-game marker: a small coin lock attached to the right of the handle.
// Kept separate from skin decoration so changing skins preserves it.
export function buildCartQuarterSlot() {
    const group = new THREE.Group();
    group.name = 'cartQuarterSlot';
    group.position.set(0.27, 1.015, -0.735);
    const housing = new THREE.MeshStandardMaterial({ color: 0xe8b640, roughness: 0.45, metalness: 0.25 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xb8bec5, roughness: 0.35, metalness: 0.8 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x15191e, roughness: 0.8 });
    const add = (geometry, material, x, y, z) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        mesh.raycast = () => {};
        group.add(mesh);
        return mesh;
    };

    add(new THREE.BoxGeometry(0.14, 0.105, 0.17), housing, 0, 0, 0);
    // Handle clamp and the recessed coin slot facing the shopper.
    add(new THREE.BoxGeometry(0.07, 0.055, 0.065), steel, 0, -0.045, 0.015);
    add(new THREE.BoxGeometry(0.105, 0.04, 0.005), steel, 0, 0.009, -0.087);
    add(new THREE.BoxGeometry(0.077, 0.009, 0.006), dark, 0, 0.009, -0.09);

    const label = document.createElement('canvas');
    label.width = 128;
    label.height = 64;
    const ctx = label.getContext('2d');
    ctx.fillStyle = '#e8b640';
    ctx.fillRect(0, 0, 128, 64);
    ctx.fillStyle = '#20252b';
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('25¢', 64, 34);
    const texture = new THREE.CanvasTexture(label);
    texture.colorSpace = THREE.SRGBColorSpace;
    const badge = add(new THREE.PlaneGeometry(0.108, 0.054),
        new THREE.MeshBasicMaterial({ map: texture }), 0, 0.053, 0);
    badge.rotation.x = -Math.PI / 2;
    badge.rotation.z = Math.PI;

    // Short dangling return chain, purely decorative.
    const link = new THREE.TorusGeometry(0.012, 0.003, 4, 8);
    for (let i = 0; i < 4; i++) {
        const mesh = add(link, steel, 0.077 + i * 0.005, -0.016 - i * 0.019, 0.01);
        mesh.rotation.y = i % 2 ? Math.PI / 2 : 0;
    }
    return group;
}

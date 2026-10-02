import * as THREE from 'three';

// Entirely cosmetic: one opaque, unshadowed draw per fixture, one shared 1024 x
// 512 atlas. No game RNG, price-book calls, collision bodies, interaction cache
// entries, per-frame work, or changes to stock. Labels stay like real shelf tags
// when a product is taken/restocked. Printed prices are explicitly guide prices.
const GUIDE_PRICES = {
    'Milk': 2.99, 'Bread': 2.49, 'Eggs': 3.49, 'Cereal': 4.99,
    'Apples': 1.29, 'Bananas': 0.79, 'Cleaning Supplies': 5.49,
    'Soda': 1.49, 'Pasta': 1.99, 'Pasta Sauce': 3.29,
    'Water bottles': 3.99, 'Sugar': 2.19, 'Towels': 2.99,
    'Peanut Butter': 3.99, 'Steak': 12.99, 'Chicken': 8.99,
    'Potatoes': 3.49, 'Canned Goods': 1.49, 'Gum': 1.29,
    '2 in 1 Item': 0.50, 'Toilet paper': 2.50, 'Ice Cream': 2.50,
    'Shampoo': 2.50, 'Orange Juice': 2.50, 'Lettuce': 2.50,
    'Grapes': 2.50, 'Cooking oil': 2.50, 'Pizza': 2.50,
    'Ketchup': 2.50, 'Mustard': 2.50, 'Batteries': 2.50,
    'Dog food': 2.50, 'Cheese': 2.50, 'Pants': 2.50, 'Toys': 2.50,
    'Chocolate bars': 2.50, 'Watermelon': 2.50, 'Flowers': 2.50,
    'Coffee': 2.50
};
const COLS = 8, TILE_W = 128, TILE_H = 64;
let assets = null;
const liveDetails = new Set();
const fixturePool = [];
const noRaycast = () => {};

function getAssets() {
    if (assets) return assets;
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 512;
    const ctx = canvas.getContext('2d');
    const tiles = new Map();
    function tile(key, paint) {
        const index = tiles.size;
        tiles.set(key, index);
        ctx.save();
        ctx.translate((index % COLS) * TILE_W, Math.floor(index / COLS) * TILE_H);
        ctx.beginPath(); ctx.rect(0, 0, TILE_W, TILE_H); ctx.clip();
        paint(ctx, index);
        ctx.restore();
    }
    for (const [name, price] of Object.entries(GUIDE_PRICES)) {
        tile(name, (c, index) => {
            c.fillStyle = '#f7f3e4'; c.fillRect(0, 0, 128, 64);
            c.fillStyle = index % 5 === 0 ? '#ead04c' : '#dde4da';
            c.fillRect(3, 3, 122, 11);
            c.fillStyle = '#283d32'; c.font = 'bold 8px Arial';
            c.fillText(index % 5 === 0 ? 'VALUE  •  GUIDE PRICE' : 'MAGMART  •  GUIDE PRICE', 6, 11, 116);
            c.fillStyle = '#242824'; c.font = 'bold 10px Arial';
            c.fillText(name.toUpperCase(), 6, 26, 116);
            c.font = 'bold 28px Arial'; c.fillText('$' + price.toFixed(2), 5, 53, 84);
            // Printed barcode/SKU, not an interactive scanner target.
            for (let bar = 0; bar < 12; bar++) {
                if ((bar * 7 + index * 3) % 5 !== 0) c.fillRect(94 + bar * 2, 32, 1 + (bar % 2), 16);
            }
            c.font = '7px monospace'; c.fillText(String(14000 + index), 93, 57);
        });
    }
    tile('rail', c => {
        c.fillStyle = '#9babb2'; c.fillRect(0, 0, 128, 64);
        c.fillStyle = '#d0d9da'; c.fillRect(0, 3, 128, 6);
        c.fillStyle = '#66767d'; c.fillRect(0, 51, 128, 10);
        c.fillStyle = '#bcc6c8';
        for (let y = 14; y < 50; y += 5) c.fillRect(0, y, 128, 1);
    });
    tile('standard', c => {
        c.fillStyle = '#909a98'; c.fillRect(0, 0, 128, 64);
        c.fillStyle = '#c6cfcb'; c.fillRect(8, 0, 12, 64);
        c.fillStyle = '#333f3b';
        for (let y = 3; y < 64; y += 9) c.fillRect(47, y, 34, 5);
    });
    tile('screw', c => {
        c.fillStyle = '#686e6b'; c.fillRect(0, 0, 128, 64);
        c.fillStyle = '#b8c2bd'; c.beginPath(); c.arc(64, 32, 27, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#48534d'; c.fillRect(47, 29, 34, 6); c.fillRect(61, 15, 6, 34);
    });
    tile('kickplate', c => {
        c.fillStyle = '#535c58'; c.fillRect(0, 0, 128, 64);
        c.fillStyle = '#69736d'; c.fillRect(0, 4, 128, 4);
        c.fillStyle = '#414a43';
        for (let i = 0; i < 16; i++) c.fillRect((i * 37) % 121, 23 + (i * 11) % 32, 5 + i % 8, 1);
    });
    tile('fixture', c => {
        c.fillStyle = '#deddd3'; c.fillRect(0, 0, 128, 64);
        c.fillStyle = '#344138'; c.font = 'bold 16px Arial'; c.fillText('MAGMART', 7, 20);
        c.font = '10px monospace'; c.fillText('FIXTURE • MM-0142', 7, 35);
        c.font = '9px Arial'; c.fillText('KEEP AISLES CLEAR', 7, 51);
    });
    tile('cold-care', c => {
        c.fillStyle = '#e1eff2'; c.fillRect(0, 0, 128, 64);
        c.fillStyle = '#164c69'; c.font = 'bold 14px Arial'; c.fillText('KEEP FROZEN', 7, 20);
        c.font = '10px Arial'; c.fillText('CLOSE DOORS AFTER USE', 7, 37);
        c.font = '9px monospace'; c.fillText('SERVICE CHECKED  [OK]', 7, 53);
    });
    tile('wood', c => {
        c.fillStyle = '#896245'; c.fillRect(0, 0, 128, 64);
        for (let i = 0; i < 28; i++) {
            c.fillStyle = i % 3 ? '#805b40' : '#916b4c';
            c.fillRect((i * 17) % 127, 0, 1 + i % 3, 64);
        }
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshLambertMaterial({ map: texture });
    assets = { tiles, material };
    // Three's object constructors generate UUIDs with Math.random. Warm a
    // bounded pool before any run starts, not between item/door/event rolls.
    // There are at most 16 fixture bays in the existing layout planner.
    for (let i = 0; i < 16; i++) {
        const detail = new THREE.Mesh(new THREE.BufferGeometry(), material);
        detail.name = 'shelf-cosmetic-details';
        detail.raycast = noRaycast;
        fixturePool.push(detail);
    }
    return assets;
}

export function addShelfDetails(unit, tierPositionsY, boardThickness, boardWidth, boardDepth, boardCenterZ) {
    const { width, height, depth, direction, isFreezer, tierStock, tierPools } = unit.userData;
    const { tiles } = getAssets();
    const detail = fixturePool.find(mesh => !liveDetails.has(mesh));
    if (!detail) return null; // Unexpected extra fixtures stay gameplay-identical.
    const positions = [], normals = [], uvs = [], indices = [];
    // All surfaces face the opening. Reverse vertex order, not UVs, on the -Z
    // fixtures so print reads correctly from either aisle-facing direction.
    function face(key, x, y, z, w, h) {
        const index = tiles.get(key) ?? tiles.get('fixture');
        const col = index % COLS, row = Math.floor(index / COLS);
        const u0 = (col * TILE_W + 1) / 1024, u1 = ((col + 1) * TILE_W - 1) / 1024;
        const v0 = 1 - ((row + 1) * TILE_H - 1) / 512, v1 = 1 - (row * TILE_H + 1) / 512;
        const start = positions.length / 3;
        positions.push(x - direction * w / 2, y - h / 2, z, x + direction * w / 2, y - h / 2, z,
            x + direction * w / 2, y + h / 2, z, x - direction * w / 2, y + h / 2, z);
        for (let i = 0; i < 4; i++) normals.push(0, 0, direction);
        uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }

    const frontZ = boardCenterZ + direction * (boardDepth / 2 + 0.013);
    tierPositionsY.forEach((tierY, tier) => {
        // Lower shelf-edge ticket channel; never intrudes into item clearance.
        face('rail', 0, tierY + boardThickness / 2 - 0.07, frontZ, boardWidth, 0.13);
        const stock = tierStock?.[tier] || tierPools?.[tier] || [];
        const count = Math.min(tierStock?.[tier]?.length ?? 3, Math.floor((width - 1.2) / 1.1));
        const spacing = (width - 1.4) / (count + 1);
        for (let slot = 0; slot < count; slot++) {
            const item = stock[slot % stock.length];
            if (!item) continue;
            const x = -width / 2 + 0.7 + (slot + 1) * spacing;
            face(item.name, x, tierY + boardThickness / 2 - 0.125,
                frontZ + direction * 0.006, Math.min(0.76, spacing * 0.8), 0.21);
        }
    });

    // Slot-punched shelf standards printed onto the rear, with visible little
    // mounting screws on the existing front edges. No hundreds of hole meshes.
    const backThickness = isFreezer ? 0.08 : 0.06;
    const rearFaceZ = direction * (-depth / 2 + backThickness + 0.026);
    const backH = height - (isFreezer ? 0.28 + 0.32 : 0.22 + 0.12) - 0.02;
    const backY = isFreezer ? -0.02 : 0.05;
    if (!isFreezer) {
        face('wood', 0, backY, rearFaceZ - direction * 0.002, boardWidth, backH);
    }
    for (const side of [-1, 1]) {
        const standardX = side * (boardWidth / 2 - 0.08);
        // Repeated small sections keep the slot pattern at human scale.
        for (let i = 0; i < 12; i++) {
            face('standard', standardX, backY - backH / 2 + (i + 0.5) * backH / 12,
                rearFaceZ + direction * 0.003, 0.045, backH / 12);
        }
        for (const tierY of tierPositionsY) {
            face('screw', side * (width / 2 - (isFreezer ? 0.05 : 0.04)), tierY - 0.025,
                direction * (depth / 2 + 0.003), 0.036, 0.036);
        }
    }
    if (!isFreezer) {
        face('kickplate', 0, -height / 2 + 0.10, direction * (depth / 2 - 0.014), width - 0.15, 0.15);
    }
    // Small inspection/fixture plate on the plinth, not a new aisle sign.
    face(isFreezer ? 'cold-care' : 'fixture', -width / 2 + 0.46, -height / 2 + 0.105,
        direction * (depth / 2 + 0.005), 0.52, 0.16);

    const geometry = detail.geometry;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.setDrawRange(0, indices.length);
    geometry.computeBoundingSphere();
    unit.add(detail);
    liveDetails.add(detail);
    return detail;
}

export function clearShelfDetails() {
    for (const detail of liveDetails) {
        detail.removeFromParent();
        detail.geometry.dispose();
    }
    liveDetails.clear();
    // Keep the single small atlas/material reusable across layouts and runs.
}

// Module initialization happens in the loading/menu phase, before run RNG.
getAssets();

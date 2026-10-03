import { buildNavGrid, worldToCell, clampToWalkable } from './pathfinding.js';

// Randomized fixture bays keep a believable shop footprint, but no permanent
// straight shelf runs or entrance-facing rule. Stock stays independent/mixed.
export const SHELF_WIDTH = 7;
export const DEPARTMENTS = [
    { id: 'cold', name: 'Cold & Frozen', short: 'Cold', color: '#246d99', items: ['Milk', 'Eggs', 'Steak', 'Chicken', 'Ice Cream', 'Cheese', 'Pizza', 'Orange Juice'] },
    { id: 'fresh', name: 'Produce & Bakery', short: 'Fresh', color: '#397448', items: ['Apples', 'Bananas', 'Potatoes', 'Bread', 'Lettuce', 'Grapes', 'Watermelon'] },
    { id: 'pantry', name: 'Pantry & Drinks', short: 'Pantry', color: '#a76b27', items: ['Cereal', 'Pasta', 'Pasta Sauce', 'Sugar', 'Peanut Butter', 'Canned Goods', 'Soda', 'Water bottles', 'Cooking oil', 'Ketchup', 'Mustard', 'Chocolate bars', 'Coffee'] },
    { id: 'home', name: 'Home & Essentials', short: 'Home', color: '#77548e', items: ['Cleaning Supplies', 'Towels', 'Toilet paper', 'Shampoo', 'Batteries', 'Dog food', 'Pants', 'Toys', 'Flowers'] }
];
const DEPARTMENT_BY_NAME = new Map(DEPARTMENTS.flatMap(d => d.items.map(name => [name, d.id])));
export function departmentForItem(name) { return DEPARTMENT_BY_NAME.get(name) || 'pantry'; }
// Preserve the original, batch-specific bottom -> top item pools exactly.
const BASE_TIER_NAMES = [
    ['Apples', 'Bananas', 'Potatoes', 'Sugar', 'Bread', 'Pasta', 'Pasta Sauce'],
    ['Milk', 'Eggs', 'Peanut Butter', 'Steak', 'Chicken'],
    ['Cereal', 'Canned Goods', 'Pasta', 'Pasta Sauce'],
    ['Soda', 'Cleaning Supplies', 'Water bottles', 'Towels']
];
const ALT_TIER_NAMES = [
    ['Ice Cream', 'Orange Juice', 'Lettuce', 'Grapes', 'Watermelon', 'Cheese'],
    ['Toilet paper', 'Cooking oil', 'Pizza', 'Dog food', 'Coffee', 'Batteries', 'Pasta Sauce'],
    ['Ketchup', 'Mustard', 'Chocolate bars', 'Toys', 'Pasta Sauce'],
    ['Shampoo', 'Pants', 'Flowers']
];
export function getShelfTierPools(items, usingAltItems = false) {
    return (usingAltItems ? ALT_TIER_NAMES : BASE_TIER_NAMES).map(names => {
        const pool = items.filter(item => names.includes(item.name));
        return pool.length ? pool : items;
    });
}
function dominantDepartment(tiers, random) {
    const counts = new Map(DEPARTMENTS.map(d => [d.id, 0]));
    tiers.flat().forEach(item => { const id = departmentForItem(item.name); counts.set(id, counts.get(id) + 1); });
    const high = Math.max(...counts.values());
    const ties = DEPARTMENTS.filter(d => counts.get(d.id) === high);
    return ties[Math.floor(random() * ties.length)].id;
}

const SECTIONS = [
    { aisle: 1, side: -1, rear: false, laneX: -16, ends: [-17.8] },
    { aisle: 2, side: 1, rear: false, laneX: 16, ends: [-17.8] },
    { aisle: 3, side: -1, rear: true, laneX: -16, ends: [7.3, 27.5] },
    { aisle: 4, side: 1, rear: true, laneX: 16, ends: [7.3, 27.5] }
];
function shuffled(values, random) {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}
function rollBays(random, fallback = false) {
    return SECTIONS.flatMap(section => {
        const rows = section.rear ? [12.4, 22.6] : [-8, 2.2];
        const columns = fallback ? [13, 23] : [section.rear ? 10.5 : 8.5, 22];
        return columns.flatMap(x => rows.map(z => {
            // All four compass-facing combinations are independent of spawn.
            const rot = !fallback && random() < 0.5 ? 0 : Math.PI / 2;
            const dir = random() < 0.5 ? -1 : 1;
            // More lateral wandering on a fixture's thin axis. Keep its long
            // axis clear of adjacent bays instead of lining every front up.
            const px = x + (fallback ? 0 : (random() - 0.5) * (rot === 0 ? 1.2 : 3));
            let pz = z + (fallback ? 0 : (random() - 0.5) * (rot === 0 ? 3 : 0.8));
            if (section.rear && z > 20 && rot === 0 && dir === 1) pz = Math.min(pz, 23);
            return { x: section.side * px, z: pz, rot, dir,
                aisle: section.aisle, laneX: section.laneX };
        }));
    });
}

// One startup-only flood fill against the same conservative grid used by NPCs.
// Also used when placing event fixtures: harder routes must not seal products,
// carts, checkout or the info desk behind a shelf/construction dead end.
export function shelfFrontsReachable(shelfUnits, constructionZones = [], sampleBooths = []) {
    const grid = buildNavGrid({ shelfUnits, constructionZones, sampleBooths, computeClearance: false });
    const start = worldToCell(grid, -3, -23);
    const first = start.r * grid.cols + start.c;
    if (!grid.walkable[first]) return false;
    const seen = new Uint8Array(grid.walkable.length);
    const queue = new Int32Array(grid.walkable.length);
    let head = 0, tail = 1;
    queue[0] = first; seen[first] = 1;
    const visit = next => {
        if (next < 0 || next >= seen.length || seen[next] || !grid.walkable[next]) return;
        seen[next] = 1; queue[tail++] = next;
    };
    while (head < tail) {
        const cell = queue[head++], col = cell % grid.cols;
        if (col > 0) visit(cell - 1);
        if (col + 1 < grid.cols) visit(cell + 1);
        visit(cell - grid.cols); visit(cell + grid.cols);
    }
    const reached = (x, z) => {
        const cell = worldToCell(grid, x, z);
        return !!seen[cell.r * grid.cols + cell.c];
    };
    for (const [x, z] of [[0, 0], [0, 20], [10.5, -17.2], [-18, -20]]) {
        if (!reached(x, z)) return false;
    }
    for (const unit of shelfUnits) {
        const rot = unit.userData?.rotY || unit.rotation?.y || 0;
        const direction = unit.userData?.direction || 1;
        const c = Math.cos(rot), s = Math.sin(rot);
        for (const along of [-2, 0, 2]) {
            for (const distance of [2.2, 3.3]) {
                const x = unit.position.x + along * c + direction * distance * s;
                const z = unit.position.z - along * s + direction * distance * c;
                // NPC targets already use this same cell-edge clamp. Permit
                // only a small adjustment, never a jump behind another fixture.
                const target = clampToWalkable(grid, x, z);
                if (Math.hypot(target.x - x, target.z - z) > 0.8 || !reached(target.x, target.z)) return false;
            }
        }
    }
    return true;
}

function stockBays(bays, stock, affinities, random) {
    const available = shuffled(bays, random), positions = [];
    for (const shelfStock of stock) {
        const preferred = available.filter(bay => affinities.get(shelfStock.department) === bay.aisle);
        // Soft section affinity, not a sorted store. Even frozen storage can
        // overflow, and every fixture still has its original mixed tier stock.
        const pool = preferred.length && random() < (shelfStock.isFreezer ? 0.8 : 0.55)
            ? preferred : available;
        const bay = pool[Math.floor(random() * pool.length)];
        available.splice(available.indexOf(bay), 1);
        positions.push({ ...bay, ...shelfStock });
    }
    return positions;
}
const unitsForPlan = positions => positions.map(p => ({
    position: { x: p.x, z: p.z },
    userData: { rotY: p.rot, direction: p.dir, width: SHELF_WIDTH, depth: 1.6 }
}));

export function planStoreShelves(total, items, freezerChance, random = Math.random, usingAltItems = false) {
    const count = Math.max(0, Math.min(14, Math.floor(total) || 0));
    // Preserve the per-fixture freezer roll, including custom 0% / 100% games.
    const freezerRolls = Array.from({ length: count }, () => random() * 100 < freezerChance);
    const tierPools = getShelfTierPools(items, usingAltItems);
    const stock = freezerRolls.map(isFreezer => {
        const tiers = tierPools.map(pool => {
            const amount = Math.floor(random() * 3) + 3;
            return Array.from({ length: amount }, () => pool[Math.floor(random() * pool.length)]);
        });
        return { isFreezer, tierPools, tiers, department: isFreezer ? 'cold' : dominantDepartment(tiers, random) };
    });
    const affinities = new Map(shuffled(DEPARTMENTS, random).map((d, i) => [d.id, i + 1]));
    const stockOrder = shuffled(stock, random).sort((a, b) => Number(b.isFreezer) - Number(a.isFreezer));
    // Bounded generation, no continuous physics/pathfinding work. Retry only
    // spatial choices: never reroll the already-selected stock or freezer count.
    for (let attempt = 0; attempt < 4; attempt++) {
        const positions = stockBays(rollBays(random), stockOrder, affinities, random);
        if (shelfFrontsReachable(unitsForPlan(positions))) return positions;
    }
    // A rare dense-roll safety layout still randomizes vacancies and facings.
    return stockBays(rollBays(random, true), stockOrder, affinities, random);
}

export function describeStoreAisles(positions) {
    const aisles = [];
    for (let aisle = 1; aisle <= 4; aisle++) {
        const bays = positions.filter(b => b.aisle === aisle);
        if (!bays.length) continue;
        const departments = DEPARTMENTS.filter(d => bays.some(b => b.department === d.id));
        const dominant = [...departments].sort((a, b) => bays.filter(p => p.department === b.id).length - bays.filter(p => p.department === a.id).length)[0];
        const section = SECTIONS.find(s => s.aisle === aisle);
        aisles.push({ aisle, x: section.laneX, departments,
            ends: section.ends, label: dominant.name, color: dominant.color
        });
    }
    return aisles;
}

// Keep only the main spine, lobby, perimeter and rear landmark reserved. Side
// cross-routes now vary with the roll; event fixtures get a reachability check.
export function blocksStoreRoute(x, z, halfSize) {
    return Math.abs(x) < 2.8 + halfSize || z < -18 + halfSize ||
        Math.abs(x) > 27 - halfSize || Math.abs(z) > 27 - halfSize ||
        Math.hypot(x, z - 20) < 6 + halfSize;
}

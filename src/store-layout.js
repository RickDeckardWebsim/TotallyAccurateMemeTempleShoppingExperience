// Fixtures have safe bays, but stock stays independent and mixed. Department
// placement is a hint based on rolled contents, never an inventory restriction.
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

const RUNS = [
    { x: -23, dir: 1, department: 'cold', laneX: -19 },
    { x: -13, dir: 1, department: 'fresh', laneX: -9 },
    { x: 13, dir: -1, department: 'pantry', laneX: 9 },
    { x: 23, dir: -1, department: 'home', laneX: 19 }
];
// No perpendicular rear endcaps cutting into the numbered aisles. Slightly
// shorter bays retain 3-5 items/tier and leave three-metre cross aisles.
const BAYS = RUNS.flatMap((run, aisle) => [1, 11, -9, 21].map(z => ({
    x: run.x, z, dir: run.dir, rot: Math.PI / 2,
    department: run.department, aisle: aisle + 1, laneX: run.laneX
})));

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
    const unused = new Set(BAYS);
    const anchors = new Map(DEPARTMENTS.filter(d => stock.some(s => s.department === d.id)).map(d => [d.id, BAYS.find(b => b.department === d.id)]));
    const positions = [];
    for (const d of DEPARTMENTS) {
        const anchor = anchors.get(d.id);
        if (!anchor) continue;
        const preferred = BAYS.filter(b => b.department === d.id);
        if (random() < 0.5) [preferred[1], preferred[2]] = [preferred[2], preferred[1]];
        const overflow = BAYS.filter(b => b.department !== d.id).sort((a, b) =>
            Math.hypot(a.x - anchor.x, a.z - anchor.z) - Math.hypot(b.x - anchor.x, b.z - anchor.z));
        const eligible = [...preferred, ...overflow].filter(b =>
            ![...anchors].some(([id, reserved]) => id !== d.id && b === reserved));
        for (const shelfStock of stock.filter(s => s.department === d.id)) {
            const bay = eligible.find(b => unused.has(b));
            if (!bay) break;
            unused.delete(bay);
            positions.push({ ...bay, ...shelfStock });
        }
    }
    return positions;
}

export function describeStoreAisles(positions) {
    const aisles = [];
    for (let aisle = 1; aisle <= 4; aisle++) {
        const bays = positions.filter(b => b.aisle === aisle);
        if (!bays.length) continue;
        const departments = DEPARTMENTS.filter(d => bays.some(b => b.department === d.id));
        const dominant = [...departments].sort((a, b) => bays.filter(p => p.department === b.id).length - bays.filter(p => p.department === a.id).length)[0];
        aisles.push({ aisle, x: bays[0].laneX, departments,
            ends: [-14.5, 26], label: dominant.name, color: dominant.color
        });
    }
    return aisles;
}

// Keep the main spine, cross aisles, lobby and rear event landmark open.
// Side pockets remain available to random samples and construction events.
export function blocksStoreRoute(x, z, halfSize) {
    return Math.abs(x) < 2.8 + halfSize || z < -18 + halfSize ||
        Math.abs(x) > 27 - halfSize || Math.abs(z) > 27 - halfSize ||
        [-14, -4, 6, 16, 26].some(cross => Math.abs(z - cross) < 1.2 + halfSize) ||
        Math.hypot(x, z - 20) < 6 + halfSize;
}

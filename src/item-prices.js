// One catalog for checkout and the shared shelf-ticket atlas.
export const ITEM_BASE_PRICES = Object.freeze({
    'Milk': 2.99, 'Bread': 2.49, 'Eggs': 3.49, 'Cereal': 4.99,
    'Apples': 1.29, 'Bananas': 0.79, 'Cleaning Supplies': 5.49,
    'Soda': 1.49, 'Pasta': 1.99, 'Pasta Sauce': 3.29,
    'Water bottles': 3.99, 'Sugar': 2.19, 'Towels': 2.99,
    'Peanut Butter': 3.99, 'Steak': 12.99, 'Chicken': 8.99,
    'Potatoes': 3.49, 'Canned Goods': 1.49, 'Gum': 1.29,
    '2 in 1 Item': 0, 'Toilet paper': 2.50, 'Ice Cream': 2.50,
    'Shampoo': 2.50, 'Orange Juice': 2.50, 'Lettuce': 2.50,
    'Grapes': 2.50, 'Cooking oil': 2.50, 'Pizza': 2.50,
    'Ketchup': 2.50, 'Mustard': 2.50, 'Batteries': 2.50,
    'Dog food': 2.50, 'Cheese': 2.50, 'Pants': 2.50, 'Toys': 2.50,
    'Chocolate bars': 2.50, 'Watermelon': 2.50, 'Flowers': 2.50,
    'Coffee': 2.50
});

// Preserve the +/-10% variation and $0.50 floor, independently of gameplay
// RNG and lookup order. Round the unit price before multiplying quantities.
export function itemPriceForRun(name, runId = '') {
    let hash = 2166136261;
    for (const ch of `${runId}|${name}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
    hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d);
    hash ^= hash >>> 15; hash = Math.imul(hash, 0x846ca68b); hash ^= hash >>> 16;
    const variation = 0.9 + (hash >>> 0) / 4294967296 * 0.2;
    return Math.round(Math.max(0.5, (ITEM_BASE_PRICES[name] ?? 2.5) * variation) * 100) / 100;
}

// Checkout uses the actual cart, not possibly stale list tick marks. Preserve
// the existing two-in-one bonus and explicit sold-out exemptions.
export function shoppingProgress(list, inventory, soldOut = []) {
    const counts = new Map();
    if (inventory) for (const item of new Set(inventory)) {
        if (!item?.inCart || item.stolen || item.inCustomerCart || item.isCustomerHeld) continue;
        const names = item.isTwoInOne ? item.twoInOneTargets || [] : [item.name];
        for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
    }
    let totalRequired = 0, totalCollected = 0;
    const rows = (list || []).map(row => {
        const quantity = Math.max(1, Math.floor(Number(row.quantity) || 1));
        const collected = Math.min(quantity, inventory ? counts.get(row.name) || 0 : Math.max(0, Number(row.collected) || 0));
        const required = soldOut.includes(row.name) ? collected : quantity;
        totalRequired += required; totalCollected += collected;
        return { name: row.name, collected, required, missing: Math.max(0, required - collected) };
    });
    const missingItems = Math.max(0, totalRequired - totalCollected);
    return { rows, totalRequired, totalCollected, missingItems,
        completionPercent: totalRequired ? Math.round(totalCollected / totalRequired * 100) : 100 };
}

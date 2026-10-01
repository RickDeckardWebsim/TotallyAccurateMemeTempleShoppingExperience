const STORAGE_KEY = 'magmartShop';

const WHEEL = (cx, cy, r, rim = '#c7ccd3') =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#15171b"/><circle cx="${cx}" cy="${cy}" r="${r * 0.45}" fill="${rim}"/>`;
const SHADOW = '<ellipse cx="50" cy="76" rx="42" ry="4" fill="#0f172a" opacity=".16"/>';

const CART_PATHS = `<path d="M10 24 H20 L28 60 H78"/><path d="M22 32 H88 L80 52 H26"/>
            <path d="M40 32 L42 52 M56 32 L56 52 M72 32 L69 52 M24 42 H84"/><path d="M32 60 L30 68 M74 60 L76 68"/>`;
const GEM = (x, y, s, r = 0) => `<path transform="translate(${x} ${y}) rotate(${r}) scale(${s})" d="M0 -6 L3 0 L0 6 L-3 0 Z" fill="#effcff" stroke="#6fd3f2" stroke-width=".6"/>`;

const PREVIEWS = {
    rainbowShader: `<svg viewBox="0 0 100 100">${SHADOW}
        <defs><linearGradient id="shopRainbowFabric" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#ff416c"/><stop offset=".2" stop-color="#ffb83e"/>
            <stop offset=".4" stop-color="#d3ef40"/><stop offset=".6" stop-color="#38dbbb"/>
            <stop offset=".8" stop-color="#5488ff"/><stop offset="1" stop-color="#cf55ec"/>
        </linearGradient></defs>
        ${[30, 70].map((x, i) => `<g transform="translate(${x} ${i * 3})">
            <g class="shop-rainbow-fabric" style="animation-delay: -${i * 2}s" fill="url(#shopRainbowFabric)">
                <rect x="-8" y="50" width="6" height="22" rx="2"/><rect x="2" y="50" width="6" height="22" rx="2"/>
                <rect x="-12" y="28" width="24" height="27" rx="7"/>
            </g>
            <circle cy="19" r="9" fill="#f4c9a8"/>
            <circle cx="-3" cy="18" r="1.4" fill="#1f2937"/><circle cx="3" cy="18" r="1.4" fill="#1f2937"/>
        </g>`).join('')}</svg>`,
    rainbow: `<svg viewBox="0 0 100 100">${SHADOW}
        ${[['#ee6689', 20], ['#ffc555', 40], ['#5dcab2', 60], ['#8e90ed', 80]].map(([c, x], i) => `
        <g transform="translate(${x} ${i % 2 ? 4 : 0})">
            <rect x="-6" y="50" width="4" height="20" rx="2" fill="#334155"/><rect x="2" y="50" width="4" height="20" rx="2" fill="#334155"/>
            <rect x="-9" y="32" width="18" height="22" rx="6" fill="${c}"/>
            <circle cy="24" r="8" fill="#f4c9a8"/>
            <circle cx="-3" cy="23" r="1.3" fill="#1f2937"/><circle cx="3" cy="23" r="1.3" fill="#1f2937"/>
        </g>`).join('')}</svg>`,
    goldenCart: `<svg viewBox="0 0 100 100">${SHADOW}
        <defs><linearGradient id="shopGold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#fff1a8"/><stop offset=".35" stop-color="#e9b52d"/>
            <stop offset=".55" stop-color="#a96e0a"/><stop offset=".75" stop-color="#ffdf69"/><stop offset="1" stop-color="#d09316"/>
        </linearGradient></defs>
        <g fill="none" stroke="url(#shopGold)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${CART_PATHS}</g>
        <circle cx="30" cy="70" r="5" fill="#3b2a05"/><circle cx="76" cy="70" r="5" fill="#3b2a05"/></svg>`,
    sedan: `<svg viewBox="0 0 100 100">${SHADOW}
        <path d="M5 67 V54 Q6 50 11 49 L29 47 L39 35 Q41 33 45 33 L63 33 Q67 33 69 36 L78 47 L92 49 Q96 50 96 55 V67 Z" fill="#1d3b6e"/>
        <path d="M42 46 L47 37 H55 V46 Z M58 46 V37 H63 Q65 37 66 39 L72 46 Z" fill="#bfe0f7"/>
        <rect x="5" y="58" width="91" height="2.5" fill="#cbd5e1"/>
        <rect x="91" y="51" width="5" height="3.5" rx="1" fill="#fff4bf"/>
        <rect x="5" y="51" width="3.5" height="4.5" rx="1" fill="#dc2626"/>
        ${WHEEL(26, 67, 9)}${WHEEL(76, 67, 9)}</svg>`,
    smart: `<svg viewBox="0 0 100 100">${SHADOW}
        <path d="M22 69 V44 Q22 23 40 21 H58 Q69 22 73 33 L80 50 Q82 54 82 58 V69 Z" fill="#84cc16"/>
        <path d="M22 69 V44 Q22 23 40 21 H58 Q69 22 73 33 L75 38 H26 V69 Z" fill="#1f2937"/>
        <path d="M29 42 L31 29 Q33 26 39 26 H57 Q63 27 66 33 L70 42 Z" fill="#bfe0f7"/>
        <rect x="46" y="24" width="5" height="45" fill="#1f2937"/>
        <rect x="22" y="62" width="60" height="4" fill="#1f2937"/>
        <rect x="78" y="48" width="4" height="4" rx="1" fill="#fff4bf"/>
        ${WHEEL(33, 69, 8)}${WHEEL(71, 69, 8)}</svg>`,
    lambo: `<svg viewBox="0 0 100 100">${SHADOW}
        <path d="M4 42 H20 V45 H4 Z M12 45 H15 V52 H12 Z" fill="#1f2937"/>
        <path d="M4 66 V53 L12 49 L38 44 Q49 34 60 34 L69 36 L97 57 V66 Z" fill="#ff6a00"/>
        <path d="M43 45 Q51 38 59 38 L67 39 L79 48 Z" fill="#1f2937" opacity=".85"/>
        <path d="M36 55 L50 50 L48 58 Z" fill="#1f2937"/>
        <path d="M84 55 L97 58" stroke="#fff4bf" stroke-width="2.5" stroke-linecap="round"/>
        <rect x="4" y="54" width="4" height="3" fill="#dc2626"/>
        ${WHEEL(24, 67, 9, '#fbbf24')}${WHEEL(80, 67, 9, '#fbbf24')}</svg>`,
    diamondCart: `<svg viewBox="0 0 100 100">${SHADOW}
        <defs><linearGradient id="shopDiamond" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#ffffff"/><stop offset=".3" stop-color="#9ee8ff"/>
            <stop offset=".55" stop-color="#5bb8d6"/><stop offset=".8" stop-color="#e6fbff"/><stop offset="1" stop-color="#8fd8ef"/>
        </linearGradient></defs>
        <g fill="none" stroke="url(#shopDiamond)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${CART_PATHS}</g>
        ${GEM(34, 28, 1.1, -20)}${GEM(62, 27, 1.3, 15)}${GEM(86, 30, 1, 30)}${GEM(50, 50, .9, -10)}${GEM(81, 50, 1, 25)}${GEM(18, 22, .8, -30)}
        <circle cx="30" cy="70" r="5" fill="#1e3a4a"/><circle cx="76" cy="70" r="5" fill="#1e3a4a"/></svg>`,
    racecarCart: `<svg viewBox="0 0 100 100">${SHADOW}
        <g fill="none" stroke="#e01414" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${CART_PATHS}</g>
        <path d="M24 42 H84" stroke="#fff" stroke-width="2.5"/>
        <path d="M6 14 H26 L24 19 H8 Z" fill="#e01414"/><path d="M12 19 V24 M20 19 V24" stroke="#151515" stroke-width="2.5"/>
        <path d="M30 55 L20 62 H40 Z M70 55 L84 62 H64 Z" fill="#e01414" stroke="#fff" stroke-width="1"/>
        <circle cx="56" cy="42" r="7" fill="#fff" stroke="#151515" stroke-width="1"/>
        <text x="56" y="45.5" font-size="10" font-weight="bold" text-anchor="middle" fill="#111" font-family="Arial">7</text>
        <circle cx="30" cy="70" r="5" fill="#151515"/><circle cx="76" cy="70" r="5" fill="#151515"/></svg>`,
    lowQualityCart: `<svg viewBox="0 0 100 100">${SHADOW}
        <rect x="24" y="34" width="60" height="24" fill="#9a9a9a" transform="rotate(3 54 46)"/>
        <rect x="80" y="30" width="6" height="30" fill="#ff0000"/>
        <rect x="10" y="22" width="18" height="6" fill="#ff0000" transform="rotate(-8 19 25)"/>
        <rect x="18" y="26" width="5" height="32" fill="#9a9a9a" transform="rotate(-18 20 42)"/>
        <rect x="26" y="60" width="54" height="4" fill="#000"/>
        <rect x="26" y="66" width="8" height="8" fill="#000"/><rect x="72" y="63" width="8" height="8" fill="#000" transform="rotate(20 76 67)"/>
        <path d="M60 12 L66 22 L55 20 Z" fill="#ff00ff"/></svg>`,
    boat: `<svg viewBox="0 0 100 100">${SHADOW}
        <path d="M4 44 L16 62 H84 L96 44 Z" fill="#8b5a2b"/>
        <path d="M9 51 H91 M12 56 H88" stroke="#5c3a1a" stroke-width="1.5"/>
        <rect x="3" y="42" width="94" height="4" rx="1" fill="#5c3a1a"/>
        <rect x="30" y="28" width="42" height="14" fill="#b07a3f"/>
        <path d="M26 29 L51 16 L76 29 Z" fill="#6b3f1d"/>
        <circle cx="40" cy="35" r="3" fill="#1f2937"/><circle cx="51" cy="35" r="3" fill="#1f2937"/><circle cx="62" cy="35" r="3" fill="#1f2937"/>
        <path d="M84 42 V20 H90 V24 H87 V42 Z" fill="#e8b04a"/><circle cx="85.5" cy="30" r="1" fill="#7a4b1a"/>
        <circle cx="16" cy="39" r="5" fill="#f5f5f0"/><circle cx="23" cy="40" r="4" fill="#f5f5f0"/>
        ${WHEEL(26, 67, 8)}${WHEEL(74, 67, 8)}</svg>`,
    suits: `<svg viewBox="0 0 100 100">${SHADOW}
        ${[['#1f2937', '#b91c1c', 30], ['#1e2a44', '#ca8a04', 70]].map(([suit, tie, x], i) => `
        <g transform="translate(${x} ${i ? 3 : 0})">
            <rect x="-8" y="50" width="6" height="22" rx="2" fill="${suit}"/><rect x="2" y="50" width="6" height="22" rx="2" fill="${suit}"/>
            <rect x="-13" y="28" width="26" height="26" rx="7" fill="${suit}"/>
            <path d="M-6 28 H6 L0 42 Z" fill="#f8fafc"/>
            <path d="M-2 30 H2 L3 44 L0 47 L-3 44 Z" fill="${tie}"/>
            <circle cy="18" r="10" fill="#f4c9a8"/>
            <circle cx="-3.5" cy="17" r="1.5" fill="#1f2937"/><circle cx="3.5" cy="17" r="1.5" fill="#1f2937"/>
        </g>`).join('')}</svg>`,
    costumes: `<svg viewBox="0 0 100 100">${SHADOW}
        <g transform="translate(22 0)">
            <path d="M-8 60 Q-22 64 -26 56 Q-16 60 -8 54 Z" fill="#d62828"/>
            <rect x="-7" y="54" width="5" height="18" rx="2" fill="#d62828"/><rect x="2" y="54" width="5" height="18" rx="2" fill="#d62828"/>
            <rect x="-10" y="34" width="20" height="24" rx="7" fill="#d62828"/><ellipse cy="47" rx="6" ry="9" fill="#f7c59f"/>
            <circle cy="25" r="9" fill="#d62828"/><rect x="0" y="23" width="12" height="7" rx="2" fill="#d62828"/>
            <path d="M-9 20 L-12 15 L-6 18 Z M-10 30 L-14 27 L-9 26 Z" fill="#ffd23f"/>
            <circle cx="2" cy="22" r="1.4" fill="#111"/>
        </g>
        <g transform="translate(47 3)">
            <rect x="-7" y="54" width="5" height="18" rx="2" fill="#facc15"/><rect x="2" y="54" width="5" height="18" rx="2" fill="#facc15"/>
            <rect x="-10" y="34" width="20" height="24" rx="7" fill="#7c3aed"/>
            <circle cx="-4" cy="42" r="2" fill="#facc15"/><circle cx="4" cy="50" r="2" fill="#22d3ee"/>
            <ellipse cy="34" rx="12" ry="3.5" fill="#fff"/>
            <circle cx="-8" cy="20" r="5" fill="#f97316"/><circle cx="8" cy="20" r="5" fill="#f97316"/>
            <circle cy="25" r="8" fill="#f4c9a8"/><circle cy="26" r="2.3" fill="#e11d48"/>
            <circle cx="-3" cy="22" r="1.2" fill="#111"/><circle cx="3" cy="22" r="1.2" fill="#111"/>
        </g>
        <g transform="translate(66 0)">
            <path d="M-11 72 L-11 30 Q-11 16 0 16 Q11 16 11 30 L11 72 L7 68 L3.5 72 L0 68 L-3.5 72 L-7 68 Z" fill="#f8fafc" stroke="#cbd5e1" stroke-width=".8"/>
            <ellipse cx="-3.5" cy="27" rx="1.8" ry="2.6" fill="#111"/><ellipse cx="3.5" cy="27" rx="1.8" ry="2.6" fill="#111"/>
            <ellipse cy="33" rx="1.5" ry="2.2" fill="#111"/>
        </g>
        <g transform="translate(86 3)">
            <rect x="-6" y="54" width="5" height="18" rx="1" fill="#6b7280"/><rect x="1" y="54" width="5" height="18" rx="1" fill="#6b7280"/>
            <rect x="-9" y="34" width="18" height="22" rx="3" fill="#9ca3af"/><rect x="-5" y="39" width="10" height="7" fill="#4b5563"/>
            <rect x="-8" y="17" width="16" height="15" rx="1.5" fill="#9ca3af"/>
            <rect x="-5" y="22" width="4" height="2.5" fill="#22d3ee"/><rect x="1" y="22" width="4" height="2.5" fill="#22d3ee"/>
            <path d="M0 17 V11" stroke="#4b5563" stroke-width="1.2"/><circle cy="10" r="1.8" fill="#22d3ee"/>
        </g></svg>`,
    squidGame: `<svg viewBox="0 0 100 100">${SHADOW}
        ${[['456', 30], ['067', 70]].map(([n, x], i) => `
        <g transform="translate(${x} ${i ? 3 : 0})">
            <rect x="-8" y="50" width="6" height="22" rx="2" fill="#1f8a78"/><rect x="2" y="50" width="6" height="22" rx="2" fill="#1f8a78"/>
            <rect x="-7.5" y="50" width="1.3" height="22" fill="#fff"/><rect x="6.2" y="50" width="1.3" height="22" fill="#fff"/>
            <rect x="-13" y="28" width="26" height="26" rx="7" fill="#1f8a78"/>
            <rect x="-12.5" y="32" width="1.6" height="20" fill="#fff"/><rect x="10.9" y="32" width="1.6" height="20" fill="#fff"/>
            <rect x="-.4" y="29" width=".8" height="24" fill="#0f4f45"/>
            <rect x="2" y="33" width="9" height="5" fill="#fff"/>
            <text x="6.5" y="37.2" font-size="4.6" font-weight="bold" text-anchor="middle" fill="#111" font-family="Arial">${n}</text>
            <circle cy="18" r="10" fill="#f4c9a8"/>
            <circle cx="-3.5" cy="17" r="1.5" fill="#1f2937"/><circle cx="3.5" cy="17" r="1.5" fill="#1f2937"/>
        </g>`).join('')}</svg>`,
};

const ITEMS = [
    { id: 'rainbow', name: 'Rainbow Customers', price: 1500, section: 'customer' },
    { id: 'rainbowShader', name: 'Rainbow Shader Pack', price: 3000, section: 'customer' },
    { id: 'costumes', name: 'Costumes', price: 3500, section: 'customer' },
    { id: 'squidGame', name: 'Squid Game', price: 4560, section: 'customer' },
    { id: 'suits', name: 'Suits', price: 5000, section: 'customer' },
    { id: 'lowQualityCart', name: 'Low Quality Cart', price: 1500, section: 'cart' },
    { id: 'racecarCart', name: 'Racecar Cart', price: 2000, section: 'cart' },
    { id: 'diamondCart', name: 'Diamond Cart', price: 5000, section: 'cart' },
    { id: 'goldenCart', name: 'Golden Cart', price: 10000, section: 'cart' },
    { id: 'smart', name: 'Mini Car', price: 2000, section: 'car' },
    { id: 'sedan', name: 'Family Sedan', price: 2500, section: 'car' },
    { id: 'boat', name: 'Boat', price: 7500, section: 'car' },
    { id: 'lambo', name: 'Supercar', price: 10000, section: 'car' }
];
const SECTIONS = [
    { id: 'customer', name: 'Customer Skins' },
    { id: 'cart', name: 'Cart Skins' },
    { id: 'car', name: 'Car Skins' },
    { id: 'other', name: 'Other Cosmetics' }
];
// Cart and car skins are one-at-a-time; customer skins stack (customers pick randomly among them).
const CART_SKIN_IDS = { goldenCart: 'golden', diamondCart: 'diamond', racecarCart: 'racecar', lowQualityCart: 'lowQuality' };
const ITEM_IDS = ITEMS.map(item => item.id);

function loadShop() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (_) {}
    const owned = new Set(Array.isArray(saved.owned) ? saved.owned : []);
    // Migrate the older per-item save format.
    if (saved.rainbowOwned === true) owned.add('rainbow');
    if (saved.goldenCartOwned === true) owned.add('goldenCart');
    if (Array.isArray(saved.carSkinsOwned)) saved.carSkinsOwned.forEach(id => owned.add(id));
    const ownedList = [...owned].filter(id => ITEM_IDS.includes(id));
    const has = id => ownedList.includes(id);
    let customerSkins = Array.isArray(saved.customerSkins) ? saved.customerSkins : [];
    if (!saved.owned && saved.rainbowEquipped === true) customerSkins = ['rainbow'];
    let cartSkin = saved.cartSkin;
    if (!saved.owned && saved.goldenCartEquipped === true) cartSkin = 'goldenCart';
    const section = id => ITEMS.find(item => item.id === id)?.section;
    return {
        balance: Number.isSafeInteger(saved.balance) && saved.balance >= 0 ? saved.balance : 0,
        owned: ownedList,
        customerSkins: customerSkins.filter(id => has(id) && section(id) === 'customer'),
        cartSkin: has(cartSkin) && section(cartSkin) === 'cart' ? cartSkin : null,
        carSkin: has(saved.carSkin) && section(saved.carSkin) === 'car' ? saved.carSkin : null
    };
}

const shop = loadShop();
const panel = document.getElementById('shop-menu');
const balance = document.getElementById('shop-balance');
const grid = document.getElementById('shop-grid');
const tabBar = document.getElementById('shop-tabs');
let activeSection = 'customer';

function saveShop() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(shop)); } catch (_) {}
}

const isOwned = item => shop.owned.includes(item.id);
function isEquipped(item) {
    if (item.section === 'customer') return shop.customerSkins.includes(item.id);
    if (item.section === 'cart') return shop.cartSkin === item.id;
    if (item.section === 'car') return shop.carSkin === item.id;
    return false;
}

function toggleItem(item) {
    const owned = isOwned(item);
    if (!owned) {
        if (shop.balance < item.price) return;
        shop.balance -= item.price;
        shop.owned.push(item.id);
    }
    const equip = !owned || !isEquipped(item);
    if (item.section === 'customer') {
        shop.customerSkins = shop.customerSkins.filter(id => id !== item.id);
        if (equip) shop.customerSkins.push(item.id);
    } else if (item.section === 'cart') {
        shop.cartSkin = equip ? item.id : null;
    } else if (item.section === 'car') {
        shop.carSkin = equip ? item.id : null;
    }
    saveShop();
    renderShop();
    if (item.section === 'cart') document.dispatchEvent(new Event('shop:cart-skin-change'));
}

// Build the tabs and tiles once; renderShop only updates their state.
const tabs = SECTIONS.map(section => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = section.name;
    button.addEventListener('click', () => { activeSection = section.id; renderShop(); });
    tabBar.appendChild(button);
    return { section, button };
});

const emptyNote = document.createElement('p');
emptyNote.className = 'shop-empty';
emptyNote.textContent = 'Nothing here yet — check back soon!';
grid.appendChild(emptyNote);

const tiles = ITEMS.map(item => {
    const tile = document.createElement('div');
    tile.className = 'shop-tile';
    tile.innerHTML = `<div class="shop-preview" aria-hidden="true">${PREVIEWS[item.id]}</div>
        <strong>${item.name}</strong><button type="button"></button>`;
    const button = tile.querySelector('button');
    button.addEventListener('click', () => toggleItem(item));
    grid.appendChild(tile);
    return { item, tile, button };
});

function renderShop() {
    balance.textContent = `$${(shop.balance / 100).toFixed(2)}`;
    for (const { section, button } of tabs) button.classList.toggle('active', section.id === activeSection);
    let shown = 0;
    for (const { item, tile, button } of tiles) {
        const visible = item.section === activeSection;
        tile.hidden = !visible;
        if (!visible) continue;
        shown++;
        const owned = isOwned(item);
        const equipped = isEquipped(item);
        tile.classList.toggle('equipped', equipped);
        button.textContent = owned ? (equipped ? 'Unequip' : 'Equip') : `Buy · $${item.price / 100}`;
        button.disabled = !owned && shop.balance < item.price;
    }
    emptyNote.hidden = shown > 0;
}

export function bankSavings(cents) {
    if (!Number.isSafeInteger(cents) || cents <= 0) return 0;
    shop.balance = Math.min(Number.MAX_SAFE_INTEGER, shop.balance + cents);
    saveShop();
    renderShop();
    return cents;
}

// Random pick among the enabled customer skins (null = default look).
export function pickCustomerSkin() {
    const list = shop.customerSkins;
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

export function equippedCartSkin() {
    return CART_SKIN_IDS[shop.cartSkin] || null;
}

export function equippedCarSkin() {
    return shop.carSkin;
}

document.getElementById('open-shop').addEventListener('click', () => {
    renderShop();
    panel.classList.remove('hidden');
});

document.getElementById('shop-close').addEventListener('click', () => panel.classList.add('hidden'));
panel.addEventListener('click', event => {
    if (event.target === panel) panel.classList.add('hidden');
});

renderShop();

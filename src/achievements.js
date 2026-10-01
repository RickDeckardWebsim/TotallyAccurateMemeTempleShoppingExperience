import { bankSavings } from './shop.js';

const STORAGE_KEY = 'magmartAchievements';
const REWARD_CENTS = 500;
let canEarnAchievement = () => true;
export function setAchievementEligibility(check) {
    canEarnAchievement = check;
}

const ACHIEVEMENTS = [
    { id: 'firstCheckout', icon: '🧾', name: 'Paper or Plastic?', desc: 'Complete a shopping run' },
    { id: 'expressLane', icon: '⚡', name: 'Express Lane', desc: 'Complete a run in under 2 minutes' },
    { id: 'slip', icon: '🍌', name: 'Cleanup on Aisle 5', desc: 'Slip in a spill' },
    { id: 'superPower', icon: '⚡', name: 'When You Use a Super Power', desc: 'Activate a super power' },
    { id: 'crushed', icon: '🪦', name: 'Clean Up Crew Needed', desc: 'Get crushed by a falling shelf' },
    { id: 'slapper', icon: '🖐️', name: 'Customer Service', desc: 'Slap 100 customers', goal: 100 },
    { id: 'klutz', icon: '🤕', name: 'Klutz', desc: 'Trip 25 times', goal: 25 },
    { id: 'butterfingers', icon: '🥚', name: 'Butterfingers', desc: 'Drop 50 items', goal: 50 },
    { id: 'lonely', icon: '🏚️', name: 'Is Anybody There?', desc: 'Find the Lonely Store', secret: true },
    { id: 'shoplift', icon: '🚓', name: 'Five Finger Discount', desc: 'Shoplift' },
    { id: 'nukeSurvivor', icon: '☢️', name: 'Duck and Cover', desc: 'Survive the nuclear fallout', secret: true }
];

let unlocked = [];
let progress = {};
try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    // Older saves were a plain array of unlocked ids.
    if (Array.isArray(saved)) unlocked = saved;
    else if (saved && typeof saved === 'object') {
        unlocked = Array.isArray(saved.unlocked) ? saved.unlocked : [];
        progress = saved.progress && typeof saved.progress === 'object' ? saved.progress : {};
    }
} catch (_) {}

function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ unlocked, progress })); } catch (_) {}
}

const panel = document.getElementById('achievements-menu');
const list = document.getElementById('achievements-list');
const count = document.getElementById('achievements-count');
const toasts = document.getElementById('achievement-toasts');

const rows = ACHIEVEMENTS.map(a => {
    const row = document.createElement('div');
    row.className = 'achievement-row';
    row.innerHTML = `<span class="achievement-icon"></span>
        <span class="achievement-text"><strong></strong><small></small></span>
        <span class="achievement-reward"></span>`;
    list.appendChild(row);
    return { a, row };
});

function render() {
    let n = 0;
    for (const { a, row } of rows) {
        const done = unlocked.includes(a.id);
        if (done) n++;
        const hidden = a.secret && !done;
        row.classList.toggle('unlocked', done);
        row.querySelector('.achievement-icon').textContent = hidden ? '❔' : a.icon;
        row.querySelector('strong').textContent = hidden ? '??????' : a.name;
        row.querySelector('small').textContent = hidden ? '??????' : a.goal && !done
            ? `${a.desc} (${Math.min(progress[a.id] || 0, a.goal)}/${a.goal})`
            : a.desc;
        row.querySelector('.achievement-reward').textContent = done ? '✓' : `$${REWARD_CENTS / 100}`;
    }
    count.textContent = `${n} / ${ACHIEVEMENTS.length}`;
}

function showToast(a) {
    const toast = document.createElement('div');
    toast.className = 'achievement-toast';
    toast.innerHTML = `<span class="achievement-icon">${a.icon}</span>
        <span class="achievement-text"><small>Achievement unlocked · +$${REWARD_CENTS / 100}</small><strong>${a.name}</strong></span>`;
    toasts.appendChild(toast);
    setTimeout(() => toast.classList.add('leaving'), 4600);
    setTimeout(() => toast.remove(), 5200);
}

export function unlockAchievement(id) {
    if (!canEarnAchievement()) return;
    const a = ACHIEVEMENTS.find(x => x.id === id);
    if (!a || unlocked.includes(id)) return;
    unlocked.push(id);
    save();
    bankSavings(REWARD_CENTS);
    render();
    showToast(a);
}

// Count toward a goal-based achievement (e.g. slap 100 customers).
export function addAchievementProgress(id, amount = 1) {
    if (!canEarnAchievement()) return;
    const a = ACHIEVEMENTS.find(x => x.id === id);
    if (!a?.goal || unlocked.includes(id) || !(amount > 0)) return;
    progress[id] = (progress[id] || 0) + amount;
    if (progress[id] >= a.goal) unlockAchievement(id);
    else save();
}

document.getElementById('open-achievements').addEventListener('click', () => {
    render();
    panel.classList.remove('hidden');
});
document.getElementById('achievements-close').addEventListener('click', () => panel.classList.add('hidden'));
panel.addEventListener('click', event => {
    if (event.target === panel) panel.classList.add('hidden');
});

render();

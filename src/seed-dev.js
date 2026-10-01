// DEV ONLY tools for run seeds: shows each run's seed + hash to the listed
// developers, and a main-menu "Seed Check" panel to verify any pasted seed.
// Everything here works offline in any copy of the game (see run-seed.js).
import { isSeedDev, verifyRunSeed } from './run-seed.js';

let devUser = false;
const devReady = (async () => {
    try {
        const user = await window.websim?.getUser?.();
        devUser = isSeedDev(user?.username);
    } catch (_) { devUser = false; }
    return devUser;
})();

export function isDev() { return devUser; }
export function whenDevKnown() { return devReady; }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Small block shown on end screens / pause menu for developers only.
export function seedBadgeHtml(runSeed) {
    if (!devUser || !runSeed) return '';
    return `
        <div class="seed-badge">
            <div class="seed-badge-head"><span>🔑 DEV · Run Seed</span></div>
            <div class="seed-badge-row"><span>Seed</span><code>${esc(runSeed.seed)}</code></div>
            <div class="seed-badge-row"><span>Hash</span><code>${esc(runSeed.hash)}</code></div>
            <button type="button" class="seed-copy" data-seed-copy="${esc(runSeed.full)}">Copy seed + hash</button>
        </div>`;
}

// Delegated copy handler for any badge on the page.
document.addEventListener('click', e => {
    const btn = e.target.closest?.('[data-seed-copy]');
    if (!btn) return;
    const text = btn.getAttribute('data-seed-copy');
    const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
    const done = () => { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = label; }, 1400); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => window.prompt('Copy seed:', text));
    else window.prompt('Copy seed:', text);
});

// ---- Main menu Seed Check panel ----
let openBtn = null;
let panel = null;

function renderResult(res) {
    const titles = {
        vanilla: '✅ Vanilla ruleset',
        custom: '🛠️ Custom ruleset',
        'modified-build': '⚠️ Modified build',
        tampered: '⛔ Tampered seed',
        invalid: '❌ Invalid seed'
    };
    let html = `<div class="seed-result-title" data-verdict="${res.verdict}">${titles[res.verdict] || res.verdict}</div>
        <div class="seed-result-reason">${esc(res.reason)}</div>`;
    if (res.ok) {
        html += `<div class="seed-result-meta">
            <div><span>Run ID</span><code>${esc(res.runId)}</code></div>
            <div><span>Started</span><code>${res.startedAt ? esc(res.startedAt.toLocaleString()) : '—'}</code></div>
            <div><span>Started as</span><code>${esc(res.claimedMode)}</code></div>
            <div><span>Hash</span><code>${esc(res.hash)}</code></div>
        </div>`;
        if (res.changes.length) {
            html += `<div class="seed-result-changes"><div class="seed-result-sub">Changed from vanilla (${res.changes.length})</div>` +
                res.changes.map(c => `<div><code>${esc(c.key)}</code><span>${esc(JSON.stringify(c.vanilla))} → <strong>${esc(JSON.stringify(c.value))}</strong></span></div>`).join('') +
                `</div>`;
        }
    }
    return html;
}

function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'seed-check';
    panel.className = 'hidden';
    panel.innerHTML = `
        <div class="seed-check-card" role="dialog" aria-label="Seed Check">
            <div class="seed-check-head"><h2>SEED CHECK</h2><button type="button" id="seed-check-close" aria-label="Close">×</button></div>
            <textarea id="seed-check-input" rows="3" spellcheck="false" placeholder="Paste seed + hash (MM2.…)"></textarea>
            <input id="seed-check-hash" type="text" spellcheck="false" placeholder="Hash (only if pasted separately)">
            <button type="button" id="seed-check-go" class="main-menu-btn">Verify</button>
            <div id="seed-check-result"></div>
        </div>`;
    (document.getElementById('game-container') || document.body).appendChild(panel);
    const input = panel.querySelector('#seed-check-input');
    const hash = panel.querySelector('#seed-check-hash');
    const out = panel.querySelector('#seed-check-result');
    const run = () => { out.innerHTML = input.value.trim() ? renderResult(verifyRunSeed(input.value, hash.value)) : ''; };
    panel.querySelector('#seed-check-go').addEventListener('click', run);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); } });
    // Keep typing from reaching the game's key handlers.
    panel.addEventListener('keydown', e => e.stopPropagation());
    panel.querySelector('#seed-check-close').addEventListener('click', () => panel.classList.add('hidden'));
    panel.addEventListener('click', e => { if (e.target === panel) panel.classList.add('hidden'); });
}

// Called by the game whenever the main menu is shown/hidden.
export function setSeedCheckMenuVisible(visible) {
    devReady.then(dev => {
        if (!dev) return;
        if (!openBtn) {
            openBtn = document.createElement('button');
            openBtn.id = 'open-seed-check';
            openBtn.type = 'button';
            openBtn.textContent = '🔑 SEED CHECK';
            openBtn.addEventListener('click', () => {
                if (!panel) buildPanel();
                panel.classList.remove('hidden');
                panel.querySelector('#seed-check-input').focus();
            });
            (document.getElementById('game-container') || document.body).appendChild(openBtn);
        }
        openBtn.classList.toggle('hidden', !visible);
        if (!visible) panel?.classList.add('hidden');
    });
}

// ---- Leaderboard review panel (devs only) ----
// Runs that would enter the top 10 wait here until approved. Devs can also
// pull any live run and ban / unban players.
let reviewKey = '';

async function devPost(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
}

function reviewRowHtml(entry, idx, list, live) {
    const reasons = (entry.review_reasons || []);
    return `
        <div class="lb-review-row" data-list="${list}" data-idx="${idx}">
            <div class="lb-review-main">
                <strong>${esc(entry.username)}</strong>
                <code>${esc(entry.final_time)}</code>
                <span class="lb-review-tag" data-ok="${entry.verified ? 1 : 0}">${entry.verified ? 'checks passed' : 'FLAGGED'}</span>
                ${live ? '' : `<span class="lb-review-tag">${esc(entry.review_status)}</span>`}
            </div>
            ${reasons.length ? `<div class="lb-review-reasons">${reasons.map(r => `<div>${esc(r)}</div>`).join('')}</div>` : ''}
            <div class="lb-review-actions">
                ${entry.replay_video_url ? '<button type="button" data-act="watch">▶ Replay</button>' : '<span class="lb-review-noreplay">no replay yet</span>'}
                ${entry.seed ? `<button type="button" class="seed-copy" data-seed-copy="${esc(entry.seed)}">🔑 Seed</button>` : ''}
                ${live ? '' : '<button type="button" data-act="approve" class="ok">Approve</button>'}
                <button type="button" data-act="remove" class="bad">Remove</button>
                <button type="button" data-act="ban" class="bad">Ban</button>
            </div>
        </div>`;
}

export function renderDevReview(data, refresh) {
    if (!devUser || !data) return;
    const queue = data.review_queue || [];
    const live = (data.top_times || []).slice(0, 10);
    const banned = data.banned || [];
    const key = JSON.stringify([queue, live.map(e => [e.id, e.replay_video_url, e.seed]), banned]);
    if (key === reviewKey) return;
    reviewKey = key;

    let box = document.getElementById('lb-dev-review');
    if (!box) {
        const anchor = document.querySelector('#leaderboard-menu .leaderboard-table-container');
        if (!anchor) return;
        box = document.createElement('div');
        box.id = 'lb-dev-review';
        anchor.after(box);
        box.addEventListener('click', async e => {
            const btn = e.target.closest('button[data-act], button[data-unban]');
            if (!btn) return;
            try {
                if (btn.dataset.unban) {
                    await devPost('/api/dev/ban', { user_key: btn.dataset.unban, ban: false });
                } else {
                    const row = btn.closest('.lb-review-row');
                    const src = row.dataset.list === 'queue' ? box._queue : box._live;
                    const entry = src[Number(row.dataset.idx)];
                    if (!entry) return;
                    const act = btn.dataset.act;
                    if (act === 'watch') { window.__replayWatch?.(entry); return; }
                    if (act === 'ban' && !confirm(`Ban @${entry.username} from the leaderboard?`)) return;
                    if (act === 'remove' && !confirm(`Remove @${entry.username}'s ${entry.final_time} run?`)) return;
                    if (act === 'ban') await devPost('/api/dev/ban', { user_key: entry.user_key, username: entry.username, ban: true });
                    else await devPost('/api/dev/review', { leaderboard_id: entry.id, action: act });
                }
                btn.disabled = true;
                refresh?.();
            } catch (err) {
                alert('Failed: ' + err.message);
            }
        });
    }
    box._queue = queue;
    box._live = live;
    box.innerHTML = `
        <div class="lb-review-head">🔑 DEV · Awaiting review (${queue.length})</div>
        ${queue.length ? queue.map((e, i) => reviewRowHtml(e, i, 'queue', false)).join('') : '<div class="lb-review-empty">Nothing waiting.</div>'}
        <div class="lb-review-head">Live top 10</div>
        ${live.length ? live.map((e, i) => reviewRowHtml(e, i, 'live', true)).join('') : '<div class="lb-review-empty">Empty.</div>'}
        ${banned.length ? `<div class="lb-review-head">Banned (${banned.length})</div>` + banned.map(b => `
            <div class="lb-review-row"><div class="lb-review-main"><strong>${esc(b.username || b.user_key)}</strong>
            <span class="lb-review-tag">by @${esc(b.banned_by)}</span>
            <button type="button" data-unban="${esc(b.user_key)}">Unban</button></div></div>`).join('') : ''}`;
}

// iPhone / iPad start-up helper. iOS needs a real tap to unlock audio, and its
// WebKit tabs are killed (and silently reloaded) when they use too much memory.
// This sheet explains the few things a player can do and starts the game from
// a fresh tap.

import { audioContext } from './audio-engine.js';

let sheet = null;

function unlockAudio() {
    try {
        const ctx = audioContext; // the game's own (src/audio-engine.js): unlocking it unlocks every sound
        if (ctx) {
            const buf = ctx.createBuffer(1, 1, 22050);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start(0);
            ctx.resume?.();
        }
    } catch (_) {}
}

function isStandalone() {
    return window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
}

/**
 * @param {{ mode?: 'start' | 'crashed' | 'error', error?: string, onStart: () => void }} opts
 */
export function showIosHelp({ mode = 'start', error = '', onStart }) {
    closeIosHelp();
    sheet = document.createElement('div');
    sheet.id = 'ios-help';
    const notice = mode === 'crashed'
        ? `<p class="ih-note">Your device ran out of memory last time, so the game restarted. Lite graphics are on now.</p>`
        : mode === 'error'
            ? `<p class="ih-note">The store couldn't open${error ? `: <code></code>` : '.'} Lite graphics are on now. Try again.</p>`
            : '';
    sheet.innerHTML = `
        <div class="ih-card" role="dialog" aria-modal="true" aria-labelledby="ih-title">
            <h2 id="ih-title">Before you shop</h2>
            ${notice}
            <ul>
                <li><b>Turn your phone sideways.</b> The game plays in landscape.</li>
                <li><b>No sound?</b> Flip the silent switch off and turn the volume up.</li>
                <li><b>Game reloads or freezes?</b> Close other apps and Safari tabs, then turn off Low Power Mode.</li>
                ${isStandalone() ? '' : '<li><b>Full screen:</b> tap Share, then <i>Add to Home Screen</i>.</li>'}
            </ul>
            <p class="ih-small">The game doesn't need camera, microphone or screen-recording access. If iOS asks, you can say no.</p>
            <button class="ih-go" type="button">Start shopping</button>
        </div>`;
    if (mode === 'error' && error) sheet.querySelector('code').textContent = error.slice(0, 160);

    const go = sheet.querySelector('.ih-go');
    let fired = false;
    const start = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (fired) return;
        fired = true;
        unlockAudio();
        closeIosHelp();
        onStart?.();
    };
    go.addEventListener('touchend', start, { passive: false });
    go.addEventListener('click', start);
    sheet.addEventListener('touchmove', (e) => { if (!e.target.closest('.ih-card')) e.preventDefault(); }, { passive: false });

    (document.getElementById('game-container') || document.body).appendChild(sheet);
}

export function closeIosHelp() {
    if (sheet) { sheet.remove(); sheet = null; }
}

// ---- On-screen error banner (touch devices only) ----
// Phones have no dev console, so any uncaught error is shown as a small
// dismissible bar the tester can screenshot and send over.
(() => {
    let coarse = false;
    try { coarse = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0; } catch (_) {}
    if (!coarse) return;
    let bar = null;
    const seen = new Set();
    const show = (msg) => {
        msg = String(msg || 'Unknown error').slice(0, 300);
        if (seen.has(msg) || seen.size > 5) return;
        seen.add(msg);
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'ss-error-bar';
            bar.addEventListener('click', () => { bar.remove(); bar = null; seen.clear(); });
            document.body.appendChild(bar);
        }
        const line = document.createElement('div');
        line.textContent = msg;
        bar.appendChild(line);
    };
    // Ignore noise from the websim host frame and blocked media autoplay.
    const ignore = (m) => /sessionStorage|The request was denied|play\(\) request|NotAllowedError|AbortError|ResizeObserver/i.test(m);
    window.addEventListener('error', (e) => {
        const m = e.message || (e.error && e.error.message) || '';
        if (!m || ignore(m)) return;
        const where = e.filename ? ` (${String(e.filename).split('/').pop()}:${e.lineno})` : '';
        show(m + where);
    });
    window.addEventListener('unhandledrejection', (e) => {
        const r = e.reason;
        const m = (r && (r.message || r.name)) || String(r || '');
        if (!m || ignore(m)) return;
        show('Promise: ' + m);
    });
})();

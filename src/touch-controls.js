// On-screen touch controls for phones/tablets.
// Left side: floating movement joystick. Right side: drag to look, tap to grab/drop.
// Buttons fire the same key events the keyboard would, so every action matches desktop.
// Deliberately imports nothing from game.js: if a host serves the entry script
// under a different URL (cache-busting query etc.), importing it here would
// evaluate the whole game a second time (two menus, two copies of the music).
// Everything comes through the window.__touch bridge game.js installs instead.

const boot = () => {
    const t = window.__touch;
    if (!t) return requestAnimationFrame(boot);
    if (t.enabled) init();
};
boot();

function code(action) {
    const kb = window.__touch?.keybinds?.() || {};
    return kb[action];
}

function key(type, c) {
    if (!c) return;
    document.dispatchEvent(new KeyboardEvent(type, { code: c, key: c, bubbles: true, cancelable: true }));
}

function init() {
    const container = document.getElementById('game-container') || document.body;

    const root = document.createElement('div');
    root.id = 'touch-controls';
    root.innerHTML = `
        <div class="tc-stick-zone" data-zone="stick">
            <div class="tc-stick"><div class="tc-knob"></div></div>
        </div>
        <div class="tc-top">
            <button class="tc-small" data-key="pause" aria-label="Pause">❚❚</button>
            <button class="tc-small" data-list aria-label="Switch list">☰</button>
        </div>
        <div class="tc-actions">
            <button class="tc-btn tc-slap" data-key="slap">Slap</button>
            <button class="tc-btn tc-power" data-key="powerup">Power</button>
            <button class="tc-btn tc-cart" data-key="cart">Cart</button>
            <button class="tc-btn tc-use" data-key="interact">Use</button>
            <button class="tc-btn tc-jump" data-key="jump">Jump</button>
        </div>`;
    container.appendChild(root);

    const T = () => window.__touch;
    const stick = root.querySelector('.tc-stick');
    const knob = root.querySelector('.tc-knob');
    const zone = root.querySelector('.tc-stick-zone');

    // ---- Joystick ----
    const R = 56;
    let stickId = null, cx = 0, cy = 0;
    const setKnob = (dx, dy) => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };
    const resetStick = () => {
        stickId = null;
        stick.classList.remove('active');
        setKnob(0, 0);
        T()?.move(0, 0);
    };
    zone.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (stickId !== null) return;
        const t = e.changedTouches[0];
        stickId = t.identifier;
        const zr = zone.getBoundingClientRect();
        cx = Math.min(Math.max(t.clientX, zr.left + R + 10), zr.right - R - 10);
        cy = Math.min(Math.max(t.clientY, zr.top + R + 10), zr.bottom - R - 10);
        stick.style.left = (cx - zr.left) + 'px';
        stick.style.top = (cy - zr.top) + 'px';
        stick.classList.add('active');
        moveStick(t);
    }, { passive: false });
    const moveStick = (t) => {
        let dx = t.clientX - cx, dy = t.clientY - cy;
        const d = Math.hypot(dx, dy);
        if (d > R) { dx *= R / d; dy *= R / d; }
        setKnob(dx, dy);
        let x = dx / R, y = -dy / R;
        const m = Math.hypot(x, y);
        if (m < 0.15) { x = 0; y = 0; }
        else {
            // Rescale past the dead zone, snap to full speed near the rim.
            const s = Math.min(1, (m - 0.15) / 0.7) / m;
            x *= s; y *= s;
        }
        T()?.move(x, y);
    };
    zone.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) if (t.identifier === stickId) moveStick(t);
    }, { passive: false });
    const endStick = (e) => {
        for (const t of e.changedTouches) if (t.identifier === stickId) resetStick();
    };
    zone.addEventListener('touchend', endStick);
    zone.addEventListener('touchcancel', endStick);

    // ---- Look (drag on the 3D view) + tap to grab/drop ----
    let lookId = null, lx = 0, ly = 0, sx = 0, sy = 0, st = 0, moved = false;
    const isView = (el) => el && el.tagName === 'CANVAS' && container.contains(el);
    document.addEventListener('touchstart', (e) => {
        if (!isView(e.target)) return;
        e.preventDefault(); // no emulated mouse/click events, no zoom
        if (lookId !== null) return;
        const t = e.changedTouches[0];
        lookId = t.identifier;
        lx = sx = t.clientX; ly = sy = t.clientY; st = performance.now(); moved = false;
    }, { passive: false });
    document.addEventListener('touchmove', (e) => {
        if (lookId === null) return;
        for (const t of e.changedTouches) {
            if (t.identifier !== lookId) continue;
            e.preventDefault();
            const dx = t.clientX - lx, dy = t.clientY - ly;
            lx = t.clientX; ly = t.clientY;
            if (Math.hypot(t.clientX - sx, t.clientY - sy) > 10) moved = true;
            if (moved) T()?.look(dx, dy);
        }
    }, { passive: false });
    const endLook = (e) => {
        for (const t of e.changedTouches) {
            if (t.identifier !== lookId) continue;
            lookId = null;
            if (e.type === 'touchend' && !moved && performance.now() - st < 300) T()?.tap();
        }
    };
    document.addEventListener('touchend', endLook);
    document.addEventListener('touchcancel', endLook);

    // ---- Buttons ----
    const held = new Map();
    root.querySelectorAll('[data-key]').forEach((btn) => {
        const action = btn.dataset.key;
        btn.addEventListener('touchstart', (e) => {
            e.preventDefault(); e.stopPropagation();
            const c = code(action);
            held.set(btn, c);
            btn.classList.add('down');
            if (action !== 'mute' && action !== 'pause') T()?.relock();
            key('keydown', c);
            navigator.vibrate?.(8);
        }, { passive: false });
        const up = (e) => {
            e.preventDefault();
            const c = held.get(btn);
            if (c === undefined) return;
            held.delete(btn);
            btn.classList.remove('down');
            key('keyup', c);
        };
        btn.addEventListener('touchend', up, { passive: false });
        btn.addEventListener('touchcancel', up, { passive: false });
    });

    let listPage = 1;
    root.querySelector('[data-list]').addEventListener('touchstart', (e) => {
        e.preventDefault(); e.stopPropagation();
        listPage = listPage === 1 ? 2 : 1;
        const c = 'Digit' + listPage;
        key('keydown', c); key('keyup', c);
    }, { passive: false });

    const releaseAll = () => {
        held.forEach((c, btn) => { btn.classList.remove('down'); key('keyup', c); });
        held.clear();
        resetStick();
        lookId = null;
    };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

    // ---- Visibility: only while actually playing ----
    let shown = null;
    const tick = () => {
        const s = T()?.state?.();
        const show = !!s && s.started && !s.menu && !s.paused && !s.over && !s.checkout && !s.intro;
        if (show !== shown) {
            shown = show;
            root.classList.toggle('visible', show);
            if (!show) releaseAll();
        }
        if (s) {
            root.classList.toggle('holding', s.holding);
            root.classList.toggle('with-cart', s.cart);
            root.classList.toggle('has-power', !!s.power);
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // Try to go fullscreen + landscape on the first touch in-game (Android; iOS ignores).
    const goFull = () => {
        const el = document.documentElement;
        if (!document.fullscreenElement && el.requestFullscreen) {
            el.requestFullscreen({ navigationUI: 'hide' })
                .then(() => screen.orientation?.lock?.('landscape').catch(() => {}))
                .catch(() => {});
        }
    };
    document.addEventListener('touchend', goFull, { once: true });
}

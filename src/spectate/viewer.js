// Spectator side: the green SPECTATE button on the main menu, the list of
// live games, and the first-person viewer (live video of the player's exact
// rendered view + their mirrored HUD on top).

import { net } from './net.js';
import { startAudioMirror, stopAudioMirror } from './audio.js';
import { ICE_SERVERS, QUALITY, DEFAULT_QUALITY } from './shared.js';
import { hudSrcdoc, sanitize, morphChildren } from './hud-frame.js';

// ------------------------------------------------------------------ DOM
const openBtn = document.createElement('button');
openBtn.id = 'ss-open';
openBtn.type = 'button';
openBtn.className = 'hidden';
openBtn.innerHTML = '<span class="ss-live-dot"></span>SPECTATE';
document.body.appendChild(openBtn);

const listEl = document.createElement('div');
listEl.id = 'ss-list';
listEl.className = 'hidden';
listEl.setAttribute('role', 'dialog');
listEl.setAttribute('aria-modal', 'true');
listEl.setAttribute('aria-label', 'Spectate');
listEl.innerHTML = `
    <div class="ss-card">
        <div class="ss-head">
            <h2>SPECTATE</h2>
            <button type="button" class="ss-close" aria-label="Close">×</button>
        </div>
        <div class="ss-games"></div>
    </div>`;
document.body.appendChild(listEl);
const gamesEl = listEl.querySelector('.ss-games');

const viewerEl = document.createElement('div');
viewerEl.id = 'ss-viewer';
viewerEl.className = 'hidden';
viewerEl.innerHTML = `
    <div class="ss-stage">
        <div class="ss-world">
            <img class="ss-jpeg" alt="">
            <video class="ss-video" autoplay muted playsinline></video>
        </div>
        <iframe class="ss-hud" sandbox="allow-same-origin" tabindex="-1" aria-hidden="true"></iframe>
        <div class="ss-wait hidden"><div class="ss-spinner"></div><span>Connecting to player…</span></div>
    </div>
    <div class="ss-bar">
        <a class="ss-who" target="_blank" rel="noopener"><img alt=""><span></span></a>
        <span class="ss-badge"><span class="ss-live-dot"></span>LIVE</span>
        <span class="ss-time">0:00</span>
        <span class="ss-eye">👁 1</span>
        <select class="ss-quality" aria-label="Stream quality"></select>
        <button type="button" class="ss-leave">Leave</button>
    </div>`;
document.body.appendChild(viewerEl);

const stageEl = viewerEl.querySelector('.ss-stage');
const worldEl = viewerEl.querySelector('.ss-world');
const jpegEl = viewerEl.querySelector('.ss-jpeg');
const videoEl = viewerEl.querySelector('.ss-video');
const hudFrame = viewerEl.querySelector('.ss-hud');
const waitEl = viewerEl.querySelector('.ss-wait');
const waitText = waitEl.querySelector('span');
const whoEl = viewerEl.querySelector('.ss-who');
const timeEl = viewerEl.querySelector('.ss-time');
const eyeEl = viewerEl.querySelector('.ss-eye');
const qualityEl = viewerEl.querySelector('.ss-quality');

let quality = DEFAULT_QUALITY;
try { const q = localStorage.getItem('ssQuality'); if (QUALITY[q]) quality = q; } catch (_) {}
for (const [key, q] of Object.entries(QUALITY)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = q.label;
    qualityEl.appendChild(opt);
}
qualityEl.value = quality;
qualityEl.onchange = () => {
    if (!QUALITY[qualityEl.value]) return;
    quality = qualityEl.value;
    try { localStorage.setItem('ssQuality', quality); } catch (_) {}
    sendQuality();
    qualityEl.blur();
};
function sendQuality() {
    if (view.target) net.send({ type: 'spec:quality', q: quality });
}

// ---------------------------------------------------------------- state
let games = [];
let listOpen = false;

const view = {
    target: null,       // broadcaster conn id
    game: null,
    w: 1280,
    h: 720,
    pc: null,
    pending: [],
    usingVideo: false,
    jpegMode: true,
    rtcRetries: 0,
    rtcFailedAt: 0,
    lastVideoFrame: 0,
    videoGoodSince: 0,
    lastData: 0,
    lastJpeg: 0,
    hudReady: false,
    pendingHud: null,
    endedAt: 0,
};

// ------------------------------------------------------------- helpers
function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function displayName(g) { return g.username ? `@${g.username}` : 'Guest shopper'; }

function avatarUrl(g) {
    return g.username ? `https://images.websim.com/avatar/${encodeURIComponent(g.username)}` : 'loading dude.png';
}

function gameElapsed(g) { return Date.now() - net.toLocalTime(g.startedAt); }

// ---------------------------------------------------------------- list
function renderList() {
    gamesEl.textContent = '';
    if (!net.connected && !games.length) {
        gamesEl.innerHTML = '<div class="ss-empty">Connecting…</div>';
        return;
    }
    if (!games.length) {
        gamesEl.innerHTML = '<div class="ss-empty">No games in progress right now.</div>';
        return;
    }
    for (const g of games) {
        const row = document.createElement('div');
        row.className = 'ss-row';

        const who = document.createElement(g.username ? 'a' : 'div');
        who.className = 'ss-row-who';
        if (g.username) {
            who.href = `https://websim.com/@${encodeURIComponent(g.username)}`;
            who.target = '_blank';
            who.rel = 'noopener';
        }
        const img = document.createElement('img');
        img.src = avatarUrl(g);
        img.alt = '';
        const name = document.createElement('span');
        name.textContent = displayName(g);
        who.append(img, name);

        const meta = document.createElement('div');
        meta.className = 'ss-row-meta';
        meta.innerHTML = '<span class="ss-live-dot"></span>';
        const t = document.createElement('span');
        t.className = 'ss-row-time';
        t.dataset.id = g.id;
        t.textContent = fmtElapsed(gameElapsed(g));
        const eyes = document.createElement('span');
        eyes.className = 'ss-row-eyes';
        eyes.textContent = g.viewers ? `👁 ${g.viewers}` : '';
        meta.append(t, eyes);

        const watch = document.createElement('button');
        watch.type = 'button';
        watch.className = 'ss-watch';
        watch.textContent = 'Watch';
        watch.onclick = () => startWatching(g);

        row.append(who, meta, watch);
        gamesEl.appendChild(row);
    }
}

function openList() {
    listOpen = true;
    listEl.classList.remove('hidden');
    net.send({ type: 'spec:list' });
    renderList();
}

function closeList() {
    listOpen = false;
    listEl.classList.add('hidden');
}

openBtn.onclick = openList;
listEl.querySelector('.ss-close').onclick = closeList;
listEl.addEventListener('click', (e) => { if (e.target === listEl) closeList(); });

const others = (list) => (list || []).filter(g => g.id !== net.myId);
net.on('spec:welcome', (msg) => { games = others(msg.games); if (listOpen) renderList(); });
net.on('spec:games', (msg) => {
    games = others(msg.games);
    if (listOpen) renderList();
    if (view.target) {
        const g = games.find(x => x.id === view.target);
        if (g) { view.game = g; renderBar(); }
    }
});

// Main-menu visibility: the button lives exactly where the SHOP button does.
function syncButton() {
    const shop = document.getElementById('open-shop');
    const onMenu = !!shop && !shop.classList.contains('hidden');
    openBtn.classList.toggle('hidden', !onMenu || !!view.target);
    if (!onMenu && listOpen) closeList();
}
const shopBtn = document.getElementById('open-shop');
if (shopBtn) new MutationObserver(syncButton).observe(shopBtn, { attributes: true, attributeFilter: ['class'] });
syncButton();

// ------------------------------------------------------------ HUD frame
function initHudFrame() {
    hudFrame.srcdoc = hudSrcdoc();
    view.hudReady = false;
    hudFrame.onload = () => {
        view.hudReady = true;
        if (view.pendingHud) { applyHud(view.pendingHud); view.pendingHud = null; }
    };
}

function applyHud(h) {
    if (!h) return;
    view.lastData = performance.now();
    if (h.w && h.h && (h.w !== view.w || h.h !== view.h)) {
        view.w = h.w; view.h = h.h;
        layout();
    }
    if (h.cv) {
        worldEl.style.filter = h.cv.f || '';
        worldEl.style.transform = h.cv.t || '';
        worldEl.style.opacity = h.cv.o || '';
    }
    if (!view.hudReady) { view.pendingHud = h; return; }
    const doc = hudFrame.contentDocument;
    if (!doc || !doc.body) { view.pendingHud = h; return; }
    const gc = doc.getElementById('game-container');
    const extra = doc.getElementById('ss-extra');
    doc.body.className = String(h.bcls || '');
    if (gc) {
        gc.className = String(h.cls || '');
        gc.setAttribute('style', String(h.st || ''));
        morphChildren(gc, sanitize(String(h.html || '')));
    }
    if (extra) morphChildren(extra, sanitize(String(h.extra || '')));
}

// ---------------------------------------------------------------- layout
function layout() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const s = Math.min(vw / view.w, vh / view.h);
    const sw = Math.round(view.w * s), sh = Math.round(view.h * s);
    stageEl.style.width = `${sw}px`;
    stageEl.style.height = `${sh}px`;
    hudFrame.style.width = `${view.w}px`;
    hudFrame.style.height = `${view.h}px`;
    hudFrame.style.transform = `scale(${s})`;
}
window.addEventListener('resize', () => { if (view.target) layout(); });

function renderBar() {
    const g = view.game;
    if (!g) return;
    const img = whoEl.querySelector('img');
    const name = whoEl.querySelector('span');
    const url = avatarUrl(g);
    if (img.getAttribute('src') !== url) img.src = url;
    name.textContent = displayName(g);
    if (g.username) whoEl.href = `https://websim.com/@${encodeURIComponent(g.username)}`;
    else whoEl.removeAttribute('href');
    eyeEl.textContent = `👁 ${Math.max(1, g.viewers || 1)}`;
}

// ---------------------------------------------------------------- WebRTC
function setJpegMode(on) {
    if (view.jpegMode === on) return;
    view.jpegMode = on;
    net.send({ type: 'spec:mode', jpeg: on });
}

function showVideo(on) {
    view.usingVideo = on;
    videoEl.classList.toggle('on', on);
    jpegEl.classList.toggle('on', !on);
}

function closePc() {
    if (view.pc) { try { view.pc.close(); } catch (_) {} }
    view.pc = null;
    view.pending = [];
    try { videoEl.srcObject = null; } catch (_) {}
    showVideo(false);
}

videoEl.addEventListener('timeupdate', () => { view.lastVideoFrame = performance.now(); });

function watchVideoFrames() {
    if (!videoEl.requestVideoFrameCallback) return;
    const cb = () => {
        view.lastVideoFrame = performance.now();
        if (view.pc) videoEl.requestVideoFrameCallback(cb);
    };
    videoEl.requestVideoFrameCallback(cb);
}

async function onOffer(from, sdp) {
    closePc();
    if (typeof RTCPeerConnection === 'undefined') return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    view.pc = pc;
    pc.ontrack = (e) => {
        const s = (e.streams && e.streams[0]) || new MediaStream([e.track]);
        videoEl.srcObject = s;
        videoEl.play().catch(() => {});
        watchVideoFrames();
    };
    pc.onicecandidate = (e) => {
        if (e.candidate) net.send({ type: 'spec:rtc', to: from, data: { candidate: e.candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => {
        if (pc !== view.pc) return;
        const st = pc.connectionState;
        if (st === 'failed' || st === 'closed') {
            showVideo(false);
            setJpegMode(true);
            view.rtcFailedAt = performance.now();
        }
    };
    try {
        await pc.setRemoteDescription(sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        net.send({ type: 'spec:rtc', to: from, data: { sdp: pc.localDescription.toJSON() } });
        for (const c of view.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } catch (e) {
        console.warn('[spectate] answer failed', e);
        view.rtcFailedAt = performance.now();
    }
}

net.on('spec:rtc', async (msg) => {
    if (!view.target || msg.from !== view.target) return;
    const data = msg.data || {};
    if (data.sdp && data.sdp.type === 'offer') { onOffer(msg.from, data.sdp); return; }
    if (data.candidate) {
        if (view.pc && view.pc.remoteDescription) await view.pc.addIceCandidate(data.candidate).catch(() => {});
        else view.pending.push(data.candidate);
    }
});

// Decide every frame which source is the freshest picture of the player's eyes.
function tickTransport(now) {
    const pc = view.pc;
    const connected = pc && pc.connectionState === 'connected';
    const videoFresh = connected && videoEl.videoWidth > 0 && now - view.lastVideoFrame < 1500;
    if (videoFresh) {
        if (!view.videoGoodSince) view.videoGoodSince = now;
        // Hold the relay a moment so the handoff is seamless.
        if (!view.usingVideo && now - view.videoGoodSince > 400) showVideo(true);
        if (view.usingVideo && now - view.videoGoodSince > 1500) setJpegMode(false);
    } else {
        view.videoGoodSince = 0;
        const dataFresh = now - view.lastData < 3000;
        if (view.usingVideo && dataFresh && now - view.lastVideoFrame > 2500) {
            // Video stalled while the game is clearly still running: fall back.
            showVideo(false);
            setJpegMode(true);
        }
        if (!view.usingVideo) setJpegMode(true);
    }
    // Retry the P2P link a couple of times if it failed.
    if (view.rtcFailedAt && now - view.rtcFailedAt > 3000 && view.rtcRetries < 3) {
        view.rtcFailedAt = 0;
        view.rtcRetries++;
        net.send({ type: 'spec:rtc', to: view.target, data: { restart: true } });
    }
}

// ------------------------------------------------------------ watching
function resetView() {
    Object.assign(view, {
        usingVideo: false, jpegMode: true, rtcRetries: 0, rtcFailedAt: 0,
        lastVideoFrame: 0, videoGoodSince: 0, lastData: 0, lastJpeg: 0,
        pendingHud: null, endedAt: 0,
    });
}

function startWatching(g) {
    closeList();
    closePc();
    resetView();
    view.target = g.id;
    view.game = g;
    view.w = g.w || 1280;
    view.h = g.h || 720;
    window.__ssIsSpectating = true;
    jpegEl.removeAttribute('src');
    initHudFrame();
    layout();
    renderBar();
    waitText.textContent = 'Connecting to player…';
    waitEl.classList.remove('hidden');
    viewerEl.classList.remove('hidden');
    document.body.classList.add('ss-spectating');
    startAudioMirror(g.id);
    syncButton();
    net.send({ type: 'spec:watch', target: g.id });
}

function stopWatching(backToList = true) {
    if (!view.target) return;
    net.send({ type: 'spec:unwatch' });
    closePc();
    view.target = null;
    view.game = null;
    window.__ssIsSpectating = false;
    viewerEl.classList.add('hidden');
    document.body.classList.remove('ss-spectating');
    stopAudioMirror();
    hudFrame.removeAttribute('srcdoc');
    syncButton();
    if (backToList) openList();
}

viewerEl.querySelector('.ss-leave').onclick = () => stopWatching(true);

net.on('spec:watch-ok', (msg) => {
    if (!msg.game || msg.game.id !== view.target) return;
    view.game = msg.game;
    renderBar();
    sendQuality();
    if (msg.hud) applyHud(msg.hud);
});

net.on('spec:watch-fail', (msg) => {
    if (!view.target) return;
    stopWatching(true);
    const note = document.createElement('div');
    note.className = 'ss-empty';
    note.textContent = msg.reason || 'That game has ended.';
    gamesEl.prepend(note);
});

net.on('spec:info', (msg) => {
    if (!msg.game || msg.game.id !== view.target) return;
    view.game = msg.game;
    if (msg.game.w && msg.game.h) { view.w = msg.game.w; view.h = msg.game.h; layout(); }
    renderBar();
});

net.on('spec:hud', (msg) => {
    if (msg.id !== view.target) return;
    applyHud(msg.h);
});

net.on('spec:frame', (msg) => {
    if (msg.id !== view.target || typeof msg.d !== 'string' || !msg.d.startsWith('data:image/jpeg;base64,')) return;
    view.lastData = performance.now();
    view.lastJpeg = view.lastData;
    jpegEl.src = msg.d;
});

net.on('spec:ended', (msg) => {
    if (msg.id !== view.target) return;
    closePc();
    stopAudioMirror();
    view.endedAt = performance.now();
    waitText.textContent = 'This game has ended.';
    waitEl.classList.remove('hidden');
});

net.onReconnect(() => {
    // The room restarted: re-subscribe to the same player if they're still live.
    if (view.target && view.game) {
        closePc();
        resetView();
        net.send({ type: 'spec:watch', target: view.target });
    }
});

// Esc leaves the viewer / closes the list without reaching the game's handlers.
window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (view.target) { e.stopImmediatePropagation(); e.preventDefault(); stopWatching(true); }
    else if (listOpen) { e.stopImmediatePropagation(); e.preventDefault(); closeList(); }
}, true);

// ------------------------------------------------------------ frame loop
let lastListTick = 0;
net.onFrame((now) => {
    if (listOpen && now - lastListTick > 1000) {
        lastListTick = now;
        gamesEl.querySelectorAll('.ss-row-time').forEach(el => {
            const g = games.find(x => x.id === el.dataset.id);
            if (g) el.textContent = fmtElapsed(gameElapsed(g));
        });
    }
    if (!view.target) return;
    if (view.endedAt) {
        if (now - view.endedAt > 2200) stopWatching(true);
        return;
    }
    tickTransport(now);
    const hasPicture = view.usingVideo || view.lastJpeg > 0;
    const stale = now - view.lastData > 5000 && !(view.usingVideo && now - view.lastVideoFrame < 1500);
    if (!hasPicture || stale) {
        waitText.textContent = hasPicture ? 'Waiting for player…' : 'Connecting to player…';
        waitEl.classList.remove('hidden');
    } else {
        waitEl.classList.add('hidden');
    }
    if (view.game) timeEl.textContent = fmtElapsed(gameElapsed(view.game));
});

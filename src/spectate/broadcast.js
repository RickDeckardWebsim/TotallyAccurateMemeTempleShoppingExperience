// Broadcaster side of spectator mode. While this player is in a run, the
// game is advertised in the room. When someone watches, the exact rendered
// frame (first person, through the player's camera) is copied into a
// composite canvas that feeds a WebRTC video stream, with a JPEG relay
// through the room as fallback. The DOM HUD (shopping list, timer, toasts,
// checkout, crosshair, overlays...) is mirrored separately so it stays crisp.

import { net } from './net.js';
import { ICE_SERVERS, SPECTATE_UI_IDS, QUALITY, DEFAULT_QUALITY } from './shared.js';

const COMPOSITE_INTERVAL = 1000 / 30;
const JPEG_INTERVAL = 1000 / 9;
const HUD_INTERVAL = 150;
const HUD_KEEPALIVE = 2000;
const HUD_BUDGET = 56000;

// Menus and chrome that belong to the main menu, never to the live run.
const HUD_SKIP_IDS = new Set([
    'main-menu', 'customization-menu', 'settings-menu', 'leaderboard-menu',
    'open-shop', 'shop-menu', 'open-achievements', 'achievements-menu',
    'mute-toggle', 'version-label', 'menu-bg', 'achievement-toasts',
    ...SPECTATE_UI_IDS,
]);

const state = {
    live: false,
    liveSince: 0,
    lastStatusCheck: 0,
    w: 0,
    h: 0,
    viewers: 0,
    jpegViewers: 0,
    hookedRenderer: null,
    lastComposite: 0,
    lastJpeg: 0,
    jpegQuality: 0.55,
    lastHud: 0,
    lastHudSent: 0,
    lastHudJson: '',
};

const peers = new Map(); // viewerId -> { pc, sender, pending: [] }
const viewerQuality = new Map(); // viewerId -> QUALITY key

function qualityOf(id) { return QUALITY[viewerQuality.get(id)] || QUALITY[DEFAULT_QUALITY]; }

// The composite is shared by every viewer, so it runs at the highest
// quality anyone asked for; each sender is scaled down to its viewer's pick.
function topQuality() {
    let best = QUALITY[DEFAULT_QUALITY];
    for (const id of peers.keys()) { const q = qualityOf(id); if (q.h > best.h) best = q; }
    return best;
}

// ---------------------------------------------------------------- canvases
const composite = document.createElement('canvas');
composite.width = 1280;
composite.height = 720;
const compCtx = composite.getContext('2d', { alpha: false });
compCtx.fillStyle = '#000';
compCtx.fillRect(0, 0, composite.width, composite.height);

const jpegCanvas = document.createElement('canvas');
const jpegCtx = jpegCanvas.getContext('2d', { alpha: false });

let stream = null;
function getStream() {
    if (!stream && composite.captureStream) {
        stream = composite.captureStream(30);
        const t = stream.getVideoTracks()[0];
        try { if (t) t.contentHint = 'motion'; } catch (_) {}
    }
    return stream;
}

function fitSize(srcW, srcH, maxW, maxH) {
    const s = Math.min(1, maxW / srcW, maxH / srcH);
    return [Math.max(2, Math.round(srcW * s) & ~1), Math.max(2, Math.round(srcH * s) & ~1)];
}

// ------------------------------------------------------------ frame capture
// Runs synchronously right after every renderer.render() call, while the
// WebGL drawing buffer still holds the finished frame.
function afterRender(canvas) {
    if (!state.live || state.viewers === 0 || !canvas || !canvas.width) return;
    const now = performance.now();
    if (now - state.lastComposite < COMPOSITE_INTERVAL) return;
    state.lastComposite = now;

    const top = topQuality();
    const [cw, ch] = fitSize(canvas.width, canvas.height, Math.round(top.h * 16 / 9) * 2, top.h);
    if (composite.width !== cw || composite.height !== ch) {
        composite.width = cw;
        composite.height = ch;
        retuneAll();
    }
    try {
        compCtx.drawImage(canvas, 0, 0, cw, ch);
        // Extra full-screen WebGL overlays (e.g. the jumpscare) are part of what the player sees.
        const js = document.getElementById('jumpscare-canvas');
        if (js && js.width && js.offsetParent !== null && getComputedStyle(js).display !== 'none') {
            compCtx.drawImage(js, 0, 0, cw, ch);
        }
    } catch (_) { return; }

    if (state.jpegViewers > 0 && now - state.lastJpeg >= JPEG_INTERVAL) {
        state.lastJpeg = now;
        sendJpeg(cw, ch);
    }
}

function sendJpeg(cw, ch) {
    const jmax = topQuality().jw;
    const [jw, jh] = fitSize(cw, ch, jmax, jmax);
    if (jpegCanvas.width !== jw || jpegCanvas.height !== jh) {
        jpegCanvas.width = jw;
        jpegCanvas.height = jh;
    }
    jpegCtx.drawImage(composite, 0, 0, jw, jh);
    let d;
    try { d = jpegCanvas.toDataURL('image/jpeg', state.jpegQuality); } catch (_) { return; }
    // Keep each frame comfortably under the room's 64 KB message cap.
    if (d.length > 52000) state.jpegQuality = Math.max(0.2, state.jpegQuality - 0.08);
    else if (d.length < 30000) state.jpegQuality = Math.min(0.7, state.jpegQuality + 0.02);
    if (d.length > 59000) return;
    net.send({ type: 'spec:frame', d });
}

// Other modules (the replay recorder) can also watch finished screen frames.
const frameListeners = new Set();
export function onScreenFrame(fn) { frameListeners.add(fn); }

function hookRenderer(renderer) {
    if (!renderer || renderer === state.hookedRenderer) return;
    state.hookedRenderer = renderer;
    if (renderer.__ssHooked) return;
    renderer.__ssHooked = true;
    const orig = renderer.render;
    renderer.render = function (...args) {
        const r = orig.apply(this, args);
        // Only frames drawn to the screen (not render-target passes).
        if (!this.getRenderTarget || this.getRenderTarget() === null) {
            afterRender(this.domElement);
            for (const fn of frameListeners) { try { fn(this.domElement); } catch (_) {} }
        }
        return r;
    };
}

// --------------------------------------------------------------- HUD mirror
function serializeNode(el) {
    if (el.nodeType !== 1) return '';
    const tag = el.tagName;
    if (tag === 'CANVAS' || tag === 'SCRIPT' || tag === 'AUDIO' || tag === 'VIDEO' || tag === 'STYLE') return '';
    if (el.id && HUD_SKIP_IDS.has(el.id)) return '';
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return '';
    return el.outerHTML;
}

export function captureHud() {
    const gc = document.getElementById('game-container');
    if (!gc) return null;
    const parts = [];
    let size = 0;
    for (const child of gc.children) {
        const html = serializeNode(child);
        if (!html) continue;
        if (size + html.length > HUD_BUDGET) continue;
        size += html.length;
        parts.push(html);
    }
    const extra = [];
    for (const child of document.body.children) {
        if (child === gc || child.tagName === 'SCRIPT') continue;
        const html = serializeNode(child);
        if (!html || size + html.length > HUD_BUDGET) continue;
        size += html.length;
        extra.push(html);
    }
    const canvas = state.hookedRenderer?.domElement;
    let cv = null;
    if (canvas) {
        const ccs = getComputedStyle(canvas);
        cv = {
            f: ccs.filter !== 'none' ? ccs.filter : '',
            t: canvas.style.transform || '',
            o: ccs.opacity !== '1' ? ccs.opacity : '',
        };
    }
    return {
        w: window.innerWidth,
        h: window.innerHeight,
        cls: gc.className,
        st: gc.getAttribute('style') || '',
        bcls: document.body.className,
        html: parts.join(''),
        extra: extra.join(''),
        cv,
    };
}

function tickHud(now) {
    if (now - state.lastHud < HUD_INTERVAL) return;
    state.lastHud = now;
    const hud = captureHud();
    if (!hud) return;
    const json = JSON.stringify(hud);
    if (json === state.lastHudJson && now - state.lastHudSent < HUD_KEEPALIVE) return;
    if (json.length > 60000) return;
    state.lastHudJson = json;
    state.lastHudSent = now;
    net.send({ type: 'spec:hud', h: hud });
}

// ----------------------------------------------------------------- WebRTC
function closePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    try { p.pc.close(); } catch (_) {}
}

function closeAllPeers() {
    [...peers.keys()].forEach(closePeer);
}

function retuneAll() {
    for (const [id, p] of peers) if (p.sender) tuneSender(p.sender, id);
}

async function tuneSender(sender, viewerId) {
    try {
        const q = qualityOf(viewerId);
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = q.br;
        params.encodings[0].scaleResolutionDownBy = Math.max(1, composite.height / q.h);
        params.encodings[0].maxFramerate = 30;
        // Above 720p, keep the chosen resolution instead of letting the encoder shrink it.
        params.degradationPreference = q.h > 720 ? 'maintain-resolution' : 'maintain-framerate';
        await sender.setParameters(params);
    } catch (_) {}
}

async function startPeer(viewerId) {
    closePeer(viewerId);
    const s = getStream();
    if (!s || typeof RTCPeerConnection === 'undefined') return;
    const track = s.getVideoTracks()[0];
    if (!track) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { pc, sender: null, pending: [] };
    peers.set(viewerId, entry);
    entry.sender = pc.addTrack(track, s);
    pc.onicecandidate = (e) => {
        if (e.candidate) net.send({ type: 'spec:rtc', to: viewerId, data: { candidate: e.candidate.toJSON() } });
    };
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await tuneSender(entry.sender, viewerId);
        net.send({ type: 'spec:rtc', to: viewerId, data: { sdp: pc.localDescription.toJSON() } });
    } catch (e) {
        console.warn('[spectate] offer failed', e);
        closePeer(viewerId);
    }
}

async function onRtc(msg) {
    const from = msg.from;
    const data = msg.data || {};
    if (data.restart) { if (state.live) startPeer(from); return; }
    const entry = peers.get(from);
    if (!entry) return;
    const { pc } = entry;
    try {
        if (data.sdp && data.sdp.type === 'answer') {
            await pc.setRemoteDescription(data.sdp);
            for (const c of entry.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        } else if (data.candidate) {
            if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
            else entry.pending.push(data.candidate);
        }
    } catch (e) {
        console.warn('[spectate] rtc error', e);
    }
}

// ---------------------------------------------------------- watcher badge
const badge = document.createElement('div');
badge.id = 'ss-watchers';
badge.className = 'hidden';
document.body.appendChild(badge);

function renderBadge() {
    const n = state.live ? state.viewers : 0;
    badge.classList.toggle('hidden', n === 0);
    badge.textContent = `👁 ${n} watching`;
}

// ----------------------------------------------------------- status loop
function sendStatus(force = false) {
    net.send({
        type: 'spec:status',
        live: state.live,
        elapsed: state.live ? Date.now() - state.liveSince : 0,
        w: state.w,
        h: state.h,
        force,
    });
}

function setCounts(msg) {
    if (typeof msg.viewers === 'number') state.viewers = msg.viewers;
    if (typeof msg.jpeg === 'number') state.jpegViewers = msg.jpeg;
    renderBadge();
}

net.on('spec:viewer-join', (msg) => {
    setCounts(msg);
    if (state.live) {
        state.lastHudJson = ''; // push a fresh HUD for the newcomer
        startPeer(msg.viewer);
    }
});
net.on('spec:viewer-left', (msg) => { setCounts(msg); closePeer(msg.viewer); viewerQuality.delete(msg.viewer); });
net.on('spec:quality', (msg) => {
    if (!QUALITY[msg.q]) return;
    viewerQuality.set(msg.viewer, msg.q);
    retuneAll();
});
net.on('spec:jpeg', setCounts);
// Self-heal from the periodic ping reply: server's view of who is watching.
net.on('spec:pong', (msg) => {
    if (!state.live) return;
    if (!msg.live) { sendStatus(true); return; }
    setCounts(msg);
    const vids = new Set(msg.vids || []);
    for (const id of vids) if (!peers.has(id)) { state.lastHudJson = ''; startPeer(id); }
    for (const id of [...peers.keys()]) if (!vids.has(id)) closePeer(id);
});
net.on('spec:rtc', onRtc);

net.onReconnect(() => {
    // The room restarted or we rejoined: viewers were dropped server-side.
    closeAllPeers();
    state.viewers = 0;
    state.jpegViewers = 0;
    renderBadge();
    if (state.live) sendStatus(true);
});

net.onFrame((now) => {
    if (now - state.lastStatusCheck > 400) {
        state.lastStatusCheck = now;
        const gs = typeof window.__ssGameState === 'function' ? window.__ssGameState() : null;
        const live = !!(gs && gs.live && !window.__ssIsSpectating);
        if (gs && gs.renderer) hookRenderer(gs.renderer);
        const w = window.innerWidth, h = window.innerHeight;
        if (live !== state.live) {
            state.live = live;
            if (live) {
                state.liveSince = Date.now();
                state.w = w; state.h = h;
            } else {
                closeAllPeers();
                state.viewers = 0;
                state.jpegViewers = 0;
            }
            renderBadge();
            sendStatus();
        } else if (live && (w !== state.w || h !== state.h)) {
            state.w = w; state.h = h;
            sendStatus();
        }
    }
    if (state.live && state.viewers > 0) tickHud(now);
});

// True while this player is in a run and at least one person is watching.
export function isStreaming() { return state.live && state.viewers > 0; }

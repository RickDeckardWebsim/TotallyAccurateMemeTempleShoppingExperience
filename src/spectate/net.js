// Spectator mode networking: one shared realtime room connection plus a
// requestAnimationFrame-driven scheduler. (The game's hardStopGame() clears
// every setTimeout/setInterval on the page, so nothing here relies on timers.)

const handlers = new Map();   // type -> Set<fn>
const reconnectFns = new Set();
const frameFns = new Set();

let room = null;
let connecting = false;
let lastPong = 0;
let lastPing = 0;
let retryAt = 0;
let serverOffset = 0; // local Date.now() - server Date.now()

export const net = {
    myId: null,
    get connected() { return !!room; },
    serverNow() { return Date.now() - serverOffset; },
    toLocalTime(serverMs) { return serverMs + serverOffset; },

    on(type, fn) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type).add(fn);
    },
    onReconnect(fn) { reconnectFns.add(fn); },
    onFrame(fn) { frameFns.add(fn); },

    send(msg) {
        if (!room) return false;
        try { room.send(msg); return true; } catch (_) { return false; }
    },
};

function dispatch(msg) {
    if (typeof msg.now === 'number') serverOffset = Date.now() - msg.now;
    const set = handlers.get(msg.type);
    if (set) set.forEach(fn => { try { fn(msg); } catch (e) { console.warn('[spectate]', e); } });
}

async function connect() {
    if (connecting || room) return;
    if (typeof WebsimSocket === 'undefined' || !WebsimSocket.joinRoom) {
        retryAt = performance.now() + 4000;
        return;
    }
    connecting = true;
    try {
        const r = await WebsimSocket.joinRoom();
        room = r;
        lastPong = performance.now();
        r.onmessage = (event) => {
            let msg;
            try { msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch (_) { return; }
            if (!msg || typeof msg.type !== 'string') return;
            lastPong = performance.now();
            if (msg.type === 'spec:welcome') net.myId = msg.id;
            dispatch(msg);
        };
        r.onreconnect = () => {
            lastPong = performance.now();
            reconnectFns.forEach(fn => { try { fn(); } catch (_) {} });
        };
        r.onclose = () => {
            if (room === r) room = null;
            retryAt = performance.now() + 3000;
        };
        reconnectFns.forEach(fn => { try { fn(); } catch (_) {} });
    } catch (e) {
        console.warn('[spectate] could not join room', e);
        retryAt = performance.now() + 5000;
    } finally {
        connecting = false;
    }
}

function loop() {
    const now = performance.now();
    if (!room && !connecting && now >= retryAt) connect();
    if (room) {
        if (now - lastPing > 5000) { lastPing = now; net.send({ type: 'spec:ping' }); }
        // Watchdog: no traffic at all for 20s -> rebuild the connection.
        if (now - lastPong > 20000) {
            const dead = room;
            room = null;
            try { dead.close?.(); } catch (_) {}
            retryAt = now + 500;
        }
    }
    frameFns.forEach(fn => { try { fn(now); } catch (e) { console.warn('[spectate]', e); } });
}

// Tick from a dedicated worker: immune to the game's global clearTimeout /
// clearInterval sweep and not paused like requestAnimationFrame in background tabs.
function startTicker() {
    try {
        const src = 'setInterval(() => postMessage(0), 33);';
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.onmessage = loop;
        return;
    } catch (_) {}
    const raf = () => { requestAnimationFrame(raf); loop(); };
    requestAnimationFrame(raf);
}
startTicker();
connect();

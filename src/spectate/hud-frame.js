// Shared helpers for showing a mirrored player HUD inside a sandboxed iframe
// (used by the live spectator viewer and the leaderboard replay player).

const STYLESHEETS = ['styles.css', 'side-quests.css', 'thermostat.css', 'nuke.css'];

function baseHref() { return new URL('.', location.href).href; }

export function hudSrcdoc() {
    const links = STYLESHEETS.map(h => `<link rel="stylesheet" href="${h}">`).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><base href="${baseHref()}">
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&family=Patrick+Hand&family=Share+Tech+Mono&display=swap" rel="stylesheet">
${links}
<style>
html,body{background:transparent!important;margin:0;overflow:hidden;pointer-events:none!important}
#game-container{background:transparent!important}
#ss-extra{display:contents}
*{cursor:none!important}
</style></head><body><div id="game-container"></div><div id="ss-extra"></div></body></html>`;
}

const DROP_TAGS = 'script,iframe,object,embed,link,meta,base,frame,frameset,template,noscript,audio,video,form';
export function sanitize(html) {
    const doc = new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}</body>`, 'text/html');
    doc.querySelectorAll(DROP_TAGS).forEach(n => n.remove());
    for (const el of doc.body.querySelectorAll('*')) {
        for (const a of [...el.attributes]) {
            const n = a.name.toLowerCase();
            if (n.startsWith('on') || n === 'autofocus' || n === 'srcdoc' ||
                ((n === 'href' || n === 'src' || n === 'xlink:href' || n === 'action' || n === 'formaction') &&
                 /^\s*(javascript|vbscript):/i.test(a.value))) {
                el.removeAttribute(a.name);
            }
        }
    }
    return doc.body;
}

function syncAttrs(a, b) {
    for (const at of [...a.attributes]) if (!b.hasAttribute(at.name)) a.removeAttribute(at.name);
    for (const at of b.attributes) if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
}

// Index-based DOM morph so running CSS animations (toasts, pulses) are
// preserved between HUD updates instead of restarting every snapshot.
export function morphChildren(from, to) {
    const doc = from.ownerDocument;
    const tc = [...to.childNodes];
    for (let i = 0; i < tc.length; i++) {
        const t = tc[i];
        const f = from.childNodes[i];
        if (!f) { from.appendChild(doc.importNode(t, true)); continue; }
        if (f.nodeType !== t.nodeType || f.nodeName !== t.nodeName || (t.nodeType === 1 && f.id !== t.id)) {
            from.replaceChild(doc.importNode(t, true), f);
            continue;
        }
        if (t.nodeType === 1) { syncAttrs(f, t); morphChildren(f, t); }
        else if (f.nodeValue !== t.nodeValue) f.nodeValue = t.nodeValue;
    }
    while (from.childNodes.length > tc.length) from.removeChild(from.lastChild);
}

// Write one HUD snapshot into a HUD iframe document. Returns false if the
// frame isn't ready yet.
export function writeHud(frame, h) {
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return false;
    const gc = doc.getElementById('game-container');
    const extra = doc.getElementById('ss-extra');
    doc.body.className = String(h.bcls || '');
    if (gc) {
        gc.className = String(h.cls || '');
        gc.setAttribute('style', String(h.st || ''));
        morphChildren(gc, sanitize(String(h.html || '')));
    }
    if (extra) morphChildren(extra, sanitize(String(h.extra || '')));
    return true;
}

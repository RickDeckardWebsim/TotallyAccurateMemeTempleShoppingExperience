// Run seeds: every run gets a self-contained, checksummed seed describing the
// ruleset it was played under. A seed can be verified by any copy of the game
// (fork, local file, websim) with no server: the verifier compares the seed's
// ruleset against its own built-in vanilla defaults.
//
// Seed format: MM2.<payload>.<hash> for every run mode.
// payload = base64url(JSON { id, t, b, r, d, m })
//   id: random run id          t: run start (unix seconds)
//   b:  fingerprint of the vanilla defaults of the build that made the run
//   r:  fingerprint of the full ruleset actually used
//   d:  [key, value] pairs where the ruleset differs from vanilla
//   m:  encoded mode (0 = vanilla, 1 = custom); not a public prefix marker
// hash = checksum over prefix + payload (detects edited or corrupted seeds).

import { CONFIG as PROB_DEFAULTS, PROBABILITIES } from '../config/probabilities.js';
import { DEFAULT_GAME_SETTINGS } from '../config/game-settings.js';
import { GAME_MECHANICS } from '../config/game-mechanics.js';

export const SEED_DEVS = ['kotsoft', 'memetemple', 'rick_deckard'];
export function isSeedDev(username) {
    return !!username && SEED_DEVS.includes(String(username).toLowerCase());
}

const SEED_VERSION = 2;

// Every setting that changes how a run plays. Graphics, audio, keybinds and
// look sensitivity are personal preferences and deliberately not included.
const RULESET_DEFAULTS = Object.freeze({
    ...PROB_DEFAULTS,
    NO_MONEY_CHANCE: PROBABILITIES.NO_MONEY_CHANCE,
    SHELF_COUNT: DEFAULT_GAME_SETTINGS.SHELF_COUNT,
    MIN_SHOPPING_LIST_ITEMS: DEFAULT_GAME_SETTINGS.MIN_SHOPPING_LIST_ITEMS,
    MAX_SHOPPING_LIST_ITEMS: DEFAULT_GAME_SETTINGS.MAX_SHOPPING_LIST_ITEMS,
    CUSTOM_RANDOM_SHELVES: DEFAULT_GAME_SETTINGS.CUSTOM_RANDOM_SHELVES,
    CUSTOM_RANDOM_ITEMS: DEFAULT_GAME_SETTINGS.CUSTOM_RANDOM_ITEMS,
    GAME_SPEED: GAME_MECHANICS.GAME_SPEED,
    MOVE_SPEED: GAME_MECHANICS.MOVE_SPEED,
    GRAVITY: GAME_MECHANICS.GRAVITY,
    ARM_REACH: GAME_MECHANICS.ARM_REACH
});
export const RULESET_KEYS = Object.freeze(Object.keys(RULESET_DEFAULTS).sort());

export function vanillaRulesetValue(key) { return RULESET_DEFAULTS[key]; }

// Normalise a value so equal settings always serialise identically
// (slider strings vs numbers, float noise, undefined vs null).
function norm(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'boolean') return v;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(n * 1e6) / 1e6;
    return String(v);
}

function stableRuleString(rules) {
    return RULESET_KEYS.map(k => `${k}=${JSON.stringify(norm(rules[k]))}`).join(';');
}

// cyrb53: fast 53-bit string hash, returned as 11 base36 chars.
function hash53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, '0');
}

export const VANILLA_FINGERPRINT = hash53(stableRuleString(RULESET_DEFAULTS));

function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    const bin = atob(b64);
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function checksum(prefix, payload, version = SEED_VERSION) {
    return hash53(`magmart-run-seed-v${version}|${prefix}|${payload}`, version);
}

// Snapshot the ruleset keys from a live config object.
export function snapshotRuleset(config) {
    const out = {};
    for (const k of RULESET_KEYS) out[k] = norm(config[k]);
    return out;
}

function randomRunId() {
    const a = new Uint32Array(2);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(a);
    else { a[0] = Math.random() * 2 ** 32; a[1] = Math.random() * 2 ** 32; }
    return (a[0].toString(36) + a[1].toString(36)).slice(0, 10).padEnd(10, '0');
}

// Create the seed for a run that is starting now.
export function createRunSeed(config, isCustomGame) {
    const rules = snapshotRuleset(config);
    const diff = RULESET_KEYS
        .filter(k => norm(rules[k]) !== norm(RULESET_DEFAULTS[k]))
        .map(k => [k, rules[k]]);
    const prefix = `MM${SEED_VERSION}`;
    const body = {
        id: randomRunId(),
        t: Math.floor(Date.now() / 1000),
        b: VANILLA_FINGERPRINT,
        r: hash53(stableRuleString(rules)),
        d: diff,
        m: isCustomGame ? 1 : 0
    };
    const payload = b64urlEncode(JSON.stringify(body));
    const hash = checksum(prefix, payload);
    return {
        seed: `${prefix}.${payload}`,
        hash,
        full: `${prefix}.${payload}.${hash}`,
        runId: body.id,
        mode: isCustomGame ? 'custom' : 'vanilla',
        rulesetIsVanilla: diff.length === 0
    };
}

// Verify a pasted seed. Accepts "SEED.HASH" or "SEED" + separate hash.
export function verifyRunSeed(input, hashInput = '') {
    const text = String(input || '').trim().replace(/\s+/g, '');
    const parts = text.split('.');
    if (parts.length < 2 || parts.length > 3) return { ok: false, verdict: 'invalid', reason: 'Not a MagMart run seed.' };
    const [prefix, payload] = parts;
    const hash = (parts[2] || String(hashInput || '').trim()).toLowerCase();
    // Keep old saved seeds verifiable, but only issue the neutral format.
    const legacy = /^MM([VC])1$/.exec(prefix);
    const version = legacy ? 1 : prefix === `MM${SEED_VERSION}` ? SEED_VERSION : null;
    if (!version) return { ok: false, verdict: 'invalid', reason: 'Unknown seed prefix or version.' };
    if (!hash) return { ok: false, verdict: 'invalid', reason: 'Missing hash.' };
    if (checksum(prefix, payload, version) !== hash) {
        return { ok: false, verdict: 'tampered', reason: 'Hash does not match: the seed was edited or copied incorrectly.' };
    }
    let body;
    try { body = JSON.parse(b64urlDecode(payload)); } catch (_) {
        return { ok: false, verdict: 'invalid', reason: 'Seed payload is unreadable.' };
    }
    if (!body || typeof body !== 'object' || !Array.isArray(body.d) ||
        body.d.some(pair => !Array.isArray(pair) || pair.length !== 2) ||
        (!legacy && body.m !== 0 && body.m !== 1)) {
        return { ok: false, verdict: 'invalid', reason: 'Invalid seed payload.' };
    }
    const claimedCustom = legacy ? legacy[1] === 'C' : body.m === 1;
    const diff = Array.isArray(body.d) ? body.d : [];
    const sameBuild = body.b === VANILLA_FINGERPRINT;

    // Rebuild the full ruleset from this build's defaults + the recorded
    // differences; if it reproduces the run's fingerprint, the diff is complete.
    const rules = { ...RULESET_DEFAULTS };
    for (const [k, v] of diff) rules[k] = v;
    const rulesetConfirmed = sameBuild && hash53(stableRuleString(rules)) === body.r;

    let verdict, reason;
    if (!sameBuild) {
        verdict = 'modified-build';
        reason = 'Played on a build whose vanilla rules differ from this copy of the game.';
    } else if (!rulesetConfirmed) {
        verdict = 'tampered';
        reason = 'Recorded ruleset does not reproduce its fingerprint.';
    } else if (claimedCustom || diff.length > 0) {
        verdict = 'custom';
        reason = claimedCustom ? 'Started from Customize Game.' : 'Vanilla run with non-default rules.';
    } else {
        verdict = 'vanilla';
        reason = 'Official vanilla ruleset.';
    }
    return {
        ok: true,
        verdict,
        reason,
        claimedMode: claimedCustom ? 'custom' : 'vanilla',
        runId: body.id,
        startedAt: body.t ? new Date(body.t * 1000) : null,
        changes: diff.map(([key, value]) => ({ key, value, vanilla: RULESET_DEFAULTS[key] ?? null })),
        buildFingerprint: body.b,
        rulesetFingerprint: body.r,
        hash
    };
}

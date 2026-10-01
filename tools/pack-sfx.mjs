// Builds the game's sound files from the originals, and src/sfx-pack.js: which file plays each sound.
//  - sfx/pack.mp3: the sounds a normal run uses, back to back. Decoded together at page load.
//  - sfx/packed/<name>.mp3: every other WAV the code plays (events: nuke, side quests, phone call, freezer...),
//    one small MP3 each, decoded the first time it plays, so a run only holds the ones that happened.
// The code keeps naming the originals (e.g. 'sfx/nuke_wind.wav'); the engine plays them from these files.
//
//   cd tools && npm i && node pack-sfx.mjs
//
// Run it again after adding or changing a sound. Until then a new sound just loads its own file.
// Decodes with ffmpeg if it's installed, else macOS's afconvert.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Mp3Encoder } from '@breezystack/lamejs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RATE = 48000, KBPS = 128;
const GAP = 0.05;   // silence between sounds (seconds), so one never bleeds into the next
const MARK = 0.05;  // where the alignment click sits in every file (see the engine's loadPack)
// MP3 smears the first and last few ms of a sound that sits next to silence, which a loop would play at its
// seam every time round; so every sound goes in with WRAP seconds of its own tail before it and its own head
// after it (any of them may be looped), and the encoder sees the seam as the continuous audio it is.
const WRAP = 0.05;

// The core pack: the sounds a normal run uses (cart, items, footsteps, doors, UI, checkout).
const CORE = [
    'footsteps-on-wood-floor-14735.wav', 'whu6.wav', 'run.wav', 'key.wav', 'tada.wav', 'squeak-duck.mp3',
    'cartoonslip.mp3', 'beep2.mp3', 'Kerplunk.wav', 'slap.mp3', 'Cash_Register_Open_01.wav',
    '20200624_Cartoon Splat sound effect.wav',
    'ES_Notification, Attention, Text, Reveal, Positive 01 - Epidemic Sound - 4178-4632.wav',
    'sfx/cart_drop.wav', 'sfx/ui_hover.wav', 'sfx/ui_click.wav', 'sfx/entrance_beep.wav',
];
// the soundboard picks (src/sound-picks.js) and every item's drop
const picks = fs.readFileSync(path.join(ROOT, 'src/sound-picks.js'), 'utf8').match(/SOUND_PICKS = (\{[\s\S]*\});/);
for (const v of Object.values(picks ? JSON.parse(picks[1]) : {})) if (!CORE.includes(v.src)) CORE.push(v.src);
for (const f of fs.readdirSync(path.join(ROOT, 'sfx/drops')).sort()) if (/\.(mp3|wav|ogg)$/.test(f) && !CORE.includes('sfx/drops/' + f)) CORE.push('sfx/drops/' + f);

// Event sounds: every other WAV/OGG/Opus file the code names (music and other MP3s stream as they are)
const code = ['game.js', ...fs.readdirSync(path.join(ROOT, 'src'), { recursive: true }).filter((f) => f.endsWith('.js') && f !== 'sfx-pack.js').map((f) => 'src/' + f)]
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const EVENTS = [...new Set([...code.matchAll(/['"]([^'"\n]+\.(?:wav|ogg|opus))['"]/g)].map((m) => m[1]))]
    .filter((f) => !CORE.includes(f) && fs.existsSync(path.join(ROOT, f))).sort();

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } })();
const tmp = path.join(os.tmpdir(), 'pack-sfx.f32');
// a file as mono float samples at RATE, read the way a browser reads it (its header as written)
function decode(file) {
    if (hasFfmpeg) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', tmp]);
    else execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEF32@${RATE}`, '-c', '1', file, tmp + '.wav']);
    const b = fs.readFileSync(hasFfmpeg ? tmp : tmp + '.wav');
    let data = b;
    if (!hasFfmpeg) { // find the WAV's data chunk
        let o = 12; while (o < b.length - 8 && b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4);
        data = b.subarray(o + 8, o + 8 + b.readUInt32LE(o + 4));
    }
    return new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~3)));
}

const sounds = {};
// Writes these sounds into one MP3 (the click first, then each sound) and notes where each one is.
function build(out, files) {
    const parts = [];
    let at = 0;
    const push = (x) => { parts.push(x); at += x.length; };
    const silence = (sec) => push(new Float32Array(Math.round(sec * RATE)));
    silence(MARK);
    push(new Float32Array(Math.round(0.002 * RATE)).fill(0.9));
    silence(0.2);
    for (const rel of files) {
        const file = path.join(ROOT, rel);
        if (!fs.existsSync(file)) { console.warn('missing, skipped:', rel); continue; }
        const x = decode(file), w = Math.min(x.length, Math.round(WRAP * RATE));
        push(x.slice(x.length - w));
        sounds[rel] = [out, +(at / RATE).toFixed(5), +(x.length / RATE).toFixed(5)];
        push(x);
        push(x.slice(0, w));
        silence(GAP);
    }
    const pcm = new Int16Array(at);
    let o = 0;
    for (const p of parts) for (let i = 0; i < p.length; i++) pcm[o++] = Math.round(Math.max(-1, Math.min(1, p[i])) * 32767);
    const enc = new Mp3Encoder(1, RATE, KBPS), mp3 = [];
    for (let i = 0; i < pcm.length; i += 1152) { const m = enc.encodeBuffer(pcm.subarray(i, i + 1152)); if (m.length) mp3.push(Buffer.from(m)); }
    mp3.push(Buffer.from(enc.flush()));
    const bytes = Buffer.concat(mp3);
    fs.writeFileSync(path.join(ROOT, out), bytes);
    return bytes.length;
}

const core = build('sfx/pack.mp3', CORE);
console.log(`sfx/pack.mp3: ${CORE.length} sounds, ${(core / 1048576).toFixed(2)} MB`);
const DIR = 'sfx/packed', made = new Set();
fs.mkdirSync(path.join(ROOT, DIR), { recursive: true });
let events = 0, before = 0;
for (const rel of EVENTS) {
    const name = path.basename(rel).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') + '.mp3';
    if (made.has(name)) throw new Error(`two sounds would both be ${DIR}/${name}: rename one`);
    made.add(name);
    events += build(`${DIR}/${name}`, [rel]);
    before += fs.statSync(path.join(ROOT, rel)).size;
}
for (const f of fs.readdirSync(path.join(ROOT, DIR))) if (!made.has(f)) fs.rmSync(path.join(ROOT, DIR, f)); // (no longer used)
console.log(`${DIR}/: ${EVENTS.length} event sounds, ${(before / 1048576).toFixed(1)} MB as originals -> ${(events / 1048576).toFixed(1)} MB`);

fs.writeFileSync(path.join(ROOT, 'src/sfx-pack.js'), `// Generated by tools/pack-sfx.mjs (cd tools && npm i && node pack-sfx.mjs).
// Which file plays each sound: the name the code uses -> [file, start, duration] (seconds into that file).
// sfx/pack.mp3 (load: decoded at page load) holds the sounds every run uses; each event sound has its own small
// file in sfx/packed/, decoded the first time it plays. Every file starts with a click at \`mark\` seconds (the
// engine finds it to correct for MP3 decoder padding).
//
// Adding a sound: nothing to do here. A file that isn't listed loads on its own, as it always did.
// CHANGING a sound that's listed (new audio, same file name): this still plays the old audio, so either run
// the tool again, or delete that sound's line below and it loads its own file again.
export const SFX_PACK = { mark: ${MARK}, load: ['sfx/pack.mp3'], sounds: {
${Object.entries(sounds).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}
} };
`);

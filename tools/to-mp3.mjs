// Converts audio files to MP3 next to them (same name, .mp3): node to-mp3.mjs <file> ...
// For long tracks (music, ambience) that are too big as WAV. Paths are from the game's root folder.
// Decodes with ffmpeg if it's installed, else macOS's afconvert.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Mp3Encoder } from '@breezystack/lamejs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const KBPS = 192, tmp = path.join(os.tmpdir(), 'to-mp3.f32');
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } })();
for (const rel of process.argv.slice(2)) {
    const file = path.resolve(ROOT, rel);
    const info = hasFfmpeg ? null : execFileSync('afinfo', [file], { encoding: 'utf8' });
    const ch = info ? Math.min(2, +info.match(/(\d+) ch/)[1]) : 2;
    const rate = info ? +info.match(/ch, +(\d+) Hz/)[1] : 48000;
    if (hasFfmpeg) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-ac', '2', '-ar', String(rate), '-f', 'f32le', tmp]);
    else execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEF32@${rate}`, '-c', String(ch), file, tmp + '.wav']);
    let b = fs.readFileSync(hasFfmpeg ? tmp : tmp + '.wav');
    if (!hasFfmpeg) { let o = 12; while (b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4); b = b.subarray(o + 8, o + 8 + b.readUInt32LE(o + 4)); }
    const x = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length & ~3)));
    const n = x.length / ch, L = new Int16Array(n), R = new Int16Array(n);
    const s16 = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
    for (let i = 0; i < n; i++) { L[i] = s16(x[i * ch]); R[i] = s16(x[i * ch + ch - 1]); }
    const enc = new Mp3Encoder(ch, rate, KBPS), out = [];
    for (let i = 0; i < n; i += 1152) { const m = ch === 2 ? enc.encodeBuffer(L.subarray(i, i + 1152), R.subarray(i, i + 1152)) : enc.encodeBuffer(L.subarray(i, i + 1152)); if (m.length) out.push(Buffer.from(m)); }
    out.push(Buffer.from(enc.flush()));
    const dest = file.replace(/\.[^.]+$/, '.mp3');
    fs.writeFileSync(dest, Buffer.concat(out));
    console.log(path.relative(ROOT, dest), (fs.statSync(file).size / 1048576).toFixed(1), '->', (fs.statSync(dest).size / 1048576).toFixed(1), 'MB');
}

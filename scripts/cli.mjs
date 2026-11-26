#!/usr/bin/env node
/* Build a place pack from the command line.
   node scripts/cli.mjs "Budapest" [--size 6000] [--n 512] [--lat 47.49 --lon 19.04] [--no-buildings] [--out budapest.place.json] [--preview budapest.png] */

import fs from 'node:fs';
import { deflateSync } from 'node:zlib';
import { buildPlace, encodePlace } from './geo/place.js';

const args = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const query = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--no-buildings', '--no-roads'].includes(args[i - 1])));
const opts = {
  query, lat: flag('lat') != null ? +flag('lat') : undefined, lon: flag('lon') != null ? +flag('lon') : undefined,
  sizeM: flag('size') ? +flag('size') : undefined, n: flag('n') ? +flag('n') : undefined,
  buildings: args.includes('--no-buildings') ? false : undefined, roads: args.includes('--no-roads') ? false : undefined,
  log: (m) => console.error('·', m),
};
if (!opts.query && (opts.lat == null || opts.lon == null)) { console.error('usage: cli.mjs "<place>" | --lat <lat> --lon <lon> [--size m] [--n cells] [--out file]'); process.exit(1); }

const p = await buildPlace(opts);
const N = p.meta.n ** 2;
let hmin = Infinity, hmax = -Infinity, water = 0, bld = 0, road = 0, cover = 0, bmax = 0;
for (let k = 0; k < N; k++) {
  hmin = Math.min(hmin, p.height[k]); hmax = Math.max(hmax, p.height[k]);
  if (p.kind[k] & 1) water++; if ((p.kind[k] >> 1) & 15) road++; if (p.kind[k] >> 5) cover++; if (p.bld[k] > 0) { bld++; bmax = Math.max(bmax, p.bld[k]); }
}
const enc = await encodePlace(p);
const json = JSON.stringify(enc);
console.error(`· terrain ${Math.round(hmin)}–${Math.round(hmax)} m · water ${(100 * water / N).toFixed(1)}% · buildings ${(100 * bld / N).toFixed(1)}% (max ${Math.round(bmax)} m) · roads ${(100 * road / N).toFixed(1)}% · land cover ${(100 * cover / N).toFixed(1)}% · pack ${(json.length / 1024).toFixed(0)} KB`);
console.error('· labels:', p.labels.slice(0, 8).map((l) => l.name).join(', '));
const out = flag('out');
if (out) fs.writeFileSync(out, json);

const prev = flag('preview');
if (prev) {
  const n = p.meta.n, rows = [];
  for (let j = 0; j < n; j++) {
    const row = Buffer.alloc(1 + n * 3); // filter byte 0 + RGB
    for (let i = 0; i < n; i++) {
      const k = j * n + i, t = (p.height[k] - hmin) / Math.max(1, hmax - hmin);
      let c = [200 + t * 40, 195 + t * 40, 170 + t * 50];
      const cov = p.kind[k] >> 5;
      if (cov) c = [null, [120, 170, 90], [50, 100, 55], [205, 195, 120], [235, 220, 170], [150, 140, 132], [235, 242, 248], [110, 140, 100]][cov];
      if ((p.kind[k] >> 1) & 15) c = [70, 70, 75];
      if (p.bld[k] > 0) c = [230, 225, 215].map((v) => v - Math.min(80, p.bld[k]));
      if (p.kind[k] & 1) c = [50, 110, 170];
      row.set(c.map((v) => Math.max(0, Math.min(255, v | 0))), 1 + i * 3);
    }
    rows.push(row);
  }
  fs.writeFileSync(prev, png(n, n, Buffer.concat(rows)));
  console.error(`· preview → ${prev}`);
}

/** Minimal RGB PNG encoder (zlib + CRC32). */
function png(w, h, raw) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

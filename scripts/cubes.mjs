#!/usr/bin/env node
/* Build a place out of real Spline cube instances (over the Spline MCP).
   Every visible voxel is a copy of one Cube per material, drawn instanced:
   bevel the cube, resize it or change its material in the editor and the
   whole class follows. Writes two run_code scripts; run them in order.

   node scripts/cubes.mjs "Budapest" | --lat 47.507 --lon 19.045 [--name Budapest]
        [--size 4000] [--n 128] [--style strata] [--frame crop|immersive]
        [--slab 6] [--aspect 1] [--exag 1.2] [--width 614]
        [--gap 0.94] [--round 0.12] [--out ./cubes-budapest]

   --n 96–160: Budapest at 128 is ~21k cubes, a mountain ~34k. --gap is the cube's
   size as a fraction of a voxel (1 = touching); --round its corner radius. */

import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { buildPlace } from './geo/place.js';
import { placeColumns } from './builder/place-scene.js';
import { STYLES, ROWS, ROW_COUNT } from './builder/styles.js';
import { placeMaterials } from './builder/glb.js';
import { inflate } from './bake/inflate.js';
import { b64 } from './bake/mesher.js';
import { cubeBuild } from './bake/cubes.js';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const query = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const n = Math.max(48, Math.min(192, +flag('n', 128)));
const styleKey = flag('style', 'strata'), style = STYLES[styleKey];
if (!style) { console.error(`unknown style "${styleKey}" — one of ${Object.keys(STYLES).join(', ')}`); process.exit(1); }
const crop = flag('frame', 'crop') !== 'immersive';
const voxel = +flag('width', 614) / n;

const pack = await buildPlace({
  query, lat: flag('lat') != null ? +flag('lat') : undefined, lon: flag('lon') != null ? +flag('lon') : undefined,
  name: flag('name'), sizeM: flag('size') ? +flag('size') : undefined, n, log: (m) => console.error('·', m),
});
const name = pack.meta.name.split(',')[0];
const base = crop ? Math.max(4, Math.round((n * +flag('slab', 6)) / 100)) : 2;
const cols = placeColumns(pack, { exag: flag('exag') ? +flag('exag') : undefined, trees: true, base });
if (Math.max(...cols.col) > 255) { console.error('columns taller than 255 voxels: lower --exag or --n'); process.exit(1); }

// material per cell: the same table and names as the .glb export
const { M, wallOf, roofOf } = placeMaterials(style);
const COVER = { grass: 'Grass', wood: 'Forest', farmland: 'Fields', sand: 'Sand', rock: 'Rock', ice: 'Ice', wetland: 'Wetland' };
const names = [], idx = (m) => { let i = names.indexOf(m); if (i < 0) { names.push(m); i = names.length - 1; } return i; };
const sides = idx('Ground · Sides');
const aspect = crop ? Math.max(1, +flag('aspect', 1)) : 1;
const rowsN = Math.max(8, Math.min(n, Math.round(n / aspect))), zA = Math.floor((n - rowsN) / 2), zB = zA + rowsN, S = rowsN * n;
const raw = new Uint8Array(S * 4);
for (let z = zA; z < zB; z++) for (let x = 0; x < n; x++) {
  const k = z * n + x, j = (z - zA) * n + x, r = ROWS[Math.min(ROWS.length - 1, Math.floor(cols.v[k] * ROW_COUNT))], u = cols.u[k];
  const topName = r === 'building' ? roofOf(u) : r === 'water' ? (u < 0.12 ? 'Water · Shore' : u < 0.6 ? 'Water' : 'Water · Deep') : r === 'road' ? 'Roads' : r === 'tree' ? 'Trees' : COVER[r] || (u < 0.34 ? 'Ground · Low' : u < 0.67 ? 'Ground · Mid' : 'Ground · High');
  const wallName = r === 'building' ? wallOf(u) : r === 'tree' ? 'Trees' : r === 'water' ? 'Water · Deep' : 'Ground · Sides';
  raw[j] = cols.col[k]; raw[S + j] = cols.terr[k]; raw[2 * S + j] = idx(topName); raw[3 * S + j] = idx(wallName);
}
for (let i = 1; i <= 4; i++) idx('Strata ' + i);
const data = deflateRawSync(raw, { level: 9 }).toString('base64');
const back = inflate(b64(data));
if (back.length !== raw.length || back.some((v, i) => v !== raw[i])) throw new Error('payload round-trip failed');

const out = path.resolve(flag('out', `cubes-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`));
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) if (/^\d\d-.*\.js$/.test(f)) fs.unlinkSync(path.join(out, f));
const prefix = name;
const used = names.filter((m) => M[m]);
const MATS = used.map((m) => [m, M[m].color, M[m].roughness]);
const files = [];
const write = (file, code) => { fs.writeFileSync(path.join(out, file), code); files.push([file, code.length]); };
write('00-materials.js', [
  `// Place to 3D cubes: ${name} — one material asset per class (shared with the .glb names)`,
  `const M = ${JSON.stringify(MATS)};`,
  `for (const [m, c, r] of M) { mesh('Cube', { width: 10, height: 10, depth: 10 }); color(c); shading({ category: 'physical', roughness: r, metalness: 0 }); createMaterial(${JSON.stringify(prefix + ' ')} + m); remove(); }`,
  `background(${JSON.stringify(style.background)});`,
  `report({ materials: M.length });`,
].join('\n'));
const C = { n, zA, zB, voxel, offX: (-n * voxel) / 2, offZ: (-n * voxel) / 2, crop, band: Math.max(2, Math.round(base / 5)), prefix, names, sides, size: +flag('gap', 0.94), round: +flag('round', 0.12) };
write('01-cubes.js', [
  `// Place to 3D cubes: ${name} — ${n}×${rowsN} columns as cube instances`,
  [inflate, b64, cubeBuild].map((f) => f.toString()).join('\n'),
  `const C = ${JSON.stringify(C)};`,
  `const D = '${data}';`,
  `const r = cubeBuild(C, inflate(b64(D)));`,
  `select(o => o.name.startsWith(${JSON.stringify(prefix + ' ')}) && !o.isCamera && !o.isLight);`,
  `group(); rename(${JSON.stringify(name + ' (cubes)')});`,
  `lookFrom({ azimuth: -35, elevation: 28 });`,
  `report(r);`,
].join('\n'));
const total = files.reduce((a, [, s]) => a + s, 0);
console.error(`· ${n}×${rowsN} columns · ${used.length} materials · ${files.length} scripts · ${(total / 1024).toFixed(0)} KB (≈ ${Math.round(total / 3.2 / 1000)}k tokens) → ${out}`);
console.error('· run each file in order with 3d_run_code: ' + files.map(([f, s]) => `${f} (${(s / 1024).toFixed(1)} KB)`).join(', '));
console.error(`· attribution to show with the scene: ${pack.meta.attribution}`);

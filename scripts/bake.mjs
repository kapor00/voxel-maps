#!/usr/bin/env node
/* Bake a place into real, editable Spline objects.
   Writes a short series of run_code scripts; run them in order with the Spline MCP's
   3d_run_code (each is one call). The result is ordinary meshes grouped under the place's
   name, with one Spline material asset per class (Ground, Grass, Water, Roads, Roofs, …),
   so it is edited, restyled and exported like anything else in Spline — and it renders
   everywhere, <spline-viewer> and WebGL included.

   node scripts/bake.mjs "Budapest" | --lat 47.507 --lon 19.045
        [--size 4000] [--n 160] [--style strata] [--frame crop|immersive]
        [--slab 6] [--aspect 1] [--vitrine 1] [--exag 1.2] [--width 614] [--out ./bake-budapest]

   --n is cells per side (96–224). Bigger means more detail and more tokens to send:
   about 3–10 KB of data per script, 4–8 scripts for a city at 160. */

import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { buildPlace } from './geo/place.js';
import { placeColumns } from './builder/place-scene.js';
import { STYLES, ROWS, ROW_COUNT } from './builder/styles.js';
import { placeMaterials } from './builder/glb.js';
import { inflate } from './bake/inflate.js';
import { b64, bakeBand } from './bake/mesher.js';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const query = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const n = Math.max(64, Math.min(256, +flag('n', 160)));
const styleKey = flag('style', 'strata'), style = STYLES[styleKey];
if (!style) { console.error(`unknown style "${styleKey}" — one of ${Object.keys(STYLES).join(', ')}`); process.exit(1); }
const crop = flag('frame', 'crop') !== 'immersive';
const worldWidth = +flag('width', 614), voxel = worldWidth / n;

const pack = await buildPlace({
  query, lat: flag('lat') != null ? +flag('lat') : undefined, lon: flag('lon') != null ? +flag('lon') : undefined,
  name: flag('name'), sizeM: flag('size') ? +flag('size') : undefined, n, log: (m) => console.error('·', m),
});
const name = pack.meta.name.split(',')[0];
const prefix = name;
const base = crop ? Math.max(3, Math.round((n * +flag('slab', 6)) / 100)) : 2;
const cols = placeColumns(pack, { exag: flag('exag') ? +flag('exag') : undefined, trees: true, base });
const span = Math.max(1, ...cols.terr) - base || 1;

// cell → bake class
const N = n * n, cls = new Uint8Array(N);
for (let k = 0; k < N; k++) {
  const row = ROWS[Math.floor(cols.v[k] * ROW_COUNT)];
  const tier = (cols.terr[k] - base) / span;
  cls[k] = { grass: 1, farmland: 1, wetland: 1, wood: 2, sand: 3, rock: 4, ice: 5, water: 6, road: 7, building: 8, tree: 9 }[row] ?? (tier < 0.34 ? 0 : tier < 0.67 ? 10 : 11);
}
if (Math.max(...cols.col) > 255) { console.error('columns taller than 255 voxels: lower --exag or --n'); process.exit(1); }

// colours: the same table the .glb export uses (one flat colour per class)
const { M, wallOf, roofOf } = placeMaterials(style);
const col = (m) => M[m].color;
const MATS = [
  ['Ground Low', col('Ground · Low'), 0.9], ['Ground Mid', col('Ground · Mid'), 0.9], ['Ground High', col('Ground · High'), 0.9],
  ['Grass', col('Grass'), 0.9], ['Forest', col('Forest'), 0.9], ['Sand', col('Sand'), 0.9],
  ['Rock', col('Rock'), 0.85], ['Ice', col('Ice'), 0.5], ['Water', col('Water'), 0.12],
  ['Roads', col('Roads'), 0.8], ['Roofs', col(roofOf(0.05)), 0.75], ['Building Walls', col(wallOf(0.05)), 0.8],
  ['Trees', col('Trees'), 0.9], ['Ground Sides', col('Ground · Sides'), 0.9],
  ...[1, 2, 3, 4].map((j) => [`Strata ${j}`, col('Strata ' + j), 0.9]),
];

const out = path.resolve(flag('out', `bake-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`));
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) if (/^\d\d-.*\.js$/.test(f)) fs.unlinkSync(path.join(out, f));
const files = [];
const write = (file, code) => { fs.writeFileSync(path.join(out, file), code); files.push([file, code.length]); };

// 1. setup: material assets, background
write('00-setup.js', [
  `// Place to 3D bake: ${name} — material assets (one per class, editable in Spline)`,
  `const M = ${JSON.stringify(MATS)};`,
  `for (const [m, c, r] of M) { mesh('Cube', { width: 10, height: 10, depth: 10 }); color(c); shading({ category: 'physical', roughness: r, metalness: 0 }); createMaterial(${JSON.stringify(prefix + ' ')} + m); remove(); }`,
  `background(${JSON.stringify(style.background)});`,
  `report({ materials: M.length });`,
].join('\n'));

// 2. bands of rows, sized so each script carries ≤ ~9 KB of data
const aspect = crop ? Math.max(1, +flag('aspect', 1)) : 1;
const rowsN = Math.max(8, Math.min(n, Math.round(n / aspect))), zA = Math.floor((n - rowsN) / 2), zB = zA + rowsN;
const offX = (-n * voxel) / 2, offZ = -(zA + rowsN / 2) * voxel;
const band = Math.max(2, Math.round(base / 5));
const payload = (r0, r1) => {
  const R0 = Math.max(zA, r0 - 1), R1 = Math.min(zB - 1, r1 + 1), S = (R1 - R0 + 1) * n, raw = new Uint8Array(S * 3);
  for (let z = R0; z <= R1; z++) for (let x = 0; x < n; x++) {
    const k = z * n + x, j = (z - R0) * n + x;
    raw[j] = cols.col[k]; raw[S + j] = cols.terr[k]; raw[2 * S + j] = cls[k];
  }
  return { R0, R1, raw, data: deflateRawSync(raw, { level: 9 }).toString('base64') };
};
const fnSrc = [inflate, b64, bakeBand].map((f) => f.toString()).join('\n');
let id = 1;
for (let r0 = zA; r0 < zB;) {
  let rows = Math.min(zB - r0, 64);
  let p = payload(r0, r0 + rows - 1);
  while (p.data.length > 9000 && rows > 8) { rows = Math.ceil(rows * 0.7); p = payload(r0, r0 + rows - 1); }
  const C = { n, zA, zB, R0: p.R0, R1: p.R1, r0, r1: r0 + rows - 1, voxel, offX, offZ, crop, band, prefix, id: String(id).padStart(2, '0') };
  // self-check: the band decodes back to the same bytes
  const back = inflate(b64(p.data));
  if (back.length !== p.raw.length || back.some((v, i) => v !== p.raw[i])) throw new Error('payload round-trip failed');
  write(`${String(id).padStart(2, '0')}-band.js`, [
    `// Place to 3D bake: ${name} — rows ${C.r0}–${C.r1} of ${zA}–${zB - 1}`,
    fnSrc,
    `const C = ${JSON.stringify(C)};`,
    `const D = '${p.data}';`,
    `report({ band: C.id, meshes: bakeBand(C, inflate(b64(D))) });`,
  ].join('\n'));
  r0 += rows; id++;
}

// 3. the crop's pedestal and wireframe, then group everything under the place's name and frame the view
const W = n * voxel, Dp = rowsN * voxel, H = Math.max(...cols.col) * voxel;
const frameLines = [];
if (crop) {
  frameLines.push(
    `mesh('Cube', { width: ${(W * 1.002).toFixed(2)}, height: ${(W * 0.03).toFixed(2)}, depth: ${(Dp * 1.002).toFixed(2)}, cornerRadius: 0 }); position({ x: 0, y: ${(-W * 0.015).toFixed(2)}, z: 0 }); color(${JSON.stringify(style.pedestal)}); rename(${JSON.stringify(prefix + ' Pedestal')});`,
  );
  const v = +flag('vitrine', 1);
  if (v > 0) {
    const h = Math.max(H * 1.15, W * 0.4) * v, t = Math.max(0.35, W * 0.001), hx = W / 2, hz = Dp / 2;
    const e = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) e.push([sx * hx, h / 2, sz * hz, t, h, t]);
    for (const y of [0, h]) { for (const sz of [-1, 1]) e.push([0, y, sz * hz, W, t, t]); for (const sx of [-1, 1]) e.push([sx * hx, y, 0, t, t, Dp]); }
    frameLines.push(
      `mesh('Cube', { width: 10, height: 10, depth: 10 }); color(${JSON.stringify(style.frame)}); opacity(0.45); createMaterial(${JSON.stringify(prefix + ' Frame')}); remove();`,
      `const E = ${JSON.stringify(e.map((a) => a.map((v2) => +v2.toFixed(2))))};`,
      `for (const [x, y, z, w, h, d] of E) { mesh('Cube', { width: w, height: h, depth: d, cornerRadius: 0 }); position({ x, y, z }); applyMaterial(${JSON.stringify(prefix + ' Frame')}); rename(${JSON.stringify(prefix + ' Frame')}); }`,
    );
  }
}
write(`${String(id++).padStart(2, '0')}-frame.js`, [`// Place to 3D bake: ${name} — ${crop ? 'pedestal and wireframe' : 'nothing to add (immersive)'}`, ...frameLines, `report({ frame: ${crop} });`].join('\n'));
write(`${String(id++).padStart(2, '0')}-group.js`, [
  `// Place to 3D bake: ${name} — group and frame the view`,
  `select(o => o.name.startsWith(${JSON.stringify(prefix + ' ')}) && !o.isCamera && !o.isLight);`,
  `group();`,
  `rename(${JSON.stringify(name + ' (baked)')});`,
  `lookFrom({ azimuth: -35, elevation: 28 });`,
  `report({ grouped: true });`,
].join('\n'));

const total = files.reduce((a, [, s]) => a + s, 0);
console.error(`· ${n}×${rowsN} cells · ${(cols.col.reduce((a, b) => a + b, 0) / 1e6).toFixed(2)}M voxels · ${files.length} scripts · ${(total / 1024).toFixed(0)} KB (≈ ${Math.round(total / 3.2 / 1000)}k tokens) → ${out}`);
console.error('· run each file in order with 3d_run_code: ' + files.map(([f, s]) => `${f} (${(s / 1024).toFixed(1)} KB)`).join(', '));
console.error(`· attribution to show with the scene: ${pack.meta.attribution}`);

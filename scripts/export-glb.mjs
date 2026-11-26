#!/usr/bin/env node
/* Export a place as a .glb to drop into the Spline editor: real, editable objects at full detail.
   Each object is one material ("Roofs · Terracotta", "Water · Deep", "Strata 2", …), grouped under
   the place's name with the crop's pedestal and vitrine. Recolour a class by editing its material;
   per-voxel shading and water depth are vertex colours (a Multiply layer in Spline).

   node scripts/export-glb.mjs "Budapest" | --lat 47.507 --lon 19.045 [--name Budapest]
        [--size 4000] [--n 384] [--style strata] [--frame crop|immersive]
        [--slab 6] [--aspect 1] [--vitrine 1] [--exag 1.2] [--width 614] [--no-trees]
        [--look '{"rows":{"roof":["#c55a3b",…]}}'] [--out budapest.glb]

   --look takes style overrides as JSON (what the scene panel's "Save .glb" hands you
   when the editor's Play preview blocks the download): the edited colour rows win.

   --n 384 is about 1M vertices and 30 MB for a 4 km city; 512 is ~1.6M and 50 MB. */

import fs from 'node:fs';
import path from 'node:path';
import { buildPlace } from './geo/place.js';
import { placeColumns } from './builder/place-scene.js';
import { STYLES } from './builder/styles.js';
import { placeToGLB } from './builder/glb.js';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const query = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const n = Math.max(64, Math.min(768, +flag('n', 384)));
const styleKey = flag('style', 'strata'), preset = STYLES[styleKey];
if (!preset) { console.error(`unknown style "${styleKey}" — one of ${Object.keys(STYLES).join(', ')}`); process.exit(1); }
let look = {};
try { look = flag('look') ? JSON.parse(flag('look')) : {}; } catch { console.error('--look must be JSON'); process.exit(1); }
const style = { ...preset, ...look, rows: { ...preset.rows, ...(look.rows || {}) } };
const frame = flag('frame', 'crop') === 'immersive' ? 'immersive' : 'crop';
const voxel = +flag('width', 614) / n;

const pack = await buildPlace({
  query, lat: flag('lat') != null ? +flag('lat') : undefined, lon: flag('lon') != null ? +flag('lon') : undefined,
  name: flag('name'), sizeM: flag('size') ? +flag('size') : undefined, n, log: (m) => console.error('·', m),
});
const name = pack.meta.name.split(',')[0];
const base = frame === 'crop' ? Math.max(4, Math.round((n * +flag('slab', 6)) / 100)) : 2;
const cols = placeColumns(pack, { exag: flag('exag') ? +flag('exag') : undefined, trees: !args.includes('--no-trees'), base });
const t0 = Date.now();
const { glb, vertices, objects, materials } = placeToGLB(cols, style, {
  voxel, frame, aspect: +flag('aspect', 1), band: Math.max(2, Math.round(base / 5)), vitrine: +flag('vitrine', 1), name,
});
const out = path.resolve(flag('out', `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.glb`));
fs.writeFileSync(out, glb);
console.error(`· ${(vertices / 1e6).toFixed(2)}M vertices · ${objects} objects · ${materials.length} materials · ${(glb.length / 1e6).toFixed(1)} MB in ${Date.now() - t0} ms → ${out}`);
console.error('· drag it into the Spline editor (or File → Import); each material is one class, so recolour it there');
console.error(`· attribution to show with the scene: ${pack.meta.attribution}`);

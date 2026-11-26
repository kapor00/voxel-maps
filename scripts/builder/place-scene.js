/* ── Build a voxel place inside a Spline scene ──
   Runs in a scene's HTML content (inline mode: the Spline public URL, Code
   Export and the editor's Play view). The scene document only carries the
   place, the style and the framing; this module fetches the data and meshes
   it:

     SplinePlace.buildPlaceScene(spline, { lat: 47.507, lon: 19.045, sizeM: 4000, style: 'strata', frame: 'crop' })

   Geometry: one CustomMesh per 64×64-column chunk (≤ 60k vertices) — a top
   quad per column plus side quads only where the neighbour is lower. uv.y
   picks the style's palette row (the cell type), uv.x a 0..1 value within
   it; voxel edges are drawn by the material, so there is no geometry per
   voxel.

   Frames:
     crop       a block cut out of the world: strata on the cut faces, a dark
                pedestal underneath and a faint wireframe box around it
     immersive  no walls; the ground dissolves into the background toward the
                edges, so the place reads as part of an endless world */

import { buildPlace, decodePlace } from '../geo/place.js';
import { STYLES, rowV, voxelMaterial } from './styles.js';

export { STYLES };

// pack land cover id (bits 5..7 of kind) → palette row
const COVER_ROW = [null, 'grass', 'wood', 'farmland', 'sand', 'rock', 'ice', 'wetland'];
const hash2 = (x, y) => { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123; return h - Math.floor(h); };

/**
 * Column heights (in voxels) and per-cell palette coordinates from a place pack.
 * @param o.exag vertical exaggeration (default 1.2 for cities, 1.6 for landscapes)
 * @param o.trees voxel trees on forests (and sparsely on parks), default true
 * @param o.base voxels of ground under the lowest point (the depth of the crop's strata), default 2
 */
export function placeColumns(pack, { exag, trees = true, base: baseVox } = {}) {
  const { n, cell } = pack.meta, N = n * n, { height, bld, kind } = pack;
  const ex = exag ?? (cell > 25 ? 1.6 : 1.2);
  let hmin = Infinity, hmax = -Infinity;
  for (let k = 0; k < N; k++) { if (height[k] < hmin) hmin = height[k]; if (height[k] > hmax) hmax = height[k]; }
  const base = baseVox ?? 2, span = Math.max(1, ((hmax - hmin) / cell) * ex);
  const terr = new Uint16Array(N), col = new Uint16Array(N), u = new Float32Array(N), v = new Float32Array(N);
  // trees are about 12 m tall: one voxel in a city, none at landscape scale (they'd be giants)
  const treeH = cell <= 15 ? 1 : 0;
  let treeCount = 0;
  for (let k = 0; k < N; k++) {
    const t = base + Math.round(((height[k] - hmin) / cell) * ex);
    terr[k] = t;
    const water = kind[k] & 1, road = (kind[k] >> 1) & 15, cover = COVER_ROW[kind[k] >> 5];
    const x = k % n, z = (k / n) | 0;
    if (bld[k] > 0) {
      col[k] = t + Math.max(1, Math.round((bld[k] / cell) * ex));
      u[k] = Math.min(1, bld[k] / 120); v[k] = rowV('building');
    } else if (water) {
      col[k] = t; u[k] = hash2(x, z) * 0.3; v[k] = rowV('water');
    } else if (road) {
      col[k] = t; u[k] = road / 10; v[k] = rowV('road');
    } else if (trees && treeH && (cover === 'wood' ? hash2(x, z) < 0.55 : cover === 'grass' ? hash2(x, z) < 0.12 : false)) {
      col[k] = t + treeH; u[k] = hash2(z, x); v[k] = rowV('tree'); treeCount++;
    } else {
      col[k] = t; u[k] = (t - base) / span; v[k] = rowV(cover || 'land');
    }
  }
  return { n, terr, col, u, v, hmin, hmax, trees: treeCount };
}

/**
 * Surface meshes for the columns: vertex data ready for spline.createObject('CustomMesh', …).
 * @param o.voxel world units per voxel · o.frame 'crop' | 'immersive'
 */
export function meshColumns({ n, terr, col, u, v }, { voxel = 1.2, frame = 'crop', chunk = 64, maxVerts = 59996 } = {}) {
  const meshes = [];
  let V = [], NN = [], UV = [], I = [], voxels = 0, maxCol = 0;
  const flush = () => { if (!V.length) return; meshes.push({ vertices: new Float32Array(V), normals: NN, uvs: UV, indices: I }); V = []; NN = []; UV = []; I = []; };
  const quad = (a, b, c, d, nrm, uu, vv) => {
    if (V.length / 3 + 4 > maxVerts) flush();
    const i0 = V.length / 3;
    V.push(...a, ...b, ...c, ...d);
    for (let q = 0; q < 4; q++) { NN.push(...nrm); UV.push(uu, vv); }
    I.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  };
  const cutV = rowV('cut'), waterV = rowV('water');
  const off = (-n * voxel) / 2;
  // a side face from height lo to hi (in voxels) on one side of a column
  const wall = (side, x0, x1, z0, z1, lo, hi, uu, vv) => {
    const a = lo * voxel, b = hi * voxel;
    if (side === 0) quad([x1, a, z0], [x1, b, z0], [x1, b, z1], [x1, a, z1], [1, 0, 0], uu, vv);
    else if (side === 1) quad([x0, a, z1], [x0, b, z1], [x0, b, z0], [x0, a, z0], [-1, 0, 0], uu, vv);
    else if (side === 2) quad([x1, a, z1], [x1, b, z1], [x0, b, z1], [x0, a, z1], [0, 0, 1], uu, vv);
    else quad([x0, a, z0], [x0, b, z0], [x1, b, z0], [x1, a, z0], [0, 0, -1], uu, vv);
  };
  const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
  for (let cz = 0; cz < n; cz += chunk) for (let cx = 0; cx < n; cx += chunk) {
    for (let z = cz; z < Math.min(n, cz + chunk); z++) for (let x = cx; x < Math.min(n, cx + chunk); x++) {
      const k = z * n + x, h = col[k], y = h * voxel, uu = u[k], vv = v[k];
      voxels += h; if (h > maxCol) maxCol = h;
      const x0 = off + x * voxel, x1 = x0 + voxel, z0 = off + z * voxel, z1 = z0 + voxel;
      quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], [0, 1, 0], uu, vv);
      for (let s = 0; s < 4; s++) {
        const nx = x + DX[s], nz = z + DZ[s], outside = nx < 0 || nz < 0 || nx >= n || nz >= n;
        if (outside) {
          if (frame !== 'crop') continue; // immersive: the edge dissolves, no walls
          // the cut: strata from the base to the ground, then whatever stands on it (buildings, trees)
          if (vv === waterV) { // a river or the sea meets the cut: water on top of the strata
            const wl = Math.max(0, terr[k] - 2);
            wall(s, x0, x1, z0, z1, 0, wl, 0, cutV);
            wall(s, x0, x1, z0, z1, wl, terr[k], uu, vv);
          } else wall(s, x0, x1, z0, z1, 0, terr[k], 0, cutV);
          if (h > terr[k]) wall(s, x0, x1, z0, z1, terr[k], h, uu, vv);
          continue;
        }
        const nh = col[nz * n + nx];
        if (nh < h) wall(s, x0, x1, z0, z1, nh, h, uu, vv);
      }
    }
    flush();
  }
  return { meshes, voxels, height: maxCol * voxel, width: n * voxel };
}

/** The crop's pedestal and wireframe: plain Spline objects, so they stay editable in the scene. */
async function addCropFrame(spline, { width, height, style, parent }) {
  const ids = [], P = parent ? { parent } : {};
  const ped = await spline.createObject('Cube', { name: 'Place Pedestal', width: width * 1.002, height: width * 0.03, depth: width * 1.002, cornerRadius: 0, position: [0, -width * 0.015, 0], material: style.pedestal, ...P });
  if (ped?.id) ids.push(ped.id);
  const h = Math.max(height * 1.3, width * 0.4), t = Math.max(0.35, width * 0.001), half = width / 2;
  const edges = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) edges.push({ position: [sx * half, h / 2, sz * half], width: t, height: h, depth: t });
  for (const y of [0, h]) {
    for (const sz of [-1, 1]) edges.push({ position: [0, y, sz * half], width, height: t, depth: t });
    for (const sx of [-1, 1]) edges.push({ position: [sx * half, y, 0], width: t, height: t, depth: width });
  }
  for (const e of edges) {
    const r = await spline.createObject('Cube', { name: 'Place Frame', cornerRadius: 0, material: { color: style.frame, alpha: 45 }, ...e, ...P });
    if (r?.id) ids.push(r.id);
  }
  return ids;
}

/**
 * Fetch a place and build it in the scene.
 * @param spline the scene's `spline` API
 * @param o.lat @param o.lon centre · o.query a place name instead · o.pack a pre-built pack (encodePlace JSON) instead
 * @param o.name label for the place · o.sizeM ground size in metres · o.n cells per side (512)
 * @param o.style a STYLES key or a style object · o.frame 'crop' (default) | 'immersive'
 * @param o.voxel world units per voxel (1.2) · o.exag vertical exaggeration · o.trees voxel trees (true)
 * @param o.parent a group name/id for everything created · o.onStatus (text) => void
 */
export async function buildPlaceScene(spline, o = {}) {
  const say = o.onStatus || (() => {});
  await spline.ready;
  const t0 = performance.now();
  say('Fetching map data…');
  const pack = o.pack ? await decodePlace(o.pack) : await buildPlace({ query: o.query, name: o.name, lat: o.lat, lon: o.lon, sizeM: o.sizeM, n: o.n ?? 512 });
  const tData = performance.now();
  say('Building voxels…');
  const frame = o.frame === 'immersive' ? 'immersive' : 'crop';
  const style = typeof o.style === 'object' ? o.style : STYLES[o.style || 'strata'] || STYLES.strata;
  // a crop stands on a slab ~6% of its width deep, so the cut reads as layers of rock
  const n = pack.meta.n;
  const cols = placeColumns(pack, { exag: o.exag, trees: o.trees, base: frame === 'crop' ? Math.max(6, Math.round(n * 0.06)) : 2 });
  const voxel = o.voxel ?? 1.2;
  const { meshes, voxels, height, width } = meshColumns(cols, { voxel, frame });
  let material = style.fallback;
  try {
    const fade = frame === 'immersive' ? { radius: width / 2, start: 0.55 } : undefined;
    material = await spline.createCustomMaterial((three) => voxelMaterial(three, style, { voxel, fade }));
  } catch (e) { console.warn('[place] custom material unavailable, using a flat colour:', e?.message || e); }
  const ids = [], P = o.parent ? { parent: o.parent } : {};
  for (const g of meshes) {
    const r = await spline.createObject('CustomMesh', { ...g, material, name: 'Place Voxels', ...P });
    if (r?.id) ids.push(r.id);
  }
  if (frame === 'crop') ids.push(...(await addCropFrame(spline, { width, height, style, parent: o.parent })));
  say('');
  return {
    name: pack.meta.name, attribution: pack.meta.attribution, labels: pack.labels, background: style.background,
    n: cols.n, cellM: pack.meta.cell, voxels, trees: cols.trees, meshes: meshes.length, ids, extent: width, height, frame,
    ms: { data: Math.round(tData - t0), build: Math.round(performance.now() - tData) },
  };
}

/**
 * Slowly orbit a camera around the place. Returns a stop function.
 * @param o.extent the place's width (buildPlaceScene's result.extent) · o.dist camera distance × extent
 * @param o.pitch degrees above the horizon · o.yaw start angle · o.speed degrees per second
 */
export async function orbitCamera(spline, { camera = 'Camera', extent = 600, dist = 0.9, pitch = 35, yaw = 25, speed = 5, target = [0, 0, 0] } = {}) {
  const cam = await spline.findObjectByName(camera);
  if (!cam) return () => {};
  const deg = 180 / Math.PI, R = extent * dist, ph = pitch / deg;
  let th = yaw / deg, last = performance.now(), run = true;
  const tick = (now) => {
    if (!run) return;
    th += ((now - last) / 1000) * (speed / deg); last = now;
    const ct = Math.cos(th), st = Math.sin(th), ca = Math.cos(-ph), sa = Math.sin(-ph);
    spline.updateObject(cam.id, {
      position: { x: target[0] + st * Math.cos(ph) * R, y: target[1] + Math.sin(ph) * R, z: target[2] + ct * Math.cos(ph) * R },
      rotation: { x: Math.atan2(sa, ct * ca) * deg, y: Math.asin(Math.max(-1, Math.min(1, st * ca))) * deg, z: Math.atan2(-st * sa, ct) * deg },
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => { run = false; };
}

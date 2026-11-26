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
import { placeToGLB } from './glb.js';
import { STYLES, rowV, voxelMaterial } from './styles.js';

export { STYLES };

// pack land cover id (bits 5..7 of kind) → palette row
const COVER_ROW = [null, 'grass', 'wood', 'farmland', 'sand', 'rock', 'ice', 'wetland'];
const hash2 = (x, y) => { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123; return h - Math.floor(h); };

/** 0 at the shore → 1 at `reach` cells out, for every water cell (two-pass chamfer distance). */
export function waterDepth(kind, n, reach) {
  const D = new Float32Array(n * n), INF = 1e9, d1 = 1, d2 = Math.SQRT2;
  for (let k = 0; k < n * n; k++) D[k] = kind[k] & 1 ? INF : 0;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const k = z * n + x; if (!D[k]) continue;
    let d = D[k];
    if (x > 0) d = Math.min(d, D[k - 1] + d1);
    if (z > 0) { d = Math.min(d, D[k - n] + d1); if (x > 0) d = Math.min(d, D[k - n - 1] + d2); if (x < n - 1) d = Math.min(d, D[k - n + 1] + d2); }
    D[k] = d;
  }
  for (let z = n - 1; z >= 0; z--) for (let x = n - 1; x >= 0; x--) {
    const k = z * n + x; if (!D[k]) continue;
    let d = D[k];
    if (x < n - 1) d = Math.min(d, D[k + 1] + d1);
    if (z < n - 1) { d = Math.min(d, D[k + n] + d1); if (x < n - 1) d = Math.min(d, D[k + n + 1] + d2); if (x > 0) d = Math.min(d, D[k + n - 1] + d2); }
    D[k] = d;
  }
  // a frame that is all water (open sea) has no shore: call it deep
  for (let k = 0; k < n * n; k++) D[k] = D[k] >= INF ? 1 : Math.min(1, (D[k] - 0.5) / reach);
  return D;
}

/**
 * Column heights (in voxels) and per-cell palette coordinates from a place pack.
 * @param o.exag vertical exaggeration (default 1.2 for cities, 1.6 for landscapes)
 * @param o.trees voxel trees on forests (and sparsely on parks), default true
 * @param o.base voxels of ground under the lowest point (the depth of the crop's strata), default 2
 */
export function placeColumns(pack, { exag, trees = true, base: baseVox } = {}) {
  const { n, cell } = pack.meta, N = n * n, { height, bld, kind, bid } = pack;
  const depth = waterDepth(kind, n, Math.max(4, n * 0.03));
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
      // one colour per building: its id picks a palette slot; towers (60 m+) take the last slot (glass)
      u[k] = bld[k] >= 60 ? 0.86 + 0.14 * Math.min(1, (bld[k] - 60) / 140) : ((bid?.[k] || hash2(Math.round(bld[k] * 10), 7) * 255) / 256) * 0.83;
      v[k] = rowV('building');
    } else if (water) {
      // the surface sits a voxel below its banks, so rivers and shores read as cut into the land
      if (t > 1) terr[k] = t - 1;
      col[k] = terr[k]; u[k] = depth[k]; v[k] = rowV('water');
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
export function meshColumns({ n, terr, col, u, v }, { voxel = 1.2, frame = 'crop', aspect = 1, chunk = 64, maxVerts = 59996 } = {}) {
  // aspect > 1 keeps every column but only a centred band of rows: a wider-than-deep crop
  const rowsN = Math.max(8, Math.min(n, Math.round(n / Math.max(1, aspect)))), zA = Math.floor((n - rowsN) / 2), zB = zA + rowsN;
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
  const off = (-n * voxel) / 2, offZ = -(zA + rowsN / 2) * voxel;
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
    for (let z = Math.max(cz, zA); z < Math.min(zB, cz + chunk); z++) for (let x = cx; x < Math.min(n, cx + chunk); x++) {
      const k = z * n + x, h = col[k], y = h * voxel, uu = u[k], vv = v[k];
      voxels += h; if (h > maxCol) maxCol = h;
      const x0 = off + x * voxel, x1 = x0 + voxel, z0 = offZ + z * voxel, z1 = z0 + voxel;
      quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], [0, 1, 0], uu, vv);
      for (let s = 0; s < 4; s++) {
        const nx = x + DX[s], nz = z + DZ[s], outside = nx < 0 || nz < zA || nx >= n || nz >= zB;
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
  return { meshes, voxels, height: maxCol * voxel, width: n * voxel, depth: rowsN * voxel };
}

/** The crop's pedestal and wireframe: plain Spline objects, so they stay editable in the scene. */
export async function addCropFrame(spline, { width, depth = width, height, style, parent, vitrine = 1 }) {
  const ids = [], P = parent ? { parent } : {};
  const ped = await spline.createObject('Cube', { name: 'Place Pedestal', width: width * 1.002, height: width * 0.03, depth: depth * 1.002, cornerRadius: 0, position: [0, -width * 0.015, 0], material: style.pedestal, ...P });
  if (ped?.id) ids.push(ped.id);
  if (!(vitrine > 0)) return ids; // vitrine: 0 hides the wireframe
  const h = Math.max(height * 1.15, width * 0.4) * vitrine, t = Math.max(0.35, width * 0.001), half = width / 2, halfZ = depth / 2;
  const edges = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) edges.push({ position: [sx * half, h / 2, sz * halfZ], width: t, height: h, depth: t });
  for (const y of [0, h]) {
    for (const sz of [-1, 1]) edges.push({ position: [0, y, sz * halfZ], width, height: t, depth: t });
    for (const sx of [-1, 1]) edges.push({ position: [sx * half, y, 0], width: t, height: t, depth });
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
 * @param o.base crop: slab depth in voxels (default 6% of n) · o.vitrine crop: wireframe height ×, 0 = none (1)
 * @param o.aspect crop: width ÷ depth, ≥ 1 (1 = square)
 * @param o.background the scene's page colour, if it differs from the style's (the immersive edge fades into it)
 * @param o.onStatus (text) => void
 * Everything is created inside a new Group (result.groupId): hide it to clear the place before building another.
 */
export async function buildPlaceScene(spline, o = {}) {
  const say = o.onStatus || (() => {});
  await spline.ready;
  const t0 = performance.now();
  if (!o.raw) say('Fetching map data…');
  const pack = o.raw ?? (o.pack ? await decodePlace(o.pack) : await buildPlace({ query: o.query, name: o.name, lat: o.lat, lon: o.lon, sizeM: o.sizeM, n: o.n ?? 512 }));
  const tData = performance.now();
  say('Building voxels…');
  const frame = o.frame === 'immersive' ? 'immersive' : 'crop';
  const style = typeof o.style === 'object' ? o.style : STYLES[o.style || 'strata'] || STYLES.strata;
  const look = { ...(o.look || style), ...(o.background ? { background: o.background } : {}) };
  // a crop stands on a slab ~6% of its width deep, so the cut reads as layers of rock
  const n = pack.meta.n;
  const base = frame === 'crop' ? Math.max(4, Math.round(o.base ?? n * 0.06)) : 2;
  const cols = placeColumns(pack, { exag: o.exag, trees: o.trees, base });
  const voxel = o.voxel ?? 1.2;
  const { meshes, voxels, height, width, depth } = meshColumns(cols, { voxel, frame, aspect: frame === 'crop' ? o.aspect ?? 1 : 1 });
  // one material for the whole session: a rebuild only retunes its uniforms (no shader recompile)
  const fade = frame === 'immersive' ? { radius: width / 2, start: 0.55 } : null;
  const band = Math.max(2, Math.round(base / 5)); // strata in ~5 bands across the slab
  let material = o.material, controls = o.material?.placeControls;
  if (controls) controls.set({ voxel, band, fade });
  else {
    material = style.fallback;
    try {
      let made;
      material = await spline.createCustomMaterial((three) => (made = voxelMaterial(three, look, { voxel, band, fade: fade || undefined })));
      controls = made?.placeControls || material?.placeControls;
    } catch (e) { console.warn('[place] custom material unavailable, using a flat colour:', e?.message || e); }
  }
  const group = await spline.createObject('Group', { name: `Place: ${pack.meta.name}` });
  const ids = [], P = group?.id ? { parent: group.id } : {};
  for (const g of meshes) {
    const r = await spline.createObject('CustomMesh', { ...g, material, name: 'Place Voxels', ...P });
    if (r?.id) ids.push(r.id);
  }
  const frameIds = frame === 'crop' ? await addCropFrame(spline, { width, depth, height, style: look, parent: group?.id, vitrine: o.vitrine ?? 1 }) : [];
  ids.push(...frameIds);
  say('');
  return {
    name: pack.meta.name, attribution: pack.meta.attribution, labels: pack.labels, background: style.background,
    // what toGLB() needs to save this exact build as a .glb
    glb: { cols, style: look, voxel, frame, aspect: frame === 'crop' ? o.aspect ?? 1 : 1, band: Math.max(2, Math.round(base / 5)), vitrine: o.vitrine ?? 1 },
    pack, material, controls, frameIds, frameArgs: { width, depth, height, parent: group?.id, vitrine: o.vitrine ?? 1 },
    n: cols.n, cellM: pack.meta.cell, voxels, trees: cols.trees, meshes: meshes.length, ids, groupId: group?.id, extent: width, depth, height, frame, lat: pack.meta.lat, lon: pack.meta.lon,
    ms: { data: Math.round(tData - t0), build: Math.round(performance.now() - tData) },
  };
}

/** Remove a place built by buildPlaceScene (its meshes, frame and group). */
/** Recolour the crop's pedestal and vitrine (they're plain Spline objects): rebuild just them. */
export async function restyleFrame(spline, result, style) {
  if (!result?.frameIds?.length) return;
  for (const id of result.frameIds) { try { await spline.removeObject(id); } catch {} }
  result.ids = result.ids.filter((id) => !result.frameIds.includes(id));
  result.frameIds = await addCropFrame(spline, { ...result.frameArgs, style });
  result.ids.push(...result.frameIds);
}

export async function removePlace(spline, result) {
  if (!result) return;
  for (const id of result.ids || []) { try { await spline.removeObject(id); } catch {} }
  if (result.groupId) { try { await spline.removeObject(result.groupId); } catch {} }
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

/** The place buildPlaceScene just built, as .glb bytes for the Spline editor (see glb.js). */
export function placeGLB(result) {
  const g = result.glb;
  return placeToGLB(g.cols, g.style, { voxel: g.voxel, frame: g.frame, aspect: g.aspect, band: g.band, vitrine: g.vitrine, name: result.name.split(',')[0] });
}

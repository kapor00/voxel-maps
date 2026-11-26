/* ── A place as a .glb you drop into the Spline editor ──
   Real, editable objects: one mesh per material (split past 65k vertices),
   grouped under the place's name, plus the crop's pedestal and vitrine.
   Each material is one flat colour named for what it is ("Roofs · Terracotta",
   "Water · Deep", "Strata 2", …), so recolouring a class is one edit in
   Spline. Per-voxel variation, wall shading and the water's depth ride in
   the vertex colours (COLOR_0), which Spline imports as a Multiply vertex-
   colour layer under each material's colour.
   Plain ES module, no dependencies: runs in Node and in the browser. */

import { ROWS, ROW_COUNT, paletteImage } from './styles.js';

const hexRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hash2 = (x, y) => { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123; return h - Math.floor(h); };

const DEFAULT_NAMES = {
  building: ['White', 'Cream', 'Peach', 'Grey', 'Sage', 'Glass'],
  roof: ['Terracotta', 'Slate', 'Tile', 'Brick', 'Grey', 'Glass'],
};

/** The material table for a style: name → { color: '#rrggbb', roughness, alpha }. Also tells which slot a cell uses. */
export function placeMaterials(style) {
  const img = paletteImage(style);
  const sample = (row, u) => {
    const x = Math.round(Math.max(0, Math.min(1, u)) * (img.width - 1)), o = (ROWS.indexOf(row) * img.width + x) * 4;
    return '#' + [0, 1, 2].map((c) => img.data[o + c].toString(16).padStart(2, '0')).join('');
  };
  const M = {}, add = (name, color, roughness = 0.9, alpha = 1) => (M[name] = { color, roughness, alpha });
  add('Ground · Low', sample('land', 0.12)); add('Ground · Mid', sample('land', 0.5)); add('Ground · High', sample('land', 0.9));
  add('Grass', sample('grass', 0.5)); add('Forest', sample('wood', 0.5)); add('Fields', sample('farmland', 0.5));
  add('Sand', sample('sand', 0.5)); add('Rock', sample('rock', 0.5), 0.85); add('Ice', sample('ice', 0.5), 0.5); add('Wetland', sample('wetland', 0.5));
  add('Water · Shore', sample('water', 0.05), 0.12); add('Water', sample('water', 0.45), 0.12); add('Water · Deep', sample('water', 0.95), 0.12);
  add('Roads', sample('road', 0.5), 0.8); add('Trees', sample('tree', 0.5)); add('Ground · Sides', sample('side', 0.3));
  const slots = (row) => {
    const stops = style.rows[row] || [];
    if (style.steps?.includes(row)) return stops.map((c, i) => [(style.names?.[row] || DEFAULT_NAMES[row])?.[i] || String(i + 1), c]);
    return [0.15, 0.5, 0.85].map((u, i) => [['Light', 'Mid', 'Dark'][i], sample(row, u)]);
  };
  const walls = slots('building'), roofs = slots('roof');
  for (const [n, c] of walls) add('Walls · ' + n, c, 0.8);
  for (const [n, c] of roofs) add('Roofs · ' + n, c, 0.75);
  const cut = style.rows.cut || ['#b44b22'];
  [0, 2, 4, 1].forEach((i, j) => add('Strata ' + (j + 1), cut[i % cut.length]));
  add('Pedestal', style.pedestal || '#120c1e', 0.6);
  add('Frame', style.frame || '#b0a4c4', 0.5, 0.45);
  const slotOf = (list, u) => list[Math.min(list.length - 1, Math.floor(u * list.length))][0];
  return { M, wallOf: (u) => 'Walls · ' + slotOf(walls, u), roofOf: (u) => 'Roofs · ' + slotOf(roofs, u) };
}

/**
 * Mesh a place's columns into material buckets and serialise them as GLB.
 * @param cols   placeColumns() output
 * @param style  a STYLES entry (or your own)
 * @param o.voxel world units per voxel · o.frame 'crop' | 'immersive' · o.aspect crop width ÷ depth
 * @param o.band strata band thickness in voxels · o.vitrine wireframe height ×, 0 = none · o.name root node name
 * @returns {{ glb: Uint8Array, vertices: number, objects: number, materials: string[] }}
 */
export function placeToGLB(cols, style, { voxel = 1.2, frame = 'crop', aspect = 1, band = 3, vitrine = 1, name = 'Place' } = {}) {
  const { n, terr, col, u, v } = cols;
  const { M, wallOf, roofOf } = placeMaterials(style);
  const crop = frame === 'crop';
  const rowsN = crop ? Math.max(8, Math.min(n, Math.round(n / Math.max(1, aspect)))) : n;
  const zA = Math.floor((n - rowsN) / 2), zB = zA + rowsN;
  const offX = (-n * voxel) / 2, offZ = -(zA + rowsN / 2) * voxel;
  const rowOf = (k) => ROWS[Math.min(ROWS.length - 1, Math.floor(v[k] * ROW_COUNT))];
  const COVER = { grass: 'Grass', wood: 'Forest', farmland: 'Fields', sand: 'Sand', rock: 'Rock', ice: 'Ice', wetland: 'Wetland' };
  const topOf = (k, r) => {
    if (r === 'building') return roofOf(u[k]);
    if (r === 'water') return u[k] < 0.12 ? 'Water · Shore' : u[k] < 0.6 ? 'Water' : 'Water · Deep';
    if (r === 'road') return 'Roads';
    if (r === 'tree') return 'Trees';
    if (COVER[r]) return COVER[r];
    return u[k] < 0.34 ? 'Ground · Low' : u[k] < 0.67 ? 'Ground · Mid' : 'Ground · High';
  };

  const B = new Map();
  const bucket = (m) => { let b = B.get(m); if (!b) B.set(m, (b = { P: [], N: [], C: [] })); return b; };
  // a quad: four corners (counter-clockwise from outside), one normal, a shade per corner (bottom pair, top pair)
  const quad = (m, a, b, c, d, nr, s0, s1) => {
    const q = bucket(m);
    q.P.push(...a, ...b, ...c, ...d);
    for (let i = 0; i < 4; i++) q.N.push(nr[0], nr[1], nr[2]);
    q.C.push(s0, s1, s1, s0);
  };
  const wall = (m, s, x0, x1, z0, z1, lo, hi, sLo = 0.8, sHi = 1) => {
    if (hi <= lo) return;
    const a = lo * voxel, b = hi * voxel;
    if (s === 0) quad(m, [x1, a, z0], [x1, b, z0], [x1, b, z1], [x1, a, z1], [1, 0, 0], sLo, sHi);
    else if (s === 1) quad(m, [x0, a, z1], [x0, b, z1], [x0, b, z0], [x0, a, z0], [-1, 0, 0], sLo, sHi);
    else if (s === 2) quad(m, [x1, a, z1], [x1, b, z1], [x0, b, z1], [x0, a, z1], [0, 0, 1], sLo, sHi);
    else quad(m, [x0, a, z0], [x0, b, z0], [x1, b, z0], [x1, a, z0], [0, 0, -1], sLo, sHi);
  };
  const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
  for (let z = zA; z < zB; z++) for (let x = 0; x < n; x++) {
    const k = z * n + x, h = col[k], t = terr[k], r = rowOf(k);
    const x0 = offX + x * voxel, x1 = x0 + voxel, z0 = offZ + z * voxel, z1 = z0 + voxel, y = h * voxel;
    const jitter = r === 'water' ? 1 : r === 'building' ? 0.95 + 0.05 * hash2(x, z) : 0.9 + 0.1 * hash2(x, z);
    const top = topOf(k, r);
    quad(top, [x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], [0, 1, 0], jitter, jitter);
    const upper = r === 'building' ? wallOf(u[k]) : r === 'tree' ? 'Trees' : r === 'water' ? 'Water · Deep' : 'Ground · Sides';
    for (let s = 0; s < 4; s++) {
      const nx = x + DX[s], nz = z + DZ[s];
      if (nx < 0 || nx >= n || nz < zA || nz >= zB) {
        if (!crop) continue;
        // the cut: strata bands up to the ground (water on top where a river meets the edge), then what stands on it
        const wl = r === 'water' ? Math.max(0, t - 2) : t;
        for (let lo = 0; lo < wl; lo += band) wall('Strata ' + (1 + (Math.floor(lo / band) % 4)), s, x0, x1, z0, z1, lo, Math.min(lo + band, wl), 0.92, 1);
        if (r === 'water') wall('Water · Deep', s, x0, x1, z0, z1, wl, t, 0.85, 1);
        wall(upper, s, x0, x1, z0, z1, t, h, 0.78, 1);
        continue;
      }
      const nh = col[nz * n + nx];
      if (nh >= h) continue;
      if (r === 'building' || r === 'tree') {
        wall(upper, s, x0, x1, z0, z1, Math.max(nh, t), h, 0.78, 1);
        wall('Ground · Sides', s, x0, x1, z0, z1, nh, Math.min(t, h), 0.75, 0.95);
      } else wall(upper, s, x0, x1, z0, z1, nh, h, 0.75, 0.97);
    }
  }

  // pedestal and vitrine (crop only), as boxes
  const W = n * voxel, D = rowsN * voxel;
  let H = 0;
  for (let k = 0; k < n * n; k++) if (col[k] > H) H = col[k];
  H *= voxel;
  const box = (m, cx, cy, cz, w, h, d, shade = 1) => {
    const [a, b, c] = [w / 2, h / 2, d / 2], X0 = cx - a, X1 = cx + a, Y0 = cy - b, Y1 = cy + b, Z0 = cz - c, Z1 = cz + c;
    quad(m, [X0, Y1, Z0], [X0, Y1, Z1], [X1, Y1, Z1], [X1, Y1, Z0], [0, 1, 0], shade, shade);
    quad(m, [X0, Y0, Z1], [X0, Y0, Z0], [X1, Y0, Z0], [X1, Y0, Z1], [0, -1, 0], shade, shade);
    quad(m, [X1, Y0, Z0], [X1, Y1, Z0], [X1, Y1, Z1], [X1, Y0, Z1], [1, 0, 0], shade, shade);
    quad(m, [X0, Y0, Z1], [X0, Y1, Z1], [X0, Y1, Z0], [X0, Y0, Z0], [-1, 0, 0], shade, shade);
    quad(m, [X1, Y0, Z1], [X1, Y1, Z1], [X0, Y1, Z1], [X0, Y0, Z1], [0, 0, 1], shade, shade);
    quad(m, [X0, Y0, Z0], [X0, Y1, Z0], [X1, Y1, Z0], [X1, Y0, Z0], [0, 0, -1], shade, shade);
  };
  if (crop) {
    box('Pedestal', 0, -W * 0.015, 0, W * 1.002, W * 0.03, D * 1.002);
    if (vitrine > 0) {
      const h = Math.max(H * 1.15, W * 0.4) * vitrine, t = Math.max(0.35, W * 0.001), hx = W / 2, hz = D / 2;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box('Frame', sx * hx, h / 2, sz * hz, t, h, t);
      for (const yy of [0, h]) {
        for (const sz of [-1, 1]) box('Frame', 0, yy, sz * hz, W, t, t);
        for (const sx of [-1, 1]) box('Frame', sx * hx, yy, 0, t, t, D);
      }
    }
  }
  return writeGLB(name, B, M);
}

/** Buckets → GLB bytes. Each bucket becomes one node per ≤65,532 vertices (uint16 indices). */
function writeGLB(name, B, M) {
  const LIMIT = 65532;
  const json = { asset: { version: '2.0', generator: 'place-to-3d' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, children: [] }], meshes: [], materials: [], accessors: [], bufferViews: [] };
  const parts = [];
  let offset = 0, vertices = 0;
  const view = (bytes, target) => {
    const pad = (4 - (bytes.byteLength % 4)) % 4;
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    parts.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (pad) parts.push(new Uint8Array(pad));
    offset += bytes.byteLength + pad;
    return json.bufferViews.length - 1;
  };
  const matIndex = new Map();
  const material = (m) => {
    if (matIndex.has(m)) return matIndex.get(m);
    const d = M[m] || { color: '#ff00ff', roughness: 0.9, alpha: 1 };
    const [r, g, b] = hexRGB(d.color).map(toLinear);
    json.materials.push({ name: m, pbrMetallicRoughness: { baseColorFactor: [r, g, b, d.alpha], metallicFactor: 0, roughnessFactor: d.roughness }, ...(d.alpha < 1 ? { alphaMode: 'BLEND' } : {}) });
    matIndex.set(m, json.materials.length - 1);
    return json.materials.length - 1;
  };
  // shade → linear byte, once
  const LUT = new Uint8Array(256);
  for (let i = 0; i < 256; i++) LUT[i] = Math.round(toLinear(i / 255) * 255);
  const order = [...B.keys()].sort();
  for (const m of order) {
    const q = B.get(m), total = q.P.length / 3;
    for (let start = 0, part = 0; start < total; start += LIMIT, part++) {
      const count = Math.min(LIMIT, total - start);
      const P = new Float32Array(q.P.slice(start * 3, (start + count) * 3));
      const N = new Float32Array(q.N.slice(start * 3, (start + count) * 3));
      const C = new Uint8Array(count * 4);
      for (let i = 0; i < count; i++) { const s = LUT[Math.round(Math.max(0, Math.min(1, q.C[start + i])) * 255)]; C[i * 4] = s; C[i * 4 + 1] = s; C[i * 4 + 2] = s; C[i * 4 + 3] = 255; }
      const I = new Uint16Array((count / 4) * 6);
      for (let f = 0, j = 0; f < count; f += 4) { I[j++] = f; I[j++] = f + 1; I[j++] = f + 2; I[j++] = f; I[j++] = f + 2; I[j++] = f + 3; }
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i += 3) for (let c = 0; c < 3; c++) { if (P[i + c] < min[c]) min[c] = P[i + c]; if (P[i + c] > max[c]) max[c] = P[i + c]; }
      const acc = (bv, componentType, count2, type, extra = {}) => { json.accessors.push({ bufferView: bv, componentType, count: count2, type, ...extra }); return json.accessors.length - 1; };
      const pos = acc(view(P, 34962), 5126, count, 'VEC3', { min, max });
      const nor = acc(view(N, 34962), 5126, count, 'VEC3');
      const colr = acc(view(C, 34962), 5121, count, 'VEC4', { normalized: true });
      const idx = acc(view(I, 34963), 5123, I.length, 'SCALAR');
      const label = part ? `${m} ${part + 1}` : m;
      json.meshes.push({ name: label, primitives: [{ attributes: { POSITION: pos, NORMAL: nor, COLOR_0: colr }, indices: idx, material: material(m) }] });
      json.nodes.push({ name: label, mesh: json.meshes.length - 1 });
      json.nodes[0].children.push(json.nodes.length - 1);
      vertices += count;
    }
  }
  json.buffers = [{ byteLength: offset }];
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (enc.length % 4)) % 4, jsonLen = enc.length + jpad;
  const out = new Uint8Array(12 + 8 + jsonLen + 8 + offset);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(enc, 20); out.fill(0x20, 20 + enc.length, 20 + jsonLen);
  let o = 20 + jsonLen;
  dv.setUint32(o, offset, true); dv.setUint32(o + 4, 0x004e4942, true); o += 8;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return { glb: out, vertices, objects: json.nodes.length - 1, materials: json.materials.map((m) => m.name) };
}

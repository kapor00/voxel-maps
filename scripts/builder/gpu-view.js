/* ── A live place view: the voxels are built on the GPU, so everything is realtime ──
   The map data (terrain, buildings, roads, water, land cover) lives in two small
   textures covering an area larger than the visible window. One fixed template
   mesh holds a box per column of the window; its vertex shader reads the column's
   height and class from the textures, so panning the window across the data,
   the height scale, the slab, the frame, the shape and the trees are uniforms:
   no rebuild, no recompile. When the window nears the edge of the data, a new
   area is fetched in the background and swapped in without a pause.
   The look (palette, water, light, grading) is voxelMaterial's, shared with the
   CPU path, through its `hook`. */

import { buildPlace } from '../geo/place.js';
import { voxelMaterial, ROW, ROW_COUNT, styleUniformValues } from './styles.js';
import { placeColumns, waterDepth } from './place-scene.js';
import { shapeIndex, volumeOf } from './shapes.js';

const hashJS = (x, y) => { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123; return h - Math.floor(h); };

/** Pack → the two RGBA8 textures the shader reads. Also the area's height range. */
function encodeArea(pack, reach) {
  const { n: W, cell, lat, lon } = pack.meta, N = W * W, { height, bld, kind, bid } = pack;
  const a = new Uint8Array(N * 4), b = new Uint8Array(N * 4);
  const depth = waterDepth(kind, W, reach);
  // trees hash on a world grid, so they stay put while the window pans across streamed areas
  const gx0 = Math.round((lon * 111320 * Math.cos((lat * Math.PI) / 180)) / cell) - W / 2, gz0 = Math.round((-lat * 111320) / cell) - W / 2;
  let hmin = Infinity, hmax = -Infinity;
  for (let k = 0; k < N; k++) {
    const m = Math.max(0, Math.min(65535, Math.round(height[k])));
    if (m < hmin) hmin = m; if (m > hmax) hmax = m;
    a[k * 4] = m >> 8; a[k * 4 + 1] = m & 255; a[k * 4 + 2] = Math.min(255, Math.round(bld[k] / 2)); a[k * 4 + 3] = kind[k];
    const water = kind[k] & 1, road = (kind[k] >> 1) & 15, cover = kind[k] >> 5, x = k % W, z = (k / W) | 0;
    const free = !water && !road && !(bld[k] > 0);
    const r = hashJS(gx0 + x, gz0 + z);
    const tree = free && (cover === 2 ? r < 0.55 : cover === 1 ? r < 0.12 : false);
    b[k * 4] = bid?.[k] || 0; b[k * 4 + 1] = Math.round(depth[k] * 255); b[k * 4 + 2] = tree ? 255 : 0; b[k * 4 + 3] = 255;
  }
  return { a, b, hmin, hmax };
}

/** The template: one box per column (top + 4 walls), uv.x = column index, uv.y = 1 on a wall's top edge. */
function template(n, vx, topY) {
  const meshes = [], cap = 59980;
  let V = [], Nn = [], UV = [], I = [];
  const flush = () => { if (V.length) { meshes.push({ vertices: new Float32Array(V), normals: Nn, uvs: UV, indices: I }); V = []; Nn = []; UV = []; I = []; } };
  const quad = (p, nr, idx, tops) => {
    const i0 = V.length / 3;
    for (let j = 0; j < 4; j++) { V.push(p[j][0], tops[j] ? topY : 0, p[j][1]); Nn.push(nr[0], nr[1], nr[2]); UV.push(idx, tops[j]); }
    I.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  };
  const T1 = [1, 1, 1, 1], W1 = [0, 1, 1, 0];
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    if (V.length / 3 + 20 > cap) flush();
    const idx = z * n + x, x0 = (x - n / 2) * vx, x1 = x0 + vx, z0 = (z - n / 2) * vx, z1 = z0 + vx;
    quad([[x0, z0], [x0, z1], [x1, z1], [x1, z0]], [0, 1, 0], idx, T1);
    quad([[x1, z0], [x1, z0], [x1, z1], [x1, z1]], [1, 0, 0], idx, W1);
    quad([[x0, z1], [x0, z1], [x0, z0], [x0, z0]], [-1, 0, 0], idx, W1);
    quad([[x1, z1], [x1, z1], [x0, z1], [x0, z1]], [0, 0, 1], idx, W1);
    quad([[x0, z0], [x0, z0], [x1, z0], [x1, z0]], [0, 0, -1], idx, W1);
  }
  flush();
  return meshes;
}

/**
 * Build a live view of a place.
 * @param o { lat, lon, name, sizeM (window metres), n (window cells: 256 | 384 | 512), area (data / window, default 2),
 *            look (a style object), frame, width and depth (0.2–1 of the window), shape ('box' | 'cylinder' |
 *            'dome' | 'island' | 'hex'), exag, slab (% of n), trees, vitrine, fov (degrees), worldWidth (614),
 *            background, onStatus, onCenter({lat, lon}) }
 */
export async function createPlaceView(spline, o) {
  const say = o.onStatus || (() => {});
  await spline.ready;
  const n = o.n || 384, area = o.area || 2, W = n * area, vx = (o.worldWidth || 614) / n;
  const P = {
    lat: o.lat, lon: o.lon, name: o.name || 'Place', sizeM: o.sizeM || 4000,
    frame: o.frame || 'crop', exag: o.exag, slab: o.slab ?? 6, trees: o.trees !== false, vitrine: o.vitrine ?? 1,
    width: o.width ?? 1, depth: o.depth ?? 1 / Math.max(1, o.aspect || 1), shape: o.shape || 'box', fov: o.fov ?? 45,
  };
  const cellM = P.sizeM / n;
  const exagOf = () => P.exag ?? (cellM > 25 ? 1.6 : 1.2);
  const baseOf = () => (P.frame === 'crop' ? Math.max(4, Math.round((n * P.slab) / 100)) : 2);
  const vol = () => (P.frame === 'crop' ? volumeOf(n, P) : { x0: 0, cols: n, z0: 0, rows: n });
  const rowsOf = () => vol().rows;
  const shapeOf = () => (P.frame === 'crop' ? shapeIndex(P.shape) : 0);
  // FOV as a lens: the camera keeps its own FOV (assumed 45°); the voxels' projection is scaled to match
  const lensOf = () => Math.tan((45 * Math.PI) / 360) / Math.tan((Math.min(150, Math.max(5, P.fov)) * Math.PI) / 360);
  const domeK = () => 0.3 * (Math.max(vol().cols, vol().rows) / 2); // dome drop at the rim, in voxels

  // ── data: an area `area`× the window, centred on the place ──
  say('Fetching map data…');
  const fetchArea = (lat, lon) => buildPlace({ lat, lon, name: P.name, sizeM: P.sizeM * area, n: W });
  let pack = await fetchArea(P.lat, P.lon);
  const reach = Math.max(4, n * 0.03);
  let enc = encodeArea(pack, reach);
  const hmin = enc.hmin, span0 = Math.max(1, enc.hmax - enc.hmin);
  say('Building voxels…');

  // ── the material: voxelMaterial's look, with the columns built in the vertex shader ──
  let G = null;
  const topY = (W / 2) * vx; // template top: keeps the meshes' bounds tall enough for culling
  const material = await spline.createCustomMaterial((three) =>
    voxelMaterial(three, o.look, {
      voxel: vx, band: Math.max(2, Math.round(baseOf() / 5)), fade: P.frame === 'immersive' ? { radius: (n * vx) / 2, start: 0.55 } : undefined,
      hook: (T, th, U, m) => {
        const mk = (data) => { const t = new th.DataTexture(data, W, W, th.RGBAFormat); t.magFilter = th.NearestFilter; t.minFilter = th.NearestFilter; t.needsUpdate = true; return t; };
        G = {
          texA: mk(enc.a), texB: mk(enc.b),
          off: T.uniform(new th.Vector2((W - n) / 2, (W - n) / 2)), exag: T.uniform(exagOf()), base: T.uniform(baseOf()),
          hmin: T.uniform(hmin), cell: T.uniform(cellM), span: T.uniform(Math.max(1, (span0 / cellM) * exagOf())),
          trees: T.uniform(P.trees ? 1 : 0), treeH: T.uniform(cellM <= 15 ? 1 : 0), crop: T.uniform(P.frame === 'crop' ? 1 : 0),
          z0: T.uniform(vol().z0), rows: T.uniform(vol().rows), x0: T.uniform(vol().x0), cols: T.uniform(vol().cols),
          shape: T.uniform(shapeOf()), domeK: T.uniform(domeK()), lens: T.uniform(lensOf()),
        };
        // the volume's shape at a cell: in or out, radius in the unit ellipse, the island's coast there
        const shapeAt = (x, z) => {
          const u = x.add(0.5).sub(G.x0.add(G.cols.mul(0.5))).div(G.cols.mul(0.5));
          const v = z.add(0.5).sub(G.z0.add(G.rows.mul(0.5))).div(G.rows.mul(0.5));
          const r = T.sqrt(u.mul(u).add(v.mul(v))), a = T.atan(v, u);
          const coast = T.sin(a.mul(3).add(1.3)).mul(0.07).add(T.sin(a.mul(5).add(0.4)).mul(0.05)).add(T.sin(a.mul(11).add(2.1)).mul(0.03)).add(0.84);
          const hexD = T.max(T.abs(u).mul(0.866).add(T.abs(v).mul(0.5)), T.abs(v));
          const is = (k) => T.step(k - 0.5, G.shape).mul(T.step(G.shape, k + 0.5));
          const round = is(1).add(is(2)), isl = is(3), hex = is(4);
          const m = is(0).add(round.mul(T.step(r, 1))).add(isl.mul(T.step(r, coast))).add(hex.mul(T.step(hexD, 0.98)));
          return { m, r, edge: T.mix(1, coast, isl), isl, drop: is(2).mul(G.domeK).mul(r.mul(r)) };
        };
        const idx = T.uv().x, topV = T.uv().y;
        const cx = T.mod(idx, n), cz = T.floor(idx.div(n));
        const nl = T.normalLocal;
        const load = (tex, x, z) => T.textureLoad(tex, T.ivec2(T.clamp(x.add(G.off.x), 0, W - 1), T.clamp(z.add(G.off.y), 0, W - 1)));
        const B = (v) => T.round(v.mul(255));
        const column = (x, z) => {
          const a = load(G.texA, x, z), b = load(G.texB, x, z);
          const terrM = B(a.x).mul(256).add(B(a.y)), bldM = B(a.z).mul(2), kind = B(a.w);
          const water = T.mod(kind, 2), road = T.mod(T.floor(kind.div(2)), 16), cover = T.floor(kind.div(32));
          const isB = T.step(0.5, bldM), isW = water.mul(T.float(1).sub(isB));
          let t = G.base.add(T.round(T.max(terrM.sub(G.hmin), 0).div(G.cell).mul(G.exag)));
          // an island's land falls toward its coast
          const sh = shapeAt(x, z), fall = T.mix(1, T.smoothstep(sh.edge, sh.edge.mul(0.7), sh.r), sh.isl);
          t = G.base.add(T.round(t.sub(G.base).mul(fall)));
          t = t.sub(isW.mul(T.step(1.5, t))); // water sits a voxel below its banks
          const isT = T.step(0.5, b.z).mul(G.trees).mul(T.float(1).sub(isB));
          const h = t.add(isB.mul(T.max(1, T.round(bldM.div(G.cell).mul(G.exag))))).add(isT.mul(G.treeH));
          return { t, h, isB, isW, road, cover, isT, bldM, bid: B(b.x), depth: b.y, sh };
        };
        const inRange = (x, z) => T.step(G.x0, x).mul(T.step(x, G.x0.add(G.cols).sub(1))).mul(T.step(G.z0, z)).mul(T.step(z, G.z0.add(G.rows).sub(1)));
        const inside = (x, z) => inRange(x, z).mul(T.mix(1, shapeAt(x, z).m, G.crop));
        // the heightfield for the fragment stage (sun shadows, AO): column top in voxels, 0 outside the visible window
        const heightAt = (x, z) => {
          const a = load(G.texA, x, z), terrM = B(a.x).mul(256).add(B(a.y)), bldM = B(a.z).mul(2), isB = T.step(0.5, bldM);
          const t = G.base.add(T.round(T.max(terrM.sub(G.hmin), 0).div(G.cell).mul(G.exag)));
          const sh = shapeAt(x, z), fall = T.mix(1, T.smoothstep(sh.edge, sh.edge.mul(0.7), sh.r), sh.isl);
          const t2 = G.base.add(T.round(t.sub(G.base).mul(fall)));
          return t2.add(isB.mul(T.max(1, T.round(bldM.div(G.cell).mul(G.exag))))).sub(sh.drop).mul(inside(x, z));
        };
        const C = column(cx, cz), own = inside(cx, cz);
        const nx = cx.add(T.round(nl.x)), nz = cz.add(T.round(nl.z)), nIn = inside(nx, nz), N2 = column(nx, nz);
        const nh = T.mix(T.mix(C.h, 0, G.crop), N2.h, nIn);
        const isTop = T.step(0.5, nl.y);
        const y = T.mix(T.min(C.h, nh), C.h, T.max(topV, isTop));
        m.positionNode = T.vec3(T.positionLocal.x, y.sub(C.sh.drop).mul(U.voxel), T.positionLocal.z).mul(own);
        // FOV: scale the projection (clip xy) — a lens, since the scene camera's own FOV can't be set from here
        const clip = T.cameraProjectionMatrix.mul(T.modelViewMatrix.mul(T.vec4(T.positionLocal, 1)));
        m.vertexNode = T.vec4(clip.xy.mul(G.lens), clip.zw);

        // the column's class → palette row and value, exactly as placeColumns does on the CPU
        const gx = cx.add(G.off.x), gz = cz.add(G.off.y);
        const hsh = T.fract(T.sin(gx.mul(127.1).add(gz.mul(311.7))).mul(43758.5453));
        const onRoad = T.step(0.5, C.road).mul(T.float(1).sub(C.isB)).mul(T.float(1).sub(C.isW));
        const rowLand = T.mix(1, C.cover.add(1), T.step(0.5, C.cover));
        let rowIdx = rowLand, uval = C.t.sub(G.base).div(G.span);
        rowIdx = T.mix(rowIdx, ROW.tree, C.isT); uval = T.mix(uval, hsh, C.isT);
        rowIdx = T.mix(rowIdx, ROW.road, onRoad); uval = T.mix(uval, C.road.div(10), onRoad);
        rowIdx = T.mix(rowIdx, ROW.water, C.isW); uval = T.mix(uval, C.depth, C.isW);
        // an island gets a beach along its coast
        const beach = C.sh.isl.mul(T.smoothstep(C.sh.edge.mul(0.86), C.sh.edge.mul(0.95), C.sh.r)).mul(T.float(1).sub(C.isW)).mul(T.float(1).sub(C.isB));
        rowIdx = T.mix(rowIdx, ROW.sand, T.step(0.5, beach)); uval = T.mix(uval, hsh, T.step(0.5, beach));
        const tower = T.step(60, C.bldM);
        const bu = T.mix(T.mix(hsh, C.bid.div(256), T.step(0.5, C.bid)).mul(0.83), T.min(T.float(1), C.bldM.sub(60).div(140)).mul(0.14).add(0.86), tower);
        rowIdx = T.mix(rowIdx, ROW.building, C.isB); uval = T.mix(uval, bu, C.isB);
        const vRow = T.varying(rowIdx.add(0.5).div(ROW_COUNT)), vU = T.varying(uval);
        const vTerr = T.varying(C.t.mul(U.voxel)), vEdge = T.varying(T.float(1).sub(nIn).mul(G.crop).mul(T.float(1).sub(isTop)));
        // fragment: below the terrain, walls are rock — strata on the crop's cut, cliffs (the side row) inside
        const wall = T.float(1).sub(T.step(0.5, T.normalWorld.y));
        const below = wall.mul(T.step(T.positionWorld.y, vTerr.sub(U.voxel.mul(0.02))));
        const v = T.mix(vRow, T.mix((ROW.land + 0.5) / ROW_COUNT, (ROW.cut + 0.5) / ROW_COUNT, T.step(0.5, vEdge)), below);
        return { v, u: vU, g: T.varying(topV), field: { h: heightAt, n } }; // g: 0 at a wall's foot, 1 at its top (the clay gradient)
      },
    })
  );
  const controls = material.placeControls || null;
  const terrainTop = () => (baseOf() + ((enc.hmax - hmin) / cellM) * exagOf()) * vx;
  controls?.set({ top: terrainTop() });

  // ── objects: the template meshes, the crop's pedestal and vitrine, a backdrop ──
  const group = await spline.createObject('Group', { name: `Place: ${P.name}` });
  const parent = group?.id ? { parent: group.id } : {};
  const ids = [];
  for (const g of template(n, vx, topY)) {
    const r = await spline.createObject('CustomMesh', { ...g, material, name: 'Place Voxels', ...parent });
    if (r?.id) ids.push(r.id);
  }
  let look = o.look;
  let frameIds = [];
  const heightNow = () => (baseOf() + ((enc.hmax - hmin) / cellM) * exagOf() + 30) * vx;
  // pedestal and vitrine: custom meshes with the same lens as the voxels, so FOV changes keep them aligned
  const lensUs = [];
  const frameMat = async (hex, alpha) => {
    let ctl = null;
    const mat = await spline.createCustomMaterial((three) => {
      const T = three.tsl, mm = new three.MeshBasicNodeMaterial();
      const U2 = { color: T.uniform(new three.Color(hex)), lens: T.uniform(lensOf()) };
      lensUs.push(U2.lens);
      const Nw = T.normalize(T.normalWorld);
      mm.colorNode = U2.color.mul(T.mix(0.72, 1.06, T.clamp(T.dot(Nw, T.normalize(T.vec3(-0.5, 0.8, 0.35))).mul(0.5).add(0.5), 0, 1)));
      const clip = T.cameraProjectionMatrix.mul(T.modelViewMatrix.mul(T.vec4(T.positionLocal, 1)));
      mm.vertexNode = T.vec4(clip.xy.mul(U2.lens), clip.zw);
      if (alpha < 1) { mm.transparent = true; mm.opacity = alpha; mm.depthWrite = false; }
      mm.toneMapped = false;
      ctl = U2;
      return mm;
    });
    return { mat, set: (h) => ctl?.color.value.set(h) };
  };
  const pedMat = await frameMat(o.look.pedestal || '#120c1e', 1), vitMat = await frameMat(o.look.frame || '#b0a4c4', 0.45);
  const rebuildFrame = async () => {
    for (const id of frameIds) { try { await spline.removeObject(id); } catch {} }
    frameIds = [];
    pedMat.set(look.pedestal || '#120c1e'); vitMat.set(look.frame || '#b0a4c4');
    if (P.frame !== 'crop') return;
    const V = vol(), w = V.cols * vx, d = V.rows * vx, cxw = (V.x0 + V.cols / 2 - n / 2) * vx, czw = (V.z0 + V.rows / 2 - n / 2) * vx;
    const S = { P: [], N: [], I: [] }, F = { P: [], N: [], I: [] };
    const quad = (B, a, b, c, dd, nr) => { const i0 = B.P.length / 3; B.P.push(...a, ...b, ...c, ...dd); for (let i = 0; i < 4; i++) B.N.push(...nr); B.I.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3); };
    const box = (B, x, y, z, sx, sy, sz) => {
      const [X0, X1, Y0, Y1, Z0, Z1] = [x - sx / 2, x + sx / 2, y - sy / 2, y + sy / 2, z - sz / 2, z + sz / 2];
      quad(B, [X0, Y1, Z0], [X0, Y1, Z1], [X1, Y1, Z1], [X1, Y1, Z0], [0, 1, 0]); quad(B, [X0, Y0, Z1], [X0, Y0, Z0], [X1, Y0, Z0], [X1, Y0, Z1], [0, -1, 0]);
      quad(B, [X1, Y0, Z0], [X1, Y1, Z0], [X1, Y1, Z1], [X1, Y0, Z1], [1, 0, 0]); quad(B, [X0, Y0, Z1], [X0, Y1, Z1], [X0, Y1, Z0], [X0, Y0, Z0], [-1, 0, 0]);
      quad(B, [X1, Y0, Z1], [X1, Y1, Z1], [X0, Y1, Z1], [X0, Y0, Z1], [0, 0, 1]); quad(B, [X0, Y0, Z0], [X0, Y1, Z0], [X1, Y1, Z0], [X1, Y0, Z0], [0, 0, -1]);
    };
    const slabH = Math.max(2, n * vx * 0.03);
    if (P.shape === 'box') {
      box(S, cxw, -slabH / 2, czw, w * 1.004, slabH, d * 1.004);
      if (P.vitrine > 0) {
        const h = Math.max(heightNow() * 1.15, n * vx * 0.4) * P.vitrine, t = Math.max(0.35, n * vx * 0.001);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(F, cxw + (sx * w) / 2, h / 2, czw + (sz * d) / 2, t, h, t);
        for (const yy of [0, h]) {
          for (const sz of [-1, 1]) box(F, cxw, yy, czw + (sz * d) / 2, w, t, t);
          for (const sx of [-1, 1]) box(F, cxw + (sx * w) / 2, yy, czw, t, t, d);
        }
      }
    } else if (P.shape === 'cylinder' || P.shape === 'hex') {
      // a plinth that follows the outline (a 64-sided ring, or six sides)
      const seg = P.shape === 'hex' ? 6 : 64, rx = (w / 2) * 1.02, rz = (d / 2) * 1.02, a0 = P.shape === 'hex' ? Math.PI / 6 : 0;
      for (let i = 0; i < seg; i++) {
        const a = a0 + (i / seg) * Math.PI * 2, b = a0 + ((i + 1) / seg) * Math.PI * 2;
        const p = [cxw + Math.cos(a) * rx, czw + Math.sin(a) * rz], q = [cxw + Math.cos(b) * rx, czw + Math.sin(b) * rz];
        const nr = [Math.cos((a + b) / 2), 0, Math.sin((a + b) / 2)];
        quad(S, [q[0], -slabH, q[1]], [q[0], 0, q[1]], [p[0], 0, p[1]], [p[0], -slabH, p[1]], nr);
        quad(S, [cxw, 0, czw], [p[0], 0, p[1]], [q[0], 0, q[1]], [cxw, 0, czw], [0, 1, 0]);
      }
    }
    const make = async (B, mat, name) => {
      if (!B.P.length) return;
      const r = await spline.createObject('CustomMesh', { vertices: new Float32Array(B.P), normals: B.N, indices: B.I, material: mat, name, ...parent });
      if (r?.id) frameIds.push(r.id);
    };
    await make(S, pedMat.mat, 'Place Pedestal'); await make(F, vitMat.mat, 'Place Vitrine');
  };
  await rebuildFrame();
  // write every uniform once the objects exist: values set at creation don't always reach the first frames
  const touch = () => { G.off.value.set(G.off.value.x, G.off.value.y); for (const k of ['exag', 'base', 'hmin', 'cell', 'span', 'trees', 'treeH', 'crop', 'z0', 'rows', 'x0', 'cols', 'shape', 'domeK', 'lens']) G[k].value = +G[k].value; };
  touch(); requestAnimationFrame(touch); setTimeout(touch, 100);
  say('');

  // ── streaming: keep the window inside the data; fetch the next area before it runs out ──
  let fetching = null;
  const centerOf = () => {
    const off = G.off.value, cx = off.x + n / 2 - W / 2, cz = off.y + n / 2 - W / 2; // cells from the area centre
    const { lat, lon } = pack.meta, cell = P.sizeM / n;
    return { lat: lat - (cz * cell) / 111320, lon: lon + (cx * cell) / (111320 * Math.cos((lat * Math.PI) / 180)) };
  };
  const stream = () => {
    if (fetching) return;
    const c = centerOf(), at = { x: G.off.value.x, y: G.off.value.y };
    say('Streaming map data…');
    fetching = fetchArea(c.lat, c.lon).then((next) => {
      const e2 = encodeArea(next, reach);
      // the window moved while we fetched: keep that movement, re-anchored in the new area
      const dx = G.off.value.x - at.x, dz = G.off.value.y - at.y;
      G.texA.image.data.set(e2.a); G.texA.needsUpdate = true;
      G.texB.image.data.set(e2.b); G.texB.needsUpdate = true;
      pack = next; enc = { ...e2, hmin: enc.hmin, hmax: Math.max(enc.hmax, e2.hmax) };
      G.off.value.set(Math.min(W - n, Math.max(0, (W - n) / 2 + dx)), Math.min(W - n, Math.max(0, (W - n) / 2 + dz)));
      say('');
      o.onCenter?.(centerOf());
    }).catch((e) => say('Could not stream: ' + ((e && e.message) || e))).finally(() => { fetching = null; });
  };

  const view = {
    n, W, vx, cellM, material, controls, ids, groupId: group?.id, attribution: pack.meta.attribution,
    get params() { return { ...P, exag: exagOf() }; },
    get look() { return look; },
    get height() { return heightNow(); },
    get extent() { return n * vx; },
    stats: () => ({ name: P.name, cellM, columns: vol().cols * vol().rows, area: `${W}²` }),
    center: centerOf,
    /** Shape, all live: exag, slab, trees, frame, width, depth, shape, vitrine, fov. */
    async set(s) {
      if (s.aspect != null && s.depth == null) s = { ...s, depth: 1 / Math.max(1, s.aspect) };
      Object.assign(P, s);
      const V = vol();
      G.exag.value = exagOf(); G.base.value = baseOf(); G.trees.value = P.trees ? 1 : 0; G.crop.value = P.frame === 'crop' ? 1 : 0;
      G.span.value = Math.max(1, (span0 / cellM) * exagOf()); G.rows.value = V.rows; G.z0.value = V.z0; G.cols.value = V.cols; G.x0.value = V.x0;
      G.shape.value = shapeOf(); G.domeK.value = domeK(); G.lens.value = lensOf(); for (const u of lensUs) u.value = lensOf();
      controls?.set({ top: terrainTop(), band: Math.max(2, Math.round(baseOf() / 5)), fade: P.frame === 'immersive' ? { radius: (n * vx) / 2, start: 0.55 } : null });
      if (['frame', 'width', 'depth', 'shape', 'vitrine', 'exag', 'slab'].some((k) => k in s)) await rebuildFrame();
    },
    /** The look: a whole style (palette rows + uniforms), or just uniform values. */
    setLook(st) { look = st; controls?.setStyle(st); },
    setFx(values) { controls?.set(values); },
    async restyleFrame() { await rebuildFrame(); },
    /** Move the window across the map, in cells; streams new data near the edge. */
    pan(dx, dz) {
      const off = G.off.value, max = W - n;
      off.set(Math.min(max, Math.max(0, off.x + dx)), Math.min(max, Math.max(0, off.y + dz)));
      const margin = n * 0.25;
      if (off.x < margin || off.y < margin || off.x > max - margin || off.y > max - margin) stream();
      o.onCenter?.(centerOf());
    },
    /** What's in the window now, as a pack: for the .glb export. */
    snapshot() {
      const off = G.off.value, ox = Math.round(off.x), oz = Math.round(off.y), N = n * n;
      const height = new Float32Array(N), bld = new Float32Array(N), kind = new Uint8Array(N), bid = new Uint8Array(N);
      for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
        const s = (z + oz) * W + (x + ox), d = z * n + x;
        height[d] = pack.height[s]; bld[d] = pack.bld[s]; kind[d] = pack.kind[s]; bid[d] = pack.bid?.[s] || 0;
      }
      const c = centerOf();
      const win = { v: 1, meta: { ...pack.meta, n, sizeM: P.sizeM, cell: cellM, lat: c.lat, lon: c.lon, name: P.name }, height, bld, kind, bid, labels: [] };
      const cols = placeColumns(win, { exag: exagOf(), trees: P.trees, base: baseOf() });
      return { cols, voxel: vx, frame: P.frame, width: P.frame === 'crop' ? P.width : 1, depth: P.frame === 'crop' ? P.depth : 1, shape: P.frame === 'crop' ? P.shape : 'box', band: Math.max(2, Math.round(baseOf() / 5)), vitrine: P.vitrine, name: P.name.split(',')[0] };
    },
    async dispose() {
      for (const id of [...ids, ...frameIds]) { try { await spline.removeObject(id); } catch {} }
      if (group?.id) { try { await spline.removeObject(group.id); } catch {} }
    },
  };
  return view;
}

/** A camera that orbits, and can be steered: set({ yaw, pitch, dist, speed, target, extent }) at any time. */
export async function createOrbit(spline, { camera = 'Camera', extent = 600, dist = 1.45, pitch = 27, yaw = 205, speed = 5, target = [0, 40, 0] } = {}) {
  const cam = await spline.findObjectByName(camera);
  const S = { extent, dist, pitch, yaw, speed, target, run: true };
  let last = performance.now();
  const D = 180 / Math.PI;
  const tick = (now) => {
    if (!S.run) return;
    S.yaw += ((now - last) / 1000) * S.speed; last = now;
    if (cam) {
      const ph = S.pitch / D, th = S.yaw / D, R = S.extent * S.dist;
      const ct = Math.cos(th), st = Math.sin(th), ca = Math.cos(-ph), sa = Math.sin(-ph);
      spline.updateObject(cam.id, {
        position: { x: S.target[0] + st * Math.cos(ph) * R, y: S.target[1] + Math.sin(ph) * R, z: S.target[2] + ct * Math.cos(ph) * R },
        rotation: { x: Math.atan2(sa, ct * ca) * D, y: Math.asin(Math.max(-1, Math.min(1, st * ca))) * D, z: Math.atan2(-st * sa, ct) * D },
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    state: S,
    set(s) { Object.assign(S, s); },
    stop() { S.run = false; },
  };
}

/** A backdrop that follows the theme: a big inward-facing box with a soft vertical gradient. set(hex) is live. */
export async function createBackdrop(spline, color = '#140e20', size = 9000) {
  let U = null;
  const material = await spline.createCustomMaterial((three) => {
    const T = three.tsl, m = new three.MeshBasicNodeMaterial();
    U = { bg: T.uniform(new three.Color(color)) };
    const d = T.normalize(T.positionWorld.sub(T.cameraPosition));
    const g = T.smoothstep(-0.35, 0.65, d.y);
    m.colorNode = T.mix(U.bg.mul(0.78), U.bg.mul(1.12).add(0.015), g);
    m.toneMapped = false;
    return m;
  });
  const h = size / 2, V = [], N = [], I = [];
  const face = (a, b, c, d, nr) => { const i0 = V.length / 3; V.push(...a, ...b, ...c, ...d); for (let i = 0; i < 4; i++) N.push(...nr); I.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3); };
  face([-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h], [0, 0, 1]);
  face([h, -h, h], [-h, -h, h], [-h, h, h], [h, h, h], [0, 0, -1]);
  face([-h, -h, h], [-h, -h, -h], [-h, h, -h], [-h, h, h], [1, 0, 0]);
  face([h, -h, -h], [h, -h, h], [h, h, h], [h, h, -h], [-1, 0, 0]);
  face([-h, h, -h], [h, h, -h], [h, h, h], [-h, h, h], [0, -1, 0]);
  face([-h, -h, h], [h, -h, h], [h, -h, -h], [-h, -h, -h], [0, 1, 0]);
  const obj = await spline.createObject('CustomMesh', { vertices: new Float32Array(V), normals: N, indices: I, material, name: 'Place Backdrop' });
  return { id: obj?.id, set: (hex) => U?.bg.value.set(hex) };
}

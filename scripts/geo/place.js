/* ── A "place pack": everything the voxel builder needs about one patch of Earth ──
   Four aligned n×n grids (row-major, row 0 = north, column 0 = west):
     height  terrain metres above sea level (ocean clamped to 0)
     bld     building height in metres above the terrain (0 = none)
     kind    bit 0 = water; bits 1..4 = road class id (see ROAD_CLASSES);
             bits 5..7 = land cover id (see COVER_CLASSES)
   plus named labels in frame metres and the attribution the data requires.
   Packs serialise to compact JSON (deflated, base64) so a scene can carry
   its place with it and never touch a tile server at view time. */

import { makeFrame } from './mercator.js';
import { sampleElevation } from './elevation.js';
import { sampleVectors, ROAD_CLASSES, COVER_CLASSES } from './vectors.js';
import { geocode } from './geocode.js';

export { ROAD_CLASSES, COVER_CLASSES };
export const ATTRIBUTION = '© OpenStreetMap contributors (ODbL) · OpenFreeMap · Terrain Tiles (Mapzen/AWS Open Data)';

/** Default ground size for a place, from its kind and extent. */
export function defaultSize(hit) {
  if (hit?.extentM) return Math.min(40000, Math.max(1500, hit.extentM * 1.15));
  return 6000;
}

/**
 * Build a pack for a place.
 * @param {object} o
 * @param {string} [o.query] place name (geocoded) — or pass lat/lon
 * @param {number} [o.lat] @param {number} [o.lon]
 * @param {number} [o.sizeM] ground size in metres (default: from the place's extent, else 6 km)
 * @param {number} [o.n] cells per side (default 512)
 * @param {boolean} [o.buildings] @param {boolean} [o.roads] include them (default: only when cells are ≤ 25 m)
 * @param {(msg: string) => void} [o.log]
 */
export async function buildPlace(o = {}) {
  const log = o.log || (() => {});
  let { lat, lon } = o, name = o.name ?? o.query, hit;
  if (o.query && (lat == null || lon == null)) {
    [hit] = await geocode(o.query);
    if (!hit) throw new Error(`no place found for "${o.query}"`);
    ({ lat, lon, name } = hit);
    log(`geocoded → ${name} (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
  }
  name ??= `${(+lat).toFixed(3)}, ${(+lon).toFixed(3)}`;
  const n = o.n ?? 512;
  const sizeM = o.sizeM ?? defaultSize(hit);
  const frame = makeFrame(lat, lon, sizeM, n);
  const urban = frame.cell <= 25;
  log(`frame ${Math.round(sizeM)} m · ${n}² cells · ${frame.cell.toFixed(1)} m/cell`);

  const t0 = Date.now();
  const [elev, vec] = await Promise.all([
    sampleElevation(frame),
    sampleVectors(frame, { buildings: o.buildings ?? urban, roads: o.roads ?? urban }),
  ]);
  log(`elevation z${elev.zoom} (${elev.tiles} tiles) · vectors z${vec.stats.zoom} (${vec.stats.tiles} tiles, ${vec.stats.buildings} buildings, ${vec.stats.roads} roads) · ${Date.now() - t0} ms`);

  const N = n * n, height = elev.height, kind = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (vec.water[k]) { kind[k] = 1; if (height[k] < 0) height[k] = 0; }
    else if (height[k] < 0) height[k] = 0; // bathymetry outside mapped water: treat as shore
    kind[k] |= (vec.road[k] << 1) | (vec.cover[k] << 5);
  }
  return {
    v: 1,
    meta: { name, lat, lon, sizeM, n, cell: frame.cell, attribution: ATTRIBUTION, created: new Date().toISOString(), elevationZoom: elev.zoom, vectorZoom: vec.stats.zoom, stats: vec.stats },
    height, bld: vec.bldH, kind, labels: vec.labels.slice(0, 40),
  };
}

// ── serialisation ──
const b64 = (u8) => (typeof Buffer !== 'undefined' ? Buffer.from(u8).toString('base64') : btoa(String.fromCharCode(...u8)));
const unb64 = (s) => (typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(s, 'base64')) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

async function deflate(u8) {
  if (typeof CompressionStream !== 'undefined') return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const { deflateSync } = await import('node:zlib');
  return new Uint8Array(deflateSync(u8, { level: 9 }));
}
async function inflate(u8) {
  if (typeof DecompressionStream !== 'undefined') return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const { inflateSync } = await import('node:zlib');
  return new Uint8Array(inflateSync(u8));
}

/** Pack → JSON-safe object. Heights are stored as whole metres (Int16), buildings as decimetres (Uint16). */
export async function encodePlace(p) {
  const N = p.meta.n ** 2;
  const h = new Int16Array(N), b = new Uint16Array(N);
  for (let k = 0; k < N; k++) { h[k] = Math.round(p.height[k]); b[k] = Math.min(65535, Math.round(p.bld[k] * 10)); }
  const bytes = new Uint8Array(N * 5);
  bytes.set(new Uint8Array(h.buffer), 0); bytes.set(new Uint8Array(b.buffer), N * 2); bytes.set(p.kind, N * 4);
  return { v: p.v, meta: p.meta, labels: p.labels, grids: b64(await deflate(bytes)) };
}

/** JSON object from encodePlace → pack with typed-array grids. */
export async function decodePlace(o) {
  const N = o.meta.n ** 2, bytes = await inflate(unb64(o.grids));
  const h = new Int16Array(bytes.buffer.slice(0, N * 2)), b = new Uint16Array(bytes.buffer.slice(N * 2, N * 4));
  const height = Float32Array.from(h), bld = new Float32Array(N);
  for (let k = 0; k < N; k++) bld[k] = b[k] / 10;
  return { v: o.v, meta: o.meta, labels: o.labels, height, bld, kind: bytes.slice(N * 4, N * 5) };
}

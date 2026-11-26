/* ── Web Mercator + a local metric frame ──
   Tiles use the standard XYZ scheme. A "frame" is a square patch of ground
   centred on (lat, lon): x grows east and z grows south, both in metres,
   which is the same handedness the voxel builder uses (+x right, +z toward
   the viewer). The frame uses an equirectangular approximation around its
   centre, which is exact to well under a cell for patches up to ~50 km. */

const R = 6378137;
export const EARTH_CIRC = 2 * Math.PI * R; // metres at the equator
const D2R = Math.PI / 180;

export const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export const latToTileY = (lat, z) => {
  const r = lat * D2R;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
export const tileXToLon = (x, z) => (x / 2 ** z) * 360 - 180;
export const tileYToLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / D2R;

/** Ground metres per pixel of a 256-px tile at zoom z and latitude lat. */
export const metresPerPixel = (lat, z) => (EARTH_CIRC * Math.cos(lat * D2R)) / (256 * 2 ** z);

/** The deepest zoom (≤ maxZ) whose pixels are no smaller than `metres` — i.e. enough detail for a cell of that size. */
export function zoomForResolution(lat, metres, maxZ, minZ = 0) {
  let z = maxZ;
  while (z > minZ && metresPerPixel(lat, z) < metres / 2) z--;
  return z;
}

/**
 * A square ground frame of `sizeM` metres sampled by an n×n grid of cells.
 * Cell (i, j) covers x ∈ [i·cell, (i+1)·cell) from the west edge, z likewise from the north edge.
 */
export function makeFrame(lat, lon, sizeM, n) {
  const cosL = Math.max(1e-6, Math.cos(lat * D2R));
  const mPerDegLat = 111320, mPerDegLon = 111320 * cosL;
  const half = sizeM / 2, cell = sizeM / n;
  return {
    lat, lon, sizeM, n, cell,
    /** lon/lat → frame metres (origin at the NW corner) */
    toXZ: (lo, la) => [(lo - lon) * mPerDegLon + half, (lat - la) * mPerDegLat + half],
    /** frame metres → [lon, lat] */
    toLonLat: (x, z) => [lon + (x - half) / mPerDegLon, lat - (z - half) / mPerDegLat],
    bbox: {
      west: lon - half / mPerDegLon, east: lon + half / mPerDegLon,
      north: lat + half / mPerDegLat, south: lat - half / mPerDegLat,
    },
  };
}

/** Tile x/y ranges at zoom z that cover a frame's bbox. */
export function tilesCovering(frame, z) {
  const n = 2 ** z, b = frame.bbox;
  const x0 = Math.floor(lonToTileX(b.west, z)), x1 = Math.floor(lonToTileX(b.east, z));
  const y0 = Math.max(0, Math.floor(latToTileY(b.north, z))), y1 = Math.min(n - 1, Math.floor(latToTileY(b.south, z)));
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ z, x: ((x % n) + n) % n, y, ux: x });
  return out;
}

/** Run async jobs with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** fetch with one retry; resolves null on 404/204 (an empty tile). */
export async function fetchBytes(url, { retries = 1, headers } = {}) {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(url, headers ? { headers } : undefined);
      if (r.status === 404 || r.status === 204) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (a >= retries) throw e;
      await new Promise((res) => setTimeout(res, 500 * (a + 1)));
    }
  }
}

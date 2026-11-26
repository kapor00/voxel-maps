/* ── Terrain heights from the free AWS Terrain Tiles (Terrarium PNGs) ──
   height(m) = R·256 + G + B/256 − 32768. Global coverage, no key. Ocean
   tiles carry bathymetry (negative heights); callers decide the sea level. */

import { latToTileY, lonToTileX, pool, fetchBytes, tilesCovering, zoomForResolution } from './mercator.js';
import { decodePng } from './png.js';

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/**
 * Sample terrain height (metres) at the centre of every cell of `frame`.
 * Picks the deepest zoom whose pixels match the cell size, capped so at most `maxTiles` are fetched.
 * @returns {{ height: Float32Array, zoom: number, tiles: number, metresPerPixel: number }}
 */
export async function sampleElevation(frame, { maxZoom = 15, maxTiles = 64, url = TERRARIUM_URL, concurrency = 8 } = {}) {
  let z = zoomForResolution(frame.lat, frame.cell, maxZoom, 1);
  while (z > 1 && tilesCovering(frame, z).length > maxTiles) z--;
  const tiles = tilesCovering(frame, z);
  const decoded = await pool(tiles, concurrency, async (t) => {
    const bytes = await fetchBytes(url.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y));
    if (!bytes) return null;
    const img = await decodePng(bytes);
    const h = new Float32Array(img.width * img.height);
    for (let i = 0, d = img.data; i < h.length; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
    return { ...t, w: img.width, h };
  });
  const byKey = new Map(decoded.filter(Boolean).map((t) => [t.ux + ',' + t.y, t]));
  // global pixel → height, bilinear across tile seams
  const px = (gx, gy) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256), t = byKey.get(tx + ',' + ty);
    if (!t) return NaN;
    return t.h[(gy - ty * 256) * t.w + (gx - tx * 256)];
  };
  const { n, cell } = frame;
  const height = new Float32Array(n * n);
  let missing = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [lon, lat] = frame.toLonLat((i + 0.5) * cell, (j + 0.5) * cell);
      const fx = lonToTileX(lon, z) * 256 - 0.5, fy = latToTileY(lat, z) * 256 - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
      let v = (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
      if (!Number.isFinite(v)) { v = [a, b, c, d].find(Number.isFinite) ?? 0; missing++; }
      height[j * n + i] = v;
    }
  }
  const mpp = (40075016.686 * Math.cos((frame.lat * Math.PI) / 180)) / (256 * 2 ** z);
  return { height, zoom: z, tiles: tiles.length, metresPerPixel: mpp, missing };
}

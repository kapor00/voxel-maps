/* ── Water, buildings, roads and labels from OpenFreeMap vector tiles ──
   OpenMapTiles schema, z ≤ 14, CDN, no key. The water layer already holds
   the pre-computed ocean polygons, so coastlines come out exact. Everything
   is rasterised onto the frame's grid: neighbouring tiles overlap in their
   buffers, which is harmless for max/or writes. */

import { decodeMVT, ringArea, tileTemplate, tileURL } from './mvt.js';
import { pool, fetchBytes, tilesCovering, tileXToLon, tileYToLat } from './mercator.js';
import { fillPolygon, strokeLine } from './raster.js';

/** Road classes, in drawing priority (wider wins): [id, OpenMapTiles class, width in metres]. */
export const ROAD_CLASSES = [
  [1, 'motorway', 22], [2, 'trunk', 18], [3, 'primary', 15], [4, 'secondary', 12], [5, 'tertiary', 10],
  [6, 'minor', 8], [7, 'service', 5], [8, 'track', 4], [9, 'path', 2.5], [10, 'rail', 6],
];
const ROAD = Object.fromEntries(ROAD_CLASSES.map(([id, cls, w]) => [cls, { id, w }]));
const ROAD_ALIAS = { unclassified: 'minor', living_street: 'minor', busway: 'service', raceway: 'track', pedestrian: 'path', transit: 'rail' };

/** Land cover classes (3 bits in the pack's kind byte): [id, name, drawing priority]. */
export const COVER_CLASSES = [[1, 'grass', 1], [2, 'wood', 4], [3, 'farmland', 2], [4, 'sand', 5], [5, 'rock', 6], [6, 'ice', 7], [7, 'wetland', 3]];
const COVER = Object.fromEntries(COVER_CLASSES.map(([id, name, pri]) => [name, { id, pri }]));
// OpenMapTiles landcover classes, plus the landuse/park classes that read as green space in a city
const COVER_FROM = { grass: 'grass', wood: 'wood', farmland: 'farmland', sand: 'sand', rock: 'rock', ice: 'ice', wetland: 'wetland' };
const LANDUSE_GREEN = new Set(['park', 'cemetery', 'pitch', 'playground', 'garden', 'stadium', 'zoo']);

const LABELS = {
  place: { city: 100, town: 86, island: 60, village: 56, suburb: 46, hamlet: 40, quarter: 36, neighbourhood: 34 },
  poi: { attraction: 68, monument: 67, castle: 67, museum: 66, theme_park: 64, zoo: 60, stadium: 58, place_of_worship: 58, viewpoint: 56, lighthouse: 56, university: 52, park: 50 },
};

/**
 * @param frame from makeFrame
 * @param opts.zoom vector zoom (≤ 14); default: 14 for city-scale cells, lower for big landscapes
 * @returns {{ water: Uint8Array, bldH: Float32Array, road: Uint8Array, cover: Uint8Array, labels: object[], stats: object }}
 */
export async function sampleVectors(frame, { zoom, maxTiles = 100, buildings = true, roads = true, concurrency = 8 } = {}) {
  const { n, cell } = frame;
  let z = zoom ?? (cell <= 25 ? 14 : cell <= 60 ? 13 : 12);
  while (z > 6 && tilesCovering(frame, z).length > maxTiles) z--;
  const tiles = tilesCovering(frame, z);
  const tpl = await tileTemplate();
  const water = new Uint8Array(n * n), bldH = new Float32Array(n * n), road = new Uint8Array(n * n);
  const roadW = new Float32Array(n * n);
  const cover = new Uint8Array(n * n), coverPri = new Uint8Array(n * n);
  const labels = [];
  const stats = { zoom: z, tiles: tiles.length, waterFeatures: 0, buildings: 0, roads: 0, cover: 0, failed: 0 };
  const seen = new Set();

  await pool(tiles, concurrency, async (t) => {
    let bytes;
    try { bytes = await fetchBytes(tileURL(tpl, t.z, t.x, t.y)); } catch { stats.failed++; return; }
    if (!bytes) return;
    const tile = decodeMVT(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    // tile-local integer coords → frame cell units
    const proj = (L) => {
      const ext = L.extent;
      return (px, py) => {
        const [x, y] = frame.toXZ(tileXToLon(t.ux + px / ext, t.z), tileYToLat(t.y + py / ext, t.z));
        return [x / cell, y / cell];
      };
    };
    const ringPts = (ring, P) => { const out = []; for (let i = 0; i < ring.length; i += 2) out.push(P(ring[i], ring[i + 1])); return out; };

    // land cover: forests, grass and parks, farmland, sand, bare rock, glaciers, wetland
    const putCover = (name) => { const c = COVER[name]; return (k) => { if (c.pri >= coverPri[k]) { coverPri[k] = c.pri; cover[k] = c.id; } }; };
    for (const [layer, pick] of [
      ['landcover', (p) => COVER_FROM[p.class]],
      ['landuse', (p) => (LANDUSE_GREEN.has(p.class) ? 'grass' : null)],
      ['park', () => (cell <= 25 ? 'grass' : null)], // national parks would paint whole landscapes green
    ]) {
      const L = tile.layers[layer];
      if (!L) continue;
      const P = proj(L);
      for (const f of L.features) {
        const name = f.type === 3 && pick(f.props);
        if (!name) continue;
        fillPolygon(n, f.rings.map((r) => ringPts(r, P)), putCover(name));
        stats.cover++;
      }
    }

    const wl = tile.layers.water;
    if (wl) {
      const P = proj(wl);
      for (const f of wl.features) {
        if (f.type !== 3 || f.props.class === 'swimming_pool') continue;
        fillPolygon(n, f.rings.map((r) => ringPts(r, P)), (k) => { water[k] = 1; });
        stats.waterFeatures++;
      }
    }
    const ww = tile.layers.waterway;
    if (ww) {
      const P = proj(ww);
      for (const f of ww.features) {
        if (f.type !== 2 || f.props.brunnel === 'tunnel' || +f.props.intermittent === 1) continue;
        // small streams and ditches are thinner than a landscape-scale cell: drawing them floods the map
        if (f.props.class !== 'river' && f.props.class !== 'canal' && cell > 15) continue;
        const wM = f.props.class === 'river' ? 50 : f.props.class === 'canal' ? 16 : 6;
        for (const line of f.rings) strokeLine(n, ringPts(line, P), wM / 2 / cell, (k) => { water[k] = 1; });
        stats.waterFeatures++;
      }
    }
    const bl = buildings && tile.layers.building;
    if (bl) {
      const P = proj(bl);
      for (const f of bl.features) {
        if (f.type !== 3 || f.props.hide_3d) continue;
        const key = f.id != null ? 'b' + f.id : null;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        // group each exterior ring (positive area in tile space) with the holes that follow it
        const polys = [];
        for (const r of f.rings) { if (r.length < 6) continue; if (ringArea(r) > 0 || !polys.length) polys.push([r]); else polys.at(-1).push(r); }
        let h = +f.props.render_height || 0;
        for (const poly of polys) {
          const rings = poly.map((r) => ringPts(r, P));
          if (!(h > 0)) { // no height tag: guess from footprint, like the prototype
            let a = 0; const r0 = rings[0];
            for (let k = 0; k < r0.length; k++) { const [x0, y0] = r0[k], [x1, y1] = r0[(k + 1) % r0.length]; a += x0 * y1 - x1 * y0; }
            const foot = Math.abs(a / 2) * cell * cell;
            h = foot > 1600 ? 14 : 7;
          }
          const hh = Math.min(h, 450);
          if (fillPolygon(n, rings, (k) => { if (hh > bldH[k]) bldH[k] = hh; })) stats.buildings++;
        }
      }
    }
    const tr = roads && tile.layers.transportation;
    if (tr) {
      const P = proj(tr);
      for (const f of tr.features) {
        if (f.type !== 2 || f.props.brunnel === 'tunnel') continue;
        const cls = ROAD[f.props.class] ? f.props.class : ROAD_ALIAS[f.props.class];
        const def = cls && ROAD[cls];
        if (!def) continue;
        for (const line of f.rings) {
          if (line.length < 4) continue;
          strokeLine(n, ringPts(line, P), def.w / 2 / cell, (k) => { if (def.w > roadW[k]) { roadW[k] = def.w; road[k] = def.id; } });
        }
        stats.roads++;
      }
    }
    for (const [layer, pri] of [['place', LABELS.place], ['poi', LABELS.poi], ['mountain_peak', null], ['water_name', null]]) {
      const L = tile.layers[layer];
      if (!L) continue;
      const P = proj(L);
      for (const f of L.features) {
        const name = f.props['name:en'] || f.props.name;
        if (f.type !== 1 || !name || !f.rings.length) continue;
        const score = pri ? pri[f.props.class] : layer === 'mountain_peak' ? 76 : 70;
        if (!score) continue;
        const [x, y] = P(f.rings[0][0], f.rings[0][1]);
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const k = layer + ':' + name;
        if (seen.has(k)) continue;
        seen.add(k);
        labels.push({ name: String(name), kind: layer === 'place' || layer === 'poi' ? String(f.props.class) : layer, score, x: x * cell, z: y * cell, ele: +f.props.ele || undefined });
      }
    }
  });
  labels.sort((a, b) => b.score - a.score);
  return { water, bldH, road, cover, labels, stats };
}

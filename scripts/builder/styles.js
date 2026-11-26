/* ── Styles: how a voxel place is coloured ──
   A style is mostly data: one row of colour stops per cell type, sampled
   left→right by a 0..1 value (terrain height for ground types, building
   height for buildings and roofs, road class for roads, a per-cell hash for
   trees, a per-level hash for the strata on the crop's cut faces). One shared
   shader reads the rows, lights the voxels and draws their edges, so a new
   style is a copy of an existing one with other colours.

   Rows: cut, land, grass, wood, farmland, sand, rock, ice, wetland, water,
   road, building (walls), roof (building tops), tree.
   Options:
     background   page colour for the scene (also what the immersive edge fades into)
     frame        colour of the crop's wireframe; pedestal: colour of its base
     edge         0..1, how dark voxel edges are drawn (1 = none)
     ambient      0..1, light on faces turned away from the sun
     glow         rows drawn unlit, e.g. ['road'] for a night city
     windows      { color, density } lit windows on building walls (unlit, like glow)
     fallback     flat colour where custom shaders can't run (WebGL2, <spline-viewer>) */

export const ROWS = ['cut', 'land', 'grass', 'wood', 'farmland', 'sand', 'rock', 'ice', 'wetland', 'water', 'road', 'building', 'roof', 'tree'];
export const ROW = Object.fromEntries(ROWS.map((r, i) => [r, i]));
export const ROW_COUNT = 16; // texture rows; the spare ones are for future cell types
/** uv.y a mesh vertex carries for a row (its texture row centre). */
export const rowV = (name) => (ROW[name] + 0.5) / ROW_COUNT;

export const STYLES = {
  /** Natural colours: green lowlands to rock and snow, cream buildings, warm rock strata on the cut. */
  strata: {
    label: 'Strata',
    background: '#140e20', frame: '#b0a4c4', pedestal: '#120c1e', fallback: '#b9a98c',
    edge: 0.8, ambient: 0.58,
    rows: {
      cut: ['#b44b22', '#8e3318', '#c9663a', '#742814', '#d8a06a', '#a03c1c', '#62200f', '#e0b880'],
      land: ['#8aa05a', '#b0a86a', '#c9b27c', '#9c8470', '#8a7a72', '#f2f0ea'],
      grass: ['#5f8f3c', '#77a24a', '#94a95a'],
      wood: ['#2f5a2c', '#3e6a34', '#557a3e'],
      farmland: ['#b9b06a', '#c7b878', '#a8a060'],
      sand: ['#e8d7a6', '#f0dfae'],
      rock: ['#8d8178', '#a1958a', '#bdb3a8'],
      ice: ['#dfe9f0', '#f4f8fb'],
      wetland: ['#6f8a5a', '#80946a'],
      water: ['#2c6fa3', '#3d86bd'],
      road: ['#4a4a50', '#5c5c62', '#6e6e72'],
      building: ['#efe2c8', '#e4d6bd', '#c9d6df', '#b8cfe0'],
      roof: ['#9e8c7c', '#b3a08e', '#c4d2dc', '#d6e2ea'],
      tree: ['#2e5e2a', '#3b7034', '#4c7f38', '#5d8c40'],
    },
  },

  /** An architect's white model: one warm white, water a pale grey-blue, roads cut slightly darker. */
  model: {
    label: 'White model',
    background: '#d9d6cf', frame: '#8f8a80', pedestal: '#bdb8ae', fallback: '#ece8e1',
    edge: 0.9, ambient: 0.68,
    rows: {
      cut: ['#d8d3ca', '#cbc6bc', '#e2ddd4', '#c2bdb3'],
      land: ['#eeebe4', '#f3f0ea'], grass: ['#e6e8df'], wood: ['#dfe3d8'], farmland: ['#ebe8df'],
      sand: ['#efe9dc'], rock: ['#e4e0d8'], ice: ['#f6f6f4'], wetland: ['#e2e6df'],
      water: ['#b8c7cf', '#c4d1d8'], road: ['#d2cfc8'],
      building: ['#f4f2ee', '#f7f5f1'], roof: ['#f9f8f5'], tree: ['#e3e6dc', '#e9ebe3'],
    },
  },

  /** Night city: dark blocks, glowing roads and lit windows, black water, cool strata. */
  night: {
    label: 'Night',
    background: '#07080d', frame: '#5e6a8a', pedestal: '#05060a', fallback: '#1d1f2a',
    edge: 0.75, ambient: 0.5, glow: ['road'], windows: { color: '#ffd08a', density: 0.28 },
    rows: {
      cut: ['#141824', '#1b2030', '#10131c', '#232a3e'],
      land: ['#12141b', '#1a1d26', '#262a36'], grass: ['#111a14', '#15201a'], wood: ['#0c140f', '#101a13'],
      farmland: ['#16161a'], sand: ['#1e1c1a'], rock: ['#1c1e24'], ice: ['#2a3140'], wetland: ['#10161a'],
      water: ['#0d1a2e', '#14253f'], road: ['#c9782f', '#ffb25a', '#ffd08f'],
      building: ['#151925', '#1b2030', '#222a3d'], roof: ['#10131b', '#161a26'], tree: ['#0b140e', '#0f1a12'],
    },
  },

  /** Snow day: fresh snow on everything, dark water and warm windows, for a December card. */
  snow: {
    label: 'Snow',
    background: '#c9d3df', frame: '#7d8ca0', pedestal: '#a9b4c2', fallback: '#eef2f6',
    edge: 0.82, ambient: 0.72, windows: { color: '#ffcf7a', density: 0.1 },
    rows: {
      cut: ['#8a94a6', '#9aa4b5', '#7a8496', '#b4bccb'],
      land: ['#f3f6f9', '#ffffff'], grass: ['#eef3f6'], wood: ['#3f5a4a', '#55705e'], farmland: ['#f6f8fa'],
      sand: ['#eef0f2'], rock: ['#9aa2ad', '#c9cfd6'], ice: ['#ffffff'], wetland: ['#e8eef2'],
      water: ['#2a3b4e', '#34495f'], road: ['#a9b0b9', '#bcc2ca'],
      building: ['#d9c7b4', '#c9b8a6', '#b9c6d3'], roof: ['#ffffff', '#f6f9fb'], tree: ['#2f4a3c', '#3c5a49', '#f4f7f9'],
    },
  },
};

const hexRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** The style's rows as an RGBA8 image: `width` px per row, ROW_COUNT rows. */
export function paletteImage(style, width = 64) {
  const data = new Uint8Array(width * ROW_COUNT * 4);
  ROWS.forEach((name, r) => {
    const stops = (style.rows[name] || style.rows.land).map(hexRGB);
    for (let x = 0; x < width; x++) {
      const t = (x / (width - 1)) * (stops.length - 1), i = Math.min(Math.max(0, stops.length - 2), Math.floor(t));
      const a = stops[i], b = stops[Math.min(stops.length - 1, i + 1)], f = t - i;
      const o = (r * width + x) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(a[c] + (b[c] - a[c]) * f);
      data[o + 3] = 255;
    }
  });
  return { data, width, height: ROW_COUNT };
}

/**
 * The shared voxel material, built only from the three namespace Spline passes in.
 * @param three  what spline.createCustomMaterial hands its factory
 * @param style  a STYLES entry, or your own object of the same shape
 * @param o.voxel world units per voxel
 * @param o.fade  { radius, start } — immersive mode: dissolve into the background from start×radius to radius
 */
export function voxelMaterial(three, style, { voxel, fade } = {}) {
  const T = three.tsl;
  const img = paletteImage(style);
  const tex = new three.DataTexture(img.data, img.width, img.height, three.RGBAFormat);
  tex.magFilter = three.LinearFilter; tex.minFilter = three.LinearFilter; tex.needsUpdate = true;

  const m = new three.MeshBasicNodeMaterial();
  const N = T.normalize(T.normalWorld), v = T.uv().y, U = T.uv().x;
  const rowMask = (name) => T.step(ROW[name] / ROW_COUNT, v).mul(T.float(1).sub(T.step((ROW[name] + 1) / ROW_COUNT, v)));
  const hash = (x) => T.fract(T.sin(x.mul(12.9898).add(4.1414)).mul(43758.5453));
  const side = T.float(1).sub(T.abs(N.y)); // 1 on walls, 0 on tops
  const level = T.floor(T.positionWorld.y.div(voxel).add(0.001));
  const isCut = rowMask('cut'), isBuilding = rowMask('building');

  // cut faces pick a strata band per pair of voxel levels; building tops read the roof row
  const u = T.mix(U, hash(T.floor(level.div(2))), isCut);
  const vv = v.add(isBuilding.mul(T.float(1).sub(side)).mul(1 / ROW_COUNT));
  let c = T.texture(tex, T.vec2(u, vv)).rgb;
  let unlit = T.float(0);
  for (const name of style.glow || []) unlit = unlit.add(rowMask(name));
  if (style.windows) {
    const cell = T.floor(T.positionWorld.div(voxel / 3));
    const lit = T.step(1 - style.windows.density, hash(T.dot(cell, T.vec3(1.0, 57.0, 113.0)))).mul(side).mul(isBuilding);
    c = T.mix(c, T.vec3(...hexRGB(style.windows.color).map((x) => x / 255)), lit);
    unlit = unlit.add(lit);
  }

  const L = T.normalize(T.vec3(-0.5, 0.8, 0.35));
  const wrap = T.dot(N, L).mul(0.5).add(0.5), top = T.smoothstep(0.5, 0.9, N.y);
  const f = T.abs(T.fract(T.positionWorld.div(voxel)).sub(0.5));
  const e = T.smoothstep(0.43, 0.5, T.max(T.max(f.x.mul(T.abs(N.x).oneMinus()), f.y.mul(T.abs(N.y).oneMinus())), f.z.mul(T.abs(N.z).oneMinus())));
  const band = T.mix(1, T.mix(0.86, 1.12, T.mod(level, 2)), isCut); // strata read as layers
  const lit = c.mul(band).mul(T.mix(style.ambient ?? 0.6, 1.05, wrap)).mul(T.mix(0.84, 1, top)).mul(T.mix(1, style.edge ?? 0.8, e));
  let out = T.mix(lit, c, T.clamp(unlit, 0, 1));

  if (fade) {
    // immersive: dissolve toward the background with distance from the centre (dithered, so no sorting issues)
    const k = T.smoothstep(fade.start, 1, T.length(T.positionWorld.xz).div(fade.radius));
    out = T.mix(out, T.vec3(...hexRGB(style.background).map((x) => x / 255)), k);
    m.opacityNode = T.step(T.interleavedGradientNoise(T.screenCoordinate.xy), T.float(1).sub(k.mul(k)));
    m.alphaTest = 0.5;
  }
  m.colorNode = out;
  m.toneMapped = false;
  return m;
}

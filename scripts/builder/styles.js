/* ── Styles: how a voxel place is coloured ──
   A style is mostly data: one row of colour stops per cell type, sampled
   left→right by a 0..1 value (terrain height for ground types, building
   height for buildings and roofs, road class for roads, a per-cell hash for
   trees, a per-band hash for the strata on the crop's cut faces). One shared
   shader reads the rows, lights the voxels and draws their edges, so a new
   style is a copy of an existing one with other colours.

   Rows (cell types):
     cut       strata on the crop's cut faces
     land grass wood farmland sand rock ice wetland   ground tops, by cover
     side      ground column walls (terraces, cliffs), by height
     water     by depth: shore → open water (distance from the bank)
     road
     building  walls · roof  building tops · tree
   Options:
     background   page colour for the scene (also what the immersive edge fades into)
     frame        colour of the crop's wireframe · pedestal: colour of its base
     key, fill    sun and shadow tints (lighting is warm key / cool fill)
     edge         0..1, how dark voxel edges are drawn (1 = none)
     tints        [{ color, amount }] regional colour patches on open ground
     glow         rows drawn unlit, e.g. ['road'] for a night city
     windows      { color, density } lit windows on building walls (unlit, like glow)
     steps        rows that pick one stop instead of blending, e.g. ['building', 'roof']: each
                  building takes one slot (its id picks it; towers take the last), so walls and
                  roofs come in a few distinct colours rather than a blur
     sky          what water reflects at grazing angles; water: false turns the water effects off
     fallback     flat colour where custom shaders can't run (WebGL2, <spline-viewer>)
     flat         { ground, water, road, building, roof, tree, cut } plain colours for baked
                  (editable) scenes, which use Spline materials instead of this shader */

export const ROWS = ['cut', 'land', 'grass', 'wood', 'farmland', 'sand', 'rock', 'ice', 'wetland', 'water', 'road', 'building', 'roof', 'tree', 'side'];
export const ROW = Object.fromEntries(ROWS.map((r, i) => [r, i]));
export const ROW_COUNT = 16; // texture rows; the spare one is for a future cell type
/** uv.y a mesh vertex carries for a row (its texture row centre). */
export const rowV = (name) => (ROW[name] + 0.5) / ROW_COUNT;
const GROUND = ['land', 'grass', 'wood', 'farmland', 'sand', 'rock', 'ice', 'wetland'];

// ── colour helpers: themes and the panel's one-swatch-per-class editing are built from these ──
const clamp01 = (x) => Math.min(1, Math.max(0, x));
function hexToHsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, l];
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s = clamp01(s); l = clamp01(l);
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}
/** hex nudged in hue (degrees), saturation and lightness (both -1..1, added). */
export function shift(hex, dh = 0, ds = 0, dl = 0) { const [h, s2, l] = hexToHsl(hex); return hslToHex(h + dh, s2 + ds, l + dl); }
export function mixHex(a, b, t) {
  const A = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16)), B = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
const variants = (hex, n = 3, spread = 0.06) => Array.from({ length: n }, (_, i) => shift(hex, (i - 1) * 4, 0, (i % 2 ? -1 : 1) * spread * Math.ceil(i / 2)));

/**
 * A whole style from a few key colours: { label, background, ground, high, green, forest, fields, sand,
 * rock, snow, cliff, water: [shore, deep], road, walls: [5 + glass], roofs: [5 + glass], strata: [...],
 * key, fill, sky, edge?, tints?, glow?, windows?, frame?, pedestal? }
 */
export function theme(t) {
  const water = [t.water[0], mixHex(t.water[0], t.water[1], 0.45), mixHex(t.water[0], t.water[1], 0.75), t.water[1]];
  return {
    label: t.label, background: t.background, frame: t.frame || shift(t.background, 0, -0.2, 0.55), pedestal: t.pedestal || shift(t.background, 0, 0, -0.03),
    fallback: t.ground, key: t.key || '#ffffff', fill: t.fill || '#6a6f9c', edge: t.edge ?? 0.8, sky: t.sky || '#cfe3f5',
    steps: ['building', 'roof'], tints: t.tints || [], glow: t.glow, windows: t.windows, water: t.waterFx === false ? false : undefined,
    ...Object.fromEntries(['hue', 'sat', 'bright', 'contrast', 'warm', 'grad', 'deep', 'rim', 'rimColor', 'sheen'].filter((k) => t[k] != null).map((k) => [k, t[k]])),
    rows: {
      cut: t.strata,
      land: [t.ground, mixHex(t.ground, t.high, 0.25), mixHex(t.ground, t.high, 0.5), mixHex(t.ground, t.high, 0.75), t.high, t.snow],
      grass: variants(t.green), wood: variants(t.forest), farmland: variants(t.fields), sand: [t.sand, shift(t.sand, 0, 0, 0.05)],
      rock: variants(t.rock), ice: [t.snow, '#ffffff'], wetland: variants(mixHex(t.green, t.water[0], 0.35), 2),
      side: [t.cliff, shift(t.cliff, 0, 0, -0.08), shift(t.cliff, 0, 0, -0.17), shift(t.cliff, 0, 0, -0.27)],
      water, road: variants(t.road, 3, 0.04), building: t.walls, roof: t.roofs, tree: variants(t.tree || t.forest, 4, 0.05),
    },
    flat: { ground: t.ground, side: t.cliff, water: water[1], road: t.road, building: t.walls[0], roof: t.roofs[0], tree: t.tree || t.forest, cut: t.strata.slice(0, 4) },
  };
}

/** The colour a key swatch shows for a style, by panel key. */
export const KEY_COLORS = {
  ground: (st) => st.rows.land[1], green: (st) => st.rows.grass[0], water: (st) => st.rows.water[Math.min(1, st.rows.water.length - 1)],
  roads: (st) => st.rows.road[Math.min(1, st.rows.road.length - 1)], walls: (st) => st.rows.building[0], roofs: (st) => st.rows.roof[0],
  strata: (st) => st.rows.cut[0], background: (st) => st.background,
};
/** Recolour a whole class from one swatch, keeping each row's shape (ramps, variety, the glass slot). Mutates st. */
export function recolor(st, key, hex) {
  const R = st.rows;
  // move every stop of a row by the hue/sat/light delta between its key colour and the new one
  const retint = (row, from) => {
    const [h0, s0, l0] = hexToHsl(from), [h1, s1, l1] = hexToHsl(hex);
    R[row] = R[row].map((c, i) => (st.steps?.includes(row) && i === R[row].length - 1 ? c : shift(c, h1 - h0, s1 - s0, l1 - l0)));
  };
  if (key === 'ground') { const f = KEY_COLORS.ground(st), peak = R.land[R.land.length - 1]; retint('land', f); R.land[R.land.length - 1] = peak; retint('side', f); }
  else if (key === 'green') { const f = KEY_COLORS.green(st); for (const r of ['grass', 'wood', 'farmland', 'tree', 'wetland']) retint(r, f); }
  else if (key === 'water') retint('water', KEY_COLORS.water(st));
  else if (key === 'roads') retint('road', KEY_COLORS.roads(st));
  // walls and roofs are a set of distinct slots (one per building): regenerate them as variations of the new colour
  else if (key === 'walls' || key === 'roofs') {
    const row = key === 'walls' ? 'building' : 'roof', glass = R[row][R[row].length - 1];
    const set = [hex, shift(hex, 8, -0.05, -0.1), shift(hex, -10, 0.04, 0.07), shift(hex, 16, 0, -0.04), shift(hex, 0, -0.3, 0.04)];
    R[row] = st.steps?.includes(row) ? [...set, glass] : set.slice(0, R[row].length);
  }
  else if (key === 'strata') retint('cut', KEY_COLORS.strata(st));
  else if (key === 'background') { st.background = hex; st.frame = shift(hex, 0, -0.2, 0.55); st.pedestal = shift(hex, 0, 0, -0.03); }
  return st;
}

export const STYLES = {
  /** Vivid and natural: sage and olive ground, saturated greens, terracotta, slate and copper roofs over
   *  white and pastel walls, turquoise-to-deep water, rust rock strata on the cut. */
  strata: {
    label: 'Strata',
    background: '#140e20', frame: '#b0a4c4', pedestal: '#120c1e', fallback: '#b4b98a',
    key: '#fff6ea', fill: '#66709e', edge: 0.78, sky: '#cfe3f5',
    steps: ['building', 'roof'],
    tints: [{ color: '#7fb04a', amount: 0.22 }, { color: '#c0502a', amount: 0.12 }, { color: '#9fb6a0', amount: 0.15 }, { color: '#c06060', amount: 0.06 }],
    rows: {
      cut: ['#b44b22', '#8e3318', '#c9663a', '#742814', '#d8a06a', '#a03c1c', '#62200f', '#e0b880'],
      land: ['#a7bf8c', '#b1bd86', '#bab47e', '#b89a68', '#9f7a56', '#ece6da'],
      grass: ['#6cb43e', '#5aa236', '#84c34c'],
      wood: ['#2f7a34', '#3d8b3a', '#256a2c'],
      farmland: ['#c6cf68', '#b2c259', '#dbd689'],
      sand: ['#f0dc9e', '#f6e7b6'],
      rock: ['#b8714f', '#9a6a55', '#c9a07a'],
      ice: ['#eef4f8', '#ffffff'],
      wetland: ['#5f9a6e', '#72aa7c'],
      side: ['#c4a06c', '#a27648', '#7a5030', '#53321c'],
      water: ['#3fc0c4', '#269ad0', '#176cb2', '#0e4685'],
      road: ['#55555f', '#626270', '#727280'],
      // one slot per building: white, cream, peach, cool grey, sage · glass towers
      building: ['#f5f2eb', '#ecd8bb', '#f1c6a2', '#d6dce4', '#cddcc2', '#a9cde4'],
      // terracotta, slate, tile, brick, grey · glass
      roof: ['#c55a3b', '#4f5768', '#d0744a', '#a8462e', '#8e939d', '#d6ebf6'],
      tree: ['#3f8a30', '#4f9a38', '#5fae3e', '#78bf48'],
    },
    flat: { ground: '#b4c47c', side: '#a27648', water: '#2490cc', road: '#626270', building: '#ece2d2', roof: '#b4553a', tree: '#4f9a38', cut: ['#b44b22', '#c9663a', '#8e3318', '#d8a06a'] },
  },

  /** An architect's white model: one warm white, water a pale grey-blue, roads cut slightly darker. */
  model: {
    label: 'White model',
    background: '#d9d6cf', frame: '#8f8a80', pedestal: '#bdb8ae', fallback: '#ece8e1',
    key: '#ffffff', fill: '#b8bcc6', edge: 0.92, water: false, bevel: 0.7, sss: 0.5, shadow: 0.85, soft: 4, ao: 1, spec: 0.15, sunEl: 30, grad: 0.25, rim: 0.15, sheen: 0.2,
    rows: {
      cut: ['#d8d3ca', '#cbc6bc', '#e2ddd4', '#c2bdb3'],
      land: ['#eeebe4', '#f3f0ea'], grass: ['#e6e8df'], wood: ['#dfe3d8'], farmland: ['#ebe8df'],
      sand: ['#efe9dc'], rock: ['#e4e0d8'], ice: ['#f6f6f4'], wetland: ['#e2e6df'], side: ['#e2ded6', '#d6d1c8'],
      water: ['#b8c7cf', '#c4d1d8'], road: ['#d2cfc8'],
      building: ['#f4f2ee', '#f7f5f1'], roof: ['#f9f8f5'], tree: ['#e3e6dc', '#e9ebe3'],
    },
    flat: { ground: '#f0ede6', side: '#e2ded6', water: '#bccad2', road: '#d2cfc8', building: '#f6f4f0', roof: '#faf9f6', tree: '#e5e8de', cut: ['#d8d3ca', '#cbc6bc'] },
  },

  /** Night city: dark blocks, glowing roads and lit windows, deep water, cool strata. */
  night: {
    label: 'Night',
    background: '#07080d', frame: '#5e6a8a', pedestal: '#05060a', fallback: '#1d1f2a',
    key: '#9fb2ff', fill: '#2a2f4a', edge: 0.75, sky: '#3a4a78', glow: ['road'], windows: { color: '#ffd08a', density: 0.28 },
    rows: {
      cut: ['#1b2238', '#24304e', '#151b2c', '#2e3a5c'],
      land: ['#161a24', '#1d2230', '#2a3040'], grass: ['#13201a', '#18281f'], wood: ['#0f1a13', '#132017'],
      farmland: ['#1a1a20'], sand: ['#24211e'], rock: ['#22252e'], ice: ['#303a4c'], wetland: ['#121a1e'], side: ['#141824', '#10131c'],
      water: ['#1b3150', '#11223a', '#0a1526'], road: ['#c9782f', '#ffb25a', '#ffd08f'],
      building: ['#171c2a', '#1d2335', '#242c42'], roof: ['#12151e', '#181c29'], tree: ['#0c160f', '#101c13'],
    },
    flat: { ground: '#1a1e2a', side: '#141824', water: '#0f1d33', road: '#ffb25a', building: '#1d2335', roof: '#141824', tree: '#0f1a12', cut: ['#1b2238', '#24304e'] },
  },

  /** Snow day: sunlit snow with blue shadows, dark rock and water, warm windows, for a December card. */
  snow: {
    label: 'Snow',
    background: '#c3d2e4', frame: '#6c7e98', pedestal: '#8e9cb2', fallback: '#eef2f6',
    key: '#fff6ea', fill: '#7d93c4', edge: 0.8, sky: '#e4ecf6', windows: { color: '#ffcf7a', density: 0.1 },
    rows: {
      cut: ['#5d6a84', '#7a88a4', '#4c5872', '#97a4bf'],
      land: ['#f4f7fb', '#ffffff'], grass: ['#eef3f8'], wood: ['#2f5a46', '#3d6c55'], farmland: ['#f6f8fb'],
      sand: ['#eef1f4'], rock: ['#56606e', '#727d8c', '#8a95a4'], ice: ['#e6f2ff', '#ffffff'], wetland: ['#e6eef4'], side: ['#dde6f2', '#c7d3e6', '#a9b8d0'],
      water: ['#3a6f8c', '#244a68', '#16304a'], road: ['#9aa3b0', '#b4bcc6'],
      building: ['#c96e4a', '#d89a6a', '#b85c3c'], roof: ['#ffffff', '#f6f9fb'], tree: ['#24503c', '#2f6048', '#f4f7f9'],
    },
    flat: { ground: '#f4f7fb', side: '#9fb0c8', water: '#1d3550', road: '#a6aeba', building: '#c96e4a', roof: '#ffffff', tree: '#2a5a42', cut: ['#5d6a84', '#7a88a4'] },
  },
  /** Clay: Spline's toy look — saturated candy colours that deepen toward violet at the foot of every wall, a pink rim, on black. */
  clay: theme({
    label: 'Clay', background: '#000000', frame: '#b8a4e8', pedestal: '#0b0614', ground: '#8c9cf2', high: '#c79cf5', snow: '#fff4fb', green: '#5fd39a', forest: '#2fae7c',
    fields: '#ffcf6e', sand: '#ffd08f', rock: '#c77ef0', cliff: '#8f6cf0', water: ['#62d7ff', '#4a2fd0'], road: '#ffffff',
    key: '#fff6fb', fill: '#6f58d0', sky: '#ffdcf6',
    walls: ['#ffd6e4', '#e6d4ff', '#ffe2ef', '#d9c8ff', '#ffe6c4', '#bfe6ff'],
    roofs: ['#ff7aa2', '#c76ff3', '#ff95b8', '#a774f2', '#ffae42', '#e8f2ff'],
    strata: ['#c76ff3', '#7630bb', '#ff8fb4', '#5136a4', '#ff9baf', '#983c64'],
    edge: 0.94, sat: 1.12, contrast: 1.06, grad: 0.7, deep: '#3a1678', rim: 0.6, rimColor: '#ffdcf6', sheen: 0.45,
    bevel: 0.9, sss: 0.8, spec: 0.35, shadow: 0.72, soft: 4, ao: 0.85, sunI: 0.8, ambI: 0.95,
    tints: [{ color: '#a9b8ff', amount: 0.2 }, { color: '#c9a8f8', amount: 0.15 }],
  }),
  /** Clay Light: the classic soft clay render — pale candy clay on a light lavender ground, rounded voxels, soft shadows. */
  claylight: theme({
    label: 'Clay Light', background: '#e9e4f5', frame: '#a99ce0', pedestal: '#d9d2ee', ground: '#d4ccef', high: '#ece4ff', snow: '#ffffff',
    green: '#9fe0bf', forest: '#6cc79e', fields: '#ffe0a3', sand: '#ffe6c2', rock: '#cdb8f2', cliff: '#bba6ee', water: ['#9fdcff', '#6f7cf0'],
    road: '#ffffff', key: '#fffaf4', fill: '#9a8fd6', sky: '#ffffff',
    walls: ['#ffffff', '#fff0f5', '#f1edff', '#fff6e6', '#eef9ff', '#d9ecff'],
    roofs: ['#ffb3c7', '#c9b6ff', '#ffd29a', '#a9d8ff', '#b9f0d8', '#f2f7ff'],
    strata: ['#cdb8f2', '#b39ce8', '#f2c4d8', '#a58ee0', '#e6d8ff', '#c0aef0'],
    edge: 0.96, grad: 0.5, deep: '#6a52c0', rim: 0.3, rimColor: '#ffffff', sheen: 0.4,
    bevel: 1, sss: 0.9, spec: 0.25, shadow: 0.85, soft: 4, ao: 1, sunI: 1.02, ambI: 0.7, sunEl: 32,
    tints: [{ color: '#f6d6ec', amount: 0.15 }],
  }),
  pastel: theme({
    label: 'Pastel', background: '#efe9f4', ground: '#cfe3c8', high: '#f1dcc4', snow: '#ffffff', green: '#a6d8a0', forest: '#7fc28d', fields: '#e8e3a4',
    sand: '#f7e6c4', rock: '#e0b9b0', cliff: '#e9c9d8', water: ['#bfeaf0', '#7fb6e6'], road: '#c9c4d6', key: '#ffffff', fill: '#b9b6d8', sky: '#ffffff',
    walls: ['#ffffff', '#fde2e4', '#e2ecf9', '#fdf0d5', '#e4f4e4', '#d6e9fb'], roofs: ['#f4a6b8', '#a7c7e7', '#f9c88b', '#b9a7e3', '#a8dcc8', '#e8f4fb'],
    strata: ['#f4c7d3', '#e5b3c9', '#d7c3ec', '#f9dccd', '#c9b6e4', '#f2b8c6'], edge: 0.86, tints: [{ color: '#f9d5e5', amount: 0.15 }],
  }),
  desert: theme({
    label: 'Desert', background: '#2a1a12', ground: '#e8c48e', high: '#c98a52', snow: '#f6e7cf', green: '#9aa85a', forest: '#6f7f3d', fields: '#d8b46a',
    sand: '#f2d49a', rock: '#c2643a', cliff: '#d29a5c', water: ['#4ec3b8', '#1f6f8c'], road: '#7a5a48', key: '#fff0d8', fill: '#8a6a7c', sky: '#f6dcc0',
    walls: ['#f1dcc0', '#e9c79c', '#f6e6d0', '#dcb48a', '#f0d2b0', '#bfe0e6'], roofs: ['#c97a4a', '#e0a46a', '#b55e3a', '#d9b38a', '#a8805e', '#e8f2f2'],
    strata: ['#c2643a', '#e0965a', '#a9462a', '#f0c288', '#8a3a22', '#d47a44'], tints: [{ color: '#f0c070', amount: 0.25 }, { color: '#b85a30', amount: 0.15 }],
  }),
  autumn: theme({
    label: 'Autumn', background: '#1b1414', ground: '#c9b07a', high: '#9c7a52', snow: '#f4efe6', green: '#c8a43c', forest: '#b8542a', fields: '#d8a24a',
    sand: '#ead2a0', rock: '#8e6e5a', cliff: '#a8784a', water: ['#5aa0b0', '#204a6a'], road: '#5a4c4a', key: '#ffe8c8', fill: '#6a5a7c', sky: '#e8d8c8',
    walls: ['#f2e6d4', '#e6cfae', '#d9b896', '#cfd2d6', '#e8d8c0', '#b8d0dc'], roofs: ['#8a2e1e', '#4a4448', '#b4542e', '#6e3a2a', '#9a8a7a', '#d8e8ee'],
    strata: ['#8a3a1a', '#c0622a', '#6a2a14', '#d89a5a', '#4a1e0e', '#a84a20'], tree: '#d0742a', tints: [{ color: '#e0a030', amount: 0.25 }, { color: '#a03a1a', amount: 0.2 }],
  }),
  tropical: theme({
    label: 'Tropical', background: '#0b1f24', ground: '#b8d88a', high: '#7fae5a', snow: '#ffffff', green: '#3fc46a', forest: '#13924a', fields: '#c8e070',
    sand: '#fbe6b0', rock: '#9a8a70', cliff: '#c9a670', water: ['#38e0d0', '#0a5aa8'], road: '#5e6270', key: '#fffbe8', fill: '#4a7a9c', sky: '#d8f4ff',
    walls: ['#ffffff', '#ffe08a', '#ff9e8a', '#8ae0d0', '#f8c8e8', '#a8e8ff'], roofs: ['#ff6a4a', '#2a9adc', '#ffb030', '#3ac0a0', '#e85a9a', '#e0f8ff'],
    strata: ['#c97a4a', '#e8b070', '#a8582e', '#f6d29a', '#8a4422', '#d8904e'], tints: [{ color: '#20c070', amount: 0.25 }],
  }),
  blueprint: theme({
    label: 'Blueprint', background: '#0e2a52', ground: '#24508e', high: '#3a6cb0', snow: '#cfe4ff', green: '#2c5c98', forest: '#21487e', fields: '#2e5a96',
    sand: '#3a68a6', rock: '#4a78b8', cliff: '#1a3e72', water: ['#123864', '#0a2448'], road: '#7fb2ff', key: '#d8ecff', fill: '#3a5a9c', sky: '#2a5a9c',
    walls: ['#e8f2ff', '#cfe2ff', '#b8d4fc', '#dbe9ff', '#c4dbff', '#9cc4ff'], roofs: ['#ffffff', '#e2eeff', '#cfe2ff', '#f0f6ff', '#d8e8ff', '#bcd8ff'],
    strata: ['#1a3e72', '#2a5290', '#123060', '#3a66a8'], edge: 0.55, glow: ['road'], waterFx: false,
  }),
  neon: theme({
    label: 'Neon', background: '#05030c', ground: '#16122a', high: '#2a1e48', snow: '#e6d8ff', green: '#0e3a2e', forest: '#0a2a22', fields: '#1e1838',
    sand: '#2a2240', rock: '#3a2a5a', cliff: '#120e24', water: ['#00f0ff', '#2a0a6a'], road: '#ff2fd0', key: '#c8b0ff', fill: '#1a1240', sky: '#ff40e0',
    walls: ['#1a1636', '#221c44', '#2a2250', '#161230', '#1e1a3c', '#3a2a7a'], roofs: ['#00e8ff', '#ff3ad0', '#8a5aff', '#30ffb0', '#ffd23a', '#c8b0ff'],
    strata: ['#2a1a5a', '#3a1e7a', '#1a1040', '#5a2aa0'], edge: 0.6, glow: ['road'], windows: { color: '#00e8ff', density: 0.22 },
  }),
  ink: theme({
    label: 'Ink', background: '#f2efe8', ground: '#e6e2da', high: '#cfc9be', snow: '#ffffff', green: '#c9cbbf', forest: '#9a9c90', fields: '#dcd8cc',
    sand: '#ece6d8', rock: '#a8a29a', cliff: '#bdb7ad', water: ['#3a3a3e', '#1a1a1e'], road: '#4a4a4e', key: '#ffffff', fill: '#a8a8b4', sky: '#ffffff',
    walls: ['#f8f6f2', '#ecebe6', '#e2e0da', '#f2f0ea', '#e8e6e0', '#d8d8d8'], roofs: ['#2a2a2e', '#4a4a50', '#1a1a1e', '#6a6a70', '#3a3a3e', '#8a8a90'],
    strata: ['#3a3a3e', '#6a6a70', '#2a2a2e', '#9a9aa0'], edge: 0.62, waterFx: false,
  }),
};

const hexRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const vec = (T, h) => T.vec3(...hexRGB(h).map((x) => x / 255));

/** The style's rows as an RGBA8 image: `width` px per row, ROW_COUNT rows. */
export function paletteImage(style, width = 64) {
  const data = new Uint8Array(width * ROW_COUNT * 4);
  ROWS.forEach((name, r) => {
    const stops = (style.rows[name] || style.rows.land).map(hexRGB);
    const step = style.steps?.includes(name);
    for (let x = 0; x < width; x++) {
      if (step) { // nearest slot, no blending between neighbours
        const a = stops[Math.min(stops.length - 1, Math.floor((x / width) * stops.length))], o = (r * width + x) * 4;
        data[o] = a[0]; data[o + 1] = a[1]; data[o + 2] = a[2]; data[o + 3] = 255;
        continue;
      }
      const t = (x / (width - 1)) * (stops.length - 1), i = Math.min(Math.max(0, stops.length - 2), Math.floor(t));
      const a = stops[i], b = stops[Math.min(stops.length - 1, i + 1)], f = t - i;
      const o = (r * width + x) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(a[c] + (b[c] - a[c]) * f);
      data[o + 3] = 255;
    }
  });
  return { data, width, height: ROW_COUNT };
}

/** Everything the live controls can change without rebuilding, read from a style. */
export function styleUniformValues(style) {
  const t = style.tints || [];
  return {
    edge: style.edge ?? 0.8,
    key: style.key || '#ffffff', fill: style.fill || '#7078a0',
    sky: style.sky || '#cfe3f5', background: style.background || '#140e20',
    water: style.water === false ? 0 : 1,
    waves: style.waves ?? 1, reflect: style.reflect ?? 1, foam: style.foam ?? 1, glints: style.glints ?? 1,
    glow: (style.glow || []).includes('road') ? 1 : 0,
    windows: style.windows?.density ?? 0, windowColor: style.windows?.color || '#ffd08a',
    tints: [0, 1, 2, 3].map((i) => ({ color: t[i]?.color || '#000000', amount: t[i]?.amount ?? 0 })),
    tint: 1,
    hue: style.hue ?? 0, sat: style.sat ?? 1, bright: style.bright ?? 1, contrast: style.contrast ?? 1, warm: style.warm ?? 0,
    // the clay look: each wall runs light → deep (toward `deep`), a fresnel rim, a soft studio sheen
    grad: style.grad ?? 0.45, deep: style.deep || '#2a1458', rim: style.rim ?? 0.35, rimColor: style.rimColor || style.sky || '#ffffff',
    sheen: style.sheen ?? 0.3,
    // light: a sun you can move (degrees), its and the sky's strength, soft heightfield shadows and AO (GPU view),
    // bevelled voxel edges, subsurface wrap, specular (clay sheen, glossy glass towers), exposure
    sunAz: style.sunAz ?? -60, sunEl: style.sunEl ?? 33, sunI: style.sunI ?? 0.85, ambI: style.ambI ?? 0.85,
    shadow: style.shadow ?? 0.8, soft: style.soft ?? 6, ao: style.ao ?? 0.75, bevel: style.bevel ?? 0.45,
    sss: style.sss ?? 0.35, spec: style.spec ?? 0.3, exposure: style.exposure ?? 1,
  };
}

/**
 * The shared voxel material, built only from the three namespace Spline passes in.
 * Every look parameter is a uniform or the palette texture, so `material.placeControls`
 * can restyle it live: set(values) and setStyle(style), with no rebuild and no recompile.
 * @param three  what spline.createCustomMaterial hands its factory
 * @param style  a STYLES entry, or your own object of the same shape
 * @param o.voxel world units per voxel · o.band strata band thickness in voxels (default 3)
 * @param o.fade  { radius, start } — immersive mode: dissolve into the background from start×radius to radius
 * @param o.hook  (T, three, U, material) => { v, u } — replace the per-vertex row/value inputs (and set a
 *                positionNode): how gpu-view.js builds the voxels on the GPU with this same look
 */
export function voxelMaterial(three, style, { voxel, band = 3, fade, hook } = {}) {
  const T = three.tsl;
  const img = paletteImage(style);
  const tex = new three.DataTexture(img.data, img.width, img.height, three.RGBAFormat);
  tex.magFilter = three.LinearFilter; tex.minFilter = three.LinearFilter; tex.needsUpdate = true;
  const col = (h) => new three.Color(h);
  const v0 = styleUniformValues(style);
  const U = {
    voxel: T.uniform(voxel), band: T.uniform(band), edge: T.uniform(v0.edge),
    key: T.uniform(col(v0.key)), fill: T.uniform(col(v0.fill)), sky: T.uniform(col(v0.sky)), background: T.uniform(col(v0.background)),
    water: T.uniform(v0.water), waves: T.uniform(v0.waves), reflect: T.uniform(v0.reflect), foam: T.uniform(v0.foam), glints: T.uniform(v0.glints),
    glow: T.uniform(v0.glow), windows: T.uniform(v0.windows), windowColor: T.uniform(col(v0.windowColor)), tint: T.uniform(v0.tint),
    fade: T.uniform(fade ? 1 : 0), fadeRadius: T.uniform(fade?.radius ?? 1), fadeStart: T.uniform(fade?.start ?? 0.55),
    tints: v0.tints.map((t) => ({ color: T.uniform(col(t.color)), amount: T.uniform(t.amount) })),
    hue: T.uniform(v0.hue), sat: T.uniform(v0.sat), bright: T.uniform(v0.bright), contrast: T.uniform(v0.contrast), warm: T.uniform(v0.warm),
    grad: T.uniform(v0.grad), deep: T.uniform(col(v0.deep)), rim: T.uniform(v0.rim), rimColor: T.uniform(col(v0.rimColor)), sheen: T.uniform(v0.sheen),
    top: T.uniform(voxel * 80), // world height the vertical gradient spans (gpu-view keeps it at the terrain's top)
    sun: T.uniform(new three.Vector3(0, 1, 0)), sunI: T.uniform(v0.sunI), ambI: T.uniform(v0.ambI), shadow: T.uniform(v0.shadow), soft: T.uniform(v0.soft),
    ao: T.uniform(v0.ao), bevel: T.uniform(v0.bevel), sss: T.uniform(v0.sss), spec: T.uniform(v0.spec), exposure: T.uniform(v0.exposure),
  };
  const sunDir = { az: v0.sunAz, el: v0.sunEl };
  const aimSun = () => { const a = (sunDir.az * Math.PI) / 180, e = (sunDir.el * Math.PI) / 180; U.sun.value.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)); };
  aimSun();

  const m = new three.MeshBasicNodeMaterial();
  const inp = hook ? hook(T, three, U, m) : null;
  const N = T.normalize(T.normalWorld), v = inp?.v ?? T.uv().y, Uv = inp?.u ?? T.uv().x;
  const gWall = inp?.g ?? T.float(1); // 0 at the foot of a wall, 1 at its top (the GPU view knows; the CPU mesh doesn't)
  const rowMask = (name) => T.step(ROW[name] / ROW_COUNT, v).mul(T.float(1).sub(T.step((ROW[name] + 1) / ROW_COUNT, v)));
  const hash = (x) => T.fract(T.sin(x.mul(12.9898).add(4.1414)).mul(43758.5453));
  const hash2 = (p) => T.fract(T.sin(T.dot(p, T.vec2(127.1, 311.7))).mul(43758.5453));
  const vnoise = (p) => { // value noise, smooth
    const i = T.floor(p), f = T.fract(p), u = f.mul(f).mul(T.float(3).sub(f.mul(2)));
    const a = hash2(i), b = hash2(i.add(T.vec2(1, 0))), c = hash2(i.add(T.vec2(0, 1))), d = hash2(i.add(T.vec2(1, 1)));
    return T.mix(T.mix(a, b, u.x), T.mix(c, d, u.x), u.y);
  };
  const side = T.smoothstep(0.3, 0.7, T.float(1).sub(T.abs(N.y))); // 1 on walls, 0 on tops
  const level = T.floor(T.positionWorld.y.div(U.voxel).add(0.001));
  const isCut = rowMask('cut'), isBuilding = rowMask('building');
  let isGround = T.float(0);
  for (const g of GROUND) isGround = isGround.add(rowMask(g));

  // strata: thick bands (a few voxels), each its own colour from the cut row
  const bandId = T.floor(level.div(U.band));
  const u = T.mix(Uv, hash(bandId), isCut);
  // building tops read the roof row; ground walls read the side row (by height)
  let vv = v.add(isBuilding.mul(T.float(1).sub(side)).mul(1 / ROW_COUNT));
  vv = T.mix(vv, rowV('side'), isGround.mul(side));
  let c = T.texture(tex, T.vec2(u, vv)).rgb;

  // regional tints on open ground tops, like the original's pale/rust/olive/rose patches
  {
    const p = T.positionWorld.xz.div(U.voxel.mul(48));
    const n1 = vnoise(p.add(T.vec2(31.4, 17.2))), n2 = vnoise(p.mul(0.63).add(T.vec2(5.1, 41.7)));
    const ground = isGround.mul(T.float(1).sub(side)).mul(T.float(1).sub(rowMask('wood'))).mul(U.tint);
    U.tints.forEach((t, i) => {
      const n = i % 2 ? n2 : n1, w = i < 2 ? T.smoothstep(0.58, 0.8, i ? T.float(1).sub(n) : n) : T.smoothstep(0.6, 0.82, i === 3 ? T.float(1).sub(n) : n);
      c = T.mix(c, t.color, w.mul(t.amount).mul(ground));
    });
  }

  // grade: hue, saturation, warmth, brightness, contrast (live, for quick theme tweaks)
  {
    const k3 = T.vec3(0.57735, 0.57735, 0.57735), th = U.hue.mul(Math.PI / 180);
    c = c.mul(T.cos(th)).add(T.cross(k3, c).mul(T.sin(th))).add(k3.mul(T.dot(k3, c)).mul(T.float(1).sub(T.cos(th))));
    const lum = T.dot(c, T.vec3(0.299, 0.587, 0.114));
    c = T.mix(T.vec3(lum, lum, lum), c, U.sat);
    c = c.add(T.vec3(U.warm.mul(0.07), U.warm.mul(0.015), U.warm.mul(-0.07)));
    c = c.sub(0.5).mul(U.contrast).add(0.5).mul(U.bright);
    c = T.clamp(c, 0, 1);
  }

  let unlit = rowMask('road').mul(U.glow);
  {
    const cell = T.floor(T.positionWorld.div(U.voxel.div(3)));
    const lit = T.step(T.float(1).sub(U.windows), hash(T.dot(cell, T.vec3(1.0, 57.0, 113.0)))).mul(side).mul(isBuilding).mul(T.step(0.001, U.windows));
    c = T.mix(c, U.windowColor, lit);
    unlit = unlit.add(lit);
  }

  // clay gradient: every wall runs from its colour at the top to a deeper, more saturated, violet-leaning
  // shade at its foot (like Spline's depth layers); low ground sits a little deeper than high ground
  {
    const gWorld = T.clamp(T.positionWorld.y.div(U.top), 0, 1);
    const topT = T.mix(T.float(0.6).add(gWorld.mul(0.4)), 1, isBuilding);
    const tt = T.mix(topT, T.mix(gWall.mul(T.float(0.55).add(gWorld.mul(0.45))), gWall, isBuilding), side); // towers run full height
    let deep = T.mix(c.mul(0.56), U.deep, 0.24);
    const dl = T.dot(deep, T.vec3(0.299, 0.587, 0.114));
    deep = T.clamp(T.mix(T.vec3(dl, dl, dl), deep, 1.3), 0, 1);
    c = T.mix(c, deep, T.float(1).sub(tt).mul(U.grad).mul(T.float(1).sub(rowMask('water').mul(T.float(1).sub(side)))));
  }

  // ── light: a sun you can move; on the GPU view, soft shadows ray-marched through the heightfield and AO ──
  const L = T.normalize(U.sun);
  const Vd = T.normalize(T.cameraPosition.sub(T.positionWorld));
  let sunVis = T.float(1), occ = T.float(1);
  if (inp?.field) {
    const F = inp.field, half = F.n / 2;
    const P = T.positionWorld.div(U.voxel); // voxel units: a cell is one voxel wide
    const p0 = T.vec3(P.x.add(half), P.y, P.z.add(half)).add(N.mul(0.04));
    const hAt = (x, z) => F.h(T.floor(x), T.floor(z));
    let res = T.float(1);
    const jit = T.interleavedGradientNoise(T.screenCoordinate.xy).mul(0.4).add(0.8); // per-pixel step jitter: noise, not streaks
    for (let i = 1; i <= 22; i++) {
      const t = jit.mul(0.35 + i * 0.85 + i * i * 0.07); // steps grow: crisp contact shadows, long mountain ones
      const sp = p0.add(L.mul(t));
      res = T.min(res, sp.y.sub(hAt(sp.x, sp.z)).mul(U.soft).div(t));
    }
    sunVis = T.smoothstep(0, 1, T.clamp(res, 0, 1));
    const b0 = p0.xz.add(N.xz.mul(0.6));
    let o = T.float(0), cnt = 0;
    for (const r of [1.25, 3.5]) for (let k = 0; k < 8; k++) {
      const a = ((k + (r > 2 ? 0.5 : 0)) * Math.PI) / 4;
      o = o.add(T.clamp(hAt(b0.x.add(Math.cos(a) * r), b0.y.add(Math.sin(a) * r)).sub(P.y).div(r * 1.3), 0, 1)); cnt++;
    }
    occ = T.float(1).sub(o.div(cnt).mul(U.ao));
  }

  // water: waves, sky reflection, sun glints and shore foam (after the original's water shader)
  const waterTop = rowMask('water').mul(T.float(1).sub(side)).mul(U.water);
  let water;
  {
    const t = (T.time ?? T.float(0)).mul(U.waves.max(0.0001).sqrt());
    const wp = T.positionWorld.xz.div(U.voxel.mul(5));
    const wave = (p) => vnoise(p.add(T.vec2(t.mul(0.32), t.mul(0.21)))).add(vnoise(p.mul(2.7).sub(T.vec2(t.mul(0.47), t.mul(-0.29)))).mul(0.5));
    const de = 0.12, h0 = wave(wp), hx = wave(wp.add(T.vec2(de, 0))), hz = wave(wp.add(T.vec2(0, de)));
    const amp = U.waves.mul(0.32);
    const Nw = T.normalize(T.vec3(h0.sub(hx).div(de).mul(amp), 1, h0.sub(hz).div(de).mul(amp)));
    const V = T.normalize(T.cameraPosition.sub(T.positionWorld));
    const fres = T.pow(T.float(1).sub(T.max(T.dot(Nw, V), 0)), 4);
    const H = T.normalize(L.add(V));
    const spec = T.pow(T.max(T.dot(Nw, H), 0), 160);
    const glint = T.step(0.993, vnoise(T.positionWorld.xz.div(U.voxel.mul(0.7)).add(T.vec2(t.mul(1.3), t.mul(-0.9))))).mul(U.glints);
    const shore = T.float(1).sub(T.smoothstep(0.0, 0.1, Uv));
    const foam = shore.mul(T.smoothstep(0.45, 0.8, vnoise(T.positionWorld.xz.div(U.voxel.mul(1.2)).add(T.vec2(t.mul(0.15), 0))))).mul(U.foam);
    water = T.mix(c, U.sky, T.min(fres.mul(0.55).mul(U.reflect), 0.7)).mul(T.mix(1, T.mix(0.9, 1.05, h0.mul(0.67)), T.min(U.waves, 1)));
    water = water.add(U.key.mul(spec.mul(1.6).mul(U.reflect).add(glint.mul(0.18))));
    water = T.mix(water, T.vec3(0.92, 0.97, 1.0), foam.mul(0.55));
  }

  // voxel edges, anti-aliased: thin dark seams that fade out once a voxel is only a few pixels on screen
  const q = T.positionWorld.div(U.voxel), w = T.fwidth(q);
  const f = T.abs(T.fract(q).sub(0.5));
  const seam = (fa, wa, na) => T.smoothstep(T.float(0.5).sub(wa.mul(1.2)).sub(0.03), 0.5, fa).mul(T.abs(na).oneMinus());
  const e = T.max(T.max(seam(f.x, w.x, N.x), seam(f.y, w.y, N.y)), seam(f.z, w.z, N.z));
  const edgeFade = T.float(1).sub(T.smoothstep(0.18, 0.45, T.max(T.max(w.x, w.y), w.z)));
  const edge = T.mix(1, U.edge, e.mul(edgeFade).mul(T.float(1).sub(waterTop))); // no grid on water
  // strata: a fine dark line between bands, also faded with distance
  const bandLine = T.smoothstep(T.float(1).sub(w.y.mul(1.5)).sub(0.02), 1, T.fract(level.add(T.fract(q.y)).div(U.band))).mul(isCut).mul(edgeFade);

  // bevelled voxels: near each voxel edge the normal rolls toward it, so every cube reads as soft rounded clay
  const fs = T.fract(q).sub(0.5), bw = T.max(U.bevel.mul(0.26), 0.001);
  const roll = (fa, na) => T.smoothstep(T.float(0.5).sub(bw), 0.5, T.abs(fa)).mul(T.sign(fa)).mul(T.abs(na).oneMinus());
  const Nb = T.normalize(N.add(T.vec3(roll(fs.x, N.x), roll(fs.y, N.y), roll(fs.z, N.z)).mul(T.step(0.001, U.bevel).mul(edgeFade).mul(T.float(1).sub(waterTop)).mul(1.4))));

  // diffuse: sun (wrapped by the subsurface amount, shadowed) + a sky/ground hemisphere (occluded)
  const ndl = T.dot(Nb, L), wrapW = U.sss.mul(0.6);
  const diff = T.clamp(ndl.add(wrapW).div(wrapW.add(1)), 0, 1), lam = T.max(ndl, 0);
  const shade = T.mix(1, sunVis, U.shadow);
  const hemi = T.mix(U.fill.mul(0.55).add(c.mul(0.22)), U.fill, Nb.y.mul(0.5).add(0.5)).mul(U.ambI).mul(occ);
  let lit = c.mul(hemi.add(U.key.mul(U.sunI).mul(diff).mul(shade)));
  // subsurface: the terminator glows in a deeper, saturated version of the surface colour (clay, wax)
  lit = lit.add(U.key.mul(T.clamp(c.mul(c).mul(1.7), 0, 1)).mul(T.clamp(diff.sub(lam), 0, 1)).mul(U.sss).mul(0.7).mul(shade));
  // specular: a broad clay sheen everywhere, a tight highlight and a sky reflection on glass towers
  {
    const glass = isBuilding.mul(T.step(0.84, Uv));
    const nh = T.max(T.dot(Nb, T.normalize(L.add(Vd))), 0);
    const fres = T.pow(T.float(1).sub(T.clamp(T.dot(Nb, Vd), 0, 1)), 5);
    lit = lit.add(U.key.mul(T.mix(T.pow(nh, 16).mul(0.3), T.pow(nh, 220).mul(3), glass)).mul(U.spec).mul(shade));
    lit = T.mix(lit, U.sky.mul(T.mix(0.7, 1.0, Nb.y.mul(0.5).add(0.5))), glass.mul(fres.mul(0.55).add(0.14)).mul(T.min(U.spec.mul(2.5), 1)));
  }
  lit = lit.mul(edge).mul(T.float(1).sub(bandLine.mul(0.25))).mul(T.mix(1, occ, 0.3));
  // studio sheen (a matcap-like soft highlight in view space, screen-blended) and a fresnel rim
  {
    const nv = T.normalize(T.transformNormalToView ? T.transformNormalToView(Nb) : T.normalView);
    const sh = T.smoothstep(0.35, 1.0, T.dot(nv, T.normalize(T.vec3(-0.62, 0.25, 0.75)))); // faces turned toward the camera's left
    lit = lit.add(T.float(1).sub(lit).mul(sh.mul(U.sheen).mul(0.45)));
    const fr = T.pow(T.float(1).sub(T.clamp(T.dot(Nb, Vd), 0, 1)), 3);
    lit = lit.add(U.rimColor.mul(fr.mul(U.rim).mul(T.mix(0.2, 1, side)))); // mostly on walls: on tops it would wash the map
  }
  let out = T.mix(lit, c, T.clamp(unlit, 0, 1));
  // water keeps its own reflection model, darkened where buildings or hills shade it
  out = T.mix(out, water.mul(T.mix(0.6, 1, shade)).mul(occ.mul(0.4).add(0.6)), waterTop);
  // exposure and a soft highlight shoulder (keeps colours below the knee untouched)
  out = out.mul(U.exposure);
  out = T.mix(out, T.float(0.8).add(out.sub(0.8).div(out.sub(0.8).div(0.2).add(1))), T.step(0.8, out));

  // immersive: dissolve toward the background with distance from the centre (dithered, so no sorting issues)
  const k = T.smoothstep(U.fadeStart, 1, T.length(T.positionWorld.xz).div(U.fadeRadius)).mul(U.fade);
  out = T.mix(out, U.background, k);
  m.opacityNode = T.step(T.interleavedGradientNoise(T.screenCoordinate.xy), T.float(1).sub(k.mul(k)));
  m.alphaTest = 0.5;
  m.colorNode = out;
  m.toneMapped = false;

  const setColor = (uni, hex) => uni.value.set(hex);
  m.placeControls = {
    uniforms: U,
    /** Live tweaks: any of styleUniformValues' keys, plus voxel, band, fade { radius, start } | null. */
    set(o) {
      for (const k2 of ['voxel', 'band', 'edge', 'water', 'waves', 'reflect', 'foam', 'glints', 'glow', 'windows', 'tint', 'hue', 'sat', 'bright', 'contrast', 'warm', 'grad', 'rim', 'sheen', 'top', 'sunI', 'ambI', 'shadow', 'soft', 'ao', 'bevel', 'sss', 'spec', 'exposure']) if (o[k2] != null) U[k2].value = +o[k2];
      if (o.sunAz != null || o.sunEl != null) { if (o.sunAz != null) sunDir.az = +o.sunAz; if (o.sunEl != null) sunDir.el = +o.sunEl; aimSun(); }
      for (const k2 of ['key', 'fill', 'sky', 'background', 'windowColor', 'deep', 'rimColor']) if (o[k2]) setColor(U[k2], o[k2]);
      if (o.tints) o.tints.forEach((t, i) => { if (U.tints[i]) { setColor(U.tints[i].color, t.color); U.tints[i].amount.value = t.amount; } });
      if (o.fade !== undefined) { U.fade.value = o.fade ? 1 : 0; if (o.fade) { U.fadeRadius.value = o.fade.radius; U.fadeStart.value = o.fade.start ?? 0.55; } }
    },
    /** Swap the whole look: palette rows and every uniform the style sets. */
    setStyle(st) {
      const next = paletteImage(st);
      tex.image.data.set(next.data); tex.needsUpdate = true;
      this.set(styleUniformValues(st));
    },
  };
  return m;
}

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
    key: '#ffffff', fill: '#b8bcc6', edge: 0.9, water: false,
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
 */
export function voxelMaterial(three, style, { voxel, band = 3, fade } = {}) {
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
  };

  const m = new three.MeshBasicNodeMaterial();
  const N = T.normalize(T.normalWorld), v = T.uv().y, Uv = T.uv().x;
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

  let unlit = rowMask('road').mul(U.glow);
  {
    const cell = T.floor(T.positionWorld.div(U.voxel.div(3)));
    const lit = T.step(T.float(1).sub(U.windows), hash(T.dot(cell, T.vec3(1.0, 57.0, 113.0)))).mul(side).mul(isBuilding).mul(T.step(0.001, U.windows));
    c = T.mix(c, U.windowColor, lit);
    unlit = unlit.add(lit);
  }

  // light: warm key from the upper left, cool fill in the shade, a little extra on tops
  const L = T.normalize(T.vec3(-0.55, 0.78, 0.3));
  const wrap = T.clamp(T.dot(N, L).mul(0.6).add(0.45), 0, 1);
  const light = T.mix(U.fill, U.key, wrap).mul(T.mix(0.92, 1.08, T.smoothstep(0.5, 0.95, N.y)));

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

  const lit = c.mul(light).mul(edge).mul(T.float(1).sub(bandLine.mul(0.25)));
  let out = T.mix(lit, c, T.clamp(unlit, 0, 1));
  out = T.mix(out, water, waterTop); // water is lit by its own reflection, not the voxel light

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
      for (const k2 of ['voxel', 'band', 'edge', 'water', 'waves', 'reflect', 'foam', 'glints', 'glow', 'windows', 'tint']) if (o[k2] != null) U[k2].value = +o[k2];
      for (const k2 of ['key', 'fill', 'sky', 'background', 'windowColor']) if (o[k2]) setColor(U[k2], o[k2]);
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

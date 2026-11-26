/* ── The mesher that runs INSIDE Spline's run_code sandbox ──
   bake.mjs embeds these functions' source in every band script, so they use
   only plain JavaScript plus the DSL's own aliases (customMesh, position,
   rename, applyMaterial). Each band becomes one real mesh per material,
   saved in the file and editable like anything else in Spline. */

/** base64 → Uint8Array, without atob (the sandbox may not have it). */
export function b64(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const map = new Uint8Array(128);
  for (let i = 0; i < 64; i++) map[A.charCodeAt(i)] = i;
  const n = s.length, pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((n / 4) * 3 - pad);
  for (let i = 0, o = 0; i < n; i += 4) {
    const v = (map[s.charCodeAt(i)] << 18) | (map[s.charCodeAt(i + 1)] << 12) | (map[s.charCodeAt(i + 2)] << 6) | map[s.charCodeAt(i + 3)];
    if (o < out.length) out[o++] = (v >> 16) & 255;
    if (o < out.length) out[o++] = (v >> 8) & 255;
    if (o < out.length) out[o++] = v & 255;
  }
  return out;
}

/**
 * Mesh one band of rows into per-material customMesh objects.
 * C: { n, zA, zB, R0, R1, r0, r1, voxel, offX, offZ, crop, band, prefix, id }
 * bytes: col, terr and class for rows R0..R1 (one row of margin each side), n per row.
 * Classes: 0 ground low · 1 grass · 2 forest · 3 sand · 4 rock · 5 ice · 6 water · 7 road · 8 building · 9 tree · 10 ground mid · 11 ground high
 */
export function bakeBand(C, bytes) {
  const n = C.n, rows = C.R1 - C.R0 + 1, S = rows * n, vx = C.voxel;
  const col = bytes.subarray(0, S), terr = bytes.subarray(S, 2 * S), cls = bytes.subarray(2 * S, 3 * S);
  const TOP = ['Ground Low', 'Grass', 'Forest', 'Sand', 'Rock', 'Ice', 'Water', 'Roads', 'Roofs', 'Trees', 'Ground Mid', 'Ground High'];
  const B = {};
  const bucket = (m) => B[m] || (B[m] = { V: [], N: [], I: [] });
  const quad = (m, a, b, c, d, nr) => {
    const q = bucket(m), i0 = q.V.length / 3;
    q.V.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (let i = 0; i < 4; i++) q.N.push(nr[0], nr[1], nr[2]);
    q.I.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  };
  const wall = (m, s, x0, x1, z0, z1, lo, hi) => {
    if (hi <= lo) return;
    const a = lo * vx, b = hi * vx;
    if (s === 0) quad(m, [x1, a, z0], [x1, b, z0], [x1, b, z1], [x1, a, z1], [1, 0, 0]);
    else if (s === 1) quad(m, [x0, a, z1], [x0, b, z1], [x0, b, z0], [x0, a, z0], [-1, 0, 0]);
    else if (s === 2) quad(m, [x1, a, z1], [x1, b, z1], [x0, b, z1], [x0, a, z1], [0, 0, 1]);
    else quad(m, [x0, a, z0], [x0, b, z0], [x1, b, z0], [x1, a, z0], [0, 0, -1]);
  };
  const upper = (c) => (c === 8 ? 'Building Walls' : c === 9 ? 'Trees' : 'Ground Sides');
  const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
  for (let z = C.r0; z <= C.r1; z++) for (let x = 0; x < n; x++) {
    const k = (z - C.R0) * n + x, h = col[k], t = terr[k], c = cls[k];
    const x0 = C.offX + x * vx, x1 = x0 + vx, z0 = C.offZ + z * vx, z1 = z0 + vx, y = h * vx;
    quad(TOP[c], [x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], [0, 1, 0]);
    for (let s = 0; s < 4; s++) {
      const nx = x + DX[s], nz = z + DZ[s];
      if (nx < 0 || nx >= n || nz < C.zA || nz >= C.zB) {
        if (!C.crop) { wall(c === 6 ? 'Water' : 'Ground Sides', s, x0, x1, z0, z1, 0, t); wall(upper(c), s, x0, x1, z0, z1, t, h); continue; }
        // the cut: strata bands up to the ground (water on top where a river meets the edge), then what stands on it
        const top = c === 6 ? Math.max(0, t - 2) : t;
        for (let lo = 0; lo < top; lo += C.band) wall('Strata ' + (1 + (Math.floor(lo / C.band) % 4)), s, x0, x1, z0, z1, lo, Math.min(lo + C.band, top));
        if (c === 6) wall('Water', s, x0, x1, z0, z1, top, t);
        wall(upper(c), s, x0, x1, z0, z1, t, h);
        continue;
      }
      const nh = col[(nz - C.R0) * n + nx];
      if (nh >= h) continue;
      if (c === 8 || c === 9) { wall(upper(c), s, x0, x1, z0, z1, Math.max(nh, t), h); wall('Ground Sides', s, x0, x1, z0, z1, nh, Math.min(t, h)); }
      else wall(c === 6 ? 'Water' : 'Ground Sides', s, x0, x1, z0, z1, nh, h);
    }
  }
  let made = 0;
  for (const m in B) {
    const q = B[m], verts = q.V.length / 3;
    // split anything over 60k vertices: quads never straddle a split
    for (let start = 0; start < verts; start += 60000) {
      const end = Math.min(verts, start + 60000);
      const idx = [];
      for (let i = (start / 4) * 6; i < (end / 4) * 6; i++) idx.push(q.I[i] - start);
      customMesh({ vertices: q.V.slice(start * 3, end * 3), normals: q.N.slice(start * 3, end * 3), indices: idx });
      position({ x: 0, y: 0, z: 0 });
      rename(C.prefix + ' ' + m + ' ' + C.id + (start ? '.' + start / 60000 : ''));
      applyMaterial(C.prefix + ' ' + m);
      made++;
    }
  }
  return made;
}

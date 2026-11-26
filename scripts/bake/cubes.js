/* ── Cube instances: the mesher that runs INSIDE Spline's run_code sandbox ──
   One real Spline Cube per material, made a cloner that puts a copy on every
   vertex of a "points" mesh (spreadType 'vertex', drawn instanced: one draw
   call per material). The points mesh holds one zero-area triangle per
   exposed voxel, so it samples as points and draws nothing; it has to stay
   visible, since a hidden target gives the cloner no points.
   Only voxels you can see become cubes: the top of every column and any voxel
   with open air beside it. Edit a cube (its bevel, size, material) and every
   voxel of that material follows. */

/**
 * @param C { n, zA, zB, voxel, offX, offZ, crop, band, prefix, names, sides, size, round }
 *   names: material names indexed by the top/wall bytes · sides: index of 'Ground · Sides'
 * @param bytes col, terr, top-material index, wall-material index — n per row, rows zA..zB-1
 */
export function cubeBuild(C, bytes) {
  const n = C.n, rows = C.zB - C.zA, S = rows * n, vx = C.voxel;
  const col = bytes.subarray(0, S), terr = bytes.subarray(S, 2 * S), top = bytes.subarray(2 * S, 3 * S), wall = bytes.subarray(3 * S, 4 * S);
  const P = {};
  const put = (name, x, y, z) => (P[name] || (P[name] = [])).push(C.offX + (x + 0.5) * vx, (y + 0.5) * vx, C.offZ + (C.zA + z + 0.5) * vx);
  for (let z = 0; z < rows; z++) for (let x = 0; x < n; x++) {
    const k = z * n + x, h = col[k], t = terr[k];
    const edge = x === 0 || x === n - 1 || z === 0 || z === rows - 1;
    let lo = h - 1;
    if (edge && C.crop) lo = 0;
    else {
      if (x > 0) lo = Math.min(lo, col[k - 1]);
      if (x < n - 1) lo = Math.min(lo, col[k + 1]);
      if (z > 0) lo = Math.min(lo, col[k - n]);
      if (z < rows - 1) lo = Math.min(lo, col[k + n]);
    }
    for (let y = Math.max(0, lo); y < h; y++) {
      let m;
      if (y === h - 1) m = C.names[top[k]];
      else if (y >= t) m = C.names[wall[k]];
      else if (edge && C.crop) m = 'Strata ' + (1 + (Math.floor(y / C.band) % 4));
      else m = C.names[C.sides];
      put(m, x, y, z);
    }
  }
  let cubes = 0;
  for (const m in P) {
    const V = P[m], cnt = V.length / 3, N = [], I = [];
    for (let i = 0; i < cnt; i++) { N.push(0, 1, 0); I.push(i, i, i); }
    const pts = customMesh({ vertices: V, normals: N, indices: I });
    position({ x: 0, y: 0, z: 0 });
    rename(C.prefix + ' ' + m + ' · points');
    mesh('Cube', { width: vx * C.size, height: vx * C.size, depth: vx * C.size, cornerRadius: vx * C.round });
    position({ x: 0, y: 0, z: 0 });
    rename(C.prefix + ' ' + m);
    applyMaterial(C.prefix + ' ' + m);
    cloneTo(pts, { spreadType: 'vertex', align: 'axis', axis: 'y', hideBase: true, scale: [1, 1, 1] });
    clone({ instanced: true });
    cubes += cnt;
  }
  return { materials: Object.keys(P).length, cubes };
}

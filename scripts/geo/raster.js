/* ── Rasterising vector features onto the frame's n×n cell grid ──
   Coordinates in here are in CELL units (frame metres / cell size).
   A cell is "inside" a polygon when its centre is (even-odd rule, so holes
   in rings survive). Polygons too small to cover any centre still mark the
   cell under their centroid, so a city of 8 m houses on a 10 m grid doesn't
   vanish. */

/** Fill polygon `rings` (arrays of [x, y] in cell units) into `grid` with `write(index)`. Returns cells written. */
export function fillPolygon(n, rings, write) {
  let minY = Infinity, maxY = -Infinity;
  for (const r of rings) for (const [, y] of r) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const j0 = Math.max(0, Math.ceil(minY - 0.5)), j1 = Math.min(n - 1, Math.floor(maxY - 0.5));
  let count = 0;
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const y = j + 0.5;
    xs.length = 0;
    for (const r of rings) {
      for (let k = 0, m = r.length; k < m; k++) {
        const [ax, ay] = r[k], [bx, by] = r[(k + 1) % m];
        if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] - 0.5)), i1 = Math.min(n - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let i = i0; i <= i1; i++) { write(j * n + i); count++; }
    }
  }
  if (!count && rings[0]?.length) {
    let cx = 0, cy = 0;
    for (const [x, y] of rings[0]) { cx += x; cy += y; }
    const i = Math.floor(cx / rings[0].length), j = Math.floor(cy / rings[0].length);
    if (i >= 0 && j >= 0 && i < n && j < n) { write(j * n + i); count = 1; }
  }
  return count;
}

/** Stamp a polyline of half-width `r` (cell units, ≥ 0.5 marks at least the cells it passes through). */
export function strokeLine(n, pts, r, write) {
  const rr = Math.max(0.5, r), r2 = rr * rr;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const len = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(len / 0.5));
    for (let s = 0; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
      const i0 = Math.max(0, Math.floor(x - rr)), i1 = Math.min(n - 1, Math.floor(x + rr));
      const j0 = Math.max(0, Math.floor(y - rr)), j1 = Math.min(n - 1, Math.floor(y + rr));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const dx = i + 0.5 - x, dy = j + 0.5 - y;
        if (dx * dx + dy * dy <= r2 || (i === Math.floor(x) && j === Math.floor(y))) write(j * n + i);
      }
    }
  }
}

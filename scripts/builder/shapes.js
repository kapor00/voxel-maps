/* ── Volume shapes: which columns of the window belong to the place ──
   The GPU view evaluates the same rules in its vertex shader; these JS twins are for the
   .glb export and anything else on the CPU. Coordinates are in cells of the window. */

export const SHAPES = ['box', 'cylinder', 'dome', 'island', 'hex'];
export const SHAPE_LABELS = { box: 'Box', cylinder: 'Cylinder', dome: 'Dome', island: 'Island', hex: 'Hexagon' };
export const shapeIndex = (s) => Math.max(0, SHAPES.indexOf(s));

/** The island's coastline: radius (in the unit ellipse) at angle a. */
export const islandEdge = (a) => 0.84 + 0.07 * Math.sin(3 * a + 1.3) + 0.05 * Math.sin(5 * a + 0.4) + 0.03 * Math.sin(11 * a + 2.1);

/** The window's columns that are in the volume: x0..x0+cols-1, z0..z0+rows-1, then the shape. */
export function volumeOf(n, { width = 1, depth = 1 } = {}) {
  const cols = Math.max(8, Math.min(n, Math.round(n * width))), rows = Math.max(8, Math.min(n, Math.round(n * depth)));
  return { x0: Math.floor((n - cols) / 2), cols, z0: Math.floor((n - rows) / 2), rows };
}

/** { inside, r (0 centre … 1 rim of the ellipse), edge (rim radius at this angle) } */
export function shapeAt(shape, x, z, { x0, cols, z0, rows }) {
  if (x < x0 || x >= x0 + cols || z < z0 || z >= z0 + rows) return { inside: false, r: 2, edge: 1 };
  const u = (x + 0.5 - (x0 + cols / 2)) / (cols / 2), v = (z + 0.5 - (z0 + rows / 2)) / (rows / 2);
  const r = Math.hypot(u, v);
  if (shape === 'cylinder' || shape === 'dome') return { inside: r <= 1, r, edge: 1 };
  if (shape === 'island') { const e = islandEdge(Math.atan2(v, u)); return { inside: r <= e, r, edge: e }; }
  if (shape === 'hex') return { inside: Math.max(Math.abs(u) * 0.866 + Math.abs(v) * 0.5, Math.abs(v)) <= 0.98, r, edge: 1 };
  return { inside: true, r, edge: 1 };
}

// Hexagonal grid math. The world uses pointy-top hexagons addressed with
// axial coordinates (q, r). One base cell is 1 m wide (flat to flat).
//   x = (q + r / 2) * HEX_W
//   z = r * ROW_H
// A level-of-detail grid with step 2^L uses the same formulas scaled by 2^L,
// which keeps the lattice hexagonal at every LOD.

export const HEX_W = 1.0;
export const HEX_R = HEX_W / Math.sqrt(3); // circumradius
export const ROW_H = HEX_R * 1.5;

/** Neighbour directions; index d faces angle d * 60 degrees (x towards z). */
export const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

/** Corner k sits at angle (60k - 30) degrees. Edge d spans corners d and d+1. */
export const CORNERS = [];
for (let k = 0; k < 6; k++) {
  const a = (Math.PI / 180) * (60 * k - 30);
  CORNERS.push([Math.cos(a) * HEX_R, Math.sin(a) * HEX_R]);
}
export const DIR_NORMALS = [];
for (let d = 0; d < 6; d++) {
  const a = (Math.PI / 180) * (60 * d);
  DIR_NORMALS.push([Math.cos(a), Math.sin(a)]);
}

export function axialX(q, r) { return (q + r * 0.5) * HEX_W; }
export function axialZ(r) { return r * ROW_H; }

/** Convert world xz to the nearest axial cell (at a given scale). Writes {q, r}. */
export function worldToAxial(x, z, out, scale = 1) {
  const rf = z / (ROW_H * scale);
  const qf = x / (HEX_W * scale) - rf * 0.5;
  // cube rounding
  const xf = qf, zf = rf, yf = -qf - rf;
  let rx = Math.round(xf), ry = Math.round(yf), rz = Math.round(zf);
  const dx = Math.abs(rx - xf), dy = Math.abs(ry - yf), dz = Math.abs(rz - zf);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  out.q = rx;
  out.r = rz;
  return out;
}

/** 2D squared distance from point to a hexagon centered at origin with circumradius R (pointy top). */
export function hexSignedDistance(px, pz, R) {
  // Inradius
  const ri = R * Math.sqrt(3) / 2;
  // Fold into one sextant using symmetry of pointy-top hexagon (flat sides at +-x).
  let x = Math.abs(px), z = Math.abs(pz);
  // Normal directions of flat sides: (1,0), (0.5, 0.866)
  const d1 = x - ri;
  const d2 = x * 0.5 + z * 0.8660254 - ri;
  return Math.max(d1, d2);
}

export function cellKey(q, r) {
  return ((q + 32768) << 16) | ((r + 32768) & 0xffff);
}

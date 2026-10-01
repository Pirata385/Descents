// Small math helpers shared across modules (no external dependencies).

export const TAU = Math.PI * 2;

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function invLerp(a, b, v) { return (v - a) / (b - a); }
export function smoothstep(a, b, v) {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}
export function smootherstep(a, b, v) {
  const t = clamp01((v - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
export function remap(v, a, b, c, d) { return c + (d - c) * clamp01((v - a) / (b - a)); }

/** Quantize a height to the terrain vertical grid. */
export const QUANT = 0.5;
export function quant(y) { return Math.round(y / QUANT) * QUANT; }
export function quantFloor(y) { return Math.floor(y / QUANT + 1e-6) * QUANT; }

export function wrapAngle(a) {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
}

/** Angle in [0, TAU). */
export function angle01(a) {
  a = a % TAU;
  return a < 0 ? a + TAU : a;
}

export function dist2(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Closest point parameter of p on segment ab (2D). */
export function segParam2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  if (l2 < 1e-9) return 0;
  return clamp01(((px - ax) * dx + (pz - az) * dz) / l2);
}

/** Terrace function: flat steps with sharp risers. */
export function terrace(h, step, sharp = 0.75) {
  const k = Math.floor(h / step);
  const f = h / step - k;
  const g = smoothstep(sharp, 1.0, f);
  return (k + g) * step;
}

export function hsl2rgb(h, s, l) {
  h = ((h % 1) + 1) % 1;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

export function mixRGB(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function rgbToHex(c) {
  const h = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return '#' + h(c[0]) + h(c[1]) + h(c[2]);
}

/** Chaikin smoothing of a 2D/3D polyline stored as array of arrays. */
export function chaikin(points, iterations = 2) {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const q = a.map((v, k) => v * 0.75 + b[k] * 0.25);
      const r = a.map((v, k) => v * 0.25 + b[k] * 0.75);
      out.push(q, r);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

/** Resample a polyline (array of [x, z, ...]) at a fixed spacing along xz. */
export function resamplePolyline(points, spacing) {
  if (points.length < 2) return points.slice();
  const out = [points[0].slice()];
  let carry = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    let d = spacing - carry;
    while (d <= len) {
      const t = d / len;
      out.push(a.map((v, k) => v + (b[k] - v) * t));
      d += spacing;
    }
    carry = len - (d - spacing);
  }
  const last = points[points.length - 1];
  const pl = out[out.length - 1];
  if (Math.hypot(last[0] - pl[0], last[1] - pl[1]) > spacing * 0.3) out.push(last.slice());
  return out;
}

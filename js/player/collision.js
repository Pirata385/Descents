// Collision between the player's vertical capsule (approximated as a circle
// in xz with a vertical extent) and hexagonal terrain columns.
import { worldToAxial, axialX, axialZ, HEX_R, CORNERS } from '../core/hex.js';

const ax = { q: 0, r: 0 };

/** Closest point on a pointy-top hexagon boundary to p (local coords). */
function hexClosest(px, pz, R, out) {
  let best = Infinity, bx = 0, bz = 0;
  let inside = true;
  let maxSd = -Infinity, mnx = 0, mnz = 0;
  for (let k = 0; k < 6; k++) {
    const ax0 = CORNERS[k][0] * R / HEX_R, az0 = CORNERS[k][1] * R / HEX_R;
    const k1 = (k + 1) % 6;
    const ax1 = CORNERS[k1][0] * R / HEX_R, az1 = CORNERS[k1][1] * R / HEX_R;
    // edge normal (outward) for edge k faces angle 60k degrees
    const ang = (Math.PI / 3) * k;
    const nx = Math.cos(ang), nz = Math.sin(ang);
    const sd = (px - ax0) * nx + (pz - az0) * nz;
    if (sd > 0) inside = false;
    if (sd > maxSd) { maxSd = sd; mnx = nx; mnz = nz; }
    const ex = ax1 - ax0, ez = az1 - az0;
    let t = ((px - ax0) * ex + (pz - az0) * ez) / (ex * ex + ez * ez);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax0 + ex * t, cz = az0 + ez * t;
    const d = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
    if (d < best) { best = d; bx = cx; bz = cz; }
  }
  out.inside = inside;
  out.dist = Math.sqrt(best);
  out.cx = bx; out.cz = bz;
  out.nx = mnx; out.nz = mnz; out.sd = maxSd;
  return out;
}

const hc = { inside: false, dist: 0, cx: 0, cz: 0, nx: 0, nz: 0, sd: 0 };

/**
 * Iterate the columns around (x, z) within radius rad. Callback receives the
 * column, its centre and hex info.
 */
export function forColumns(world, x, z, rad, fn) {
  worldToAxial(x, z, ax);
  const q0 = ax.q, r0 = ax.r;
  const n = Math.ceil(rad + 1);
  for (let dr = -n; dr <= n; dr++) {
    for (let dq = -n; dq <= n; dq++) {
      const q = q0 + dq, r = r0 + dr;
      const cx = axialX(q, r), cz = axialZ(r);
      const ddx = cx - x, ddz = cz - z;
      if (ddx * ddx + ddz * ddz > (rad + HEX_R + 0.1) * (rad + HEX_R + 0.1)) continue;
      const col = world.cell(q, r);
      if (fn(col, cx, cz) === false) return;
    }
  }
}

/**
 * Push a circle (radius rad) out of all columns with solid spans overlapping
 * [yLo, yHi]. Returns {hit, nx, nz, maxTop} — the wall normal of the last
 * contact and the highest blocking span top (for mantling).
 */
export function resolveHorizontal(world, pos, rad, yLo, yHi, result) {
  result.hit = false; result.nx = 0; result.nz = 0; result.maxTop = -Infinity; result.minBottom = Infinity;
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    forColumns(world, pos.x, pos.z, rad, (col, cx, cz) => {
      let blockTop = -Infinity, blockBot = Infinity;
      for (let s = 0; s < col.n; s++) {
        const o = (col.off + s) * 2;
        const y0 = col.y[o], y1 = col.y[o + 1];
        if (y1 > yLo && y0 < yHi) { blockTop = Math.max(blockTop, y1); blockBot = Math.min(blockBot, y0); }
      }
      if (blockTop === -Infinity) return;
      hexClosest(pos.x - cx, pos.z - cz, HEX_R, hc);
      let px, pz, depth;
      if (hc.inside) {
        px = hc.nx; pz = hc.nz; depth = rad - hc.sd;
      } else {
        if (hc.dist >= rad) return;
        const dx = pos.x - cx - hc.cx, dz = pos.z - cz - hc.cz;
        const l = Math.hypot(dx, dz) || 1;
        px = dx / l; pz = dz / l; depth = rad - hc.dist;
      }
      pos.x += px * (depth + 0.001);
      pos.z += pz * (depth + 0.001);
      result.hit = true; result.nx = px; result.nz = pz;
      result.maxTop = Math.max(result.maxTop, blockTop);
      result.minBottom = Math.min(result.minBottom, blockBot);
      moved = true;
    });
    if (!moved) break;
  }
  return result;
}

/** Highest floor top under a circle that is at or below yMax. */
export function groundUnder(world, x, z, rad, yMax) {
  let best = -Infinity;
  forColumns(world, x, z, rad, (col, cx, cz) => {
    hexClosest(x - cx, z - cz, HEX_R, hc);
    if (!hc.inside && hc.dist > rad) return;
    for (let s = col.n - 1; s >= 0; s--) {
      const top = col.y[(col.off + s) * 2 + 1];
      if (top <= yMax) { if (top > best) best = top; break; }
    }
  });
  return best;
}

/** Lowest ceiling above yMin under a circle. */
export function ceilingOver(world, x, z, rad, yMin) {
  let best = Infinity;
  forColumns(world, x, z, rad, (col, cx, cz) => {
    hexClosest(x - cx, z - cz, HEX_R, hc);
    if (!hc.inside && hc.dist > rad) return;
    for (let s = 0; s < col.n; s++) {
      const b = col.y[(col.off + s) * 2];
      if (b >= yMin) { if (b < best) best = b; break; }
    }
  });
  return best;
}

/** True if the vertical range [y0, y1] is free at (x, z) for a circle. */
export function spaceFree(world, x, z, rad, y0, y1) {
  let free = true;
  forColumns(world, x, z, rad, (col, cx, cz) => {
    hexClosest(x - cx, z - cz, HEX_R, hc);
    if (!hc.inside && hc.dist > rad) return;
    for (let s = 0; s < col.n; s++) {
      const o = (col.off + s) * 2;
      if (col.y[o + 1] > y0 && col.y[o] < y1) { free = false; return false; }
    }
  });
  return free;
}

/** Push out of tree trunk colliders (vertical cylinders). */
export function resolveColliders(world, pos, rad, yLo, yHi) {
  for (const c of world.collidersNear(pos.x, pos.z, 4)) {
    if (c.t !== 'cyl') continue;
    if (yHi < c.y0 || yLo > c.y1) continue;
    const dx = pos.x - c.x, dz = pos.z - c.z;
    const d = Math.hypot(dx, dz);
    const min = rad + c.r;
    if (d < min && d > 1e-4) { pos.x = c.x + (dx / d) * min; pos.z = c.z + (dz / d) * min; }
  }
}

// Structure primitives ("stamps"). Buildings, ruins, platforms, arches and
// other constructions compile into these primitives, which the column
// generator applies to hex columns in order. Pure data; no rendering here.
import { M } from './materials.js';

export const PK = {
  BOX: 1,      // oriented box: add/carve over [y0, y1]
  CYL: 2,      // vertical cylinder
  GABLE: 3,    // gable roof over an oriented box (ridge along local u)
  HIP: 4,      // hip roof
  CONE: 5,     // conical roof / spire
  DOME: 6,     // dome
  FLAT: 7,     // terrain levelling pad (cut/fill), optional top material
  WINDOWS: 8,  // window/door pattern on the perimeter of an oriented box
  RING: 9,     // hollow cylinder wall
  ARCH: 10,    // arched bridge / natural arch along a segment
  MATPATCH: 11, // change top material of terrain (fields, plazas)
  SPIRE: 12,   // rock spire: cone of rock from y0 to y1
};

export const OP_ADD = 0;
export const OP_CARVE = 1;

let _order = 0;
export function resetPrimOrder() { _order = 0; }

function base(kind, op, x, z, opts) {
  const ang = opts.angle || 0;
  return {
    kind, op, x, z,
    ca: Math.cos(ang), sa: Math.sin(ang), angle: ang,
    hw: opts.hw || 0, hd: opts.hd || 0, r: opts.r || 0, ri: opts.ri || 0,
    y0: opts.y0 ?? 0, y1: opts.y1 ?? 0, h: opts.h || 0,
    top: opts.top ?? M.ROCK, side: opts.side ?? (opts.top ?? M.ROCK), bot: opts.bot ?? (opts.side ?? M.ROCK),
    eave: opts.eave || 0,
    floors: opts.floors || 0, floorH: opts.floorH || 3.2, spacing: opts.spacing || 3, door: opts.door ?? -1,
    feather: opts.feather || 0,
    exp: opts.exp ?? 0.25,
    maxLod: opts.maxLod ?? 3,
    // arch
    bx: opts.bx || 0, bz: opts.bz || 0, yb: opts.yb || 0, bulge: opts.bulge || 0, thick: opts.thick || 2, width: opts.width || 3,
    gableSide: opts.gableSide ?? -1,
    order: _order++,
    br: 0,
  };
}

function finishBR(p) {
  switch (p.kind) {
    case PK.CYL: case PK.CONE: case PK.DOME: case PK.RING: case PK.SPIRE:
      p.br = p.r + p.feather + 1; break;
    case PK.ARCH:
      p.br = Math.hypot(p.bx - p.x, p.bz - p.z) / 2 + p.width + 1;
      p.cx2 = (p.x + p.bx) / 2; p.cz2 = (p.z + p.bz) / 2;
      break;
    default:
      p.br = Math.hypot(p.hw + p.eave, p.hd + p.eave) + p.feather + 1;
  }
  if (p.kind === PK.CYL && p.hw > 0) p.br = Math.max(p.br, Math.hypot(p.hw, p.hd) + 1);
  return p;
}

export const box = (op, x, z, o) => finishBR(base(PK.BOX, op, x, z, o));
export const cyl = (op, x, z, o) => finishBR(base(PK.CYL, op, x, z, o));
export const gable = (x, z, o) => finishBR(base(PK.GABLE, OP_ADD, x, z, o));
export const hip = (x, z, o) => finishBR(base(PK.HIP, OP_ADD, x, z, o));
export const cone = (x, z, o) => finishBR(base(PK.CONE, OP_ADD, x, z, o));
export const dome = (x, z, o) => finishBR(base(PK.DOME, OP_ADD, x, z, o));
export const flat = (x, z, o) => finishBR(base(PK.FLAT, OP_ADD, x, z, o));
export const windows = (x, z, o) => finishBR(base(PK.WINDOWS, OP_ADD, x, z, o));
export const ring = (x, z, o) => finishBR(base(PK.RING, OP_ADD, x, z, o));
export const arch = (x, z, o) => finishBR(base(PK.ARCH, OP_ADD, x, z, o));
export const matPatch = (x, z, o) => finishBR(base(PK.MATPATCH, OP_ADD, x, z, o));
export const spire = (x, z, o) => finishBR(base(PK.SPIRE, OP_ADD, x, z, o));

/**
 * Build a house-like building as a list of primitives.
 * Local axes: u along the street (tangent), v pointing away from the street (depth).
 */
export function building(x, z, opts) {
  const {
    angle, w, d, base: by, floors = 2, floorH = 3.2, wall = M.PLASTER, roof = M.ROOF_A,
    roofType = 'gable', pitch = 0.7, doorSide = 2, chimney = false, foundation = 3, trim = M.BRICK,
  } = opts;
  const hw = w / 2, hd = d / 2;
  const wallTop = by + floors * floorH + 0.4;
  const prims = [];
  prims.push(flat(x, z, { angle, hw: hw + 1.2, hd: hd + 1.2, y0: by, feather: 2.5, top: M.COBBLE }));
  prims.push(box(OP_ADD, x, z, { angle, hw, hd, y0: by - foundation, y1: by + 0.5, top: trim, side: trim }));
  prims.push(box(OP_ADD, x, z, { angle, hw, hd, y0: by + 0.5, y1: wallTop, top: wall, side: wall }));
  prims.push(windows(x, z, { angle, hw, hd, y0: by, floors, floorH, spacing: floors > 2 ? 2.6 : 3, door: doorSide, top: M.WINDOW }));
  const ridgeAlongU = w >= d;
  const span = ridgeAlongU ? hd : hw;
  const rh = Math.max(1.5, span * pitch);
  if (roofType === 'flat') {
    prims.push(box(OP_ADD, x, z, { angle, hw: hw + 0.6, hd: hd + 0.6, y0: wallTop, y1: wallTop + 0.6, top: trim, side: trim }));
  } else if (roofType === 'hip') {
    prims.push(hip(x, z, { angle, hw, hd, y0: wallTop, h: rh, eave: 0.9, top: roof, side: roof }));
  } else {
    prims.push(gable(x, z, { angle: ridgeAlongU ? angle : angle + Math.PI / 2, hw: ridgeAlongU ? hw : hd, hd: ridgeAlongU ? hd : hw, y0: wallTop, h: rh, eave: 0.9, top: roof, side: roof, bot: wall, gableSide: 1 }));
  }
  if (chimney) {
    const cu = hw * 0.55, cv = hd * 0.3;
    const cx = x + Math.cos(angle) * cu - Math.sin(angle) * cv;
    const cz = z + Math.sin(angle) * cu + Math.cos(angle) * cv;
    prims.push(cyl(OP_ADD, cx, cz, { r: 0.6, y0: wallTop, y1: wallTop + rh + 1.6, top: M.BRICK, side: M.BRICK }));
  }
  return { prims, wallTop, roofTop: wallTop + rh };
}

/** Round tower with conical roof. */
export function tower(x, z, { r, base: by, height, wall = M.BRICK, roof = M.ROOF_A, roofH = null }) {
  const prims = [];
  prims.push(flat(x, z, { r: r + 1.2, y0: by, feather: 2, top: M.COBBLE }));
  prims.push(cyl(OP_ADD, x, z, { r, y0: by - 3, y1: by + height, top: wall, side: wall }));
  prims.push(windows(x, z, { r, hw: r, hd: r, y0: by, floors: Math.floor(height / 3.6), floorH: 3.6, spacing: 3, door: -2, top: M.WINDOW, round: true }));
  prims.push(cone(x, z, { r: r + 0.8, y0: by + height, h: roofH ?? r * 1.9, top: roof, side: roof }));
  return { prims, top: by + height + (roofH ?? r * 1.9) };
}

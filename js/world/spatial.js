// Uniform spatial grid over the world rectangle for fast lookup of
// procedural features (structures, caves, rivers, routes) by column.

export class SpatialGrid {
  constructor(cellSize, halfX = 1600, halfZ = 1400) {
    this.cs = cellSize;
    this.ox = -halfX;
    this.oz = -halfZ;
    this.nx = Math.ceil((halfX * 2) / cellSize);
    this.nz = Math.ceil((halfZ * 2) / cellSize);
    this.cells = new Array(this.nx * this.nz);
    this.empty = [];
  }

  insertAABB(minX, minZ, maxX, maxZ, item) {
    const cs = this.cs;
    const i0 = Math.max(0, Math.floor((minX - this.ox) / cs));
    const i1 = Math.min(this.nx - 1, Math.floor((maxX - this.ox) / cs));
    const j0 = Math.max(0, Math.floor((minZ - this.oz) / cs));
    const j1 = Math.min(this.nz - 1, Math.floor((maxZ - this.oz) / cs));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.nx + i;
        (this.cells[k] || (this.cells[k] = [])).push(item);
      }
    }
  }

  insertCircle(x, z, r, item) { this.insertAABB(x - r, z - r, x + r, z + r, item); }

  insertSegment(ax, az, bx, bz, r, item) {
    this.insertAABB(Math.min(ax, bx) - r, Math.min(az, bz) - r, Math.max(ax, bx) + r, Math.max(az, bz) + r, item);
  }

  query(x, z) {
    const i = Math.floor((x - this.ox) / this.cs);
    const j = Math.floor((z - this.oz) / this.cs);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return this.empty;
    return this.cells[j * this.nx + i] || this.empty;
  }

  /** Collect unique items in a radius (slower; for planning). */
  queryRadius(x, z, r, out = []) {
    const cs = this.cs;
    const seen = new Set();
    const i0 = Math.max(0, Math.floor((x - r - this.ox) / cs)), i1 = Math.min(this.nx - 1, Math.floor((x + r - this.ox) / cs));
    const j0 = Math.max(0, Math.floor((z - r - this.oz) / cs)), j1 = Math.min(this.nz - 1, Math.floor((z + r - this.oz) / cs));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = this.cells[j * this.nx + i];
      if (!c) continue;
      for (const it of c) if (!seen.has(it)) { seen.add(it); out.push(it); }
    }
    return out;
  }
}

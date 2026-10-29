// Chunk streaming with a quadtree level of detail. The world is divided into
// parallelogram chunks in axial hex coordinates; a node at level L covers
// 32 * 2^L cells and is meshed with 32x32 cells of size 2^L. Nodes near the
// camera split into children. Workers build meshes; missing chunks are covered
// by their nearest ready ancestor so the terrain never shows holes.
//
// Like Minecraft, only the chunks within the render distance (chosen in the
// settings, in chunks of 32 cells) are built and drawn; nodes that cross that
// circle are split down to small chunks so nothing coarse pokes out beyond it,
// and the edge fog hides the border.
import * as THREE from 'three';
import { CHUNK } from '../world/mesher.js';
import { makeTerrainMaterial, makeFoliageMaterial, makeWaterMaterial, makeFallMaterial } from './materials.js';

const LMAX = 5;
const keyOf = (L, cq, cr) => `${L}:${cq}:${cr}`;

export class ChunkManager {
  constructor({ world, scene, workers, quality = 1.0, renderChunks = 12, onChunkLoaded }) {
    this.world = world;
    this.scene = scene;
    this.workers = workers; // array of { worker, busy }
    this.quality = quality;
    this.renderRadius = renderChunks * CHUNK;
    this.onChunkLoaded = onChunkLoaded;
    this.nodes = new Map();
    this.pending = new Map(); // key -> {L, cq, cr, prio}
    this.inFlight = new Map(); // key -> worker index
    this.shown = new Set();
    this.desired = [];
    this.group = new THREE.Group();
    this.group.name = 'chunks';
    scene.add(this.group);
    this.terrainMats = [];
    for (let L = 0; L <= LMAX; L++) this.terrainMats.push(makeTerrainMaterial(1 << L));
    this.foliageMat = makeFoliageMaterial();
    this.waterMat = makeWaterMaterial();
    this.fallMat = makeFallMaterial();
    this.cacheLimit = 360;
    this.showUpper = true; this.showDeep = false;
    this.stats = { built: 0, ms: 0, tris: 0, visible: 0, pending: 0 };
    for (let i = 0; i < workers.length; i++) {
      workers[i].busy = false;
      workers[i].worker.addEventListener('message', (e) => this.onMessage(i, e.data));
    }
    const hx = world.params.worldHalfX, hz = world.params.worldHalfZ;
    this.rootRange = { cq0: Math.floor((-hx - hz / 0.866 * 0.5) / (CHUNK << LMAX)) - 1, cq1: Math.floor((hx + hz / 0.866 * 0.5) / (CHUNK << LMAX)) + 1, cr0: Math.floor(-hz / 0.866 / (CHUNK << LMAX)) - 1, cr1: Math.floor(hz / 0.866 / (CHUNK << LMAX)) + 1 };
    this.islandR = world.params.coastR * 1.12 + 60;
  }

  nodeCenter(L, cq, cr) {
    const S = CHUNK << L;
    const qc = (cq + 0.5) * S - 0.5 * (1 << L), rc = (cr + 0.5) * S - 0.5 * (1 << L);
    return [qc + rc * 0.5, rc * 0.8660254, S * 0.88];
  }

  /** Choose the set of leaf nodes to display for a camera position. */
  select(cx, cz) {
    const out = [];
    const K = this.quality;
    const rec = (L, cq, cr) => {
      const [x, z, rad] = this.nodeCenter(L, cq, cr);
      if (Math.hypot(x, z) - rad > this.islandR) return;
      if (Math.abs(x) - rad > this.world.params.worldHalfX + 80 || Math.abs(z) - rad > this.world.params.worldHalfZ + 80) return;
      const d = Math.hypot(x - cx, z - cz);
      const S = CHUNK << L;
      // beyond the render distance: not built, not drawn
      if (d - rad > this.renderRadius) return;
      // crossing the edge: split until the pieces are small
      const edge = d + rad > this.renderRadius && L > 2;
      if (L > 0 && (edge || d - rad < K * S * 0.5)) {
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) rec(L - 1, cq * 2 + i, cr * 2 + j);
      } else out.push({ L, cq, cr, d, S });
    };
    const R = this.rootRange;
    for (let cr = R.cr0; cr <= R.cr1; cr++) for (let cq = R.cq0; cq <= R.cq1; cq++) rec(LMAX, cq, cr);
    return out;
  }

  ancestorReady(L, cq, cr) {
    for (let l = L + 1, q = cq, r = cr; l <= LMAX; l++) {
      q = Math.floor(q / 2); r = Math.floor(r / 2);
      const n = this.nodes.get(keyOf(l, q, r));
      if (n && n.ready) return n;
    }
    return null;
  }

  update(camPos) {
    this.lastFocus = camPos;
    // Layer 4 lies below the split; it shows from the bottom of the Great Fault down
    this.setBands(camPos.y > -2012, camPos.y < -1930);
    const leaves = this.select(camPos.x, camPos.z);
    this.desired = leaves;
    const now = performance.now();
    const want = new Set();
    let covered = 0;
    for (const lf of leaves) {
      const k = keyOf(lf.L, lf.cq, lf.cr);
      const n = this.nodes.get(k);
      if (n && n.ready) {
        want.add(k);
        n.lastUsed = now;
        covered++;
      } else {
        if (!this.inFlight.has(k)) this.pending.set(k, { L: lf.L, cq: lf.cq, cr: lf.cr, prio: lf.d / lf.S - (lf.L >= 3 ? 0.5 : 0) });
        const anc = this.ancestorReady(lf.L, lf.cq, lf.cr);
        if (anc) { want.add(anc.key); anc.lastUsed = now; }
      }
    }
    // remove descendants of any wanted ancestor (avoid overlap)
    const finalSet = new Set();
    for (const k of want) {
      const n = this.nodes.get(k);
      let covered2 = false;
      for (let l = n.L + 1, q = n.cq, r = n.cr; l <= LMAX; l++) {
        q = Math.floor(q / 2); r = Math.floor(r / 2);
        if (want.has(keyOf(l, q, r))) { covered2 = true; break; }
      }
      if (!covered2) finalSet.add(k);
    }
    // drop pending requests that are no longer desired
    const desiredKeys = new Set(leaves.map((l) => keyOf(l.L, l.cq, l.cr)));
    for (const k of this.pending.keys()) if (!desiredKeys.has(k)) this.pending.delete(k);
    // visibility
    for (const k of this.shown) if (!finalSet.has(k)) { const n = this.nodes.get(k); if (n && n.group) n.group.visible = false; }
    let tris = 0;
    for (const k of finalSet) { const n = this.nodes.get(k); if (n && n.group) { n.group.visible = true; tris += n.tris; } }
    this.shown = finalSet;
    this.stats.tris = tris;
    this.stats.visible = finalSet.size;
    this.stats.pending = this.pending.size + this.inFlight.size;
    this.coverage = leaves.length ? covered / leaves.length : 0;
    this.dispatch();
    this.evict();
  }

  /** Fraction of desired leaves near the camera that are ready. */
  nearReady(radius) {
    let tot = 0, ok = 0;
    for (const lf of this.desired) {
      if (lf.d > radius) continue;
      tot++;
      const n = this.nodes.get(keyOf(lf.L, lf.cq, lf.cr));
      if (n && n.ready) ok++;
    }
    return tot ? ok / tot : 1;
  }

  dispatch() {
    if (!this.pending.size) return;
    const free = this.workers.filter((w) => !w.busy);
    if (!free.length) return;
    const list = [...this.pending.entries()].sort((a, b) => a[1].prio - b[1].prio);
    for (const w of free) {
      const next = list.shift();
      if (!next) break;
      const [k, req] = next;
      this.pending.delete(k);
      this.inFlight.set(k, this.workers.indexOf(w));
      w.busy = true;
      w.worker.postMessage({ type: 'chunk', key: k, L: req.L, cq: req.cq, cr: req.cr });
    }
  }

  onMessage(wi, msg) {
    if (msg.type === 'chunk') {
      this.workers[wi].busy = false;
      this.inFlight.delete(msg.key);
      // collision data is needed at once; the meshes go up to the GPU a few at a time (see pump)
      const o = msg.out;
      if (o.L === 0 && o.spans) { this.world.addChunkData(o.cq, o.cr, o.spans, o.colliders); o.spansDone = true; }
      (this.arrived || (this.arrived = [])).push([msg.key, o]);
      this.dispatch();
    } else if (msg.type === 'error') {
      this.workers[wi].busy = false;
      this.inFlight.delete(msg.key);
      console.error('chunk worker error', msg.key, msg.message);
      this.dispatch();
    }
  }

  makeGeometry(m, sway) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(m.col, 3, true));
    g.setAttribute('aLight', new THREE.BufferAttribute(m.lit, 4, true));
    if (sway && m.sway) g.setAttribute('aSway', new THREE.BufferAttribute(m.sway, 1, true));
    g.setIndex(new THREE.BufferAttribute(m.idx, 1));
    if (m.bs) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(m.bs[0], m.bs[1], m.bs[2]), m.bs[3]);
    else g.computeBoundingSphere();
    return g;
  }

  buildNode(key, out) {
    const { L, cq, cr } = out;
    let node = this.nodes.get(key);
    if (!node) { node = { key, L, cq, cr }; this.nodes.set(key, node); }
    const group = new THREE.Group();
    group.visible = false;
    let tris = 0;
    // each kind of mesh, for the upper world and for the deep (Layer 4) band
    for (const deep of [false, true]) {
      const sfx = deep ? 'Deep' : '';
      const show = deep ? this.showDeep : this.showUpper;
      const T = out['terrain' + sfx], F = out['foliage' + sfx], Wt = out['water' + sfx], Fa = out['falls' + sfx];
      if (T) {
        const mesh = new THREE.Mesh(this.makeGeometry(T), this.terrainMats[L]);
        mesh.receiveShadow = L <= 2;
        mesh.castShadow = L <= 1 && !deep;
        mesh.userData.deep = deep; mesh.visible = show;
        group.add(mesh);
        tris += T.idx.length / 3;
      }
      if (F) {
        const mesh = new THREE.Mesh(this.makeGeometry(F, true), this.foliageMat);
        mesh.receiveShadow = L === 0;
        mesh.castShadow = false;
        mesh.userData.deep = deep; mesh.visible = show;
        group.add(mesh);
        tris += F.idx.length / 3;
      }
      if (Wt) {
        const mesh = new THREE.Mesh(this.makeGeometry(Wt), this.waterMat);
        mesh.renderOrder = 2;
        mesh.userData.deep = deep; mesh.visible = show;
        group.add(mesh);
      }
      if (Fa) {
        const mesh = new THREE.Mesh(this.makeGeometry(Fa), this.fallMat);
        mesh.renderOrder = 3;
        mesh.userData.deep = deep; mesh.visible = show;
        group.add(mesh);
      }
    }
    node.group = group;
    node.tris = tris;
    node.ready = true;
    node.lastUsed = performance.now();
    this.group.add(group);
    if (L === 0 && out.spans && !out.spansDone) this.world.addChunkData(cq, cr, out.spans, out.colliders);
    this.stats.built++;
    this.stats.ms += out.ms || 0;
    if (this.onChunkLoaded) this.onChunkLoaded(node, out);
  }

  /**
   * Turn arrived chunk meshes into scene objects within a byte budget per frame:
   * each new mesh is uploaded to the GPU when first drawn, and dozens arriving
   * together made a visible stall on slow devices. Returns true when something
   * new can be shown (the caller then refreshes the visible set).
   */
  pump(budgetBytes = 1.5e6) {
    if (!this.arrived || !this.arrived.length) return false;
    let used = 0, n = 0;
    // nearest first: the arrival list is short, a sort is cheap
    if (this.arrived.length > 1 && this.lastFocus) {
      const f = this.lastFocus;
      this.arrived.sort((a, b) => this.nodeDist(a[1], f) - this.nodeDist(b[1], f));
    }
    while (this.arrived.length && (n === 0 || used < budgetBytes)) {
      const [key, out] = this.arrived.shift();
      for (const k of ['terrain', 'foliage', 'water', 'falls', 'terrainDeep', 'foliageDeep', 'waterDeep', 'fallsDeep']) if (out[k]) used += out[k].pos.byteLength * 2 + out[k].idx.byteLength;
      this.buildNode(key, out);
      n++;
    }
    return n > 0;
  }

  nodeDist(out, f) {
    const m = out.terrain || out.terrainDeep || out.foliage || out.water || out.falls;
    if (!m || !m.bs) return 0;
    return (m.bs[0] - f.x) ** 2 + (m.bs[2] - f.z) ** 2;
  }

  evict() {
    if (this.nodes.size <= this.cacheLimit) return;
    const list = [...this.nodes.values()].filter((n) => n.ready && !this.shown.has(n.key)).sort((a, b) => a.lastUsed - b.lastUsed);
    let excess = this.nodes.size - this.cacheLimit;
    for (const n of list) {
      if (excess-- <= 0) break;
      this.disposeNode(n);
    }
  }

  disposeNode(n) {
    if (n.group) {
      for (const m of n.group.children) m.geometry.dispose();
      this.group.remove(n.group);
    }
    if (n.L === 0) this.world.removeChunkData(n.cq, n.cr);
    this.nodes.delete(n.key);
  }

  setQuality(q) { this.quality = q; }

  /**
   * Which height bands are drawn: the upper world (surface to Layer 3) and the
   * deep band (Layer 4). Nothing of one can be seen from deep inside the other,
   * so hiding it saves the GPU most of the world.
   */
  setBands(showUpper, showDeep) {
    if (showUpper === this.showUpper && showDeep === this.showDeep) return;
    this.showUpper = showUpper; this.showDeep = showDeep;
    for (const n of this.nodes.values()) {
      if (!n.group) continue;
      for (const m of n.group.children) m.visible = m.userData.deep ? showDeep : showUpper;
    }
  }

  setRenderDistance(chunks) { this.renderRadius = chunks * CHUNK; }

  dispose() {
    for (const n of [...this.nodes.values()]) this.disposeNode(n);
    this.scene.remove(this.group);
  }
}

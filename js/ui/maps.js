// Map views drawn on 2D canvases:
// - TopDownMap: the explorer's chart of explored terrain per depth band, with
//   hillshade and contours, discovered landmarks, routes, artifact sites, the
//   travelled trail, layer boundaries (once discovered) and the explorer.
// - VerticalMap: the Abyss in profile — a depth schematic of all layers and a
//   true cross-section through the explorer's bearing from the Eye.
import { MATERIALS } from '../world/materials.js';
import { LAYERS, LAYER_BOUNDARIES } from '../world/layers.js';
import { MAP_W, MAP_H, RES, X0, Z0, BANDS, F_EXPLORED, F_WATER, F_VOID, F_ROUTE, F_BUILDING, bandOf } from '../systems/mapdata.js';
import { clamp, lerp } from '../core/mathutil.js';

const PARCH = [0.86, 0.8, 0.66];
const ICONS = {
  eye: '◎', waterfall: '≋', lake: '◌', gate: '⛩', guild: '⚑', market: '⌂', temple: '⛫', observatory: '✧', hamlet: '⌂', platform: '▿',
  ruin: '♜', arch: '∩', spire: '▲', station: '⚑', gallery: '♣', plain: '◇', stair: '≡', fault: '✕', threshold: '∏', cave: '●', crystal: '✦',
};

function mapColor(mat, flags) {
  if (flags & F_VOID) return [0.06, 0.08, 0.1];
  if (flags & F_WATER) return [0.34, 0.52, 0.62];
  const m = MATERIALS[mat];
  let c = m ? m.color : [0.5, 0.5, 0.5];
  if (flags & F_BUILDING) c = [0.62, 0.42, 0.36];
  else if (flags & F_ROUTE) c = [0.72, 0.6, 0.42];
  return [lerp(c[0], PARCH[0], 0.3), lerp(c[1], PARCH[1], 0.3), lerp(c[2], PARCH[2], 0.3)];
}

// ---------------------------------------------------------------------------
export class TopDownMap {
  constructor(game) {
    this.game = game;
    this.data = game.mapData;
    this.disc = game.discovery;
    this.base = BANDS.map(() => { const c = document.createElement('canvas'); c.width = MAP_W; c.height = MAP_H; return { canvas: c, version: -1 }; });
    this.band = 0;
    this.zoom = 1.2;      // pixels per metre
    this.cx = 0; this.cz = 0;
    this.follow = true;
  }

  mount(el) {
    this.el = el;
    el.innerHTML = `
      <div class="map-wrap">
        <canvas class="map-canvas"></canvas>
        <div class="map-tools">
          <div class="map-bands"></div>
          <button class="btn small" data-act="center">Centre on me</button>
          <button class="btn small" data-act="zin">+</button>
          <button class="btn small" data-act="zout">−</button>
        </div>
        <div class="map-legend"></div>
        <div class="map-hover"></div>
      </div>`;
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.hover = el.querySelector('.map-hover');
    const p = this.game.player.pos;
    this.band = bandOf(p.y);
    this.cx = p.x; this.cz = p.z;
    this.follow = true;
    this.buildBandButtons();
    el.querySelector('[data-act=center]').onclick = () => { this.follow = true; this.draw(); };
    el.querySelector('[data-act=zin]').onclick = () => { this.zoom = clamp(this.zoom * 1.5, 0.15, 12); this.draw(); };
    el.querySelector('[data-act=zout]').onclick = () => { this.zoom = clamp(this.zoom / 1.5, 0.15, 12); this.draw(); };
    let drag = null;
    this.canvas.onpointerdown = (e) => { drag = { x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz }; this.canvas.setPointerCapture(e.pointerId); };
    this.canvas.onpointermove = (e) => {
      if (drag) {
        this.follow = false;
        this.cx = drag.cx - (e.clientX - drag.x) / this.zoom;
        this.cz = drag.cz - (e.clientY - drag.y) / this.zoom;
        this.draw();
      } else this.hoverAt(e);
    };
    this.canvas.onpointerup = () => { drag = null; };
    this.canvas.onwheel = (e) => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const wx = this.cx + (mx - r.width / 2) / this.zoom, wz = this.cz + (my - r.height / 2) / this.zoom;
      this.zoom = clamp(this.zoom * (e.deltaY < 0 ? 1.25 : 0.8), 0.15, 12);
      this.cx = wx - (mx - r.width / 2) / this.zoom; this.cz = wz - (my - r.height / 2) / this.zoom;
      this.follow = false;
      this.draw();
    };
    this.renderLegend();
    this.resize();
    this.draw();
  }

  buildBandButtons() {
    const box = this.el.querySelector('.map-bands');
    box.innerHTML = '';
    BANDS.forEach((b, i) => {
      const known = this.data.bands[i].count > 0;
      const btn = document.createElement('button');
      btn.className = 'btn small tab' + (i === this.band ? ' active' : '');
      btn.textContent = known ? b.name : '???';
      btn.disabled = !known;
      btn.onclick = () => { this.band = i; this.buildBandButtons(); this.draw(); };
      box.appendChild(btn);
    });
  }

  renderLegend() {
    const lg = this.el.querySelector('.map-legend');
    const types = new Set(this.game.plan.landmarks.filter((l) => this.disc.landmarks.has(l.id)).map((l) => l.type));
    const items = [['▲', 'You', 'you'], ['·', 'Your trail', 'trail'], ['✦', 'Artifact recovered', 'art'], ['◇', 'Artifact sighted', 'art2']];
    for (const t of types) items.push([ICONS[t] || '•', t.charAt(0).toUpperCase() + t.slice(1), 'lm']);
    lg.innerHTML = items.map(([i, t, c]) => `<div><span class="lg-${c}">${i}</span> ${t}</div>`).join('') +
      `<div class="lg-note">Only terrain you have explored is charted.</div>`;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(10, r.width * dpr);
    this.canvas.height = Math.max(10, r.height * dpr);
    this.dpr = dpr;
  }

  /** Re-compose the band raster if it changed. */
  updateBase(bi) {
    const B = this.data.bands[bi], T = this.base[bi];
    if (T.version === B.version) return T.canvas;
    T.version = B.version;
    const ctx = T.canvas.getContext('2d');
    const img = ctx.createImageData(MAP_W, MAP_H);
    const px = img.data;
    const { h, mat, flags } = B;
    const W = MAP_W;
    for (let j = 0; j < MAP_H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const f = flags[k];
        if (!(f & F_EXPLORED)) continue;
        const c = mapColor(mat[k], f);
        let shade = 1;
        if (!(f & F_VOID)) {
          const hr = i + 1 < W && (flags[k + 1] & F_EXPLORED) && !(flags[k + 1] & F_VOID) ? h[k + 1] : h[k];
          const hl = i > 0 && (flags[k - 1] & F_EXPLORED) && !(flags[k - 1] & F_VOID) ? h[k - 1] : h[k];
          const hd = j + 1 < MAP_H && (flags[k + W] & F_EXPLORED) && !(flags[k + W] & F_VOID) ? h[k + W] : h[k];
          const hu = j > 0 && (flags[k - W] & F_EXPLORED) && !(flags[k - W] & F_VOID) ? h[k - W] : h[k];
          const dx = (hr - hl) / 4 / (2 * RES), dz = (hd - hu) / 4 / (2 * RES);
          shade = clamp(1 - (dx * 0.7 + dz * 0.7) * 0.9, 0.45, 1.35);
          // contour lines every 10 m (heavier every 50 m)
          if (!(f & F_WATER)) {
            const lv = Math.floor(h[k] / 40), lr = Math.floor(hr / 40), ld = Math.floor(hd / 40);
            if (lv !== lr || lv !== ld) shade *= Math.min(lv, lr, ld) % 5 === 4 ? 0.72 : 0.86;
          }
          // cliffs drawn dark
          if (Math.abs(dx) > 2.2 || Math.abs(dz) > 2.2) shade *= 0.7;
        }
        const o = k * 4;
        px[o] = clamp(c[0] * shade, 0, 1) * 255;
        px[o + 1] = clamp(c[1] * shade, 0, 1) * 255;
        px[o + 2] = clamp(c[2] * shade, 0, 1) * 255;
        px[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return T.canvas;
  }

  toScreen(x, z) {
    const W = this.canvas.width / this.dpr, H = this.canvas.height / this.dpr;
    return [(x - this.cx) * this.zoom + W / 2, (z - this.cz) * this.zoom + H / 2];
  }

  draw() {
    if (!this.ctx) return;
    const g = this.game, p = g.player.pos;
    if (this.follow) { this.cx = p.x; this.cz = p.z; }
    const ctx = this.ctx, dpr = this.dpr;
    const W = this.canvas.width / dpr, H = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // parchment
    ctx.fillStyle = '#cdbf9c';
    ctx.fillRect(0, 0, W, H);
    this.drawGrid(ctx, W, H);
    // explored raster
    const base = this.updateBase(this.band);
    ctx.imageSmoothingEnabled = this.zoom < RES * 0.9 ? true : false;
    const [sx, sy] = this.toScreen(X0, Z0);
    ctx.drawImage(base, sx, sy, MAP_W * RES * this.zoom, MAP_H * RES * this.zoom);
    this.drawBoundaries(ctx);
    this.drawRoutes(ctx);
    this.drawTrail(ctx);
    this.drawLandmarks(ctx);
    this.drawArtifacts(ctx);
    this.drawPlayer(ctx);
    this.drawScale(ctx, W, H);
    this.drawCompass(ctx, W);
  }

  drawGrid(ctx, W, H) {
    const step = this.zoom > 2 ? 50 : this.zoom > 0.6 ? 100 : 250;
    ctx.strokeStyle = 'rgba(90,70,40,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.floor((this.cx - W / 2 / this.zoom) / step) * step, x1 = this.cx + W / 2 / this.zoom;
    const z0 = Math.floor((this.cz - H / 2 / this.zoom) / step) * step, z1 = this.cz + H / 2 / this.zoom;
    for (let x = x0; x <= x1; x += step) { const [a] = this.toScreen(x, 0); ctx.moveTo(a, 0); ctx.lineTo(a, H); }
    for (let z = z0; z <= z1; z += step) { const [, b] = this.toScreen(0, z); ctx.moveTo(0, b); ctx.lineTo(W, b); }
    ctx.stroke();
  }

  contour(ctx, fn, style, dash, label) {
    const f = this.game.world.field;
    ctx.save();
    ctx.strokeStyle = style; ctx.lineWidth = 1.6; ctx.setLineDash(dash);
    ctx.beginPath();
    let lx = 0, ly = 0;
    for (let i = 0; i <= 180; i++) {
      const th = -Math.PI + (i / 180) * Math.PI * 2;
      const pt = fn(th, f);
      if (!pt) continue;
      const [x, y] = this.toScreen(pt[0], pt[1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      if (i === 30) { lx = x; ly = y; }
    }
    ctx.closePath();
    ctx.stroke();
    if (label) { ctx.setLineDash([]); ctx.font = 'italic 12px Georgia, serif'; ctx.fillStyle = style; ctx.fillText(label, lx + 6, ly - 4); }
    ctx.restore();
  }

  drawBoundaries(ctx) {
    const L = this.disc.layers;
    const eye = (th, f) => f.fromPolar(f.tab(f.eyeTab, th), th);
    if (this.band === 0) {
      if (L.has(1)) this.contour(ctx, (th, f) => f.fromPolar(f.tab(f.rimTab, th), th), 'rgba(60,90,40,0.9)', [6, 4], 'First Layer');
      if (L.has(2) || this.disc.landmarks.has(this.game.plan.landmarks.find((l) => l.type === 'eye')?.id)) this.contour(ctx, eye, 'rgba(30,40,70,0.95)', [2, 3], 'The Abyss Eye — Second Layer below');
    } else if (this.band === 1) {
      this.contour(ctx, eye, 'rgba(160,200,220,0.9)', [2, 3], 'Shaft of the Eye');
      if (L.has(3)) {
        const fp = this.game.plan.params.fault;
        this.contour(ctx, (th, f) => { const r = f.tab(f.faultTab, th); return [fp.x + Math.cos(th) * r, fp.z + Math.sin(th) * r]; }, 'rgba(170,40,30,0.95)', [5, 3], 'The Great Fault — Third Layer');
      }
    } else {
      const fp = this.game.plan.params.fault;
      this.contour(ctx, (th, f) => { const r = f.tab(f.faultTab, th); return [fp.x + Math.cos(th) * r, fp.z + Math.sin(th) * r]; }, 'rgba(200,60,40,0.95)', [5, 3], 'The Great Fault');
    }
  }

  inBand(y) { return bandOf(y) === this.band; }

  drawRoutes(ctx) {
    const plan = this.game.plan;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(120,40,20,0.85)';
    ctx.font = 'italic 11px Georgia, serif';
    ctx.fillStyle = 'rgba(100,30,15,0.95)';
    for (const id of this.disc.routes) {
      const r = plan.routes.find((rr) => rr.id === id);
      if (!r) continue;
      const pts = r.pts;
      ctx.beginPath();
      let pen = false, lab = null;
      for (let i = 0; i < pts.length; i += 3) {
        const x = pts[i], y = pts[i + 1], z = pts[i + 2];
        const vis = this.inBand(y) && this.data.explored(this.band, x, z);
        if (!vis) { pen = false; continue; }
        const [sx, sy] = this.toScreen(x, z);
        if (!pen) { ctx.moveTo(sx, sy); pen = true; } else ctx.lineTo(sx, sy);
        if (!lab) lab = [sx, sy];
      }
      ctx.stroke();
      if (lab && this.zoom > 0.5) ctx.fillText(r.name, lab[0] + 5, lab[1] - 5);
    }
    ctx.restore();
  }

  drawTrail(ctx) {
    const t = this.data.trail;
    ctx.save();
    ctx.fillStyle = 'rgba(30,20,10,0.55)';
    const s = Math.max(1, this.zoom * 1.2);
    const stride = this.zoom < 0.4 ? 9 : 3;
    for (let i = 0; i < t.length; i += stride) {
      if (!this.inBand(t[i + 1])) continue;
      const [x, y] = this.toScreen(t[i], t[i + 2]);
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
    ctx.restore();
  }

  drawLandmarks(ctx) {
    const plan = this.game.plan;
    ctx.save();
    ctx.textAlign = 'center';
    for (const lm of plan.landmarks) {
      if (!this.disc.landmarks.has(lm.id)) continue;
      if (!this.inBand(lm.y) && !(lm.type === 'eye' && this.band <= 1)) continue;
      if (lm.minor && this.zoom < 0.8) continue;
      const [x, y] = this.toScreen(lm.x, lm.z);
      ctx.font = '15px serif';
      ctx.fillStyle = '#2a1c10';
      ctx.fillText(ICONS[lm.type] || '•', x, y + 5);
      if (this.zoom > 0.35 || ['eye', 'station', 'guild', 'threshold', 'gallery', 'plain'].includes(lm.type)) {
        ctx.font = 'italic 12px Georgia, serif';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(230,220,190,0.8)';
        ctx.strokeText(lm.name, x, y - 9);
        ctx.fillText(lm.name, x, y - 9);
      }
    }
    ctx.restore();
  }

  drawArtifacts(ctx) {
    const arts = this.game.artifacts;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 14px serif';
    for (const [id, f] of this.disc.found) {
      if (!this.inBand(f.y)) continue;
      const [x, y] = this.toScreen(f.x, f.z);
      ctx.fillStyle = '#b07a10';
      ctx.fillText('✦', x, y + 5);
      void id;
    }
    for (const id of this.disc.spotted) {
      const a = arts.byId.get(id);
      if (!a || arts.collected.has(id) || !this.inBand(a.site.y)) continue;
      const [x, y] = this.toScreen(a.site.x, a.site.z);
      ctx.fillStyle = '#6a3fa0';
      ctx.fillText('◇', x, y + 5);
    }
    ctx.restore();
  }

  drawPlayer(ctx) {
    const p = this.game.player;
    if (!this.inBand(p.pos.y)) return;
    const [x, y] = this.toScreen(p.pos.x, p.pos.z);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-p.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -11); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath();
    ctx.fillStyle = '#c0301c'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  drawScale(ctx, W, H) {
    const target = 120 / this.zoom;
    const nice = [10, 25, 50, 100, 250, 500, 1000].find((v) => v >= target * 0.6) || 1000;
    const len = nice * this.zoom;
    ctx.save();
    ctx.fillStyle = '#2a1c10'; ctx.strokeStyle = '#2a1c10'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(20, H - 24); ctx.lineTo(20 + len, H - 24); ctx.moveTo(20, H - 29); ctx.lineTo(20, H - 19); ctx.moveTo(20 + len, H - 29); ctx.lineTo(20 + len, H - 19); ctx.stroke();
    ctx.font = '12px Georgia, serif';
    ctx.fillText(`${nice} m`, 24, H - 31);
    ctx.restore();
  }

  drawCompass(ctx, W) {
    ctx.save();
    ctx.translate(W - 44, 44);
    ctx.strokeStyle = '#2a1c10'; ctx.fillStyle = '#2a1c10'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -22); ctx.lineTo(5, 0); ctx.lineTo(0, 22); ctx.lineTo(-5, 0); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -22); ctx.lineTo(5, 0); ctx.lineTo(-5, 0); ctx.closePath(); ctx.fill();
    ctx.font = 'bold 12px Georgia, serif'; ctx.textAlign = 'center';
    ctx.fillText('N', 0, -28);
    ctx.restore();
  }

  hoverAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const wx = this.cx + (e.clientX - r.left - r.width / 2) / this.zoom;
    const wz = this.cz + (e.clientY - r.top - r.height / 2) / this.zoom;
    const k = this.data.cellIndex(wx, wz);
    const B = this.data.bands[this.band];
    let txt = '';
    if (k >= 0 && (B.flags[k] & F_EXPLORED)) {
      const f = B.flags[k];
      if (f & F_VOID) txt = 'Open abyss';
      else {
        const y = B.h[k] / 4;
        const m = MATERIALS[B.mat[k]];
        txt = `${f & F_WATER ? 'Water' : m ? m.name.charAt(0).toUpperCase() + m.name.slice(1) : 'Ground'} · ${y >= 0 ? `${Math.round(y)} m above the rim` : `depth ${Math.round(-y)} m`}`;
      }
    } else txt = 'Unexplored';
    // nearby landmark
    for (const lm of this.game.plan.landmarks) {
      if (!this.disc.landmarks.has(lm.id)) continue;
      const [x, y] = this.toScreen(lm.x, lm.z);
      if (Math.hypot(x - (e.clientX - r.left), y - (e.clientY - r.top)) < 12) { txt = `${lm.name} — ${txt}`; break; }
    }
    this.hover.textContent = txt;
    this.hover.style.left = `${e.clientX - r.left + 14}px`;
    this.hover.style.top = `${e.clientY - r.top + 10}px`;
  }
}

// ---------------------------------------------------------------------------
/** Piecewise depth scale for the schematic: the charted layers get room. */
const SCHEME = [
  { y0: 120, y1: 0, h: 0.06 },          // surface
  { y0: 0, y1: -350, h: 0.2 },           // layer 1
  { y0: -350, y1: -900, h: 0.24 },       // layer 2
  { y0: -900, y1: -2600, h: 0.2 },       // layer 3
  { y0: -2600, y1: -4000, h: 0.07 },
  { y0: -4000, y1: -6000, h: 0.07 },
  { y0: -6000, y1: -12000, h: 0.08 },
  { y0: -12000, y1: -20000, h: 0.08 },
];

function schemeY(y, top, height) {
  let acc = 0;
  for (const s of SCHEME) {
    if (y <= s.y0 && y >= s.y1) return top + (acc + ((s.y0 - y) / (s.y0 - s.y1)) * s.h) * height;
    acc += s.h;
  }
  return y > SCHEME[0].y0 ? top : top + height;
}

export class VerticalMap {
  constructor(game) {
    this.game = game;
    this.disc = game.discovery;
    this.profile = null;
  }

  mount(el) {
    this.el = el;
    el.innerHTML = `<div class="vmap-wrap"><canvas class="vmap-canvas"></canvas><div class="vmap-side"></div></div>`;
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.side = el.querySelector('.vmap-side');
    this.resize();
    this.computeProfile();
    this.draw();
    this.renderSide();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(10, r.width * dpr);
    this.canvas.height = Math.max(10, r.height * dpr);
    this.dpr = dpr;
  }

  /** True cross-section of the terrain along the explorer's bearing from the Eye. */
  computeProfile() {
    const g = this.game, W = g.world, f = W.field;
    const p = g.player.pos;
    const P = f.polar(p.x, p.z, {});
    const th = P.th;
    const rMax = Math.min(f.tab(f.coastTab, th) + 40, 1400);
    const step = 5;
    const cols = [];
    for (let r = 0; r <= rMax; r += step) {
      const [x, z] = f.fromPolar(r, th);
      const c = W.columnAt(x, z);
      const spans = [];
      for (let s = 0; s < c.n; s++) {
        const o = (c.off + s) * 2;
        spans.push([c.y[o], c.y[o + 1], c.mat[o]]);
      }
      const ex = [0, 1, 2].map((b) => g.mapData.explored(b, x, z));
      cols.push({ r, x, z, spans, water: c.water, ex });
    }
    this.profile = { th, rMax, step, cols, pr: P.r, py: p.y };
  }

  draw() {
    const ctx = this.ctx, dpr = this.dpr;
    const W = this.canvas.width / dpr, H = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#16191c';
    ctx.fillRect(0, 0, W, H);
    const schemeW = Math.min(230, W * 0.3);
    this.drawSchematic(ctx, 14, 16, schemeW - 20, H - 32);
    this.drawSection(ctx, schemeW + 10, 16, W - schemeW - 24, H - 32);
  }

  drawSchematic(ctx, x, y, w, h) {
    const g = this.game, p = g.player.pos;
    const L = this.disc.layers;
    const colors = ['#8fa67a', '#6f9a5a', '#2f5a52', '#5a2a26', '#30283a', '#262433', '#1c1b26', '#141319'];
    let acc = 0;
    SCHEME.forEach((s, i) => {
      const y0 = y + acc * h, hh = s.h * h;
      acc += s.h;
      const known = L.has(i) || i === 0;
      const layer = LAYERS[i];
      const grd = ctx.createLinearGradient(x, y0, x + w, y0);
      grd.addColorStop(0, colors[i]); grd.addColorStop(1, shade(colors[i], 0.6));
      ctx.fillStyle = grd;
      ctx.fillRect(x, y0, w * 0.42, hh - 1);
      ctx.fillStyle = known ? '#e8dcc0' : '#8a8578';
      ctx.font = `${known ? 'bold ' : ''}12px Georgia, serif`;
      const name = i === 0 ? 'The Surface' : known ? layer.name : `${layer.name}`;
      ctx.fillText(name, x + w * 0.46, y0 + 14);
      ctx.font = 'italic 11px Georgia, serif';
      ctx.fillStyle = known ? '#c8bea6' : '#6c685e';
      ctx.fillText(i === 0 ? 'Rim City' : known ? layer.title : layer.implemented ? 'Not yet reached' : 'Uncharted', x + w * 0.46, y0 + 28);
      if (hh > 44) ctx.fillText(layer.depthLabel, x + w * 0.46, y0 + 42);
    });
    // deepest point and the explorer
    const dy = schemeY(Math.min(0, -g.player.deepest), y, h);
    ctx.strokeStyle = 'rgba(255,200,120,0.6)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, dy); ctx.lineTo(x + w * 0.42, dy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,200,120,0.85)'; ctx.font = '10px sans-serif';
    ctx.fillText(`deepest ${Math.round(g.player.deepest)} m`, x + 2, dy - 3);
    const py = schemeY(p.y, y, h);
    ctx.fillStyle = '#ff5a3c';
    ctx.beginPath(); ctx.moveTo(x + w * 0.42 + 2, py); ctx.lineTo(x + w * 0.42 + 12, py - 6); ctx.lineTo(x + w * 0.42 + 12, py + 6); ctx.closePath(); ctx.fill();
    // discovered landmarks as ticks
    ctx.fillStyle = '#e6d6a8';
    for (const lm of g.plan.landmarks) {
      if (!this.disc.landmarks.has(lm.id) || lm.minor) continue;
      const ly = schemeY(lm.y, y, h);
      ctx.fillRect(x + w * 0.42 - 6, ly, 6, 1.5);
    }
  }

  drawSection(ctx, x, y, w, h) {
    const g = this.game, P = this.profile;
    if (!P) return;
    const yTop = 90, yBot = -1010;
    const sx = (r) => x + (r / P.rMax) * w;
    const sy = (v) => y + ((yTop - v) / (yTop - yBot)) * h;
    // sky and abyss gradient
    const grd = ctx.createLinearGradient(0, y, 0, y + h);
    const off = (v) => clamp((sy(v) - y) / h, 0, 1);
    grd.addColorStop(0, '#6d8aa0'); grd.addColorStop(off(-350), '#2e4650'); grd.addColorStop(off(-900), '#141c1e'); grd.addColorStop(1, '#1a0c0c');
    ctx.fillStyle = grd;
    ctx.fillRect(x, y, w, h);
    // layer bands
    ctx.font = 'italic 11px Georgia, serif';
    for (const [yy, label, li] of [[LAYER_BOUNDARIES.layer2Top, 'Second Layer', 2], [LAYER_BOUNDARIES.layer3Top, 'Third Layer', 3]]) {
      ctx.strokeStyle = 'rgba(220,200,150,0.35)'; ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(x, sy(yy)); ctx.lineTo(x + w, sy(yy)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(230,215,170,0.8)';
      ctx.fillText(this.disc.layers.has(li) ? `${label} — ${Math.round(-yy)} m` : `${Math.round(-yy)} m`, x + w - 150, sy(yy) - 4);
    }
    // terrain spans
    const cw = Math.max(1, (P.step / P.rMax) * w + 0.6);
    for (const c of P.cols) {
      const X = sx(c.r) - cw / 2;
      for (const [y0, y1, mat] of c.spans) {
        if (y1 < yBot || y0 > yTop) continue;
        const a = Math.max(y0, yBot), b = Math.min(y1, yTop);
        const band = b > -345 ? 0 : b > -895 ? 1 : 2;
        const ex = c.ex[band];
        const m = MATERIALS[mat];
        const base = m ? m.color : [0.4, 0.4, 0.4];
        const k = ex ? 0.95 : 0.38;
        ctx.fillStyle = `rgb(${(base[0] * 0.55 + 0.12) * k * 255 | 0},${(base[1] * 0.5 + 0.12) * k * 255 | 0},${(base[2] * 0.5 + 0.12) * k * 255 | 0})`;
        ctx.fillRect(X, sy(b), cw, Math.max(1, sy(a) - sy(b)));
        // surface rim line
        ctx.fillStyle = ex ? 'rgba(200,230,150,0.9)' : 'rgba(150,150,130,0.4)';
        ctx.fillRect(X, sy(b), cw, 1);
      }
      if (!Number.isNaN(c.water)) { ctx.fillStyle = 'rgba(90,150,200,0.9)'; ctx.fillRect(X, sy(c.water), cw, 2); }
    }
    // landmarks near this bearing
    ctx.font = '11px Georgia, serif';
    const f = g.world.field;
    for (const lm of g.plan.landmarks) {
      if (!this.disc.landmarks.has(lm.id) || lm.minor) continue;
      const Q = f.polar(lm.x, lm.z, {});
      let dth = Math.abs(Q.th - P.th); dth = Math.min(dth, Math.PI * 2 - dth);
      if (dth > 0.3 && lm.type !== 'eye') continue;
      const X = sx(lm.type === 'eye' ? 0 : Q.r), Y = sy(lm.y);
      ctx.fillStyle = '#ffe2a0';
      ctx.fillRect(X - 2, Y - 2, 4, 4);
      ctx.fillText(lm.name, X + 5, Y - 4);
    }
    // the explorer's trail projected on the section
    const t = g.mapData.trail;
    ctx.fillStyle = 'rgba(255,170,120,0.5)';
    for (let i = 0; i < t.length; i += 6) {
      const Q = f.polar(t[i], t[i + 2], {});
      let dth = Math.abs(Q.th - P.th); dth = Math.min(dth, Math.PI * 2 - dth);
      if (dth > 0.35) continue;
      ctx.fillRect(sx(Q.r) - 1, sy(t[i + 1]) - 1, 2, 2);
    }
    // explorer
    const X = sx(P.pr), Y = sy(this.game.player.pos.y);
    ctx.fillStyle = '#ff5a3c'; ctx.strokeStyle = '#fff';
    ctx.beginPath(); ctx.arc(X, Y - 3, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // depth axis
    ctx.fillStyle = 'rgba(230,220,200,0.75)'; ctx.font = '10px sans-serif';
    for (let d = 0; d >= -1000; d -= 100) { ctx.fillRect(x, sy(d), 5, 1); ctx.fillText(`${-d} m`, x + 7, sy(d) + 3); }
    ctx.font = 'italic 12px Georgia, serif';
    ctx.fillStyle = 'rgba(240,230,210,0.85)';
    ctx.fillText('Cross-section along your bearing from the Eye', x + 8, y + 16);
    ctx.fillText('◀ the Eye', x + 8, y + h - 8);
    ctx.fillText('the coast ▶', x + w - 80, y + h - 8);
  }

  renderSide() {
    const g = this.game, p = g.player.pos, info = g.layerInfo;
    const L = LAYERS[info ? info.layer : 0];
    const routes = [...this.disc.routes].map((id) => g.plan.routes.find((r) => r.id === id)).filter(Boolean);
    const routeRows = routes.map((r) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 1; i < r.pts.length; i += 3) { lo = Math.min(lo, r.pts[i]); hi = Math.max(hi, r.pts[i]); }
      return `<li><b>${r.name}</b><span>${Math.round(Math.max(0, -hi))} – ${Math.round(Math.max(0, -lo))} m</span></li>`;
    }).join('');
    const lms = g.plan.landmarks.filter((l) => this.disc.landmarks.has(l.id) && !l.minor).sort((a, b) => b.y - a.y);
    this.side.innerHTML = `
      <h3>Position</h3>
      <div class="kv"><span>Depth</span><b>${p.y >= 0 ? 'Surface' : Math.round(-p.y) + ' m'}</b></div>
      <div class="kv"><span>Layer</span><b>${L.index === 0 ? 'The Surface' : `${L.name}: ${L.title}`}</b></div>
      <div class="kv"><span>Deepest reached</span><b>${Math.round(g.player.deepest)} m</b></div>
      <h3>Known routes</h3>
      <ul class="routes">${routeRows || '<li class="muted">None yet — routes are recorded once you walk them.</li>'}</ul>
      <h3>Places by depth</h3>
      <ul class="routes">${lms.map((l) => `<li>${l.name}<span>${l.y >= 0 ? 'surface' : Math.round(-l.y) + ' m'}</span></li>`).join('') || '<li class="muted">Nothing discovered yet.</li>'}</ul>`;
  }
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) * k, g = ((n >> 8) & 255) * k, b = (n & 255) * k;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

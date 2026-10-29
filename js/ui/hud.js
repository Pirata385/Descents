// Heads-up display: crosshair with grapple range feedback and hit markers,
// compass with markers, depth/layer readout, health, stamina and the aegis
// shield, notifications, layer banners, interaction prompts, the observation
// panel, worn artifacts, the weapon in hand (and its heat), the health of the
// creature last struck and the warden's health bar.
import { LAYERS } from '../world/layers.js';
import { FAMILY_LABEL } from '../creatures/genome.js';
import { ACTION_LABEL } from '../creatures/brain.js';
import { FULL_OBSERVATION } from '../systems/discovery.js';
import { clamp, wrapAngle } from '../core/mathutil.js';
import { GLYPH } from '../core/gamepad.js';
import { WEAPONS } from '../artifacts/artifactGen.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CARD = [['N', 0], ['NE', Math.PI / 4], ['E', Math.PI / 2], ['SE', Math.PI * 0.75], ['S', Math.PI], ['SW', -Math.PI * 0.75], ['W', -Math.PI / 2], ['NW', -Math.PI / 4]];

export class HUD {
  constructor(game, root) {
    this.game = game;
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="compass"><div class="compass-strip"></div><div class="compass-mark"></div></div>
      <div class="crosshair"><div class="ch-dot"></div><div class="ch-ring"></div><div class="ch-hit"></div><div class="ch-dist"></div></div>
      <div class="target hidden"><div class="tg-name"></div><div class="tg-bar"><i></i></div></div>
      <div class="boss hidden"><div class="bs-name"></div><div class="bs-bar"><i></i></div></div>
      <div class="shieldfx"></div>
      <div class="prompt"></div>
      <div class="observe hidden"><div class="ob-name"></div><div class="ob-sub"></div><div class="bar"><i></i></div><div class="ob-act"></div></div>
      <div class="status">
        <div class="depth"><div class="depth-m"></div><div class="depth-l"></div></div>
        <div class="bars"><div class="hb"><i></i></div><div class="shb"><i></i></div><div class="sb"><i></i></div></div>
      </div>
      <div class="clock"></div>
      <div class="slots-hud"></div>
      <div class="weapon"><div class="wp-name"></div><div class="heat"><i></i></div></div>
      <div class="rope hidden"></div>
      <div class="notes"></div>
      <div class="banner hidden"><div class="b-small"></div><div class="b-big"></div><div class="b-sub"></div></div>
      <div class="hurt"></div>
      <div class="death hidden"><div>You have fallen.</div><small></small></div>
      <div class="fps hidden"></div>
      <div class="hint"></div>`;
    root.appendChild(this.el);
    this.$ = (s) => this.el.querySelector(s);
    this.strip = this.$('.compass-strip');
    this.notes = this.$('.notes');
    this.lastText = {};
    this.hurtA = 0;
    this.textTimer = 0;
    this.fpsAcc = 0; this.fpsN = 0;
    this.hintShown = false;
  }

  set(sel, html) {
    if (this.lastText[sel] === html) return;
    this.lastText[sel] = html;
    this.$(sel).innerHTML = html;
  }

  notify(text, kind = 'info', ttl = 5) {
    const d = document.createElement('div');
    d.className = `note n-${kind}`;
    d.innerHTML = text;
    this.notes.appendChild(d);
    while (this.notes.children.length > 6) this.notes.removeChild(this.notes.firstChild);
    setTimeout(() => d.classList.add('fade'), ttl * 1000);
    setTimeout(() => d.remove(), ttl * 1000 + 900);
  }

  banner(small, big, sub, ttl = 6) {
    const b = this.$('.banner');
    this.$('.b-small').textContent = small;
    this.$('.b-big').textContent = big;
    this.$('.b-sub').textContent = sub;
    b.classList.remove('hidden', 'fade');
    clearTimeout(this.bannerT1); clearTimeout(this.bannerT2);
    this.bannerT1 = setTimeout(() => b.classList.add('fade'), ttl * 1000);
    this.bannerT2 = setTimeout(() => b.classList.add('hidden'), ttl * 1000 + 1500);
  }

  hint(text, ttl = 8) {
    const h = this.$('.hint');
    h.innerHTML = text;
    h.classList.remove('fade');
    clearTimeout(this.hintT);
    this.hintT = setTimeout(() => h.classList.add('fade'), ttl * 1000);
  }

  flashHurt(amount) { this.hurtA = Math.min(1, this.hurtA + amount / 40); }

  setVisible(v) { this.el.classList.toggle('hidden', !v); }

  update(dt) {
    const g = this.game, p = g.player;
    if (!p) return;
    // crosshair: grapple feedback
    const gr = g.grapple;
    const aim = gr && gr.state === 'idle' ? gr.aim : null;
    const ch = this.$('.crosshair');
    ch.classList.toggle('valid', !!(aim && aim.valid));
    ch.classList.toggle('far', !!(aim && !aim.valid));
    ch.classList.toggle('attached', !!(gr && gr.attached));
    ch.classList.toggle('zoom', !!p.zoomed);
    this.textTimer -= dt;
    const slow = this.textTimer <= 0;
    if (slow) this.textTimer = 0.1;
    if (slow) this.set('.ch-dist', aim ? `${Math.round(aim.dist)} m` : '');
    // compass (rebuilt 20 times a second: it is a strip of HTML)
    this.compassT = (this.compassT || 0) - dt;
    if (this.compassT <= 0) { this.compassT = 0.05; this.updateCompass(p); }
    // depth
    if (slow) {
      const info = g.layerInfo;
      const L = LAYERS[info ? info.layer : 0];
      const depth = -p.pos.y;
      this.set('.depth-m', depth <= 0 ? `<b>${Math.round(-depth)}</b> m above the rim` : `Depth <b>${Math.round(depth)}</b> m`);
      this.set('.depth-l', L.index === 0 ? 'The Surface — Rim City' : `${L.name} — ${L.title}`);
      const h = Math.floor(g.timeOfDay), m = Math.floor((g.timeOfDay - h) * 60);
      const lamp = g.lamp && g.lamp.on ? ' · <span class="lamp-on">lamp</span>' : '';
      this.set('.clock', `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}${lamp}`);
      this.updatePrompt(p);
      this.updateObserve(p);
      this.updateSlots();
      this.updateRope(gr);
    }
    // bars
    const hb = this.$('.hb'), sb = this.$('.sb');
    hb.firstChild.style.width = `${clamp(p.health / p.maxHealth, 0, 1) * 100}%`;
    sb.firstChild.style.width = `${clamp(p.stamina / p.maxStamina, 0, 1) * 100}%`;
    hb.classList.toggle('show', p.health < p.maxHealth - 0.5);
    sb.classList.toggle('show', p.stamina < p.maxStamina - 0.5 || p.mode === 'climb');
    hb.classList.toggle('low', p.health < 30);
    this.updateCombat(dt, slow);
    // hurt vignette
    this.hurtA = Math.max(0, this.hurtA - dt * 0.8);
    const lowH = p.health < 30 ? 0.25 + Math.sin(g.gameTime * 4) * 0.08 : 0;
    this.$('.hurt').style.opacity = Math.max(this.hurtA, lowH).toFixed(3);
    // death
    const dead = p.mode === 'dead';
    const de = this.$('.death');
    de.classList.toggle('hidden', !dead);
    if (dead && slow) this.set('.death small', p.deathCause === 'fall' ? 'The fall was too great. You wake where you last stood safely.' : p.deathCause === 'creature' ? 'Something in the dark struck you down.' : 'You lost your footing in the Abyss.');
    // fps
    if (g.settings.showFps) {
      this.fpsAcc += dt; this.fpsN++;
      if (this.fpsAcc > 0.5) {
        const s = g.chunks.stats;
        this.set('.fps', `${Math.round(this.fpsN / this.fpsAcc)} fps · ${s.visible} chunks · ${(s.tris / 1e6).toFixed(1)}M tris`);
        this.fpsAcc = 0; this.fpsN = 0;
      }
    }
    this.$('.fps').classList.toggle('hidden', !g.settings.showFps);
  }

  /** Hit markers, the shield, the weapon's heat, the struck creature's and the warden's health. */
  updateCombat(dt, slow) {
    const g = this.game, C = g.combat, p = g.player;
    if (!C) return;
    const ch = this.$('.crosshair');
    ch.classList.toggle('hit', C.hitT > 0);
    ch.classList.toggle('kill', C.killT > 0);
    const shb = this.$('.shb');
    shb.classList.toggle('show', C.shield > 0);
    if (C.shield > 0) shb.firstChild.style.width = `${clamp(C.shield / Math.max(1, C.shieldMax), 0, 1) * 100}%`;
    this.el.classList.toggle('aegis', C.shield > 0);
    this.el.classList.toggle('phase', C.phaseT > 0);
    const W = C.W;
    const heat = this.$('.heat');
    heat.classList.toggle('show', W.kind === 'beam' && C.heat > 0.5);
    heat.classList.toggle('over', C.overheated);
    heat.firstChild.style.width = `${clamp(C.heat, 0, 100)}%`;
    if (!slow) return;
    const many = g.artifacts && g.artifacts.weapons().length > 1;
    const key = many ? (g.pad ? '' : g.touch ? '' : ' <kbd>T</kbd>') : '';
    const kind = W.kind === 'beam' ? 'ray' : W.kind === 'shot' ? 'caster' : 'melee';
    this.set('.wp-name', `${esc(C.label)} <span class="muted">${kind}${C.weapon.element ? ` · ${C.weapon.element}` : ''}</span>${key}`);
    this.$('.weapon').classList.toggle('on', C.drawn);
    // the creature last struck
    const t = C.target;
    const tg = this.$('.target');
    const w = g.ecosystem && g.ecosystem.warden;
    const boss = w && w.engaged && w.agent.pos.distanceTo(p.pos) < 130 ? w.agent : null;
    if (t && C.targetT > 0 && t !== boss) {
      tg.classList.remove('hidden');
      const known = g.discovery && g.discovery.known(t.sp.id);
      this.set('.tg-name', t.dead ? `${known ? esc(t.sp.name) : 'The creature'} is slain` : known ? esc(t.sp.name) : 'Unknown creature');
      tg.querySelector('i').style.width = `${clamp(t.hp / Math.max(1, t.maxHp), 0, 1) * 100}%`;
    } else tg.classList.add('hidden');
    const bs = this.$('.boss');
    bs.classList.toggle('hidden', !boss);
    if (boss) {
      this.set('.bs-name', esc(w.name));
      bs.classList.toggle('enraged', !!w.enraged);
      bs.querySelector('i').style.width = `${clamp(boss.hp / boss.maxHp, 0, 1) * 100}%`;
    }
    void dt; void WEAPONS;
  }

  updateCompass(p) {
    // heading: yaw 0 looks toward -z (north on the map)
    const heading = wrapAngle(-p.yaw);
    const W = 520, scale = W / (Math.PI * 0.9);
    const marks = [];
    for (const [t, a] of CARD) {
      const d = wrapAngle(a - heading);
      if (Math.abs(d) < Math.PI * 0.47) marks.push(`<span class="cd ${t.length === 1 ? 'major' : ''}" style="left:${(W / 2 + d * scale).toFixed(1)}px">${t}</span>`);
    }
    const g = this.game, pos = p.pos;
    const addMarker = (x, z, cls, label) => {
      const a = Math.atan2(x - pos.x, -(z - pos.z));
      const d = wrapAngle(a - heading);
      if (Math.abs(d) < Math.PI * 0.47) marks.push(`<span class="cm ${cls}" style="left:${(W / 2 + d * scale).toFixed(1)}px" title="${esc(label)}">${label ? `<em>${esc(label)}</em>` : ''}</span>`);
    };
    // the Eye is always felt
    if (Math.hypot(pos.x, pos.z) > 40) addMarker(0, 0, 'eye', Math.hypot(pos.x, pos.z) < 600 ? '' : 'the Eye');
    // on the Stone Plain the delvers' charts point to the nearest way down into the Great Fault
    const F = g.plan.fault;
    if (F && F.sinkholes && F.sinkholes.length && Math.abs(pos.y - g.plan.params.plainY) < 60) {
      let best = null, bd = Infinity;
      for (const sk of F.sinkholes) { const d = Math.hypot(sk.x - pos.x, sk.z - pos.z); if (d < bd) { bd = d; best = sk; } }
      if (best && bd > 14) addMarker(best.x, best.z, 'down', `Way down · ${Math.round(bd)} m`);
    }
    // nearby discovered landmarks
    let n = 0;
    for (const lm of g.plan.landmarks) {
      if (!g.discovery.landmarks.has(lm.id) || lm.minor) continue;
      const d = Math.hypot(lm.x - pos.x, lm.z - pos.z);
      if (d < 30 || d > 500 || Math.abs(lm.y - pos.y) > 150) continue;
      addMarker(lm.x, lm.z, 'lm', d < 200 ? lm.name : '');
      if (++n > 6) break;
    }
    const A = g.artifacts;
    if (A) {
      const target = A.dowse(pos);
      if (target) addMarker(target.site.x, target.site.z, 'dowse', `${Math.round(Math.hypot(target.site.x - pos.x, target.site.z - pos.z))} m`);
      const sense = A.mods?.sense || 0;
      if ((sense || A.effects.pulse > 0) && g.ecosystem) {
        const R = A.effects.pulse > 0 ? 80 : sense;
        let k = 0;
        for (const a of g.ecosystem.agents) {
          if (a.dead || a.pos.distanceTo(pos) > R) continue;
          addMarker(a.pos.x, a.pos.z, a.sp.behavior.diet === 'carnivore' || a.sp.behavior.playerAware ? 'sense danger' : 'sense', '');
          if (++k > 24) break;
        }
      }
    }
    const html = marks.join('');
    if (html !== this.lastCompass) { this.strip.innerHTML = html; this.lastCompass = html; }
  }

  updatePrompt(p) {
    const g = this.game;
    const pad = !!g.pad, t = !pad && !!g.touch;
    let txt = '';
    const A = g.artifacts;
    if (A && A.focus && p.mode !== 'dead') {
      const a = A.focus.art;
      txt = `${pad ? `${GLYPH.square} Take` : t ? '<b>Take</b>' : '<kbd>E</kbd> Take'} the ${esc(a.name)} <span class="muted">(${a.gradeLabel})</span>`;
    } else if (g.discovery.focus && !p.zoomed && p.mode !== 'dead') {
      const a = g.discovery.focus;
      const known = g.discovery.known(a.sp.id);
      txt = `${pad ? `Hold ${GLYPH.triangle} Observe` : t ? 'Hold <b>Observe</b> to study' : '<kbd>F</kbd> Observe'} ${known ? esc(a.sp.name) : 'the creature'}`;
    } else if (g.grapple && g.grapple.attached) {
      txt = pad ? `${GLYPH.L2} reel in · ${GLYPH.L1} pay out · ${GLYPH.R1} release · ${GLYPH.cross} let go`
        : t ? 'Hold <b>Reel in</b> or <b>Pay out</b> · <b>Jump</b> to let go' : '<kbd>Q</kbd>/wheel reel in · <kbd>Z</kbd> pay out · <kbd>RMB</kbd> release · <kbd>Space</kbd> let go';
    } else if (p.mode === 'climb') {
      txt = pad ? `Stick up or down to climb · ${GLYPH.cross} leap off · ${GLYPH.circle} drop`
        : t ? 'Push up or down to climb · <b>Leap</b> off · <b>Drop</b>' : '<kbd>W</kbd>/<kbd>S</kbd> climb · <kbd>Space</kbd> leap off · <kbd>Ctrl</kbd> drop';
    }
    this.set('.prompt', txt);
  }

  updateObserve(p) {
    const g = this.game, ob = this.$('.observe');
    const a = g.discovery.focus;
    if (!p.zoomed) { ob.classList.add('hidden'); return; }
    ob.classList.remove('hidden');
    if (!a) {
      this.set('.ob-name', 'Observing');
      this.set('.ob-sub', 'Centre a creature in view');
      this.set('.ob-act', '');
      ob.querySelector('.bar i').style.width = '0%';
      return;
    }
    const e = g.discovery.species.get(a.sp.id);
    this.set('.ob-name', esc(a.sp.name));
    const form = e && a.sub > 0 && a.sp.subspecies[a.sub] ? ` · ${esc(a.sp.subspecies[a.sub].name)} form` : '';
    this.set('.ob-sub', `${FAMILY_LABEL[a.sp.family]} · ${a.juvenile ? 'juvenile' : a.sex === 'f' ? 'female' : 'male'}${form} · ${Math.round(a.pos.distanceTo(p.pos))} m`);
    const act = ACTION_LABEL[a.state] || a.state;
    this.set('.ob-act', `Currently ${act}`);
    ob.querySelector('.bar i').style.width = `${e ? Math.min(100, (e.observe / FULL_OBSERVATION) * 100) : 0}%`;
  }

  updateSlots() {
    const A = this.game.artifacts;
    if (!A) return;
    const abil = A.abilityItems();
    const active = abil.length ? abil[A.activeIndex % abil.length] : null;
    const html = A.equipped.map((id) => {
      const a = A.byId.get(id);
      const cd = A.cooldowns.get(id) || 0;
      const isActive = active && active.id === id;
      return `<div class="hs ${isActive ? 'active' : ''}" title="${esc(a.name)}"><span class="grade g${a.grade}">${['IV', 'III', 'II', 'I', '✶'][a.grade]}</span>${isActive ? `${this.game.pad ? GLYPH.down : this.game.touch ? '' : '<kbd>R</kbd>'}${cd > 0 ? `<b>${Math.ceil(cd)}</b>` : ''}` : ''}</div>`;
    }).join('');
    // the weapon in hand, when it carries an ability
    const w = A.wieldedArt();
    const wHtml = w && w.ability && w.ability.type !== 'glide' ? (() => {
      const cd = A.cooldowns.get(w.id) || 0, isActive = active && active.id === w.id;
      return `<div class="hs hand ${isActive ? 'active' : ''}" title="${esc(w.name)}"><span class="grade g${w.grade}">⚔</span>${isActive ? `${this.game.pad ? GLYPH.down : this.game.touch ? '' : '<kbd>R</kbd>'}${cd > 0 ? `<b>${Math.ceil(cd)}</b>` : ''}` : ''}</div>`;
    })() : '';
    const html2 = html + wHtml;
    this.set('.slots-hud', html2);
  }

  updateRope(gr) {
    const r = this.$('.rope');
    if (!gr || !gr.attached) { r.classList.add('hidden'); return; }
    r.classList.remove('hidden');
    this.set('.rope', `Cable ${gr.ropeLen.toFixed(1)} / ${Math.round(gr.range)} m${gr.reeling ? ' · reeling' : gr.paying ? ' · paying out' : ''}`);
  }
}

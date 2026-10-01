// The explorer's journal: maps, creature and artifact catalogs, equipment and
// the expedition log. Everything shown here comes from the discovery record.
import { TopDownMap, VerticalMap } from './maps.js';
import { Preview } from './preview.js';
import { FAMILY_LABEL, describeAppearance, DIET_TEXT, LOCO_TEXT } from '../creatures/genetics.js';
import { CATEGORY_LABEL, GRADES, describeEffect, describeAbility, describeDrawback } from '../artifacts/artifactGen.js';
import { LAYERS } from '../world/layers.js';
import { FACT_TIMES, FULL_OBSERVATION } from '../systems/discovery.js';
import { SLOTS } from '../artifacts/artifacts.js';

const TABS = [
  ['map', 'Map'], ['abyss', 'Abyss'], ['creatures', 'Creatures'], ['artifacts', 'Artifacts'], ['equipment', 'Equipment'], ['log', 'Expedition'],
];
const LAYER_IDS = ['surface', 'layer1', 'layer2', 'layer3'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtTime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

export class Journal {
  constructor(game, root) {
    this.game = game;
    this.root = root;
    this.open = false;
    this.tab = 'map';
    this.selSpecies = null;
    this.selArtifact = null;
    this.preview = null;
    this.el = document.createElement('div');
    this.el.className = 'journal hidden';
    this.el.innerHTML = `
      <div class="journal-book">
        <div class="journal-head">
          <div class="journal-title">Delver's Journal</div>
          <div class="journal-tabs">${TABS.map(([id, label]) => `<button class="tab" data-tab="${id}">${label}</button>`).join('')}</div>
          <button class="btn close" data-act="close" title="Close (Esc)">✕</button>
        </div>
        <div class="journal-body"></div>
      </div>`;
    root.appendChild(this.el);
    this.body = this.el.querySelector('.journal-body');
    this.el.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => this.show(b.dataset.tab); });
    this.el.querySelector('[data-act=close]').onclick = () => this.close();
    window.addEventListener('resize', () => { if (this.open) this.show(this.tab); });
  }

  show(tab) {
    this.tab = tab;
    this.open = true;
    this.el.classList.remove('hidden');
    this.el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (this.preview) this.preview.detach();
    this.body.innerHTML = '';
    this.body.className = `journal-body tab-${tab}`;
    switch (tab) {
      case 'map': this.map = new TopDownMap(this.game); this.map.mount(this.body); break;
      case 'abyss': this.vmap = new VerticalMap(this.game); this.vmap.mount(this.body); break;
      case 'creatures': this.renderCreatures(); break;
      case 'artifacts': this.renderArtifacts(); break;
      case 'equipment': this.renderEquipment(); break;
      case 'log': this.renderLog(); break;
      default: break;
    }
  }

  close() {
    this.open = false;
    this.el.classList.add('hidden');
    if (this.preview) this.preview.detach();
    this.map = null; this.vmap = null;
    if (this.onClose) this.onClose();
  }

  getPreview() {
    if (!this.preview) {
      try { this.preview = new Preview(); } catch (e) { console.warn('Preview unavailable', e); this.preview = null; }
    }
    return this.preview;
  }

  // ------------------------------------------------------------------ creatures
  renderCreatures() {
    const g = this.game, D = g.discovery;
    const species = g.plan.species;
    const known = species.filter((s) => D.species.has(s.id));
    if (this.selSpecies === null && known.length) this.selSpecies = known[0].id;
    const groups = LAYER_IDS.map((lid) => [lid, known.filter((s) => s.layer === lid)]).filter(([, l]) => l.length);
    const list = groups.map(([lid, l]) => `
      <div class="cat-group">${LAYERS.find((L) => L.id === lid)?.title || lid}</div>
      ${l.map((s) => {
        const e = D.species.get(s.id);
        const pct = Math.min(100, Math.round((e.observe / FULL_OBSERVATION) * 100));
        return `<button class="cat-item ${s.id === this.selSpecies ? 'active' : ''}" data-sp="${s.id}">
          <span class="fam fam-${s.family}">${FAMILY_LABEL[s.family][0]}</span>
          <span class="nm">${esc(s.name)}</span><span class="pct">${pct}%</span></button>`;
      }).join('')}`).join('');
    this.body.innerHTML = `
      <div class="catalog">
        <div class="cat-list">
          <div class="cat-count">${known.length} species recorded</div>
          ${list || '<div class="muted pad">No creatures recorded yet. Look at creatures to record them; hold <b>F</b> to observe them closely.</div>'}
        </div>
        <div class="cat-detail"></div>
      </div>`;
    this.body.querySelectorAll('[data-sp]').forEach((b) => { b.onclick = () => { this.selSpecies = Number(b.dataset.sp); this.renderCreatures(); }; });
    const sp = species.find((s) => s.id === this.selSpecies);
    if (sp && D.species.has(sp.id)) this.renderSpeciesDetail(sp, D.species.get(sp.id));
  }

  renderSpeciesDetail(sp, e) {
    const det = this.body.querySelector('.cat-detail');
    const has = (k) => e.facts.has(k);
    const b = sp.behavior, m = sp.morph;
    const lock = (k) => `<span class="locked">Observe longer to learn this (${Math.max(0, Math.ceil(FACT_TIMES[k] - e.observe))} s)</span>`;
    const pct = Math.min(100, Math.round((e.observe / FULL_OBSERVATION) * 100));
    const sizeText = e.maxSize ? `${e.minSize.toFixed(1)} – ${e.maxSize.toFixed(1)} m observed` : `${m.size.toFixed(1)} m`;
    const traits = [
      ['Speed', b.speed.run / 12], ['Perception', b.perception / 60], ['Strength', Math.min(1, b.strength / 6)], ['Aggression', b.aggression], ['Wariness', b.fearfulness],
    ].map(([k, v]) => `<div class="trait"><span>${k}</span><div class="bar"><i style="width:${Math.round(Math.min(1, v) * 100)}%"></i></div></div>`).join('');
    const social = { solitary: 'Solitary', pair: 'Lives in pairs', group: 'Small groups', herd: 'Herds', flock: 'Flocks', swarm: 'Swarms', colony: 'Colonies', pack: 'Hunts in packs', family: 'Family groups' }[b.social] || b.social;
    const act = { diurnal: 'Active by day', nocturnal: 'Active at night', crepuscular: 'Active at dawn and dusk', cathemeral: 'Active at all hours' }[b.activity];
    const inter = [...e.interactions.entries()].sort((a, c) => c[1].count - a[1].count);
    det.innerHTML = `
      <div class="det-head">
        <div><h2>${esc(sp.name)}</h2><div class="binomial">${esc(sp.binomial)}</div></div>
        <div class="det-tags"><span class="tag fam-${sp.family}">${FAMILY_LABEL[sp.family]}</span><span class="tag">${LAYERS.find((L) => L.id === sp.layer)?.title || ''}</span></div>
      </div>
      <div class="det-grid">
        <div class="preview-box"></div>
        <div class="det-facts">
          <div class="obs"><span>Observation</span><div class="bar"><i style="width:${pct}%"></i></div><b>${pct}%</b></div>
          <h4>Appearance</h4><p>${esc(describeAppearance(sp))}</p>
          <h4>Habitat</h4><p>${e.habitats.size ? `${[...e.habitats].map(esc).join('; ')}.` : 'Not yet seen in its own surroundings.'} First recorded at ${Math.round(e.firstDepth)} m depth.</p>
          <h4>Diet</h4><p>${has('diet') ? esc(DIET_TEXT[b.diet] || b.diet) : lock('diet')}</p>
          <h4>Behaviour</h4>
          <p>${has('locomotion') ? `It ${esc(LOCO_TEXT[b.locomotion] || b.locomotion)}. ` : ''}${has('activity') ? `${act}. ` : ''}${has('social') ? `${social}.` : ''}${!has('locomotion') ? lock('locomotion') : ''}</p>
          ${e.behaviours.size ? `<ul class="facts">${[...e.behaviours].map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        </div>
      </div>
      <div class="det-cols">
        <div>
          <h4>Traits</h4>
          ${has('traits') ? traits : lock('traits')}
          <div class="kv"><span>Size</span><b>${has('size') ? sizeText : '?'}</b></div>
          ${has('reproduction') ? `<div class="kv"><span>Offspring</span><b>${b.reproduction.litter > 1 ? `litters of up to ${b.reproduction.litter}` : 'one at a time'}${b.reproduction.care === 'none' ? ', left to fend for themselves' : ', cared for by a parent'}</b></div>` : ''}
          ${e.juveniles ? '<div class="kv"><span>Young</span><b>Juveniles observed</b></div>' : ''}
          ${e.call ? `<div class="kv"><span>Call</span><b>A ${esc(sp.call.type)}</b></div>` : ''}
        </div>
        <div>
          <h4>Observed interactions</h4>
          ${inter.length ? `<ul class="facts">${inter.map(([t, v]) => `<li>${esc(t)}${v.count > 1 ? ` <span class="muted">×${v.count}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">None witnessed yet. Watch how it lives alongside other creatures.</p>'}
        </div>
      </div>`;
    const pv = this.getPreview();
    if (pv) { pv.attach(det.querySelector('.preview-box')); pv.showSpecies(sp, this.game.ecosystem?.templates); }
  }

  // ------------------------------------------------------------------ artifacts
  renderArtifacts() {
    const g = this.game, A = g.artifacts, D = g.discovery;
    const items = A.list.filter((a) => A.collected.has(a.id));
    const spotted = A.list.filter((a) => D.spotted.has(a.id) && !A.collected.has(a.id));
    if (this.selArtifact === null && items.length) this.selArtifact = items[0].id;
    this.body.innerHTML = `
      <div class="catalog">
        <div class="cat-list">
          <div class="cat-count">${items.length} artifacts recovered</div>
          ${items.map((a) => `<button class="cat-item ${a.id === this.selArtifact ? 'active' : ''}" data-art="${a.id}"><span class="grade g${a.grade}">${['IV', 'III', 'II', 'I', '✶'][a.grade]}</span><span class="nm">${esc(a.name)}</span>${A.equipped.includes(a.id) ? '<span class="pct">worn</span>' : ''}</button>`).join('') || '<div class="muted pad">No artifacts recovered yet. They lie in ruins, caves, atop spires and in other hard-to-reach places. Press <b>E</b> to take one.</div>'}
          ${spotted.length ? `<div class="cat-group">Sighted, not taken</div>${spotted.map((a) => `<div class="cat-item ghost"><span class="grade">?</span><span class="nm">Unknown object — ${esc(a.site.place)}</span></div>`).join('')}` : ''}
        </div>
        <div class="cat-detail"></div>
      </div>`;
    this.body.querySelectorAll('[data-art]').forEach((b) => { b.onclick = () => { this.selArtifact = Number(b.dataset.art); this.renderArtifacts(); }; });
    const a = A.byId.get(this.selArtifact);
    if (a && A.collected.has(a.id)) this.renderArtifactDetail(a);
  }

  renderArtifactDetail(a) {
    const g = this.game, A = g.artifacts, D = g.discovery;
    const det = this.body.querySelector('.cat-detail');
    const idd = A.isIdentified(a.id);
    const prog = Math.min(100, Math.round(((A.identified.get(a.id) || 0) / 25) * 100));
    const found = D.found.get(a.id);
    const layer = LAYERS[a.site.layer];
    const props = idd
      ? `${a.effects.length ? `<ul class="facts">${a.effects.map((e) => `<li>${esc(describeEffect(e))}</li>`).join('')}</ul>` : '<p class="muted">No lasting effect on its bearer.</p>'}
         ${a.ability ? `<h4>Ability</h4><p>${esc(describeAbility(a.ability))}</p>` : ''}
         ${a.drawback ? `<h4>Drawback</h4><p>${esc(describeDrawback(a.drawback))}</p>` : ''}`
      : `<p class="locked">Unidentified. Carry it equipped to learn its properties (${prog}%).</p>`;
    det.innerHTML = `
      <div class="det-head">
        <div><h2>${esc(a.name)}</h2><div class="binomial">${esc(CATEGORY_LABEL[a.category])}</div></div>
        <div class="det-tags"><span class="tag grade g${a.grade}">${GRADES[a.grade]}</span></div>
      </div>
      <div class="det-grid">
        <div class="preview-box"></div>
        <div class="det-facts">
          <h4>Appearance</h4><p>${esc(a.appearance)} Weight ${a.weight} kg.</p>
          <h4>Known properties</h4>${props}
          <h4>Discovered</h4><p>${esc(a.site.context)} — ${esc(a.site.place)}, ${a.site.layer === 0 ? 'on the surface' : `${esc(layer.name)}`}${found ? `, at a depth of ${Math.round(Math.max(0, -found.y))} m` : ''}.</p>
          <h4>Notes</h4><p class="muted">${esc(a.origin)}</p>
          <div class="row">${A.equipped.includes(a.id) ? `<button class="btn" data-act="unequip">Unequip</button>` : `<button class="btn" data-act="equip" ${A.equipped.length >= SLOTS ? 'disabled' : ''}>Equip</button>`}</div>
        </div>
      </div>`;
    const eq = det.querySelector('[data-act=equip]'), un = det.querySelector('[data-act=unequip]');
    if (eq) eq.onclick = () => { A.equip(a.id); this.renderArtifacts(); };
    if (un) un.onclick = () => { A.unequip(a.id); this.renderArtifacts(); };
    const pv = this.getPreview();
    if (pv) { pv.attach(det.querySelector('.preview-box')); pv.showArtifact(a); }
  }

  // ------------------------------------------------------------------ equipment
  renderEquipment() {
    const g = this.game, A = g.artifacts;
    const slots = [];
    for (let i = 0; i < SLOTS; i++) slots.push(A.equipped[i] !== undefined ? A.byId.get(A.equipped[i]) : null);
    const carried = A.list.filter((a) => A.collected.has(a.id) && !A.equipped.includes(a.id));
    const abil = A.abilityItems();
    const mods = A.mods || {};
    const summary = [];
    if (mods.run > 1.001) summary.push(`Running +${Math.round((mods.run - 1) * 100)}%`);
    if (mods.jump > 1.001) summary.push(`Jumping +${Math.round((mods.jump - 1) * 100)}%`);
    if (mods.fall > 0) summary.push(`Fall damage −${Math.round(mods.fall * 100)}%`);
    if (mods.climb > 0) summary.push(`Climbing effort −${Math.round(mods.climb * 100)}%`);
    if (mods.reach) summary.push(`Arm range ${Math.round(60 + mods.reach)} m`);
    if (mods.winch) summary.push(`Reel speed +${Math.round(mods.winch * 100)}%`);
    if (mods.lantern) summary.push(`Glows in a ${Math.round(mods.lantern)} m radius`);
    if (mods.sense) summary.push(`Senses creatures within ${Math.round(mods.sense)} m`);
    if (mods.dowsing) summary.push(`Points to artifacts within ${Math.round(mods.dowsing)} m`);
    if (mods.scholar) summary.push(`Observation +${Math.round(mods.scholar * 100)}%`);
    if (mods.regen) summary.push(`Recovery +${mods.regen.toFixed(1)}/s`);
    if (mods.cartographer) summary.push(`Map reveal +${Math.round(mods.cartographer * 100)}%`);
    if (mods.swim > 1.001) summary.push(`Swimming +${Math.round((mods.swim - 1) * 100)}%`);
    if (mods.glide) summary.push('Glide (hold Space while falling)');
    if (mods.move < 0.999) summary.push(`Movement −${Math.round((1 - mods.move) * 100)}%`);
    const card = (a, i) => a ? `
      <div class="slot full"><div class="slot-n">Slot ${i + 1}</div><div class="slot-name">${esc(a.name)}</div>
      <div class="muted">${GRADES[a.grade]} · ${CATEGORY_LABEL[a.category]}${A.isIdentified(a.id) ? '' : ' · unidentified'}</div>
      <button class="btn small" data-un="${a.id}">Unequip</button></div>` : `<div class="slot"><div class="slot-n">Slot ${i + 1}</div><div class="muted">Empty</div></div>`;
    this.body.innerHTML = `
      <div class="equip">
        <div class="equip-left">
          <h3>Mechanical Grappling Arm</h3>
          <p class="muted">The arm you were given by the Guild. Range ${Math.round(g.grapple.range)} m. <b>Left click</b> fires the claw, <b>right click / Q / wheel</b> reels in, <b>Z / wheel</b> pays out, <b>X</b> or click again releases.</p>
          <h3>Worn artifacts</h3>
          <div class="slots">${slots.map(card).join('')}</div>
          <h3>Combined effects</h3>
          <p>${summary.length ? summary.map(esc).join(' · ') : '<span class="muted">No active effects.</span>'}</p>
          ${abil.length ? `<h3>Ability on R</h3><div class="row">${abil.map((a, i) => `<button class="btn small ${i === A.activeIndex % abil.length ? 'active' : ''}" data-ab="${i}">${esc(a.name)}</button>`).join('')}</div>` : ''}
        </div>
        <div class="equip-right">
          <h3>Carried</h3>
          ${carried.map((a) => `<div class="carry"><span class="grade g${a.grade}">${['IV', 'III', 'II', 'I', '✶'][a.grade]}</span><span class="nm">${esc(a.name)}</span><button class="btn small" data-eq="${a.id}" ${A.equipped.length >= SLOTS ? 'disabled' : ''}>Equip</button></div>`).join('') || '<p class="muted">Nothing else carried.</p>'}
        </div>
      </div>`;
    this.body.querySelectorAll('[data-un]').forEach((b) => { b.onclick = () => { A.unequip(Number(b.dataset.un)); this.renderEquipment(); }; });
    this.body.querySelectorAll('[data-eq]').forEach((b) => { b.onclick = () => { A.equip(Number(b.dataset.eq)); this.renderEquipment(); }; });
    this.body.querySelectorAll('[data-ab]').forEach((b) => { b.onclick = () => { A.activeIndex = Number(b.dataset.ab); this.renderEquipment(); }; });
  }

  // ------------------------------------------------------------------ log
  renderLog() {
    const g = this.game, D = g.discovery, A = g.artifacts, p = g.player;
    const lmTotal = D.landmarks.size;
    const stats = [
      ['Time in the field', fmtTime(g.gameTime)],
      ['Distance travelled', `${(p.distanceTravelled / 1000).toFixed(2)} km`],
      ['Deepest point', `${Math.round(p.deepest)} m`],
      ['Layers reached', [...D.layers].filter((l) => l > 0).sort().map((l) => LAYERS[l].title).join(', ') || 'none yet'],
      ['Species recorded', D.species.size],
      ['Interactions witnessed', D.stats.interactions],
      ['Artifacts recovered', A.collected.size],
      ['Places discovered', lmTotal],
      ['Routes walked', D.routes.size],
      ['World seed', esc(g.seedLabel)],
    ];
    const log = D.log.slice().reverse().slice(0, 150);
    this.body.innerHTML = `
      <div class="explog">
        <div class="stats">${stats.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join('')}</div>
        <div class="entries"><h3>Field notes</h3>${log.map((l) => `<div class="entry e-${l.kind}"><span class="t">${fmtTime(l.t)}</span>${esc(l.text)}</div>`).join('') || '<p class="muted">The journal is empty.</p>'}</div>
      </div>`;
  }
}

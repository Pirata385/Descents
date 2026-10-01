// Creature tests: species per layer, genuine morphological variety (not
// recolours), food webs, inheritance, and a headless ecosystem simulation
// that must produce interactions without the player's involvement.
import * as THREE from 'three';
import { test, assert, note } from './lib.js';
import { generateSpecies, individualGenes, inheritGenes, FAMILIES } from '../js/creatures/genetics.js';
import { buildSpeciesModel } from '../js/creatures/creatureMesh.js';
import { Ecosystem } from '../js/creatures/ecosystem.js';
import { World } from '../js/world/world.js';
import { NameGen } from '../js/world/names.js';
import { RNG } from '../js/core/rng.js';

function morphVector(sp) {
  const m = sp.morph;
  return [
    Math.log(m.size), m.bodyLen, m.bodyGirth * 2, m.legs.pairs / 2, m.legs.len, m.neckLen, m.headSize * 2, m.tail.len,
    m.wings.type === 'none' ? 0 : 1, m.horns.type === 'none' ? 0 : 1, m.eyes.count / 4, m.spines.count / 8, m.crest.type === 'none' ? 0 : 1, m.legs.biped ? 1 : 0,
  ];
}

function fakeGame(plan, pos) {
  const world = new World(plan);
  const camera = new THREE.PerspectiveCamera(75, 1.6, 0.1, 1000);
  camera.position.copy(pos).add(new THREE.Vector3(0, 1.6, 0));
  return {
    world, plan, camera, renderer: { scene: new THREE.Scene() }, gameTime: 0, timeOfDay: 10, lamp: { on: false, power: 0 },
    player: { pos: pos.clone(), vel: new THREE.Vector3(), mode: 'walk', hurt() { this.hurtCount = (this.hurtCount || 0) + 1; } },
  };
}

function simulate(game, eco, seconds, dt = 0.1) {
  const counts = {};
  eco.on((type) => { counts[type] = (counts[type] || 0) + 1; });
  for (let t = 0; t < seconds; t += dt) {
    game.gameTime += dt;
    game.timeOfDay = (game.timeOfDay + dt / 60) % 24;
    eco.update(dt);
  }
  return counts;
}

export async function creatureTests(seeds, plans) {
  await test('species exist per layer in all five families', () => {
    const famAll = new Set();
    for (const seed of seeds) {
      const sp = plans.get(seed).species;
      const by = {};
      for (const s of sp) { (by[s.layer] = by[s.layer] || []).push(s); famAll.add(s.family); }
      assert((by.surface || []).length >= 4, 'surface species');
      assert((by.layer1 || []).length >= 10, 'Layer 1 species');
      assert((by.layer2 || []).length >= 10, 'Layer 2 species');
      assert((by.layer3 || []).length >= 1, 'Layer 3 species');
      const fams = new Set(sp.map((s) => s.family));
      assert(fams.size >= 4, `world ${seed} has only ${[...fams].join(', ')}`);
    }
    for (const f of FAMILIES) assert(famAll.has(f), `family ${f} never generated`);
    note(`families across seeds: ${[...famAll].join(', ')}`);
  });

  await test('species differ in morphology and behaviour, not only colour', () => {
    let pairs = 0, close = 0;
    const meshSizes = new Set();
    for (const seed of seeds) {
      const sp = plans.get(seed).species;
      for (let i = 0; i < sp.length; i++) {
        for (let j = i + 1; j < sp.length; j++) {
          if (sp[i].family !== sp[j].family) continue;
          const a = morphVector(sp[i]), b = morphVector(sp[j]);
          const d = Math.sqrt(a.reduce((s, v, k) => s + (v - b[k]) ** 2, 0));
          pairs++;
          if (d < 0.25) close++;
          const behDiff = sp[i].behavior.diet !== sp[j].behavior.diet || sp[i].behavior.locomotion !== sp[j].behavior.locomotion || sp[i].behavior.social !== sp[j].behavior.social || sp[i].behavior.activity !== sp[j].behavior.activity;
          assert(d >= 0.1 || behDiff, `${sp[i].name} and ${sp[j].name} are near-identical`);
        }
      }
      if (seed === seeds[0]) for (const s of sp) meshSizes.add(buildSpeciesModel(s).geometry.attributes.position.count);
    }
    const sp0 = plans.get(seeds[0]).species;
    note(`${pairs} same-family pairs, ${close} morphologically close (they differ in behaviour) · ${meshSizes.size}/${sp0.length} distinct mesh topologies`);
    assert(close / pairs < 0.1, 'too many look-alike species');
    assert(meshSizes.size >= sp0.length * 0.6, 'species meshes are too similar');
  });

  await test('genomes: deterministic species, individual variation, inheritance', () => {
    const s0 = plans.get(seeds[0]).seed;
    const a = generateSpecies(s0, new NameGen(s0));
    const b = generateSpecies(s0, new NameGen(s0));
    assert(JSON.stringify(a.map((s) => [s.morph.size, s.behavior.diet])) === JSON.stringify(b.map((s) => [s.morph.size, s.behavior.diet])), 'species generation not deterministic');
    const sp = plans.get(seeds[0]).species[5];
    const rng = new RNG(99);
    const p1 = individualGenes(sp, rng), p2 = individualGenes(sp, rng);
    const kids = [0, 1, 2, 3].map(() => inheritGenes(sp, p1, p2, rng));
    for (const k of kids) {
      assert(k.size >= Math.min(p1.size, p2.size) - 0.15 && k.size <= Math.max(p1.size, p2.size) + 0.15, 'offspring size far from the parents');
    }
    assert(new Set(kids.map((k) => k.hue.toFixed(4))).size > 1, 'siblings are identical');
  });

  await test('food webs: predators, prey, competition and symbiosis', () => {
    let sym = 0;
    for (const seed of seeds) {
      const sp = plans.get(seed).species;
      for (const layer of ['layer1', 'layer2']) {
        const L = sp.filter((s) => s.layer === layer);
        assert(L.some((s) => s.relations.prey.length > 0), `${seed} ${layer}: no predators`);
        assert(L.some((s) => s.relations.competitors.length > 0), `${seed} ${layer}: no competition`);
        if (L.some((s) => s.relations.symbiontOf !== null)) sym++;
      }
      assert(sp.filter((s) => s.layer === 'layer3').every((s) => s.behavior.playerAware), 'Layer 3 creatures should be aware of the player');
      assert(sp.filter((s) => s.layer !== 'layer3').every((s) => !s.behavior.playerAware), 'Layers 1-2 creatures must ignore the player');
    }
    note(`symbiotic pairs in ${sym}/${seeds.length * 2} layer ecologies`);
    assert(sym >= 1, 'no symbiosis anywhere');
  });

  await test('ecosystem simulation runs on its own (Layer 1)', () => {
    const plan = plans.get(seeds[0]);
    const f = new World(plan).field;
    // a meadow in the Layer 1 bowl
    const th = plan.spiral.th0 + 0.4;
    const Re = f.tab(f.eyeTab, th), Rr = f.tab(f.rimTab, th);
    const [x, z] = f.fromPolar((Re + Rr) / 2, th);
    const w = new World(plan);
    const y = w.floorBelow(x, 200, z);
    const game = fakeGame(plan, new THREE.Vector3(x, y, z));
    const eco = new Ecosystem(game);
    game.ecosystem = eco;
    const counts = simulate(game, eco, 240);
    const species = new Set(eco.agents.map((a) => a.sp.id));
    const types = Object.keys(counts).filter((k) => k !== 'call');
    note(`${eco.agents.length} agents of ${species.size} species · events ${JSON.stringify(counts)} · births ${eco.stats.births}, deaths ${eco.stats.deaths}`);
    assert(eco.agents.length >= 15, 'too few creatures materialised');
    assert(species.size >= 4, 'too few species present');
    assert(types.length >= 4, `too few kinds of behaviour (${types.join(', ')})`);
    assert(!counts['attack-player'] && !counts['stalk-player'], 'Layer 1 creatures must ignore the explorer');
    assert(game.player.hurtCount === undefined, 'explorer was hurt in Layer 1');
  });

  await test('ecosystem: abstract populations keep evolving away from the player', () => {
    const plan = plans.get(seeds[0]);
    const game = fakeGame(plan, new THREE.Vector3(0, 0, 0));
    const eco = new Ecosystem(game);
    const regions = [];
    for (let i = -6; i < -2; i++) for (let j = 2; j < 6; j++) { const r = eco.getRegion(0, i, j); eco.initRegion(r); regions.push(r); }
    const before = regions.map((r) => Array.from(r.pops));
    for (let k = 0; k < 200; k++) eco.abstractTick(5);
    let changed = 0, bounded = true;
    regions.forEach((r, i) => { r.pops.forEach((v, s) => { if (Math.abs(v - before[i][s]) > 1e-3) changed++; if (v > r.K[s] * 1.5 + 1e-6 || v < 0) bounded = false; }); });
    note(`${changed} population values changed over ${200 * 5} s of abstract time`);
    assert(changed > 5, 'populations do not change');
    assert(bounded, 'populations exceed their carrying capacity bounds');
  });

  await test('ecosystem: the Layer 3 stalker hunts the explorer', () => {
    const plan = plans.get(seeds[0]);
    const t = plan.threshold;
    const game = fakeGame(plan, new THREE.Vector3(t.x, t.y, t.z));
    const eco = new Ecosystem(game);
    game.ecosystem = eco;
    const counts = simulate(game, eco, 90);
    const stalkers = eco.agents.filter((a) => a.sp.behavior.playerAware);
    note(`${stalkers.length} stalkers near the Threshold · events ${JSON.stringify(counts)}`);
    assert(stalkers.length >= 1, 'no Layer 3 predator near the Threshold');
    assert(counts['stalk-player'] >= 1, 'the predator never stalked the explorer');
  });
}

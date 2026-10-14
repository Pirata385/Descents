// Creature tests: species per layer (Layer 3 only cave and chasm fauna),
// anatomical variation between individuals of one species, differences
// between species, inheritance and subspecies, food webs, and headless
// ecosystem simulations in Layer 1, the Layer 3 caves and the chasm.
import * as THREE from 'three';
import { test, assert, note } from './lib.js';
import { generateSpecies, individualGenes, inheritGenes, FAMILIES, G, GENES } from '../js/creatures/genome.js';
import { phenotype, typicalPhenotype } from '../js/creatures/anatomy.js';
import { buildCreature } from '../js/creatures/bodyMesh.js';
import { Animator } from '../js/creatures/motion.js';
import { Ecosystem } from '../js/creatures/ecosystem.js';
import { BAND } from '../js/creatures/habitat.js';
import { World } from '../js/world/world.js';
import { NameGen } from '../js/world/names.js';
import { RNG } from '../js/core/rng.js';
import { CF } from '../js/world/column.js';

/** Anatomy of a phenotype as numbers (proportions and ornaments, not colour). */
function anatomy(ph) {
  return [
    ph.body.girth * 4, ph.body.height * 4, ph.neck.len, ph.head.size * 3, ph.head.snout, ph.legs.len, ph.legs.thick * 10, ph.tail.len,
    ph.horns.type === 'none' ? 0 : ph.horns.len * 2, ph.crest.type === 'none' ? 0 : ph.crest.size * 2, ph.ears.size, ph.wings.type === 'none' ? 0 : ph.wings.span / 3,
    ph.spikes.rows * ph.spikes.len * 3, ph.eyes.size * 4,
  ];
}
const dist = (a, b) => Math.sqrt(a.reduce((s, v, k) => s + (v - b[k]) ** 2, 0));

function fakeGame(plan, pos, hour = 10) {
  const world = new World(plan);
  const camera = new THREE.PerspectiveCamera(75, 1.6, 0.1, 1000);
  camera.position.copy(pos).add(new THREE.Vector3(0, 1.6, 0));
  return {
    world, plan, camera, renderer: { scene: new THREE.Scene() }, gameTime: 0, timeOfDay: hour, settings: {},
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
  await test('species per layer; Layer 3 holds only cave and chasm fauna', () => {
    const famAll = new Set();
    for (const seed of seeds) {
      const sp = plans.get(seed).species;
      const by = {};
      for (const s of sp) { (by[s.layer] = by[s.layer] || []).push(s); famAll.add(s.family); }
      assert((by.surface || []).length >= 4, 'surface species');
      assert((by.layer1 || []).length >= 10, 'Layer 1 species');
      assert((by.layer2 || []).length >= 10, 'Layer 2 species');
      const L3 = by.layer3 || [];
      assert(L3.length >= 8, `Layer 3 needs a full fauna (${L3.length})`);
      for (const s of L3) {
        assert(s.niche.startsWith('cave_') || s.niche.startsWith('chasm_'), `${s.name} is neither cave nor chasm fauna`);
        if (s.behavior.habitat === 'cave') assert((s.family === 'reptile' || s.family === 'mammal') && s.size < 1, `cave species ${s.name} must be a small lizard or mammal`);
        else assert(s.family === 'bird' || s.family === 'reptile' || (s.family === 'mammal' && s.plan === 'bat'), `chasm species ${s.name} must be a bird, lizard or flying mammal`);
      }
      assert(L3.some((s) => s.plan === 'bat'), 'the chasm needs flying mammals');
      assert(L3.some((s) => s.family === 'bird'), 'the chasm needs birds');
      assert(L3.some((s) => s.behavior.habitat === 'wall'), 'the chasm needs wall-climbing lizards');
      assert(L3.filter((s) => s.behavior.habitat === 'cave').length >= 3, 'the caves need several species');
    }
    for (const f of FAMILIES) assert(famAll.has(f), `family ${f} never generated`);
    note(`families across seeds: ${[...famAll].join(', ')}`);
  });

  await test('individuals of one species differ in anatomy, not only colour', () => {
    const sp = plans.get(seeds[0]).species;
    let varied = 0, alleleVaried = 0;
    const rows = [];
    for (const s of sp) {
      const rng = new RNG(s.id * 7 + 3);
      const phs = [];
      for (let k = 0; k < 16; k++) phs.push(phenotype(s, individualGenes(s, rng, k % s.subspecies.length)));
      const vs = phs.map(anatomy);
      let sum = 0, n = 0;
      for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) { sum += dist(vs[i], vs[j]); n++; }
      const mean = sum / n;
      if (mean > 0.08) varied++;
      const combos = new Set(phs.map((p) => `${p.crest.type}/${p.tail.tip}/${p.pattern.type}/${p.horns.type}/${p.ears.shape}/${p.spikes.rows}/${p.cheek}`));
      if (combos.size >= 3) alleleVaried++;
      rows.push(`${s.name}: ${mean.toFixed(2)}/${combos.size}`);
    }
    note(`${varied}/${sp.length} species vary in proportions, ${alleleVaried}/${sp.length} in ornaments (16 individuals each)`);
    assert(varied / sp.length > 0.9, `too little anatomical variation: ${rows.join('; ')}`);
    assert(alleleVaried / sp.length > 0.8, 'individuals share the same ornaments');
    // meshes differ between individuals of one species
    const s = sp.find((x) => x.layer === 'layer3' && x.niche === 'chasm_drake') || sp[0];
    const rng = new RNG(5);
    const counts = new Set();
    for (let k = 0; k < 8; k++) counts.add(buildCreature(phenotype(s, individualGenes(s, rng)), k).vertices);
    assert(counts.size >= 3, 'individual bodies share one mesh');
  });

  await test('species differ from each other in body plan, build and behaviour', () => {
    let pairs = 0, close = 0;
    for (const seed of seeds) {
      const sp = plans.get(seed).species;
      const typ = sp.map((s) => anatomy(typicalPhenotype(s)));
      for (let i = 0; i < sp.length; i++) for (let j = i + 1; j < sp.length; j++) {
        if (sp[i].family !== sp[j].family) continue;
        pairs++;
        const d = dist(typ[i], typ[j]);
        const behDiff = sp[i].behavior.diet !== sp[j].behavior.diet || sp[i].behavior.locomotion !== sp[j].behavior.locomotion || sp[i].behavior.habitat !== sp[j].behavior.habitat || sp[i].plan !== sp[j].plan;
        if (d < 0.2) close++;
        assert(d >= 0.12 || behDiff, `${sp[i].name} and ${sp[j].name} are near-identical`);
      }
    }
    note(`${pairs} same-family pairs, ${close} close in build (they differ in plan or behaviour)`);
  });

  await test('genomes: deterministic species, inheritance from both parents, subspecies', () => {
    const s0 = plans.get(seeds[0]).seed;
    const a = generateSpecies(s0, new NameGen(s0)), b = generateSpecies(s0, new NameGen(s0));
    assert(JSON.stringify(a.map((s) => [s.size, s.genome.mean[3], s.name])) === JSON.stringify(b.map((s) => [s.size, s.genome.mean[3], s.name])), 'species generation not deterministic');
    const sp = plans.get(seeds[0]).species.find((s) => s.layer === 'layer3');
    const rng = new RNG(99);
    const p1 = individualGenes(sp, rng), p2 = individualGenes(sp, rng);
    const kids = [0, 1, 2, 3, 4, 5].map(() => inheritGenes(sp, p1, p2, rng));
    let outside = 0;
    for (const k of kids) for (let i = 0; i < GENES.length; i++) {
      if (i === G.hue || i === G.hue2 || i === G.accentHue) continue;
      const lo = Math.min(p1.c[i], p2.c[i]) - 0.25, hi = Math.max(p1.c[i], p2.c[i]) + 0.25;
      if (k.c[i] < lo || k.c[i] > hi) outside++;
    }
    assert(outside < kids.length * GENES.length * 0.05, `offspring genes stray far from both parents (${outside})`);
    assert(new Set(kids.map((k) => k.c[G.bodyLen].toFixed(4))).size > 3, 'siblings are identical');
    // each allele of a child comes from a parent (or is a rare mutation)
    let fromParent = 0, total = 0;
    for (const k of kids) for (const key of Object.keys(k.a)) { total++; if (k.a[key] === p1.a[key] || k.a[key] === p2.a[key]) fromParent++; }
    assert(fromParent / total > 0.85, 'alleles are not inherited');
    // subspecies are distinct forms
    let subs = 0;
    for (const s of plans.get(seeds[0]).species) {
      if (s.subspecies.length < 2) continue;
      const d = dist(s.subspecies[0].offset, s.subspecies[1].offset);
      assert(d > 0.2, `${s.name}: subspecies are indistinguishable`);
      subs += s.subspecies.length;
    }
    note(`${subs} regional forms across ${plans.get(seeds[0]).species.length} species`);
  });

  await test('food webs: predators, prey, competition, mobbing and symbiosis', () => {
    let sym = 0;
    for (const seed of seeds) {
      const sp = plans.get(seed).species;
      for (const layer of ['layer1', 'layer2', 'layer3']) {
        const L = sp.filter((s) => s.layer === layer);
        assert(L.some((s) => s.relations.prey.length > 0), `${seed} ${layer}: no predators`);
        assert(L.some((s) => s.relations.competitors.length > 0), `${seed} ${layer}: no competition`);
        if (L.some((s) => s.relations.symbiontOf !== null)) sym++;
      }
      const L3 = sp.filter((s) => s.layer === 'layer3');
      for (const s of L3) for (const p of s.relations.prey) {
        const q = sp[p];
        assert((s.behavior.habitat === 'cave') === (q.behavior.habitat === 'cave'), `${s.name} hunts across the cave/chasm divide`);
      }
      assert(L3.some((s) => s.relations.mobs.length), `${seed}: no chasm flier mobs its predators`);
      assert(sp.filter((s) => s.layer === 'layer3').every((s) => !s.behavior.playerAware), 'Layer 3 fauna is small and must not hunt the explorer');
      assert(sp.filter((s) => s.layerIndex < 3).every((s) => !s.behavior.playerAware), 'creatures of the upper layers ignore explorers');
    }
    note(`symbiotic pairs in ${sym}/${seeds.length * 3} layer ecologies`);
    assert(sym >= 1, 'no symbiosis anywhere');
  });

  await test('animation: gaits, flight and rest poses keep the skeleton finite', () => {
    const sp = plans.get(seeds[0]).species;
    let checked = 0;
    for (const s of sp) {
      const ph = phenotype(s, individualGenes(s, new RNG(s.id)));
      const cr = buildCreature(ph, s.id);
      const an = new Animator(cr, ph, s, s.id);
      for (const st of [{ speed: ph.stats.walk, mode: 'ground' }, { speed: ph.stats.run, mode: 'ground' }, { speed: 6, mode: 'fly' }, { speed: 0, mode: 'sleep', action: 'idle' }, { speed: 0, mode: 'ground', action: 'eat' }]) {
        for (let k = 0; k < 10; k++) an.update(0.05, st);
        for (const b of cr.rig.bones) assert(Number.isFinite(b.quaternion.x + b.quaternion.y + b.quaternion.z + b.quaternion.w + b.position.x + b.position.y), `${s.name}: pose became invalid in ${st.mode}`);
      }
      checked++;
    }
    note(`${checked} species animated through walk, run, flight, sleep and feeding`);
  });

  await test('ecosystem simulation runs on its own (Layer 1)', () => {
    const plan = plans.get(seeds[0]);
    const w = new World(plan);
    const f = w.field;
    const th = plan.spiral.th0 + 0.4;
    const Re = f.tab(f.eyeTab, th), Rr = f.tab(f.rimTab, th);
    const [x, z] = f.fromPolar((Re + Rr) / 2, th);
    const y = w.floorBelow(x, 200, z);
    const game = fakeGame(plan, new THREE.Vector3(x, y, z));
    const eco = new Ecosystem(game);
    game.ecosystem = eco;
    const counts = simulate(game, eco, 240);
    const live = eco.agents.filter((a) => !a.dead);
    const species = new Set(live.map((a) => a.sp.id));
    const types = Object.keys(counts).filter((k) => k !== 'call');
    note(`${live.length} agents of ${species.size} species · events ${JSON.stringify(counts)} · births ${eco.stats.births}, deaths ${eco.stats.deaths}`);
    assert(live.length >= 15, 'too few creatures materialised');
    assert(species.size >= 4, 'too few species present');
    assert(types.length >= 4, `too few kinds of behaviour (${types.join(', ')})`);
    assert(!counts['attack-player'], 'Layer 1 creatures must not attack the explorer here');
    for (const a of live) assert(Number.isFinite(a.pos.x + a.pos.y + a.pos.z), 'a creature position became invalid');
  });

  await test('creatures keep appearing around a travelling explorer and leave when it moves on', () => {
    const plan = plans.get(seeds[0]);
    const route = [];
    for (const n of ["Delvers' Road", 'The Great Spiral']) {
      const r = plan.routes.find((x) => x.name === n);
      if (r) for (let i = 0; i < r.pts.length; i += 3) route.push(new THREE.Vector3(r.pts[i], r.pts[i + 1], r.pts[i + 2]));
    }
    assert(route.length > 10, 'routes to walk');
    const game = fakeGame(plan, route[0].clone());
    game.renderer.fogEdge = 12 * 32;
    const eco = new Ecosystem(game);
    game.ecosystem = eco;
    const P = game.player.pos;
    let i = 0, t = 0, checks = 0, populated = 0, far = 0;
    const layersSeen = new Set();
    while (i < route.length - 1 && t < 900) {
      let step = 6 * 0.1;
      while (step > 0 && i < route.length - 1) {
        const d = P.distanceTo(route[i + 1]);
        if (d <= step) { P.copy(route[i + 1]); i++; step -= d; } else { P.addScaledVector(route[i + 1].clone().sub(P).normalize(), step); step = 0; }
      }
      game.camera.position.copy(P).y += 1.6;
      game.gameTime += 0.1; t += 0.1;
      eco.update(0.1);
      if (t > 20 && Math.round(t * 10) % 150 === 0) {
        const live = eco.agents.filter((a) => !a.dead);
        const near = live.filter((a) => a.pos.distanceTo(P) < 130);
        checks++;
        if (near.length >= 8) populated++;
        for (const a of near) layersSeen.add(a.sp.layer);
        far += live.filter((a) => a.pos.distanceTo(P) > eco.areaRadius() + 120).length;
      }
    }
    note(`${checks} checks along ${Math.round(t)} s of walking: ${populated} with 8+ creatures nearby · spawned ${eco.stats.spawned}, folded back ${eco.stats.despawned} · layers ${[...layersSeen].join(', ')}`);
    assert(populated >= checks * 0.85, `creatures thinned out while travelling (${populated}/${checks})`);
    assert(eco.stats.despawned > 20, 'creatures left behind were not folded back into the population');
    assert(far === 0, `${far} creatures lingered far outside the explorer's area`);
    assert(layersSeen.has('layer1') && layersSeen.has('layer2'), 'the fauna should change from Layer 1 to Layer 2 on the way down');
  });

  await test('ecosystem: abstract populations keep evolving away from the explorer', () => {
    const plan = plans.get(seeds[0]);
    const game = fakeGame(plan, new THREE.Vector3(0, 0, 0));
    const eco = new Ecosystem(game);
    const regions = [];
    const f = game.world.field;
    for (let k = 0; k < 12; k++) {
      const th = (k / 12) * Math.PI * 2;
      const [x, z] = f.fromPolar((f.tab(f.eyeTab, th) + f.tab(f.rimTab, th)) / 2, th);
      const y = game.world.floorBelow(x, 200, z);
      regions.push(eco.region(eco.regionKey(BAND.SURF, x, y, z), x, y, z, BAND.SURF));
    }
    const before = regions.map((r) => Array.from(r.pops));
    for (let k = 0; k < 200; k++) eco.abstractTick(5);
    let changed = 0, bounded = true;
    regions.forEach((r, i) => { r.pops.forEach((v, s) => { if (Math.abs(v - before[i][s]) > 1e-3) changed++; if (v > r.K[s] * 1.5 + 1e-6 || v < 0) bounded = false; }); });
    note(`${changed} population values changed over ${200 * 5} s of abstract time`);
    assert(changed > 5, 'populations do not change');
    assert(bounded, 'populations exceed their carrying capacity bounds');
  });

  await test('Layer 3 caves: small lizards and mammals live in the cave network', () => {
    const plan = plans.get(seeds[0]);
    const hall = plan.fault.halls[Math.min(4, plan.fault.halls.length - 1)];
    const game = fakeGame(plan, new THREE.Vector3(hall.x, hall.y, hall.z), 12);
    const eco = new Ecosystem(game);
    game.ecosystem = eco;
    const counts = simulate(game, eco, 90);
    const live = eco.agents.filter((a) => !a.dead && a.sp.behavior.habitat === 'cave');
    let inCave = 0;
    for (const a of live) {
      const fl = game.world.flagsAt(a.pos.x, a.pos.z);
      const ceil = game.world.ceilingAbove(a.pos.x, a.pos.y + 0.3, a.pos.z);
      if ((fl & CF.CAVE) || ceil - a.pos.y < 30) inCave++;
    }
    note(`${live.length} cave creatures of ${new Set(live.map((a) => a.sp.id)).size} species near ${hall.name} · ${inCave} under rock · events ${JSON.stringify(counts)}`);
    assert(live.length >= 4, 'too few cave creatures');
    assert(inCave / live.length > 0.85, 'cave creatures wander out of the caves');
    assert(eco.agents.every((a) => a.sp.layer === 'layer3' || a.dead), 'only Layer 3 fauna lives here');
  });

  await test('Layer 3 chasm: birds, bats and wall lizards fly, climb and roost in the void', () => {
    const plan = plans.get(seeds[0]);
    const w = plan.fault.windows[Math.min(1, plan.fault.windows.length - 1)] || plan.fault.halls[2];
    const game = fakeGame(plan, new THREE.Vector3(w.x, w.y, w.z), 21);
    const eco = new Ecosystem(game);
    game.ecosystem = eco;
    const counts = simulate(game, eco, 120);
    const live = eco.agents.filter((a) => !a.dead && a.sp.behavior.habitat !== 'cave');
    const ch = game.world.gen.chasm;
    const air = live.filter((a) => a.mode === 'air');
    const wall = live.filter((a) => a.mode === 'wall');
    const home = live.filter((a) => a.mode === 'hang' || a.mode === 'perch' || (a.home && a.pos.distanceTo(a.home.pos) < 2));
    const outside = air.filter((a) => ch.clearance(a.pos.x, a.pos.y, a.pos.z) > 1).length;
    note(`${live.length} chasm creatures: ${air.length} flying, ${wall.length} on the walls, ${home.length} at roosts and nests · events ${JSON.stringify(counts)}`);
    assert(live.length >= 6, 'too few chasm creatures');
    assert(air.length >= 2, 'nothing flies in the chasm');
    assert(outside <= Math.max(1, air.length * 0.1), `${outside} fliers flew into the rock`);
    assert(wall.length + home.length >= 1, 'nothing climbs the walls or rests at a roost or nest');
  });

  await test('Layer 3 nests: parents drive an explorer away from their eggs', () => {
    const plan = plans.get(seeds[0]);
    const w = plan.fault.windows[0];
    const pos = new THREE.Vector3(w.x, w.y, w.z);
    const game = fakeGame(plan, pos, 12);
    const eco = new Ecosystem(game);
    game.ecosystem = eco;
    simulate(game, eco, 5);
    const S = eco.sp.find((x) => x.s.niche === 'chasm_hawk') || eco.sp.find((x) => x.s.layerIndex >= 3 && x.s.behavior.nest && x.s.behavior.nest !== 'roost');
    const rng = new RNG(9);
    const nest = pos.clone().add(new THREE.Vector3(3, 0.5, 2));
    const f = eco.spawn(S, { x: nest.x, y: nest.y, z: nest.z, mode: 'rest' }, { ...individualGenes(S.s, rng), sex: 'f' }, { age: S.s.behavior.reproduction.maturity * 2 });
    f.home = { pos: nest.clone(), kind: 'nest' };
    f.nestEggs = 2; f.eggT = 200;
    const seen = {};
    eco.on((t) => { seen[t] = (seen[t] || 0) + 1; });
    let guarded = 0;
    for (let t = 0; t < 12; t += 0.1) { game.gameTime += 0.1; eco.update(0.1); if (f.state === 'guard') guarded++; }
    // the explorer backs off: the parent calms down
    game.player.pos.add(new THREE.Vector3(60, 0, 0));
    for (let t = 0; t < 10; t += 0.1) { game.gameTime += 0.1; eco.update(0.1); }
    note(`${S.s.name}: guarded ${(guarded / 10).toFixed(1)} s, strikes ${seen['guard-strike'] || 0}, explorer hurt ${game.player.hurtCount || 0}× · after leaving: ${f.state}`);
    assert(guarded > 10 && seen.guard, 'the parent did not defend its nest');
    assert(f.state !== 'guard', 'the parent kept guarding after the explorer left');
    assert(Number.isFinite(f.pos.x + f.pos.y + f.pos.z), 'the guardian position became invalid');
  });

  await test('breeding: offspring inherit from both parents and join the population', () => {
    const plan = plans.get(seeds[0]);
    const hall = plan.fault.halls[2];
    const game = fakeGame(plan, new THREE.Vector3(hall.x, hall.y, hall.z), 12);
    const eco = new Ecosystem(game);
    game.ecosystem = eco;
    simulate(game, eco, 20);
    const S = eco.sp.find((x) => x.s.niche === 'cave_shrew') || eco.sp.find((x) => x.s.layer === 'layer3' && x.s.behavior.habitat === 'cave');
    const rng = new RNG(4);
    const f = eco.spawn(S, { x: hall.x, y: hall.y, z: hall.z, mode: 'cave' }, { ...individualGenes(S.s, rng), sex: 'f' }, { age: S.s.behavior.reproduction.maturity * 2 });
    const m = eco.spawn(S, { x: hall.x + 1, y: hall.y, z: hall.z, mode: 'cave' }, { ...individualGenes(S.s, rng), sex: 'm' }, { age: S.s.behavior.reproduction.maturity * 2 });
    const n0 = eco.agents.length;
    let births = 0;
    eco.on((t) => { if (t === 'birth') births++; });
    eco.mate(f, m);
    const young = eco.agents.slice(n0).filter((a) => a.parent === f);
    note(`${births} births from one pairing · young: ${young.map((y) => y.genes.c[G.bodyLen].toFixed(2)).join(', ')} · parents ${f.genes.c[G.bodyLen].toFixed(2)} / ${m.genes.c[G.bodyLen].toFixed(2)}`);
    assert(births >= 1 && young.length >= 1, 'no offspring');
    assert(young.every((y) => y.juvenile), 'newborns must be juveniles');
  });
}

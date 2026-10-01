// Persistence tests: exploration rasters, discovery records and artifact
// state survive a serialize → JSON → restore round trip unchanged.
import * as THREE from 'three';
import { test, assert, note } from './lib.js';
import { World } from '../js/world/world.js';
import { MapData, F_EXPLORED } from '../js/systems/mapdata.js';
import { Discovery } from '../js/systems/discovery.js';
import { ArtifactSystem } from '../js/artifacts/artifacts.js';

function baseGame(plan) {
  const world = new World(plan);
  const s = plan.spawn;
  return {
    plan, world, gameTime: 123, layerInfo: { layer: 1, zone: 1 }, renderer: { scene: new THREE.Scene() },
    camera: new THREE.PerspectiveCamera(), player: { pos: new THREE.Vector3(s.x, s.y, s.z), mods: {} }, grapple: { rangeBonus: 0, reelMul: 1 },
  };
}

export async function saveTests(seeds, plans) {
  const plan = plans.get(seeds[0]);

  await test('map exploration survives a save round trip', () => {
    const g = baseGame(plan);
    const md = new MapData(g);
    const s = plan.spawn;
    md.reveal(s.x, s.y, s.z, 60);
    md.reveal(0, -500, 300, 40, 1);
    while (md.queue.length) { const it = md.queue.shift(); md.sampleCell(it[1], it[2], it[3]); }
    for (let i = 0; i < 50; i++) md.trail.push(s.x + i, s.y, s.z - i);
    const json = JSON.stringify(md.serialize());
    const md2 = new MapData(g);
    md2.restore(JSON.parse(json));
    for (let b = 0; b < md.bands.length; b++) {
      const A = md.bands[b], B = md2.bands[b];
      assert(A.count === B.count, `band ${b} explored count differs (${A.count} vs ${B.count})`);
      for (let k = 0; k < A.flags.length; k++) {
        if (!(A.flags[k] & F_EXPLORED)) { assert(!(B.flags[k] & F_EXPLORED), 'unexplored cell restored as explored'); continue; }
        assert(A.h[k] === B.h[k] && A.mat[k] === B.mat[k] && A.flags[k] === B.flags[k], `cell ${k} differs after restore`);
      }
    }
    assert(md2.trail.length === md.trail.length, 'trail lost');
    note(`${md.bands[0].count + md.bands[1].count} explored cells → ${(json.length / 1024).toFixed(1)} KB`);
  });

  await test('discoveries and artifacts survive a save round trip', () => {
    const g = baseGame(plan);
    const D = new Discovery(g);
    const sp = plan.species.slice(4, 9);
    for (const s of sp) {
      const e = D.entry(s);
      e.observe = 12; e.facts.add('diet'); e.habitats.add('a test meadow'); e.behaviours.add('Grazes on grass');
    }
    D.witness(sp[0], 'Hunts the test prey', sp[1], 'Hunted by the test predator');
    D.landmarks.add(plan.landmarks[0].id); D.layers.add(1); D.routes.add(plan.journeys[0]);
    const A = new ArtifactSystem(g);
    const a0 = plan.artifacts[0], a1 = plan.artifacts[1];
    A.collected.add(a0.id); A.collected.add(a1.id); A.equipped = [a0.id]; A.identified.set(a0.id, 30); A.recompute();
    const json = JSON.stringify({ d: D.serialize(), a: A.serialize() });
    const s = JSON.parse(json);
    const D2 = new Discovery(g);
    D2.restore(s.d);
    const A2 = new ArtifactSystem(g);
    A2.restore(s.a);
    assert(D2.species.size === sp.length, 'species entries lost');
    const e = D2.species.get(sp[0].id);
    assert(e.facts.has('diet') && e.habitats.has('a test meadow') && e.interactions.has('Hunts the test prey'), 'species facts lost');
    assert(D2.species.get(sp[1].id).interactions.has('Hunted by the test predator'), 'interaction lost on the prey');
    assert(D2.landmarks.has(plan.landmarks[0].id) && D2.layers.has(1) && D2.routes.has(plan.journeys[0]), 'places lost');
    assert(A2.collected.has(a0.id) && A2.collected.has(a1.id) && A2.equipped[0] === a0.id && A2.isIdentified(a0.id), 'artifact state lost');
    note(`save fragment ${(json.length / 1024).toFixed(1)} KB`);
  });
}

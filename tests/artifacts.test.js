// Artifact tests: contextual deterministic placement, variety, and the
// mapping of effects onto the explorer.
import * as THREE from 'three';
import { test, assert, note } from './lib.js';
import { ColumnGen, ColumnData } from '../js/world/column.js';
import { LAYERS } from '../js/world/layers.js';
import { ArtifactSystem } from '../js/artifacts/artifacts.js';
import { buildArtifactModel } from '../js/artifacts/artifactMesh.js';

export async function artifactTests(seeds, plans) {
  for (const seed of seeds) {
    const plan = plans.get(seed);
    await test(`[${seed}] artifacts are placed in context and reachable`, () => {
      const arts = plan.artifacts;
      const gen = new ColumnGen(plan);
      const col = new ColumnData();
      const byLayer = {};
      for (const a of arts) (byLayer[a.site.layer] = byLayer[a.site.layer] || []).push(a);
      for (const li of [1, 2]) assert((byLayer[li] || []).length >= Math.min(LAYERS[li].artifacts.count, 6), `Layer ${li} has too few artifacts`);
      let floating = 0;
      for (const a of arts) {
        assert(a.site.context && a.site.place, 'artifact without a discovery context');
        gen.column(a.site.x, a.site.z, 0, col);
        const f = col.floorBelow(a.site.y + 1.5);
        if (f < 0 || Math.abs(col.y1[f] - a.site.y) > 2) floating++;
      }
      const cats = new Set(arts.map((a) => a.category));
      const grades = new Set(arts.map((a) => a.grade));
      const kinds = new Set(arts.map((a) => a.site.kind));
      const names = new Set(arts.map((a) => a.name));
      note(`${arts.length} artifacts · ${cats.size} categories · grades ${[...grades].sort().join('')} · sites ${[...kinds].join(', ')}`);
      assert(floating <= Math.ceil(arts.length * 0.05), `${floating} artifacts are not resting on a surface`);
      assert(cats.size >= 5, 'artifact categories lack variety');
      assert(grades.size >= 2, 'artifact rarities lack variety');
      assert(kinds.size >= 3, 'artifacts should come from several kinds of places');
      assert(names.size >= arts.length * 0.9, 'artifact names repeat too much');
    });
  }

  await test('artifact models are generated from their shape parameters', () => {
    const arts = plans.get(seeds[0]).artifacts;
    const sizes = new Set();
    for (const a of arts.slice(0, 20)) {
      const m = buildArtifactModel(a);
      let verts = 0;
      m.traverse((o) => { if (o.geometry) verts += o.geometry.attributes.position.count; });
      assert(verts > 20, `${a.name} has no geometry`);
      sizes.add(verts);
    }
    assert(sizes.size >= 8, 'artifact models look alike');
  });

  await test('equipped artifacts change the explorer and the grappling arm', () => {
    const plan = plans.get(seeds[0]);
    const game = { plan, renderer: { scene: new THREE.Scene() }, player: { mods: {}, pos: new THREE.Vector3() }, grapple: { rangeBonus: 0, reelMul: 1 } };
    const sys = new ArtifactSystem(game);
    const pick = (type) => plan.artifacts.find((a) => a.effects.some((e) => e.type === type));
    let tested = 0;
    for (const [type, check] of [
      ['stride', () => game.player.mods.run > 1], ['spring', () => game.player.mods.jump > 1], ['feather', () => game.player.mods.fall > 0],
      ['grip', () => game.player.mods.climb > 0], ['reach', () => game.grapple.rangeBonus > 0], ['winch', () => game.grapple.reelMul > 1],
    ]) {
      const a = pick(type);
      if (!a) continue;
      sys.collected.add(a.id);
      sys.equipped = [a.id];
      sys.recompute();
      assert(check(), `${type} effect of ${a.name} not applied`);
      tested++;
    }
    note(`${tested} effect types verified`);
    assert(tested >= 2, 'not enough effect types to test');
    sys.equipped = [];
    sys.recompute();
    assert(game.player.mods.run === 1 && game.grapple.rangeBonus === 0, 'unequipping did not restore the explorer');
  });
}

// Artifact tests: contextual deterministic placement, variety, and the
// mapping of effects onto the explorer.
import * as THREE from 'three';
import { test, assert, note } from './lib.js';
import { ColumnGen, ColumnData } from '../js/world/column.js';
import { LAYERS } from '../js/world/layers.js';
import { ArtifactSystem } from '../js/artifacts/artifacts.js';
import { buildArtifactModel } from '../js/artifacts/artifactMesh.js';
import { WEAPONS, ABILITIES, ELEMENTS, describeWeapon } from '../js/artifacts/artifactGen.js';

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

  await test('weapons, combat abilities and the combat effects vary and reach the explorer', () => {
    const all = seeds.flatMap((s) => plans.get(s).artifacts);
    const weapons = all.filter((a) => a.weapon);
    const types = new Set(weapons.map((a) => a.weapon.type));
    const elements = new Set(weapons.map((a) => a.weapon.element).filter(Boolean));
    const abil = new Set(all.filter((a) => a.ability).map((a) => a.ability.type));
    const combat = [...abil].filter((k) => ABILITIES[k].kind);
    const arche = new Set(all.map((a) => a.archetype));
    for (const a of weapons) {
      assert(WEAPONS[a.weapon.type], `unknown weapon ${a.weapon.type}`);
      assert(a.weapon.power >= 1 && a.weapon.power < 3, `weapon power out of range (${a.weapon.power})`);
      assert(!a.weapon.element || ELEMENTS[a.weapon.element], 'unknown element');
      assert(describeWeapon(a.weapon).length > 10, 'weapon without a description');
    }
    note(`${weapons.length} weapons of ${types.size} kinds (${[...types].join(', ')}) · elements ${[...elements].join(', ')} · ${combat.length} combat abilities (${combat.join(', ')}) · ${arche.size} shapes`);
    assert(types.size >= 5, 'too few kinds of weapon');
    assert(combat.length >= 5, 'too few combat abilities');
    assert(arche.size >= 40, 'too few artifact shapes');
    // the warden's reward
    for (const seed of seeds) {
      const t = plans.get(seed).artifacts.find((a) => a.site.kind === 'throne');
      assert(t && t.weapon && t.weapon.type === 'gamma' && t.grade === 4 && t.ability && t.ability.type === 'gamma', `[${seed}] the Throne Cup must hold a gamma lance`);
    }
    // combat effects on the explorer
    const plan = plans.get(seeds[0]);
    const game = { plan, renderer: { scene: new THREE.Scene() }, player: { mods: {}, pos: new THREE.Vector3(), health: 100, maxHealth: 100, stamina: 100, maxStamina: 100 }, grapple: { rangeBonus: 0, reelMul: 1 } };
    const sys = new ArtifactSystem(game);
    const fake = { id: 9999, name: 'test', effects: [{ type: 'armor', magnitude: 0.3 }, { type: 'tough', magnitude: 40 }, { type: 'wind', magnitude: 20 }, { type: 'might', magnitude: 0.5 }], ability: null, drawback: null, weapon: { type: 'blade', power: 1.2, element: 'frost' }, site: plan.artifacts[0].site };
    sys.byId.set(fake.id, fake);
    sys.collected.add(fake.id);
    assert(sys.wield(fake.id), 'could not wield a weapon');
    assert(sys.wieldedArt() === fake, 'the weapon is not in hand');
    assert(Math.abs(sys.mods.armor - 0.3) < 1e-6 && sys.mods.might === 0.5, 'the weapon in hand does not work on its bearer');
    assert(game.player.maxHealth === 140 && game.player.maxStamina === 120, 'toughness and second wind do not raise health and stamina');
    sys.wield(null);
    assert(game.player.maxHealth === 100 && !sys.mods.armor, 'putting the weapon away did not restore the explorer');
    const real = plan.artifacts.find((x) => x.weapon);
    sys.collected.add(real.id);
    assert(sys.weapons().length >= 2 && sys.weapons()[0] === null && sys.weapons().includes(real.id), 'the carried weapons list');
    sys.cycleWeapon();
    assert(sys.wielded === real.id, 'switching weapons');
  });
}

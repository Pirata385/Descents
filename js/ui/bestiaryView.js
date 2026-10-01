// Debug view that lays out every generated species (adult and juvenile) for
// visual inspection of the genome system: ?bestiary=1&seed=...
import * as THREE from 'three';
import { generateSpecies } from '../creatures/genetics.js';
import { buildSpeciesModel, createCreatureObject } from '../creatures/creatureMesh.js';
import { animateCreature } from '../creatures/animation.js';
import { individualGenes, inheritGenes } from '../creatures/genetics.js';
import { NameGen } from '../world/names.js';
import { normalizeSeed, RNG } from '../core/rng.js';

export function bestiary(canvas, seedText) {
  const seed = normalizeSeed(seedText);
  const species = generateSpecies(seed, new NameGen(seed));
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fa6b8);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x556655, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const cols = 6;
  const items = [];
  const labels = document.createElement('div');
  labels.style.cssText = 'position:fixed;inset:0;pointer-events:none;font:11px sans-serif;color:#000';
  document.body.appendChild(labels);
  species.forEach((sp, i) => {
    const tpl = buildSpeciesModel(sp);
    const rng = new RNG(i + 1);
    const g1 = individualGenes(sp, rng), g2 = individualGenes(sp, rng);
    const parent = createCreatureObject(tpl, sp, g1);
    const child = createCreatureObject(tpl, sp, inheritGenes(sp, g1, g2, rng));
    const x = (i % cols) * 3.2 - (cols - 1) * 1.6, z = Math.floor(i / cols) * 3.2;
    const s = 1.6 / Math.max(0.6, sp.morph.size) * Math.min(1.6, Math.max(0.6, sp.morph.size));
    parent.mesh.scale.setScalar(1.25);
    parent.mesh.position.set(x, 0, -z);
    parent.mesh.rotation.y = Math.PI / 2 + 0.6;
    child.mesh.scale.setScalar(0.6);
    child.mesh.position.set(x + 1.0, 0, -z + 0.9);
    child.mesh.rotation.y = Math.PI / 2 + 0.9;
    scene.add(parent.mesh, child.mesh);
    const ap = { sp, obj: parent, scale: 1, state: sp.behavior.locomotion === 'fly' ? 'wander' : 'wander', animSpeed: sp.behavior.speed.walk * 0.6, seed: i, airborne: sp.behavior.locomotion === 'fly', look: 0, calling: 0 };
    const ac = { sp, obj: child, scale: 0.6, state: 'idle', animSpeed: 0, seed: i + 0.5, juvenile: true, look: 0, calling: 0 };
    items.push([ap, tpl], [ac, tpl]);
    const lab = document.createElement('div');
    lab.style.position = 'absolute';
    lab.dataset.x = x; lab.dataset.z = -z;
    lab.textContent = `${sp.name} [${sp.family}/${sp.role}] ${sp.morph.size.toFixed(1)}m ${sp.behavior.locomotion}`;
    labels.appendChild(lab);
    void s;
  });
  const rows = Math.ceil(species.length / cols);
  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 9 + rows * 1.6, 6);
  camera.lookAt(0, 0, -rows * 1.6 + 1);
  let t = 0;
  const loop = () => {
    t += 1 / 60;
    for (const [a, tpl] of items) animateCreature(a, tpl, 1 / 60, t);
    renderer.render(scene, camera);
    for (const lab of labels.children) {
      const v = new THREE.Vector3(Number(lab.dataset.x), -0.1, Number(lab.dataset.z)).project(camera);
      lab.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth - 60}px`;
      lab.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight + 4}px`;
    }
    requestAnimationFrame(loop);
  };
  loop();
  window.__ready = true;
  return species;
}

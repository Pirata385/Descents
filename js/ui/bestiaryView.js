// Debug view of the genome system: for every species, two parents and four of
// their offspring, animated, so anatomical variation and inheritance can be
// inspected. ?bestiary=1&seed=...&layer=layer3&pose=walk|idle|fly
import * as THREE from 'three';
import { generateSpecies, individualGenes, inheritGenes } from '../creatures/genome.js';
import { phenotype } from '../creatures/anatomy.js';
import { buildCreature } from '../creatures/body.js';
import { Animator } from '../creatures/motion.js';
import { NameGen } from '../world/names.js';
import { normalizeSeed, RNG } from '../core/rng.js';

export function bestiary(canvas, seedText) {
  const params = new URLSearchParams(location.search);
  const seed = normalizeSeed(seedText);
  const layer = params.get('layer');
  const pose = params.get('pose') || 'walk';
  let species = generateSpecies(seed, new NameGen(seed));
  if (layer) species = species.filter((s) => s.layer === layer);
  const from = Number(params.get('from') || 0), count = Number(params.get('count') || 999);
  species = species.slice(from, from + count);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fa6b8);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x556655, 2.0));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const items = [];
  const labels = document.createElement('div');
  labels.style.cssText = 'position:fixed;inset:0;pointer-events:none;font:11px sans-serif;color:#102';
  document.body.appendChild(labels);
  const perRow = Number(params.get('cols') || 6);
  species.forEach((sp, i) => {
    const rng = new RNG(i * 7 + 1);
    const sub = i % sp.subspecies.length;
    const A = individualGenes(sp, rng, sub), B = individualGenes(sp, rng, sub);
    const kids = [0, 1, 2, 3].map(() => inheritGenes(sp, A, B, rng));
    const row = i;
    [A, B, ...kids].slice(0, perRow).forEach((g, j) => {
      const ph = phenotype(sp, g);
      const cr = buildCreature(ph, i * 10 + j);
      const portrait = params.get('portrait');
      const k = portrait ? 1.25 / Math.max(0.05, cr.length, cr.height) : 1 / Math.max(0.05, ph.scale);
      const root = new THREE.Group();
      root.add(cr.mesh);
      root.scale.setScalar(k * (j < 2 ? 1 : 0.85));
      const x = portrait ? (j - (perRow - 1) / 2) * 1.7 : j * 2.2 - (perRow - 1) * 1.1 + (j >= 2 ? 0.6 : 0);
      const z = portrait ? 0 : -row * 2.3;
      if (portrait) root.position.y = -row * 1.6;
      root.position.x = x; root.position.z = z;
      root.rotation.y = params.get('face') ? Number(params.get('face')) : Math.PI / 2 + 0.5;
      scene.add(root);
      const flier = ph.wings.type === 'feather' || ph.wings.type === 'membrane';
      const anim = new Animator(cr, ph, sp, i * 10 + j);
      const mode = pose === 'fly' && flier ? 'fly' : pose === 'idle' ? 'ground' : 'ground';
      items.push({ anim, ph, mode, root, flier, j });
    });
    const lab = document.createElement('div');
    lab.style.position = 'absolute';
    if (params.get('portrait')) { lab.dataset.x = -(perRow - 1) * 0.85 - 0.5; lab.dataset.y = -row * 1.6 + 1.35; lab.dataset.z = 0; } else { lab.dataset.x = -(perRow - 1) * 1.1 - 1.4; lab.dataset.y = 0; lab.dataset.z = -row * 2.3; }
    lab.innerHTML = `<b>${sp.name}</b><br>${sp.layer} · ${sp.niche} · ${sp.plan}/${sp.family} · ${sp.size.toFixed(2)} m`;
    labels.appendChild(lab);
  });
  const rows = species.length;
  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 300);
  if (params.get('portrait')) {
    camera.fov = 22; camera.updateProjectionMatrix();
    camera.position.set(0, 1.5 - (rows - 1) * 0.8, 4.5 + rows * 2.6);
    camera.lookAt(0, 0.45 - (rows - 1) * 0.8, 0);
  } else if (rows <= 3) { camera.position.set(0, 0.9 + rows * 0.45, 2.4 + rows * 0.5); camera.lookAt(0, 0.3, -(rows - 1) * 1.15); }
  else { camera.position.set(0, 4 + rows * 1.1, 5); camera.lookAt(0, 0, -rows * 1.15 + 1.5); }
  let t = 0;
  const loop = () => {
    t += 1 / 60;
    for (const it of items) {
      const st = { speed: pose === 'walk' ? it.ph.stats.walk : 0, mode: it.mode, action: pose === 'idle' ? (Math.sin(t * 0.5 + it.j) > 0.5 ? 'eat' : 'idle') : 'idle', lookYaw: Math.sin(t * 0.7 + it.j) * 0.6 };
      it.anim.update(1 / 60, st);
    }
    renderer.render(scene, camera);
    for (const lab of labels.children) {
      const v = new THREE.Vector3(Number(lab.dataset.x), Number(lab.dataset.y), Number(lab.dataset.z)).project(camera);
      lab.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth - 150}px`;
      lab.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight - 10}px`;
    }
    requestAnimationFrame(loop);
  };
  loop();
  window.__ready = true;
  return species;
}

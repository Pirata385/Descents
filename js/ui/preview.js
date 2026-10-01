// Small turntable renderer for catalog entries (creatures and artifacts).
// One WebGL context is shared by every preview and moved between panels.
import * as THREE from 'three';
import { createCreatureObject, buildSpeciesModel } from '../creatures/creatureMesh.js';
import { animateCreature } from '../creatures/animation.js';
import { buildArtifactModel } from '../artifacts/artifactMesh.js';
import { RNG } from '../core/rng.js';
import { individualGenes } from '../creatures/genetics.js';

export class Preview {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'preview-canvas';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x404858, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 1.2);
    rim.position.set(-4, 2, -3);
    this.scene.add(rim);
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);
    this.templates = new Map();
    this.obj = null;
    this.t = 0;
    this.running = false;
    this.drag = null;
    this.spin = 0.5;
    this.canvas.addEventListener('pointerdown', (e) => { this.drag = { x: e.clientX, r: this.pivot.rotation.y }; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => { if (this.drag) this.pivot.rotation.y = this.drag.r + (e.clientX - this.drag.x) * 0.01; });
    this.canvas.addEventListener('pointerup', () => { this.drag = null; });
  }

  attach(el) {
    el.appendChild(this.canvas);
    const r = el.getBoundingClientRect();
    this.renderer.setSize(Math.max(50, r.width), Math.max(50, r.height), false);
    this.camera.aspect = Math.max(50, r.width) / Math.max(50, r.height);
    this.camera.updateProjectionMatrix();
    if (!this.running) { this.running = true; this.last = performance.now(); requestAnimationFrame((t) => this.loop(t)); }
  }

  detach() {
    this.running = false;
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }

  clear() {
    if (this.obj) {
      this.pivot.remove(this.obj.root);
      this.obj.root.traverse((m) => { if (m.material && m.material.dispose) m.material.dispose(); if (m.geometry && this.obj.ownGeometry) m.geometry.dispose(); });
      this.obj = null;
    }
  }

  frame(size, height) {
    const d = size * 2.6 + 0.4;
    this.camera.position.set(d * 0.75, height + d * 0.32, d * 0.85);
    this.camera.lookAt(0, height, 0);
  }

  showSpecies(sp, ecoTemplates) {
    this.clear();
    let tpl = ecoTemplates && ecoTemplates.get(sp.id);
    if (!tpl) { tpl = this.templates.get(sp.id); if (!tpl) { tpl = buildSpeciesModel(sp); this.templates.set(sp.id, tpl); } }
    const genes = individualGenes(sp, new RNG(sp.id * 31 + 7));
    genes.hue = 0; genes.light = 0; genes.sat = 0;
    const o = createCreatureObject(tpl, sp, genes);
    o.mesh.scale.setScalar(1);
    const root = new THREE.Group();
    root.add(o.mesh);
    this.pivot.add(root);
    const ind = { sp, obj: o, scale: 1, state: 'idle', animSpeed: 0, seed: sp.id, airborne: false, look: 0, calling: 0, perched: true };
    this.obj = { root, ind, tpl, kind: 'creature' };
    const height = (sp.behavior.locomotion === 'ceiling' ? 0 : 0.35);
    if (sp.behavior.locomotion === 'ceiling') { o.mesh.rotation.z = 0; }
    this.frame(1.0, height);
  }

  showArtifact(art) {
    this.clear();
    const model = buildArtifactModel(art);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3()).length() || 1;
    const c = box.getCenter(new THREE.Vector3());
    model.position.sub(c);
    const root = new THREE.Group();
    root.add(model);
    root.scale.setScalar(1 / size);
    this.pivot.add(root);
    this.obj = { root, kind: 'artifact', ownGeometry: true };
    this.frame(0.38, 0);
  }

  loop(t) {
    if (!this.running) return;
    requestAnimationFrame((tt) => this.loop(tt));
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    this.t += dt;
    if (!this.drag) this.pivot.rotation.y += dt * this.spin;
    if (this.obj && this.obj.kind === 'creature') {
      const ind = this.obj.ind;
      ind.calling = Math.sin(this.t * 0.7) > 0.97 ? 0.5 : 0;
      animateCreature(ind, this.obj.tpl, dt, this.t);
    }
    this.renderer.render(this.scene, this.camera);
  }
}

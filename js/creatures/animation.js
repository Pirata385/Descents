// Procedural creature animation driven by locomotion state and body plan.
// Gaits: trotting quadrupeds, bipeds, sprawling reptiles with spinal waves,
// arthropod tripod gaits, slithering, rolling lithoseres; plus wing flapping
// and gliding, tail sway, head look/grazing, jaw opening, resting poses.

export function animateCreature(ind, tpl, dt, t) {
  const rig = tpl.rig;
  const B = ind.obj.bones;
  const rest = ind.obj.rest;
  const sp = ind.sp;
  const m = sp.morph;
  const speed = ind.animSpeed || 0;
  const unit = Math.max(0.05, ind.scale);
  const stride = Math.max(0.15, rig.legLen * unit * 1.5);
  const running = speed > sp.behavior.speed.walk * 1.4;
  ind.phase = (ind.phase || 0) + (speed / stride) * dt * Math.PI;
  const ph = ind.phase;
  const state = ind.state;
  const resting = state === 'rest' || state === 'sleep';
  const flying = ind.airborne;
  // reset
  for (let i = 0; i < B.length; i++) { B[i].rotation.set(0, 0, 0); B[i].position.copy(rest[i]); }
  const root = B[rig.root];
  // juveniles: bigger heads, longer legs
  if (ind.juvenile) {
    B[rig.head].scale.setScalar(1.3);
    for (const l of rig.legs) B[l.upper].scale.set(1, 1.15, 1);
  }
  const posture = m.legs.posture;
  const amp = flying ? 0.15 : Math.min(1, speed / Math.max(0.3, sp.behavior.speed.walk)) * (running ? 0.75 : 0.5);
  // legs
  for (const l of rig.legs) {
    let off = (l.side > 0 ? Math.PI : 0) + (l.pair % 2) * Math.PI;
    if (posture === 'arthropod') off = ((l.pair % 2 === 0) !== (l.side > 0)) ? 0 : Math.PI;
    const s = Math.sin(ph + off) * amp;
    const lift = Math.max(0, Math.cos(ph + off)) * amp;
    const U = B[l.upper], Lw = B[l.lower];
    if (resting) {
      if (posture === 'arthropod') { U.rotation.z = -0.4 * l.side; }
      else { U.rotation.x = -0.9; Lw.rotation.x = 1.6; }
      continue;
    }
    if (flying && sp.family === 'bird') { U.rotation.x = -1.0; Lw.rotation.x = 1.2; continue; }
    if (posture === 'sprawl') { U.rotation.y = s * 0.9 * l.side; U.rotation.z = lift * 0.5 * l.side; Lw.rotation.y = -s * 0.3 * l.side; }
    else if (posture === 'arthropod') { U.rotation.y = s * 0.7 * l.side; U.rotation.z = -lift * 0.45 * l.side; }
    else { U.rotation.x = -s; Lw.rotation.x = lift * 1.2 * (posture === 'digitigrade' ? -1 : 1); }
  }
  // body
  if (resting) root.position.y = rest[rig.root].y * (posture === 'arthropod' ? 0.6 : 0.45);
  else if (!flying) root.position.y = rest[rig.root].y + Math.abs(Math.sin(ph * 2)) * 0.035 * amp;
  if (m.legs.pairs === 0 && sp.behavior.locomotion !== 'roll') {
    // slithering: wave along the spine and tail
    root.position.y = rest[rig.root].y * 0.4;
    rig.spine.forEach((b, k) => { B[b].rotation.y = Math.sin(ph * 1.5 - k * 0.9) * 0.35; });
    rig.tail.forEach((b, k) => { B[b].rotation.y = Math.sin(ph * 1.5 - (k + rig.spine.length) * 0.9) * 0.45; });
  } else if (posture === 'sprawl') {
    rig.spine.forEach((b, k) => { B[b].rotation.y = Math.sin(ph - k * 0.8) * 0.12 * amp; });
  }
  if (sp.behavior.locomotion === 'roll' && speed > 0.05) {
    ind.rollAngle = (ind.rollAngle || 0) + speed * dt / Math.max(0.2, rig.hipH * unit);
    root.rotation.x = ind.rollAngle;
    root.position.y = rest[rig.root].y * 0.8;
  }
  // tail
  rig.tail.forEach((b, k) => {
    if (m.legs.pairs === 0) return;
    B[b].rotation.y += Math.sin(t * (running ? 4 : 1.4) + k * 0.7 + ind.seed) * (0.08 + 0.05 * k) * (resting ? 0.3 : 1);
    B[b].rotation.x = (running ? 0.05 : -0.04) + (m.tail.tip === 'stinger' ? -0.15 : 0);
  });
  // neck / head
  const look = ind.look || 0;
  const graze = state === 'forage' && ind.grazing ? 1 : 0;
  const nNeck = rig.neck.length;
  rig.neck.forEach((b) => { B[b].rotation.x = graze * 0.55 / Math.max(1, nNeck) + (resting ? 0.25 : 0); B[b].rotation.y = look * 0.5 / Math.max(1, nNeck); });
  const H = B[rig.head];
  H.rotation.x = graze * (nNeck ? 0.5 : 0.9) + (resting ? 0.3 : 0) + Math.sin(t * 0.7 + ind.seed) * 0.05;
  H.rotation.y = look * 0.5 + Math.sin(t * 0.4 + ind.seed * 3) * 0.12 * (state === 'idle' || state === 'wander' ? 1 : 0.2);
  // jaw
  const call = ind.calling > 0 ? 1 : 0;
  B[rig.jaw].rotation.x = call * 0.45 + (state === 'eat' ? Math.max(0, Math.sin(t * 8)) * 0.35 : 0) + (graze ? Math.max(0, Math.sin(t * 5)) * 0.2 : 0);
  // arms
  rig.arms.forEach((b, k) => { B[b].rotation.x = -0.2 + Math.sin(ph + k * Math.PI) * 0.2 * amp + (state === 'hunt' && ind.strike > 0 ? -1.0 : 0); });
  // wings
  for (const w of rig.wings) {
    const Wi = B[w.inner], Wo = B[w.outer];
    if (flying) {
      if (ind.gliding) { Wi.rotation.z = 0.08 * w.side; Wo.rotation.z = -0.05 * w.side; }
      else {
        const f = sp.morph.wings.type === 'insect' ? 28 : 6 / Math.max(0.4, Math.sqrt(unit));
        const a = Math.sin(t * f + ind.seed) * (sp.morph.wings.type === 'insect' ? 0.5 : 0.85);
        Wi.rotation.z = a * w.side;
        Wo.rotation.z = Math.sin(t * f + ind.seed - 0.7) * 0.45 * w.side;
      }
    } else {
      // folded along the body
      Wi.rotation.y = -1.35 * w.side;
      Wi.rotation.z = -0.25 * w.side;
      Wo.rotation.y = -1.6 * w.side;
    }
  }
}

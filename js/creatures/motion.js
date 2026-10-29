// Procedural animation of creature skeletons, in the spirit of Spore: nothing
// is keyframed; every frame the pose is rebuilt from the rest pose.
// - gaits per body plan (walk, trot, bound, biped stride, hops, sprawl with a
//   side-bending spine, tripod and wave gaits for many legs), feet placed by
//   two-bone IK with stance and swing phases; bouncy or heavy steps by temperament,
// - flight: flapping (rate and amplitude by size), gliding, hovering, banking,
//   folded wings on the ground; medusoids pulse their bells and trail tentacles;
//   slugs creep with a wave along the body; rollers roll inside their shell,
// - the face: eyes that follow what the animal looks at, dart about and blink,
//   a jaw that chews, calls and yawns, ears that twitch, a head that tilts when
//   curious,
// - springy parts (ears, antennae, eye stalks, trunks, crests, tail tips,
//   tentacles) swing with the body's motion,
// - idle behaviour with personality: looking around, happy hops, shaking off,
//   stretching, yawning, sitting, tail wagging, sniffing, chosen from the
//   animal's playfulness, energy, curiosity and sociability.
import * as THREE from 'three';

const _e = new THREE.Euler();
const _v4 = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

function rot(bone, ax, ay, az) {
  _e.set(ax, ay, az, 'YXZ');
  bone.quaternion.setFromEuler(_e);
}
/** Multiply an extra rotation onto a bone's current pose. */
const _q = new THREE.Quaternion();
function addRot(bone, ax, ay, az) {
  _e.set(ax, ay, az, 'YXZ');
  _q.setFromEuler(_e);
  bone.quaternion.multiply(_q);
}

/** Gait timing: phase offset per leg (pair index, side) and duty factor. */
function gaitFor(plan, pairs, mode, speedK) {
  if (plan === 'insect' || plan === 'hexapod' || plan === 'crab') return { off: (pi, sd) => ((pi + (sd > 0 ? 1 : 0)) % 2) * 0.5, duty: 0.55 };
  if (plan === 'spider') return { off: (pi, sd) => (((pi % 2) + (sd > 0 ? 1 : 0)) % 2) * 0.5 + pi * 0.06, duty: 0.6 };
  if (plan === 'centipede') return { off: (pi, sd) => (pi / pairs + (sd > 0 ? 0.5 : 0)) % 1, duty: 0.6 };
  if (pairs === 1) return mode === 'hop' ? { off: () => 0, duty: 0.4 } : { off: (pi, sd) => (sd > 0 ? 0.5 : 0), duty: speedK > 1.5 ? 0.4 : 0.6 };
  // quadrupeds: walk (lateral sequence) -> trot -> bound when running
  if (speedK > 2.2) return { off: (pi, sd) => (pi === 0 ? 0 : 0.5) + (sd > 0 ? 0.08 : 0), duty: 0.35 };
  if (speedK > 1.2 || plan === 'sprawler' || plan === 'glider') return { off: (pi, sd) => ((pi + (sd > 0 ? 1 : 0)) % 2) * 0.5, duty: 0.5 };
  return { off: (pi, sd) => (pi === 0 ? 0 : 0.25) + (sd > 0 ? 0.5 : 0), duty: 0.65 };
}

const EMOTES = ['look', 'hop', 'shake', 'stretch', 'yawn', 'sit', 'wag', 'tilt', 'sniff'];

/** A tiny deterministic random stream per animal (animation only). */
function rand(seed) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export class Animator {
  constructor(creature, ph, sp, seed = 1) {
    this.c = creature;
    this.rig = creature.rig;
    this.ph = ph;
    this.sp = sp;
    this.rnd = rand(seed + 7);
    this.t = (seed % 1000) * 0.137;
    this.gait = (seed % 97) / 97;
    this.flap = (seed % 53) / 53;
    this.drop = 0;        // body lowering when resting (0..1)
    this.sleepK = 0;
    this.wingOpen = 0;    // 0 folded .. 1 spread
    this.display = 0;
    this.jawOpen = 0;
    this.lookYaw = 0; this.lookPitch = 0;
    this.eat = 0;
    this.earTwitch = 0;
    this.footOff = null;  // optional per-leg ground offsets (root frame, metres)
    this.lod = 0;
    const P = ph.personality || {};
    this.P = { bold: P.bold ?? 0.5, curious: P.curious ?? 0.5, social: P.social ?? 0.5, aggr: P.aggr ?? 0.5, playful: P.playful ?? 0.5, bounce: P.bounce ?? 0.5, energy: P.energy ?? 0.5 };
    // face
    this.blink = 0; this.blinkT = 1 + this.rnd() * 4;
    this.sacY = 0; this.sacP = 0; this.sacT = this.rnd() * 2;
    this.tilt = 0;
    // idle behaviour
    this.emote = null; this.emoteT = 0; this.emoteLen = 0; this.emoteCd = 2 + this.rnd() * 6;
    // inertia for the springy parts
    this.prevSpeed = 0; this.prevBob = 0; this.bobVel = 0; this.accF = 0; this.accY = 0;
    this.pulse = this.rnd();
    this.roll = 0;
    const r = this.rig;
    this.springs = (r.springs || []).filter((c) => c && c.length).map((chain) => ({ chain, ax: 0, ay: 0, vx: 0, vy: 0, ph: this.rnd() * 6.28 }));
    // memo of leg chains
    this.legs = r.legs.map((L) => ({
      ...L,
      u: r.bones[L.knee].position.clone(),       // knee offset from the hip joint
      l: r.bones[L.foot].position.clone(),       // foot offset from the knee
      H: r.bones[L.upper].position.clone(),      // hip joint in the parent frame
      a: r.bones[L.knee].position.length(),
      b: r.bones[L.foot].position.length(),
    }));
    for (const L of this.legs) {
      // bend direction of the rest pose (pole), in the parent frame
      const foot = _v4.copy(L.u).add(L.l);
      const fd = foot.clone().normalize();
      const pole = L.u.clone().addScaledVector(fd, -L.u.dot(fd));
      L.pole = pole.lengthSq() > 1e-8 ? pole.normalize() : new THREE.Vector3(0, 0, 1);
    }
  }

  /** Transform (position, quaternion) of a bone relative to the root, from the current local poses. */
  chain(bi, outP, outQ) {
    const bones = this.rig.bones;
    const cache = this._chains || (this._chains = new Map());
    let list = cache.get(bi);
    if (!list) {
      list = [];
      let b = bones[bi];
      while (b && b.isBone) { list.push(b); b = b.parent; }
      cache.set(bi, list);
    }
    outP.set(0, 0, 0); outQ.identity();
    for (let i = list.length - 1; i >= 0; i--) {
      // a child's offset is scaled by its parent (squash and stretch of the hips)
      _v4.copy(list[i].position).multiply(i < list.length - 1 ? list[i + 1].scale : ONE).applyQuaternion(outQ);
      outP.add(_v4);
      outQ.multiply(list[i].quaternion);
    }
  }

  /** Two-bone IK: place the foot of leg L at target T (root frame). */
  ik(L, T) {
    const bones = this.rig.bones;
    const w = this._w || (this._w = { pP: new THREE.Vector3(), pQ: new THREE.Quaternion(), iQ: new THREE.Quaternion(), D: new THREE.Vector3(), Dn: new THREE.Vector3(), pole: new THREE.Vector3(), K: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), low: new THREE.Vector3(), q: new THREE.Quaternion() });
    this.chain(L.parent, w.pP, w.pQ);
    // target in the parent's frame, relative to the hip joint
    w.iQ.copy(w.pQ).invert();
    w.D.copy(T).sub(w.pP).applyQuaternion(w.iQ).sub(L.H);
    const a = L.a, b = L.b;
    let d = w.D.length();
    d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, d));
    w.Dn.copy(w.D).normalize();
    const cosA = Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d)));
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    w.pole.copy(L.pole).addScaledVector(w.Dn, -L.pole.dot(w.Dn));
    if (w.pole.lengthSq() < 1e-8) w.pole.set(0, 0, 1); else w.pole.normalize();
    w.K.copy(w.Dn).multiplyScalar(cosA).addScaledVector(w.pole, sinA).multiplyScalar(a);
    const up = bones[L.upper], kn = bones[L.knee], ft = bones[L.foot];
    up.quaternion.setFromUnitVectors(w.a.copy(L.u).normalize(), w.b.copy(w.K).normalize());
    w.q.copy(up.quaternion).invert();
    w.low.copy(w.Dn).multiplyScalar(d).sub(w.K).normalize().applyQuaternion(w.q);
    kn.quaternion.setFromUnitVectors(w.a.copy(L.l).normalize(), w.low);
    // keep the foot level with the parent frame
    ft.quaternion.copy(up.quaternion).multiply(kn.quaternion).invert();
  }

  /** Pick an idle behaviour that suits the animal. */
  pickEmote() {
    const P = this.P, ph = this.ph, plan = ph.plan, r = this.rig;
    const legged = r.legs.length >= 4 && plan !== 'spider' && plan !== 'centipede' && plan !== 'insect' && plan !== 'crab';
    const small = ph.scale < 1.2 && ph.family !== 'lithosere';
    const w = {
      look: 1 + P.curious,
      hop: small && r.legs.length && plan !== 'slug' ? P.playful * P.bounce * 2.5 : 0,
      shake: ph.family === 'mammal' || ph.family === 'bird' ? 0.4 + P.energy * 0.6 : 0.15,
      stretch: legged ? 0.5 + (1 - P.energy) * 0.5 : 0,
      yawn: r.jaw !== undefined ? 0.3 + (1 - P.energy) * 0.8 : 0,
      sit: legged && (ph.family === 'mammal' || ph.family === 'amphibian') ? 0.4 + (1 - P.energy) * 0.6 : 0,
      wag: r.tail.length >= 3 ? P.social * 1.5 + P.playful * 0.5 : 0,
      tilt: 0.3 + P.curious * 1.4,
      sniff: ph.mouth && (ph.mouth.type === 'muzzle' || ph.mouth.type === 'trunk') ? 0.8 : 0,
    };
    let tot = 0;
    for (const k of EMOTES) tot += w[k];
    let x = this.rnd() * tot;
    for (const k of EMOTES) { x -= w[k]; if (x <= 0) return k; }
    return 'look';
  }

  /**
   * st: { speed m/s, mode: ground|fly|glide|hover|climb|hang|rest|sleep|swim, action: idle|eat|call|attack|display|groom|alert,
   *       lookYaw, lookPitch (radians, relative to the body), turn (rad/s), bank, flap, hop, hurt }
   */
  update(dt, st) {
    if (!(dt > 0)) dt = 1 / 60;
    this.t += dt;
    const r = this.rig, bones = r.bones, ph = this.ph;
    const plan = ph.plan;
    const P = this.P;
    // reset to rest
    for (let i = 0; i < bones.length; i++) { bones[i].quaternion.copy(r.restQ[i]); bones[i].position.copy(r.restP[i]); bones[i].scale.copy(r.restS[i]); }
    const mode = st.mode || 'ground';
    const airborne = mode === 'fly' || mode === 'glide' || mode === 'hover';
    const k = 1 - Math.exp(-dt * 6);
    const resting = mode === 'rest' || mode === 'sleep';
    this.drop += ((resting ? 1 : 0) - this.drop) * (1 - Math.exp(-dt * 2));
    this.sleepK += ((mode === 'sleep' ? 1 : 0) - this.sleepK) * (1 - Math.exp(-dt * 1.5));
    this.wingOpen += ((airborne || st.action === 'display' ? 1 : 0) - this.wingOpen) * (1 - Math.exp(-dt * 5));
    this.display += ((st.action === 'display' || st.action === 'alert' ? 1 : 0) - this.display) * k;
    this.eat += ((st.action === 'eat' ? 1 : 0) - this.eat) * (1 - Math.exp(-dt * 3));
    this.lookYaw += ((st.lookYaw || 0) - this.lookYaw) * k;
    this.lookPitch += ((st.lookPitch || 0) - this.lookPitch) * k;
    const speed = st.speed || 0;
    const stats = ph.stats;
    const speedK = speed / Math.max(0.2, stats.walk);
    this.accF += (((speed - this.prevSpeed) / dt) - this.accF) * Math.min(1, dt * 8);
    this.prevSpeed = speed;
    // ---------------------------------------------------------- idle behaviour
    const idle = !airborne && !resting && speed < 0.08 && (st.action === 'idle' || !st.action);
    if (this.emote) {
      this.emoteT += dt;
      if (this.emoteT > this.emoteLen || !idle) this.emote = null;
    } else if (idle) {
      this.emoteCd -= dt * (0.6 + P.playful * 0.8);
      if (this.emoteCd <= 0) {
        this.emote = this.pickEmote(); this.emoteT = 0;
        this.emoteLen = { look: 2.5, hop: 1.4, shake: 0.9, stretch: 2.2, yawn: 1.8, sit: 5, wag: 2, tilt: 2.2, sniff: 1.6 }[this.emote] * (0.8 + this.rnd() * 0.5);
        this.emoteCd = 3 + this.rnd() * 7;
        this.emoteDir = this.rnd() < 0.5 ? -1 : 1;
      }
    }
    const em = this.emote, eT = this.emoteT, eK = em ? Math.sin(Math.PI * Math.min(1, eT / this.emoteLen)) : 0;
    if (plan === 'floater') { this.floaterPose(dt, st, speed); this.face(dt, st, 0); this.springsUpdate(dt, speed); return; }
    // ---------------------------------------------------------- gait phase
    const stride = stats.stride * Math.min(1.8, 0.6 + speedK * 0.5);
    const hopper = plan === 'hopper' || (ph.legs.biped && st.hop);
    if (!airborne) this.gait = (this.gait + (speed / Math.max(0.05, stride)) * dt * (hopper ? 0.42 : 0.5)) % 1;
    const moving = speed > 0.05 && !airborne;
    const bounce = 0.6 + P.bounce * 1.2;
    let bob = moving ? Math.abs(Math.sin(this.gait * Math.PI * 2)) * r.legLen * 0.05 * Math.min(1.5, speedK) * bounce : 0;
    let hopLift = 0;
    if (moving && hopper) { const p = this.gait; hopLift = p < 0.55 ? Math.sin(Math.PI * p / 0.55) * r.legLen * (0.25 + 0.2 * P.bounce) * Math.min(1.4, 0.5 + speedK * 0.5) : 0; bob = hopLift; }
    if (em === 'hop') { const hp = (eT * 2.2) % 1; hopLift = Math.max(hopLift, Math.max(0, Math.sin(Math.PI * 2 * hp)) * r.legLen * 0.35 * eK); bob = Math.max(bob, hopLift); }
    // squash and stretch: stretch going up, squash on landing
    this.bobVel += (((bob - this.prevBob) / dt) - this.bobVel) * Math.min(1, dt * 10);
    this.accY = this.bobVel;
    this.prevBob = bob;
    const breath = Math.sin(this.t * (resting ? 1.6 : 2.6) * (0.8 + P.energy * 0.4));
    const sit = em === 'sit' ? Math.min(1, eT * 2.5, (this.emoteLen - eT) * 2.5) : 0;
    const dropY = Math.max(this.drop, sit * 0.8) * (plan === 'serpent' || plan === 'slug' ? 0 : r.legLen * (ph.legs.posture === 'sprawl' || ph.legs.posture === 'arthropod' ? 0.35 : 0.5));
    bones[r.hips].position.y -= dropY - bob;
    const sq = 1 + Math.max(-0.12, Math.min(0.12, this.bobVel * 0.04 / Math.max(0.2, r.legLen)));
    if (Math.abs(sq - 1) > 0.005) bones[r.hips].scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
    bones[r.chest].scale.multiplyScalar(1 + breath * 0.025);
    // ---------------------------------------------------------- spine and tail
    const sideBend = plan === 'sprawler' || plan === 'serpent' || plan === 'glider' || plan === 'centipede' || plan === 'slug';
    const turn = Math.max(-1.2, Math.min(1.2, st.turn || 0));
    this.lastTurn = turn;
    const nS = r.spine.length;
    const shake = em === 'shake' ? Math.sin(eT * 30) * 0.25 * eK : 0;
    const stretch = em === 'stretch' ? eK : 0;
    // a swagger: the hips roll a little with each step
    const swag = moving && !sideBend ? Math.sin(this.gait * Math.PI * 2) * 0.05 * bounce : 0;
    if (plan === 'roller') {
      // the shell rolls; the face inside stays upright
      this.roll += (speed / Math.max(0.1, r.hipY)) * dt;
      rot(bones[r.spine[0]], this.roll, 0, 0);
      rot(bones[r.chest], -this.roll, 0, 0);
    } else {
      rot(bones[r.hips], -stretch * 0.25, 0, swag + shake);
      for (let i = 0; i < nS; i++) {
        const sb = bones[r.spine[i]];
        let ay = turn * 0.12;
        if (sideBend && moving) ay += Math.sin(this.gait * Math.PI * 2 + i * 1.1) * 0.22 * Math.min(1.3, speedK);
        if (plan === 'serpent') ay += Math.sin(this.t * 3 + i * 1.3) * 0.35 * Math.min(1, speedK + 0.2);
        const ax = speedK > 2.2 && !sideBend ? Math.sin(this.gait * Math.PI * 2) * 0.12 : 0;
        rot(sb, ax + stretch * 0.15, ay, -swag * 0.5 + shake * 0.6);
      }
      if (plan === 'slug') {
        // a creeping wave runs along the body
        const w = Math.sin(this.t * 4 - 0) * 0.04 * Math.min(1, speed * 6 + 0.2);
        bones[r.hips].scale.z *= 1 + w; bones[r.chest].scale.z *= 1 - w;
      }
    }
    const nT = r.tail.length;
    const wag = em === 'wag' ? eK : 0;
    const tailRaise = (this.display * 0.25) - (resting ? 0.1 : 0) + (airborne ? 0.1 : 0) + wag * 0.3 + stretch * 0.4 + (P.playful - 0.5) * 0.15;
    for (let i = 0; i < nT; i++) {
      const tb = bones[r.tail[i]];
      const swayF = sideBend && moving ? this.gait * Math.PI * 2 : this.t * (0.9 + wag * 9);
      const amp = sideBend && moving ? 0.3 : plan === 'serpent' ? 0.4 : 0.07 + wag * 0.35 + P.playful * 0.04;
      const ay = Math.sin(swayF - i * 0.7) * amp - turn * 0.15;
      rot(tb, -tailRaise / nT * (i === 0 ? 2 : 1), ay, 0);
    }
    // ---------------------------------------------------------- neck, head, jaw, ears, frill
    let lookY = Math.max(-1.1, Math.min(1.1, this.lookYaw)), lookP = Math.max(-0.7, Math.min(0.7, this.lookPitch));
    if (em === 'look') { lookY += Math.sin(eT * 1.6) * 0.9 * eK * this.emoteDir; lookP += 0.15 * eK; }
    if (em === 'sniff') lookP -= 0.35 * eK;
    const graze = this.eat * (r.legLen > 0 ? 1 : 0);
    const nodTime = this.eat * Math.sin(this.t * 7) * 0.08 + (em === 'sniff' ? Math.sin(eT * 22) * 0.06 * eK : 0);
    const sleepDown = this.sleepK * 0.5;
    const yawnUp = em === 'yawn' ? eK * 0.35 : 0;
    const neckDown = graze * (ph.legs.biped ? 0.9 : 1.15) + sleepDown - this.display * 0.25 + stretch * 0.3 - yawnUp;
    // curious animals tilt the head at what they watch (the Spore head tilt)
    const watching = Math.abs(this.lookYaw) + Math.abs(this.lookPitch) > 0.05 && st.action === 'alert';
    this.tilt += (((watching ? P.curious * 0.35 : 0) + (em === 'tilt' ? 0.4 * this.emoteDir * eK : 0)) - this.tilt) * Math.min(1, dt * 3);
    if (r.neck.length && r.neck[0] !== r.hips) {
      rot(bones[r.neck[0]], neckDown * 0.55 - lookP * 0.3, lookY * 0.3, shake * 0.4);
      rot(bones[r.neck[1]], neckDown * 0.35 - lookP * 0.3, lookY * 0.3, 0);
    }
    if (r.head !== undefined) rot(bones[r.head], neckDown * 0.15 - lookP * 0.4 + nodTime, lookY * 0.4, Math.sin(this.t * 0.7) * 0.05 * (1 - this.sleepK) + this.tilt + shake);
    const calling = st.action === 'call' ? 0.5 + 0.5 * Math.sin(this.t * 14) : 0;
    const biting = st.action === 'attack' ? 0.6 + 0.4 * Math.sin(this.t * 18) : 0;
    const chewing = this.eat * (0.15 + 0.15 * Math.sin(this.t * 9));
    const yawn = em === 'yawn' ? Math.max(0, Math.sin(Math.PI * Math.min(1, eT / (this.emoteLen * 0.8)))) : 0;
    this.jawOpen += (Math.max(calling * 0.5, biting * 0.7, chewing, yawn * 0.9, this.display * 0.25 * P.aggr) - this.jawOpen) * (1 - Math.exp(-dt * 14));
    if (r.jaw !== undefined) rot(bones[r.jaw], this.jawOpen * 0.6, 0, 0);
    this.earTwitch = Math.max(0, this.earTwitch - dt * 4);
    if (this.rnd() < dt * 0.4) this.earTwitch = 1;
    const earsBack = this.display * (P.aggr > 0.6 ? 0.5 : -0.2) + this.sleepK * 0.5 + (st.hurt ? 0.6 : 0);
    r.ears.forEach((ei, j) => rot(bones[ei], -earsBack * 0.6, 0, (j ? 1 : -1) * (this.earTwitch * 0.25 - this.display * 0.15)));
    if (r.frill !== undefined) rot(bones[r.frill], -this.display * 0.9 + 0.5 * (1 - this.display), 0, 0);
    // ---------------------------------------------------------- legs
    const tuck = airborne ? 1 : 0;
    const G = gaitFor(plan, ph.legs.pairs, hopper ? 'hop' : 'walk', speedK);
    const lift = r.legLen * (plan === 'insect' || plan === 'spider' || plan === 'centipede' || plan === 'crab' ? 0.25 : 0.18) * Math.min(1.5, 0.5 + speedK * 0.5) * (0.8 + P.bounce * 0.4);
    const _T = this._T || (this._T = new THREE.Vector3());
    for (let li = 0; li < this.legs.length; li++) {
      const L = this.legs[li];
      const T = _T.copy(L.footRest);
      if (tuck) {
        // tucked under the body (birds pull their feet back, bats trail them)
        const hip = L.hip;
        T.set(hip.x * 0.8, hip.y - r.legLen * 0.45, hip.z - r.legLen * (plan === 'bat' ? 0.9 : 0.55));
        T.y -= dropY;
      } else if (moving && hopper) {
        // all feet push off together, the hind legs trail in the air
        const p = this.gait;
        if (p < 0.55) { T.y += hopLift * 0.85; T.z += (L.front ? 0.15 : -0.35) * r.legLen * Math.sin(Math.PI * p / 0.55); }
      } else if (moving) {
        const p = (this.gait + G.off(L.pair, L.side)) % 1;
        const duty = G.duty;
        let dz, dy;
        if (p < duty) { dz = stride * (0.5 - p / duty); dy = 0; } else { const s = (p - duty) / (1 - duty); dz = stride * (-0.5 + s); dy = lift * Math.sin(Math.PI * s); }
        T.z += dz * (ph.legs.posture === 'sprawl' ? 0.8 : 1);
        T.y += dy;
        if (ph.legs.posture === 'sprawl' || ph.legs.posture === 'arthropod') T.x += L.side * Math.abs(dz) * 0.15;
      } else {
        if (resting && (ph.legs.posture === 'erect' || ph.legs.posture === 'digitigrade')) { T.z += (L.front ? 0.12 : -0.18) * r.legLen; T.x *= 0.85; }
        if (sit > 0 && !L.front) { T.z -= sit * r.legLen * 0.1; }
        if (stretch > 0 && L.front) T.z += stretch * r.legLen * 0.35;
        if (em === 'hop') T.y += hopLift * 0.9;
      }
      if (this.footOff && !tuck) T.y += this.footOff[li] || 0;
      this.ik(L, T);
    }
    // arms: swing with the gait, raise to display or attack; crabs work their pincers
    for (const A of r.arms) {
      const sw = moving ? Math.sin((this.gait + (A.side > 0 ? 0.5 : 0)) * Math.PI * 2) * 0.35 : 0;
      if (A.pincer !== undefined) {
        rot(bones[A.b0], -this.display * 0.5, A.side * this.display * 0.3, 0);
        const snap = st.action === 'attack' || this.display > 0.5 ? Math.abs(Math.sin(this.t * 9)) : idle ? Math.max(0, Math.sin(this.t * 1.3 + A.side)) * 0.6 * P.playful : 0;
        rot(bones[A.pincer], snap * 0.6, 0, 0);
        continue;
      }
      rot(bones[A.b0], sw - this.display * 0.6 - (st.action === 'attack' ? 0.8 : 0) + (em === 'stretch' ? -0.9 * eK : 0), 0, A.side * 0.15);
      rot(bones[A.b1], -0.4 - this.display * 0.3, 0, 0);
    }
    if (r.wings.length) this.wingPose(dt, st, mode, airborne);
    this.face(dt, st, em === 'yawn' ? yawn : 0);
    this.springsUpdate(dt, speed);
  }

  /** Eyes: follow the look direction, dart about, blink (and stay shut asleep or mid-yawn). */
  face(dt, st, squint) {
    const r = this.rig, bones = r.bones;
    if (!r.eyes.length) return;
    this.blinkT -= dt;
    if (this.blinkT <= 0) { this.blinkT = 1.5 + this.rnd() * 4.5; this.blinkStart = this.t; }
    const bt = this.blinkStart !== undefined ? (this.t - this.blinkStart) / 0.16 : 9;
    const blink = bt < 1 ? Math.sin(Math.PI * bt) : 0;
    this.sacT -= dt;
    if (this.sacT <= 0) {
      this.sacT = 0.4 + this.rnd() * (2.2 - this.P.curious * 1.2);
      this.sacY = (this.rnd() - 0.5) * 0.5; this.sacP = (this.rnd() - 0.5) * 0.3;
    }
    const close = Math.max(blink, this.sleepK, squint * 0.85, st.hurt ? 0.7 : 0);
    const ey = Math.max(-0.5, Math.min(0.5, this.lookYaw * 0.5 + this.sacY));
    const ep = Math.max(-0.35, Math.min(0.35, -this.lookPitch * 0.4 + this.sacP));
    for (const E of r.eyes) {
      const b = bones[E.bone];
      rot(b, ep, ey, 0);
      if (close > 0.02) b.scale.y = Math.max(0.08, 1 - close * 0.92);
      // wide-eyed when alarmed
      else if (this.display > 0.3 && st.action === 'alert') b.scale.setScalar(1 + this.display * 0.12);
    }
  }

  /** Springy parts: damped swings driven by the body's acceleration, turning and bounce. */
  springsUpdate(dt, speed) {
    const bones = this.rig.bones;
    const fA = Math.max(-6, Math.min(6, this.accF)), fY = Math.max(-6, Math.min(6, this.accY));
    const turn = this.lastTurn || 0;
    const stiff = 38, damp = 5.5;
    for (const S of this.springs) {
      // forward acceleration and bobbing swing the part back; turning swings it sideways
      const fx = -fA * 0.06 - fY * 0.05 + Math.sin(this.t * 1.7 + S.ph) * 0.4 + speed * 0.04;
      const fy = -turn * 0.25 + Math.sin(this.t * 1.3 + S.ph * 1.7) * 0.3;
      S.vx += (-stiff * S.ax - damp * S.vx + fx * stiff * 0.1) * dt;
      S.vy += (-stiff * S.ay - damp * S.vy + fy * stiff * 0.1) * dt;
      S.ax = Math.max(-0.9, Math.min(0.9, S.ax + S.vx * dt));
      S.ay = Math.max(-0.9, Math.min(0.9, S.ay + S.vy * dt));
      const n = S.chain.length;
      for (let i = 0; i < n; i++) {
        const w = (0.6 + 0.4 * (i / Math.max(1, n - 1))) / Math.sqrt(n);
        addRot(bones[S.chain[i]], S.ax * w, S.ay * w, 0);
      }
    }
  }

  /** Medusoids: the bell pulses, the body drifts and bobs, tentacles trail and ripple. */
  floaterPose(dt, st, speed) {
    const r = this.rig, bones = r.bones;
    const rate = 0.7 + this.P.energy * 0.6 + speed * 0.5;
    this.pulse = (this.pulse + dt * rate) % 1;
    const p = this.pulse;
    // a quick contraction and a slow relaxation
    const c = p < 0.3 ? Math.sin((p / 0.3) * Math.PI * 0.5) : Math.cos(((p - 0.3) / 0.7) * Math.PI * 0.5);
    const bell = bones[r.hips];
    bell.scale.set(1 - c * 0.12, 1 + c * 0.1, 1 - c * 0.12);
    bell.position.y += Math.sin(this.t * 0.9) * r.hipY * 0.03 + c * r.hipY * 0.02;
    rot(bell, -Math.min(0.35, speed * 0.25) + Math.sin(this.t * 0.6) * 0.06, 0, Math.sin(this.t * 0.45) * 0.06);
    this.accF = speed * 2;
    for (let i = 0; i < r.tentacles.length; i++) {
      const ch = r.tentacles[i];
      for (let j = 0; j < ch.length; j++) rot(bones[ch[j]], Math.min(0.5, speed * 0.25) + Math.sin(this.t * 1.8 - j * 0.9 + i) * 0.12, 0, Math.cos(this.t * 1.4 - j * 0.8 + i * 1.3) * 0.12);
    }
    if (r.jaw !== undefined) rot(bones[r.jaw], (st.action === 'eat' ? 0.3 : 0) * Math.abs(Math.sin(this.t * 6)), 0, 0);
  }

  wingPose(dt, st, mode, airborne) {
    const r = this.rig, bones = r.bones, ph = this.ph;
    const size = ph.scale;
    // flapping rate: small fliers beat fast, large ones slowly
    const rate = ph.wings.type === 'insect' ? 22 : Math.max(1.6, 9 / Math.sqrt(Math.max(0.08, size)));
    const flapping = mode === 'fly' || mode === 'hover' || (st.flap && st.flap > 0.5);
    if (flapping) this.flap = (this.flap + dt * rate * (mode === 'hover' ? 1.4 : 1)) % 1;
    const amp = mode === 'glide' ? 0.06 : flapping ? (ph.wings.type === 'insect' ? 0.7 : 0.75) : 0;
    const fp = this.flap * Math.PI * 2;
    const open = this.wingOpen;
    void airborne;
    for (const W of r.wings) {
      const sd = W.side;
      if (W.type === 'patagium') {
        const fold = 1 - open;
        rot(bones[W.b1], 0, sd * fold * 1.2, sd * (-0.2 * open));
        rot(bones[W.b3], 0, -sd * fold * 1.0, sd * (-0.2 * open));
        continue;
      }
      const beat = Math.sin(fp) * amp, lag = Math.sin(fp - 0.7) * amp;
      const fold = 1 - open;
      const bank = (st.bank || 0) * 0.4;
      rot(bones[W.b0], 0, sd * fold * 1.5, (sd * beat + bank + (mode === 'glide' ? sd * 0.08 : 0)) * open + sd * fold * 0.12);
      rot(bones[W.b1], 0, -sd * fold * 2.55, sd * lag * 0.6 * open);
      rot(bones[W.b2], 0, sd * fold * 2.35, sd * lag * 0.4 * open);
      if (W.b3 !== undefined) rot(bones[W.b3], 0, -sd * fold * 0.3, sd * lag * 0.2 * open);
    }
  }
}

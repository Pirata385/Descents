// Procedural animation of creature skeletons. Every frame the pose is rebuilt
// from the rest pose:
// - gaits per body plan (walk, trot, bound, biped stride, hop, sprawl with a
//   side-bending spine, tripod and wave gaits for many legs), feet placed by
//   two-bone IK, with stance/swing phases and lift,
// - flight: flapping (rate and amplitude by size), gliding, hovering, banking,
//   folded wings on the ground, membranes spread or furled,
// - head and neck look-at, grazing, calling (jaw), alert and display poses
//   (crest/frill flare, wings spread), resting, sleeping, hanging upside down,
// - tail sway, breathing, ear twitches.
import * as THREE from 'three';

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _e = new THREE.Euler();
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

function rot(bone, ax, ay, az) {
  _e.set(ax, ay, az, 'YXZ');
  bone.quaternion.setFromEuler(_e);
}

/** Gait timing: phase offset per leg (pair index, side) and duty factor. */
function gaitFor(plan, pairs, mode, speedK) {
  if (plan === 'insect') return { off: (pi, sd) => ((pi + (sd > 0 ? 1 : 0)) % 2) * 0.5, duty: 0.55 };
  if (plan === 'spider') return { off: (pi, sd) => (((pi % 2) + (sd > 0 ? 1 : 0)) % 2) * 0.5 + pi * 0.06, duty: 0.6 };
  if (plan === 'centipede') return { off: (pi, sd) => (pi / pairs + (sd > 0 ? 0.5 : 0)) % 1, duty: 0.6 };
  if (pairs === 1) return mode === 'hop' ? { off: () => 0, duty: 0.4 } : { off: (pi, sd) => (sd > 0 ? 0.5 : 0), duty: speedK > 1.5 ? 0.4 : 0.6 };
  // quadrupeds: walk (lateral sequence) -> trot -> bound when running
  if (speedK > 2.2) return { off: (pi, sd) => (pi === 0 ? 0 : 0.5) + (sd > 0 ? 0.08 : 0), duty: 0.35 };
  if (speedK > 1.2 || plan === 'sprawler' || plan === 'glider') return { off: (pi, sd) => ((pi + (sd > 0 ? 1 : 0)) % 2) * 0.5, duty: 0.5 };
  return { off: (pi, sd) => (pi === 0 ? 0 : 0.25) + (sd > 0 ? 0.5 : 0), duty: 0.65 };
}

export class Animator {
  constructor(creature, ph, sp, seed = 1) {
    this.c = creature;
    this.rig = creature.rig;
    this.ph = ph;
    this.sp = sp;
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
    this.spineSide = 0;
    this.footOff = null;  // optional per-leg ground offsets (root frame, metres)
    this.lod = 0;
    // memo of leg chains
    const r = this.rig;
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
      const foot = _v.copy(L.u).add(L.l);
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
      _v4.copy(list[i].position).applyQuaternion(outQ);
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
    if (w.pole.lengthSq() < 1e-8) w.pole.copy(Z); else w.pole.normalize();
    // knee position
    w.K.copy(w.Dn).multiplyScalar(cosA).addScaledVector(w.pole, sinA).multiplyScalar(a);
    const up = bones[L.upper], kn = bones[L.knee], ft = bones[L.foot];
    up.quaternion.setFromUnitVectors(w.a.copy(L.u).normalize(), w.b.copy(w.K).normalize());
    // lower bone: from its rest direction to the direction knee -> foot, in the upper bone's frame
    w.q.copy(up.quaternion).invert();
    w.low.copy(w.Dn).multiplyScalar(d).sub(w.K).normalize().applyQuaternion(w.q);
    kn.quaternion.setFromUnitVectors(w.a.copy(L.l).normalize(), w.low);
    // keep the foot level with the parent frame
    ft.quaternion.copy(up.quaternion).multiply(kn.quaternion).invert();
  }

  /**
   * st: { speed m/s, mode: ground|fly|glide|hover|climb|hang|rest|sleep|swim, action: idle|eat|call|attack|display|groom|alert,
   *       lookYaw, lookPitch (radians, relative to the body), turn (rad/s), dt }
   */
  update(dt, st) {
    this.t += dt;
    const r = this.rig, bones = r.bones, ph = this.ph;
    const plan = ph.plan;
    // reset to rest
    for (let i = 0; i < bones.length; i++) { bones[i].quaternion.copy(r.restQ[i]); bones[i].position.copy(r.restP[i]); }
    const mode = st.mode || 'ground';
    const airborne = mode === 'fly' || mode === 'glide' || mode === 'hover';
    const k = 1 - Math.exp(-dt * 6);
    // smoothed state
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
    // ---------------------------------------------------------- gait phase
    const stride = stats.stride * Math.min(1.8, 0.6 + speedK * 0.5);
    if (!airborne) this.gait = (this.gait + (speed / Math.max(0.05, stride)) * dt * (ph.legs.biped ? 0.5 : 0.5)) % 1;
    const moving = speed > 0.05 && !airborne;
    // body bob and breathing
    const bob = moving ? Math.abs(Math.sin(this.gait * Math.PI * 2)) * r.legLen * 0.05 * Math.min(1.5, speedK) : 0;
    const breath = Math.sin(this.t * (resting ? 1.6 : 2.6)) * r.hgt * 0.025;
    const dropY = this.drop * (plan === 'serpent' ? 0 : r.legLen * (ph.legs.posture === 'sprawl' || ph.legs.posture === 'arthropod' ? 0.35 : 0.55));
    bones[r.hips].position.y -= dropY + bob;
    bones[r.chest].position.y += breath;
    // ---------------------------------------------------------- spine and tail
    const sideBend = plan === 'sprawler' || plan === 'serpent' || plan === 'glider' || plan === 'centipede';
    const turn = Math.max(-1.2, Math.min(1.2, st.turn || 0));
    const nS = r.spine.length;
    for (let i = 0; i < nS; i++) {
      const sb = bones[r.spine[i]];
      let ay = turn * 0.12;
      if (sideBend && moving) ay += Math.sin(this.gait * Math.PI * 2 + i * 1.1) * 0.22 * Math.min(1.3, speedK);
      if (plan === 'serpent') ay += Math.sin(this.t * 3 + i * 1.3) * 0.35 * Math.min(1, speedK + 0.2);
      // galloping flexes the back
      const ax = speedK > 2.2 && !sideBend ? Math.sin(this.gait * Math.PI * 2) * 0.12 : 0;
      rot(sb, ax, ay, 0);
    }
    const nT = r.tail.length;
    const tailRaise = (this.display * 0.25) - (resting ? 0.1 : 0) + (airborne ? 0.1 : 0);
    for (let i = 0; i < nT; i++) {
      const tb = bones[r.tail[i]];
      const swayF = sideBend && moving ? this.gait * Math.PI * 2 : this.t * (0.8 + (this.t * 0 + 0.4));
      const amp = sideBend && moving ? 0.3 : plan === 'serpent' ? 0.4 : 0.08 + (st.action === 'alert' ? 0.0 : 0.05);
      const ay = Math.sin(swayF - i * 0.7) * amp - turn * 0.15;
      rot(tb, -tailRaise / nT * (i === 0 ? 2 : 1), ay, 0);
    }
    // ---------------------------------------------------------- neck, head, jaw, ears, frill
    const lookY = Math.max(-1.1, Math.min(1.1, this.lookYaw)), lookP = Math.max(-0.7, Math.min(0.7, this.lookPitch));
    const graze = this.eat * (r.legLen > 0 ? 1 : 0);
    const nodTime = this.eat * Math.sin(this.t * 7) * 0.08;
    const sleepDown = this.sleepK * 0.5;
    const neckDown = graze * (ph.legs.biped ? 0.9 : 1.15) + sleepDown - this.display * 0.25;
    if (r.neck.length) {
      rot(bones[r.neck[0]], neckDown * 0.55 - lookP * 0.3, lookY * 0.3, 0);
      rot(bones[r.neck[1]], neckDown * 0.35 - lookP * 0.3, lookY * 0.3, 0);
    }
    rot(bones[r.head], neckDown * 0.15 - lookP * 0.4 + nodTime, lookY * 0.4, Math.sin(this.t * 0.7) * 0.05 * (1 - this.sleepK));
    const calling = st.action === 'call' ? 0.5 + 0.5 * Math.sin(this.t * 14) : 0;
    const biting = st.action === 'attack' ? 0.6 + 0.4 * Math.sin(this.t * 18) : 0;
    const chewing = this.eat * (0.15 + 0.15 * Math.sin(this.t * 9));
    this.jawOpen += (Math.max(calling * 0.5, biting * 0.7, chewing) - this.jawOpen) * (1 - Math.exp(-dt * 14));
    rot(bones[r.jaw], this.jawOpen * 0.6, 0, 0);
    this.earTwitch = Math.max(0, this.earTwitch - dt * 4);
    if (Math.random() < dt * 0.4) this.earTwitch = 1;
    r.ears.forEach((ei, j) => rot(bones[ei], -this.display * 0.3 + this.sleepK * 0.5, 0, (j ? 1 : -1) * (this.earTwitch * 0.25 - this.display * 0.15)));
    if (r.frill !== undefined) rot(bones[r.frill], -this.display * 0.9 + 0.5 * (1 - this.display), 0, 0);
    // ---------------------------------------------------------- legs
    const tuck = airborne ? 1 : 0;
    const G = gaitFor(plan, ph.legs.pairs, ph.legs.biped && st.hop ? 'hop' : 'walk', speedK);
    const lift = r.legLen * (plan === 'insect' || plan === 'spider' || plan === 'centipede' ? 0.25 : 0.18) * Math.min(1.5, 0.5 + speedK * 0.5);
    for (let li = 0; li < this.legs.length; li++) {
      const L = this.legs[li];
      const T = (this._T || (this._T = new THREE.Vector3())).copy(L.footRest);
      if (tuck) {
        // tucked under the body (birds pull their feet back, bats trail them)
        const hip = L.hip;
        T.set(hip.x * 0.8, hip.y - this.rig.legLen * 0.45, hip.z - this.rig.legLen * (plan === 'bat' ? 0.9 : 0.55));
        T.y -= dropY;
      } else if (moving) {
        const p = (this.gait + G.off(L.pair, L.side)) % 1;
        const duty = G.duty;
        let dz, dy;
        if (p < duty) { dz = stride * (0.5 - p / duty); dy = 0; } else { const s = (p - duty) / (1 - duty); dz = stride * (-0.5 + s); dy = lift * Math.sin(Math.PI * s); }
        T.z += dz * (ph.legs.posture === 'sprawl' ? 0.8 : 1);
        T.y += dy;
        // sprawled legs sweep in an arc
        if (ph.legs.posture === 'sprawl' || ph.legs.posture === 'arthropod') T.x += L.side * Math.abs(dz) * 0.15;
      } else if (resting && (ph.legs.posture === 'erect' || ph.legs.posture === 'digitigrade')) {
        // folded under the body
        T.z += (L.front ? 0.12 : -0.18) * r.legLen;
        T.x *= 0.85;
      }
      if (this.footOff && !tuck) T.y += this.footOff[li] || 0;
      this.ik(L, T);
    }
    // arms (bipeds): swing with the gait, raise to display/attack
    for (const A of r.arms) {
      const sw = moving ? Math.sin((this.gait + (A.side > 0 ? 0.5 : 0)) * Math.PI * 2) * 0.35 : 0;
      rot(bones[A.b0], sw - this.display * 0.6 - (st.action === 'attack' ? 0.8 : 0), 0, A.side * 0.15);
      rot(bones[A.b1], -0.4 - this.display * 0.3, 0, 0);
    }
    // ---------------------------------------------------------- wings
    if (r.wings.length) this.wingPose(dt, st, mode, airborne);
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
    for (const W of r.wings) {
      const sd = W.side;
      if (W.type === 'patagium') {
        // spread by the limbs when gliding, furled against the body otherwise
        const fold = 1 - open;
        rot(bones[W.b1], 0, sd * fold * 1.2, sd * (-0.2 * open));
        rot(bones[W.b3], 0, -sd * fold * 1.0, sd * (-0.2 * open));
        continue;
      }
      const beat = Math.sin(fp) * amp, lag = Math.sin(fp - 0.7) * amp;
      // folded pose: wing swept back along the body
      const fold = 1 - open;
      const bank = (st.bank || 0) * 0.4;
      // the roll (flap and bank) only acts on open wings; folded wings lie flat along the back
      rot(bones[W.b0], 0, sd * fold * 1.5, (sd * beat + bank + (mode === 'glide' ? sd * 0.08 : 0)) * open + sd * fold * 0.12);
      rot(bones[W.b1], 0, -sd * fold * 2.55, sd * lag * 0.6 * open);
      rot(bones[W.b2], 0, sd * fold * 2.35, sd * lag * 0.4 * open);
      if (W.b3 !== undefined) rot(bones[W.b3], 0, -sd * fold * 0.3, sd * lag * 0.2 * open);
    }
  }
}

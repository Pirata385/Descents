// Creature decision making. Each individual has needs (hunger, energy, fear,
// the urge to mate, the pull of its group) and a temperament taken from its
// genes (boldness, curiosity, sociality, aggression). Every half second or so
// it scores the actions open to it and picks the most useful one; the
// ecosystem then carries the action out frame by frame.
//
// Actions: flee, hunt, forage, scavenge, rest, sleep, roost (go home),
// court, nest (tend eggs and young), follow (young after parents), flock,
// mob (small fliers harass a predator), defend (drive off rivals), guard
// (deep-layer parents dive at an explorer who comes too close to the nest),
// investigate (approach the explorer), symbiosis (keep beside a host),
// stalk/charge (large predators and the explorer), wander, idle.
import { G } from './genome.js';

export const ACTION_LABEL = {
  flee: 'fleeing', hunt: 'hunting', forage: 'feeding', scavenge: 'scavenging', rest: 'resting', sleep: 'sleeping', roost: 'going home',
  court: 'courting', nest: 'tending its nest', follow: 'following its parent', flock: 'with its group', mob: 'mobbing a predator',
  defend: 'driving off a rival', guard: 'defending its nest!', investigate: 'watching you', symbiosis: 'beside its host', stalk: 'stalking you', charge: 'charging!',
  wander: 'wandering', idle: 'resting', eat: 'eating', display: 'displaying', glide: 'gliding',
};

/** Hours when a species sleeps, by activity pattern. */
export function asleepAt(sp, hour) {
  switch (sp.behavior.activity) {
    case 'diurnal': return hour >= 20.5 || hour < 5.5;
    case 'nocturnal': return hour >= 7 && hour < 18;
    case 'crepuscular': return (hour >= 10 && hour < 16) || (hour >= 0.5 && hour < 4);
    default: return (hour >= 13 && hour < 14.5) || (hour >= 2 && hour < 4);
  }
}

/**
 * Choose an action for agent a. eco provides queries (neighbours, player,
 * carcasses, time). Sets a.state, a.target and a.timer.
 */
export function decide(a, eco) {
  const sp = a.sp, B = sp.behavior, c = a.genes.c;
  const bold = c[G.boldness], curious = c[G.curiosity], social = c[G.sociality], aggr = c[G.aggression];
  const perception = a.ph.stats.perception * (eco.dark ? 0.75 : 1) * (a.state === 'sleep' ? 0.35 : 1);
  const player = eco.player;
  const N = a.needs;
  const near = eco.neighbours(a, perception);
  // ---- threats: predators and the explorer
  let threat = null, threatD = Infinity, threatW = 0;
  for (const o of near) {
    if (o.dead) continue;
    const isPred = sp.relations.predators.includes(o.sp.id) || (o.sp.behavior.diet === 'carnivore' && o.ph.scale > a.ph.scale * 2.2 && o.sp !== sp);
    if (!isPred) continue;
    const d = o.pos.distanceTo(a.pos);
    // a resting or grazing predator is watched, not fled from, unless it comes close
    const hunting = o.state === 'hunt' || o.state === 'charge' || o.state === 'stalk';
    const reach = hunting ? perception : perception * 0.4;
    if (d > reach) continue;
    const w = (1 - d / reach) * (hunting ? 1.5 : 0.8);
    if (w > threatW) { threatW = w; threat = o; threatD = d; }
  }
  let playerD = Infinity;
  if (player && !B.playerAware) {
    playerD = player.pos.distanceTo(a.pos);
    // the explorer is large, loud and (in the deep) carries a light
    // a still, quiet observer is gradually tolerated (habituation)
    const fleeR = (8 + a.ph.stats.perception * 0.45) * (1.25 - bold) * (eco.lampOn && eco.dark ? 1.35 : 1) * (player.crouch ? 0.6 : 1) * (a.juvenile ? 1.3 : 1) * (1 - 0.65 * (a.habit || 0));
    if (playerD < fleeR && !(a.state === 'investigate' && playerD > 4) && a.state !== 'guard') {
      const w = (1 - playerD / fleeR) * (1.2 - bold) * 1.4;
      if (w > threatW) { threatW = w; threat = eco.playerAgent; threatD = playerD; }
    }
  }
  N.fear = Math.max(N.fear * 0.8, threatW);
  // ---- utilities
  const U = [];
  const add = (action, score, target = null, timer = 4) => { if (score > 0) U.push({ action, score, target, timer }); };
  if (threat) add('flee', 1.2 + N.fear * 2.5, { agent: threat, kind: 'threat' }, 3 + bold * 2);
  if (B.playerAware && player) {
    const d = player.pos.distanceTo(a.pos);
    if (d < perception * 1.6 && !eco.playerSafe) add(a.state === 'charge' ? 'charge' : 'stalk', 1.6 + N.hunger, { agent: eco.playerAgent, kind: 'explorer' }, 6);
  }
  const hour = eco.hour;
  const sleepy = asleepAt(sp, hour);
  if (sleepy || N.energy < 0.2) {
    const away = a.home && a.home.kind !== 'range' && a.pos.distanceTo(a.home.pos) > 3;
    add(away ? 'roost' : 'sleep', (sleepy ? 1.1 : 0.4) + (1 - N.energy) * 0.8, away ? { pos: a.home.pos, kind: a.home.kind } : null, 20);
  }
  // food
  if (B.diet === 'carnivore') {
    let prey = null, pd = Infinity;
    const canFly = a.ph.stats.fly > 0;
    for (const o of near) {
      if (o.dead || !sp.relations.prey.includes(o.sp.id)) continue;
      // hunters on foot cannot catch prey on the wing
      if (!canFly && o.mode === 'air') continue;
      const d = o.pos.distanceTo(a.pos) * (o.juvenile ? 0.7 : 1);
      if (d < pd) { pd = d; prey = o; }
    }
    if (prey) add('hunt', N.hunger * 2.0 + aggr * 0.3, { agent: prey, kind: 'prey' }, 12);
    const carc = eco.carcassNear(a.pos, perception);
    if (carc) add('scavenge', N.hunger * 1.5, { pos: carc.pos, carcass: carc, kind: 'carcass' }, 10);
  } else {
    add('forage', N.hunger * 1.6 + 0.15, null, 6 + Math.random() * 6);
    if (B.diet === 'scavenger') {
      const carc = eco.carcassNear(a.pos, perception * 2);
      if (carc) add('scavenge', 0.4 + N.hunger * 1.6, { pos: carc.pos, carcass: carc, kind: 'carcass' }, 12);
    }
  }
  // young follow a parent
  if (a.juvenile && a.parent && !a.parent.dead) {
    const d = a.parent.pos.distanceTo(a.pos);
    add('follow', 0.5 + Math.min(1.5, d / 6), { agent: a.parent, kind: 'parent' }, 3);
  }
  // nests: parents tend eggs and young
  if (a.nestEggs > 0 && a.home) add('nest', 1.0 + (a.sex === 'f' ? 0.3 : 0), { pos: a.home.pos, kind: 'nest' }, 15);
  // mates
  if (!a.juvenile && N.mate > 0.6 && !sleepy) {
    let mate = a.mate && !a.mate.dead ? a.mate : null;
    if (!mate) {
      let md = Infinity;
      for (const o of near) {
        if (o.sp !== sp || o.sex === a.sex || o.juvenile || o.dead || (o.mate && o.mate !== a)) continue;
        const d = o.pos.distanceTo(a.pos);
        if (d < md) { md = d; mate = o; }
      }
    }
    if (mate) add('court', (N.mate - 0.4) * 1.8, { agent: mate, kind: 'mate' }, 10);
  }
  // groups
  if (a.group && a.leader && a.leader !== a && !a.leader.dead) {
    const d = a.leader.pos.distanceTo(a.pos);
    const spread = (B.social === 'flock' || B.social === 'swarm' ? 6 : B.social === 'herd' ? 10 : 8) * (0.6 + a.ph.scale);
    add('flock', social * Math.min(1.6, d / spread) * 0.9, { agent: a.leader, kind: 'group' }, 3);
  }
  // mobbing: social fliers harass the predators that hunt them
  if (sp.relations.mobs.length && bold > 0.35) {
    for (const o of near) if (sp.relations.mobs.includes(o.sp.id) && !o.dead && o.pos.distanceTo(a.pos) < perception * 0.8) { add('mob', 0.5 + bold * 0.8 - N.fear * 0.5, { agent: o, kind: 'mob' }, 8); break; }
  }
  // territory: drive off same-sex rivals near home
  if (!a.juvenile && a.home && c[G.territory] > 0.45) {
    for (const o of near) {
      if (o.sp !== sp || o === a.mate || o.sex !== a.sex || o.juvenile || o.dead) continue;
      if (o.pos.distanceTo(a.home.pos) < 14 + c[G.territory] * 20) { add('defend', aggr * c[G.territory] * 1.4, { agent: o, kind: 'rival' }, 6); break; }
    }
  }
  // nest defence: in the deep layers, parents with eggs or fresh young drive the explorer off
  if (player && sp.layerIndex >= 3 && B.nest && B.nest !== 'roost' && a.home && a.home.kind !== 'range' && !a.juvenile && (a.nestEggs > 0 || a.broodT > 0 || (a.mate && a.mate.nestEggs > 0))) {
    const r = 7 + c[G.territory] * 9;
    if (player.pos.distanceTo(a.home.pos) < r && !eco.playerSafe) add('guard', 1.1 + bold * 0.8 + aggr * 0.6, { agent: eco.playerAgent, kind: 'explorer', pos: a.home.pos, r }, 5);
  }
  // symbiosis
  if (sp.relations.symbiontOf !== null) {
    for (const o of near) if (o.sp.id === sp.relations.symbiontOf && !o.dead) { add('symbiosis', 0.75, { agent: o, kind: 'host' }, 10); break; }
  }
  // curiosity about the explorer
  if (player && playerD < perception * 1.5 && playerD > 5 && curious > 0.55 && N.fear < 0.3 && !B.playerAware) add('investigate', (curious - 0.45) * 1.2, { agent: eco.playerAgent, kind: 'explorer' }, 6);
  add('wander', 0.35 + curious * 0.15, null, 4 + Math.random() * 6);
  add('idle', 0.25 + (1 - c[G.agility]) * 0.2, null, 2 + Math.random() * 4);
  // keep the current action a little longer (no dithering)
  for (const u of U) if (u.action === a.state && a.timer > 0) u.score += 0.25;
  U.sort((x, y) => y.score - x.score);
  const best = U[0];
  const changed = best.action !== a.state;
  a.state = best.action;
  a.target = best.target;
  if (changed || a.timer <= 0) a.timer = best.timer;
  return changed;
}

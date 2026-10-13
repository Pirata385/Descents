// Entry point: boots the user interface and starts games.
import { Game, DebugCamera } from './game.js';
import { Player } from './player/player.js';
import { Grapple } from './player/grapple.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view');

/** Camera poses at notable places of the generated world (test harness). */
function namedPose(g, loc) {
  const plan = g.plan, f = g.world.field, p = plan.params;
  const look = (x, y, z, tx, ty, tz) => ({ x, y, z, yaw: Math.atan2(-(tx - x), -(tz - z)), pitch: Math.atan2(ty - y, Math.hypot(tx - x, tz - z)) });
  const floor = (x, z, y) => g.world.floorBelow(x, y, z);
  const eyeR = (th) => f.tab(f.eyeTab, th);
  const th0 = plan.spiral.th0;
  switch (loc) {
    case 'rim': { const s = plan.spawn; return look(s.x, s.y + 25, s.z, 0, -150, 0); }
    case 'overview': return look(900, 700, 900, 0, -300, 0);
    case 'station': { const s = plan.station; return look(s.x, s.y + 3, s.z, 0, s.y - 60, 0); }
    case 'bowl': { const [x, z] = f.fromPolar(eyeR(th0) + 280, th0 + 0.4); const y = floor(x, z, 200) + 1.7; return look(x, y, z, 0, y - 40, 0); }
    case 'shaft': { const [x, z] = f.fromPolar(eyeR(th0) * 0.55, th0 + 0.5); return look(x, p.lipY - 140, z, f.fromPolar(eyeR(th0), th0 + 0.5)[0], p.lipY - 200, f.fromPolar(eyeR(th0), th0 + 0.5)[1]); }
    case 'gallery': {
      const w = plan.galleryWindows[0];
      const [x, z] = f.fromPolar(eyeR(w.th) + 25, w.th);
      const y = floor(x, z, w.y + 5) + 1.7;
      const [tx, tz] = f.fromPolar(eyeR(w.th) + 90, w.th + 0.25);
      return look(x, y, z, tx, y + 10, tz);
    }
    case 'plain': { const sk = plan.fault.sinkholes[0]; const [x, z] = [sk.x + (p.fault.x - sk.x) * -0.4, sk.z + (p.fault.z - sk.z) * -0.4]; const y = floor(x, z, p.plainY + 30) + 1.7; return look(x, y, z, sk.x, y - 6, sk.z); }
    case 'fault': { const w = plan.fault.windows[0] || plan.fault.halls[1]; return look(w.x, w.y + 1.7, w.z, p.fault.x, w.y - 60, p.fault.z); }
    case 'sinkhole': { const sk = plan.fault.sinkholes[0]; return look(sk.x + 12, sk.y + 4, sk.z, sk.x, sk.y - 3, sk.z); }
    case 'hall': { const h = plan.fault.halls[Number(params.get('i') || 1)]; return look(h.x, h.y + 1.7, h.z, h.x + 5, h.y + 1, h.z + 5); }
    case 'basin': { const e = plan.fault.exit; const b = plan.fault.basin; return look(e.x, e.y + 1.7, e.z, b.x, b.y + 10, b.z); }
    case 'gate': { const gt = plan.fault.gate.mouth; const b = plan.fault.basin; return look(gt.x + (b.x - gt.x) * 0.15, gt.y + 2.5, gt.z + (b.z - gt.z) * 0.15, gt.x, gt.y + 6, gt.z); }
    case 'up': { const sk = plan.fault.halls[0]; const [cx, cz] = [p.fault.x, p.fault.z]; const y = p.chasm.yWide - 40; return { x: cx + (sk.x - cx) * 0.2, y, z: cz + (sk.z - cz) * 0.2, yaw: 0, pitch: 1.2 }; }
    case 'chasm': { const y = Number(params.get('y') || -1300); const [cx, cz] = [p.fault.x, p.fault.z]; return look(cx, y, cz, cx + 100, y - 60, cz); }
    default: return { x: plan.spawn.x, y: plan.spawn.y + 1.7, z: plan.spawn.z, yaw: plan.spawn.yaw, pitch: -0.1 };
  }
}

async function debugStart() {
  const seed = params.get('seed') || '12345';
  const settings = { viewDistance: Number(params.get('vd') || 1.0), shadows: params.get('shadows') !== '0', pixelRatio: 1 };
  const ui = document.getElementById('ui');
  ui.innerHTML = '<div id="dbg" style="position:fixed;left:8px;top:8px;color:#fff;font:12px monospace;text-shadow:0 0 3px #000;z-index:10"></div>';
  const dbg = document.getElementById('dbg');
  const game = new Game(canvas, settings, {
    onProgress: (stage, p) => { dbg.textContent = `${stage} ${(p * 100).toFixed(0)}%`; },
    onWorldReady: (g) => {
      const cam = (params.get('cam') || '').split(',').map(Number);
      const plan = g.plan;
      let pose;
      if (cam.length >= 3 && cam.every((v) => !Number.isNaN(v))) pose = { x: cam[0], y: cam[1], z: cam[2], yaw: cam[3] || 0, pitch: cam[4] || 0 };
      else pose = namedPose(g, params.get('loc') || 'spawn');
      if (params.get('play')) {
        const pl = new Player(g);
        pl.spawn(pose.x, pose.y - 1.7, pose.z, pose.yaw);
        pl.pitch = pose.pitch;
        g.player = pl;
        g.grapple = new Grapple(g, pl);
        pl.grapple = g.grapple;
        g.systems.push(pl, g.grapple);
      } else {
        g.debugCam = new DebugCamera(g, pose);
        g.systems.push(g.debugCam);
      }
      g.camera.position.set(pose.x, pose.y, pose.z);
      g.camera.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
      if (params.get('time')) g.timeOfDay = Number(params.get('time'));
      canvas.addEventListener('click', () => g.input.lock());
    },
  });
  window.__descents = game;
  await game.start({ seed });
  setInterval(() => {
    const s = game.chunks.stats;
    const p = game.camera.position;
    dbg.textContent = `seed ${seed} | ${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)} | layer ${game.layerInfo?.layer} | chunks ${s.visible} tris ${(s.tris / 1e6).toFixed(2)}M pending ${s.pending} | evals ${game.world.evals}`;
  }, 250);
  window.__ready = true;
}

if (location.protocol !== 'file:' && params.get('bestiary')) {
  import('./ui/bestiaryView.js').then((m) => m.bestiary(canvas, params.get('seed') || '12345')).catch((e) => { console.error(e); window.__error = String(e.stack || e); });
} else if (location.protocol !== 'file:') {
  if (params.get('debug')) debugStart().catch((e) => { console.error(e); window.__error = String(e.stack || e); });
  else import('./ui/app.js').then((m) => m.boot(canvas)).catch((e) => { console.error(e); window.__error = String(e.stack || e); });
}

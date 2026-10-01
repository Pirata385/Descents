// Save system. An expedition save holds the world seed (the world itself is
// regenerated deterministically from it) plus everything that changed:
// explorer state, discoveries, artifacts, map exploration, ecosystem
// populations and statistics. Saves live in localStorage and can be exported
// to / imported from JSON files.
export const SAVE_VERSION = 1;
const INDEX_KEY = 'descents.saves.v1';
const SLOT_PREFIX = 'descents.save.v1.';

function readIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]'); } catch { return []; }
}

function writeIndex(list) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(list)); } catch (e) { console.warn('save index', e); }
}

/** Gzip + base64 when the browser supports CompressionStream. */
async function pack(obj) {
  const json = JSON.stringify(obj);
  if (typeof CompressionStream === 'undefined') return 'J' + json;
  try {
    const cs = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = new Uint8Array(await new Response(cs).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return 'Z' + btoa(s);
  } catch {
    return 'J' + json;
  }
}

async function unpack(str) {
  if (!str) return null;
  if (str[0] === 'J') return JSON.parse(str.slice(1));
  if (str[0] === 'Z') {
    const bin = atob(str.slice(1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(ds).text());
  }
  return JSON.parse(str);
}

export const SaveStore = {
  list() { return readIndex().sort((a, b) => b.time - a.time); },

  latest() { return this.list()[0] || null; },

  async load(id) {
    try { return await unpack(localStorage.getItem(SLOT_PREFIX + id)); } catch (e) { console.warn('load failed', e); return null; }
  },

  async write(save) {
    const data = await pack(save);
    const meta = { id: save.id, name: save.name, seedLabel: save.seedLabel, time: save.time, depth: save.summary.depth, layer: save.summary.layer, species: save.summary.species, artifacts: save.summary.artifacts, playTime: save.gameTime, auto: !!save.auto };
    const tryWrite = () => { localStorage.setItem(SLOT_PREFIX + save.id, data); };
    try {
      tryWrite();
    } catch {
      // out of space: drop the oldest autosaves of other expeditions and retry
      const list = readIndex().filter((m) => m.id !== save.id).sort((a, b) => a.time - b.time);
      for (const m of list) {
        if (!m.auto) continue;
        localStorage.removeItem(SLOT_PREFIX + m.id);
        writeIndex(readIndex().filter((x) => x.id !== m.id));
        try { tryWrite(); break; } catch { /* keep trying */ }
      }
      tryWrite();
    }
    const index = readIndex().filter((m) => m.id !== save.id);
    index.push(meta);
    writeIndex(index);
    return meta;
  },

  remove(id) {
    localStorage.removeItem(SLOT_PREFIX + id);
    writeIndex(readIndex().filter((m) => m.id !== id));
  },
};

/** Gather the state of a running game. */
export function captureSave(game, { id, name, auto = false } = {}) {
  const p = game.player;
  const info = game.layerInfo || { layer: 0 };
  return {
    version: SAVE_VERSION,
    id: id || game.saveId || `exp-${Date.now().toString(36)}`,
    name: name || game.expeditionName || `Expedition ${game.seedLabel}`,
    auto,
    seed: game.plan.seed,
    seedLabel: game.seedLabel,
    time: Date.now(),
    gameTime: game.gameTime,
    timeOfDay: game.timeOfDay,
    player: p.serialize(),
    grapple: game.grapple.serialize(),
    artifacts: game.artifacts.serialize(),
    discovery: game.discovery.serialize(),
    map: game.mapData.serialize(),
    ecosystem: game.ecosystem.serialize(),
    summary: { depth: Math.round(Math.max(0, -p.pos.y)), layer: info.layer, species: game.discovery.species.size, artifacts: game.artifacts.collected.size },
  };
}

/** Apply a save to a freshly started game (same seed). */
export function applySave(game, save) {
  if (!save) return;
  game.saveId = save.id;
  game.expeditionName = save.name;
  game.gameTime = save.gameTime || 0;
  game.timeOfDay = save.timeOfDay ?? 9;
  game.player.restore(save.player);
  game.discovery.restore(save.discovery);
  game.artifacts.restore(save.artifacts);
  game.mapData.restore(save.map);
  game.ecosystem.restore(save.ecosystem);
}

export function exportSave(save) {
  const blob = new Blob([JSON.stringify(save)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `descents-${(save.seedLabel || 'world').replace(/[^\w-]+/g, '_')}-${new Date(save.time).toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function validateSave(obj) {
  return obj && typeof obj === 'object' && obj.version === SAVE_VERSION && obj.seed !== undefined && obj.player && typeof obj.player.x === 'number';
}

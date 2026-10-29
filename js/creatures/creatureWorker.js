// Builds creature skins off the main thread: the metaball field and its
// surface (sdfmesh.js) are the costly part of a new creature.
import { meshParts } from './sdfmesh.js';

self.onmessage = (e) => {
  const { id, desc } = e.data;
  let mesh = null;
  try { mesh = meshParts(desc); } catch (err) { self.postMessage({ id, mesh: null, error: String(err) }); return; }
  self.postMessage({ id, mesh }, [mesh.pos.buffer, mesh.nrm.buffer, mesh.col.buffer, mesh.glow.buffer, mesh.skin.buffer, mesh.wts.buffer, mesh.idx.buffer]);
};

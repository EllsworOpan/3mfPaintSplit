import { import3mf, export3mf } from './three-mf.js';
import { splitMesh } from './geometry.js';
import { demoProject } from './demo.js';

let project = null,
  pieces = [],
  history = [],
  serial = 0;
function snapshot() {
  return { ...project, pieces, undoCount: history.length };
}
onmessage = ({ data }) => {
  const { id, action } = data;
  try {
    let result;
    if (action === 'restore') {
      project = data.project;
      pieces = project.pieces;
      history = [];
      serial = Math.max(...pieces.map((p) => p.id));
      result = snapshot();
    } else if (action === 'import' || action === 'demo') {
      const next =
        action === 'demo'
          ? demoProject()
          : import3mf(data.buffer, data.filename, (message) =>
              postMessage({ id, progress: message }),
            );
      project = next;
      pieces = next.pieces.map((p) => ({ ...p, id: ++serial }));
      history = [];
      result = snapshot();
    } else if (action === 'cut') {
      const selected = pieces.find((p) => p.id === data.pieceId);
      if (!selected) throw new Error('Select a piece first.');
      const cut = splitMesh(selected, data.normal, data.offset, data.capMaterial).map((p) => ({
        ...p,
        id: ++serial,
      }));
      if (history.length >= 12) history.shift();
      history.push(pieces);
      pieces = pieces.flatMap((p) => (p.id === selected.id ? cut : [p]));
      result = snapshot();
      result.selectedId = cut[0].id;
    } else if (action === 'undo') {
      if (history.length) pieces = history.pop();
      result = snapshot();
    } else if (action === 'export') {
      const selected = pieces.filter((p) => data.ids.includes(p.id));
      const bytes = export3mf(selected, data.palette);
      postMessage({ id, result: bytes }, [bytes.buffer]);
      return;
    } else throw new Error('Unknown operation.');
    postMessage({ id, result });
  } catch (error) {
    postMessage({ id, error: error.message || String(error) });
  }
};

import './style.css';
import { Viewer } from './viewer.js';
import { bounds, dot } from './geometry.js';

const $ = (id) => document.getElementById(id);
let project = null,
  selectedId = null,
  busy = false,
  requestId = 0,
  worker,
  pending = new Map(),
  planeNormal = [0, 0, 1],
  planeOffset = 0,
  offsetRange = [-25, 25];
function startWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.progress) {
      $('busy-message').textContent = data.progress;
      return;
    }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
  };
  worker.onerror = () => {
    for (const p of pending.values())
      p.reject(new Error('The model worker stopped. Try a smaller file or reload the app.'));
    pending.clear();
  };
}
startWorker();
function request(action, data = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, action, ...data }, transfer);
  });
}
function toast(message, error = false) {
  $('toast-message').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
}
$('dismiss-toast').onclick = () => ($('toast').hidden = true);
let viewer;
try {
  viewer = new Viewer($('canvas-host'), (normal, offset) => {
    planeNormal = normal;
    planeOffset = offset;
    const center = bounds([selectedPiece()]).center;
    $('offset').value = (offset - dot(normal, center)).toFixed(2);
    $('tilt').value = ((Math.acos(Math.max(-1, Math.min(1, normal[2]))) * 180) / Math.PI).toFixed(
      1,
    );
    $('azimuth').value = ((Math.atan2(normal[1], normal[0]) * 180) / Math.PI).toFixed(1);
    syncRange();
    syncAxes();
  });
} catch {
  toast(
    'This browser could not start the 3D viewer. Enable WebGL / hardware acceleration and reload.',
    true,
  );
}
const selectedPiece = () => project?.pieces.find((p) => p.id === selectedId);
function setBusy(value, message = 'Working…') {
  busy = value;
  $('busy-overlay').hidden = !value;
  $('busy-message').textContent = message;
  document
    .querySelectorAll('.inspector button,.inspector input,.inspector select')
    .forEach((el) => (el.disabled = value || !project));
  $('undo').disabled = value || !project?.undoCount;
  $('open-button').disabled = value;
  $('empty-open').disabled = value;
  $('demo-button').disabled = value;
}
async function run(message, fn) {
  if (busy) return;
  setBusy(true, message);
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    setBusy(false);
  }
}
function syncAxes() {
  const axis = planeNormal.findIndex((x) => Math.abs(x - 1) < 0.001);
  document
    .querySelectorAll('[data-axis]')
    .forEach((el) => el.classList.toggle('active', el.dataset.axis === 'XYZ'[axis]));
}
function syncRange() {
  const piece = selectedPiece();
  if (!piece) return;
  const center = bounds([piece]).center;
  let lo = Infinity,
    hi = -Infinity;
  for (const p of piece.vertices) {
    const d = dot(planeNormal, p) - dot(planeNormal, center);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  offsetRange = [lo, hi];
  $('offset-slider').min = lo.toFixed(3);
  $('offset-slider').max = hi.toFixed(3);
  $('offset-slider').step = Math.max(0.001, (hi - lo) / 1000);
  $('offset-slider').value = $('offset').value;
}
function updatePlane(reset = false) {
  if (!project) return;
  const tilt = (Number($('tilt').value) * Math.PI) / 180,
    az = (Number($('azimuth').value) * Math.PI) / 180;
  planeNormal = [Math.sin(tilt) * Math.cos(az), Math.sin(tilt) * Math.sin(az), Math.cos(tilt)];
  const center = bounds([selectedPiece()]).center;
  if (reset) $('offset').value = 0;
  planeOffset = dot(planeNormal, center) + Number($('offset').value);
  syncRange();
  syncAxes();
  viewer?.setPlane(
    planeNormal,
    planeOffset,
    center,
    $('show-plane').checked && Number($('explode').value) === 0,
  );
}
function selectPiece(id) {
  selectedId = id;
  $('piece-select').value = id;
  viewer?.select(id);
  $('explode').value = 0;
  setExplode();
  updatePlane(true);
  renderPieces();
}
function renderPieces() {
  $('piece-count').textContent = project.pieces.length;
  $('export-count').textContent =
    $('export-scope').value === 'selected' ? 1 : project.pieces.length;
  $('piece-list').replaceChildren();
  for (const piece of project.pieces) {
    const button = document.createElement('button');
    button.className = 'piece-row' + (piece.id === selectedId ? ' selected' : '');
    button.setAttribute('aria-pressed', piece.id === selectedId);
    button.disabled = busy;
    const marker = document.createElement('span');
    marker.className = 'piece-marker';
    marker.textContent = '◇';
    const content = document.createElement('span');
    content.className = 'piece-content';
    const name = document.createElement('span');
    name.className = 'piece-name';
    name.textContent = piece.name;
    name.title = piece.name;
    const info = document.createElement('span');
    info.className = 'piece-info';
    info.textContent =
      bounds([piece])
        .size.map((n) => n.toFixed(1))
        .join(' × ') + ' mm';
    content.append(name, info);
    const health = document.createElement('span');
    health.className = 'piece-status' + (piece.health.closed ? '' : ' bad');
    health.textContent = piece.health.closed ? 'CLOSED' : 'CHECK';
    health.title = piece.health.closed
      ? 'Closed, consistently oriented mesh'
      : `${piece.health.boundary} open edges; ${piece.health.nonmanifold} non-manifold edges; ${piece.health.inconsistent} inconsistent edges`;
    button.append(marker, content, health);
    button.onclick = () => selectPiece(piece.id);
    $('piece-list').append(button);
  }
}
function renderProject(next, fit = true) {
  const oldPalette = project?.palette;
  project = next;
  if (!fit && oldPalette) project.palette = oldPalette;
  selectedId = next.selectedId || next.pieces[0].id;
  $('empty-state').hidden = true;
  $('view-toolbar').hidden = false;
  $('demo-tag').hidden = !project.demo;
  $('model-title').textContent = project.filename;
  const count = project.pieces.reduce((sum, p) => sum + p.faces.length, 0);
  $('model-detail').textContent =
    `${count.toLocaleString()} triangles · ${project.palette.length} materials · millimeters`;
  $('view-hint').textContent = 'Drag to orbit · Right-drag to pan · Scroll to zoom';
  $('piece-select').replaceChildren();
  for (const p of project.pieces) {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = p.name;
    $('piece-select').append(option);
  }
  $('piece-select').value = selectedId;
  $('cap-material').replaceChildren();
  $('palette').replaceChildren();
  for (let i = 0; i < project.palette.length; i++) {
    const option = document.createElement('option');
    option.value = i + 1;
    option.textContent = `Material ${i + 1}`;
    $('cap-material').append(option);
    const label = document.createElement('label');
    label.className = 'swatch';
    label.title = `Material ${i + 1} display and export color`;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = project.palette[i];
    input.setAttribute('aria-label', `Material ${i + 1} color`);
    input.oninput = () => {
      project.palette[i] = input.value;
      viewer?.setPalette(project.palette);
    };
    label.append(input, document.createTextNode(String(i + 1)));
    $('palette').append(label);
  }
  $('material-count').textContent = `${project.palette.length} slots`;
  $('explode').value = 0;
  $('explode-value').value = '0 mm';
  viewer?.setExplode(0);
  viewer?.load(project.pieces, project.palette, selectedId, fit);
  renderPieces();
  updatePlane(true);
}
function openFile(file) {
  if (!file || busy) return;
  if (!/\.3mf$/i.test(file.name)) {
    toast('Choose a .3mf model file.', true);
    return;
  }
  run('Reading 3MF and resolving paint…', async () => {
    const buffer = await file.arrayBuffer();
    const next = await request('import', { buffer, filename: file.name }, [buffer]);
    renderProject(next);
    toast(
      next.warnings.length
        ? next.warnings.join(' ')
        : 'Model loaded. Position the plane to make your first cut.',
      next.warnings.length > 0,
    );
  });
}
for (const id of ['open-button', 'empty-open']) $(id).onclick = () => $('file-input').click();
$('file-input').onchange = (e) => {
  openFile(e.target.files[0]);
  e.target.value = '';
};
$('demo-button').onclick = () =>
  run('Loading painted demo…', async () => {
    renderProject(await request('demo'));
    toast('Demo loaded. Try a cut, separate the preview, and export the pieces.');
  });
$('piece-select').onchange = (e) => selectPiece(Number(e.target.value));
document.querySelectorAll('[data-axis]').forEach(
  (el) =>
    (el.onclick = () => {
      const axis = el.dataset.axis;
      $('tilt').value = axis === 'Z' ? 0 : 90;
      $('azimuth').value = axis === 'Y' ? 90 : 0;
      assemble();
      updatePlane(true);
    }),
);
function assemble() {
  $('explode').value = 0;
  setExplode();
}
for (const id of ['offset', 'tilt', 'azimuth'])
  $(id).oninput = () => {
    assemble();
    updatePlane();
  };
$('offset-slider').oninput = (e) => {
  $('offset').value = Number(e.target.value).toFixed(3);
  assemble();
  updatePlane();
};
$('center').onclick = () => {
  assemble();
  updatePlane(true);
};
$('show-plane').onchange = () => {
  assemble();
  updatePlane();
};
for (const [id, mode] of [
  ['move-mode', 'translate'],
  ['rotate-mode', 'rotate'],
])
  $(id).onclick = () => {
    assemble();
    viewer?.setMode(mode);
    $('move-mode').classList.toggle('active', mode === 'translate');
    $('rotate-mode').classList.toggle('active', mode === 'rotate');
  };
function setExplode() {
  const value = Number($('explode').value);
  $('explode-value').value = `${value} mm`;
  viewer?.setExplode(value);
  if (project)
    viewer?.setPlane(
      planeNormal,
      planeOffset,
      bounds([selectedPiece()]).center,
      $('show-plane').checked && value === 0,
    );
}
$('explode').oninput = setExplode;
$('cut-button').onclick = () =>
  run('Cutting painted surfaces and closing both halves…', async () => {
    const capMaterial = Number($('cap-material').value);
    const next = await request('cut', {
      pieceId: selectedId,
      normal: planeNormal,
      offset: planeOffset,
      capMaterial,
    });
    renderProject(next, false);
    $('cap-material').value = capMaterial;
    toast('Cut complete. Both pieces are closed. Select either piece to cut again.');
  });
$('undo').onclick = () => {
  if (project?.undoCount)
    run('Restoring the previous cut…', async () => {
      renderProject(await request('undo'), false);
      toast('Last cut undone.');
    });
};
$('export-scope').onchange = renderPieces;
$('export-button').onclick = () =>
  run('Saving geometry and native paint assignments…', async () => {
    const ids =
        $('export-scope').value === 'selected' ? [selectedId] : project.pieces.map((p) => p.id),
      bytes = await request('export', { ids, palette: project.palette });
    const url = URL.createObjectURL(new Blob([bytes], { type: 'model/3mf' })),
      link = document.createElement('a');
    link.href = url;
    link.download =
      project.filename.replace(/\.3mf$/i, '') + (ids.length === 1 ? '-piece' : '-split') + '.3mf';
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(
      'Painted 3MF download prepared. Keep material slots in the same order in PrusaSlicer.',
    );
  });
$('cancel').onclick = () => {
  worker.terminate();
  for (const p of pending.values()) p.reject(new Error('Operation cancelled.'));
  pending.clear();
  startWorker();
  if (project) {
    request('restore', { project }).then((next) => {
      renderProject(next, false);
      setBusy(false);
      toast('Operation cancelled. Current pieces kept; undo history cleared.');
    });
    return;
  }
  selectedId = null;
  $('empty-state').hidden = false;
  $('view-toolbar').hidden = true;
  $('model-title').textContent = 'Your next clean cut.';
  $('model-detail').textContent = 'Painted surfaces. Separate pieces.';
  $('piece-list').replaceChildren();
  $('palette').replaceChildren();
  $('piece-count').textContent = '0';
  $('demo-tag').hidden = true;
  viewer?.transform.detach();
  if (viewer) {
    viewer.plane.visible = false;
    for (const m of viewer.meshes.values()) {
      viewer.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    viewer.meshes.clear();
  }
  setBusy(false);
};
$('fit').onclick = () => viewer?.fit();
document.querySelectorAll('[data-view]').forEach(
  (el) =>
    (el.onclick = () => {
      viewer?.fit(el.dataset.view);
      document
        .querySelectorAll('[data-view]')
        .forEach((b) => b.classList.toggle('active', b === el));
    }),
);
$('wireframe').onclick = () => {
  const value = $('wireframe').getAttribute('aria-pressed') !== 'true';
  $('wireframe').setAttribute('aria-pressed', value);
  viewer?.setWireframe(value);
};
$('help-button').onclick = () => $('help-dialog').showModal();
$('close-help').onclick = () => $('help-dialog').close();
$('help-dialog').onclick = (e) => {
  if (e.target === $('help-dialog')) {
    const b = e.target.getBoundingClientRect();
    if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom)
      e.target.close();
  }
};
document.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || $('help-dialog').open) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (!busy) $('undo').click();
  } else if (e.key.toLowerCase() === 'f') viewer?.fit();
  else if (e.key.toLowerCase() === 'c' && !busy) $('cut-button').click();
});
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (e.dataTransfer.types.includes('Files')) {
    dragDepth++;
    $('drop-overlay').hidden = false;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) $('drop-overlay').hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  openFile(e.dataTransfer.files[0]);
});

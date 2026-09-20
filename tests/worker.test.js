import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { import3mf, export3mf } from '../src/three-mf.js';
import { cubeMesh } from '../src/demo.js';
import { paintedSquare, PALETTE } from './helpers/painted-square.js';
import { assertPaintAtOriginalPositions } from './helpers/spatial-assertions.js';

function session(t) {
  const worker = new Worker(new URL('./helpers/worker-harness.js', import.meta.url));
  t.after(() => worker.terminate());
  let serial = 0;
  const pending = new Map();
  worker.on('message', (message) => {
    if (message.progress) return;
    const p = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) p.reject(new Error(message.error));
    else p.resolve(message.result);
  });
  worker.on('error', (error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  });
  return (action, data = {}) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, action, ...data });
    });
}
const load = (rpc) => rpc('import', { buffer: paintedSquare(), filename: 'complex.3mf' });

test('actual worker imports complex paint, cuts it, and exports only the selected piece', async (t) => {
  const rpc = session(t),
    source = await load(rpc),
    normal = [1, 2, 0],
    offset = 37.3;
  const result = await rpc('cut', { pieceId: source.pieces[0].id, normal, offset, capMaterial: 5 });
  assert.equal(result.pieces.length, 2);
  assert.equal(result.undoCount, 1);
  assert.ok(result.pieces.some((p) => p.id === result.selectedId));
  const bytes = await rpc('export', { ids: [result.pieces[1].id], palette: PALETTE });
  const exported = import3mf(bytes);
  assert.equal(exported.pieces.length, 1);
  assertPaintAtOriginalPositions(exported.pieces[0], [{ normal, offset, sign: -1 }]);
  const undone = await rpc('undo');
  assert.deepEqual(undone.pieces, source.pieces);
  assert.equal(undone.undoCount, 0);
});
test('failed worker cuts, imports, and exports leave current pieces and history intact', async (t) => {
  const rpc = session(t),
    source = await load(rpc);
  const cut = await rpc('cut', {
    pieceId: source.pieces[0].id,
    normal: [1, 0, 0],
    offset: 13.375,
    capMaterial: 5,
  });
  await assert.rejects(
    rpc('cut', { pieceId: cut.pieces[0].id, normal: [1, 0, 0], offset: 100, capMaterial: 5 }),
    /interior/,
  );
  await assert.rejects(rpc('import', { buffer: new Uint8Array([1, 2, 3]), filename: 'bad.3mf' }));
  await assert.rejects(rpc('export', { ids: [], palette: PALETTE }), /Select/);
  await assert.rejects(rpc('cut', { pieceId: -1, normal: [1, 0, 0], offset: 1 }), /Select/);
  const preserved = import3mf(
    await rpc('export', { ids: cut.pieces.map((p) => p.id), palette: PALETTE }),
  );
  assert.equal(preserved.pieces.length, 2);
  assertPaintAtOriginalPositions(preserved.pieces[0], [
    { normal: [1, 0, 0], offset: 13.375, sign: 1 },
  ]);
  assert.deepEqual((await rpc('undo')).pieces, source.pieces);
});
test('worker retains twelve undo steps and stable IDs without mutating snapshots', async (t) => {
  const rpc = session(t),
    buffer = export3mf([cubeMesh()], PALETTE);
  let state = await rpc('import', { buffer, filename: 'cube.3mf' });
  const snapshots = [state];
  for (let i = 0; i < 13; i++) {
    const piece = state.pieces[0],
      xs = piece.vertices.map((p) => p[0]);
    const offset = (Math.min(...xs) + Math.max(...xs)) / 2;
    state = await rpc('cut', { pieceId: piece.id, normal: [1, 0, 0], offset, capMaterial: 1 });
    snapshots.push(state);
    assert.equal(new Set(state.pieces.map((p) => p.id)).size, state.pieces.length);
  }
  assert.equal(state.undoCount, 12);
  assert.equal(state.pieces.length, 14);
  for (let i = 12; i >= 1; i--) {
    state = await rpc('undo');
    assert.deepEqual(state.pieces, snapshots[i].pieces);
  }
  assert.equal(state.undoCount, 0);
  assert.equal(state.pieces.length, 2);
  assert.deepEqual((await rpc('undo')).pieces, state.pieces);
});
test('worker restore preserves pieces, clears history, and allocates fresh IDs', async (t) => {
  const rpc = session(t),
    source = await load(rpc);
  const cut = await rpc('cut', {
    pieceId: source.pieces[0].id,
    normal: [1, 0, 0],
    offset: 13.375,
    capMaterial: 5,
  });
  const restored = await rpc('restore', { project: cut });
  assert.deepEqual(restored.pieces, cut.pieces);
  assert.equal(restored.undoCount, 0);
  const next = await rpc('cut', {
    pieceId: restored.pieces[0].id,
    normal: [0, 1, 0],
    offset: 16,
    capMaterial: 5,
  });
  assert.equal(next.pieces.length, 3);
  assert.equal(new Set(next.pieces.map((p) => p.id)).size, 3);
});

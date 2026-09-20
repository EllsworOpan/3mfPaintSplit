import test from 'node:test';
import assert from 'node:assert/strict';
import { cubeMesh } from '../src/demo.js';
import { splitMesh, makeMesh, meshHealth } from '../src/geometry.js';
import { import3mf } from '../src/three-mf.js';
import { paintedSquare } from './helpers/painted-square.js';
import { assertPaintAtOriginalPositions } from './helpers/spatial-assertions.js';

test('deterministic oblique plane sweep preserves complex paint and closed halves', () => {
  const mesh = import3mf(paintedSquare()).pieces[0];
  let seed = 47393;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let i = 0; i < 32; i++) {
    const normal = [random() * 2 - 1, random() * 2 - 1, random() * 0.8 - 0.4];
    const offset = normal[0] * 16 + normal[1] * 16 + normal[2] * 4 + (random() - 0.5) * 3;
    const pieces = splitMesh(mesh, normal, offset, 5);
    for (let side = 0; side < 2; side++) {
      assert.ok(pieces[side].health.closed);
      assertPaintAtOriginalPositions(pieces[side], [{ normal, offset, sign: side === 0 ? 1 : -1 }]);
    }
    assert.ok(Math.abs(pieces[0].health.volume + pieces[1].health.volume - 8192) < 1e-5);
  }
});
test('scaling a plane equation does not change the cut geometry', () => {
  const mesh = cubeMesh(),
    a = splitMesh(mesh, [1, 2, 3], 1.125),
    b = splitMesh(mesh, [10, 20, 30], 11.25);
  for (let i = 0; i < 2; i++) {
    assert.equal(a[i].faces.length, b[i].faces.length);
    assert.ok(Math.abs(a[i].health.volume - b[i].health.volume) < 1e-8);
  }
});
for (const scale of [0.01, 1, 100])
  test(`closed cuts preserve volume at geometry scale ${scale}`, () => {
    const mesh = cubeMesh();
    mesh.vertices = mesh.vertices.map((p) => p.map((v, i) => v * scale + [37, -19, 8][i]));
    const normal = [1, 2, 3],
      offset = 37 - 38 + 24 + 0.321 * scale;
    const pieces = splitMesh(mesh, normal, offset);
    assert.ok(pieces.every((p) => p.health.closed));
    assert.ok(
      Math.abs(pieces.reduce((s, p) => s + p.health.volume, 0) - 8000 * scale ** 3) <
        Math.max(1e-5, 8000 * scale ** 3 * 1e-7),
    );
  });
test('nested island inside a hollow solid is capped as solid, hole, then solid', () => {
  const triangles = [];
  for (const [size, reverse] of [
    [20, false],
    [12, true],
    [4, false],
  ]) {
    const mesh = cubeMesh(size);
    for (const f of mesh.faces)
      triangles.push({
        v: (reverse ? [...f.v].reverse() : f.v).map((i) => mesh.vertices[i]),
        material: 1,
      });
  }
  const mesh = makeMesh(triangles),
    volume = 8000 - 1728 + 64;
  assert.ok(meshHealth(mesh).closed);
  for (const p of splitMesh(mesh, [0, 0, 1], 0)) {
    assert.ok(p.health.closed);
    assert.ok(Math.abs(p.health.volume - volume / 2) < 1e-7);
  }
});
for (const [label, normal, offset, material] of [
  ['zero normal', [0, 0, 0], 0, 1],
  ['nonfinite normal', [NaN, 0, 1], 0, 1],
  ['short normal', [1, 0], 0, 1],
  ['long normal', [1, 0, 0, 1], 0, 1],
  ['nonfinite offset', [1, 0, 0], Infinity, 1],
  ['zero material', [1, 0, 0], 0, 0],
  ['fractional material', [1, 0, 0], 0, 1.5],
  ['out-of-range material', [1, 0, 0], 0, 256],
])
  test(`invalid ${label} rejects without mutating the source`, () => {
    const mesh = cubeMesh(),
      before = JSON.stringify(mesh);
    assert.throws(() => splitMesh(mesh, normal, offset, material));
    assert.equal(JSON.stringify(mesh), before);
  });

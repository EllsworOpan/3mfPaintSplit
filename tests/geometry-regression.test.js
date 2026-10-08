import test from 'node:test';
import assert from 'node:assert/strict';
import earcut from 'earcut';
import { cubeMesh } from '../src/demo.js';
import { splitMesh, makeMesh, meshHealth, dot, cross, sub, length } from '../src/geometry.js';
import { import3mf, export3mf } from '../src/three-mf.js';
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

// Detailed contours can have real bends much smaller than the vertex-weld
// tolerance. Use a painted prism so cap area, side paint, and volume have
// independent oracles without bundling a user's model.
function shallowContourPrism(ring) {
  const triangles = [],
    at = (i, z) => [124 + ring[i][0], 102.5 + ring[i][1], z],
    tris = earcut(ring.flat());
  for (let i = 0; i < tris.length; i += 3) {
    const ids = tris.slice(i, i + 3);
    triangles.push(
      { v: ids.map((i) => at(i, 2)), material: 1 },
      { v: ids.reverse().map((i) => at(i, 0)), material: 1 },
    );
  }
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length,
      material = 2 + (i % 3);
    triangles.push(
      { v: [at(i, 0), at(j, 0), at(j, 2)], material },
      { v: [at(i, 0), at(j, 2), at(i, 2)], material },
    );
  }
  return makeMesh(triangles);
}
function surfaceAreas(mesh) {
  const areas = new Map();
  for (const f of mesh.faces) {
    if (f.cap) continue;
    const [a, b, c] = f.v.map((i) => mesh.vertices[i]);
    areas.set(f.material, (areas.get(f.material) || 0) + length(cross(sub(b, a), sub(c, a))) / 2);
  }
  return areas;
}
for (const [label, ring] of [
  [
    'a long shallow curved chain',
    [...Array.from({ length: 41 }, (_, i) => [i, 2e-7 * i * i]), [40, 10], [0, 10]],
  ],
  [
    'nearly collinear triangulation chords',
    [
      [0, 0],
      [2, 0],
      [4, 1e-7],
      [6, 3e-7],
      [8, 6e-7],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
  ],
  [
    'thin triangles with essential boundary edges',
    [
      [0, 0],
      [1e-5, 0],
      [2e-5, 2e-10],
      [3e-5, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
  ],
]) {
  test('caps preserve ' + label + ' without gaps or overlapping edges', () => {
    const mesh = shallowContourPrism(ring),
      before = JSON.stringify(mesh),
      health = meshHealth(mesh),
      capArea = health.volume / 2,
      pieces = splitMesh(mesh, [0, 0, 1], 0.5, 5);
    assert.ok(health.closed);
    assert.equal(JSON.stringify(mesh), before);
    for (const [side, piece] of pieces.entries()) {
      assert.ok(piece.health.closed);
      assert.ok(Math.abs(piece.health.volume - health.volume * (side === 0 ? 0.75 : 0.25)) < 1e-8);
      let area = 0;
      for (const f of piece.faces.filter((f) => f.cap)) {
        assert.equal(f.material, 5);
        const [a, b, c] = f.v.map((i) => piece.vertices[i]),
          normal = cross(sub(b, a), sub(c, a));
        assert.ok(dot(normal, [0, 0, side === 0 ? -1 : 1]) > 0);
        assert.ok(f.v.every((i) => piece.vertices[i][2] === 0.5));
        area += length(normal) / 2;
      }
      assert.ok(Math.abs(area - capArea) < 1e-8);
    }
    const after = new Map();
    for (const piece of pieces)
      for (const [material, area] of surfaceAreas(piece))
        after.set(material, (after.get(material) || 0) + area);
    for (const [material, area] of surfaceAreas(mesh))
      assert.ok(Math.abs(after.get(material) - area) < 1e-8);
    const roundtrip = import3mf(
      export3mf(pieces, ['#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#888888']),
    );
    assert.ok(roundtrip.pieces.every((p) => p.health.closed));
    for (let i = 0; i < pieces.length; i++) {
      assert.deepEqual(
        roundtrip.pieces[i].faces.filter((f) => f.material !== 5).map((f) => f.material),
        pieces[i].faces.filter((f) => !f.cap).map((f) => f.material),
      );
      assert.ok(Math.abs(roundtrip.pieces[i].health.volume - pieces[i].health.volume) < 1e-8);
    }
    assert.ok(splitMesh(pieces[0], [0, 0, 1], 1.25, 5).every((p) => p.health.closed));
  });
}

for (const [label, size, translation, volumes] of [
  ['overlapping solid shells', 14, [9, 2, 1], [5568, 5176]],
  ['nested solid shells', 8, [1, 2, 0], [4256, 4256]],
]) {
  test(label + ' stay solid while their cut contours are capped independently', () => {
    // Face order changes the first point of each contour. An overlapping shell
    // must remain solid whether that point lies inside or outside the other.
    for (const firstFace of [0, 4, 8]) {
      const cubes = [cubeMesh(20), cubeMesh(size)],
        triangles = [];
      cubes[1].vertices = cubes[1].vertices.map((p) => p.map((v, i) => v + translation[i]));
      for (const [i, cube] of cubes.entries())
        for (const f of [...cube.faces.slice(firstFace), ...cube.faces.slice(0, firstFace)])
          triangles.push({ v: f.v.map((k) => cube.vertices[k]), material: i + 1 });
      const mesh = makeMesh(triangles);
      assert.ok(meshHealth(mesh).closed);
      const pieces = splitMesh(mesh, [0, 0, 1], 0, 3);
      for (const [i, piece] of pieces.entries()) {
        assert.ok(piece.health.closed);
        assert.ok(Math.abs(piece.health.volume - volumes[i]) < 1e-8);
        const capArea = piece.faces
          .filter((f) => f.cap)
          .reduce((sum, f) => {
            const [a, b, c] = f.v.map((i) => piece.vertices[i]);
            return sum + length(cross(sub(b, a), sub(c, a))) / 2;
          }, 0);
        assert.ok(Math.abs(capArea - (400 + size * size)) < 1e-8);
      }
      const reloaded = import3mf(export3mf(pieces, ['#FF0000', '#0000FF', '#888888']));
      assert.ok(reloaded.pieces.every((p) => p.health.closed));
      assert.ok(splitMesh(pieces[0], [1, 2, 3], 10.37, 3).every((p) => p.health.closed));
    }
  });
}

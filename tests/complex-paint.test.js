import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { import3mf, export3mf } from '../src/three-mf.js';
import { splitMesh, meshHealth, dot, cross, sub } from '../src/geometry.js';
import { paintedSquare, PALETTE, SIZE, HEIGHT } from './helpers/painted-square.js';
import { assertPaintAtOriginalPositions, topFaces } from './helpers/spatial-assertions.js';

function assertSolid(mesh) {
  const health = meshHealth(mesh);
  assert.ok(health.closed, JSON.stringify(health));
  assert.ok(health.volume > 0);
  for (const f of mesh.faces) {
    assert.equal(new Set(f.v).size, 3);
    const [a, b, c] = f.v.map((i) => mesh.vertices[i]);
    assert.ok(Math.hypot(...cross(sub(b, a), sub(c, a))) > 1e-12, 'No zero-area triangles');
  }
}

test('the fixture has only two original mesh triangles on its complex painted square', () => {
  const xml = strFromU8(unzipSync(paintedSquare())['3D/3dmodel.model']);
  assert.equal((xml.match(/<triangle /g) || []).length, 12);
  assert.equal((xml.match(/mmu_segmentation=/g) || []).length, 2);
  assert.ok(xml.length > 1000);
});

for (const dialect of ['prusa', 'bambu'])
  for (const collapse of [false, true]) {
    test(`${dialect}: ${collapse ? 'adaptive' : 'uniform'} paint trees match independent XY paint regions`, () => {
      const project = import3mf(paintedSquare({ dialect, collapse }));
      assert.equal(project.sourceTriangles, 12);
      assert.equal(project.paintedTriangles, 2);
      const mesh = project.pieces[0];
      assertSolid(mesh);
      assert.ok(topFaces(mesh).length > 500, 'Paint expands far beyond the two original triangles');
      assertPaintAtOriginalPositions(mesh);
      assert.ok(Math.abs(mesh.health.volume - SIZE * SIZE * HEIGHT) < 1e-6);
    });
  }

const cases = [
  ['X through paint interiors', [1, 0, 0], 13.375],
  ['Y through paint interiors', [0, 1, 0], 19.625],
  ['diagonal through both original mesh triangles', [1, 2, 0], 37.3],
  ['tilted plane through paint triangles', [1, 1.7, 0.4], 41.9],
  ['plane along original diagonal', [1, -1, 0], 0],
  ['plane through paint vertices', [1, 0, 0], 16],
  ['plane very close to paint vertices', [1, 0, 0], 16.00001],
  ['thin edge piece', [1, 0, 0], 0.03125],
  ['horizontal plane below painted square', [0, 0, 1], 3.1],
  ['negative normal', [-1, -2, 0], -37.3],
];
for (const [label, normal, offset] of cases)
  test(`two-triangle square: ${label} preserves every paint region`, () => {
    const source = import3mf(paintedSquare()).pieces[0];
    const original = JSON.stringify(source);
    const halves = splitMesh(source, normal, offset, 5);
    for (let i = 0; i < halves.length; i++) {
      const sign = i === 0 ? 1 : -1,
        piece = halves[i];
      assertSolid(piece);
      assertPaintAtOriginalPositions(piece, [{ normal, offset, sign }]);
      const caps = piece.faces.filter((f) => f.cap);
      assert.ok(caps.length > 0);
      for (const cap of caps) {
        assert.equal(cap.material, 5);
        for (const index of cap.v)
          assert.ok(Math.abs(dot(piece.vertices[index], normal) - offset) < 1e-6);
        const [a, b, c] = cap.v.map((j) => piece.vertices[j]);
        assert.ok(dot(cross(sub(b, a), sub(c, a)), normal) * sign < 0, 'Caps face outward');
      }
    }
    assert.ok(Math.abs(halves.reduce((s, p) => s + p.health.volume, 0) - 8192) < 1e-5);
    assert.equal(JSON.stringify(source), original, 'Cut must not mutate source geometry or paint');
    const reimported = import3mf(export3mf(halves, PALETTE));
    reimported.pieces.forEach((piece, i) => {
      assertSolid(piece);
      assertPaintAtOriginalPositions(piece, [{ normal, offset, sign: i === 0 ? 1 : -1 }]);
    });
  });

test('repeated cuts through complex paint retain each region after export', () => {
  const source = import3mf(paintedSquare()).pieces[0];
  const first = { normal: [1, 2, 0], offset: 37.3 };
  const [a, b] = splitMesh(source, first.normal, first.offset, 5);
  const second = { normal: [-2, 1, 0.25], offset: -9.7 };
  const [aa, ab] = splitMesh(a, second.normal, second.offset, 5);
  const pieces = [aa, ab, b];
  const spaces = [
    [
      { ...first, sign: 1 },
      { ...second, sign: 1 },
    ],
    [
      { ...first, sign: 1 },
      { ...second, sign: -1 },
    ],
    [{ ...first, sign: -1 }],
  ];
  const reloaded = import3mf(export3mf(pieces, PALETTE));
  reloaded.pieces.forEach((p, i) => {
    assertSolid(p);
    assertPaintAtOriginalPositions(p, spaces[i]);
  });
  assert.ok(Math.abs(reloaded.pieces.reduce((s, p) => s + p.health.volume, 0) - 8192) < 1e-5);
});

test('spatial oracle rejects a color swap even when total material areas match', () => {
  const source = import3mf(paintedSquare({ collapse: false })).pieces[0];
  const a = source.faces.find(
    (f) => f.material === 1 && f.v.every((i) => source.vertices[i][2] === 8),
  );
  const b = source.faces.find(
    (f) => f.material === 2 && f.v.every((i) => source.vertices[i][2] === 8),
  );
  [a.material, b.material] = [b.material, a.material];
  assert.throws(() => assertPaintAtOriginalPositions(source), /paint boundary/);
});

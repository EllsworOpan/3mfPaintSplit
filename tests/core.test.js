import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { decodePaint, encodePaint, childrenOf } from '../src/paint.js';
import {
  bounds,
  makeMesh,
  meshHealth,
  splitMesh,
  conformPaint,
  cross,
  sub,
  length,
} from '../src/geometry.js';
import { import3mf, export3mf } from '../src/three-mf.js';
import { cubeMesh, demoProject } from '../src/demo.js';

const palette = ['#70C6B4', '#F2AD60', '#E9E4DA'];
const tri = [
  [0, 0, 0],
  [8, 0, 0],
  [0, 8, 0],
];
const area = (t) => length(cross(sub(t.v[1], t.v[0]), sub(t.v[2], t.v[0]))) / 2;
const near = (a, b, tol = 1e-7) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
const materialAreas = (mesh) => {
  const out = {};
  for (const f of mesh.faces)
    if (!f.cap)
      out[f.material] = (out[f.material] || 0) + area({ v: f.v.map((i) => mesh.vertices[i]) });
  return out;
};
function rewrite(bytes, fn) {
  const files = unzipSync(bytes);
  fn(files);
  return zipSync(files);
}

test('Prusa and Bambu material encodings include all extended material slots', () => {
  assert.equal(encodePaint(17), '00EC');
  assert.equal(encodePaint(18), '01EC');
  assert.equal(encodePaint(18, 'bambu'), '0FC');
  for (const dialect of ['prusa', 'bambu'])
    for (let state = 0; state <= 255; state++)
      assert.equal(
        decodePaint(tri, encodePaint(state, dialect), 2, dialect)[0].material,
        state || 2,
      );
});
test('real TriangleSelector order: one split uses reversed child serialization', () => {
  const decoded = decodePaint(tri, '481');
  assert.equal(decoded.length, 2);
  assert.deepEqual(decoded[0], {
    v: [
      [4, 4, 0],
      [0, 8, 0],
      [0, 0, 0],
    ],
    material: 2,
  });
  assert.deepEqual(decoded[1], {
    v: [
      [0, 0, 0],
      [8, 0, 0],
      [4, 4, 0],
    ],
    material: 1,
  });
});
test('all split sides and rotations preserve triangle area and nesting', () => {
  for (const sides of [1, 2, 3])
    for (const side of sides === 3 ? [0] : [0, 1, 2]) {
      const hex = '4'.repeat(sides + 1) + (sides + 4 * side).toString(16);
      const leaves = decodePaint(tri, hex);
      assert.equal(leaves.length, sides + 1);
      near(
        leaves.reduce((s, t) => s + area(t), 0),
        32,
      );
    }
  const nested = decodePaint(tri, '444434443');
  assert.equal(nested.length, 7);
  near(
    nested.reduce((s, t) => s + area(t), 0),
    32,
  );
});
test('malformed paint is rejected instead of discarding color', () => {
  for (const hex of ['Z', '1', 'C', '00EC4', 'F', '44447'])
    assert.throws(() => decodePaint(tri, hex));
});

test('legacy Texture2Paint dual attributes retain Bambu extended material numbers', () => {
  const cube = cubeMesh();
  cube.faces[0].material = 18;
  const colors = Array.from({ length: 18 }, (_, i) => palette[i % 3]);
  const bytes = rewrite(export3mf([cube], colors), (files) => {
    const source = strFromU8(files['3D/3dmodel.model'])
      .replace('MmPaintingVersion">2', 'MmPaintingVersion">1')
      .replace('mmu_segmentation="01EC"', 'mmu_segmentation="0FC"');
    files['3D/3dmodel.model'] = strToU8(source);
  });
  assert.equal(import3mf(bytes).pieces[0].faces[0].material, 18);
});
test('paint boundaries conform to neighboring triangles before cutting', () => {
  const cube = cubeMesh();
  let triangles = [];
  cube.faces.forEach((f, i) => {
    const v = f.v.map((k) => cube.vertices[k]);
    triangles.push(...(i === 0 ? decodePaint(v, '48483') : [{ v, material: f.material }]));
  });
  const mesh = makeMesh(conformPaint(triangles));
  assert.ok(meshHealth(mesh).closed);
  for (const n of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 2, 3],
  ]) {
    const halves = splitMesh(mesh, n, 1, 3);
    const before = materialAreas(mesh),
      after = {};
    for (const p of halves)
      for (const [k, a] of Object.entries(materialAreas(p))) after[k] = (after[k] || 0) + a;
    for (const [k, a] of Object.entries(before)) near(a, after[k], 1e-5);
    assert.ok(halves.every((p) => p.health.closed));
  }
});
test('axis and oblique cuts produce closed solids with conserved volumes and surface paint', () => {
  const cube = cubeMesh();
  for (const n of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 1],
    [1, 2, 3],
    [-3, 0.3, 1],
  ])
    for (const offset of [0, 1.234]) {
      const halves = splitMesh(cube, n, offset, 3);
      assert.ok(halves.every((p) => p.health.closed));
      near(
        halves.reduce((s, p) => s + p.health.volume, 0),
        8000,
        1e-4,
      );
      const before = materialAreas(cube),
        after = {};
      for (const p of halves)
        for (const [k, a] of Object.entries(materialAreas(p))) after[k] = (after[k] || 0) + a;
      for (const [k, a] of Object.entries(before)) near(a, after[k], 1e-5);
      assert.ok(halves.flatMap((p) => p.faces.filter((f) => f.cap)).every((f) => f.material === 3));
    }
});
test('multiple cuts stay closed and partition the original volume', () => {
  const [a, b] = splitMesh(cubeMesh(), [0, 0, 1], 0);
  const [aa, ab] = splitMesh(a, [1, 2, 0], 0, 2);
  near(aa.health.volume + ab.health.volume + b.health.volume, 8000, 1e-4);
  assert.ok([aa, ab, b].every((p) => p.health.closed));
});
test('hollow solids keep holes in their cut caps', () => {
  const outer = cubeMesh(20),
    inner = cubeMesh(10);
  const tris = [];
  for (const f of outer.faces) tris.push({ v: f.v.map((i) => outer.vertices[i]), material: 1 });
  for (const f of inner.faces)
    tris.push({ v: [...f.v].reverse().map((i) => inner.vertices[i]), material: 2 });
  const hollow = makeMesh(tris);
  near(meshHealth(hollow).volume, 7000);
  const halves = splitMesh(hollow, [0, 0, 1], 0);
  for (const half of halves) {
    assert.ok(half.health.closed);
    near(half.health.volume, 3500);
  }
});
test('nonconvex demo supports several disconnected cut contours', () => {
  const mesh = demoProject().pieces[0],
    pieces = splitMesh(mesh, [0, 0, 1], 30);
  assert.ok(pieces.every((p) => p.health.closed));
  near(
    pieces.reduce((s, p) => s + p.health.volume, 0),
    mesh.health.volume,
    1e-5,
  );
});
test('outside planes and open meshes reject without changing the original', () => {
  const mesh = cubeMesh(),
    before = JSON.stringify(mesh);
  assert.throws(() => splitMesh(mesh, [0, 0, 1], 30), /interior/);
  assert.equal(JSON.stringify(mesh), before);
  const open = { ...mesh, faces: mesh.faces.slice(1) };
  assert.throws(() => splitMesh(open, [0, 0, 1], 0), /Repair/);
});
test('3MF export/import preserves independent pieces, names, palette and material areas', () => {
  const pieces = splitMesh(cubeMesh(), [1, 2, 1], 0, 2);
  pieces[0].name = 'Painted <piece> & "A"';
  const result = import3mf(export3mf(pieces, palette));
  assert.equal(result.pieces.length, 2);
  assert.deepEqual(result.palette, palette);
  assert.equal(result.pieces[0].name, pieces[0].name);
  for (let i = 0; i < 2; i++) {
    assert.ok(result.pieces[i].health.closed);
    near(result.pieces[i].health.volume, pieces[i].health.volume);
    assert.deepEqual(
      result.pieces[i].faces.map((f) => f.material),
      pieces[i].faces.map((f) => f.material),
    );
  }
});
test('import honors transforms, mirrored winding and model units', () => {
  const bytes = rewrite(export3mf([cubeMesh()], palette), (files) => {
    let xml = strFromU8(files['3D/3dmodel.model']);
    xml = xml
      .replace('unit="millimeter"', 'unit="inch"')
      .replace(
        '<item objectid="2"/>',
        '<item objectid="2" transform="-1 0 0 0 1 0 0 0 1 30 0 0"/>',
      );
    files['3D/3dmodel.model'] = strToU8(xml);
  });
  const result = import3mf(bytes),
    box = bounds(result.pieces);
  near(box.center[0], 762);
  near(box.size[0], 508);
  assert.ok(result.pieces[0].health.closed);
  splitMesh(result.pieces[0], [0, 0, 1], 0);
});
test('nested external Bambu components retain paint and transforms', () => {
  const bytes = rewrite(export3mf([cubeMesh()], palette), (files) => {
    const source = strFromU8(files['3D/3dmodel.model']).replaceAll(
      /slic3rpe:mmu_segmentation="[^"]*"/g,
      '',
    );
    files['3D/Objects/object_1.model'] = strToU8(source);
    files['3D/3dmodel.model'] = strToU8(
      '<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources><object id="5" type="model"><components><component objectid="2" p:path="/3D/Objects/object_1.model" transform="1 0 0 0 1 0 0 0 1 50 0 0"/></components></object></resources><build><item objectid="5" transform="1 0 0 0 1 0 0 0 1 0 10 0"/></build></model>',
    );
  });
  const result = import3mf(bytes);
  assert.deepEqual(bounds(result.pieces).center, [50, 10, 0]);
  assert.ok(result.pieces[0].health.closed);
  assert.equal(result.paintedTriangles, 12);
});
test('subtriangle painting survives import, cut, export and reimport', () => {
  const bytes = rewrite(export3mf([cubeMesh()], palette), (files) => {
    const xml = strFromU8(files['3D/3dmodel.model']).replace(
      'slic3rpe:mmu_segmentation="4"',
      'slic3rpe:mmu_segmentation="48483"',
    );
    files['3D/3dmodel.model'] = strToU8(xml);
  });
  const project = import3mf(bytes);
  assert.ok(project.pieces[0].health.closed);
  const pieces = splitMesh(project.pieces[0], [0, 1, 1], 1);
  const roundtrip = import3mf(export3mf(pieces, palette));
  assert.ok(roundtrip.pieces.every((p) => p.health.closed));
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      roundtrip.pieces[i].faces.map((f) => f.material),
      pieces[i].faces.map((f) => f.material),
    );
});
test('XML entities and unsupported future paint formats reject clearly', () => {
  const base = export3mf([cubeMesh()], palette);
  assert.throws(
    () =>
      import3mf(
        rewrite(base, (f) => {
          f['3D/3dmodel.model'] = strToU8('<!DOCTYPE model []><model/>');
        }),
      ),
    /entity declarations/,
  );
  assert.throws(
    () =>
      import3mf(
        rewrite(base, (f) => {
          f['3D/3dmodel.model'] = strToU8(
            strFromU8(f['3D/3dmodel.model']).replace(
              'MmPaintingVersion">1',
              'MmPaintingVersion">9',
            ),
          );
        }),
      ),
    /newer paint/,
  );
});

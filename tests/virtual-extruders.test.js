import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readDocument, getTarget } from '../src/vendor/three-mf/index.js';
import { unzipSync, strFromU8 } from 'fflate';
import { cubeMesh } from '../src/demo.js';
import { splitMesh } from '../src/geometry.js';
import { import3mf, export3mf, export3mfResult } from '../src/three-mf.js';
import { paintedSquare, PALETTE } from './helpers/painted-square.js';
import { assertPaintAtOriginalPositions } from './helpers/spatial-assertions.js';

const virtualExtruders = { physicalExtruderCount: 8 };
const nativePath = 'Metadata/Prusa_Slicer_full_spectrum.json';
const nativeConfig = (bytes) => JSON.parse(strFromU8(unzipSync(bytes)[nativePath]));
function restoreRegions(piece, plan) {
  const original = new Map(plan.regions.map((r) => [r.virtualExtruder, r.region]));
  return {
    ...piece,
    faces: piece.faces.map((f) => ({ ...f, material: original.get(f.material) })),
  };
}
function assertGeometryAndPaint(source, result) {
  const round = import3mf(result.bytes);
  assert.equal(round.pieces.length, source.length);
  round.pieces.forEach((piece, i) => {
    const restored = restoreRegions(piece, result.virtualExtruders);
    assert.deepEqual(restored.vertices, source[i].vertices);
    assert.deepEqual(
      restored.faces.map((f) => ({ v: f.v, material: f.material })),
      source[i].faces.map((f) => ({ v: f.v, material: f.material })),
    );
  });
  return round;
}

test('virtual export converts partial-triangle paint without cutting or mutating the model', () => {
  const source = import3mf(paintedSquare());
  const before = structuredClone(source);
  const result = export3mfResult(source.pieces, source.palette, { virtualExtruders });
  assert.deepEqual(source, before);
  const round = assertGeometryAndPaint(source.pieces, result);
  assertPaintAtOriginalPositions(restoreRegions(round.pieces[0], result.virtualExtruders));
  const config = nativeConfig(result.bytes);
  const used = [...new Set(source.pieces.flatMap((p) => p.faces.map((f) => f.material)))].sort(
    (a, b) => a - b,
  );
  assert.deepEqual(
    result.virtualExtruders.regions.map((r) => r.region),
    used,
  );
  assert.equal(config.physical_extruders.length, 8);
  assert.deepEqual(
    config.virtual_extruders.map((v) => v.id),
    used.map((_, i) => 9 + i),
  );
  assert.ok(config.virtual_extruders.every((v) => v.kind === 'fullspectrum'));
  assert.match(result.warnings.join(' '), /Open Project.*PrusaSlicer/);
  assert.match(result.warnings.join(' '), /8 physical tools/);
  const files = unzipSync(result.bytes);
  assert.ok(files['Metadata/Slic3r_PE_model.config']);
  assert.doesNotMatch(
    Object.keys(files).join(' '),
    /Slic3r_PE\.config|project_settings|PrusaSlicer3_project|gcode/,
  );
  assert.doesNotMatch(
    Object.values(files).map(strFromU8).join('\n'),
    /nozzle_diameter|printer_settings|filament_settings|flush_volumes/,
  );
});

test('virtual export retains cuts and converts the selected interior-face region', () => {
  const source = import3mf(paintedSquare());
  const normal = [1, 2, 0],
    offset = 37.3;
  const pieces = splitMesh(source.pieces[0], normal, offset, 5);
  for (const selected of [pieces, [pieces[1]]]) {
    const result = export3mfResult(selected, PALETTE, { format: 'prusa', virtualExtruders });
    const round = assertGeometryAndPaint(selected, result);
    const cap = result.virtualExtruders.regions.find((r) => r.region === 5);
    assert.ok(cap);
    selected.forEach((p, i) => {
      const caps = p.faces.map((f, index) => (f.cap ? index : -1)).filter((index) => index >= 0);
      assert.ok(caps.length > 0);
      assert.ok(
        caps.every((index) => round.pieces[i].faces[index].material === cap.virtualExtruder),
      );
      assertPaintAtOriginalPositions(restoreRegions(round.pieces[i], result.virtualExtruders), [
        { normal, offset, sign: selected.length === 1 || i === 1 ? -1 : 1 },
      ]);
    });
  }
});

test('sparse and equal-color regions get distinct virtual IDs without unused palette entries', () => {
  const piece = cubeMesh();
  piece.faces.forEach((f, i) => {
    f.material = i % 2 ? 20 : 7;
  });
  const palette = Array(255).fill('#FFFFFF');
  const result = export3mfResult([piece], palette, { virtualExtruders });
  const [first, second] = result.virtualExtruders.regions;
  assert.deepEqual(
    result.virtualExtruders.regions.map((r) => r.region),
    [7, 20],
  );
  assert.deepEqual(
    result.virtualExtruders.regions.map((r) => r.virtualExtruder),
    [9, 10],
  );
  assert.deepEqual(first.components, second.components);
  assert.equal(nativeConfig(result.bytes).virtual_extruders.length, 2);
  assertGeometryAndPaint([piece], result);
});

test('custom physical colors and two-slot recipes reach the native project', () => {
  const piece = cubeMesh();
  const options = { physicalExtruderCount: 2, physicalColors: ['#ff0000', '#0000ff'] };
  const result = export3mfResult([piece], ['#FF0000', '#0000FF', '#800080'], {
    virtualExtruders: options,
  });
  const config = nativeConfig(result.bytes);
  assert.deepEqual(config.physical_extruders, [
    { id: 1, color: '#FF0000' },
    { id: 2, color: '#0000FF' },
  ]);
  assert.deepEqual(
    config.virtual_extruders.map((v) => v.id),
    [3, 4, 5],
  );
  assert.deepEqual(
    config.virtual_extruders.map((v) => v.color),
    ['#FF0000', '#0000FF', '#4C0E4C'],
  );
  assert.equal(result.virtualExtruders.regions[2].color, '#800080');
  assert.equal(result.virtualExtruders.regions[2].predictedColor, '#4C0E4C');
  assert.ok(config.virtual_extruders.every((v) => v.components.every((c) => c.extruder <= 2)));
  assert.ok(config.virtual_extruders[0].components.every((c) => c.extruder === 1));
  assert.ok(config.virtual_extruders[1].components.every((c) => c.extruder === 2));
  assertGeometryAndPaint([piece], result);
});

test('ordinary export still has the original physical paint and no virtual recipes', () => {
  const piece = cubeMesh();
  const bytes = export3mf([piece], PALETTE);
  assert.equal(unzipSync(bytes)[nativePath], undefined);
  assert.deepEqual(
    import3mf(bytes).pieces[0].faces.map((f) => f.material),
    piece.faces.map((f) => f.material),
  );
  assert.equal(export3mfResult([piece], PALETTE).virtualExtruders, undefined);
});

test('unsupported formats and invalid physical slots fail explicitly', () => {
  const pieces = [cubeMesh()];
  for (const format of ['universal', 'bambu', 'orca']) {
    assert.throws(
      () => export3mf(pieces, PALETTE, { format, virtualExtruders }),
      /not supported.*PrusaSlicer/,
    );
  }
  assert.throws(
    () => export3mf(pieces, PALETTE, { format: 'prusa3', virtualExtruders }),
    /source-backed native prusa3Template/,
  );
  for (const physicalExtruderCount of [1, 9, 2.5, NaN]) {
    assert.throws(
      () => export3mf(pieces, PALETTE, { virtualExtruders: { physicalExtruderCount } }),
      /2 through 8/,
    );
  }
  assert.throws(
    () =>
      export3mf(pieces, PALETTE, {
        virtualExtruders: { physicalExtruderCount: 2, physicalColors: ['#FF0000'] },
      }),
    /one #RRGGBB color/,
  );
  assert.throws(
    () =>
      export3mf(pieces, PALETTE, {
        virtualExtruders: { physicalExtruderCount: 2, physicalColors: ['red', '#0000FF'] },
      }),
    /one #RRGGBB color/,
  );
});

test('Prusa 3 virtual export forwards the native template and retains spatial paint', () => {
  const source = import3mf(paintedSquare());
  const prusa3Template = readDocument(
    readFileSync(new URL('./fixtures/multimaterial-mmu-prusa3-alpha12.3mf', import.meta.url)),
  );
  const result = export3mfResult(source.pieces, source.palette, {
    format: 'prusa3',
    virtualExtruders: { physicalExtruderCount: 5, prusa3Template },
  });
  assert.equal(getTarget('prusa3').supportsVirtualExtruders, true);
  assertGeometryAndPaint(source.pieces, result);
  const files = unzipSync(result.bytes);
  assert.equal(files[nativePath], undefined);
  const project = JSON.parse(strFromU8(files['Metadata/PrusaSlicer3_project.json']));
  assert.equal(project.config_containers.length, 1);
  assert.deepEqual(
    project.config_containers[0].virtual_extruders.map((entry) => entry.id),
    result.virtualExtruders.regions.map((entry) => entry.virtualExtruder),
  );
  assert.match(result.warnings.join(' '), /copies.*configuration/);
});

test('too many used regions reject instead of dropping a color', () => {
  const piece = cubeMesh();
  piece.faces = Array.from({ length: 248 }, (_, i) => ({
    ...piece.faces[i % 12],
    material: i + 1,
  }));
  assert.throws(
    () => export3mf([piece], Array(248).fill('#FFFFFF'), { virtualExtruders }),
    /at most 247 used regions/,
  );
});

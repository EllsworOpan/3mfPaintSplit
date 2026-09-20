import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { import3mf, export3mf } from '../src/three-mf.js';
import { splitMesh } from '../src/geometry.js';
import { paintedSquare, PALETTE } from './helpers/painted-square.js';
import { assertPaintAtOriginalPositions } from './helpers/spatial-assertions.js';

const executable =
  process.env.PRUSA_SLICER || 'C:/Program Files/Prusa3D/PrusaSlicer/prusa-slicer-console.exe';
test(
  'PrusaSlicer native save → complex paint cuts → native save preserves spatial paint',
  { skip: !existsSync(executable) },
  () => {
    const dir = resolve('.tmp/complex-prusa');
    mkdirSync(dir, { recursive: true });
    const run = (args) => {
      const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 0, String(result.error || '') + result.stdout + result.stderr);
      return result.stdout;
    };
    const save = (input, output) =>
      run(['--export-3mf', '--dont-arrange', '--no-ensure-on-bed', '--output', output, input]);
    const input = resolve(dir, 'original.3mf'),
      native = resolve(dir, 'native-paint.3mf');
    writeFileSync(input, paintedSquare());
    save(input, native);
    const source = import3mf(readFileSync(native));
    assert.equal(
      source.sourceTriangles,
      12,
      'The square must still use two original mesh triangles after Prusa saves it',
    );
    assertPaintAtOriginalPositions(source.pieces[0]);
    const first = { normal: [1, 2, 0], offset: 37.3 },
      second = { normal: [-2, 1, 0.25], offset: -9.7 };
    const [a, b] = splitMesh(source.pieces[0], first.normal, first.offset, 5);
    const [aa, ab] = splitMesh(a, second.normal, second.offset, 5);
    const pieces = [aa, ab, b],
      halfspaces = [
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
    const cut = resolve(dir, 'cut.3mf'),
      roundtrip = resolve(dir, 'roundtrip.3mf');
    writeFileSync(cut, export3mf(pieces, PALETTE));
    const info = run(['--info', cut]);
    assert.equal((info.match(/manifold = yes/g) || []).length, 3, info);
    save(cut, roundtrip);
    const reloaded = import3mf(readFileSync(roundtrip));
    assert.equal(reloaded.pieces.length, 3);
    reloaded.pieces.forEach((piece, i) => {
      assert.ok(piece.health.closed);
      // Prusa stores float32 coordinates: spatial comparisons allow 0.0001 mm²
      // overlap per triangle, while checking every triangle against the oracle.
      assertPaintAtOriginalPositions(piece, halfspaces[i], 1e-4);
      assert.ok(Math.abs(piece.health.volume - pieces[i].health.volume) < 0.01);
    });
  },
);

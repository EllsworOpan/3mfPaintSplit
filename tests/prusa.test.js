import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { cubeMesh } from '../src/demo.js';
import { splitMesh } from '../src/geometry.js';
import { import3mf, export3mf } from '../src/three-mf.js';

const executable =
  process.env.PRUSA_SLICER || 'C:/Program Files/Prusa3D/PrusaSlicer/prusa-slicer-console.exe';
test(
  'PrusaSlicer imports closed cut pieces and re-exports their native paint intact',
  { skip: !existsSync(executable) },
  () => {
    const dir = resolve('.tmp/prusa-test');
    mkdirSync(dir, { recursive: true });
    const palette = Array.from({ length: 18 }, (_, i) => ['#70C6B4', '#F2AD60', '#E9E4DA'][i % 3]);
    const mesh = cubeMesh();
    mesh.faces[2].material = 18;
    const archive = unzipSync(export3mf([mesh], palette));
    archive['3D/3dmodel.model'] = strToU8(
      strFromU8(archive['3D/3dmodel.model']).replace(
        'mmu_segmentation="4"',
        'mmu_segmentation="48483"',
      ),
    );
    const nativeInput = resolve(dir, 'painted-input.3mf'),
      nativeSaved = resolve(dir, 'prusa-painted.3mf');
    writeFileSync(nativeInput, zipSync(archive));
    const native = spawnSync(
      executable,
      [
        '--export-3mf',
        '--dont-arrange',
        '--no-ensure-on-bed',
        '--output',
        nativeSaved,
        nativeInput,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(native.status, 0, native.stdout + native.stderr);
    const source = import3mf(readFileSync(nativeSaved));
    const pieces = splitMesh(source.pieces[0], [1, 2, 3], 1, 2);
    const input = resolve(dir, 'cut.3mf'),
      output = resolve(dir, 'prusa-roundtrip.3mf');
    writeFileSync(input, export3mf(pieces, palette));
    const info = spawnSync(executable, ['--info', input], { encoding: 'utf8', timeout: 30000 });
    assert.equal(info.status, 0, info.stdout + info.stderr);
    assert.equal((info.stdout.match(/manifold = yes/g) || []).length, 2, info.stdout);
    const save = spawnSync(
      executable,
      ['--export-3mf', '--dont-arrange', '--no-ensure-on-bed', '--output', output, input],
      { encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(save.status, 0, save.stdout + save.stderr);
    const result = import3mf(readFileSync(output));
    assert.equal(result.pieces.length, 2);
    for (let i = 0; i < 2; i++) {
      assert.ok(result.pieces[i].health.closed);
      assert.equal(result.pieces[i].faces.length, pieces[i].faces.length);
      assert.deepEqual(
        result.pieces[i].faces.map((f) => f.material),
        pieces[i].faces.map((f) => f.material),
      );
      assert.ok(Math.abs(result.pieces[i].health.volume - pieces[i].health.volume) < 0.01);
    }
  },
);

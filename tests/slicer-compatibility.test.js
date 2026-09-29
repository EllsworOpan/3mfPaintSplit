import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { import3mf, export3mf } from '../src/three-mf.js';
import { splitMesh } from '../src/geometry.js';
import { paintedSquare, PALETTE } from './helpers/painted-square.js';
import { assertPaintAtOriginalPositions } from './helpers/spatial-assertions.js';

const programs = {
  bambu: process.env.BAMBU_STUDIO || 'C:/Program Files/Bambu Studio/bambu-studio.exe',
  orca: process.env.ORCA_SLICER || 'C:/Program Files/OrcaSlicer/orca-slicer.exe',
  prusa3: process.env.PRUSA_SLICER3 || resolve('.local/prusa3/PrusaSlicer.exe'),
};
for (const [name, executable] of Object.entries(programs))
  test(
    `${name}: model-only cut export keeps spatial paint and extended material 18 after native save`,
    { skip: !existsSync(executable), timeout: 60000 },
    () => {
      const dir = resolve(`.tmp/slicer-compatibility/${name}`);
      mkdirSync(dir, { recursive: true });
      const source = import3mf(paintedSquare());
      const normal = [1, 2, 0],
        offset = 37.3;
      const pieces = splitMesh(source.pieces[0], normal, offset, 18);
      const palette = Array.from({ length: 18 }, (_, i) => PALETTE[i % PALETTE.length]);
      const input = resolve(dir, 'model-only.3mf'),
        output = resolve(dir, `roundtrip-${Date.now()}.3mf`);
      writeFileSync(
        input,
        export3mf(pieces, palette, { format: name === 'prusa3' ? 'prusa3' : 'universal' }),
      );
      const args =
        name === 'prusa3'
          ? [
              '--datadir',
              resolve(dir, 'profiles'),
              '--export-3mf',
              '--dont-arrange',
              '--no-ensure-on-bed',
              '--output',
              output,
              input,
            ]
          : ['--arrange', '0', '--export-3mf', output, input];
      const run = spawnSync(executable, args, {
        cwd: dir,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 45000,
      });
      assert.equal(run.status, 0, String(run.error || '') + run.stdout + run.stderr);
      assert.ok(existsSync(output));
      const roundtrip = import3mf(readFileSync(output));
      assert.equal(roundtrip.pieces.length, 2);
      for (const [i, p] of roundtrip.pieces.entries()) {
        assert.ok(p.health.closed);
        assert.ok(Math.abs(p.health.volume - pieces[i].health.volume) < 0.01);
        assertPaintAtOriginalPositions(p, [{ normal, offset, sign: i ? -1 : 1 }], 1e-4);
        assert.ok(p.faces.some((f) => f.material === 18));
      }
    },
  );

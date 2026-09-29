import test from 'node:test';
import { cubeMesh } from '../src/demo.js';
import { export3mf } from '../src/three-mf.js';
import { assertPrusaUsesPaint, canSlicePrusa } from './helpers/prusa-slice.js';

for (const slot of [16, 17, 32])
  test(
    `Prusa 2 slices paint slot ${slot} into actual extrusion with the matching tool`,
    { skip: !canSlicePrusa },
    () => {
      const mesh = cubeMesh();
      const lo = [0, 1, 2].map((axis) => Math.min(...mesh.vertices.map((v) => v[axis])));
      mesh.vertices = mesh.vertices.map((v) =>
        v.map((n, axis) => (n - lo[axis]) / 10 + (axis === 2 ? 0 : 20)),
      );
      for (const face of mesh.faces) face.material = slot;
      assertPrusaUsesPaint(export3mf([mesh], Array(slot).fill('#FFFFFF')), slot);
    },
  );

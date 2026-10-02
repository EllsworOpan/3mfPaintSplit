import test from 'node:test';
import { cubeMesh } from '../src/demo.js';
import { export3mf } from '../src/three-mf.js';
import { assertPrusaUsesPaint, canSlicePrusa } from './helpers/prusa-slice.js';

test(
  'Prusa 2.9.6 resolves virtual paint to the intended physical filament during slicing',
  { skip: !canSlicePrusa },
  () => {
    const mesh = cubeMesh(2);
    mesh.vertices = mesh.vertices.map((v) => v.map((n, axis) => n + (axis === 2 ? 1 : 20)));
    for (const face of mesh.faces) face.material = 7;
    // Source region 7 becomes native virtual ID 3, but must print physical tool 2.
    const palette = Array(7).fill('#0000FF');
    assertPrusaUsesPaint(
      export3mf([mesh], palette, {
        virtualExtruders: { physicalExtruderCount: 2, physicalColors: ['#FF0000', '#0000FF'] },
      }),
      2,
      2,
    );
  },
);

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

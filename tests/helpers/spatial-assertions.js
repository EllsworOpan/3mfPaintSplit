import assert from 'node:assert/strict';
import {
  GRID,
  STEP,
  HEIGHT,
  referencePaint,
  intersectPolygons,
  signedArea,
  expectedAreas,
} from './painted-square.js';

const reference = referencePaint();
export function topFaces(mesh, tolerance = 1e-7) {
  return mesh.faces
    .filter((f) => f.v.every((i) => Math.abs(mesh.vertices[i][2] - HEIGHT) < tolerance))
    .map((f) => ({ material: f.material, polygon: f.v.map((i) => mesh.vertices[i].slice(0, 2)) }));
}
export function assertPaintAtOriginalPositions(mesh, halfspaces = [], tolerance = 1e-7) {
  const actual = [0, 0, 0, 0, 0];
  for (const face of topFaces(mesh, tolerance)) {
    const area = Math.abs(signedArea(face.polygon));
    assert.ok(area > 0, 'No degenerate surface triangles');
    assert.ok(
      face.material >= 1 && face.material <= 4,
      'Original surface must not acquire cap paint',
    );
    actual[face.material] += area;
    const lo = [0, 1].map((axis) =>
      Math.max(0, Math.floor(Math.min(...face.polygon.map((p) => p[axis])) / STEP) - 1),
    );
    const hi = [0, 1].map((axis) =>
      Math.min(GRID - 1, Math.floor(Math.max(...face.polygon.map((p) => p[axis])) / STEP) + 1),
    );
    let covered = 0,
      wrongColorArea = 0;
    for (let y = lo[1]; y <= hi[1]; y++)
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let k = 0; k < 2; k++) {
          const expected = reference[(y * GRID + x) * 2 + k];
          const overlap = Math.abs(signedArea(intersectPolygons(face.polygon, expected.polygon)));
          covered += overlap;
          if (expected.material !== face.material) wrongColorArea += overlap;
        }
    assert.ok(
      wrongColorArea < tolerance,
      `Material ${face.material} shifted across a paint boundary by ${wrongColorArea} mm² at ${JSON.stringify(face.polygon)}`,
    );
    assert.ok(
      Math.abs(area - covered) < tolerance,
      `Surface coverage mismatch: ${area} vs ${covered}`,
    );
    for (const { normal, offset, sign = 1 } of halfspaces)
      for (const p of face.polygon)
        assert.ok(
          sign * (normal[0] * p[0] + normal[1] * p[1] + normal[2] * HEIGHT - offset) > -tolerance,
          'Surface crossed the cut plane',
        );
  }
  const expected = expectedAreas(halfspaces);
  for (let material = 1; material <= 4; material++)
    assert.ok(
      Math.abs(actual[material] - expected[material]) < tolerance * 100,
      `Material ${material} area: ${actual[material]} vs ${expected[material]}`,
    );
  return actual;
}

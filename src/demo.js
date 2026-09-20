import { TorusKnotGeometry, BoxGeometry } from 'three';
import { makeMesh, meshHealth } from './geometry.js';
import { DEFAULT_COLORS } from './three-mf.js';

export function demoProject() {
  const geometry = new TorusKnotGeometry(19, 6.5, 160, 16, 2, 3).toNonIndexed();
  const position = geometry.getAttribute('position'),
    triangles = [];
  for (let i = 0; i < position.count; i += 3) {
    const v = [0, 1, 2].map((j) => [
      position.getX(i + j),
      position.getY(i + j),
      position.getZ(i + j) + 30,
    ]);
    const z = v.reduce((s, p) => s + p[2], 0) / 3;
    triangles.push({ v, material: z > 38 ? 3 : z > 27 ? 1 : 2 });
  }
  geometry.dispose();
  const mesh = makeMesh(triangles, 'Painted knot');
  mesh.health = meshHealth(mesh);
  return {
    pieces: [mesh],
    palette: DEFAULT_COLORS.slice(0, 3),
    warnings: [],
    filename: 'Painted knot.3mf',
    sourceTriangles: mesh.faces.length,
    paintedTriangles: mesh.faces.length,
    demo: true,
  };
}

export function cubeMesh(size = 20) {
  const g = new BoxGeometry(size, size, size).toNonIndexed(),
    p = g.getAttribute('position'),
    tris = [];
  for (let i = 0; i < p.count; i += 3)
    tris.push({
      v: [0, 1, 2].map((j) => [p.getX(i + j), p.getY(i + j), p.getZ(i + j)]),
      material: (Math.floor(i / 6) % 3) + 1,
    });
  g.dispose();
  return makeMesh(tris, 'Painted cube');
}

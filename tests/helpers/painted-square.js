import { zipSync, strToU8 } from 'fflate';

// Test fixture and spatial oracle intentionally import no application code.
// The expected paint is an XY grid defined directly in Cartesian coordinates.
export const SIZE = 32;
export const HEIGHT = 8;
export const GRID = 32;
export const STEP = SIZE / GRID;
export const PALETTE = ['#E9E4DA', '#70C6B4', '#D46878', '#6557A4', '#F2AD60'];

export function pattern(x, y) {
  const dx = x - 16,
    dy = y - 16;
  if (Math.abs(dx) + Math.abs(dy) < 6.5) return 4;
  const radius = dx * dx + dy * dy;
  if (radius > 70 && radius < 155) return 3;
  if (Math.abs(y - 0.65 * x - 3) < 1.2) return 2;
  return (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 2 : 1;
}

export function referencePaint() {
  const triangles = [];
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++) {
      const a = [x * STEP, y * STEP],
        b = [(x + 1) * STEP, y * STEP];
      const c = [(x + 1) * STEP, (y + 1) * STEP],
        d = [x * STEP, (y + 1) * STEP];
      for (const polygon of [
        [a, b, c],
        [a, c, d],
      ]) {
        const center = polygon.reduce((p, v) => [p[0] + v[0] / 3, p[1] + v[1] / 3], [0, 0]);
        triangles.push({ polygon, material: pattern(...center), cell: [x, y] });
      }
    }
  return triangles;
}

// Only the fixture serializer needs the native tree traversal. Its expected
// result is checked against referencePaint(), which uses no tree traversal.
function tree(points, depth, collapse) {
  if (depth === 0) {
    const center = points.reduce((p, v) => [p[0] + v[0] / 3, p[1] + v[1] / 3], [0, 0]);
    return pattern(...center);
  }
  const [a, b, c] = points;
  const ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const bc = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
  const ca = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2];
  const children = [
    [a, ab, ca],
    [ab, b, bc],
    [bc, c, ca],
    [ab, bc, ca],
  ].map((p) => tree(p, depth - 1, collapse));
  return collapse && children.every((c) => c === children[0]) ? children[0] : children;
}
function encodeTree(node, dialect) {
  // Fixture uses slots 1-4: their encodings are identical in both dialects.
  if (typeof node === 'number') return ['0', '4', '8', '0C', '1C'][node];
  return node.map((c) => encodeTree(c, dialect)).join('') + '3';
}

export function paintedSquare({ collapse = true, dialect = 'prusa' } = {}) {
  const vertices = [
    [0, 0, 0],
    [32, 0, 0],
    [32, 32, 0],
    [0, 32, 0],
    [0, 0, 8],
    [32, 0, 8],
    [32, 32, 8],
    [0, 32, 8],
  ];
  const faces = [
    [0, 2, 1],
    [0, 3, 2],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
    [4, 5, 6],
    [4, 6, 7],
  ];
  const top = [
    tree(
      [
        [0, 0],
        [32, 0],
        [32, 32],
      ],
      5,
      collapse,
    ),
    tree(
      [
        [0, 0],
        [32, 32],
        [0, 32],
      ],
      5,
      collapse,
    ),
  ];
  const attribute = dialect === 'prusa' ? 'slic3rpe:mmu_segmentation' : 'paint_color';
  const model = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06"><metadata name="Application">Paint Split independent test fixture</metadata><metadata name="slic3rpe:Version3mf">1</metadata><metadata name="slic3rpe:MmPaintingVersion">1</metadata><resources><object id="1" type="model" name="Two-triangle painted square"><mesh><vertices>${vertices.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices><triangles>${faces.map((f, i) => `<triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"${i >= 10 ? ` ${attribute}="${encodeTree(top[i - 10], dialect)}"` : ''}/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const files = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="application/xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="model" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    ),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/Slic3r_PE.config': strToU8(
      `; extruder_colour = ${PALETTE.join(';')}\n; filament_colour = ${PALETTE.join(';')}\n`,
    ),
  };
  return zipSync(files, { mtime: new Date('2020-01-01T00:00:00Z') });
}

export const signedArea = (polygon) =>
  polygon.reduce((area, p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    return area + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;

// Independent 2D convex clipping oracle: a polygon is clipped against each
// oriented edge of a reference paint triangle, not against a 3D mesh plane.
export function intersectPolygons(subject, clip) {
  let result = subject;
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i],
      b = clip[(i + 1) % clip.length];
    result = clipPolygon(
      result,
      (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]),
    );
  }
  return result;
}
export function clipPolygon(polygon, distance) {
  const output = [];
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i],
      prev = polygon[(i + polygon.length - 1) % polygon.length];
    const dc = distance(current),
      dp = distance(prev);
    if (dc >= 0 !== dp >= 0) {
      const weight = dp / (dp - dc);
      output.push([
        prev[0] + weight * (current[0] - prev[0]),
        prev[1] + weight * (current[1] - prev[1]),
      ]);
    }
    if (dc >= 0) output.push(current);
  }
  return output;
}
export function expectedAreas(halfspaces = []) {
  const result = [0, 0, 0, 0, 0];
  for (const leaf of referencePaint()) {
    let polygon = leaf.polygon;
    for (const { normal, offset, sign = 1 } of halfspaces)
      polygon = clipPolygon(
        polygon,
        (p) => sign * (normal[0] * p[0] + normal[1] * p[1] + normal[2] * HEIGHT - offset),
      );
    result[leaf.material] += Math.abs(signedArea(polygon));
  }
  return result;
}

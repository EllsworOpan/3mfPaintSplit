import { mkdirSync, writeFileSync } from 'node:fs';
import {
  paintedSquare,
  PALETTE,
  referencePaint,
  expectedAreas,
} from '../tests/helpers/painted-square.js';
import { assertPaintAtOriginalPositions, topFaces } from '../tests/helpers/spatial-assertions.js';
import { import3mf, export3mf } from '../src/three-mf.js';
import { splitMesh } from '../src/geometry.js';

const sourceBytes = paintedSquare();
const source = import3mf(sourceBytes).pieces[0];
const normal = [1, 2, 0],
  offset = 37.3;
const pieces = splitMesh(source, normal, offset, 5);
assertPaintAtOriginalPositions(source);
pieces.forEach((piece, i) =>
  assertPaintAtOriginalPositions(piece, [{ normal, offset, sign: i === 0 ? 1 : -1 }]),
);
mkdirSync('public/examples', { recursive: true });
writeFileSync('public/examples/complex-painted-square.3mf', sourceBytes);
writeFileSync('public/examples/complex-painted-square-cut.3mf', export3mf(pieces, PALETTE));

const polygon = ({ polygon: points, material }) =>
  `<polygon points="${points.map((p) => `${p[0]},${32 - p[1]}`).join(' ')}" fill="${PALETTE[material - 1]}"/>`;
const before = referencePaint().map(polygon).join('');
const after = pieces
  .map(
    (piece, i) =>
      `<g transform="translate(${i === 0 ? 1.5 : -1.5} ${i === 0 ? -3 : 3})">${topFaces(piece).map(polygon).join('')}</g>`,
  )
  .join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="560" viewBox="0 0 1040 560">
<rect width="1040" height="560" fill="#141a22"/>
<g fill="#e6ebf0" font-family="Segoe UI, sans-serif"><text x="38" y="45" font-size="24" font-weight="600">Paint crossing the original mesh triangles</text>
<text x="38" y="77" font-size="15" fill="#a6b6c7">Independent test fixture: a 32 × 32 mm square face, two original mesh triangles, four painted materials.</text>
<text x="70" y="120" font-size="18">Before: native paint on two triangles</text><text x="584" y="120" font-size="18">After: actual output from the cutter</text>
<text x="70" y="508" font-size="14" fill="#a6b6c7">Dashed diagonal = original mesh edge</text><text x="70" y="532" font-size="14" fill="#a6b6c7">White line = angled cut through finer paint regions</text>
<text x="584" y="508" font-size="14" fill="#a6b6c7">Pieces separated for illustration; paint stays in place.</text><text x="584" y="532" font-size="14" fill="#a6b6c7">Every output triangle is checked against the original pattern.</text></g>
<g transform="translate(70 145) scale(10)">${before}<rect width="32" height="32" fill="none" stroke="#a6b6c7" stroke-width=".15"/><path d="M0 32L32 0" fill="none" stroke="#16232e" stroke-dasharray=".7 .45" stroke-width=".22"/><path d="M0 13.35L32 29.35" stroke="#fff" stroke-width=".27"/></g>
<path d="M456 300h48m-10-10 10 10-10 10" fill="none" stroke="#7cddbd" stroke-width="2"/>
<g transform="translate(584 145) scale(10)">${after}</g></svg>`;
writeFileSync('docs/paint-preservation.svg', svg);
console.log(
  JSON.stringify(
    {
      originalMeshTriangles: 12,
      originalTopTriangles: 2,
      referencePaintTriangles: 2048,
      resolvedTopTriangles: topFaces(source).length,
      resolvedTotalTriangles: source.faces.length,
      cutTriangles: pieces.map((p) => p.faces.length),
      originalPaintAreasMm2: expectedAreas().slice(1),
      files: [
        'public/examples/complex-painted-square.3mf',
        'public/examples/complex-painted-square-cut.3mf',
        'docs/paint-preservation.svg',
      ],
    },
    null,
    2,
  ),
);

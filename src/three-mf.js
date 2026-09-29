import {
  readDocument,
  worldParts,
  resolvePart,
  createDocument,
  writeDocument,
  identity,
  getTarget,
  DEFAULT_COLORS,
} from './vendor/three-mf/index.js';
import { conformPaint, makeMesh, meshHealth, MAX_FACES } from './geometry.js';
export { DEFAULT_COLORS };

export function import3mf(buffer, filename = 'Model.3mf', progress = () => {}) {
  const document = readDocument(buffer, filename, progress),
    pieces = [];
  let resolved = 0,
    skipped = 0;
  for (const part of worldParts(document, { printableOnly: false })) {
    const object = document.objects.find((o) => o.id === part.objectId);
    if (!object.printable || part.kind !== 'ModelPart') {
      skipped++;
      continue;
    }
    progress(`Resolving paint on ${part.name}…`);
    const decoded = conformPaint(resolvePart(part, { maxResolvedTriangles: MAX_FACES - resolved }));
    resolved += decoded.length;
    if (resolved > MAX_FACES)
      throw new Error('Conforming paint exceeds the 1.5 million triangle limit.');
    const piece = makeMesh(decoded, part.name);
    if (piece.faces.length) {
      piece.health = meshHealth(piece);
      pieces.push(piece);
    }
  }
  if (!pieces.length) throw new Error('No printable model geometry was found.');
  const warnings = [...document.warnings];
  if (skipped)
    warnings.push(
      `${skipped} non-printing item(s), modifiers, or negative volumes were excluded. Apply any needed modifiers in your slicer after export.`,
    );
  if (pieces.some((p) => !p.health.closed))
    warnings.push(
      'Some pieces have open or inconsistent edges. They can be viewed, but must be repaired before cutting.',
    );
  const printableParts = document.objects
    .filter((o) => o.printable)
    .flatMap((o) => o.parts.filter((p) => p.kind === 'ModelPart'));
  return {
    pieces,
    palette: document.palette,
    warnings,
    filename,
    sourceTriangles: document.sourceTriangles,
    paintedTriangles: printableParts.reduce((n, p) => n + (p.paintedTriangleCount || 0), 0),
    format: preferredPaintTarget(document.format),
  };
}

// Compatibility names are interpreted by the shared target registry.
import { preferredPaintTarget } from './vendor/three-mf/index.js';
export function export3mf(pieces, palette, options = {}) {
  if (!pieces.length) throw new Error('Select at least one piece to export.');
  if (
    !Array.isArray(palette) ||
    !palette.length ||
    palette.length > 255 ||
    palette.some((c) => !/^#[\da-f]{6}$/i.test(c))
  )
    throw new Error('Export requires 1–255 valid material colors.');
  if (
    pieces.some(
      (p) =>
        !p.faces.length ||
        p.faces.some(
          (f) => !Number.isInteger(f.material) || f.material < 1 || f.material > palette.length,
        ),
    )
  )
    throw new Error('Every exported face needs a material slot present in the palette.');
  const objects = pieces.map((piece, i) => ({
    id: `piece-${i}`,
    name: piece.name,
    printable: true,
    transform: identity(),
    overrides: {},
    parts: [
      {
        id: `piece-${i}/part`,
        name: piece.name,
        kind: 'ModelPart',
        transform: identity(),
        overrides: {},
        mesh: { vertices: piece.vertices.flat(), triangles: piece.faces.flatMap((f) => f.v) },
        paint: piece.faces.map((f) => ({ region: f.material })),
      },
    ],
  }));
  return writeDocument(createDocument(objects, palette), {
    mode: 'create',
    target: getTarget(options.format || 'universal').id,
  }).bytes;
}

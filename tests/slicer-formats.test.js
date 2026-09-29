import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { import3mf, export3mf } from '../src/three-mf.js';
import { bounds, splitMesh } from '../src/geometry.js';
import { cubeMesh } from '../src/demo.js';
import { paintedSquare, PALETTE } from './helpers/painted-square.js';
import { assertPaintAtOriginalPositions } from './helpers/spatial-assertions.js';

const modelPath = '3D/3dmodel.model';
const projectPath = 'Metadata/PrusaSlicer3_project.json';
const paintPath = 'Metadata/Slic3r_facets_annotation.json';
const text = (files, path = modelPath) => strFromU8(files[path]);
const rewrite = (source, fn) => {
  const files = unzipSync(source);
  fn(files);
  return zipSync(files);
};
const open = (bytes) => import3mf(bytes, 'fixture.3mf');
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}.3mf`, import.meta.url));
const base = () => export3mf([cubeMesh()], PALETTE);

for (const [name, count, painted, palette] of [
  ['painted-prusa', 2, 20, ['#FF0000', '#00FF00', '#0000FF']],
  ['painted-instances-prusa', 4, 40, null],
  ['painted-plates-bambu', 5, 4, ['#FFFFFF', '#FF0000']],
  ['painted-plates-orca', 5, 4, ['#FFFFFF', '#FF0000']],
  ['painted-plates-prusa3-alpha12', 4, 4, ['#FF8000']],
])
  test(`${name}: native meshes and paint survive import and model-only export`, () => {
    const bytes = fixture(name),
      source = open(bytes);
    assert.equal(source.pieces.length, count);
    assert.equal(source.paintedTriangles, painted);
    if (palette) assert.deepEqual(source.palette, palette);
    assert.ok(source.pieces.every((p) => p.health.closed));
    assert.ok(source.warnings.some((w) => w.includes('excluded')));
    const exported = export3mf(source.pieces, source.palette);
    assert.deepEqual(
      Object.keys(unzipSync(exported)).sort(),
      ['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels'].sort(),
    );
    const roundtrip = open(exported);
    assert.deepEqual(roundtrip.pieces, source.pieces);
    assert.deepEqual(roundtrip.palette, source.palette);
    const piece = source.pieces[0],
      halves = splitMesh(piece, [0, 0, 1], bounds([piece]).center[2], 1);
    assert.ok(halves.every((p) => p.health.closed));
    assert.ok(
      Math.abs(halves.reduce((v, p) => v + p.health.volume, 0) - piece.health.volume) < 1e-5,
    );
  });

test('exports contain only meshes, native paint, names and standard colors; no profiles or annotations', () => {
  const source = open(fixture('painted-prusa'));
  const files = unzipSync(export3mf(source.pieces, source.palette));
  assert.equal(Object.keys(files).length, 3);
  const all = Object.values(files).map(strFromU8).join('\n');
  assert.doesNotMatch(
    all,
    /nozzle|filament_diameter|printer|Slic3r_PE|project_settings|custom_gcode|supports_paint|seam|fuzzy_skin/i,
  );
  assert.match(all, /slic3rpe:mmu_segmentation=/);
  assert.match(all, /paint_color=/);
  assert.match(all, /m:colorgroup/);
});

test('PrusaSlicer 3 export has native paint and volume identity but no printer configuration', () => {
  const source = open(prusa3Square());
  const bytes = export3mf(source.pieces, source.palette, { format: 'prusa3' });
  const files = unzipSync(bytes);
  assert.deepEqual(
    Object.keys(files).sort(),
    [modelPath, '[Content_Types].xml', '_rels/.rels', projectPath, paintPath].sort(),
  );
  const project = JSON.parse(text(files, projectPath));
  assert.deepEqual(project.config_containers, []);
  for (const object of project.objects) {
    assert.deepEqual(object.object_settings, {});
    assert.deepEqual(object.volumes[0].volume_settings, {});
  }
  const round = open(bytes);
  assert.equal(round.format, 'prusa3');
  assert.deepEqual(round.palette, source.palette);
  assertPaintAtOriginalPositions(round.pieces[0]);
  assert.throws(() => export3mf(source.pieces, source.palette, { format: 'unknown' }), /format/);
});

test('import automatically recovers an unreadable optional palette without dropping native paint', () => {
  const source = base(),
    bytes = rewrite(source, (f) => {
      f['Metadata/project_settings.config'] = strToU8('{broken');
    });
  const recovered = open(bytes);
  assert.deepEqual(recovered.pieces, open(source).pieces);
  assert.deepEqual(recovered.palette, PALETTE); // Standard color group is still available.
  assert.ok(recovered.warnings.some((w) => w.includes('Unreadable project palette')));
});

test('automatic recovery never hides invalid paint or loses volume roles from a broken model config', () => {
  assert.throws(
    () =>
      open(
        rewrite(base(), (f) => {
          f[modelPath] = strToU8(text(f).replace('mmu_segmentation="4"', 'mmu_segmentation="Z"'));
        }),
      ),
    /paint/i,
  );
  assert.throws(
    () =>
      open(
        rewrite(base(), (f) => {
          f['Metadata/Slic3r_PE_model.config'] = strToU8('<config><object');
        }),
      ),
    /XML/,
  );
  const clean = open(base());
  const extra = open(
    rewrite(base(), (f) => {
      f['Metadata/custom_gcode_per_layer.xml'] = strToU8('<broken');
      f['Metadata/slice_info.config'] = strToU8('<broken');
      f['Metadata/Slic3r_PE.config'] = strToU8(
        '; nozzle_diameter = nonsense\n; printer_model = imaginary\n',
      );
    }),
  );
  assert.deepEqual(extra.pieces, clean.pieces);
});

test('Bambu/Orca parts are scoped to their parent even when external models reuse IDs', () => {
  const bytes = rewrite(base(), (f) => {
    const mesh = text(f).replace(
      /\s+(?:slic3rpe:mmu_segmentation|paint_color|pid|p1)="[^"]*"/g,
      '',
    );
    f['3D/Objects/first.model'] = strToU8(mesh);
    f['3D/Objects/second.model'] = strToU8(mesh);
    f[modelPath] = strToU8(
      '<model><resources><object id="10"><components><component objectid="2" path="Objects/first.model"/></components></object><object id="20"><components><component objectid="2" path="Objects/second.model" transform="1 0 0 0 1 0 0 0 1 50 0 0"/></components></object></resources><build><item objectid="10"/><item objectid="20"/></build></model>',
    );
    f['Metadata/model_settings.config'] = strToU8(
      '<config><object id="10"><metadata key="extruder" value="2"/><part id="2" subtype="normal_part"><metadata key="name" value="First"/><metadata key="extruder" value="0"/></part></object><object id="20"><part id="2" subtype="normal_part"><metadata key="name" value="Second"/><metadata key="extruder" value="3"/></part></object></config>',
    );
  });
  const result = open(bytes);
  assert.deepEqual(
    result.pieces.map((p) => p.name),
    ['First', 'Second'],
  );
  assert.deepEqual(
    result.pieces.map((p) => [...new Set(p.faces.map((f) => f.material))]),
    [[2], [3]],
  );
  assert.deepEqual(bounds([result.pieces[1]]).center, [50, 0, 0]);
});

test('component units scale mesh coordinates without scaling the parent translation', () => {
  const bytes = rewrite(base(), (f) => {
    f['3D/inches.model'] = strToU8(text(f).replace('unit="millimeter"', 'unit="inch"'));
    f[modelPath] = strToU8(
      '<model unit="millimeter"><resources><object id="10"><components><component objectid="2" path="inches.model" transform="1 0 0 0 1 0 0 0 1 50 0 0"/></components></object></resources><build><item objectid="10" transform="1 0 0 0 1 0 0 0 1 0 10 0"/></build></model>',
    );
  });
  const result = open(bytes);
  assert.deepEqual(bounds(result.pieces).center, [50, 10, 0]);
  assert.deepEqual(bounds(result.pieces).size, [508, 508, 508]);
});

test('native unpainted leaves inherit the volume slot even when a standard display color is present', () => {
  const bytes = rewrite(base(), (f) => {
    f[modelPath] = strToU8(text(f).replace('mmu_segmentation="4"', 'mmu_segmentation="0"'));
    f['Metadata/Slic3r_PE_model.config'] = strToU8(
      '<config><object id="2"><volume firstid="0" lastid="11"><metadata key="extruder" value="5"/></volume></object></config>',
    );
  });
  assert.equal(open(bytes).pieces[0].faces[0].material, 5);
});

function prusa3Square() {
  return rewrite(paintedSquare(), (files) => {
    const source = text(files);
    const triangles = [...source.matchAll(/<triangle\b[^>]*>/g)];
    const paint = triangles.flatMap(([t], triangle) => {
      const dividing = /mmu_segmentation="([^"]+)"/.exec(t)?.[1];
      return dividing ? [{ triangle, dividing }] : [];
    });
    files[modelPath] = strToU8(
      source
        .replace(/\s+slic3rpe:mmu_segmentation="[^"]*"/g, '')
        .replace(
          '</resources>',
          '<object id="2" name="Painted volume"><components><component objectid="1"/></components></object><object id="3" name="Painted square"><components><component objectid="2"/></components></object></resources>',
        )
        .replace('<item objectid="1"/>', '<item objectid="3"/>'),
    );
    files[projectPath] = strToU8(
      JSON.stringify({
        objects: [{ id: 3, volumes: [{ id: 2, type: 'ModelPart' }] }],
        config_containers: [{ configuration: { project_settings: { extruder_colour: PALETTE } } }],
      }),
    );
    files[paintPath] = strToU8(
      JSON.stringify([{ id: 2, mmSegmentationFacetsVersion: 1, mmSegmentationFacets: paint }]),
    );
    delete files['Metadata/Slic3r_PE_model.config'];
    delete files['Metadata/Slic3r_PE.config'];
  });
}

test('PrusaSlicer 3 sparse JSON paint keeps partial-face positions through cuts and export', () => {
  const source = open(prusa3Square());
  assert.ok(source.paintedTriangles > 0);
  assertPaintAtOriginalPositions(source.pieces[0]);
  const normal = [1, 2, 0],
    offset = 37.3;
  const pieces = splitMesh(source.pieces[0], normal, offset, 5);
  const round = open(export3mf(pieces, PALETTE));
  round.pieces.forEach((p, i) =>
    assertPaintAtOriginalPositions(p, [{ normal, offset, sign: i ? -1 : 1 }]),
  );
});

for (const [name, change] of [
  [
    'unknown paint version',
    (p) => {
      p[0].mmSegmentationFacetsVersion = 99;
    },
  ],
  [
    'missing painted volume',
    (p) => {
      p[0].id = 999;
    },
  ],
  [
    'duplicate triangle paint',
    (p) => {
      p[0].mmSegmentationFacets.push(p[0].mmSegmentationFacets[0]);
    },
  ],
  [
    'missing painted triangle',
    (p) => {
      p[0].mmSegmentationFacets[0].triangle = 999;
    },
  ],
])
  test(`PrusaSlicer 3 rejects ${name}`, () => {
    const bytes = rewrite(prusa3Square(), (f) => {
      const p = JSON.parse(text(f, paintPath));
      change(p);
      f[paintPath] = strToU8(JSON.stringify(p));
    });
    assert.throws(() => open(bytes), /paint/i);
  });

test('PrusaSlicer 3 blend/gradient recipes reject instead of becoming unrelated physical slots', () => {
  assert.throws(() => open(fixture('multimaterial-mmu-prusa3-alpha12')), /blend\/gradient/);
});

test('resource paths reject external targets, traversal and ambiguous archive aliases', () => {
  assert.throws(
    () =>
      open(
        rewrite(base(), (f) => {
          f['_rels/.rels'] = strToU8(
            text(f, '_rels/.rels').replace('Target=', 'TargetMode="External" Target='),
          );
        }),
      ),
    /External/,
  );
  assert.throws(
    () =>
      open(
        rewrite(base(), (f) => {
          f['../../escape.model'] = strToU8('<model/>');
        }),
      ),
    /escapes/,
  );
  assert.throws(
    () =>
      open(
        rewrite(base(), (f) => {
          f['3D/./3dmodel.model'] = f[modelPath];
        }),
      ),
    /Duplicate/,
  );
});

for (const range of [
  'firstid="0.5" lastid="11"',
  'firstid="1" lastid="11"',
  'firstid="0" lastid="10"',
  'firstid="0" lastid="11"/><volume firstid="5" lastid="11"',
])
  test(`invalid volume ranges reject: ${range}`, () => {
    const bytes = rewrite(base(), (f) => {
      f['Metadata/Slic3r_PE_model.config'] = strToU8(
        `<config><object id="2"><volume ${range}/></object></config>`,
      );
    });
    assert.throws(() => open(bytes), /range/i);
  });

test('printable=false is excluded just like printable=0', () => {
  const bytes = rewrite(base(), (f) => {
    f[modelPath] = strToU8(
      text(f).replace(
        '<item objectid="2"/>',
        '<item objectid="2"/><item objectid="2" printable="false"/>',
      ),
    );
  });
  assert.equal(open(bytes).pieces.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { import3mf, export3mf } from '../src/three-mf.js';
import { cubeMesh } from '../src/demo.js';
import { bounds } from '../src/geometry.js';
import { PALETTE, paintedSquare } from './helpers/painted-square.js';

function modify(transform, extra = {}) {
  const files = unzipSync(export3mf([cubeMesh()], PALETTE));
  files['3D/3dmodel.model'] = strToU8(transform(strFromU8(files['3D/3dmodel.model'])));
  for (const [path, text] of Object.entries(extra)) files[path] = strToU8(text);
  return zipSync(files);
}
const invalid = [
  ['missing vertex coordinate', (x) => x.replace(/ x="[^"]+"/, '')],
  ['missing triangle index', (x) => x.replace(/ v1="[^"]+"/, '')],
  ['fractional triangle index', (x) => x.replace(/ v1="[^"]+"/, ' v1="0.5"')],
  ['out-of-range triangle index', (x) => x.replace(/ v1="[^"]+"/, ' v1="999999"')],
  ['nonfinite coordinate', (x) => x.replace(/ x="[^"]+"/, ' x="Infinity"')],
  [
    'invalid object transform',
    (x) => x.replace('<item objectid="2"/>', '<item objectid="2" transform="1 2 3"/>'),
  ],
  ['unknown model units', (x) => x.replace('unit="millimeter"', 'unit="parsec"')],
  ['missing object', (x) => x.replace('<item objectid="2"/>', '<item objectid="99"/>')],
  ['missing build item', (x) => x.replace('<item objectid="2"/>', '')],
];
for (const [name, transform] of invalid)
  test(`3MF importer rejects ${name}`, () => assert.throws(() => import3mf(modify(transform))));
test('3MF importer rejects corrupt ZIPs and archives with no model', () => {
  assert.throws(() => import3mf(new Uint8Array([1, 2, 3])));
  assert.throws(() => import3mf(zipSync({ 'readme.txt': strToU8('not a model') })), /No 3D model/);
});
test('component cycles and missing external models are rejected', () => {
  const model = (path) =>
    `<model><resources><object id="2" type="model"><components><component objectid="2" ${path}/></components></object></resources><build><item objectid="2"/></build></model>`;
  assert.throws(() => import3mf(modify(() => model(''))), /Cyclic/);
  assert.throws(
    () => import3mf(modify(() => model('path="/3D/missing.model"'))),
    /Missing 3MF component/,
  );
});
test('two transformed instances remain separate and keep the same paint', () => {
  const data = modify((x) =>
    x.replace(
      '<item objectid="2"/>',
      '<item objectid="2"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 50 0 0"/>',
    ),
  );
  const project = import3mf(data);
  assert.equal(project.pieces.length, 2);
  assert.deepEqual(bounds([project.pieces[1]]).center, [50, 0, 0]);
  assert.deepEqual(project.pieces[0].faces, project.pieces[1].faces);
  assert.ok(project.pieces.every((p) => p.health.closed));
});
test('volume default material applies to unpainted leaves while explicit paint stays intact', () => {
  const files = unzipSync(paintedSquare());
  files['Metadata/Slic3r_PE_model.config'] = strToU8(
    '<config><object id="1"><metadata key="extruder" value="2"/><volume firstid="0" lastid="11"><metadata key="extruder" value="5"/><metadata key="volume_type" value="ModelPart"/></volume></object></config>',
  );
  const result = import3mf(zipSync(files));
  for (const f of result.pieces[0].faces) {
    const top = f.v.every((i) => result.pieces[0].vertices[i][2] === 8);
    assert.ok(top ? f.material <= 4 : f.material === 5);
  }
});
test('non-printing instances are excluded with a visible warning', () => {
  const data = modify((x) =>
    x.replace('<item objectid="2"/>', '<item objectid="2"/><item objectid="2" printable="0"/>'),
  );
  const result = import3mf(data);
  assert.equal(result.pieces.length, 1);
  assert.ok(result.warnings.some((w) => w.includes('1 non-printing')));
});
test('Bambu filament palette is used when Prusa configuration is absent', () => {
  const files = unzipSync(paintedSquare({ dialect: 'bambu' }));
  delete files['Metadata/Slic3r_PE.config'];
  files['Metadata/project_settings.config'] = strToU8(JSON.stringify({ filament_colour: PALETTE }));
  assert.deepEqual(import3mf(zipSync(files)).palette, PALETTE);
});
test('fallback standard 3MF colors are retained without slicer palette metadata', () => {
  const files = unzipSync(export3mf([cubeMesh()], PALETTE));
  delete files['Metadata/Slic3r_PE.config'];
  assert.deepEqual(import3mf(zipSync(files)).palette, PALETTE);
});
test('out-of-range unpainted default material is rejected rather than creating invalid paint', () => {
  const files = unzipSync(paintedSquare());
  files['Metadata/Slic3r_PE_model.config'] = strToU8(
    '<config><object id="1"><metadata key="extruder" value="999"/></object></config>',
  );
  assert.throws(() => import3mf(zipSync(files)), /material/i);
});

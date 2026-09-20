import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { Matrix4, Vector3 } from 'three';
import { decodePaint, encodePaint } from './paint.js';
import { conformPaint, makeMesh, meshHealth, MAX_FACES } from './geometry.js';

export const DEFAULT_COLORS = [
  '#70C6B4',
  '#F2AD60',
  '#E9E4DA',
  '#6557A4',
  '#D46878',
  '#559FDE',
  '#A8BC60',
  '#817C79',
];
const children = (el, name) =>
  Array.from(el?.childNodes || []).filter((n) => n.nodeType === 1 && n.localName === name);
const child = (el, name) => children(el, name)[0];
const descendants = (el, name) =>
  Array.from(el.getElementsByTagName('*')).filter((n) => n.localName === name);
const attr = (el, name) => Array.from(el.attributes || []).find((a) => a.localName === name)?.value;
const xmlEscape = (s) =>
  String(s).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );

function xml(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error('3MF XML with document type or entity declarations is not supported.');
  return new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') throw new Error(`Invalid 3MF XML: ${message}`);
    },
  }).parseFromString(text, 'application/xml');
}
function matrix(value) {
  if (!value) return new Matrix4();
  const a = value.trim().split(/\s+/).map(Number);
  if (a.length !== 12 || !a.every(Number.isFinite))
    throw new Error('Invalid 3MF object transform.');
  return new Matrix4().set(
    a[0],
    a[3],
    a[6],
    a[9],
    a[1],
    a[4],
    a[7],
    a[10],
    a[2],
    a[5],
    a[8],
    a[11],
    0,
    0,
    0,
    1,
  );
}
function pathOf(path, base = '') {
  const parts = (path.startsWith('/') ? path : base.slice(0, base.lastIndexOf('/') + 1) + path)
      .replaceAll('\\', '/')
      .split('/'),
    result = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') result.pop();
    else result.push(p);
  }
  return result.join('/');
}
function positiveInt(value, fallback = 1) {
  if (value == null || String(value).trim() === '') return fallback;
  const n = Number(value);
  // Slicer metadata uses zero to mean "inherit the enclosing material".
  if (n === 0) return fallback;
  if (!Number.isInteger(n) || n < 1 || n > 255)
    throw new Error('The model contains an invalid material index (expected 1–255).');
  return n;
}
function requiredNumber(element, name) {
  const value = element.getAttribute(name);
  if (value == null || value.trim() === '' || !Number.isFinite(Number(value)))
    throw new Error(`The mesh contains a missing or invalid ${name} attribute.`);
  return Number(value);
}

export function import3mf(buffer, filename = 'Model.3mf', progress = () => {}) {
  if (buffer.byteLength > 200 * 1024 * 1024)
    throw new Error('This file exceeds the 200 MB browser import limit.');
  let expanded = 0;
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (file) => {
      // Do not inflate embedded G-code, thumbnails, textures, or other assets.
      if (!/\.model$|\.config$|\.rels$|project_settings\.config$/i.test(file.name)) return false;
      expanded += file.originalSize;
      if (expanded > 400 * 1024 * 1024)
        throw new Error('The expanded 3MF exceeds the 400 MB browser memory limit.');
      return true;
    },
  });
  const read = (path) => (files[path] ? strFromU8(files[path]) : null);
  let root = '3D/3dmodel.model';
  if (read('_rels/.rels')) {
    const rel = descendants(xml(read('_rels/.rels')), 'Relationship').find((r) =>
      (r.getAttribute('Type') || '').endsWith('/3dmodel'),
    );
    if (rel) root = pathOf(rel.getAttribute('Target'));
  }
  if (!read(root)) throw new Error('No 3D model was found in this 3MF archive.');
  const cache = new Map(),
    warnings = [],
    palette = [];
  const config = read('Metadata/Slic3r_PE.config') || '';
  const colors =
    config.match(/^;?\s*extruder_colour\s*=\s*(.+)$/m)?.[1] ||
    config.match(/^;?\s*filament_colour\s*=\s*(.+)$/m)?.[1];
  if (colors)
    for (const c of colors.split(';'))
      palette.push(
        /^#[\da-f]{6}/i.test(c.trim())
          ? c.trim().slice(0, 7)
          : DEFAULT_COLORS[palette.length % DEFAULT_COLORS.length],
      );
  const bambuSettings = read('Metadata/project_settings.config');
  if (!palette.length && bambuSettings)
    try {
      const settings = JSON.parse(bambuSettings),
        colors = settings.filament_colour || settings.filament_color;
      if (Array.isArray(colors))
        for (const c of colors)
          palette.push(
            /^#[\da-f]{6}/i.test(c)
              ? c.slice(0, 7)
              : DEFAULT_COLORS[palette.length % DEFAULT_COLORS.length],
          );
    } catch {
      /* Some older project configs are not JSON. */
    }
  const objectSettings = new Map(),
    bambuParts = new Map();
  const prusaConfig = read('Metadata/Slic3r_PE_model.config');
  if (prusaConfig)
    for (const o of descendants(xml(prusaConfig), 'object')) {
      const metadata = Object.fromEntries(
        children(o, 'metadata').map((m) => [m.getAttribute('key'), m.getAttribute('value')]),
      );
      const volumes = children(o, 'volume').map((v) => ({
        first: Number(v.getAttribute('firstid')),
        last: Number(v.getAttribute('lastid')),
        meta: Object.fromEntries(
          children(v, 'metadata').map((m) => [m.getAttribute('key'), m.getAttribute('value')]),
        ),
      }));
      objectSettings.set(o.getAttribute('id'), { metadata, volumes });
    }
  const bambuConfig = read('Metadata/model_settings.config');
  if (bambuConfig)
    for (const o of descendants(xml(bambuConfig), 'object')) {
      const metadata = Object.fromEntries(
        children(o, 'metadata').map((m) => [m.getAttribute('key'), m.getAttribute('value')]),
      );
      if (!objectSettings.has(o.getAttribute('id')))
        objectSettings.set(o.getAttribute('id'), { metadata, volumes: [] });
      for (const p of children(o, 'part'))
        bambuParts.set(p.getAttribute('id'), {
          ...Object.fromEntries(
            children(p, 'metadata').map((m) => [m.getAttribute('key'), m.getAttribute('value')]),
          ),
          subtype: p.getAttribute('subtype'),
        });
    }
  function model(path) {
    if (cache.has(path)) return cache.get(path);
    const content = read(path);
    if (!content) throw new Error(`Missing 3MF component: ${path}`);
    const doc = xml(content),
      el = doc.documentElement,
      resources = child(el, 'resources');
    const unit = {
      micron: 0.001,
      millimeter: 1,
      centimeter: 10,
      inch: 25.4,
      foot: 304.8,
      meter: 1000,
    }[el.getAttribute('unit') || 'millimeter'];
    if (!unit) throw new Error('Unsupported 3MF unit.');
    const data = {
      el,
      unit,
      objects: new Map(children(resources, 'object').map((o) => [o.getAttribute('id'), o])),
      resources: new Map(
        Array.from(resources?.childNodes || [])
          .filter((e) => e.nodeType === 1)
          .map((e) => [e.getAttribute('id'), e]),
      ),
    };
    const ver = children(el, 'metadata').find(
      (m) => m.getAttribute('name') === 'slic3rpe:MmPaintingVersion',
    );
    if (ver && Number(ver.textContent) > 2)
      throw new Error(
        'This 3MF uses a newer paint format. Save a PrusaSlicer 2.x compatible 3MF first.',
      );
    data.paintVersion = Number(ver?.textContent || 0);
    if (!palette.length) {
      const groups = [...data.resources.values()].filter((r) => r.localName === 'colorgroup');
      if (groups.length === 1) {
        for (const color of children(groups[0], 'color')) {
          const value = color.getAttribute('color');
          if (/^#[\da-f]{6}/i.test(value)) palette.push(value.slice(0, 7));
        }
      }
    }
    cache.set(path, data);
    return data;
  }
  const pieces = [];
  let sourceTriangles = 0,
    paintedTriangles = 0,
    resolved = 0,
    skipped = 0;
  function visit(path, id, transform, stack = [], inherited = 1) {
    const key = path + '#' + id;
    if (stack.includes(key) || stack.length > 40)
      throw new Error('Cyclic or excessively nested 3MF components.');
    const data = model(path),
      obj = data.objects.get(id);
    if (!obj) throw new Error(`Missing 3MF object ${id}.`);
    if (obj.getAttribute('type') && obj.getAttribute('type') !== 'model') {
      skipped++;
      return;
    }
    const settings = objectSettings.get(id),
      part = bambuParts.get(id);
    if (part?.subtype && part.subtype !== 'normal_part') {
      skipped++;
      return;
    }
    const fallback = positiveInt(part?.extruder || settings?.metadata.extruder, inherited);
    const mesh = child(obj, 'mesh'),
      components = child(obj, 'components');
    const baseName =
      settings?.metadata.name ||
      part?.name ||
      obj.getAttribute('name') ||
      filename.replace(/\.3mf$/i, '');
    if (components)
      for (const c of children(components, 'component')) {
        const nextPath = attr(c, 'path') ? pathOf(attr(c, 'path'), path) : path;
        visit(
          nextPath,
          c.getAttribute('objectid'),
          transform.clone().multiply(matrix(c.getAttribute('transform'))),
          [...stack, key],
          fallback,
        );
      }
    if (!mesh) return;
    const verts = children(child(mesh, 'vertices'), 'vertex').map((v) => {
      const p = ['x', 'y', 'z'].map((k) => requiredNumber(v, k));
      if (!p.every(Number.isFinite)) throw new Error('The mesh contains an invalid vertex.');
      return new Vector3(...p).applyMatrix4(transform).multiplyScalar(data.unit).toArray();
    });
    const triangles = children(child(mesh, 'triangles'), 'triangle');
    sourceTriangles += triangles.length;
    const groups = settings?.volumes.length
      ? settings.volumes
      : [{ first: 0, last: triangles.length - 1, meta: {} }];
    for (const group of groups) {
      if (
        group.meta.modifier === '1' ||
        (group.meta.volume_type && group.meta.volume_type !== 'ModelPart')
      ) {
        skipped++;
        continue;
      }
      let decoded = [];
      const defaultMaterial = positiveInt(group.meta.extruder, fallback);
      for (let i = group.first; i <= group.last; i++) {
        const t = triangles[i];
        if (!t) throw new Error('Invalid volume triangle range in 3MF metadata.');
        const indices = ['v1', 'v2', 'v3'].map((k) => requiredNumber(t, k));
        if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= verts.length))
          throw new Error('A triangle references a missing vertex.');
        const points = indices.map((i) => verts[i]);
        const prusa = attr(t, 'mmu_segmentation'),
          bambu = attr(t, 'paint_color');
        let material = defaultMaterial;
        if (!prusa && !bambu) {
          const pid = t.getAttribute('pid') || obj.getAttribute('pid'),
            p1 = t.getAttribute('p1') || obj.getAttribute('pindex') || '0',
            resource = data.resources.get(pid);
          if (resource) {
            const entries = children(
                resource,
                resource.localName === 'basematerials' ? 'base' : 'color',
              ),
              entry = entries[Number(p1)];
            const color =
              entry && (entry.getAttribute('color') || entry.getAttribute('displaycolor'));
            if (color && /^#[\da-f]{6}/i.test(color)) {
              const normalized = color.slice(0, 7).toUpperCase();
              let index = palette.findIndex((c) => c.toUpperCase() === normalized);
              if (index < 0) {
                index = palette.length;
                palette.push(normalized);
              }
              material = index + 1;
            }
          }
        }
        if (prusa || bambu) paintedTriangles++;
        // Some older third-party exporters (including Texture2Paint) write the
        // same Bambu string into both attributes without Prusa's version-2 flag.
        const sharedLegacyPaint = prusa && prusa === bambu && data.paintVersion < 2;
        const leaves = decodePaint(
          points,
          prusa || bambu,
          material,
          prusa && !sharedLegacyPaint ? 'prusa' : 'bambu',
        );
        if (transform.determinant() < 0)
          for (const leaf of leaves) leaf.v = [leaf.v[0], leaf.v[2], leaf.v[1]];
        resolved += leaves.length;
        if (resolved > MAX_FACES)
          throw new Error(
            'Paint resolves to more than 1.5 million triangles. Use a smaller model.',
          );
        for (const leaf of leaves) decoded.push(leaf);
      }
      progress(`Resolving paint on ${baseName}…`);
      decoded = conformPaint(decoded);
      const piece = makeMesh(decoded, group.meta.name || baseName);
      if (piece.faces.length) {
        piece.health = meshHealth(piece);
        pieces.push(piece);
      }
    }
  }
  const rootData = model(root),
    build = child(rootData.el, 'build');
  const items = children(build, 'item');
  if (!items.length) throw new Error('This 3MF has no build items.');
  for (const item of items) {
    if (item.getAttribute('printable') === '0') {
      skipped++;
      continue;
    }
    visit(
      attr(item, 'path') ? pathOf(attr(item, 'path'), root) : root,
      item.getAttribute('objectid'),
      matrix(item.getAttribute('transform')),
    );
  }
  if (!pieces.length) throw new Error('No printable model geometry was found.');
  let maxMaterial = 1;
  for (const p of pieces) for (const f of p.faces) maxMaterial = Math.max(maxMaterial, f.material);
  if (!palette.length)
    warnings.push(
      'No filament palette was stored. Material numbers are preserved; choose display colors below.',
    );
  while (palette.length < maxMaterial)
    palette.push(DEFAULT_COLORS[palette.length % DEFAULT_COLORS.length]);
  if (skipped)
    warnings.push(
      `${skipped} non-printing item(s), modifiers, or negative volumes were excluded. Apply any needed modifiers in your slicer after export.`,
    );
  if (!paintedTriangles)
    warnings.push('No MMU/AMS paint was found. Existing object material assignments are used.');
  if (pieces.some((p) => !p.health.closed))
    warnings.push(
      'Some pieces have open or inconsistent edges. They can be viewed, but must be repaired before cutting.',
    );
  return { pieces, palette, warnings, filename, sourceTriangles, paintedTriangles };
}

export function export3mf(pieces, palette) {
  if (!pieces.length) throw new Error('Select at least one piece to export.');
  const paintVersion = pieces.some((piece) => piece.faces.some((face) => face.material > 16))
    ? 2
    : 1;
  const objects = pieces
    .map((piece, index) => {
      const vertices = piece.vertices
        .map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`)
        .join('');
      const faces = piece.faces
        .map(
          (f) =>
            `<triangle v1="${f.v[0]}" v2="${f.v[1]}" v3="${f.v[2]}" slic3rpe:mmu_segmentation="${encodePaint(f.material)}" paint_color="${encodePaint(f.material, 'bambu')}" pid="1" p1="${f.material - 1}"/>`,
        )
        .join('');
      return `<object id="${index + 2}" type="model" name="${xmlEscape(piece.name)}"><mesh><vertices>${vertices}</vertices><triangles>${faces}</triangles></mesh></object>`;
    })
    .join('');
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"><metadata name="Application">3MF Paint Split 1.0</metadata><metadata name="slic3rpe:Version3mf">1</metadata><metadata name="slic3rpe:MmPaintingVersion">${paintVersion}</metadata><resources><m:colorgroup id="1">${palette.map((c) => `<m:color color="${xmlEscape(c)}FF"/>`).join('')}</m:colorgroup>${objects}</resources><build>${pieces.map((_, i) => `<item objectid="${i + 2}"/>`).join('')}</build></model>`;
  const modelConfig = `<?xml version="1.0"?><config>${pieces.map((p, i) => `<object id="${i + 2}" instances_count="1"><metadata type="object" key="name" value="${xmlEscape(p.name)}"/><volume firstid="0" lastid="${p.faces.length - 1}"><metadata type="volume" key="name" value="${xmlEscape(p.name)}"/><metadata type="volume" key="volume_type" value="ModelPart"/><metadata type="volume" key="extruder" value="1"/></volume></object>`).join('')}</config>`;
  const config = `; generated by 3MF Paint Split\n; extruder_colour = ${palette.join(';')}\n; filament_colour = ${palette.join(';')}\n; nozzle_diameter = ${palette.map(() => 0.4).join(',')}\n; filament_diameter = ${palette.map(() => 1.75).join(',')}\n`;
  return zipSync(
    {
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="application/xml"/></Types>',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
      ),
      '3D/3dmodel.model': strToU8(model),
      'Metadata/Slic3r_PE_model.config': strToU8(modelConfig),
      'Metadata/Slic3r_PE.config': strToU8(config),
    },
    { level: 6 },
  );
}

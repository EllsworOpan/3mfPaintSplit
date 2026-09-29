import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { Matrix4, Vector3 } from 'three';
import { decodePaint, encodePaint } from './paint.js';
import { conformPaint, makeMesh, meshHealth, MAX_FACES } from './geometry.js';
import { readPrusaPaint } from './prusa-paint.js';

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
  try {
    path = decodeURIComponent(path);
  } catch {
    throw new Error('Invalid encoded 3MF resource path.');
  }
  if (!path || /[?#\x00-\x1f]|^[a-z][a-z\d+.-]*:/i.test(path))
    throw new Error('Invalid or external 3MF resource path.');
  path = path.replaceAll('\\', '/');
  const parts = (
      path.startsWith('/') ? path : base.slice(0, base.lastIndexOf('/') + 1) + path
    ).split('/'),
    result = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') {
      if (!result.length) throw new Error('A 3MF resource path escapes the archive.');
      result.pop();
    } else result.push(p);
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
  let expanded = 0,
    entries = 0;
  const sidecars = new Set([
    '_rels/.rels',
    'metadata/slic3r_pe.config',
    'metadata/slic3r_pe_model.config',
    'metadata/model_settings.config',
    'metadata/project_settings.config',
    'metadata/prusaslicer3_project.json',
    'metadata/slic3r_facets_annotation.json',
  ]);
  const archivePaths = new Set();
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (file) => {
      if (++entries > 10000) throw new Error('The 3MF contains too many archive entries.');
      const path = pathOf(file.name).toLowerCase();
      if (archivePaths.has(path)) throw new Error('Duplicate 3MF archive resource path.');
      archivePaths.add(path);
      // Only mesh, paint, roles, material assignments and palette sources.
      // Never inflate G-code, textures, or unrelated slicer settings/annotations.
      if (!/\.model$/i.test(path) && !sidecars.has(path)) return false;
      expanded += file.originalSize;
      if (expanded > 400 * 1024 * 1024)
        throw new Error('The expanded 3MF exceeds the 400 MB browser memory limit.');
      return true;
    },
  });
  const filePaths = new Map(Object.keys(files).map((p) => [pathOf(p).toLowerCase(), p]));
  const read = (path) => {
    const actual = filePaths.get(path.toLowerCase());
    return actual === undefined ? null : strFromU8(files[actual]);
  };
  let root = '3D/3dmodel.model';
  if (read('_rels/.rels')) {
    const rel = descendants(xml(read('_rels/.rels')), 'Relationship').find((r) =>
      (r.getAttribute('Type') || '').endsWith('/3dmodel'),
    );
    if (rel) {
      if (rel.getAttribute('TargetMode') === 'External')
        throw new Error('External 3MF model relationships are not supported.');
      root = pathOf(rel.getAttribute('Target'));
    }
  }
  if (!read(root)) throw new Error('No 3D model was found in this 3MF archive.');
  const cache = new Map(),
    colorRegions = new Map(),
    warnings = [],
    palette = [];
  const prusa3 = readPrusaPaint(read);
  const setPalette = (colors) => {
    if (colors.length > 255) throw new Error('This palette exceeds the 255 material limit.');
    for (const value of colors) {
      const c = typeof value === 'string' ? value.trim() : '';
      palette.push(
        /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(c)
          ? c.slice(0, 7)
          : DEFAULT_COLORS[palette.length % DEFAULT_COLORS.length],
      );
    }
  };
  if (prusa3) {
    warnings.push('Experimental PrusaSlicer 3 paint import (validated with 3.0.0-alpha12).');
    if (prusa3.flattenedRecipes)
      warnings.push(
        'Blend and gradient assignments were kept as flat color regions. Their mixing recipes were discarded; assign materials to these region numbers in the slicer.',
      );
    if (prusa3.palettes.length) setPalette(prusa3.palettes[0]);
    if (prusa3.palettes.some((p) => JSON.stringify(p) !== JSON.stringify(prusa3.palettes[0])))
      warnings.push(
        'The project has different palettes on different beds. Material slot numbers are preserved; the first palette is shown.',
      );
  }
  const config = read('Metadata/Slic3r_PE.config') || '';
  const colors =
    config.match(/^;?\s*extruder_colour\s*=\s*(.+)$/m)?.[1] ||
    config.match(/^;?\s*filament_colour\s*=\s*(.+)$/m)?.[1];
  if (!palette.length && colors) setPalette(colors.split(';'));
  const bambuSettings = read('Metadata/project_settings.config');
  if (!palette.length && bambuSettings)
    try {
      const settings = JSON.parse(bambuSettings),
        colors = settings.filament_colour || settings.filament_color || settings.extruder_colour;
      if (colors !== undefined && !Array.isArray(colors)) throw new Error('Invalid palette.');
      if (colors) setPalette(colors);
    } catch {
      warnings.push(
        'Unreadable project palette settings were ignored. Paint material numbers are preserved; check the display colors.',
      );
    }
  const objectSettings = new Map();
  const metadataOf = (el) =>
    Object.fromEntries(
      children(el, 'metadata')
        .filter((m) =>
          ['name', 'extruder', 'modifier', 'volume_type'].includes(m.getAttribute('key')),
        )
        .map((m) => [m.getAttribute('key'), m.getAttribute('value')]),
    );
  const prusaConfig = read('Metadata/Slic3r_PE_model.config');
  if (prusaConfig)
    for (const o of descendants(xml(prusaConfig), 'object')) {
      const metadata = metadataOf(o);
      const volumes = children(o, 'volume').map((v) => ({
        first: requiredNumber(v, 'firstid'),
        last: requiredNumber(v, 'lastid'),
        meta: metadataOf(v),
      }));
      if (objectSettings.has(o.getAttribute('id')))
        throw new Error('Duplicate 3MF object settings.');
      objectSettings.set(o.getAttribute('id'), { metadata, volumes });
    }
  const bambuConfig = read('Metadata/model_settings.config');
  if (prusa3 && (prusaConfig || bambuConfig))
    throw new Error(
      'Mixed PrusaSlicer 3 and legacy object metadata is ambiguous. Save the project in its slicer first.',
    );
  if (bambuConfig)
    for (const o of descendants(xml(bambuConfig), 'object')) {
      if (objectSettings.has(o.getAttribute('id')))
        throw new Error('Ambiguous or mixed 3MF object settings.');
      objectSettings.set(o.getAttribute('id'), {
        metadata: metadataOf(o),
        volumes: [],
        parts: children(o, 'part').map((p) => ({
          id: p.getAttribute('id'),
          metadata: metadataOf(p),
          subtype: p.getAttribute('subtype'),
        })),
      });
    }
  if (prusa3) for (const [id, settings] of prusa3.objects) objectSettings.set(id, settings);
  function model(path) {
    path = path.toLowerCase();
    if (cache.has(path)) return cache.get(path);
    const content = read(path);
    if (!content) throw new Error(`Missing 3MF component: ${path}`);
    const doc = xml(content),
      el = doc.documentElement,
      resources = child(el, 'resources');
    if (el.localName !== 'model' || !resources) throw new Error('Invalid 3MF model resources.');
    // Resolve prefixes, not their spelling: p/m are conventions, not identities.
    const supportedExtensions = new Set([
      'http://schemas.microsoft.com/3dmanufacturing/production/2015/06',
      'http://schemas.microsoft.com/3dmanufacturing/material/2015/02',
    ]);
    for (const prefix of (el.getAttribute('requiredextensions') || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)) {
      if (!supportedExtensions.has(el.lookupNamespaceURI(prefix)))
        throw new Error(
          `Unsupported required 3MF extension: ${prefix}. Export a mesh-and-paint 3MF without this extension in the source app.`,
        );
    }
    const ids = new Set();
    for (const resource of Array.from(resources.childNodes).filter((e) => e.nodeType === 1)) {
      const id = resource.getAttribute('id');
      if (!/^\d+$/.test(id || '') || Number(id) < 1 || ids.has(id))
        throw new Error('Invalid or duplicate 3MF resource ID.');
      ids.add(id);
    }
    const application =
      children(el, 'metadata').find((m) => m.getAttribute('name') === 'Application')?.textContent ||
      '';
    if (/^PrusaSlicer[-\s]+(?:[3-9]|\d{2,})\./i.test(application) && !prusa3)
      throw new Error(
        'Missing PrusaSlicer 3 project/paint metadata. Save an editable 3MF in PrusaSlicer first.',
      );
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
    const versions = children(el, 'metadata').filter((m) =>
      /^(?:slic3rpe|BambuStudio|OrcaSlicer):MmPaintingVersion$/.test(m.getAttribute('name')),
    );
    if (versions.some((v) => ![0, 1, 2].includes(Number(v.textContent))))
      throw new Error(
        'This 3MF uses a newer paint format. Save a PrusaSlicer 2.x compatible 3MF first.',
      );
    data.paintVersion = Number(
      versions.find((v) => v.getAttribute('name') === 'slic3rpe:MmPaintingVersion')?.textContent ||
        0,
    );
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
    skipped = 0,
    visits = 0;
  function visit(path, id, transform, stack = [], inherited = 1, context = {}) {
    path = path.toLowerCase();
    if (++visits > 100000) throw new Error('The 3MF contains too many component instances.');
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
    const settings = path === root.toLowerCase() ? objectSettings.get(id) : undefined,
      part = context.part;
    if (
      part?.subtype &&
      ![
        'normal_part',
        'negative_part',
        'modifier_part',
        'support_enforcer',
        'support_blocker',
      ].includes(part.subtype)
    )
      throw new Error(`Unsupported Bambu/Orca part role: ${part.subtype}.`);
    if (part?.subtype && part.subtype !== 'normal_part') {
      skipped++;
      return;
    }
    if (part?.role && part.role !== 'ModelPart') {
      skipped++;
      return;
    }
    const fallback = positiveInt(
      part?.metadata.extruder,
      positiveInt(settings?.metadata.extruder, inherited),
    );
    const mesh = child(obj, 'mesh'),
      components = child(obj, 'components');
    const baseName =
      part?.metadata.name ||
      settings?.metadata.name ||
      context.name ||
      obj.getAttribute('name') ||
      filename.replace(/\.3mf$/i, '');
    if (mesh && components)
      throw new Error('A 3MF object cannot contain both mesh and components.');
    if (components) {
      const refs = children(components, 'component');
      if (
        settings?.parts?.length &&
        (settings.parts.length !== refs.length ||
          settings.parts.some((p, i) => p.id !== refs[i].getAttribute('objectid')))
      )
        throw new Error('Part settings do not match the 3MF components.');
      if (part?.paint && refs.length !== 1)
        throw new Error('PrusaSlicer 3 paint must refer to a single mesh per volume.');
      for (const [index, c] of refs.entries()) {
        const nextPath = attr(c, 'path') ? pathOf(attr(c, 'path'), path) : path;
        const scale = model(nextPath).unit / data.unit;
        visit(
          nextPath,
          c.getAttribute('objectid'),
          transform
            .clone()
            .multiply(matrix(c.getAttribute('transform')))
            .scale(new Vector3(scale, scale, scale)),
          [...stack, key],
          fallback,
          { part: settings?.parts?.[index] || part, name: baseName },
        );
      }
    }
    if (!mesh) return;
    if (settings?.parts?.length)
      throw new Error(
        'Part metadata expects components, but this object contains a combined mesh. Save it again in its slicer first.',
      );
    if (!Number.isFinite(transform.determinant()) || transform.determinant() === 0)
      throw new Error('Invalid or collapsed 3MF object transform.');
    const verts = children(child(mesh, 'vertices'), 'vertex').map((v) => {
      const p = ['x', 'y', 'z'].map((k) => requiredNumber(v, k));
      const result = new Vector3(...p).applyMatrix4(transform).toArray();
      if (!result.every(Number.isFinite))
        throw new Error('The mesh contains an invalid transformed vertex.');
      return result;
    });
    const triangles = children(child(mesh, 'triangles'), 'triangle');
    sourceTriangles += triangles.length;
    if (sourceTriangles > MAX_FACES)
      throw new Error('The model exceeds the 1.5 million triangle import limit.');
    if (part?.paint && [...part.paint.keys()].some((i) => i >= triangles.length))
      throw new Error('PrusaSlicer 3 paint references a missing triangle.');
    const groups = settings?.volumes.length
      ? settings.volumes
      : [{ first: 0, last: triangles.length - 1, meta: {} }];
    let nextTriangle = 0;
    for (const group of [...groups].sort((a, b) => a.first - b.first)) {
      if (
        !Number.isInteger(group.first) ||
        !Number.isInteger(group.last) ||
        group.first !== nextTriangle ||
        group.last < group.first ||
        group.last >= triangles.length
      )
        throw new Error(
          'Invalid, overlapping or incomplete volume triangle range in 3MF metadata.',
        );
      nextTriangle = group.last + 1;
    }
    if (nextTriangle !== triangles.length)
      throw new Error('Incomplete volume triangle ranges in 3MF metadata.');
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
        const prusa = part?.paint?.get(i) ?? attr(t, 'mmu_segmentation'),
          bambu = attr(t, 'paint_color');
        if (
          part?.paint?.has(i) &&
          attr(t, 'mmu_segmentation') &&
          prusa !== attr(t, 'mmu_segmentation')
        )
          throw new Error('Conflicting XML and JSON triangle paint.');
        let material = defaultMaterial;
        if (!prusa && !bambu) {
          const pid = t.getAttribute('pid') || obj.getAttribute('pid'),
            p1 = t.getAttribute('p1') || obj.getAttribute('pindex') || '0',
            resource = data.resources.get(pid);
          if (resource) {
            if (!['basematerials', 'colorgroup'].includes(resource.localName))
              throw new Error(
                'Texture and composite 3MF materials are not supported. Convert them to slicer paint first.',
              );
            if (['p2', 'p3'].some((k) => t.hasAttribute(k) && t.getAttribute(k) !== p1))
              throw new Error(
                'Interpolated vertex colors are not supported. Convert them to slicer paint first.',
              );
            const entries = children(
                resource,
                resource.localName === 'basematerials' ? 'base' : 'color',
              ),
              property = Number(p1);
            if (!Number.isInteger(property) || property < 0 || property >= entries.length)
              throw new Error('A triangle references a missing color region.');
            // Property IDs define regions. Equal RGB swatches must not merge
            // independently assignable labels (including separately scoped resources).
            const resourceKey = `${path}#${pid}`;
            if (!colorRegions.has(resourceKey)) {
              const colors = entries.map((entry, index) => {
                const c = entry.getAttribute('color') || entry.getAttribute('displaycolor') || '';
                return /^#[\da-f]{6}/i.test(c)
                  ? c.slice(0, 7)
                  : DEFAULT_COLORS[index % DEFAULT_COLORS.length];
              });
              const reusePalette =
                !colorRegions.size &&
                colors.length === palette.length &&
                colors.every((c, i) => c.toUpperCase() === palette[i].toUpperCase());
              const start = reusePalette ? 0 : palette.length;
              if (start + colors.length > 255)
                throw new Error('This model exceeds the 255 color-region limit.');
              if (!reusePalette) palette.push(...colors);
              colorRegions.set(
                resourceKey,
                colors.map((_, i) => start + i + 1),
              );
            }
            material = colorRegions.get(resourceKey)[property];
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
      const leafCount = decoded.length;
      decoded = conformPaint(decoded);
      resolved += decoded.length - leafCount;
      if (resolved > MAX_FACES)
        throw new Error('Conforming paint exceeds the 1.5 million triangle limit.');
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
  if (prusa3)
    for (const [index, instance] of prusa3.instances) {
      if (!items[index] || items[index].getAttribute('objectid') !== instance.id)
        throw new Error('PrusaSlicer 3 instance metadata does not match the build.');
    }
  for (const [index, item] of items.entries()) {
    if (
      ['0', 'false'].includes(item.getAttribute('printable')) ||
      prusa3?.instances.get(index)?.printable === false
    ) {
      skipped++;
      continue;
    }
    const itemPath = attr(item, 'path') ? pathOf(attr(item, 'path'), root) : root;
    if (prusa3 && (itemPath !== root || !objectSettings.has(item.getAttribute('objectid'))))
      throw new Error('Missing PrusaSlicer 3 object metadata.');
    const scale = model(itemPath).unit / rootData.unit;
    visit(
      itemPath,
      item.getAttribute('objectid'),
      new Matrix4()
        .makeScale(rootData.unit, rootData.unit, rootData.unit)
        .multiply(matrix(item.getAttribute('transform')))
        .scale(new Vector3(scale, scale, scale)),
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
  return {
    pieces,
    palette,
    warnings,
    filename,
    sourceTriangles,
    paintedTriangles,
    format: prusa3
      ? 'prusa3'
      : children(rootData.el, 'metadata').some(
            (m) =>
              m.getAttribute('name') === 'OrcaSlicer' ||
              (m.getAttribute('name') === 'Application' && /^OrcaSlicer-/i.test(m.textContent)),
          )
        ? 'orca'
        : 'universal',
  };
}

export function export3mf(pieces, palette, options = {}) {
  const format = options.format || 'universal';
  if (!['universal', 'orca', 'prusa3'].includes(format))
    throw new Error('Unknown 3MF export format.');
  const prusa3 = format === 'prusa3';
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
  const paintVersion = pieces.some((piece) => piece.faces.some((face) => face.material > 16))
    ? 2
    : 1;
  if (format === 'orca' && paintVersion > 1)
    throw new Error(
      'OrcaSlicer 2.4.2 supports painted material slots 1–16. Reassign higher slots before exporting, or choose PrusaSlicer / Bambu Studio.',
    );
  const meshId = (i) => 2 + i * (prusa3 ? 3 : 1);
  const objectId = (i) => meshId(i) + (prusa3 ? 2 : 0);
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
      const id = meshId(index),
        name = xmlEscape(piece.name);
      return (
        `<object id="${id}" type="model" name="${name}"><mesh><vertices>${vertices}</vertices><triangles>${faces}</triangles></mesh></object>` +
        (prusa3
          ? `<object id="${id + 1}" type="model" name="${name}"><components><component objectid="${id}"/></components></object><object id="${id + 2}" type="model" name="${name}"><components><component objectid="${id + 1}"/></components></object>`
          : '')
      );
    })
    .join('');
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"><metadata name="Application">3MF Paint Split 1.0</metadata><metadata name="slic3rpe:Version3mf">1</metadata><metadata name="slic3rpe:MmPaintingVersion">${paintVersion}</metadata><resources><m:colorgroup id="1">${palette.map((c) => `<m:color color="${xmlEscape(c)}FF"/>`).join('')}</m:colorgroup>${objects}</resources><build>${pieces.map((_, i) => `<item objectid="${objectId(i)}"/>`).join('')}</build></model>`;
  // PrusaSlicer 3 no longer imports legacy XML paint reliably. Its native JSON
  // sidecars hold ONLY volume identity and paint; an empty container list lets
  // the slicer use the user's own profiles and physical material slots.
  const annotations = prusa3
    ? {
        'Metadata/PrusaSlicer3_project.json': strToU8(
          JSON.stringify({
            project: { id: '00000000-0000-4000-8000-000000000001', version: 0 },
            objects: pieces.map((_, i) => ({
              id: objectId(i),
              object_settings: {},
              volumes: [{ id: meshId(i) + 1, type: 'ModelPart', volume_settings: {} }],
            })),
            config_containers: [],
          }),
        ),
        'Metadata/Slic3r_facets_annotation.json': strToU8(
          JSON.stringify(
            pieces.map((p, i) => ({
              id: meshId(i) + 1,
              mmSegmentationFacetsVersion: paintVersion,
              mmSegmentationFacets: p.faces.map((f, triangle) => ({
                triangle,
                dividing: encodePaint(f.material),
              })),
            })),
          ),
        ),
      }
    : {};
  return zipSync(
    {
      '[Content_Types].xml': strToU8(
        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>${prusa3 ? '<Default Extension="json" ContentType="application/json"/>' : ''}</Types>`,
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
      ),
      '3D/3dmodel.model': strToU8(model),
      ...annotations,
    },
    { level: 6 },
  );
}

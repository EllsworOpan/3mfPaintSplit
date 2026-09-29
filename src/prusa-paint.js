// PrusaSlicer 3 keeps volume roles and material assignments in the project JSON,
// and attaches sparse triangle paint to volume wrappers, not shared mesh IDs.
// Read only that information; printer, print, support and seam settings are unused.
const PROJECT = 'Metadata/PrusaSlicer3_project.json';
const PAINT = 'Metadata/Slic3r_facets_annotation.json';
const roles = new Set([
  'ModelPart',
  'NegativeVolume',
  'ParameterModifier',
  'SupportEnforcer',
  'SupportBlocker',
]);
const fail = (message) => {
  throw new Error(`Invalid PrusaSlicer 3 paint project: ${message}`);
};
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object.');
  return value;
}
function list(value) {
  if (!Array.isArray(value)) fail('expected a list.');
  return value;
}
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('invalid resource or triangle index.');
  return value;
}
function json(text, path) {
  if (text === null) fail(`missing ${path}.`);
  try {
    return JSON.parse(text);
  } catch {
    fail(`unreadable ${path}.`);
  }
}

export function readPrusaPaint(read) {
  const text = read(PROJECT),
    annotations = read(PAINT);
  if (text === null && annotations === null) return null;
  const data = record(json(text, PROJECT));
  const objects = new Map(),
    volumes = new Set(),
    instances = new Map();
  for (const value of list(data.objects)) {
    const object = record(value),
      id = String(integer(object.id, 1));
    if (objects.has(id)) fail('duplicate object.');
    const localIds = new Set();
    const parts = list(object.volumes).map((value) => {
      const volume = record(value),
        id = String(integer(volume.id, 1));
      if (localIds.has(id) || !roles.has(volume.type))
        fail('duplicate volume or unknown volume role.');
      localIds.add(id);
      volumes.add(id);
      return {
        id,
        metadata: { extruder: record(volume.volume_settings ?? {}).extruder },
        role: volume.type,
      };
    });
    if (!parts.length) fail('object has no volumes.');
    objects.set(id, {
      metadata: { extruder: record(object.object_settings ?? {}).extruder },
      volumes: [],
      parts,
    });
    for (const value of list(object.instances ?? [])) {
      const instance = record(value),
        index = integer(instance.ord);
      if (instances.has(index) || typeof instance.printable !== 'boolean')
        fail('invalid instance metadata.');
      instances.set(index, { id, printable: instance.printable });
    }
  }
  const painting = new Map();
  for (const value of annotations === null ? [] : list(json(annotations, PAINT))) {
    const entry = record(value),
      id = String(integer(entry.id, 1));
    if (!volumes.has(id) || painting.has(id)) fail('missing or duplicate painted volume.');
    const faces = new Map();
    if (entry.mmSegmentationFacets !== undefined) {
      if (![1, 2].includes(entry.mmSegmentationFacetsVersion))
        fail('unsupported newer paint format.');
      for (const value of list(entry.mmSegmentationFacets)) {
        const face = record(value),
          index = integer(face.triangle);
        if (faces.has(index) || typeof face.dividing !== 'string' || !face.dividing.length)
          fail('invalid or duplicate triangle paint.');
        faces.set(index, face.dividing);
      }
    }
    painting.set(id, faces);
  }
  for (const object of objects.values())
    for (const part of object.parts) part.paint = painting.get(part.id) ?? new Map();
  const palettes = [];
  for (const value of list(data.config_containers ?? [])) {
    const container = record(value);
    if (list(container.virtual_extruders ?? []).length)
      throw new Error(
        'PrusaSlicer 3 blend/gradient materials cannot be preserved as physical paint slots. Convert them to physical materials in PrusaSlicer before importing.',
      );
    const config = record(container.configuration ?? {});
    const projectColors = record(config.project_settings ?? {}).extruder_colour;
    const filamentColors = record(config.filament_settings ?? {}).filament_colour;
    const colors =
      Array.isArray(projectColors) && projectColors.length ? projectColors : filamentColors;
    if (Array.isArray(colors) && colors.length) palettes.push(colors);
  }
  return { objects, instances, palettes };
}

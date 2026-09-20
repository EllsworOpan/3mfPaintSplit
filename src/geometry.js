import earcut, { deviation } from 'earcut';
import { midpoint } from './paint.js';

export const EPS = 1e-7;
export const MAX_FACES = 1500000;
export const add = (a, b) => a.map((x, i) => x + b[i]);
export const sub = (a, b) => a.map((x, i) => x - b[i]);
export const mul = (a, s) => a.map((x) => x * s);
export const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a) => Math.hypot(...a);
export const normalize = (a) => mul(a, 1 / length(a));
export const pointKey = (p) => p.map((x) => Math.round(x / EPS)).join(',');
const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);

export function bounds(meshes) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes)
    for (const p of mesh.vertices)
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], p[i]);
        max[i] = Math.max(max[i], p[i]);
      }
  return { min, max, center: midpoint(min, max), size: sub(max, min) };
}

export function makeMesh(triangles, name = 'Piece') {
  const vertices = [],
    faces = [],
    map = new Map();
  for (const t of triangles) {
    const v = t.v.map((p) => {
      const k = pointKey(p);
      if (!map.has(k)) {
        map.set(k, vertices.length);
        vertices.push(p);
      }
      return map.get(k);
    });
    if (
      new Set(v).size === 3 &&
      length(cross(sub(t.v[1], t.v[0]), sub(t.v[2], t.v[0]))) > EPS * EPS
    )
      faces.push({ v, material: t.material, cap: !!t.cap });
    if (faces.length > MAX_FACES)
      throw new Error('This model exceeds the 1.5 million resolved triangle limit.');
  }
  return { vertices, faces, name };
}

// Painted leaves may meet an unsplit neighbor partway along an edge. Introduce
// those existing dyadic vertices into the neighbor without moving paint borders.
export function conformPaint(triangles) {
  const points = new Map();
  for (const t of triangles) for (const p of t.v) points.set(pointKey(p), p);
  const output = [];
  function emit(t, depth = 0) {
    if (depth > 64 || output.length > MAX_FACES)
      throw new Error('Paint subdivision exceeds the supported mesh complexity.');
    for (let i = 0; i < 3; i++) {
      const a = t.v[i],
        b = t.v[(i + 1) % 3],
        c = t.v[(i + 2) % 3];
      const m = points.get(pointKey(midpoint(a, b)));
      if (m && length(sub(m, a)) > EPS * 2 && length(sub(m, b)) > EPS * 2) {
        emit({ ...t, v: [a, m, c] }, depth + 1);
        emit({ ...t, v: [m, b, c] }, depth + 1);
        return;
      }
    }
    output.push(t);
  }
  for (const t of triangles) emit(t);
  return output;
}

export function meshHealth(mesh) {
  const edges = new Map();
  let volume = 0;
  for (const f of mesh.faces) {
    const [a, b, c] = f.v.map((i) => mesh.vertices[i]);
    volume += dot(a, cross(b, c)) / 6;
    for (let j = 0; j < 3; j++) {
      const u = f.v[j],
        v = f.v[(j + 1) % 3],
        key = edgeKey(u, v);
      const e = edges.get(key) || { count: 0, direction: 0 };
      e.count++;
      e.direction += u < v ? 1 : -1;
      edges.set(key, e);
    }
  }
  let boundary = 0,
    nonmanifold = 0,
    inconsistent = 0;
  for (const e of edges.values()) {
    if (e.count === 1) boundary++;
    else if (e.count !== 2) nonmanifold++;
    else if (e.direction !== 0) inconsistent++;
  }
  return {
    boundary,
    nonmanifold,
    inconsistent,
    volume: Math.abs(volume),
    closed: boundary === 0 && nonmanifold === 0 && inconsistent === 0,
  };
}

function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

function capMesh(mesh, n, offset, outward, material) {
  const edges = new Map();
  for (const f of mesh.faces)
    for (let i = 0; i < 3; i++) {
      const a = f.v[i],
        b = f.v[(i + 1) % 3];
      if (
        Math.abs(dot(mesh.vertices[a], n) - offset) > EPS * 4 ||
        Math.abs(dot(mesh.vertices[b], n) - offset) > EPS * 4
      )
        continue;
      const key = edgeKey(a, b);
      const e = edges.get(key) || { a, b, count: 0 };
      e.count++;
      edges.set(key, e);
    }
  const links = new Map();
  for (const e of edges.values())
    if (e.count === 1)
      for (const [a, b] of [
        [e.a, e.b],
        [e.b, e.a],
      ]) {
        if (!links.has(a)) links.set(a, []);
        links.get(a).push(b);
      }
  for (const adj of links.values())
    if (adj.length !== 2)
      throw new Error(
        'The cut touches an ambiguous edge or an open surface. Move the plane slightly, or repair the source model.',
      );
  const u = normalize(cross(Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0], n)),
    v = cross(n, u);
  const seen = new Set(),
    loops = [];
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const ids = [];
    let cur = start,
      prev = -1;
    do {
      if (seen.has(cur))
        throw new Error('The cut contour intersects itself. Try a slightly different plane.');
      seen.add(cur);
      ids.push(cur);
      const next = links.get(cur).find((i) => i !== prev);
      prev = cur;
      cur = next;
    } while (cur !== start);
    const xy = ids.map((i) => [dot(mesh.vertices[i], u), dot(mesh.vertices[i], v)]);
    const area = Math.abs(
      xy.reduce((s, p, i) => {
        const q = xy[(i + 1) % xy.length];
        return s + p[0] * q[1] - q[0] * p[1];
      }, 0) / 2,
    );
    loops.push({ ids, xy, area, parent: null, depth: 0 });
  }
  loops.sort((a, b) => b.area - a.area);
  for (let i = 0; i < loops.length; i++)
    for (let j = i - 1; j >= 0; j--)
      if (pointInPolygon(loops[i].xy[0], loops[j].xy)) {
        loops[i].parent = loops[j];
        loops[i].depth = loops[j].depth + 1;
        break;
      }
  function emit(ids) {
    const p = ids.map((i) => mesh.vertices[i]);
    if (dot(cross(sub(p[1], p[0]), sub(p[2], p[0])), outward) < 0) ids = [ids[0], ids[2], ids[1]];
    mesh.faces.push({ v: ids, material, cap: true });
  }
  for (const outer of loops.filter((l) => l.depth % 2 === 0)) {
    const rings = [outer, ...loops.filter((l) => l.parent === outer)],
      flat = [],
      ids = [],
      holes = [],
      locations = [];
    for (let r = 0; r < rings.length; r++) {
      if (r) holes.push(ids.length);
      const ring = rings[r];
      for (let j = 0; j < ring.ids.length; j++) {
        const a = mesh.vertices[ring.ids[(j + ring.ids.length - 1) % ring.ids.length]],
          b = mesh.vertices[ring.ids[j]],
          c = mesh.vertices[ring.ids[(j + 1) % ring.ids.length]];
        // Floating point noise can turn a collinear point into a tiny ear.
        // Triangulate the corner polygon, then restore its exact edge chains.
        if (
          length(cross(sub(b, a), sub(c, b))) <=
            EPS * 8 * (length(sub(b, a)) + length(sub(c, b))) &&
          dot(sub(b, a), sub(c, b)) > 0
        )
          continue;
        flat.push(...ring.xy[j]);
        ids.push(ring.ids[j]);
        locations.push([r, j]);
      }
    }
    const tris = earcut(flat, holes, 2);
    if (deviation(flat, holes, 2, tris) > 1e-6)
      throw new Error('Could not triangulate this cut surface reliably. Try a different plane.');
    // Earcut may remove collinear contour points. Restore every boundary segment
    // so caps and painted sidewalls share precisely the same edges.
    function chain(a, b) {
      const [ra, ia] = locations[a],
        [rb, ib] = locations[b];
      if (ra !== rb) return [ids[a]];
      const ring = rings[ra],
        pa = mesh.vertices[ids[a]],
        pb = mesh.vertices[ids[b]],
        ab = sub(pb, pa),
        norm = dot(ab, ab);
      for (const dir of [1, -1]) {
        const out = [ids[a]];
        let i = (ia + dir + ring.ids.length) % ring.ids.length,
          valid = true;
        while (i !== ib) {
          const id = ring.ids[i],
            ap = sub(mesh.vertices[id], pa),
            t = dot(ap, ab) / norm;
          if (t <= 0 || t >= 1 || length(cross(ap, ab)) > EPS * 8 * Math.sqrt(norm)) {
            valid = false;
            break;
          }
          out.push(id);
          i = (i + dir + ring.ids.length) % ring.ids.length;
        }
        if (valid) return out;
      }
      return [ids[a]];
    }
    for (let i = 0; i < tris.length; i += 3) {
      const abc = tris.slice(i, i + 3),
        perimeter = [];
      for (let j = 0; j < 3; j++) perimeter.push(...chain(abc[j], abc[(j + 1) % 3]));
      if (perimeter.length === 3) emit(perimeter);
      else {
        const center = mul(abc.map((k) => mesh.vertices[ids[k]]).reduce(add, [0, 0, 0]), 1 / 3),
          ci = mesh.vertices.length;
        mesh.vertices.push(center);
        for (let j = 0; j < perimeter.length; j++)
          emit([perimeter[j], perimeter[(j + 1) % perimeter.length], ci]);
      }
    }
  }
}

export function splitMesh(mesh, normal, offset, capMaterial = 1) {
  if (
    (!Array.isArray(normal) && !ArrayBuffer.isView(normal)) ||
    normal.length !== 3 ||
    !normal.every(Number.isFinite) ||
    !Number.isFinite(offset) ||
    length(normal) < EPS
  )
    throw new Error('Enter a valid cut plane.');
  if (!Number.isInteger(capMaterial) || capMaterial < 1 || capMaterial > 255)
    throw new Error('Choose a valid cut face material (1–255).');
  const norm = length(normal),
    n = mul(normal, 1 / norm);
  offset /= norm;
  const distances = mesh.vertices.map((p) => {
    const d = dot(p, n) - offset;
    return Math.abs(d) < EPS ? 0 : d;
  });
  if (!distances.some((d) => d > 0) || !distances.some((d) => d < 0))
    throw new Error('The plane must pass through the interior of the selected piece.');
  const health = mesh.health || meshHealth(mesh);
  if (!health.closed)
    throw new Error(
      'This piece has open, non-manifold, or inconsistently oriented edges. Repair the source mesh before cutting.',
    );
  const sides = [[], []],
    intersection = new Map();
  const projected = mesh.vertices.map((p, i) =>
    distances[i] === 0 ? sub(p, mul(n, dot(p, n) - offset)) : p,
  );
  function intersect(a, b) {
    if (distances[a] === 0) return projected[a];
    if (distances[b] === 0) return projected[b];
    const key = edgeKey(a, b);
    if (!intersection.has(key)) {
      const t = distances[a] / (distances[a] - distances[b]);
      let p = add(projected[a], mul(sub(projected[b], projected[a]), t));
      p = sub(p, mul(n, dot(p, n) - offset));
      intersection.set(key, p);
    }
    return intersection.get(key);
  }
  for (const f of mesh.faces) {
    if (f.v.every((i) => distances[i] === 0)) {
      const ps = f.v.map((i) => projected[i]),
        fn = cross(sub(ps[1], ps[0]), sub(ps[2], ps[0]));
      sides[dot(fn, n) > 0 ? 1 : 0].push({ ...f, v: ps });
      continue;
    }
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1,
        poly = [];
      for (let i = 0; i < 3; i++) {
        const a = f.v[i],
          b = f.v[(i + 1) % 3],
          inside = distances[a] * sign >= 0,
          next = distances[b] * sign >= 0;
        if (inside) poly.push(projected[a]);
        if (inside !== next) poly.push(intersect(a, b));
      }
      for (let j = 1; j + 1 < poly.length; j++)
        sides[side].push({ ...f, v: [poly[0], poly[j], poly[j + 1]] });
    }
  }
  const pieces = sides.map((tris, i) => {
    const result = makeMesh(tris, `${mesh.name} · ${i === 0 ? 'A' : 'B'}`);
    capMesh(result, n, offset, mul(n, i === 0 ? -1 : 1), capMaterial);
    result.health = meshHealth(result);
    if (!result.health.closed)
      throw new Error(
        'The cut could not produce closed pieces. Move or tilt the plane slightly. Your original piece is unchanged.',
      );
    return result;
  });
  const volume = pieces.reduce((s, p) => s + p.health.volume, 0);
  if (Math.abs(volume - health.volume) > Math.max(1e-5, health.volume * 1e-5))
    throw new Error('Cut validation found a volume mismatch. The original piece is unchanged.');
  return pieces;
}

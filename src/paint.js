// Independent implementation of the on-disk TriangleSelector format.
// See docs/FORMAT.md for upstream format references and dialect differences.
export const midpoint = (a, b) => a.map((x, i) => (x + b[i]) / 2);

export function childrenOf(v, sides, side) {
  const [a, b, c] = [v[side], v[(side + 1) % 3], v[(side + 2) % 3]];
  if (sides === 1) {
    const m = midpoint(b, c);
    return [
      [a, b, m],
      [m, c, a],
    ];
  }
  const ab = midpoint(a, b),
    ca = midpoint(c, a);
  if (sides === 2)
    return [
      [a, ab, ca],
      [ab, b, ca],
      [b, c, ca],
    ];
  const bc = midpoint(b, c);
  return [
    [a, ab, ca],
    [ab, b, bc],
    [bc, c, ca],
    [ab, bc, ca],
  ];
}

export function decodePaint(v, hex, fallback = 1, dialect = 'prusa') {
  if (!hex) return [{ v, material: fallback }];
  if (!/^[\da-f]+$/i.test(hex)) throw new Error('Invalid triangle paint encoding.');
  let cursor = hex.length - 1;
  const next = () => {
    if (cursor < 0) throw new Error('Truncated triangle paint data.');
    return parseInt(hex[cursor--], 16);
  };
  const result = [];
  function read(points, depth = 0) {
    if (depth > 40 || result.length > 1000000)
      throw new Error('Triangle paint is too deeply subdivided.');
    const code = next(),
      sides = code & 3,
      side = code >> 2;
    if (sides) {
      if (side > 2 || (sides === 3 && side !== 0))
        throw new Error('Unsupported triangle paint subdivision.');
      const children = childrenOf(points, sides, side);
      for (let i = children.length - 1; i >= 0; i--) read(children[i], depth + 1);
    } else {
      let state = side;
      if (state === 3) {
        let n = next();
        if (dialect === 'bambu') {
          state = 3;
          while (n === 15) {
            state += 15;
            n = next();
          }
          state += n;
        } else state = n === 14 ? 17 + next() + 16 * next() : n + 3;
      }
      if (state > 255) throw new Error('Paint uses an unsupported material index.');
      result.push({ v: points, material: state || fallback });
    }
  }
  read(v);
  if (cursor >= 0) throw new Error('Unrecognized trailing triangle paint data.');
  return result;
}

export function encodePaint(state, dialect = 'prusa') {
  if (!Number.isInteger(state) || state < 0 || state > 255)
    throw new Error('Invalid material index.');
  if (state < 3) return (state * 4).toString(16).toUpperCase();
  if (dialect === 'bambu')
    return (
      ((state - 3) % 15).toString(16).toUpperCase() + 'F'.repeat(Math.floor((state - 3) / 15)) + 'C'
    );
  return state < 17
    ? (state - 3).toString(16).toUpperCase() + 'C'
    : (state - 17).toString(16).toUpperCase().padStart(2, '0') + 'EC';
}

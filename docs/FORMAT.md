# Geometry and paint format notes

This app independently implements the serialized TriangleSelector format. It does not link to, copy, or modify PrusaSlicer or Bambu Studio code.

Authoritative format references:

- [PrusaSlicer 2.9.6 TriangleSelector](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/TriangleSelector.cpp): `perform_split`, `serialize`, `decode_leaf_state`, and `deserialize` define child geometry, traversal order, and extended state encodings.
- [PrusaSlicer 2.9.6 3MF handling](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/Format/3mf.cpp): model metadata, per-volume triangle ranges, native paint attributes, and palette config.
- [Bambu Studio TriangleSelector](https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/TriangleSelector.cpp): continuation-nibble encoding for extended material indices.

## On-disk paint trees

Hex strings are read from right to left. The two low bits of each node indicate the number of split sides. Zero denotes a leaf; the upper bits encode states 0–2 directly or introduce additional nibbles. State zero falls back to the volume/object material. Internal nodes encode the special side in their upper bits, with children serialized in reverse order. The exact midpoint splitting rules and winding are important: reusing the original paint string on a newly clipped triangle would change the paint's spatial location.

PrusaSlicer 2.9.6 uses `E` as the second nibble to introduce an additional byte for states 17–255. Bambu/Orca instead use repeated `F` continuation nibbles. For example, material 18 is `01EC` in current PrusaSlicer and `0FC` in Bambu. Both attributes are exported with their correct encoding, not a single shared string.

## Geometry processing

1. Resolve component transforms and unit conversions into millimeter model coordinates.
2. Expand paint trees to leaf triangles with explicit 1-based material numbers.
3. Introduce existing dyadic midpoint vertices into adjacent triangles to remove paint-boundary T-junctions.
4. Weld vertices at a 0.0000001 mm coordinate key tolerance and check edge incidence/winding.
5. Clip each triangle to both plane half-spaces. Reuse shared edge intersections.
6. Recover closed contour loops from open edges on the plane. Nest loops to identify holes and islands.
7. Triangulate caps with earcut. Restore every collinear boundary vertex so cap triangles and sidewalls have matching edges.
8. Reject outputs with open/non-manifold/inconsistent edges or a total-volume mismatch. Only then replace the source piece.

Cuts do not introduce clearance, translate objects, generate joints, or reorient pieces. New cut faces carry an explicit selected material. Original triangles' support and seam annotations cannot be transferred by this paint-only pipeline and are intentionally omitted.

## Export contract

The output is a geometry-and-paint 3MF in the traditional Prusa-compatible schema, with one object per resulting piece, explicit native face paint, a standard material color group, and newly generated model configuration matching the new face indices. Minimal filament colors and placeholder nozzle/filament dimensions allow the palette to travel with the archive; users must apply their actual printer and filament profiles in PrusaSlicer.

No old model configuration or print job is copied wholesale: doing so would leave volume ranges, triangle references, supports, and other geometry-dependent metadata stale after clipping.

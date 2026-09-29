# Geometry and paint format notes

This app independently implements the serialized TriangleSelector format. It does not link to, copy, or modify PrusaSlicer or Bambu Studio code.

Authoritative format references:

- [PrusaSlicer 2.9.6 TriangleSelector](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/TriangleSelector.cpp): `perform_split`, `serialize`, `decode_leaf_state`, and `deserialize` define child geometry, traversal order, and extended state encodings.
- [PrusaSlicer 2.9.6 3MF handling](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/Format/3mf.cpp): model metadata, per-volume triangle ranges, native paint attributes, and palette config.
- [Bambu Studio TriangleSelector](https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/TriangleSelector.cpp): continuation-nibble encoding for extended material indices.

## On-disk paint trees

Hex strings are read from right to left. The two low bits of each node indicate the number of split sides. Zero denotes a leaf; the upper bits encode states 0–2 directly or introduce additional nibbles. State zero falls back to the volume/object material. Internal nodes encode the special side in their upper bits, with children serialized in reverse order. The exact midpoint splitting rules and winding are important: reusing the original paint string on a newly clipped triangle would change the paint's spatial location.

PrusaSlicer 2.9.6 uses `E` as the second nibble to introduce an additional byte for states 17–255. Bambu instead uses repeated `F` continuation nibbles. For example, material 18 is `01EC` in current PrusaSlicer and `0FC` in Bambu. Both attributes are exported with their correct encoding. OrcaSlicer 2.4.2 supports painted slots 1–16; its export target rejects higher painted slots. This is a limit on triangle paint, not on the length of a project's filament list.

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

The default PrusaSlicer 2 / Bambu output and the range-checked Orca output contain exactly three ZIP entries: `[Content_Types].xml`, `_rels/.rels`, and `3D/3dmodel.model`. They have one object per resulting piece, explicit native face paint in both dialects, names, and a standard material color group. They contain no slicer configuration files. In particular, there is no `Slic3r_PE.config`, `project_settings.config`, printer definition, nozzle/filament dimensions, or print profile. Palette colors are standard model data; material slot order must match the user's current slicer setup.

PrusaSlicer 3 output adds its native JSON sidecars: `PrusaSlicer3_project.json` supplies only object/volume identities with empty settings and `config_containers: []`; `Slic3r_facets_annotation.json` supplies only MMU paint. Meshes are wrapped in volume components so annotations refer to the correct ordered triangles. No hardware/material-slot descriptors, printer presets, or profile values are synthesized. This separate output is necessary because alpha12 drops paint from model-only legacy XML imports. It has been validated by saving the export in the alpha12 CLI and checking the paint spatially afterward.

No old model configuration or print job is copied wholesale: doing so would leave volume ranges, triangle references, supports, and other geometry-dependent metadata stale after clipping.

## Import and automatic recovery

Each loaded model part resolves `requiredextensions` prefixes to namespace URIs and rejects unknown or undeclared required extensions, including in external component files. This follows [3MF Core 1.3 §3.4](https://github.com/3MFConsortium/spec_core/blob/1.3.0/3MF%20Core%20Specification.md#34-model). Unknown optional extensions can be ignored; an unsupported required extension may change the meaning of the geometry.

Only model resources and the recognized role/material/palette/paint sidecars are inflated. G-code, thumbnails, textures, unrelated configs and other annotations are ignored. Object and volume metadata is reduced to names, material defaults and roles; Bambu/Orca part settings stay scoped to their parent component rather than using a global part-ID lookup. PrusaSlicer 3 paint is carried from its volume wrapper down to the shared mesh and never attached globally to a mesh ID.

Import automatically ignores an unreadable optional Bambu/Orca project palette and warns that display colors need checking. There is no import mode toggle or options argument: call `import3mf(bytes, name, progress)`. Geometry/paint validation always rejects missing or ambiguous role metadata, invalid ranges, unsupported paint versions, and corrupt paint. Recovery does not turn modifiers into solid model parts or silently discard painting. PrusaSlicer 3 blend/gradient assignments retain their numeric IDs as ordinary flat regions, with a warning; mixing recipes are discarded and a gradient is not reconstructed. Reading paint does not require its printer configuration or hardware records. Different bed palettes retain numeric slots, with the first palette shown and a warning.

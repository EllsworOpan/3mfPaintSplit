# Native slicer import fixtures

These original box models come from the sibling `WebRollingBrim3mf` project's
`tests/fixtures` directory, under its MIT license (included as `LICENSE`). They
contain test profiles, not user models or credentials. The profiles are used only
to exercise import; this app never includes them in exports.

- `painted-prusa.3mf` and `painted-instances-prusa.3mf`: saved by PrusaSlicer 2.9.6;
  multipart partial-face paint, modifiers, support/seam paint and mirrored instances.
- `painted-plates-bambu.3mf`: saved by Bambu Studio 2.8.2.61; external meshes,
  repeated instances, multiple plates, negative parts and a non-printing copy.
- `painted-plates-orca.3mf`: equivalent model saved by OrcaSlicer 2.4.2.
- `painted-plates-prusa3-alpha12.3mf`: saved by PrusaSlicer 3.0.0-alpha12; JSON
  annotations on shared mesh wrappers, multiple beds, all five volume roles,
  transformed instances and a non-printing copy.
- `multimaterial-mmu-prusa3-alpha12.3mf`: alpha12 blend and gradient materials;
  verifies conversion to flat region IDs with an explicit warning and no exported recipes or hardware.

Synthetic fixtures in `slicer-formats.test.js` cover malformed metadata, shared
resource IDs, mixed units and PrusaSlicer 3 partial-face paint independently of the
native samples. Optional CLI tests reopen model-only exports in installed slicers.

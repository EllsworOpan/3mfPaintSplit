# 3MF Paint Split

A standalone, local-first web app for cutting already painted 3MF models into printable pieces while keeping their PrusaSlicer MMU / Bambu AMS material assignments, and converting color regions to virtual extruders with or without cutting. This is a new application, not a Texture2Paint fork.

## Run with Docker

Start Docker Desktop, then run from this directory:

```powershell
docker compose up -d --build
```

Open **http://localhost:8081**. Texture2Paint can keep using port 8080. Rebuild with the same command after changing the app. Stop this app with `docker compose down`.

## Develop without Docker

Node.js 22 or newer is recommended.

```powershell
npm ci
npm run dev
```

Open **http://localhost:5174**. `npm run build` creates the static site in `dist`. `npm run preview` serves that production build.

## Use the app

1. Open or drop a painted `.3mf` file. Import always reads meshes, paint, material assignments and part roles, ignores unrelated slicer data, and automatically recovers an unreadable optional palette with a warning. It never skips invalid geometry, paint or volume metadata. The demo provides a quick way to try the workflow.
2. Cutting is optional: to convert colors only, skip directly to export and enable **Use virtual extruders**. To cut, select a piece. Choose X, Y, or Z for a centered plane, or set the position, tilt, and azimuth. The offset is measured from that piece's bounding-box center, along the plane normal. Move and Rotate handles also position the plane directly in the viewer.
3. Choose the material for the new interior faces and apply the cut. Both halves remain, with no kerf or gap introduced into their geometry.
4. Select a resulting piece and cut again if needed. The last 12 cuts can be undone. Preview spacing helps inspect the halves and never changes their exported positions. Moving the plane returns to the assembled preview.
5. Choose the target slicer and export all pieces or just the selected piece. Ordinary paint uses **PrusaSlicer 2 / Bambu Studio**, **OrcaSlicer 2.4.2 (paint slots 1–16)**, or **PrusaSlicer 3 (experimental)**. Native Orca and PrusaSlicer 3 inputs select their target automatically. Orca export rejects painted slots above 16; a longer palette is allowed if those slots are unused. Each piece is a separate 3MF object. Virtual mode selects its supported PrusaSlicer target automatically; disabling it restores your previous ordinary-paint target.
6. Open/import ordinary paint output into your existing slicer setup. Keep the original material slot order, orient the pieces, and slice. For virtual output, follow the Open Project instructions below. Exports contain mesh, paint, and optionally newly generated virtual-extruder recipes, with no printer, filament or print profiles, invented nozzle dimensions, G-code, or purge settings. Display colors travel in a standard 3MF color group; ordinary paint slots should match your current filament slots.

All parsing, geometry processing, and export run on your device. No file upload service, account, CDN, or network API is required. Dependencies are bundled into the static app. Color swatches edit the displayed/exported filament colors; they do not repaint surfaces or change material numbers.

Every format follows the same clean contract: resolve source paint into geometry and numbered color regions, apply any cuts and your selected cut-face region, then export those results. Inherited slicer settings never enter the output. Standard RGB swatches describe region colors; the receiving slicer supplies printer profiles and materials. Separate region numbers stay separate even when their swatches match.

## Virtual extruders without cutting

Open a painted 3MF and enable **Use virtual extruders** in the export panel. Choose **2–8 physical filament slots** (default 8), then click the numbered filament swatches to match your loaded filaments in tool order. The starting reference colors are Cyan, Magenta, Yellow, White, Black, Red, Green, Blue, truncated to your slot count. These are reference RGB values, not measured filament colors. Your edits remain when you reduce the slot count or switch back to ordinary paint.

Click **Save virtual-extruder 3MF** immediately, or make cuts first. Every color region used by the exported pieces, including cut-face colors, gets a distinct virtual extruder with an automatic starting recipe using up to three physical tools. Regions with identical RGB colors or recipes remain independently editable. Unused palette slots are omitted. Geometry and paint boundaries are retained; the conversion does not cut the model. Import still resolves partial-triangle paint into mesh triangles as usual.

Only **PrusaSlicer 2.9.6 or later** currently supports virtual export through the bundled API. Select a printer with the matching physical slot count, then use **File → Open Project** to retain virtual extruders; importing geometry alone discards them. Recipes are estimates you can edit in the slicer. The viewer and color-region swatches show desired colors, not the predicted appearance of printed mixtures. Changing a display swatch in the slicer does not automatically recalculate its recipe.

The app regenerates recipes from region colors and your chosen physical filaments; it does not copy original mixing recipes or printer settings. Virtual IDs follow the physical slots and are assigned deterministically by source region number. The format permits at most `255 − physical slot count` used virtual regions; exceeding that limit stops export with an error instead of dropping colors.

## Paint preservation

The importer decodes the slicer's recursive per-triangle paint tree, including partially painted triangles. It resolves colored leaves to explicit geometry and makes neighboring edges conform before cutting. Each clipped surface triangle retains its material assignment. The new planar caps use the selected interior material, including contours with holes. The exporter writes native `slic3rpe:mmu_segmentation`, dialect-correct `paint_color`, a standard color group, object names, and the filament palette.

The app checks edge connectivity, winding, and volume conservation before accepting a cut. A failed cut leaves the original piece intact. Resolving fine paint can increase triangle counts and export size; it does not sample or approximate the paint boundaries.

See [format notes](docs/FORMAT.md) for details and upstream references.

## Supported scope and limits

- PrusaSlicer 2.x triangle painting and Bambu Studio / OrcaSlicer `paint_color`, including nested production-extension components, object transforms, mirrored instances, standard 3MF units, and separately scoped external parts that reuse resource IDs.
- Experimental PrusaSlicer 3 JSON paint import/export, validated with 3.0.0-alpha12. Native volume wrappers, physical material assignments and printable instances are respected. Use its separate export option: alpha12 does not reliably retain legacy XML paint when opening a model-only archive. No hardware or profile definitions are generated.
- Axis-aligned and arbitrary planar cuts, multiple sequential cuts, hollow contours, independent objects, undo, orbit/pan/zoom, view presets, wireframe, and preview separation.
- Closed meshes with consistently oriented triangles are required for cutting. Repair open/non-manifold geometry in a mesh repair tool first. Ambiguous vertex-touching or intersecting contours may require moving the plane slightly.
- Supports, seams, negative/modifier volumes, printer settings, custom G-code, textures, connectors, variable layers, and assembly metadata are not preserved. Non-printing objects are excluded with a visible warning. Negative volumes are excluded rather than subtracted from the positive mesh; reapply them in the slicer when needed. PrusaSlicer 3 blend/gradient assignments become ordinary flat region IDs, with a warning: mixing recipes and a gradient's changing colors are discarded. Projects with different bed palettes retain slot numbers and show the first palette with a warning.
- Default assignments become explicit painted triangle assignments on export. Later changing an object's default extruder will therefore not recolor those faces automatically.
- There is no compressed 3MF upload-size cap. The shared reader expands only needed entries, with default processing budgets of 1 GiB total and 512 MB per entry. The cutting/conforming algorithm retains its 1.5-million-resolved-triangle budget. Complex files can need substantial RAM. Cancelling a worker operation preserves current pieces but clears undo history.
- Disconnected islands within one half stay grouped in that object. PrusaSlicer's Split to Objects can separate them afterward if desired.

## Publish on GitHub Pages

The local repository uses branch `main`. No GitHub remote is configured and nothing is published automatically from this computer.

1. Create your GitHub repository and push this project to its `main` branch.
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. Run the **Publish GitHub Pages** workflow (or push another commit). It installs locked dependencies, runs the tests, builds, and deploys `dist`.

Vite uses relative asset URLs, so the app and worker work under a repository subpath. Docker and GitHub Pages serve the same static application.

## Validation

```powershell
npm test
npm run test:coverage
npm run test:model
npm run build
npm run format
```

The test suite covers both paint dialects, PrusaSlicer 3 JSON paint, native fixtures from all supported slicers, automatic palette recovery, profile-free export contents, every split-side arrangement, extended material indices, recursive subdivisions, exact spatial paint preservation, topology, volume conservation, oblique/repeated cuts, hollow caps, transforms, component references, malformed data, worker operations, undo, and 3MF round trips. Virtual-export tests cover conversion without cuts, partial-triangle paint and cut-face preservation, selected-piece export, custom physical filaments, independent equal-color regions, material limits, unsupported targets, and unchanged ordinary exports. Windows and Linux tests/builds run on pushes and pull requests.

Optional native integration tests use `PRUSA_SLICER`, `BAMBU_STUDIO`, `ORCA_SLICER`, and `PRUSA_SLICER3`, or the installed paths documented in the tests. Native saves check paint persistence and spatial position. Separate slicing tests verify that PrusaSlicer 2 uses the correct extrusion tool for painted slots 16, 17 and 32, and OrcaSlicer 2.4.2 for slot 16. Saving opaque paint bytes alone does not establish that a slicer interprets them correctly. Tests skip explicitly when a slicer is unavailable.

The included [complex painted square](public/examples/complex-painted-square.3mf) has only two original mesh triangles on its top face and a complex native paint pattern within them. The [cut example](public/examples/complex-painted-square-cut.3mf) demonstrates preservation after an angled cut. Both are also served under `/examples/` by Docker and GitHub Pages. See the [test report and illustrated comparison](docs/TESTING.md) for the independent checks and reproduction instructions.

Tests use generated fixtures. Validate the first export of your own miniature in PrusaSlicer's painted view and sliced preview before printing.

## Project structure

| File              | Responsibility                                        |
| ----------------- | ----------------------------------------------------- |
| `src/paint.js`    | Shared paint API compatibility export                 |
| `src/geometry.js` | Conforming edges, plane clipping, caps and validation |
| `src/three-mf.js` | App mesh adapter for 3MF import/export                |
| `src/worker.js`   | Processing, cut history and export off the UI thread  |
| `src/viewer.js`   | Three.js viewer, orbit controls and plane gizmo       |
| `src/main.js`     | User interface and workflow                           |

Three.js, fflate, earcut, and xmldom retain their respective upstream licenses. Native test models from WebRollingBrim3mf are attributed in `tests/fixtures/README.md` with their MIT license. No Texture2Paint source files are included.

## License

This project is licensed under the [MIT License](LICENSE). The third-party dependencies retain their own licenses.

## Included 3MF support

The browser code for 3MF handling is included in [src/vendor/three-mf](src/vendor/three-mf). It is part of the normal development and publishing workflow described above.

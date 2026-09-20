# 3MF Paint Split

A standalone, local-first web app for cutting already painted 3MF models into printable pieces while keeping their PrusaSlicer MMU / Bambu AMS material assignments. This is a new application, not a Texture2Paint fork.

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

1. Open or drop a painted `.3mf` file. The demo provides a quick way to try the workflow.
2. Select the piece to cut. Choose X, Y, or Z for a centered plane, or set the position, tilt, and azimuth. The offset is measured from that piece's bounding-box center, along the plane normal. Move and Rotate handles also position the plane directly in the viewer.
3. Choose the material for the new interior faces and apply the cut. Both halves remain, with no kerf or gap introduced into their geometry.
4. Select a resulting piece and cut again if needed. The last 12 cuts can be undone. Preview spacing helps inspect the halves and never changes their exported positions. Moving the plane returns to the assembled preview.
5. Export all pieces or just the selected piece. Each piece is a separate 3MF object.
6. Open/import the output in PrusaSlicer. Keep the original material slot order, choose the correct printer and filament profiles, orient the pieces, and slice. The app's minimal palette configuration is not a printer profile.

All parsing, geometry processing, and export run on your device. No file upload service, account, CDN, or network API is required. Dependencies are bundled into the static app. Color swatches edit the displayed/exported filament colors; they do not repaint surfaces or change material numbers.

## Paint preservation

The importer decodes the slicer's recursive per-triangle paint tree, including partially painted triangles. It resolves colored leaves to explicit geometry and makes neighboring edges conform before cutting. Each clipped surface triangle retains its material assignment. The new planar caps use the selected interior material, including contours with holes. The exporter writes native `slic3rpe:mmu_segmentation`, dialect-correct `paint_color`, a standard color group, object names, and the filament palette.

The app checks edge connectivity, winding, and volume conservation before accepting a cut. A failed cut leaves the original piece intact. Resolving fine paint can increase triangle counts and export size; it does not sample or approximate the paint boundaries.

See [format notes](docs/FORMAT.md) for details and upstream references.

## Supported scope and limits

- PrusaSlicer 2.x triangle painting and Bambu Studio / OrcaSlicer `paint_color`, including nested production-extension components, object transforms, mirrored instances, and standard 3MF units.
- Axis-aligned and arbitrary planar cuts, multiple sequential cuts, hollow contours, independent objects, undo, orbit/pan/zoom, view presets, wireframe, and preview separation.
- Closed meshes with consistently oriented triangles are required for cutting. Repair open/non-manifold geometry in a mesh repair tool first. Ambiguous vertex-touching or intersecting contours may require moving the plane slightly.
- Supports, seams, negative/modifier volumes, printer settings, custom G-code, textures, connectors, variable layers, and assembly metadata are not preserved. Non-printing objects are excluded with a visible warning. Material blending / virtual-extruder recipes and PrusaSlicer 3.x's new project format are outside this release's scope; save a compatible 2.x 3MF with physical material slots first.
- Default assignments become explicit painted triangle assignments on export. Later changing an object's default extruder will therefore not recolor those faces automatically.
- Limits: 200 MB compressed input, 400 MB of relevant expanded archive data, and 1.5 million resolved triangles. Complex files can need substantial RAM. Cancelling a worker operation preserves current pieces but clears undo history.
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

The 81-test suite covers both paint dialects, every split-side arrangement, extended material indices, recursive subdivisions, exact spatial paint preservation, topology, volume conservation, oblique/repeated cuts, hollow caps, transforms, component references, malformed data, worker operations, undo, and 3MF round trips. Windows and Linux tests/builds run on pushes and pull requests.

The two optional PrusaSlicer integration tests run automatically when the installed CLI is found at the usual Windows path or `PRUSA_SLICER` is set to its executable. They import the generated pieces with PrusaSlicer, verify manifold status, re-export them, and check their paint again. They are skipped on hosts without PrusaSlicer, including the GitHub Pages runner.

The included [complex painted square](public/examples/complex-painted-square.3mf) has only two original mesh triangles on its top face and a complex native paint pattern within them. The [cut example](public/examples/complex-painted-square-cut.3mf) demonstrates preservation after an angled cut. Both are also served under `/examples/` by Docker and GitHub Pages. See the [test report and illustrated comparison](docs/TESTING.md) for the independent checks and reproduction instructions.

Tests use generated fixtures. Validate the first export of your own miniature in PrusaSlicer's painted view and sliced preview before printing.

## Project structure

| File              | Responsibility                                        |
| ----------------- | ----------------------------------------------------- |
| `src/paint.js`    | Native triangle paint decoding/encoding               |
| `src/geometry.js` | Conforming edges, plane clipping, caps and validation |
| `src/three-mf.js` | 3MF archive, XML, material and component handling     |
| `src/worker.js`   | Processing, cut history and export off the UI thread  |
| `src/viewer.js`   | Three.js viewer, orbit controls and plane gizmo       |
| `src/main.js`     | User interface and workflow                           |

Three.js, fflate, earcut, and xmldom retain their respective upstream licenses. No Texture2Paint source files are included.

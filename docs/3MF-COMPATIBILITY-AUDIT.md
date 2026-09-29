# 3MF compatibility audit

Researched 2026-09-29. This is a research report; application behavior was not changed.

**The three projects do not fully agree.** Their common mesh representation is broadly compatible, but their project-preservation policies, paint encodings, PrusaSlicer 3 support, and handling of required extensions differ. No single project should be treated as the authority for every case.

Evidence is separated below into **official documentation**, **vendor implementation**, and **local experiments**. Public documentation establishes the file-format rules and intended workflows. I did not find a published vendor wire-format specification for the complete paint bitstreams or PrusaSlicer 3 JSON schema; those details require implementation evidence and tests.

## What the official documentation establishes

| Official source                                                                                                                                                                      | Relevant rule or documented behavior                                                                                                        | Implication                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [3MF Consortium Core Specification 1.3.0, §§2.1.1–2.1.4](https://github.com/3MFConsortium/spec_core/blob/1.3.0/3MF%20Core%20Specification.md#211-3d-parts-and-payload-relationships) | Model data is required; device settings through PrintTicket are optional. A consumer supplies defaults when no supported ticket exists.     | A mesh-and-color file does not need a printer definition. Slicer configuration sidecars are separate vendor conventions, not mandatory core parts.                                   |
| [Prusa: Saving projects as 3MF](https://help.prusa3d.com/article/saving-projects-as-3mf_1773?product=prusaslicer)                                                                    | Saving a project captures objects, settings, modifiers, and parameters.                                                                     | Retaining a whole native project intentionally retains much more than geometry and paint.                                                                                            |
| [OrcaSlicer: Import and Export](https://github.com/OrcaSlicer/OrcaSlicer/wiki/import_export#export-model)                                                                            | Generic model export omits printer, material, and process configuration; project saving includes settings.                                  | The model-versus-project distinction is explicitly supported by a slicer manual. This does not promise preservation of every vendor paint annotation.                                |
| [Bambu Studio: Command Line Usage](https://github.com/bambulab/BambuStudio/wiki/Command-Line-Usage#command-manual)                                                                   | `--export-3mf` exports a project. Its documented slicing workflows can use printer, filament, and print settings supplied by the input 3MF. | A native save is a project operation; it is not evidence that a minimal geometry export requires profiles.                                                                           |
| [3MF Materials Extension 1.2.1, chapter 2](https://github.com/3MFConsortium/spec_materials/blob/1.2.1/3MF%20Materials%20Extension.md#chapter-2-color-groups)                         | Color groups use ordered, zero-based property indices and sRGB colors.                                                                      | Standard color properties and a slicer's numbered filament-paint assignments are distinct representations. Standard color support alone does not promise identical MMU/AMS behavior. |
| [3MF Production Extension, §§3.1–3.3](https://github.com/3MFConsortium/spec_production/blob/master/3MF%20Production%20Extension.md#31-the-path-attribute)                            | An external component's object ID identifies a resource in its referenced model file; resources and transforms have defined scopes.         | Bambu/Orca archives containing several `.model` files are a legitimate structure. IDs must be resolved with their model path.                                                        |
| [Prusa's official 3.0 preview announcement, Compatibility](https://blog.prusa3d.com/prusaslicer-3-0-preview-built-for-the-future-of-3d-printing_137672/)                             | Prusa distinguishes its legacy/native project import from third-party 3MF geometry import.                                                  | Prusa 3 cannot be assumed to retain third-party paint just because it opens the mesh.                                                                                                |

“Slicer-compatible” also does not mean fully conformant to the Consortium's schema. For example, the unprefixed `paint_color` attribute is a Bambu/Orca convention; the [Core extension rules, §2.3.1](https://github.com/3MFConsortium/spec_core/blob/1.3.0/3MF%20Core%20Specification.md#231-support-for-versioning-and-extensibility) call for extension attributes in other namespaces. All three projects target vendor behavior in addition to standard 3MF features. This audit is not full schema certification.

## Project comparison

| Area                       | 3mfPaintSplit                                                                      | WebRollingBrim3mf                                                                | Texture2Paint                                                           |
| -------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 3MF reading                | Reads meshes, roles, names, palette and paint, then reconstructs editable geometry | Reads native projects and retains the source archive for controlled modification | No 3MF reader; its README explicitly lists 3MF as export only           |
| Normal export              | Fresh mesh-and-paint archive; no printer/profile configuration                     | Preserves the native project and adds brim parts and their settings              | Fresh mesh-and-paint archive; no printer/profile configuration          |
| PrusaSlicer 2              | Separate Prusa paint encoder                                                       | Native paint preserved unchanged; cross-slicer conversion has a higher-slot bug  | Writes Bambu encoding into the Prusa attribute as well; higher-slot bug |
| Bambu Studio               | Separate Bambu paint encoder                                                       | Native paint preserved unchanged                                                 | Bambu-compatible continuation encoding                                  |
| OrcaSlicer                 | Shares the Bambu paint path; higher-slot support is overclaimed                    | Preserves native data; cross-slicer higher-slot compatibility needs restrictions | Shares the Bambu paint path; higher-slot support is overclaimed         |
| PrusaSlicer 3              | Experimental native JSON import/export                                             | Experimental native project handling, pinned to alpha12                          | No native Prusa 3 writer                                                |
| Unknown required extension | Currently accepted: a defect                                                       | Rejected in the tested import path                                               | Not applicable to reading                                               |

These observations refer to local source snapshots: PaintSplit `872c8857`, RollingBrim `7dbb5453`, and Texture2Paint `66a27be3`. Sibling projects were read only. Existing unrelated local changes were left alone.

## Finding 1: Texture2Paint's universal paint-encoding assumption is wrong

**Vendor implementation evidence:** the [PrusaSlicer 2.9.6 decoder](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/TriangleSelector.cpp#L1648) and [Bambu Studio 2.8.2.61 serializer](https://github.com/bambulab/BambuStudio/blob/v02.08.02.61/src/libslic3r/TriangleSelector.cpp#L1870) diverge for higher states. For a whole triangle, with one-based material slots:

| Slot | PrusaSlicer 2.9.6 | Bambu Studio 2.8.2.61 |
| ---- | ----------------- | --------------------- |
| 1    | `4`               | `4`                   |
| 16   | `DC`              | `DC`                  |
| 17   | `00EC`            | `EC`                  |
| 18   | `01EC`            | `0FC`                 |
| 32   | `0FEC`            | `EFC`                 |

Texture2Paint's pre-fix [getPrusaMmuHex() and triangle writer](https://github.com/EllsworOpan/Texture2Paint/blob/66a27be/src/processor.js) implement the Bambu column and write the result into both attributes. PaintSplit's [paint encoder](../src/paint.js) correctly produces separate strings for Prusa and Bambu.

**Local experiment:** called Texture2Paint's actual exporter on closed cubes painted entirely with slots 1, 16, 17, 18 and 32. Prusa 2.9.6 saved all five successfully, but retained the incompatible higher-slot strings verbatim. It did not repair them. Corresponding PaintSplit exports contained the expected Prusa strings and retained them. Bambu preserved slot 32 with its expected `EFC` encoding.

The encoding defect is established by the vendor decoder, not by trusting PaintSplit's decoder as an independent oracle. These save tests do not establish the precise GUI symptom or successful slicing of every higher-slot case.

**Verdict:** use dialect-specific serialization. Texture2Paint is correct for the tested Bambu encoding, not for current Prusa higher-slot paint. The shared encoding works through slot 16.

## Finding 2: RollingBrim's cross-slicer conversion has the same higher-slot risk

RollingBrim's native preservation is appropriate when triangle order and corners remain unchanged. Its pre-fix cross-slicer converter, however, copies paint strings to the target attribute rather than translating them. Its [version guard](https://github.com/EllsworOpan/WebRollingBrim3mf/blob/7dbb545/src/core/convert-3mf.ts) rejects some newer Prusa version markers, but that does not detect Bambu's extended encoding.

**Local experiment:** imported a Bambu-format cube and exercised RollingBrim's actual clean converter to Prusa. Source strings `EC`, `0FC`, and `EFC` were accepted and copied unchanged. Those are not the expected current Prusa encodings for slots 17, 18 and 32.

**Verdict:** same-slicer preservation and cross-slicer translation are different jobs. Cross-conversion must decode/re-encode, or reject unsupported states. Checking only a paint-version number is insufficient.

## Finding 3: Orca must not be treated as Bambu for every paint slot

**Vendor implementation evidence:** Orca 2.4.2's [paint-state enum](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/libslic3r/TriangleSelector.hpp#L9) stops at `Extruder16`. Its [serializer and decoder](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/libslic3r/TriangleSelector.cpp#L1589) do not implement Bambu's continuation loop.

**Local experiment:** the installed Orca binary successfully saved a file containing `EFC` unchanged. That proves preservation of bytes, not correct interpretation of slot 32. PaintSplit's existing extended-slot native-save tests therefore prove less than their wording suggests: rereading those bytes with PaintSplit's Bambu decoder cannot establish Orca's own interpretation.

**Verdict:** treat slots 1–16 as the supported shared paint range for this Orca release. Higher-slot support requires a version-specific implementation check and a test that forces the slicer to interpret paint. Do not infer a universal limit on all Orca objects or filament lists from this paint-state limit.

## Finding 4: PrusaSlicer 3 needs its own tested format path

The official compatibility announcement above is useful workflow documentation, but does not publish the JSON schema. Prusa also has an [official import matrix](https://github.com/prusa3d/PrusaSlicer/blob/30ef59195e0f3ee6f270b185bb5f9fb5f349f81f/doc/3mf-import-matrix.md) distinguishing Open Project from Import. That snapshot still contains an outdated legacy-project warning compared with the preview announcement; it should not be treated as a complete current wire-format specification.

**Local experiment, alpha12:** loaded and saved the same slot-16 cube in three forms:

| Input                               | Native output                                           |
| ----------------------------------- | ------------------------------------------------------- |
| Texture2Paint model-only XML        | Mesh retained; no MMU paint annotation; fallback slot 1 |
| PaintSplit universal model-only XML | Mesh retained; no MMU paint annotation; fallback slot 1 |
| PaintSplit native Prusa 3 output    | Slot 16 retained as `DC` in the native annotation JSON  |

PaintSplit's native output uses object/volume identities and facet annotations, with empty object/volume settings and `config_containers: []`. RollingBrim also implements the native hierarchy and JSON, but preserves more native project information. Texture2Paint does not implement this path.

**Verdict:** the separate experimental Prusa 3 export is justified. Native project support should remain version-tested, not described as guaranteed for all future Prusa releases.

## Finding 5: PaintSplit needs a required-extension guard

**Official rule:** [Core 1.3.0 §3.4](https://github.com/3MFConsortium/spec_core/blob/1.3.0/3MF%20Core%20Specification.md#34-model) forbids editors from processing documents requiring an extension they do not support.

**Local experiment:** added an unknown namespace and `requiredextensions="audit"` to an otherwise ordinary cube. PaintSplit accepted it; RollingBrim rejected it. PaintSplit's [pre-fix model reader](https://github.com/EllsworOpan/3mfPaintSplit/blob/872c885/src/three-mf.js) does not check this declaration.

**Verdict:** RollingBrim has the correct refusal behavior in this case. Always importing safely means respecting required semantics, not discarding an extension that might change the model's meaning.

## Why RollingBrim's “clean” output is not this app's export contract

At the time of the original audit, RollingBrim clean export retained extra configuration: Orca purge-volume defaults and Prusa 3 hardware/material routing and placeholder presets. This was an implementation choice for preserving configured palettes and recipes, not a requirement for transporting mesh paint. The clean-contract follow-up below removes it. Normal export still intentionally preserves the source project; brim writers add the app's own settings in either mode.

PaintSplit and Texture2Paint instead reconstruct model-and-paint archives. For the requested behavior here, excluding printer and process configuration is the appropriate policy. Standard palette colors and object labels are still model information. The user supplies the printer and matching filament slots in the receiving slicer. Retaining numerical paint assignments does not guarantee every slicer automatically adopts the same displayed palette.

## Recommended follow-up

1. Add PaintSplit's missing required-extension validation.
2. Correct Texture2Paint's Prusa encoding and add an explicit Prusa 3 target if that compatibility is desired.
3. Translate or reject extended paint during RollingBrim cross-slicer conversion.
4. Make Orca compatibility version-aware, and strengthen paint tests beyond import/save/reimport.
5. Keep printer/profile preservation separate from the mesh-and-paint export contract.

## Reproduction and limits

### Implemented follow-up (September 29, 2026)

The findings above describe the pre-fix audit. PaintSplit now rejects unsupported required extensions and offers an explicit Orca target limited to painted slots 1–16. Texture2Paint now writes separate Prusa/Bambu encodings and offers Orca and experimental Prusa 3 targets. RollingBrim translates paint trees during cross-slicer conversion, supports Prusa paint versions 1 and 2, and refuses paint outside Orca 2.4.2's range. Its normal native project preservation remains intentional. PaintSplit and Texture2Paint exports remain free of printer and process profiles.

Regression tests now force PrusaSlicer 2.9.6 to slice PaintSplit and Texture2Paint exports at slots 16, 17 and 32, plus RollingBrim Bambu-to-Prusa conversions at slots 17 and 32. They verify the tool used on actual extrusion moves. An Orca 2.4.2 slicing test verifies slot 16. Texture2Paint's new Prusa 3 JSON output is separately checked by an alpha12 native save at slot 32; that save establishes annotation persistence, not full slicing coverage of Prusa 3.

### Clean-contract follow-up (September 29, 2026)

All three projects now use a clean model baseline: geometry and numbered color regions, followed by the app's intentional changes. RollingBrim clean exports omit Prusa 2 and Bambu/Orca global configuration sidecars and leave Prusa 3 `config_containers` empty. They retain region/default assignments, brim part settings and the app's zero elephant-foot compensation overrides. Printer hardware, placeholder presets, original palettes and mixing recipes are not needed for this contract. Normal RollingBrim export continues to preserve source projects.

PaintSplit imports Prusa 3 blend/gradient IDs as flat regions with an explicit warning. RollingBrim clean export does the same, including cross-slicer conversion. Palette differences no longer block conversion. Recipe behavior is intentionally discarded; gradients do not become sampled color bands. Texture2Paint already constructs profile-free model archives; new regressions check every target and confirm that equal display swatches do not merge distinct region IDs. Standard display colors in PaintSplit/Texture2Paint remain optional model data, without hardware or material presets.

A direct alpha12 probe first removed all configuration containers from a native RollingBrim clean export; native save retained all four printable objects, ordered painted corners, part roles, the brim and its settings. Updated native integration tests then verified profile-free clean exports in Prusa 2, Prusa 3, Bambu and Orca. These are model/paint persistence checks, separate from the G-code interpretation tests described above.

Final clean-contract validation: PaintSplit **118 passed**, Texture2Paint **80 passed**, RollingBrim **439 passed** with its one opt-in private-model check skipped. PaintSplit and RollingBrim production builds passed. PaintSplit also preserves distinct standard 3MF property IDs when their RGB values match, rather than merging them by display color.

### Original audit probe files

The original exploratory probes and CLI logs were local scratch files under `.tmp/format-audit`, which is not committed. Maintained reproduction coverage is in [PaintSplit's format tests](../tests/slicer-formats.test.js), [its native slicing tests](../tests/paint-slicing.test.js), [Texture2Paint's native paint tests](https://github.com/EllsworOpan/Texture2Paint/blob/main/tests/slicer-paint.test.mjs), and [RollingBrim's conversion tests](https://github.com/EllsworOpan/WebRollingBrim3mf/blob/main/tests/convert-export.test.ts). These exercise the actual exporters and converter.

Native probes used PrusaSlicer 2.9.6, Bambu Studio 2.8.2.61, the locally installed Orca 2.4.2 build, and PrusaSlicer 3.0.0-alpha12. Tests performed 18 Prusa/Bambu/Orca saves, three Prusa 3 saves, four RollingBrim conversions, and two required-extension imports. They did not print models, exhaustively test all 3MF extensions, or verify every GUI import route. A successful native save is specifically not used as proof that all higher-slot paint is usable by the slicer.

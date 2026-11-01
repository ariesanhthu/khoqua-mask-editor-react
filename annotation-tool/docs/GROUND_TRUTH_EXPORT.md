# Fetch ground truth from the database

## Approved consistent export (2026-10-04)

The user selected `native-canvas-separated.png` for `8582_01`: white native Canvas evenodd fills, followed by all original closed outlines drawn black at **2 image pixels**, then thresholded at 128. Do not substitute the older fill-only union when producing this approved variant.

`artifacts/ground-truth-consistent-2026-10-04/` is the matching full dataset. Its final native Canvas binary mask is assigned numeric instance IDs using highest native polygon coverage, with later polygons winning ties. This is the **only** authoritative raster. `mask.png`, `instance-ids.png`, `polygons/*.png`, the final per-image/per-instance JSON, and `coco.json` are all derived from it. `instance-preview.png` is a color lookup from the same IDs; `overlay.png` is a pixel composition, not another vector render.

The finalizer verifies through the public `pycocotools.COCO.annToMask` API that:

- Every COCO instance equals its PNG, area and bbox.
- Decoded COCO IDs equal the uint16 ID PNG.
- The union of decoded COCO instances equals the visible `mask.png` exactly.
- Local JSON and the color preview match those same decoded pixels.
- `8582_01/mask.png` equals the exact approved sample, with **zero** pixel differences.

Use the new folder's **`coco.json`** and original RGB image paths to train. Do not combine it with earlier exports. Original vector/source JSON is retained explicitly under `source/`; the paired training JSON is the final RLE JSON. Separator pixels are background. A source polygon with no visible pixel after the approved separator/occlusion is recorded explicitly, not fabricated as a nonempty COCO instance.

Reproduction uses the local-only native renderer and finalizer:

```powershell
node scripts/serve-consistent-ground-truth.mjs
# Open http://127.0.0.1:4319 and click the render button; wait for 11/11.
node --env-file=.env.local scripts/audit-database-ground-truth.mjs artifacts/ground-truth-audited-2026-10-04 artifacts/ground-truth-consistent-2026-10-04/database-source-check.json
python scripts/finalize-consistent-ground-truth.py artifacts/ground-truth-consistent-2026-10-04
```

The renderer requires a fresh destination. Existing exports are not overwritten. The older commands below produce the original fill-only variant and do not implement the newly approved separator rule.

Run in `annotation-tool` (a fresh output directory is required):

```powershell
npm run labels:fetch -- artifacts/ground-truth-2026-10-03
python scripts/validate-ground-truth.py artifacts/ground-truth-2026-10-03
```

The fetch reads the **current annotations table** in a repeatable-read, read-only transaction, including saved drafts. It does not select the highest historical version in place of the active annotation. Source dimensions, revision, status, original JSON, original image bytes and saved raster remain available for review. No database records are changed.

Use `coco-compressed.json` for COCO tooling, with the output directory as the image root. Each annotation uses independent binary RLE, with `iscrowd=0`, pixel area and pixel bbox. Original polygon geometry (including holes, IDs, labels and metadata) is retained in `annotation.json` and `polygons/*.json`. Category 3 explicitly holds unclassified labels; no automatic relabeling occurs.

`polygons/*.png` are independent 0/255 training masks at original image resolution. Rasterization uses the editor's evenodd geometry at pixel centers, without antialiasing, smoothing, scaling, or strokes. RLE encodes those same pixels rather than asking a second polygon rasterizer to reinterpret fractional coordinates. This avoids discrepancies between COCO polygon rasterization and the editor's fill, and preserves holes and overlaps.

`binary-union.png` is the union of polygon masks. It cannot show internal boundaries where instances touch or overlap. Older exports named it `mask.png`, which obscured its role. Never cut artificial black lines into training masks to make instance boundaries visible. `polygons/instance-mask.png` packs IDs as `R+256*G+65536*B` and appears almost black for small IDs. `polygons/instance-ids-uint16.png` stores actual one-channel numeric IDs without 8-bit truncation. Both use last-polygon-wins at overlaps and are not lossless substitutes for independent masks or COCO annotations. Use `polygons/instance-colors.png` for a fill-only preview; colors are display-only.

Use `overlay.png`, `preview.png` and `polygons/vector-boundaries.svg` to inspect all original closed outlines. `vector-boundaries.png` rasterizes those outlines independently, including holes and overlapped shapes. These files are display assets, not training masks.

`saved-raster.png` retains a stored raster only when the segmentation really has `maskStorageKey`. Otherwise `initial-prediction.png` contains the model/init prediction; it must never be described as a saved/current annotation mask. The 2026-10-03 script incorrectly named that fallback `saved-mask.png`. `audit/audit.json` now identifies `comparisonSource` and `comparisonFile` explicitly. A difference from a prediction does not justify changing polygon coordinates or replacing current vectors with prediction geometry.

The validator uses the official `pycocotools.COCO.annToMask` decoder for every instance, compares every pixel against each PNG, checks area/bbox, original polygon JSON, union and packed IDs, and validates the serialized compressed RLE again. It reports empty instances separately. Install `numpy`, `Pillow`, and `pycocotools` if missing.

COCO/PNG equality alone does **not** certify correct source geometry. Also run the independent audit (requires Shapely):

```powershell
python scripts/audit-polygon-ground-truth.py artifacts/ground-truth-2026-10-03 artifacts/ground-truth-audit-2026-10-04
node --env-file=.env.local scripts/audit-database-ground-truth.mjs artifacts/ground-truth-2026-10-03 artifacts/ground-truth-audit-2026-10-04/database-audit.json
```

This separately classifies every pixel center using ray parity, with no shared TS scanline rasterizer, reports Shapely topology validity, duplicate IDs/labels and overlap/occlusion, and checks original JSON bytes against the live database. It never repairs geometry implicitly.

Audit of 2026-10-03 data: all 1,645 independent polygon PNGs and all 11 binary unions match independent evenodd coverage with zero differing pixels; database JSON bytes match exactly. `DC3_01` has three self-intersecting source rings (`r1`, `w29`, `w66`) requiring geometry review. `8769_01/w159` covers one pixel and is fully overwritten in a flattened ID mask, but remains intact in independent PNG and COCO. RLE is renderable even when source vector topology is invalid; do not certify all vector rings valid from RLE tests alone.

The web ZIP export now also includes `coco.json` plus per-image COCO files, independent PNGs and complete vector boundary exports. It still retains original saved raster bytes under `masks/`. If a brush/reset follows a polygon set, the set is stale and is not silently used as current instance ground truth.

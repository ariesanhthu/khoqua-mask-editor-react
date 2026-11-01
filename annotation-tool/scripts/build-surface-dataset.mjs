// Builds a source dataset (manifest + images + predictions + prelabels) from a surface pipeline run
// exported as COCO 1.0 (one folder per cultivar: images/, masks/, annotations/instances_default.json).
// Local only: reads the run folder, writes a new output folder, never touches the server.
//
//   node --experimental-strip-types --loader ./scripts/resolve-typescript.mjs scripts/build-surface-dataset.mjs \
//     <run>/artifacts/surface artifacts/<output> [--tolerance auto|<px>] [--skip-suffix _01] [--crop pipeline|none] [--jpegtran <exe>]
//
// `--crop pipeline` (default) cuts the black background off without scaling: the box is the notebook's own
// crop_bbox_xyxy (every mask pixel lies inside it with a 32 px margin), its top-left snapped down to the 16 px
// JPEG block grid so jpegtran cuts losslessly (decoded pixels identical except chroma upsampling on the outer
// 2 px). Polygons and the prediction move by the same whole-pixel offset, stored as `crop` in the manifest.
//
// Every COCO annotation (one 4-connected flesh region) becomes one instance `w<n>` in file order.
// Rings are compacted (half-pixel contour + Douglas–Peucker, `compactPolygon`) so the editor gets few
// vertices; the prediction PNG is rasterized from those polygons, so prelabel and mask agree pixel for pixel.
// `auto` tolerance = ¾ of one pixel of the image the notebook really processed (metadata crop_bbox_xyxy
// vs processed_hw; masks were upscaled with INTER_NEAREST, so finer stair steps carry no information),
// at least 1 px.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { buildPrelabelDocument, decodeCocoRle } from '../src/lib/coco-import.ts';
import { compactPolygon, forEachPolygonSpan, rasterizePolygons, vectorizeBinaryMask } from '../src/lib/mask-pixels.ts';

const [runArg, outArg, ...rest] = process.argv.slice(2);
if (!runArg || !outArg) throw Error('Usage: build-surface-dataset.mjs <run surface dir> <output dir> [--tolerance auto|<px>] [--skip-suffix _01] [--crop pipeline|none] [--jpegtran <exe>]');
const option = (name, fallback) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
const toleranceOption = option('--tolerance', 'auto');
const skipSuffix = option('--skip-suffix', '_01');
const cropMode = option('--crop', 'pipeline');
const jpegtran = option('--jpegtran', 'jpegtran');
if (!['pipeline', 'none'].includes(cropMode)) throw Error('--crop must be pipeline or none');
if (toleranceOption !== 'auto' && !(Number(toleranceOption) > 0 && Number(toleranceOption) <= 3)) throw Error('Tolerance must be auto or in (0, 3] px');
const runDir = path.resolve(runArg);
const outDir = path.resolve(outArg);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const vertices = (polygons) => polygons.reduce((sum, p) => sum + p.nodes.length + (p.holes ?? []).reduce((s, r) => s + r.length, 0), 0);

await mkdir(outDir, { recursive: false });
for (const folder of ['images', 'predictions', 'prelabels']) await mkdir(path.join(outDir, folder));

const items = [];
const skipped = [];
const cultivars = (await readdir(runDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
for (const cultivar of cultivars) {
  const coco = JSON.parse(await readFile(path.join(runDir, cultivar, 'annotations', 'instances_default.json'), 'utf8'));
  if (coco.info?.version !== '1.0' || !Array.isArray(coco.images) || !Array.isArray(coco.annotations)) throw Error(`${cultivar}: not COCO 1.0`);
  if (coco.categories.length !== 1 || coco.categories[0].name !== 'flesh') throw Error(`${cultivar}: expected the single category "flesh"`);
  for (const image of coco.images) {
    const fileName = path.posix.basename(image.file_name);
    const id = fileName.replace(/\.[^.]+$/, '');
    if (!/^[A-Za-z0-9]+_\d+$/.test(id) || !id.startsWith(`${cultivar}_`)) throw Error(`Unexpected image name ${image.file_name}`);
    if (skipSuffix && id.endsWith(skipSuffix)) { skipped.push(id); continue; }
    const { width, height } = image;
    const imageBytes = await readFile(path.join(runDir, cultivar, ...image.file_name.split('/')));
    const meta = await sharp(imageBytes).metadata();
    if (meta.format !== 'jpeg' || meta.width !== width || meta.height !== height || (meta.orientation ?? 1) !== 1) throw Error(`${id}: image must be an unrotated ${width}x${height} JPEG`);
    const { geometry } = JSON.parse(await readFile(path.join(runDir, cultivar, 'metadata', `${fileName}.json`), 'utf8'));
    const [x1, y1, x2, y2] = geometry.crop_bbox_xyxy; const [processedHeight, processedWidth] = geometry.processed_hw;
    const sourcePixel = Math.max((x2 - x1) / processedWidth, (y2 - y1) / processedHeight);
    if (!(sourcePixel > 0.5 && sourcePixel < 5)) throw Error(`${id}: unexpected processing scale ${sourcePixel}`);
    // Output frame: the whole image, or the pipeline crop with its top-left on the JPEG block grid.
    const originX = cropMode === 'pipeline' ? x1 - (x1 % 16) : 0; const originY = cropMode === 'pipeline' ? y1 - (y1 % 16) : 0;
    const outWidth = cropMode === 'pipeline' ? x2 - originX : width; const outHeight = cropMode === 'pipeline' ? y2 - originY : height;
    if (x2 > width || y2 > height || outWidth < 1 || outHeight < 1) throw Error(`${id}: crop box outside the image`);
    const tolerance = toleranceOption === 'auto' ? Math.round(Math.max(1, 0.75 * sourcePixel) * 100) / 100 : Number(toleranceOption);

    // Ground truth for the QA numbers: the run's own union mask (255 = flesh).
    const { data: runMask, info } = await sharp(await readFile(path.join(runDir, cultivar, 'masks', `${fileName}.png`)))
      .greyscale().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height || info.channels !== 1) throw Error(`${id}: mask size mismatch`);

    const annotations = coco.annotations.filter((annotation) => annotation.image_id === image.id);
    const union = new Uint8Array(width * height);
    const polygons = [];
    let exactVertices = 0;
    annotations.forEach((annotation, index) => {
      const pixels = decodeCocoRle(annotation.segmentation, width, height);
      const [bx, by, bw, bh] = annotation.bbox;
      const left = Math.floor(bx); const top = Math.floor(by);
      const right = Math.min(width, Math.ceil(bx + bw)); const bottom = Math.min(height, Math.ceil(by + bh));
      const cropWidth = right - left; const cropHeight = bottom - top;
      const crop = new Uint8Array(cropWidth * cropHeight);
      let area = 0;
      for (let y = 0; y < cropHeight; y += 1) for (let x = 0; x < cropWidth; x += 1) {
        const source = (y + top) * width + x + left;
        if (!pixels[source]) continue;
        if (union[source]) throw Error(`${id}: annotations overlap`);
        crop[y * cropWidth + x] = 255; union[source] = 255; area += 1;
      }
      if (area !== annotation.area) throw Error(`${id}: annotation ${annotation.id} has pixels outside its bbox`);
      const label = `w${index + 1}`;
      const parts = vectorizeBinaryMask(crop, cropWidth, cropHeight);
      parts.forEach((part, k) => {
        const polygonId = k === 0 ? `${id}-${label}` : `${id}-${label}-${k}`;
        // Same node id scheme as compactPolygon, in case it keeps the exact rings.
        const shift = (ring, suffix) => ring.map((p, i) => ({ x: p.x + left - originX, y: p.y + top - originY, id: `${polygonId}-${suffix}-${i}` }));
        exactVertices += vertices([part]);
        const exact = { id: polygonId, label, nodes: shift(part.nodes, 'outer'), holes: (part.holes ?? []).map((ring, h) => shift(ring, `hole${h}`)) };
        polygons.push(compactPolygon(exact, tolerance));
      });
    });
    if (!union.every((value, i) => Boolean(value) === Boolean(runMask[i]))) throw Error(`${id}: COCO annotations differ from the run mask`);
    // The crop may only remove background: every flesh pixel stays inside the output frame.
    const target = new Uint8Array(outWidth * outHeight);
    let kept = 0; let flesh = 0;
    for (let i = 0; i < union.length; i += 1) {
      if (!union[i]) continue;
      flesh += 1;
      const x = (i % width) - originX; const y = Math.floor(i / width) - originY;
      if (x >= 0 && y >= 0 && x < outWidth && y < outHeight) { target[y * outWidth + x] = 255; kept += 1; }
    }
    if (kept !== flesh) throw Error(`${id}: ${flesh - kept} flesh pixels outside the crop`);

    // QA: union IoU against the run mask, and no pixel claimed by two instances.
    const owners = new Uint8Array(outWidth * outHeight);
    let overlap = 0;
    for (const polygon of polygons) {
      forEachPolygonSpan([polygon], { left: 0, top: 0, right: outWidth, bottom: outHeight }, (y, start, end) => {
        for (let i = y * outWidth + start; i < y * outWidth + end; i += 1) { owners[i] += 1; if (owners[i] === 2) overlap += 1; }
      });
    }
    if (overlap) throw Error(`${id}: ${overlap} pixels belong to two instances`);
    const raster = rasterizePolygons(polygons, outWidth, outHeight);
    let both = 0; let either = 0;
    for (let i = 0; i < raster.length; i += 1) { if (raster[i] && target[i]) both += 1; if (raster[i] || target[i]) either += 1; }

    const outputBytes = cropMode === 'pipeline' ? await cropJpeg(imageBytes, originX, originY, outWidth, outHeight, id) : imageBytes;
    const prelabelBytes = Buffer.from(JSON.stringify(buildPrelabelDocument(id, outWidth, outHeight, polygons)));
    const predictionBytes = await sharp(Buffer.from(raster), { raw: { width: outWidth, height: outHeight, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer();
    const item = {
      id, image: `images/${id}.jpg`, prediction: `predictions/${id}.png`, prelabel: `prelabels/${id}.json`, width: outWidth, height: outHeight, group: cultivar,
      source: `${cultivar}/${image.file_name}`, sourceSize: [width, height], crop: { left: originX, top: originY },
      sourceImageSha256: hash(imageBytes), imageSha256: hash(outputBytes), maskSha256: hash(predictionBytes), prelabelSha256: hash(prelabelBytes),
      instances: annotations.length, polygons: polygons.length, vertices: vertices(polygons), exactVertices, iou: Number((both / either).toFixed(6)),
      sourcePixel: Number(sourcePixel.toFixed(3)), tolerance,
    };
    await writeFile(path.join(outDir, item.image), outputBytes, { flag: 'wx' });
    await writeFile(path.join(outDir, item.prediction), predictionBytes, { flag: 'wx' });
    await writeFile(path.join(outDir, item.prelabel), prelabelBytes, { flag: 'wx' });
    items.push(item);
    console.log(`${id}: ${outWidth}x${outHeight} at +${originX}+${originY}, ${item.instances} instances, ${item.exactVertices} → ${item.vertices} vertices (tolerance ${tolerance}px), IoU ${item.iou}`);
  }
}

/** Lossless JPEG crop (jpegtran, block-aligned origin), verified against the decoded source. */
async function cropJpeg(bytes, left, top, cropWidth, cropHeight, id) {
  const dir = await mkdtemp(path.join(tmpdir(), 'surface-crop-'));
  try {
    const input = path.join(dir, 'in.jpg'); const output = path.join(dir, 'out.jpg');
    await writeFile(input, bytes);
    execFileSync(jpegtran, ['-copy', 'all', '-perfect', '-crop', `${cropWidth}x${cropHeight}+${left}+${top}`, input, output]);
    const result = await readFile(output);
    const meta = await sharp(result).metadata();
    if (meta.width !== cropWidth || meta.height !== cropHeight || (meta.orientation ?? 1) !== 1) throw Error(`${id}: jpegtran produced ${meta.width}x${meta.height}`);
    const cut = await sharp(result).raw().toBuffer();
    const original = await sharp(bytes).extract({ left, top, width: cropWidth, height: cropHeight }).raw().toBuffer();
    for (let y = 2; y < cropHeight - 2; y += 1) for (let x = 2; x < cropWidth - 2; x += 1) for (let c = 0; c < 3; c += 1) {
      const i = (y * cropWidth + x) * 3 + c;
      if (cut[i] !== original[i]) throw Error(`${id}: crop changed pixel ${x},${y}`);
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const runManifest = JSON.parse(await readFile(path.join(runDir, '..', 'manifest.json'), 'utf8'));
const manifest = {
  dataset_version: cropMode === 'pipeline' ? `${runManifest.run_id}-crop` : runManifest.run_id,
  algorithm_version: `surface-coco-1.0-compact-${toleranceOption === 'auto' ? 'auto' : `${toleranceOption}px`}${cropMode === 'pipeline' ? '-crop' : ''}`,
  source_run: { run_id: runManifest.run_id, status: runManifest.status, started_at: runManifest.started_at, config_sha256: runManifest.config_sha256 },
  skipped,
  items,
};
if (runManifest.status !== 'success') throw Error('Run did not succeed');
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
const total = (key) => items.reduce((sum, item) => sum + item[key], 0);
console.log(JSON.stringify({ items: items.length, skipped: skipped.length, instances: total('instances'), exactVertices: total('exactVertices'),
  vertices: total('vertices'), minIoU: Math.min(...items.map((item) => item.iou)), outDir }));

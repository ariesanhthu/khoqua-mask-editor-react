import postgres from 'postgres';
import { get } from '@vercel/blob';
import sharp from 'sharp';
import JSZip from 'jszip';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { addPolygonFiles, addPixelAudit } from '../src/lib/polygon-export.ts';
import { rasterizePolygons } from '../src/lib/mask-pixels.ts';
import { cocoCategories } from '../src/lib/coco-export.ts';

const root = path.resolve(process.argv[2] || `artifacts/ground-truth-${new Date().toISOString().slice(0, 10)}`);
const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL, { max: 1, prepare: false, connect_timeout: 20 });
const report = { exportedAt: new Date().toISOString(), source: 'current annotations table (includes saved drafts)', complete: false, items: [], errors: [] };
const coco = { info: { description: 'Independent instances from saved polygons; original pixel coordinates, evenodd fill, no strokes in training masks' }, images: [], annotations: [], categories: cocoCategories };
async function asset(ref) {
  if (!ref) throw Error('Missing asset reference');
  if (ref.startsWith('blob:')) ref = ref.slice(5);
  if (path.isAbsolute(ref)) return readFile(ref);
  if (ref.startsWith('https://')) {
    const response = await fetch(ref);
    if (!response.ok) throw Error(`Asset HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  const response = await get(ref, { access: 'private', useCache: false });
  if (response?.statusCode !== 200 || !response.stream) throw Error('Private asset unavailable');
  return Buffer.from(await new Response(response.stream).arrayBuffer());
}
await mkdir(root, { recursive: false });
try {
  const rows = await sql.begin('isolation level repeatable read read only', tx => tx`
    SELECT p.name AS project_name, df.id AS file_id, df.external_key, df.image_drive_file_id,
      df.prediction_drive_file_id, df.width, df.height, df.latest_version_number,
      a.segmentation_json, a.breakpoints_json, a.status, a.revision, a.updated_at
    FROM annotations a JOIN dataset_files df ON df.id = a.dataset_file_id
    JOIN datasets d ON d.id = df.dataset_id JOIN projects p ON p.id = d.project_id
    WHERE a.status <> 'UNSTARTED' ORDER BY p.id, df.external_key`);
  const names = new Set();
  for (const row of rows) {
    try {
      const name = row.external_key.replace(/[^a-zA-Z0-9._-]/g, '_');
      if (names.has(name)) throw Error(`Duplicate image key: ${name}`);
      names.add(name);
      const folder = path.join(root, name);
      await mkdir(folder);
      const segmentation = typeof row.segmentation_json === 'string' ? JSON.parse(row.segmentation_json) : row.segmentation_json;
      const operations = segmentation.maskOperations ?? [];
      const current = operations.at(-1);
      const width = Number(row.width), height = Number(row.height);
      const image = await asset(row.image_drive_file_id);
      const meta = await sharp(image).metadata();
      if (meta.width !== width || meta.height !== height) throw Error('Image differs from annotation coordinate dimensions');
      const extension = meta.format === 'jpeg' ? 'jpg' : meta.format;
      const record = { imageId: name, project: row.project_name, status: row.status, revision: row.revision, version: row.latest_version_number,
        updatedAt: row.updated_at, polygonCount: current?.type === 'POLYGON_SET' ? current.polygons.length : 0, files: {} };
      const save = async (filename, bytes) => {
        await mkdir(path.dirname(path.join(folder, filename)), { recursive: true });
        await writeFile(path.join(folder, filename), bytes, { flag: 'wx' });
        record.files[filename] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      };
      await save(`image.${extension}`, image);
      await save('segmentation.json', Buffer.from(typeof row.segmentation_json === 'string' ? row.segmentation_json : JSON.stringify(segmentation)));
      await save('breakpoints.json', Buffer.from(typeof row.breakpoints_json === 'string' ? row.breakpoints_json : JSON.stringify(row.breakpoints_json)));
      const reference = await asset(segmentation.maskStorageKey || row.prediction_drive_file_id);
      const referenceSource = segmentation.maskStorageKey ? 'stored_raster' : 'initial_prediction';
      const referenceFilename = segmentation.maskStorageKey ? 'saved-raster.png' : 'initial-prediction.png';
      record.referenceSource = referenceSource;
      record.referenceFile = referenceFilename;
      const maskMeta = await sharp(reference).metadata();
      if (maskMeta.width !== width || maskMeta.height !== height) throw Error('Stored mask differs from annotation dimensions');
      await save(referenceFilename, reference);
      const annotation = { imageId: name, datasetFileId: row.file_id, width, height, coordinateSpace: 'image_pixels',
        revision: row.revision, versionNumber: row.latest_version_number, status: row.status, updatedAt: row.updated_at,
        image: `image.${extension}`, segmentation, maskOperations: operations };
      await save('annotation.json', Buffer.from(JSON.stringify(annotation, null, 2)));
      if (current?.type !== 'POLYGON_SET') throw Error('No current saved polygon set; cannot produce instance ground truth without inventing geometry');
      const zip = new JSZip();
      await addPolygonFiles(zip, 'polygons', operations, width, height, `../image.${extension}`);
      await addPixelAudit(zip, 'audit', operations, width, height, reference);
      const audit = JSON.parse(await zip.file('audit/audit.json').async('string'));
      zip.file('audit/audit.json', JSON.stringify({ ...audit, comparisonSource: referenceSource, comparisonFile: referenceFilename }));
      for (const entry of Object.values(zip.files)) if (!entry.dir) await save(entry.name, await entry.async('nodebuffer'));
      const union = rasterizePolygons(current.polygons, width, height);
      await save('binary-union.png', await sharp(union, { raw: { width, height, channels: 1 } }).png().toBuffer());
      // Preview outlines are display-only and do not punch artificial gaps in ground truth.
      const boundaries = await readFile(path.join(folder, 'polygons/vector-boundaries.png'));
      const preview = await sharp(path.join(folder, 'polygons/instance-preview.png')).composite([{ input: boundaries, blend: 'screen' }]).png().toBuffer();
      await save('preview.png', preview);
      const overlay = await sharp(image).composite([{ input: boundaries, blend: 'screen' }]).png().toBuffer();
      await save('overlay.png', overlay);
      const local = JSON.parse(await readFile(path.join(folder, 'polygons/coco.json')));
      const imageId = coco.images.length + 1;
      coco.images.push({ id: imageId, file_name: `${name}/image.${extension}`, width, height, external_key: name, revision: row.revision, status: row.status });
      for (const instance of local.annotations) coco.annotations.push({ ...instance, id: coco.annotations.length + 1, image_id: imageId });
      report.items.push(record);
      console.log(`${name}: revision ${row.revision}, ${record.polygonCount} polygons (${row.status})`);
    } catch (error) { report.errors.push({ imageId: row.external_key, message: error.message }); console.error(`${row.external_key}: ${error.message}`); }
  }
  await writeFile(path.join(root, 'coco.json'), JSON.stringify(coco));
  await writeFile(path.join(root, 'README.txt'), `Ground truth: polygons/*.png and coco.json preserve each independent instance, holes and overlaps.\nbinary-union.png merges foreground: internal instance borders cannot exist in a binary union.\npolygons/instance-ids-uint16.png stores one-channel numeric IDs; do not convert to 8-bit. polygons/instance-labels.json maps IDs to original polygons.\npolygons/instance-colors.png is a fill-only display preview. preview.png, overlay.png and vector-boundaries.* are display assets.\npolygons/instance-mask.png stores RGB24 IDs (id=R+256*G+65536*B); it looks dark by design. Both ID masks use later-polygon-wins and cannot retain overlaps or fully occluded instances; independent PNGs and COCO do.\ninitial-prediction.png is the model/init prediction, NOT saved/current ground truth. saved-raster.png exists only for a real maskStorageKey.\nsegmentation.json retains exact database bytes. audit/ identifies which reference is compared against polygon union.\nCOCO RLE is column-major [height,width], iscrowd=0. Categories: 1 main_flesh_band; 2 wart_flesh; 3 unclassified (never guess unknown labels).\nDRAFT annotations are included and explicitly marked; review before training.\nRun independent geometry audit as well as COCO validation before certifying vector topology.\n`);
  report.complete = report.errors.length === 0;
  if (!report.complete) process.exitCode = 1;
} finally {
  await writeFile(path.join(root, 'download-manifest.json'), JSON.stringify(report, null, 2));
  await sql.end();
}

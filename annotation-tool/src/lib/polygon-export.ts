import JSZip from 'jszip';
import sharp from 'sharp';
import type { MaskOperation } from '@/types';
import { rasterizePolygons } from './mask-pixels';
import { annotationSvg } from './annotation-svg';
import { cocoCategories, cocoInstance } from './coco-export';
import { instanceIdPng } from './instance-id-png';

/** Independent files retain overlaps and instance identity that one binary mask cannot encode. */
export async function addPolygonFiles(zip: JSZip, folder: string, operations: MaskOperation[], width: number, height: number, imageFilename = '../image.png') {
  const operation = operations.at(-1);
  const manifest = [];
  const cocoAnnotations = [];
  const instanceIds = new Uint32Array(width * height);
  const polygonEdges = new Uint8Array(width * height);
  if (operation?.type === 'POLYGON_SET') for (const [index, polygon] of operation.polygons.entries()) {
    if (index >= 0xffffff) throw new Error('Too many polygon instances for RGB24 mask');
    const name = `${String(index + 1).padStart(4, '0')}-${(polygon.label || polygon.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}`;
    const base = `${folder}/${name}`;
    const pixels = rasterizePolygons([polygon], width, height);
    cocoAnnotations.push(cocoInstance(polygon, pixels, width, height, index + 1, 1));
    for (let pixel = 0; pixel < pixels.length; pixel += 1) if (pixels[pixel]) {
      instanceIds[pixel] = index + 1;
      const x = pixel % width;
      if (x === 0 || x === width - 1 || pixel < width || pixel >= pixels.length - width
        || !pixels[pixel - 1] || !pixels[pixel + 1] || !pixels[pixel - width] || !pixels[pixel + width]) polygonEdges[pixel] = 255;
    }
    const mask = await sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
    zip.file(`${base}.json`, JSON.stringify({ schemaVersion: 'bitter-melon-prelabel-1.1', coordinateSpace: 'image_pixels', width, height,
      polygon, maskOperations: [{ type: 'POLYGON_SET', polygons: [polygon] }] }));
    zip.file(`${base}.png`, mask);
    zip.file(`${base}.svg`, annotationSvg([{ type: 'POLYGON_SET', polygons: [polygon] }], width, height));
    manifest.push({ id: polygon.id, label: polygon.label, json: `${name}.json`, mask: `${name}.png`, boundary: `${name}.svg` });
  }
  zip.file(`${folder}/index.json`, JSON.stringify({ width, height, coordinateSpace: 'image_pixels', polygons: manifest,
    vectorsCurrent: operation?.type === 'POLYGON_SET', note: operation && operation.type !== 'POLYGON_SET' ? 'Later brush/reset operations make stored polygons stale; no instance ground truth invented.' : undefined }));
  zip.file(`${folder}/coco.json`, JSON.stringify({ images: [{ id: 1, width, height, file_name: imageFilename }], annotations: cocoAnnotations, categories: cocoCategories }));
  if (manifest.length) {
    const rgb = Buffer.alloc(width * height * 3);
    const boundaries = Buffer.alloc(width * height);
    const preview = Buffer.alloc(width * height * 3);
    for (let pixel = 0; pixel < instanceIds.length; pixel += 1) {
      const id = instanceIds[pixel];
      rgb[pixel * 3] = id & 255;
      rgb[pixel * 3 + 1] = (id >>> 8) & 255;
      rgb[pixel * 3 + 2] = (id >>> 16) & 255;
      if (id) {
        const hue = ((id * 137.508) % 360) / 60;
        const chroma = 200, secondary = Math.round(chroma * (1 - Math.abs(hue % 2 - 1)));
        const channels = hue < 1 ? [chroma, secondary, 0] : hue < 2 ? [secondary, chroma, 0]
          : hue < 3 ? [0, chroma, secondary] : hue < 4 ? [0, secondary, chroma]
          : hue < 5 ? [secondary, 0, chroma] : [chroma, 0, secondary];
        preview[pixel * 3] = channels[0] + 35;
        preview[pixel * 3 + 1] = channels[1] + 35;
        preview[pixel * 3 + 2] = channels[2] + 35;
      }
    }
    for (let pixel = 0; pixel < polygonEdges.length; pixel += 1) if (polygonEdges[pixel]) {
      const x = pixel % width, y = Math.floor(pixel / width);
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const neighbor = yy * width + xx;
        boundaries[neighbor] = 255;
        preview[neighbor * 3] = 0;
        preview[neighbor * 3 + 1] = 0;
        preview[neighbor * 3 + 2] = 0;
      }
    }
    zip.file(`${folder}/instance-mask.png`, await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer());
    if (manifest.length <= 65535) zip.file(`${folder}/instance-ids-uint16.png`, instanceIdPng(instanceIds, width, height));
    // A fill-only preview shows ID separation without erasing small instances with drawn strokes.
    const colors = Buffer.alloc(width * height * 3);
    for (let pixel = 0; pixel < instanceIds.length; pixel++) {
      const id = instanceIds[pixel];
      if (!id) continue;
      const hue = ((id * 137.508) % 360) / 60;
      const c = 200, s = Math.round(c * (1 - Math.abs(hue % 2 - 1)));
      const channels = hue < 1 ? [c, s, 0] : hue < 2 ? [s, c, 0] : hue < 3 ? [0, c, s]
        : hue < 4 ? [0, s, c] : hue < 5 ? [s, 0, c] : [c, 0, s];
      for (let channel = 0; channel < 3; channel++) colors[pixel * 3 + channel] = channels[channel] + 35;
    }
    zip.file(`${folder}/instance-colors.png`, await sharp(colors, { raw: { width, height, channels: 3 } }).png().toBuffer());
    zip.file(`${folder}/boundaries.png`, await sharp(boundaries, { raw: { width, height, channels: 1 } }).png().toBuffer());
    zip.file(`${folder}/instance-preview.png`, await sharp(preview, { raw: { width, height, channels: 3 } }).png().toBuffer());
    // Draw every original closed vector ring independently. ID adjacency misses background
    // edges and overlapped polygons, so it cannot be used to export complete vector outlines.
    const svg = annotationSvg(operations, width, height).replace(/fill="#7c5cfa"/g, 'fill="none"')
      .replace(/stroke="#7c5cfa"/g, 'stroke="#ffffff"').replace(/stroke-width="0.7"/g, 'stroke-width="1"');
    zip.file(`${folder}/vector-boundaries.svg`, svg);
    zip.file(`${folder}/vector-boundaries.png`, await sharp(Buffer.from(svg)).flatten({ background: '#000000' }).png().toBuffer());
    zip.file(`${folder}/instance-labels.json`, JSON.stringify({ encoding: 'rgb24_little_endian', formula: 'id = R + 256*G + 65536*B', backgroundId: 0,
      overlapRule: 'later polygon in annotation array wins', instances: operation?.type === 'POLYGON_SET'
        ? operation.polygons.map((polygon, index) => ({ id: index + 1, polygonId: polygon.id, label: polygon.label, meta: polygon.meta ?? null })) : [] }));
  }
}

export async function addPixelAudit(zip: JSZip, folder: string, operations: MaskOperation[], width: number, height: number, savedMask: Uint8Array) {
  const operation = operations.at(-1);
  if (operation?.type !== 'POLYGON_SET') {
    zip.file(`${folder}/audit.json`, JSON.stringify({ width, height, hasSavedPolygons: false, note: 'No current polygon set; no automatic vectorization performed.' }));
    return;
  }
  const vector = rasterizePolygons(operation.polygons, width, height);
  const { data: saved, info } = await sharp(savedMask).flatten({ background: '#000000' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) throw Error('Saved raster coordinate size differs from polygons');
  let differentPixels = 0; let vectorOnly = 0; let savedOnly = 0;
  const difference = new Uint8Array(width * height * 3);
  for (let i = 0; i < vector.length; i += 1) {
    const a = vector[i] > 0; const b = saved[i] >= 128;
    if (a === b) continue;
    differentPixels += 1;
    if (a) { vectorOnly += 1; difference[i * 3] = 255; }
    else { savedOnly += 1; difference[i * 3 + 2] = 255; }
  }
  zip.file(`${folder}/vector-mask.png`, await sharp(vector, { raw: { width, height, channels: 1 } }).png().toBuffer());
  zip.file(`${folder}/difference.png`, await sharp(difference, { raw: { width, height, channels: 3 } }).png().toBuffer());
  zip.file(`${folder}/audit.json`, JSON.stringify({ width, height, hasSavedPolygons: true, polygonCount: operation.polygons.length,
    differentPixels, vectorOnly, savedOnly, legend: { red: 'polygon foreground absent from saved raster', blue: 'saved foreground absent from polygons', black: 'equal' },
    note: 'Comparison only. Original saved raster and polygon coordinates remain unchanged.' }));
}

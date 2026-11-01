// A second rendering engine: SVG native fill with no strokes, smoothing or modified coordinates.
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const records = [];
for (const key of ['8582_01', '8769_01']) {
  const folder = path.join(root, key);
  const annotation = JSON.parse(await readFile(path.join(folder, 'annotation.json')));
  const { width, height } = annotation;
  const polygons = annotation.maskOperations.at(-1).polygons;
  const paths = polygons.map(polygon => {
    const d = [polygon.nodes, ...(polygon.holes ?? [])].map(ring => ring.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') + ' Z').join(' ');
    return `<path d="${d}" fill="white" fill-rule="evenodd"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="black"/>${paths}</svg>`;
  const native = await sharp(Buffer.from(svg)).removeAlpha().greyscale().threshold(127).raw().toBuffer();
  const original = await sharp(path.join(folder, 'mask.png')).greyscale().raw().toBuffer();
  const differences = Buffer.alloc(width * height * 3);
  let nativeOnly = 0, centerOnly = 0;
  for (let i = 0; i < original.length; i++) if (original[i] !== native[i]) {
    if (native[i]) { nativeOnly++; differences[i * 3] = 255; }
    else { centerOnly++; differences[i * 3 + 2] = 255; }
  }
  await writeFile(path.join(output, key, 'native-fill.svg'), svg);
  await sharp(native, { raw: { width, height, channels: 1 } }).png().toFile(path.join(output, key, 'native-binary-union.png'));
  await sharp(differences, { raw: { width, height, channels: 3 } }).png().toFile(path.join(output, key, 'native-vs-center-rule.png'));
  records.push({ imageId: key, width, height, polygonCount: polygons.length, nativeOnly, centerOnly,
    note: 'SVG native antialiasing threshold differs from pixel-center membership near boundaries. Both fill the polygon union; neither carries instance separation. No outlines drawn.' });
}
await writeFile(path.join(output, 'native-fill-audit.json'), JSON.stringify(records, null, 2));
console.log(JSON.stringify(records));

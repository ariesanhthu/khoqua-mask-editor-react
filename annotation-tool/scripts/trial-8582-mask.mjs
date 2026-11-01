// Intentionally processes only 8582_01. No batch export or database writes.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';

const key = '8582_01';
const source = path.resolve('artifacts/ground-truth-audited-2026-10-04', key);
const target = path.resolve(process.argv[2] || 'artifacts/trial-8582-2026-10-04');
await mkdir(target, { recursive: false });
const original = await readFile(path.join(source, 'annotation.json'));
const annotation = JSON.parse(original);
const { width, height } = annotation;
const polygons = annotation.maskOperations.at(-1).polygons;
await writeFile(path.join(target, 'annotation.original.json'), original);
await writeFile(path.join(target, 'image.jpg'), await readFile(path.join(source, 'image.jpg')));
await writeFile(path.join(target, 'before-binary-union.png'), await readFile(path.join(source, 'binary-union.png')));
const paths = polygons.map(p => [p.nodes, ...(p.holes ?? [])].map(ring => ring.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') + ' Z').join(' '));
const fills = paths.map(d => `<path d="${d}" fill="white" fill-rule="evenodd"/>`).join('');
const outlines = paths.map(d => `<path d="${d}" fill="none" stroke="black" stroke-width="2" stroke-linejoin="round"/>`).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="black"/>${fills}${outlines}</svg>`;
await writeFile(path.join(target, 'trial-separated.svg'), svg);
await sharp(Buffer.from(svg)).removeAlpha().greyscale().threshold(127).png().toFile(path.join(target, 'trial-separated.png'));
const before = await sharp(path.join(source, 'binary-union.png')).greyscale().raw().toBuffer();
const after = await sharp(path.join(target, 'trial-separated.png')).greyscale().raw().toBuffer();
let removed = 0, added = 0;
for (let i = 0; i < before.length; i++) {
  if (before[i] && !after[i]) removed++;
  if (!before[i] && after[i]) added++;
}
await writeFile(path.join(target, 'trial-report.json'), JSON.stringify({ imageId: key, revision: annotation.revision,
  width, height, polygonCount: polygons.length, annotationSha256: createHash('sha256').update(original).digest('hex'),
  trial: 'All original fills first, then all original closed outlines black, width 2 image pixels, threshold to binary',
  removedForegroundPixels: removed, addedForegroundPixels: added,
  groundTruthCertified: false, note: 'Trial for visual review only. Black separator strokes change foreground coverage. Original geometry/COCO are not modified. No batch processing performed.' }, null, 2));
const html = `<!doctype html><html lang="vi"><meta charset="utf-8"><title>8582_01 — thử một ảnh</title>
<style>body{background:#181818;color:#eee;font:16px system-ui;margin:20px}button{padding:10px;margin:10px 0}section{margin:20px 0}img,canvas{max-width:100%;height:auto;background:#000;border:1px solid #555}h2{font-size:18px}p{max-width:1100px}</style>
<h1>8582_01 — chỉ thử một ảnh, 18 polygon</h1><p>Tọa độ gốc revision ${annotation.revision}. So sánh vùng tô với lớp đường viền. Không thay đổi database, không xuất hàng loạt.</p>
<button id="capture">Lưu hai mask Canvas để kiểm tra</button><span id="status"></span>
<section><h2>A. Mask cũ: gộp mọi polygon trắng → mất đường phân cách</h2><img src="/before-binary-union.png"></section>
<section><h2>B. Bản thử: vùng trắng + toàn bộ đường viền đen liên tục (2 px)</h2><img src="/trial-separated.png"></section>
<section><h2>C. Native Canvas chỉ fill — cùng Path2D/evenodd như web, không stroke</h2><canvas id="fill" width="${width}" height="${height}"></canvas></section>
<section><h2>D. Native Canvas fill + lớp viền riêng</h2><canvas id="separated" width="${width}" height="${height}"></canvas></section>
<p>B/D là bản thử có vẽ thêm separator: pixel foreground đã thay đổi. Chưa xác nhận dùng làm ground truth. Dữ liệu polygon gốc vẫn nguyên vẹn.</p>
<script>const polygons=${JSON.stringify(polygons)};const paths=polygons.map(p=>{const path=new Path2D();for(const ring of [p.nodes,...p.holes||[]]){ring.forEach((n,i)=>i?path.lineTo(n.x,n.y):path.moveTo(n.x,n.y));path.closePath()}return path});
for(const id of ['fill','separated']){const ctx=document.getElementById(id).getContext('2d',{willReadFrequently:true});ctx.fillStyle='#000';ctx.fillRect(0,0,${width},${height});ctx.fillStyle='#fff';paths.forEach(p=>ctx.fill(p,'evenodd'));if(id==='separated'){ctx.strokeStyle='#000';ctx.lineWidth=2;ctx.lineJoin='round';paths.forEach(p=>ctx.stroke(p))}const image=ctx.getImageData(0,0,${width},${height});for(let i=0;i<image.data.length;i+=4){const v=image.data[i]>=128?255:0;image.data[i]=image.data[i+1]=image.data[i+2]=v;image.data[i+3]=255}ctx.putImageData(image,0,0)}
document.getElementById('capture').onclick=async()=>{for(const id of ['fill','separated']){const blob=await new Promise(resolve=>document.getElementById(id).toBlob(resolve,'image/png'));const response=await fetch('/capture/'+id,{method:'POST',body:blob});if(!response.ok)throw Error('capture failed')}document.getElementById('status').textContent='Đã lưu 2 mask native Canvas'};
</script></html>`;
await writeFile(path.join(target, 'index.html'), html);
console.log(JSON.stringify({ target, polygonCount: polygons.length, removed, added }));

// Native browser Canvas produces ONE final ID raster. All PNG and COCO derivatives
// are generated from this raster, so preview/instance/COCO cannot disagree.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const source = path.resolve('artifacts/ground-truth-audited-2026-10-04');
const target = path.resolve('artifacts/ground-truth-consistent-2026-10-04');
await mkdir(target, { recursive: false });
const manifest = JSON.parse(await readFile(path.join(source, 'download-manifest.json')));
const names = new Set(manifest.items.map(item => item.imageId));
await writeFile(path.join(target, 'source-manifest.json'), JSON.stringify(manifest, null, 2));
const html = `<!doctype html><html lang="vi"><meta charset="utf-8"><title>Ground truth đồng nhất</title>
<style>body{font:16px system-ui;background:#181818;color:#eee;margin:24px}button{padding:12px}canvas{display:block;max-width:100%;height:auto}pre{white-space:pre-wrap}</style>
<h1>Ground truth đồng nhất — Canvas, viền đen 2 px</h1><p>Mask cuối cùng là nguồn duy nhất cho PNG, ID mask và COCO.</p><button id="start">Dựng 11 ảnh theo mẫu đã xác nhận</button><pre id="status">Chưa chạy</pre><canvas id="preview"></canvas>
<script>
const status=document.getElementById('status'),preview=document.getElementById('preview');
document.getElementById('start').onclick=async()=>{document.getElementById('start').disabled=true;try{
const items=await(await fetch('/manifest')).json();let lines=[];
for(const item of items){status.textContent=[...lines,'Đang dựng '+item.imageId].join('\\n');
const a=await(await fetch('/annotation/'+item.imageId)).json();const {width:w,height:h}=a,polygons=a.maskOperations.at(-1).polygons;
const paths=polygons.map(p=>{const path=new Path2D();for(const ring of [p.nodes,...(p.holes||[])]){ring.forEach((n,i)=>i?path.lineTo(n.x,n.y):path.moveTo(n.x,n.y));path.closePath()}return path});
preview.width=w;preview.height=h;const ctx=preview.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#000';ctx.fillRect(0,0,w,h);ctx.fillStyle='#fff';paths.forEach(p=>ctx.fill(p,'evenodd'));ctx.strokeStyle='#000';ctx.lineWidth=2;ctx.lineJoin='round';paths.forEach(p=>ctx.stroke(p));
const rendered=ctx.getImageData(0,0,w,h),binary=new Uint8Array(w*h),ids=new Uint16Array(w*h),best=new Uint8Array(w*h);
for(let i=0;i<binary.length;i++)binary[i]=rendered.data[i*4]>=128?255:0;
const scratch=document.createElement('canvas');scratch.width=w;scratch.height=h;const sc=scratch.getContext('2d',{willReadFrequently:true});
for(let index=0;index<paths.length;index++){sc.fillStyle='#000';sc.fillRect(0,0,w,h);sc.fillStyle='#fff';sc.fill(paths[index],'evenodd');const data=sc.getImageData(0,0,w,h).data;
for(let i=0;i<ids.length;i++){const coverage=data[i*4];if(binary[i]&&coverage>0&&coverage>=best[i]){best[i]=coverage;ids[i]=index+1}}
if(index%25===0)await new Promise(resolve=>requestAnimationFrame(resolve));}
for(let i=0;i<ids.length;i++){if(binary[i]&&!ids[i])throw Error('Foreground has no source polygon: '+item.imageId);const v=ids[i]?255:0;rendered.data[i*4]=rendered.data[i*4+1]=rendered.data[i*4+2]=v;rendered.data[i*4+3]=255}ctx.putImageData(rendered,0,0);
const packed=new Uint8Array(ids.length*2);for(let i=0;i<ids.length;i++){packed[i*2]=ids[i]&255;packed[i*2+1]=ids[i]>>>8}
for(const [kind,bytes] of [['ids',packed],['binary',binary]]){const response=await fetch('/capture/'+item.imageId+'/'+kind,{method:'POST',body:bytes});if(!response.ok)throw Error('Cannot save '+item.imageId)}
lines.push(item.imageId+': '+polygons.length+' source polygons — saved');status.textContent=lines.join('\\n');await new Promise(resolve=>requestAnimationFrame(resolve));}
status.textContent+='\\nHOÀN TẤT 11/11';}catch(e){status.textContent+='\\nLỖI: '+e.message;document.getElementById('start').disabled=false}};
</script></html>`;
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    if (request.method === 'POST' && parts[0] === 'capture' && names.has(parts[1]) && ['ids','binary'].includes(parts[2])) {
      const a = JSON.parse(await readFile(path.join(source, parts[1], 'annotation.json')));
      const expected = a.width * a.height * (parts[2] === 'ids' ? 2 : 1);
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > expected) throw Error('Capture too large'); chunks.push(chunk); }
      if (size !== expected) throw Error('Capture dimensions mismatch');
      await mkdir(path.join(target, parts[1]), { recursive: true });
      await writeFile(path.join(target, parts[1], parts[2] === 'ids' ? 'native-ids.u16' : 'native-binary.u8'), Buffer.concat(chunks));
      console.log(`${parts[1]}: ${parts[2]} saved`); response.end('saved'); return;
    }
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/manifest') response.end(JSON.stringify(manifest.items.map(({ imageId }) => ({ imageId }))));
    else if (parts[0] === 'annotation' && names.has(parts[1])) response.end(await readFile(path.join(source, parts[1], 'annotation.json')));
    else if (url.pathname === '/') { response.setHeader('Content-Type','text/html; charset=utf-8'); response.end(html); }
    else { response.writeHead(404); response.end(); }
  } catch (error) { console.error(error.message); response.writeHead(500); response.end('failed'); }
}).listen(4319, '127.0.0.1', () => console.log('Consistent GT renderer http://127.0.0.1:4319'));

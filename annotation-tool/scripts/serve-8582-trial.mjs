import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(process.argv[2] || 'artifacts/trial-8582-2026-10-04');
createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && ['/capture/fill', '/capture/separated'].includes(request.url)) {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 10_000_000) throw Error('Too large'); chunks.push(chunk); }
      const filename = request.url === '/capture/fill' ? 'native-canvas-fill.png' : 'native-canvas-separated.png';
      await writeFile(path.join(root, filename), Buffer.concat(chunks));
      response.end('saved'); return;
    }
    const allowed = { '/': 'index.html', '/before-binary-union.png': 'before-binary-union.png', '/trial-separated.png': 'trial-separated.png' };
    const filename = allowed[request.url];
    if (!filename) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', filename.endsWith('.html') ? 'text/html; charset=utf-8' : 'image/png');
    response.end(await readFile(path.join(root, filename)));
  } catch { response.writeHead(500); response.end('failed'); }
}).listen(4318, '127.0.0.1', () => console.log('Single-image preview: http://127.0.0.1:4318'));

import { get, list } from '@vercel/blob';
import postgres from 'postgres';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const destination = path.resolve(process.argv[2]);
await mkdir(destination, { recursive: false });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = { startedAt: new Date().toISOString(), tables: {}, blobs: [], complete: false };
try {
  const database = await sql.begin('isolation level repeatable read read only', async (tx) => {
    const tables = await tx`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
    const snapshot = {};
    for (const { table_name: table } of tables) {
      snapshot[table] = await tx`select * from ${tx(table)}`;
      report.tables[table] = snapshot[table].length;
    }
    return snapshot;
  });
  const bytes = Buffer.from(JSON.stringify(database));
  await writeFile(path.join(destination, 'database.json'), bytes, { flag: 'wx' });
  report.databaseSha256 = hash(bytes);
  let cursor;
  do {
    const page = await list({ cursor, limit: 1000 });
    for (let i = 0; i < page.blobs.length; i += 6) {
      await Promise.all(page.blobs.slice(i, i + 6).map(async (blob) => {
        const relative = `blobs/${blob.pathname}`;
        const target = path.resolve(destination, relative);
        if (!target.startsWith(destination + path.sep)) throw new Error('Unsafe blob path');
        let asset;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            const response = await get(blob.url, { access: 'private', useCache: false });
            if (response?.statusCode !== 200 || !response.stream) throw new Error(`Cannot download ${blob.pathname}`);
            asset = Buffer.from(await new Response(response.stream).arrayBuffer());
            break;
          } catch (error) { if (attempt === 3) throw error; }
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, asset, { flag: 'wx' });
        const sha256 = hash(asset);
        if (hash(await readFile(target)) !== sha256) throw new Error('Backup checksum mismatch');
        report.blobs.push({ pathname: blob.pathname, relative, size: asset.length, sha256 });
      }));
      console.log(`Downloaded ${report.blobs.length} blobs`);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  report.complete = true;
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify({ tables: report.tables, blobs: report.blobs.length, destination }));
} finally {
  await writeFile(path.join(destination, 'backup-report.json'), JSON.stringify(report, null, 2));
  await sql.end();
}

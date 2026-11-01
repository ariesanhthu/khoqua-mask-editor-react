// Copies every object from the private Vercel Blob store to a Cloudflare R2 bucket, keeping
// pathnames identical so database `maskStorageKey` values and `blob:` dataset references
// keep working. Reads Blob and writes ONLY to R2: it never changes or deletes Blob objects
// or database rows.
//
// Dry run (default; reads Blob and HEADs R2, writes nothing):
//   node --env-file=.env.local scripts/migrate-blob-to-r2.mjs
// Copy for real:
//   node --env-file=.env.local scripts/migrate-blob-to-r2.mjs --apply
//
// Needs BLOB_READ_WRITE_TOKEN plus R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.
// Objects already in R2 with the same size are skipped, so the script can be re-run safely.
import { get, list } from '@vercel/blob';
import { AwsClient } from 'aws4fetch';

const apply = process.argv.includes('--apply');

const missing = ['BLOB_READ_WRITE_TOKEN', 'R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
  .filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const endpoint = process.env.R2_ENDPOINT.trim().replace(/\/+$/, '');
const bucket = process.env.R2_BUCKET.trim();
const client = new AwsClient({
  accessKeyId: process.env.R2_ACCESS_KEY_ID.trim(),
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY.trim(),
  service: 's3',
  region: 'auto',
  retries: 3,
});
const urlFor = (key) => `${endpoint}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;

async function r2Size(key) {
  const response = await client.fetch(urlFor(key), { method: 'HEAD' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HEAD ${key} failed (${response.status})`);
  return Number(response.headers.get('content-length'));
}

const totals = { listed: 0, bytes: 0, skipped: 0, copied: 0, failed: 0 };
const failures = [];
let cursor;
do {
  const page = await list({ cursor, limit: 500 });
  for (const item of page.blobs) {
    totals.listed += 1;
    totals.bytes += item.size;
    try {
      if ((await r2Size(item.pathname)) === item.size) {
        totals.skipped += 1;
        continue;
      }
      if (!apply) {
        totals.copied += 1; // would copy
        continue;
      }
      const source = await get(item.pathname, { access: 'private', useCache: false });
      if (!source || source.statusCode !== 200 || !source.stream) throw new Error('Blob read failed');
      const bytes = Buffer.from(await new Response(source.stream).arrayBuffer());
      if (bytes.length !== item.size) throw new Error(`size mismatch (${bytes.length} vs ${item.size})`);
      const put = await client.fetch(urlFor(item.pathname), {
        method: 'PUT',
        headers: { 'Content-Type': item.contentType || 'application/octet-stream' },
        body: bytes,
      });
      if (!put.ok) throw new Error(`PUT failed (${put.status})`);
      if ((await r2Size(item.pathname)) !== item.size) throw new Error('verification after PUT failed');
      totals.copied += 1;
    } catch (error) {
      totals.failed += 1;
      failures.push(`${item.pathname}: ${error instanceof Error ? error.message : error}`);
    }
  }
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  blobObjects: totals.listed,
  blobBytes: totals.bytes,
  alreadyInR2: totals.skipped,
  [apply ? 'copied' : 'wouldCopy']: totals.copied,
  failed: totals.failed,
}, null, 2));
if (failures.length) {
  console.error(failures.slice(0, 20).join('\n'));
  process.exit(2);
}

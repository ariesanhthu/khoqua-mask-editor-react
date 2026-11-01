import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { SignJWT } from 'jose';
import JSZip from 'jszip';

const [backupDir, datasetDir] = process.argv.slice(2);
const base = 'https://bitter-melon-annotation.vercel.app';
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const old = JSON.parse(await readFile(path.join(backupDir, 'database.json'), 'utf8'));
const imports = JSON.parse(await readFile(path.join(backupDir, 'import-report.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(datasetDir, 'manifest.json'), 'utf8'));
try {
  const users = await sql`select id, display_name, role from users`;
  async function cookie(user) {
    const token = await new SignJWT({ userId: user.id, displayName: user.display_name, role: user.role })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m')
      .sign(new TextEncoder().encode(process.env.SECRET_KEY));
    return `auth-token=${token}`;
  }
  const admin = await cookie(users.find(u => u.role === 'ADMIN'));
  const member = await cookie(users.find(u => u.role !== 'ADMIN'));
  const read = async (url, auth = admin) => {
    const response = await fetch(base + url, { headers: { cookie: auth } });
    assert.equal(response.status, 200, `${url}: ${response.status}`);
    return response;
  };
  const versions = await sql`select * from annotation_versions`;
  for (const previous of old.annotation_versions) {
    const current = versions.find(v => v.id === previous.id);
    assert.equal(current.segmentation_json, previous.segmentation_json);
    assert.equal(current.breakpoints_json, previous.breakpoints_json);
  }
  const report = [];
  for (const item of imports) {
    const source = manifest.items.find(i => i.id === item.image);
    const payload = JSON.parse(await readFile(path.join(datasetDir, source.prelabel), 'utf8'));
    const prior = versions.find(v => v.dataset_file_id === item.fileId && v.version_number === item.preservedVersion);
    const previous = old.annotations.find(a => a.dataset_file_id === item.fileId);
    if (previous) {
      assert.equal(prior.segmentation_json, previous.segmentation_json);
      assert.equal(prior.breakpoints_json, previous.breakpoints_json);
    }
    const editor = await (await read(`/api/files/${item.fileId}/editor`)).json();
    assert.deepEqual([editor.file.width, editor.file.height], [source.width, source.height]);
    assert.deepEqual(editor.annotation.segmentation.maskOperations, payload.maskOperations);
    assert.equal(editor.annotation.segmentation.sourceNotebook, source.notebook);
    for (const [url, expected] of [[editor.assets.imageUrl, source.imageSha256], [editor.assets.predictionMaskUrl, source.maskSha256], [editor.assets.currentMaskUrl, source.maskSha256]]) {
      assert.equal(hash(Buffer.from(await (await read(url)).arrayBuffer())), expected);
    }
    const endpoint = `/api/files/${item.fileId}/versions`;
    assert.equal((await fetch(base + endpoint, { headers: { cookie: member } })).status, 403);
    const history = await (await read(endpoint)).json();
    assert.ok(history.versions.some(v => v.versionNumber === item.preservedVersion));
    assert.ok(history.versions.some(v => v.versionNumber === item.newVersion));
    report.push({ image: item.image, notebook: source.notebook, size: [source.width, source.height], preservedVersion: item.preservedVersion, newVersion: item.newVersion, polygons: payload.maskOperations[0].polygons.length, assetsSha256: 'match', rawPolygons: 'exact' });
    console.log(`Verified ${item.image}`);
  }
  const project = old.projects[0];
  const zipResponse = await read(`/api/projects/${project.id}/export`);
  const zipBytes = Buffer.from(await zipResponse.arrayBuffer());
  await writeFile(path.join(backupDir, 'production-ground-truth.zip'), zipBytes);
  const zip = await JSZip.loadAsync(zipBytes);
  const annotations = await sql`select * from annotations`;
  for (const item of imports) {
    const current = annotations.find(a => a.dataset_file_id === item.fileId);
    const source = manifest.items.find(i => i.id === item.image);
    const raw = await zip.file(`saved/${item.image}/segmentation.json`).async('string');
    assert.equal(raw, current.segmentation_json);
    const annotation = JSON.parse(await zip.file(`annotations/${item.image}.json`).async('string'));
    assert.deepEqual(annotation.segmentation, JSON.parse(raw));
    assert.deepEqual(annotation.maskOperations, JSON.parse(raw).maskOperations);
    assert.equal(hash(await zip.file(`images/${item.image}.png`).async('nodebuffer')), source.imageSha256);
    assert.equal(hash(await zip.file(`masks/${item.image}.png`).async('nodebuffer')), source.maskSha256);
    assert.ok(zip.file(`boundaries/${item.image}.svg`));
    assert.ok(zip.file(`overlays/${item.image}.svg`));
  }
  for (const version of versions) {
    const file = old.dataset_files.find(f => f.id === version.dataset_file_id);
    const folder = `versions/${file.external_key}/v${version.version_number}`;
    assert.equal(await zip.file(`${folder}/segmentation.json`).async('string'), version.segmentation_json);
    assert.equal(await zip.file(`${folder}/breakpoints.json`).async('string'), version.breakpoints_json);
  }
  await writeFile(path.join(backupDir, 'notebook-deployment-verification.json'), JSON.stringify({ report, oldVersionsUnchanged: old.annotation_versions.length, exportedVersions: versions.length, zipBytes: zipBytes.length, result: 'PASS' }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', files: report.length, exportedVersions: versions.length, zipBytes: zipBytes.length }));
} finally { await sql.end(); }

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { SignJWT } from 'jose';
import sharp from 'sharp';

const backupDir = process.argv[2];
const base = 'https://bitter-melon-annotation.vercel.app';
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const report = [];
const old = JSON.parse(await readFile(path.join(backupDir, 'database.json'), 'utf8'));
const imports = JSON.parse(await readFile(path.join(backupDir, 'import-report.json'), 'utf8'));
try {
  const users = await sql`select id, display_name, role from users`;
  async function cookie(user) {
    const token = await new SignJWT({ userId: user.id, displayName: user.display_name, role: user.role })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('5m')
      .sign(new TextEncoder().encode(process.env.SECRET_KEY));
    return `auth-token=${token}`;
  }
  const adminCookie = await cookie(users.find((u) => u.role === 'ADMIN'));
  const memberCookie = await cookie(users.find((u) => u.role !== 'ADMIN'));
  const read = async (url, auth = adminCookie, method = 'GET') => fetch(base + url, { method, headers: auth ? { cookie: auth } : {} });
  for (const item of imports) {
    const root = `/api/files/${item.fileId}/versions`;
    assert.equal((await read(root, '')).status, 401);
    assert.equal((await read(root, memberCookie)).status, 403);
    const listResponse = await read(root);
    assert.equal(listResponse.status, 200);
    const { versions } = await listResponse.json();
    const prior = versions.find((v) => v.versionNumber === item.serverVersion);
    const fresh = versions.find((v) => v.versionNumber === item.fleshVersion);
    assert.ok(prior && fresh);
    const source = old.annotations.find((a) => a.dataset_file_id === item.fileId);
    const [snapshot] = await sql`select * from annotation_versions where id = ${prior.id}`;
    assert.equal(snapshot.segmentation_json, source.segmentation_json);
    assert.equal(snapshot.breakpoints_json, source.breakpoints_json);
    const [current] = await sql`select * from annotations where dataset_file_id = ${item.fileId}`;
    const [freshRow] = await sql`select * from annotation_versions where id = ${fresh.id}`;
    assert.equal(current.segmentation_json, freshRow.segmentation_json);
    for (const version of [prior, fresh]) {
      const url = `${root}/${version.id}`;
      assert.equal((await read(url, memberCookie)).status, 403);
      assert.equal((await read(url, memberCookie, 'DELETE')).status, 403);
      assert.equal((await read(url + '/assets/image', memberCookie)).status, 403);
      const detailResponse = await read(url);
      assert.equal(detailResponse.status, 200);
      const detail = await detailResponse.json();
      for (const assetUrl of [detail.imageUrl, detail.maskUrl]) {
        const response = await read(assetUrl);
        assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        const metadata = await sharp(bytes).metadata();
        assert.equal(metadata.width, detail.width);
        assert.equal(metadata.height, detail.height);
      }
      report.push({ file: item.key, version: version.versionNumber, label: version.label, width: detail.width, height: detail.height, assets: 'OK', nonAdmin: '403' });
    }
    const bootstrap = await read(`/api/files/${item.fileId}/editor`);
    assert.equal(bootstrap.status, 200);
    const editor = await bootstrap.json();
    assert.equal(editor.file.width, 1200);
    assert.equal(editor.annotation.revision, item.revision);
    assert.ok(editor.annotation.segmentation.maskOperations[0].polygons.every((p) => /^w[1-9]\d*$/.test(p.label)));
  }
  for (const version of old.annotation_versions) {
    const [row] = await sql`select segmentation_json, breakpoints_json from annotation_versions where id = ${version.id}`;
    assert.equal(row.segmentation_json, version.segmentation_json);
    assert.equal(row.breakpoints_json, version.breakpoints_json);
  }
  for (const annotation of old.annotations.filter((a) => !imports.some((i) => i.fileId === a.dataset_file_id))) {
    const [row] = await sql`select * from annotations where dataset_file_id = ${annotation.dataset_file_id}`;
    assert.equal(row.segmentation_json, annotation.segmentation_json);
    assert.equal(row.breakpoints_json, annotation.breakpoints_json);
  }
  await writeFile(path.join(backupDir, 'deployment-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  console.log('PASS: server snapshots exact, all original history retained, other annotations unchanged, ADMIN access and both versions assets verified');
} finally { await sql.end(); }

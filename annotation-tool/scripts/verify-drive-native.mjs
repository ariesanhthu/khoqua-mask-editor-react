import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { SignJWT } from 'jose';
import JSZip from 'jszip';
import sharp from 'sharp';
import { rasterizePolygons } from '../src/lib/mask-pixels.ts';

const [backupDir,datasetDir] = process.argv.slice(2);
const backup = JSON.parse(await readFile(path.join(backupDir,'database.json'),'utf8'));
const imports = JSON.parse(await readFile(path.join(backupDir,'drive-import-report.json'),'utf8'));
const manifest = JSON.parse(await readFile(path.join(datasetDir,'manifest.json'),'utf8'));
const sql = postgres(process.env.DATABASE_URL,{max:1,prepare:false});
const hash = b=>createHash('sha256').update(b).digest('hex');
const md5 = b=>createHash('md5').update(b).digest('hex');
const base='https://bitter-melon-annotation.vercel.app';
try {
  const users=await sql`select id,display_name,role from users`;
  const token=async user=>new SignJWT({userId:user.id,displayName:user.display_name,role:user.role}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('20m').sign(new TextEncoder().encode(process.env.SECRET_KEY));
  const admin=await token(users.find(u=>u.role==='ADMIN')); const member=await token(users.find(u=>u.role!=='ADMIN'));
  const request=async(url,auth=admin,method='GET')=>fetch(base+url,{method,headers:{cookie:`auth-token=${auth}`}});
  const read=async url=>{const r=await request(url);assert.equal(r.status,200,`${url}: ${r.status} ${r.ok?'':await r.text()}`);return r;};
  const versions=await sql`select id,dataset_file_id,version_number,md5(segmentation_json) as segmentation_md5,md5(breakpoints_json) as breakpoints_md5,md5(asset_snapshot_json) as assets_md5 from annotation_versions`;
  const annotations=await sql`select * from annotations`;
  const files=await sql`select * from dataset_files`;
  for (const old of backup.annotation_versions) {
    const current=versions.find(v=>v.id===old.id);
    assert.equal(current.segmentation_md5,md5(old.segmentation_json));
    assert.equal(current.breakpoints_md5,md5(old.breakpoints_json));
    assert.equal(current.assets_md5,old.asset_snapshot_json ? md5(old.asset_snapshot_json) : null);
  }
  const report=[];
  for (const item of imports) {
    const source=manifest.items.find(i=>i.id===item.image);
    const previous=backup.annotations.find(a=>a.dataset_file_id===item.fileId);
    const preserved=versions.find(v=>v.dataset_file_id===item.fileId&&v.version_number===item.preservedVersion);
    assert.equal(preserved.segmentation_md5,md5(previous.segmentation_json));
    assert.equal(preserved.breakpoints_md5,md5(previous.breakpoints_json));
    const restored=backup.annotation_versions.find(v=>v.dataset_file_id===item.fileId&&v.version_number===item.restoredFrom);
    const annotation=annotations.find(a=>a.dataset_file_id===item.fileId);
    assert.equal(annotation.segmentation_json,restored.segmentation_json);
    assert.equal(annotation.breakpoints_json,restored.breakpoints_json);
    const generated=versions.find(v=>v.dataset_file_id===item.fileId&&v.version_number===item.generatedVersion);
    const payload=JSON.parse(await readFile(path.join(datasetDir,source.prelabel),'utf8'));
    const prefix=`datasets/${manifest.dataset_version}`;
    const generatedRaw=JSON.stringify({humanAction:'MODIFIED',maskOperations:payload.maskOperations,maskStorageKey:`${prefix}/${source.prediction}`,sourcePredictionDriveFileId:`blob:${prefix}/${source.prediction}`,sourceNotebook:source.notebook,sourceImageSha256:source.sourceSha256,preprocessing:source.preprocessing});
    assert.equal(generated.segmentation_md5,md5(generatedRaw));
    const editor=await(await read(`/api/files/${item.fileId}/editor`)).json();
    assert.deepEqual(editor.annotation.segmentation,JSON.parse(restored.segmentation_json));
    assert.deepEqual([editor.file.width,editor.file.height],[source.width,source.height]);
    assert.equal(hash(Buffer.from(await(await read(editor.assets.imageUrl)).arrayBuffer())),source.sourceSha256);
    const boundary=await(await read(`/api/files/${item.fileId}/versions/${generated.id}/assets/boundary`)).text();
    assert.equal((boundary.match(/<path /g)||[]).length,payload.maskOperations[0].polygons.length);
    const endpoint=`/api/files/${item.fileId}/versions/${generated.id}`;
    assert.equal((await request(endpoint,member,'POST')).status,403);
    assert.equal((await request(endpoint+'/export',member)).status,403);
    report.push({image:item.image,size:[source.width,source.height],restoredPolygons:JSON.parse(restored.segmentation_json).maskOperations?.at(-1)?.polygons?.length,generatedPolygons:source.polygonCount,sourceSha256:'exact',rawData:'exact'});
    console.log(`Verified native image and preserved polygons: ${item.image}`);
  }
  const response=await read(`/api/projects/${backup.projects[0].id}/export`);
  const bytes=Buffer.from(await response.arrayBuffer());
  await writeFile(path.join(backupDir,'drive-native-production.zip'),bytes);
  const zip=await JSZip.loadAsync(bytes);
  let polygonCount=0; const pixelAudits=[];
  for (const item of imports) {
    const row=annotations.find(a=>a.dataset_file_id===item.fileId); const seg=JSON.parse(row.segmentation_json);
    const source=manifest.items.find(i=>i.id===item.image);
    assert.equal(await zip.file(`saved/${item.image}/segmentation.json`).async('string'),row.segmentation_json);
    assert.equal(hash(await zip.file(`images/${item.image}.jpg`).async('nodebuffer')),source.sourceSha256);
    if(seg.maskStorageKey) assert.equal(hash(await zip.file(`masks/${item.image}.png`).async('nodebuffer')),hash(await readFile(path.join(backupDir,'blobs',seg.maskStorageKey))));
    const polygons=[...(seg.maskOperations||[])].reverse().find(o=>o.type==='POLYGON_SET')?.polygons||[];
    const index=JSON.parse(await zip.file(`polygons/${item.image}/index.json`).async('string'));
    assert.equal(index.polygons.length,polygons.length);
    for (const [i,entry] of index.polygons.entries()) {
      const folder=`polygons/${item.image}`;
      assert.deepEqual(JSON.parse(await zip.file(`${folder}/${entry.json}`).async('string')).polygon,polygons[i]);
      assert.ok(zip.file(`${folder}/${entry.mask}`));assert.ok(zip.file(`${folder}/${entry.boundary}`));
      if (i===0||i===polygons.length-1) {
        const {data,info}=await sharp(await zip.file(`${folder}/${entry.mask}`).async('nodebuffer')).greyscale().raw().toBuffer({resolveWithObject:true});
        assert.deepEqual([info.width,info.height],[source.width,source.height]);
        assert.ok(data.equals(Buffer.from(rasterizePolygons([polygons[i]],source.width,source.height))));
      }
    }
    polygonCount+=polygons.length;
    pixelAudits.push({image:item.image,...JSON.parse(await zip.file(`pixel-audit/${item.image}/audit.json`).async('string'))});
  }
  for(const v of versions) {
    const file=files.find(f=>f.id===v.dataset_file_id);
    const folder=`versions/${file.external_key}/v${v.version_number}`;
    assert.equal(md5(await zip.file(`${folder}/segmentation.json`).async('string')),v.segmentation_md5);
    assert.equal(md5(await zip.file(`${folder}/breakpoints.json`).async('string')),v.breakpoints_md5);
  }
  console.log(`Project ZIP verified: ${polygonCount} separate polygons, ${versions.length} versions`);
  const item=imports.find(i=>i.image==='8964_01');
  const generated=versions.find(v=>v.dataset_file_id===item.fileId&&v.version_number===item.generatedVersion);
  const nativeBytes=Buffer.from(await(await read(`/api/files/${item.fileId}/versions/${generated.id}/export`)).arrayBuffer());
  await writeFile(path.join(backupDir,'8964-native-generated-version.zip'),nativeBytes);
  const nativeZip=await JSZip.loadAsync(nativeBytes);
  assert.equal(md5(await nativeZip.file('segmentation.json').async('string')),generated.segmentation_md5);
  const nativeIndex=JSON.parse(await nativeZip.file('polygons/index.json').async('string'));
  assert.equal(nativeIndex.polygons.length,1311);
  for(const entry of nativeIndex.polygons) for(const field of ['json','mask','boundary']) assert.ok(nativeZip.file(`polygons/${entry[field]}`));
  assert.equal(JSON.parse(await nativeZip.file('pixel-audit/audit.json').async('string')).differentPixels,0);
  await writeFile(path.join(backupDir,'drive-verification.json'),JSON.stringify({result:'PASS',report,pixelAudits,originalVersionsUnchanged:backup.annotation_versions.length,exportedVersions:versions.length,separatePolygons:polygonCount,zipBytes:bytes.length,nativeVersionZipBytes:nativeBytes.length},null,2));
  console.log(JSON.stringify({result:'PASS',files:report.length,separatePolygons:polygonCount,versions:versions.length,zipBytes:bytes.length}));
}finally{await sql.end();}

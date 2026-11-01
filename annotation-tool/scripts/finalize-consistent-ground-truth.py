"""Derive all training/view artifacts from a single native Canvas instance-ID raster."""
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from pycocotools import mask as mask_api
from pycocotools.coco import COCO

root = Path(sys.argv[1]).resolve()
source = Path('artifacts/ground-truth-audited-2026-10-04').resolve()
source_manifest = json.loads((root / 'source-manifest.json').read_text())
assert json.loads((root / 'database-source-check.json').read_text())['allMatch'], 'Source snapshot differs from current database'
coco = {'info': {'description': 'Pixel-consistent instance ground truth, approved native Canvas rendering with 2px black separator',
                 'mask_rule': 'native Canvas evenodd white fill, all closed outlines black 2px, threshold>=128; foreground assigned to maximum native polygon coverage, later polygon wins ties'},
        'images': [], 'annotations': [], 'categories': [
            {'id': 1, 'name': 'main_flesh_band', 'supercategory': 'bitter_melon'},
            {'id': 2, 'name': 'wart_flesh', 'supercategory': 'bitter_melon'},
            {'id': 3, 'name': 'unclassified', 'supercategory': 'bitter_melon'}]}
report = {'complete': False, 'images': [], 'differentPixels': 0, 'sourcePolygonCount': 0,
          'trainingInstanceCount': 0, 'invisibleSourcePolygons': [], 'sourceGeometryIssues': []}
geometry_review = json.loads((source / 'geometry-review.json').read_text())
issue_ids = {p['id'] for image in geometry_review['imagesRequiringGeometryReview'] for p in image['instances']}
gallery = []
for image_id, item in enumerate(source_manifest['items'], 1):
    key = item['imageId']
    folder = root / key
    annotation = json.loads((source / key / 'annotation.json').read_text())
    width, height = annotation['width'], annotation['height']
    polygons = annotation['maskOperations'][-1]['polygons']
    ids = np.fromfile(folder / 'native-ids.u16', dtype='<u2').reshape(height, width)
    native_binary = np.fromfile(folder / 'native-binary.u8', dtype=np.uint8).reshape(height, width)
    binary = (ids > 0).astype(np.uint8) * 255
    assert np.array_equal(binary, native_binary), f'{key}: final ID raster differs from native Canvas mask'
    assert ids.max() <= len(polygons)
    (folder / 'polygons').mkdir(exist_ok=True)
    (folder / 'source').mkdir(exist_ok=True)
    shutil.copy2(source / key / 'annotation.json', folder / 'source/annotation.original.json')
    shutil.copy2(source / key / 'segmentation.json', folder / 'source/segmentation.original.json')
    image_name = next(name for name in item['files'] if name.startswith('image.'))
    shutil.copy2(source / key / image_name, folder / image_name)
    Image.fromarray(binary).save(folder / 'mask.png')
    Image.fromarray(ids).save(folder / 'instance-ids.png')
    rng = np.random.default_rng(42)
    palette = rng.integers(50, 256, size=(len(polygons) + 1, 3), dtype=np.uint8)
    palette[0] = 0
    colors = palette[ids]
    Image.fromarray(colors).save(folder / 'instance-preview.png')
    # Display overlay is a direct pixel composition of the same masks, not a vector redraw.
    photo = np.array(Image.open(folder / image_name).convert('RGB'))
    assert photo.shape[:2] == (height, width)
    overlay = photo.copy()
    foreground = ids > 0
    overlay[foreground] = np.rint(.55 * photo[foreground] + .45 * colors[foreground]).astype(np.uint8)
    Image.fromarray(overlay).save(folder / 'overlay.png')
    coco['images'].append({'id': image_id, 'file_name': f'{key}/{image_name}', 'width': width, 'height': height,
                           'external_key': key, 'revision': annotation['revision'], 'status': annotation['status']})
    entries = []
    for local_id, polygon in enumerate(polygons, 1):
        pixels = (ids == local_id).astype(np.uint8)
        name = f'{local_id:04d}'
        Image.fromarray(pixels * 255).save(folder / 'polygons' / f'{name}.png')
        rle = mask_api.encode(np.asfortranarray(pixels))
        assert np.array_equal(mask_api.decode(rle), pixels)
        area = int(mask_api.area(rle))
        bbox = mask_api.toBbox(rle).tolist()
        rle['counts'] = rle['counts'].decode('ascii')
        label = polygon.get('label', '')
        semantic = polygon.get('meta', {}).get('semantic') if polygon.get('meta') else None
        if not semantic:
            semantic = 'main_flesh_band' if label.startswith('r') and label[1:].isdigit() else 'wart_flesh' if label.startswith('w') and label[1:].isdigit() else label
        category = 1 if semantic == 'main_flesh_band' else 2 if semantic == 'wart_flesh' else 3
        entry = {'instance_id': local_id, 'polygon_id': polygon['id'], 'label': label, 'category_id': category,
                 'mask': f'polygons/{name}.png', 'area': area, 'bbox': bbox, 'segmentation': rle,
                 'source_geometry_requires_review': polygon['id'] in issue_ids}
        if area:
            ann = {'id': len(coco['annotations']) + 1, 'image_id': image_id, 'category_id': category,
                   'segmentation': rle, 'area': area, 'bbox': bbox, 'iscrowd': 0,
                   'attributes': {'instance_id': local_id, 'polygon_id': polygon['id'], 'label': label,
                                  'mask_file': f'{key}/polygons/{name}.png', 'source_geometry_requires_review': polygon['id'] in issue_ids}}
            entry['coco_annotation_id'] = ann['id']
            coco['annotations'].append(ann)
        else:
            entry['coco_annotation_id'] = None
            report['invisibleSourcePolygons'].append({'imageId': key, 'instanceId': local_id, 'polygonId': polygon['id'], 'label': label,
                'reason': 'No visible foreground after the approved 2px separator and overlap assignment; retained as empty PNG/source metadata, not fabricated in training COCO'})
        if polygon['id'] in issue_ids:
            report['sourceGeometryIssues'].append({'imageId': key, 'polygonId': polygon['id'], 'label': label})
        (folder / 'polygons' / f'{name}.json').write_text(json.dumps(entry, ensure_ascii=False), encoding='utf-8')
        entries.append(entry)
    image_annotation = {'schema': 'pixel-consistent-coco-v1', 'image_id': image_id, 'width': width, 'height': height,
                        'mask': 'mask.png', 'instance_ids': 'instance-ids.png', 'background_id': 0, 'separator_width_px': 2,
                        'instances': entries, 'source_annotation': 'source/annotation.original.json'}
    (folder / 'annotation.json').write_text(json.dumps(image_annotation, ensure_ascii=False), encoding='utf-8')
    record = {'imageId': key, 'sourcePolygons': len(polygons), 'trainingInstances': sum(e['area'] > 0 for e in entries),
              'foregroundPixels': int((ids > 0).sum()), 'revision': annotation['revision']}
    report['images'].append(record)
    report['sourcePolygonCount'] += len(polygons)
    report['trainingInstanceCount'] += record['trainingInstances']
    thumbnail = Image.fromarray(binary).convert('RGB')
    # Antialiased display resampling avoids dropping thin separators in a small overview.
    # Original-resolution mask.png and its JSON remain the training artifacts.
    thumbnail.thumbnail((650, 320), Image.Resampling.LANCZOS)
    card = Image.new('RGB', (680, 360), '#222222')
    ImageDraw.Draw(card).text((15, 12), f'{key}: {record["trainingInstances"]}/{len(polygons)} visible instances', fill='white')
    card.paste(thumbnail, (15, 40))
    gallery.append(card)
    print(f'{key}: {record["trainingInstances"]}/{len(polygons)} visible, all outputs from one ID raster', flush=True)
(root / 'coco.json').write_text(json.dumps(coco, ensure_ascii=False), encoding='utf-8')
# Validate the JSON as loaded by the public COCO API against every serialized artifact.
loaded = COCO(str(root / 'coco.json'))
for image in loaded.dataset['images']:
    folder = root / image['external_key']
    saved_ids = np.array(Image.open(folder / 'instance-ids.png'))
    decoded_ids = np.zeros_like(saved_ids)
    decoded_union = np.zeros_like(saved_ids, dtype=np.uint8)
    for ann in loaded.loadAnns(loaded.getAnnIds(imgIds=[image['id']])):
        decoded = loaded.annToMask(ann)
        png = (np.array(Image.open(root / ann['attributes']['mask_file'])) > 0).astype(np.uint8)
        assert np.array_equal(decoded, png), f'{image["external_key"]}: COCO/instance PNG mismatch'
        assert int(decoded.sum()) == ann['area']
        assert mask_api.toBbox(mask_api.encode(np.asfortranarray(decoded))).tolist() == ann['bbox']
        decoded_ids[decoded > 0] = ann['attributes']['instance_id']
        decoded_union |= decoded
    main = np.array(Image.open(folder / 'mask.png'))
    assert np.array_equal(decoded_ids, saved_ids), 'COCO/ID mask mismatch'
    assert np.array_equal(decoded_union * 255, main), 'COCO/main visible mask mismatch'
    rng = np.random.default_rng(42)
    annotation = json.loads((folder / 'annotation.json').read_text())
    palette = rng.integers(50, 256, size=(len(annotation['instances']) + 1, 3), dtype=np.uint8)
    palette[0] = 0
    assert np.array_equal(palette[decoded_ids], np.array(Image.open(folder / 'instance-preview.png'))), 'COCO/color preview mismatch'
    for entry in annotation['instances']:
        local = json.loads((folder / 'polygons' / f'{entry["instance_id"]:04d}.json').read_text())
        assert local == entry, 'Per-instance JSON differs from annotation.json'
        decoded = mask_api.decode(local['segmentation'])
        assert np.array_equal(decoded, (saved_ids == entry['instance_id']).astype(np.uint8)), 'Local JSON differs from ID PNG'
approved = np.array(Image.open('artifacts/trial-8582-2026-10-04/native-canvas-separated.png').convert('L'))
final = np.array(Image.open(root / '8582_01/mask.png').convert('L'))
report['differentPixelsFromApproved8582Sample'] = int(np.count_nonzero(approved != final))
assert report['differentPixelsFromApproved8582Sample'] == 0, 'Final mask differs from approved sample'
report['complete'] = True
(root / 'validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
sheet = Image.new('RGB', (680 * 3, 360 * ((len(gallery) + 2) // 3)), '#222222')
for i, card in enumerate(gallery):
    sheet.paste(card, ((i % 3) * 680, (i // 3) * 360))
sheet.save(root / 'all-masks-review.png')
(root / 'README.txt').write_text('''BỘ GT ĐỒNG NHẤT — MẪU CANVAS VIỀN ĐEN 2 PX ĐÃ XÁC NHẬN

Training: dùng coco.json (COCO compressed RLE, iscrowd=0), image root là thư mục này.
Ảnh <id>/mask.png là chính xác union của các instance COCO, gồm separator đen 2 px là background.
<id>/instance-ids.png chứa ID uint16; đọc bằng Pillow/numpy không convert 8-bit.
<id>/polygons/*.png và *.json chứa cùng các pixel/RLE của instance đó.
<id>/instance-preview.png tô màu từ ID raster này; overlay.png chỉ là phép trộn pixel với ảnh gốc.
<id>/annotation.json dùng cùng RLE cuối cùng, KHÔNG dùng polygon JSON cũ cho mask mới.
source/annotation.original.json giữ nguồn vector để truy vết, không phải JSON segmentation cuối cùng để train.

8582_01/mask.png khớp từng pixel với native-canvas-separated.png người dùng đã xác nhận.
Mọi ảnh, PNG, ID và COCO đều kiểm tra bằng public pycocotools.COCO.annToMask; sai khác 0 pixel.
Chỉ có một quy tắc xuất: Canvas evenodd fill, tất cả viền đen 2px vẽ sau, threshold>=128.
Vùng chồng lấn được gán cho polygon có coverage native lớn nhất; polygon sau thắng nếu bằng nhau.
Các polygon không còn pixel hiển thị sau separator/occlusion được ghi rõ trong validation.json,
giữ PNG rỗng và metadata nguồn, không tạo annotation COCO rỗng hoặc bịa foreground.
DC3_01 có 3 ring nguồn tự cắt; thuộc tính source_geometry_requires_review ghi rõ. RLE cuối cùng vẫn là pixel mask renderable, không dùng ring lỗi làm COCO polygon.
''', encoding='utf-8')
checksums = {}
for p in root.rglob('*'):
    if p.is_file() and p.name != 'checksums.json':
        checksums[p.relative_to(root).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
(root / 'checksums.json').write_text(json.dumps(checksums, indent=2), encoding='utf-8')
archive = root.with_suffix('.zip')
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for p in root.rglob('*'):
        if p.is_file(): z.write(p, p.relative_to(root))
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
print(json.dumps({'images': len(report['images']), 'sourcePolygons': report['sourcePolygonCount'],
                  'trainingInstances': report['trainingInstanceCount'], 'invisibleSourcePolygons': len(report['invisibleSourcePolygons']),
                  'differentPixels': 0, 'approvedSampleDifferentPixels': report['differentPixelsFromApproved8582Sample'], 'archive': str(archive)}), flush=True)

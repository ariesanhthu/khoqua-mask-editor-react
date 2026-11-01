"""Validate every PNG against COCO's actual decoder, then publish compressed RLE.

Usage: python scripts/validate-ground-truth.py artifacts/ground-truth-YYYY-MM-DD
Requires numpy, Pillow, pycocotools.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from pycocotools.coco import COCO
from pycocotools import mask as mask_api


def validate(root):
    manifest = json.loads((root / 'download-manifest.json').read_text(encoding='utf-8'))
    if not manifest['complete'] or manifest['errors']:
        raise ValueError('Fetch incomplete; do not use a partial dataset as ground truth')
    for item in manifest['items']:
        for name, record in item['files'].items():
            data = (root / item['imageId'] / name).read_bytes()
            assert len(data) == record['bytes'] and hashlib.sha256(data).hexdigest() == record['sha256'], name
    coco = COCO(str(root / 'coco.json'))
    instance_paths = {}
    result = {'complete': False, 'images': [], 'instances': 0, 'differentPixels': 0, 'emptyInstances': []}
    for image in coco.dataset['images']:
        key = image['external_key']
        folder = root / key
        index = json.loads((folder / 'polygons/index.json').read_text())
        original = json.loads((folder / 'annotation.json').read_text())
        polygons = original['maskOperations'][-1]['polygons']
        annotations = coco.loadAnns(coco.getAnnIds(imgIds=[image['id']]))
        assert len(annotations) == len(index['polygons']) == len(polygons), key
        union = np.zeros((image['height'], image['width']), dtype=np.uint8)
        ids = np.zeros_like(union, dtype=np.uint32)
        for number, (annotation, entry, polygon) in enumerate(zip(annotations, index['polygons'], polygons), 1):
            instance_paths[annotation['id']] = folder / 'polygons' / entry['mask']
            assert annotation['attributes']['polygon_id'] == entry['id'] == polygon['id']
            saved_polygon = json.loads((folder / 'polygons' / entry['json']).read_text())['polygon']
            assert saved_polygon == polygon, 'Polygon coordinates/metadata changed'
            pixels = (np.array(Image.open(folder / 'polygons' / entry['mask']).convert('L')) > 0).astype(np.uint8)
            decoded = coco.annToMask(annotation)
            differences = int(np.count_nonzero(decoded != pixels))
            assert differences == 0, f'{key}/{entry["id"]}: {differences} wrong pixels'
            encoded = mask_api.encode(np.asfortranarray(pixels))
            assert int(mask_api.area(encoded)) == annotation['area']
            assert mask_api.toBbox(encoded).tolist() == annotation['bbox']
            assert np.array_equal(mask_api.decode(encoded), pixels)
            encoded['counts'] = encoded['counts'].decode('ascii')
            annotation['segmentation'] = encoded
            if annotation['area'] == 0:
                result['emptyInstances'].append({'image': key, 'polygon': entry['id'], 'label': polygon.get('label')})
            union |= pixels
            ids[pixels > 0] = number
            result['instances'] += 1
        union_path = folder / 'binary-union.png' if (folder / 'binary-union.png').exists() else folder / 'mask.png'
        actual_union = (np.array(Image.open(union_path).convert('L')) > 0).astype(np.uint8)
        assert np.array_equal(actual_union, union), f'{key}: binary union mismatch'
        rgb = np.array(Image.open(folder / 'polygons/instance-mask.png').convert('RGB'), dtype=np.uint32)
        actual_ids = rgb[:, :, 0] + 256 * rgb[:, :, 1] + 65536 * rgb[:, :, 2]
        assert np.array_equal(actual_ids, ids), f'{key}: instance ID mismatch'
        ids16 = folder / 'polygons/instance-ids-uint16.png'
        if ids16.exists():
            assert np.array_equal(np.array(Image.open(ids16)), ids), f'{key}: 16-bit instance IDs changed'
        audit = json.loads((folder / 'audit/audit.json').read_text())
        result['images'].append({'image': key, 'instances': len(annotations), 'foregroundPixels': int(union.sum()),
                                'differentPixelsFromSavedRaster': audit['differentPixels'], 'status': image['status']})
    output = root / 'coco-compressed.json'
    output.write_text(json.dumps(coco.dataset, ensure_ascii=False), encoding='utf-8')
    # Validate the serialized compressed file through the public COCO entry point again.
    compressed = COCO(str(output))
    for annotation in compressed.dataset['annotations']:
        pixels = (np.array(Image.open(instance_paths[annotation['id']]).convert('L')) > 0).astype(np.uint8)
        assert np.array_equal(compressed.annToMask(annotation), pixels), 'Serialized compressed COCO differs from PNG'
    result['complete'] = True
    result['cocoSha256'] = hashlib.sha256(output.read_bytes()).hexdigest()
    (root / 'validation.json').write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'images': len(result['images']), 'instances': result['instances'],
                      'differentPixels': result['differentPixels'], 'emptyInstances': result['emptyInstances']}))


if __name__ == '__main__':
    validate(Path(sys.argv[1]).resolve())

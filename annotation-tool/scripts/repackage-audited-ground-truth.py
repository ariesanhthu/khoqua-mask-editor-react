"""Create an explicitly named, audited bundle without overwriting the previous export."""
import hashlib
import json
import shutil
import sys
from pathlib import Path


source, audit, target = map(Path, sys.argv[1:4])
summary = json.loads((audit / 'audit-summary.json').read_text(encoding='utf-8'))
database = json.loads((audit / 'database-audit.json').read_text(encoding='utf-8'))
assert summary['complete'] and database['allMatch']
assert summary['differentInstancePixels'] == summary['differentUnionPixels'] == 0
assert not target.exists(), 'Use a fresh output directory'
shutil.copytree(source, target)
manifest = json.loads((target / 'download-manifest.json').read_text(encoding='utf-8'))
for item in manifest['items']:
    key = item['imageId']
    folder = target / key
    record = next(i for i in summary['images'] if i['imageId'] == key)
    (folder / 'mask.png').rename(folder / 'binary-union.png')
    filename = 'initial-prediction.png' if record['savedMaskActualSource'] == 'initial_prediction_fallback' else 'saved-raster.png'
    (folder / 'saved-mask.png').rename(folder / filename)
    shutil.copy2(audit / key / 'instance-ids-uint16.png', folder / 'polygons/instance-ids-uint16.png')
    shutil.copy2(audit / key / 'instance-colors.png', folder / 'polygons/instance-colors.png')
    shutil.copy2(audit / key / 'audit.json', folder / 'audit/independent-geometry.json')
    comparison = folder / 'audit/audit.json'
    value = json.loads(comparison.read_text())
    value.update(comparisonSource=record['savedMaskActualSource'], comparisonFile=filename)
    comparison.write_text(json.dumps(value, indent=2), encoding='utf-8')
    item['referenceSource'] = record['savedMaskActualSource']
    item['referenceFile'] = filename
    item['files'] = {}
    for p in folder.rglob('*'):
        if p.is_file():
            data = p.read_bytes()
            item['files'][p.relative_to(folder).as_posix()] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
shutil.copy2(audit / 'audit-summary.json', target / 'independent-geometry-audit.json')
shutil.copy2(audit / 'database-audit.json', target / 'database-audit.json')
review = {'geometryValidForAllInstances': summary['topologyIssues'] == 0, 'imagesRequiringGeometryReview': [],
          'note': 'No original geometry was repaired or modified. RLE preserves editor evenodd fill, including invalid vector rings.'}
for image in summary['images']:
    detail = json.loads((audit / image['imageId'] / 'audit.json').read_text(encoding='utf-8'))
    issues = [p for p in detail['instances'] if not p['topologyValid']]
    if issues:
        review['imagesRequiringGeometryReview'].append({'imageId': image['imageId'], 'instances': issues})
(target / 'geometry-review.json').write_text(json.dumps(review, indent=2, ensure_ascii=False), encoding='utf-8')
(target / 'download-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
(target / 'README.txt').write_text('''GROUND TRUTH AUDIT 2026-10-04

Use coco-compressed.json + independent polygons/*.png for lossless instance training.
polygons/instance-ids-uint16.png: exact one-channel IDs, background=0, ID lookup in instance-labels.json. Read without conversion to 8-bit/RGB.
polygons/instance-colors.png: display-only colored instance regions, no artificial outline gaps.
binary-union.png: binary foreground union; cannot retain internal instance boundaries.
polygons/vector-boundaries.png / .svg: continuous original closed outlines, display/boundary targets only.
initial-prediction.png: original model/init prediction, NOT the saved/current ground truth.
saved-raster.png: stored raster bytes only when maskStorageKey really exists.

Database JSON bytes match current database. Independent Python ray-parity coverage matches every exported polygon PNG and binary union exactly.
DC3_01 has 3 self-intersecting source rings: r1, w29, w66. See geometry-review.json; vector topology is NOT certified valid for this image.
8769_01/w159 is a 1-pixel instance fully covered by a later polygon in a flattened ID map; COCO and its independent PNG preserve it.
Repeated label names are not deduplicated: polygon IDs are distinct.
Overlaps cannot be encoded losslessly in a single per-pixel ID PNG. COCO and independent instance PNGs retain them.
No polygon vertices were moved, smoothed, repaired, merged, or deleted.
''', encoding='utf-8')
print(target)

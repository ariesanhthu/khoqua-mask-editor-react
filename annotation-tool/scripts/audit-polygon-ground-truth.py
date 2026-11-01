"""Independent geometry audit: classify pixel centers directly using ray parity.

Does not import the export rasterizer or use COCO to establish geometric coverage.
Shapely reports topology problems separately; invalid coordinates are never repaired.
"""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.geometry import Polygon
from shapely.validation import explain_validity


def classify_polygon(polygon, width, height):
    rings = [polygon['nodes'], *polygon.get('holes', [])]
    all_points = [(p['x'], p['y']) for ring in rings for p in ring]
    assert all(len(ring) >= 3 for ring in rings), 'Ring has fewer than three nodes'
    points = np.asarray(all_points, dtype=np.float64)
    assert np.isfinite(points).all(), 'Non-finite coordinate'
    left = max(0, int(np.ceil(points[:, 0].min() - .5)))
    right = min(width, int(np.ceil(points[:, 0].max() - .5)))
    top = max(0, int(np.ceil(points[:, 1].min() - .5)))
    bottom = min(height, int(np.ceil(points[:, 1].max() - .5)))
    result = np.zeros((height, width), dtype=bool)
    if right <= left or bottom <= top:
        return result
    # Each point independently toggles parity whenever its horizontal ray crosses an edge.
    # Unlike the TS scanline code, no intersections are sorted or paired and no spans filled.
    xs = np.arange(left, right, dtype=np.float64)[None, :] + .5
    ys = np.arange(top, bottom, dtype=np.float64) + .5
    local = np.zeros((bottom - top, right - left), dtype=bool)
    for ring in rings:
        for a, b in zip(ring, [*ring[1:], ring[0]]):
            rows = np.flatnonzero((a['y'] > ys) != (b['y'] > ys))
            if not len(rows):
                continue
            intersections = a['x'] + (ys[rows] - a['y']) * (b['x'] - a['x']) / (b['y'] - a['y'])
            local[rows] ^= xs < intersections[:, None]
    result[top:bottom, left:right] = local
    return result


def audit(root, output):
    output.mkdir(parents=True, exist_ok=False)
    manifest = json.loads((root / 'download-manifest.json').read_text(encoding='utf-8'))
    report = {'source': str(root.resolve()), 'method': 'Independent per-pixel ray parity at original pixel centers, evenodd per polygon',
              'complete': False, 'images': [], 'differentInstancePixels': 0, 'differentUnionPixels': 0, 'topologyIssues': 0}
    for item in manifest['items']:
        key = item['imageId']
        folder = root / key
        annotation_bytes = (folder / 'annotation.json').read_bytes()
        annotation = json.loads(annotation_bytes)
        width, height = annotation['width'], annotation['height']
        polygons = annotation['maskOperations'][-1]['polygons']
        index = json.loads((folder / 'polygons/index.json').read_text())['polygons']
        assert len(index) == len(polygons)
        union = np.zeros((height, width), dtype=bool)
        count = np.zeros((height, width), dtype=np.uint16)
        id_map = np.zeros((height, width), dtype=np.uint16)
        details = []
        for number, (polygon, entry) in enumerate(zip(polygons, index), 1):
            assert polygon['id'] == entry['id']
            independent = classify_polygon(polygon, width, height)
            exported = np.asarray(Image.open(folder / 'polygons' / entry['mask']).convert('L')) > 0
            different = int(np.count_nonzero(independent != exported))
            report['differentInstancePixels'] += different
            exterior = [(p['x'], p['y']) for p in polygon['nodes']]
            holes = [[(p['x'], p['y']) for p in ring] for ring in polygon.get('holes', [])]
            geometry = Polygon(exterior, holes)
            reason = explain_validity(geometry)
            report['topologyIssues'] += int(not geometry.is_valid)
            details.append({'id': polygon['id'], 'label': polygon.get('label'), 'areaPixels': int(independent.sum()),
                            'differentPixels': different, 'topologyValid': bool(geometry.is_valid), 'topologyReason': reason,
                            'vertices': len(exterior), 'holes': len(holes), 'outOfBoundsVertices': sum(x < 0 or y < 0 or x > width or y > height for x, y in exterior),
                            'rasterPath': f"polygons/{entry['mask']}"})
            union |= independent
            count += independent
            id_map[independent] = number
        union_path = folder / 'binary-union.png' if (folder / 'binary-union.png').exists() else folder / 'mask.png'
        exported_union = np.asarray(Image.open(union_path).convert('L')) > 0
        different_union = int(np.count_nonzero(exported_union != union))
        report['differentUnionPixels'] += different_union
        # How much of each instance survives a single last-wins ID image?
        for number, detail in enumerate(details, 1):
            visible = int(np.count_nonzero(id_map == number))
            detail['visiblePixelsInLastWinsIdMask'] = visible
            detail['overwrittenPixelsInLastWinsIdMask'] = detail['areaPixels'] - visible
        record = {'imageId': key, 'revision': annotation['revision'], 'polygons': len(polygons),
                  'annotationSha256': hashlib.sha256(annotation_bytes).hexdigest(),
                  'hasSavedRasterReference': bool(annotation['segmentation'].get('maskStorageKey')),
                  'savedMaskActualSource': 'stored_raster' if annotation['segmentation'].get('maskStorageKey') else 'initial_prediction_fallback',
                  'differentUnionPixels': different_union, 'unionAreaPixels': int(union.sum()),
                  'overlapPixels': int(np.count_nonzero(count > 1)), 'maxOverlap': int(count.max()),
                  'duplicatePolygonIds': [v for v, n in Counter(p['id'] for p in polygons).items() if n > 1],
                  'duplicateLabels': {v: n for v, n in Counter(p.get('label') for p in polygons).items() if n > 1},
                  'instances': details}
        target = output / key
        target.mkdir()
        Image.fromarray(union.astype(np.uint8) * 255).save(target / 'independent-binary-union.png')
        Image.fromarray(id_map).save(target / 'instance-ids-uint16.png')
        # ID transitions show complete instance adjacency without inventing a background gap.
        rng = np.random.default_rng(42)
        colors = rng.integers(50, 256, size=(len(polygons) + 1, 3), dtype=np.uint8)
        colors[0] = 0
        Image.fromarray(colors[id_map]).save(target / 'instance-colors.png')
        (target / 'audit.json').write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding='utf-8')
        report['images'].append({k: v for k, v in record.items() if k != 'instances'})
        print(f'{key}: {len(polygons)} instances, independent union diff={different_union}, invalid topology={sum(not d["topologyValid"] for d in details)}, saved raster source={record["savedMaskActualSource"]}', flush=True)
    report['complete'] = True
    (output / 'audit-summary.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'images'}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    audit(args.source, args.output)

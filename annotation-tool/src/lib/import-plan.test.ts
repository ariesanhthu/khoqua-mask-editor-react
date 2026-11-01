import { describe, expect, it } from 'vitest';
import { isPlanJsonCandidate, planCocoImport, planDefaultImport, summarizePlan, type ImportEntry } from './import-plan';

const entries = (...paths: string[]): ImportEntry<string>[] => paths.map((path) => ({ path, file: path }));

describe('default (manifest) folder import', () => {
  it('splits one manifest per variety folder into one group each', () => {
    const files = entries(
      'khoqua/8582/manifest.json', 'khoqua/8582/images/8582_01.jpg', 'khoqua/8582/predictions/8582_01.png', 'khoqua/8582/prelabels/8582_01.json',
      'khoqua/DC3/manifest.json', 'khoqua/DC3/images/DC3_01.jpg', 'khoqua/DC3/predictions/DC3_01.png',
    );
    const plan = planDefaultImport(files, [
      { path: 'khoqua/8582/manifest.json', value: { items: [{ id: '8582_01', image: 'images/8582_01.jpg', prediction: 'predictions/8582_01.png', prelabel: 'prelabels/8582_01.json' }] } },
      { path: 'khoqua/DC3/manifest.json', value: { items: [{ id: 'DC3_01', image: 'images/DC3_01.jpg', prediction: 'predictions/DC3_01.png' }] } },
    ], 'folder');
    expect(plan.rootName).toBe('khoqua');
    expect(plan.warnings).toEqual([]);
    expect(plan.items).toEqual([
      { externalKey: '8582_01', group: '8582', imagePath: '8582/images/8582_01.jpg', image: 'khoqua/8582/images/8582_01.jpg',
        prediction: 'khoqua/8582/predictions/8582_01.png', prelabel: 'khoqua/8582/prelabels/8582_01.json' },
      { externalKey: 'DC3_01', group: 'DC3', imagePath: 'DC3/images/DC3_01.jpg', image: 'khoqua/DC3/images/DC3_01.jpg',
        prediction: 'khoqua/DC3/predictions/DC3_01.png', prelabel: undefined },
    ]);
  });

  it('keeps the existing flat production layout as one group, or groups it by name prefix on request', () => {
    const files = entries('prelabel-production/manifest.json', 'prelabel-production/images/8582_01.jpg', 'prelabel-production/predictions/8582_01.png',
      'prelabel-production/images/DC3_01.jpg', 'prelabel-production/predictions/DC3_01.png');
    const manifest = { path: 'prelabel-production/manifest.json', value: { items: [
      { id: '8582_01', image: 'images/8582_01.jpg', prediction: 'predictions/8582_01.png' },
      { id: 'DC3_01', image: 'images/DC3_01.jpg', prediction: 'predictions/DC3_01.png' },
    ] } };
    expect(summarizePlan(planDefaultImport(files, [manifest], 'folder'))).toEqual([{ name: 'prelabel-production', count: 2 }]);
    expect(summarizePlan(planDefaultImport(files, [manifest], 'prefix'))).toEqual([{ name: '8582', count: 1 }, { name: 'DC3', count: 1 }]);
  });

  it('reports missing assets and unsafe paths instead of importing a partial item', () => {
    const files = entries('root/manifest.json', 'root/images/a.jpg', 'root/predictions/a.png', 'root/images/b.jpg');
    const plan = planDefaultImport(files, [{ path: 'root/manifest.json', value: { items: [
      { id: 'a', image: 'images/a.jpg', prediction: 'predictions/a.png', prelabel: 'prelabels/a.json' },
      { id: 'b', image: 'images/b.jpg', prediction: 'predictions/b.png' },
      { id: 'c', image: '../outside.jpg', prediction: 'predictions/a.png' },
      { id: 'd', image: 'images/a.jpg' },
    ] } }], 'folder');
    expect(plan.items).toEqual([]);
    expect(plan.warnings).toHaveLength(4);
    expect(planDefaultImport(files, [], 'folder').warnings[0]).toMatch(/manifest\.json/);
  });

  it('prefixes keys that repeat across groups and skips exact duplicates', () => {
    const files = entries('k/A/manifest.json', 'k/A/01.jpg', 'k/A/01.png', 'k/B/manifest.json', 'k/B/01.jpg', 'k/B/01.png');
    const item = { id: '01', image: '01.jpg', prediction: '01.png' };
    const plan = planDefaultImport(files, [
      { path: 'k/A/manifest.json', value: { items: [item, item] } },
      { path: 'k/B/manifest.json', value: { items: [item] } },
    ], 'folder');
    expect(plan.items.map((entry) => [entry.group, entry.externalKey])).toEqual([['A', 'A_01'], ['B', 'B_01']]);
    expect(plan.warnings.some((warning) => /trùng tên ảnh "A_01"/.test(warning))).toBe(true);
  });
});

describe('COCO 1.0 folder import', () => {
  const coco = (fileNames: string[]) => ({
    images: fileNames.map((file_name, index) => ({ id: index + 1, file_name, width: 4, height: 3 })),
    annotations: [],
    categories: [{ id: 1, name: 'wart' }],
  });

  it('resolves CVAT exports per variety (annotations/ + images/default/) into variety groups', () => {
    const files = entries(
      'khoqua/8582/annotations/instances_default.json', 'khoqua/8582/images/default/8582_01.jpg',
      'khoqua/DC3/annotations/instances_default.json', 'khoqua/DC3/images/default/DC3_01.JPG',
    );
    const plan = planCocoImport(files, [
      { path: 'khoqua/8582/annotations/instances_default.json', value: coco(['8582_01.jpg']) },
      { path: 'khoqua/DC3/annotations/instances_default.json', value: coco(['DC3_01.JPG']) },
    ], 'folder');
    expect(plan.warnings).toEqual([]);
    expect(plan.cocoSets).toHaveLength(2);
    expect(plan.items.map(({ externalKey, group, imagePath, coco: source }) => ({ externalKey, group, imagePath, source }))).toEqual([
      { externalKey: '8582_01', group: '8582', imagePath: '8582/images/default/8582_01.jpg', source: { setIndex: 0, imageId: '1', width: 4, height: 3 } },
      { externalKey: 'DC3_01', group: 'DC3', imagePath: 'DC3/images/default/DC3_01.JPG', source: { setIndex: 1, imageId: '1', width: 4, height: 3 } },
    ]);
  });

  it('uses folders inside file_name for one COCO file covering every variety', () => {
    const files = entries('k/annotations/instances.json', 'k/images/8582/8582_01.jpg', 'k/images/VIN005/VIN005_01.jpg');
    const plan = planCocoImport(files, [{ path: 'k/annotations/instances.json', value: coco(['8582/8582_01.jpg', 'VIN005/VIN005_01.jpg']) }], 'folder');
    expect(plan.items.map((item) => [item.group, item.externalKey])).toEqual([['8582', '8582_01'], ['VIN005', 'VIN005_01']]);
  });

  it('warns about missing, ambiguous or dimensionless images and ignores non-COCO JSON', () => {
    const files = entries('k/annotations/a.json', 'k/x/dup.jpg', 'k/y/dup.jpg');
    const dataset = coco(['missing.jpg', 'dup.jpg']);
    dataset.images.push({ id: 9, file_name: 'nosize.jpg', width: 0, height: 3 });
    const plan = planCocoImport(files, [{ path: 'k/annotations/a.json', value: dataset }, { path: 'k/annotations/other.json', value: { items: [] } }], 'folder');
    expect(plan.items).toEqual([]);
    expect(plan.cocoSets).toHaveLength(1);
    expect(plan.warnings).toHaveLength(3);
    expect(planCocoImport(files, [], 'folder').warnings[0]).toMatch(/COCO/);
  });
});

describe('which JSON files are read for planning', () => {
  it('reads only manifests for the default format and only annotation files for COCO', () => {
    expect(isPlanJsonCandidate('k/8582/manifest.json', 'default')).toBe(true);
    expect(isPlanJsonCandidate('k/8582/prelabels/8582_01.json', 'default')).toBe(false);
    expect(isPlanJsonCandidate('k/8582/annotations/instances_default.json', 'coco')).toBe(true);
    expect(isPlanJsonCandidate('k/coco.json', 'coco')).toBe(true);
    expect(isPlanJsonCandidate('k/8582/prelabels/8582_01.json', 'coco')).toBe(false);
  });
});

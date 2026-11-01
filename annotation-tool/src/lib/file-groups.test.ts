import { describe, expect, it } from 'vitest';
import { groupFromRelativePath, inferGroupName, isValidExternalKey, isValidGroupName, normalizeGroupName } from './file-groups';

describe('group of an uploaded image', () => {
  it('uses the variety folder directly under the selected root', () => {
    expect(groupFromRelativePath('8582/8582_01.jpg', 'khoqua')).toBe('8582');
    expect(groupFromRelativePath('TVI8573/batch-2/TVI8573_04.jpg', 'khoqua')).toBe('TVI8573');
  });

  it('skips dataset structure folders of the default and COCO/CVAT layouts', () => {
    expect(groupFromRelativePath('8582/images/8582_01.jpg', 'khoqua')).toBe('8582');
    expect(groupFromRelativePath('images/8582/8582_01.jpg', 'khoqua')).toBe('8582');
    expect(groupFromRelativePath('DC3/images/default/DC3_01.jpg', 'khoqua')).toBe('DC3');
    expect(groupFromRelativePath('Images/Default/x.jpg', 'khoqua')).toBe('khoqua');
  });

  it('puts images outside any variety folder into a group named after the root', () => {
    expect(groupFromRelativePath('8582_01.jpg', 'khoqua')).toBe('khoqua');
    expect(groupFromRelativePath('images/8582_01.jpg', 'prelabel-production')).toBe('prelabel-production');
  });
});

describe('group inferred from the image name', () => {
  it('drops the trailing sequence number of the dataset naming convention', () => {
    expect(inferGroupName('8582_01')).toBe('8582');
    expect(inferGroupName('TVI8573_12')).toBe('TVI8573');
    expect(inferGroupName('VIN005_20')).toBe('VIN005');
    expect(inferGroupName('Draco-3')).toBe('Draco');
    expect(inferGroupName('TVI_8573_01')).toBe('TVI_8573');
    expect(inferGroupName('8582_01_crop')).toBe('8582');
  });

  it('returns null instead of guessing when there is no separator', () => {
    expect(inferGroupName('sample')).toBeNull();
    expect(inferGroupName('_01')).toBeNull();
  });
});

describe('name validation', () => {
  it('rejects keys that would become paths in ZIP/Drive exports', () => {
    expect(isValidExternalKey('8582_01')).toBe(true);
    for (const key of ['', ' 8582', 'a/b', 'a\\b', '..', 'x\u0000', 'a'.repeat(201)]) expect(isValidExternalKey(key)).toBe(false);
  });

  it('normalizes whitespace in group names and rejects empty or control characters', () => {
    expect(normalizeGroupName('  Giống   8582 ')).toBe('Giống 8582');
    expect(isValidGroupName('Giống 8582')).toBe(true);
    expect(isValidGroupName('   ')).toBe(false);
    expect(isValidGroupName('a\u0007b')).toBe(false);
  });
});

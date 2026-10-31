import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ asset: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./drive-service', () => ({ fetchDatasetAsset: mocks.asset }));
import { loadPrelabelOperations } from './prelabel-service';

const nodes = [
  { id: 'a', x: 0, y: 0 },
  { id: 'b', x: 10, y: 0 },
  { id: 'c', x: 10, y: 8 },
];
const polygon = (label: string) => ({ id: 'polygon', label, nodes, meta: { source: 'model', wartId: 3 } });
const payload = (schemaVersion = 'bitter-melon-prelabel-1.1', label = 'w3') => ({
  schemaVersion, coordinateSpace: 'image_pixels', width: 10, height: 8,
  maskOperations: [{ type: 'POLYGON_SET', polygons: [polygon(label)] }],
});
function asset(value: unknown) {
  mocks.asset.mockResolvedValue(new TextEncoder().encode(JSON.stringify(value)));
}
const load = () => loadPrelabelOperations('blob:datasets/prelabels/image.json', 10, 8);

beforeEach(() => { vi.clearAllMocks(); });

describe('prelabel schema compatibility', () => {
  it.each(['main_flesh_band', 'wart_flesh'])('keeps existing 1.0 labels and geometry: %s', async (label) => {
    const original = payload('bitter-melon-prelabel-1.0', label);
    asset(original);
    expect(await load()).toEqual(original.maskOperations);
  });

  it.each(['r1', 'w3'])('opens 1.1 instance labels without changing their identity: %s', async (label) => {
    const original = payload('bitter-melon-prelabel-1.1', label);
    asset(original);
    expect(await load()).toEqual(original.maskOperations);
  });

  it('accepts instance labels in a 1.0 envelope', async () => {
    const original = payload('bitter-melon-prelabel-1.0', 'w3');
    asset(original);
    expect(await load()).toEqual(original.maskOperations);
  });

  it('preserves additional polygon fields including interior rings', async () => {
    const original = payload();
    const hole = [{ id: 'h1', x: 7, y: 1 }, { id: 'h2', x: 8, y: 1 }, { id: 'h3', x: 8, y: 2 }];
    Object.assign(original.maskOperations[0].polygons[0], { holes: [hole], note: 'preserve' });
    asset(original);
    expect(await load()).toEqual(original.maskOperations);
  });

  it.each([
    ['unknown schema', { ...payload(), schemaVersion: 'other-format-2.0' }],
    ['wrong dimensions', { ...payload(), width: 11 }],
    ['wrong coordinate space', { ...payload(), coordinateSpace: 'normalized' }],
    ['missing operation', { ...payload(), maskOperations: [] }],
    ['null operation', { ...payload(), maskOperations: [null] }],
    ['null polygon', { ...payload(), maskOperations: [{ type: 'POLYGON_SET', polygons: [null] }] }],
    ['unsupported label', payload('bitter-melon-prelabel-1.1', 'w0')],
    ['null document', null],
  ])('rejects %s with a prelabel validation error', async (_name, value) => {
    asset(value);
    await expect(load()).rejects.toMatchObject({ name: 'PrelabelValidationError' });
  });

  it.each([
    [{ id: 'a', x: -1, y: 1 }, ...nodes.slice(1)],
    [{ id: 'a', x: 1, y: 9 }, ...nodes.slice(1)],
    [{ id: 'b', x: 1, y: 1 }, ...nodes.slice(1)],
  ])('rejects invalid or duplicate node coordinates/IDs', async (...invalidNodes) => {
    const original = payload();
    original.maskOperations[0].polygons[0].nodes = invalidNodes;
    asset(original);
    await expect(load()).rejects.toMatchObject({ name: 'PrelabelValidationError' });
  });

  it('validates interior rings instead of silently accepting invalid geometry', async () => {
    const original = payload();
    Object.assign(original.maskOperations[0].polygons[0], { holes: [[{ id: 'h', x: 1, y: 1 }]] });
    asset(original);
    await expect(load()).rejects.toMatchObject({ name: 'PrelabelValidationError' });
  });

  it('classifies malformed JSON as invalid prelabel data', async () => {
    mocks.asset.mockResolvedValue(new TextEncoder().encode('{broken'));
    await expect(load()).rejects.toMatchObject({ name: 'PrelabelValidationError' });
  });

  it('does not misclassify a storage outage as invalid annotation data', async () => {
    const outage = new Error('Storage unavailable');
    mocks.asset.mockRejectedValue(outage);
    await expect(load()).rejects.toBe(outage);
  });
});

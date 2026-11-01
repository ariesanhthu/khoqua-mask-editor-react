import type { MaskOperation } from '@/types';

const xml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Export original vector coordinates, IDs, labels and holes without raster conversion. */
export function annotationSvg(operations: MaskOperation[], width: number, height: number, imageDataUrl?: string): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw Error('Invalid SVG size');
  const operation = [...operations].reverse().find((op) => op.type === 'POLYGON_SET');
  const paths = operation?.type === 'POLYGON_SET' ? operation.polygons.map((polygon) => {
    const rings = [polygon.nodes, ...(polygon.holes ?? [])];
    const d = rings.map((ring) => ring.map((node, i) => {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) throw Error('Invalid vector coordinate');
      return `${i ? 'L' : 'M'}${node.x},${node.y}`;
    }).join(' ') + ' Z').join(' ');
    return `<path id="${xml(polygon.id)}" data-label="${xml(polygon.label || '')}" d="${d}" fill="#7c5cfa" fill-opacity="0.25" fill-rule="evenodd" stroke="#7c5cfa" stroke-width="0.7" vector-effect="non-scaling-stroke"><title>${xml(polygon.label || polygon.id)}</title></path>`;
  }).join('') : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${imageDataUrl ? `<image href="${xml(imageDataUrl)}" width="${width}" height="${height}"/>` : ''}${paths}</svg>`;
}

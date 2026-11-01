import type { AnnotationPolygon, AnnotationPolygonMeta, PolygonNode } from '../types/index';

/**
 * Polygon geometry in transferable typed arrays for worker messages. Structured clone of nested
 * node objects (with long string ids) cost hundreds of milliseconds on the main thread for a full
 * vector result; typed arrays are transferred in O(1).
 */
export interface PackedGeometry {
  /** Rings per polygon (1 outer + holes). */
  ringCounts: Uint32Array;
  /** Nodes per ring, in polygon order. */
  ringLengths: Uint32Array;
  /** x, y of every node. */
  coords: Float64Array;
}

export interface PackedPolygons extends PackedGeometry {
  ids: string[];
  labels: string[];
  /** 1 when the polygon had a `holes` array (possibly empty), so unpacking restores the same shape. */
  hasHoles: Uint8Array;
  /** Only present when some node id does not follow `${polygonId}-${outer|holeN}-${index}`. */
  nodeIds?: string[];
  /** Only present when some polygon carries meta. */
  metas?: Array<AnnotationPolygonMeta | undefined>;
}

const ringSuffix = (ring: number) => (ring === 0 ? 'outer' : `hole${ring - 1}`);

export function packGeometry(polygons: AnnotationPolygon[]): PackedGeometry {
  let ringTotal = 0; let nodeTotal = 0;
  for (const polygon of polygons) {
    ringTotal += 1 + (polygon.holes?.length ?? 0);
    nodeTotal += polygon.nodes.length;
    for (const hole of polygon.holes ?? []) nodeTotal += hole.length;
  }
  const ringCounts = new Uint32Array(polygons.length);
  const ringLengths = new Uint32Array(ringTotal);
  const coords = new Float64Array(nodeTotal * 2);
  let ringIndex = 0; let offset = 0;
  polygons.forEach((polygon, index) => {
    const rings = [polygon.nodes, ...(polygon.holes ?? [])];
    ringCounts[index] = rings.length;
    for (const ring of rings) {
      ringLengths[ringIndex++] = ring.length;
      for (const node of ring) { coords[offset++] = node.x; coords[offset++] = node.y; }
    }
  });
  return { ringCounts, ringLengths, coords };
}

/** Rings as plain point arrays; enough for rasterization (ids are not needed there). */
export function unpackGeometry(packed: PackedGeometry): AnnotationPolygon[] {
  const polygons: AnnotationPolygon[] = [];
  let ringIndex = 0; let offset = 0;
  for (let index = 0; index < packed.ringCounts.length; index += 1) {
    const rings: PolygonNode[][] = [];
    for (let ring = 0; ring < packed.ringCounts[index]; ring += 1) {
      const length = packed.ringLengths[ringIndex++];
      const nodes: PolygonNode[] = new Array(length);
      for (let i = 0; i < length; i += 1) { nodes[i] = { id: '', x: packed.coords[offset], y: packed.coords[offset + 1] }; offset += 2; }
      rings.push(nodes);
    }
    polygons.push({ id: '', label: '', nodes: rings[0] ?? [], holes: rings.slice(1) });
  }
  return polygons;
}

export function packPolygons(polygons: AnnotationPolygon[]): PackedPolygons {
  const geometry = packGeometry(polygons);
  const hasHoles = new Uint8Array(polygons.length);
  let regularIds = true;
  let anyMeta = false;
  polygons.forEach((polygon, index) => {
    hasHoles[index] = polygon.holes ? 1 : 0;
    if (polygon.meta !== undefined) anyMeta = true;
    if (!regularIds) return;
    [polygon.nodes, ...(polygon.holes ?? [])].forEach((ring, ringIndex) => {
      const prefix = `${polygon.id}-${ringSuffix(ringIndex)}-`;
      if (ring.some((node, i) => node.id !== prefix + i)) regularIds = false;
    });
  });
  return {
    ...geometry,
    ids: polygons.map((polygon) => polygon.id),
    labels: polygons.map((polygon) => polygon.label),
    hasHoles,
    ...(regularIds ? {} : { nodeIds: polygons.flatMap((polygon) => [polygon.nodes, ...(polygon.holes ?? [])].flat().map((node) => node.id)) }),
    ...(anyMeta ? { metas: polygons.map((polygon) => polygon.meta) } : {}),
  };
}

export function unpackPolygons(packed: PackedPolygons): AnnotationPolygon[] {
  const polygons: AnnotationPolygon[] = [];
  let ringIndex = 0; let offset = 0; let nodeIndex = 0;
  for (let index = 0; index < packed.ids.length; index += 1) {
    const id = packed.ids[index];
    const rings: PolygonNode[][] = [];
    for (let ring = 0; ring < packed.ringCounts[index]; ring += 1) {
      const length = packed.ringLengths[ringIndex++];
      const prefix = `${id}-${ringSuffix(ring)}-`;
      const nodes: PolygonNode[] = new Array(length);
      for (let i = 0; i < length; i += 1) {
        // Same key order as the vectorizer ({ x, y, id }), so saved JSON is byte-identical.
        nodes[i] = { x: packed.coords[offset], y: packed.coords[offset + 1], id: packed.nodeIds ? packed.nodeIds[nodeIndex] : prefix + i };
        offset += 2; nodeIndex += 1;
      }
      rings.push(nodes);
    }
    const polygon: AnnotationPolygon = { id, label: packed.labels[index], nodes: rings[0] ?? [] };
    if (packed.hasHoles[index]) polygon.holes = rings.slice(1);
    const meta = packed.metas?.[index];
    if (meta !== undefined) polygon.meta = meta;
    polygons.push(polygon);
  }
  return polygons;
}

/** Buffers to pass as the transfer list of `postMessage`. */
export function packedTransfer(packed: PackedGeometry & { hasHoles?: Uint8Array }): ArrayBuffer[] {
  return [packed.ringCounts.buffer, packed.ringLengths.buffer, packed.coords.buffer, ...(packed.hasHoles ? [packed.hasHoles.buffer] : [])] as ArrayBuffer[];
}

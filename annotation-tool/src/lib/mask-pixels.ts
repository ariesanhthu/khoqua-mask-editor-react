import type { AnnotationPolygon, PolygonNode } from '../types/index';

type Point = { x: number; y: number };
/** Pixel rectangle; `right`/`bottom` are exclusive. */
export type PixelBounds = { left: number; top: number; right: number; bottom: number };
/** Inclusive pixel indices of a traced component. */
type ComponentBounds = PixelBounds;

function dimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 100_000_000) {
    throw new Error('Invalid mask dimensions');
  }
}

/**
 * Scanline core of the pixel-center rule (evenodd per polygon, no antialiasing). Calls
 * `emit(y, start, end)` for every covered run `[start, end)` of row `y` that lies inside `rect`.
 * Crossings are computed for whole rows, so clipping to `rect` never changes evenodd pairing:
 * the runs are exactly the full-image runs cut to the rectangle.
 */
export function forEachPolygonSpan(
  polygons: AnnotationPolygon[],
  rect: PixelBounds,
  emit: (y: number, start: number, end: number) => void,
) {
  for (const polygon of polygons) {
    const rings = [polygon.nodes, ...(polygon.holes ?? [])];
    const crossings = new Map<number, number[]>();
    for (const ring of rings) {
      if (ring.length < 3) throw new Error('Polygon ring needs at least three nodes');
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i]; const b = ring[(i + 1) % ring.length];
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
          throw new Error('Invalid polygon coordinates');
        }
        if (a.y === b.y) continue;
        const from = Math.max(rect.top, Math.ceil(Math.min(a.y, b.y) - 0.5));
        const to = Math.min(rect.bottom, Math.ceil(Math.max(a.y, b.y) - 0.5));
        for (let y = from; y < to; y += 1) {
          const x = a.x + (y + 0.5 - a.y) * (b.x - a.x) / (b.y - a.y);
          const row = crossings.get(y);
          if (row) row.push(x); else crossings.set(y, [x]);
        }
      }
    }
    for (const [y, row] of crossings) {
      row.sort((a, b) => a - b);
      for (let i = 0; i + 1 < row.length; i += 2) {
        const start = Math.max(rect.left, Math.ceil(row[i] - 0.5));
        const end = Math.min(rect.right, Math.ceil(row[i + 1] - 0.5));
        if (start < end) emit(y, start, end);
      }
    }
  }
}

/** Binary coverage at pixel centers, without antialiasing, resizing or strokes. */
export function rasterizePolygons(polygons: AnnotationPolygon[], width: number, height: number): Uint8Array {
  dimensions(width, height);
  const pixels = new Uint8Array(width * height);
  forEachPolygonSpan(polygons, { left: 0, top: 0, right: width, bottom: height }, (y, start, end) => {
    pixels.fill(255, y * width + start, y * width + end);
  });
  return pixels;
}

/**
 * Smallest pixel rectangle that can contain covered pixel centers (clamped to the image), or null.
 * A run starts at ceil(x - 0.5) of a crossing ≥ min x and ends before ceil(x - 0.5) of one ≤ max x.
 */
export function polygonPixelRect(polygons: AnnotationPolygon[], width: number, height: number): PixelBounds | null {
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const polygon of polygons) {
    for (const ring of [polygon.nodes, ...(polygon.holes ?? [])]) {
      for (const node of ring) {
        if (node.x < minX) minX = node.x; if (node.x > maxX) maxX = node.x;
        if (node.y < minY) minY = node.y; if (node.y > maxY) maxY = node.y;
      }
    }
  }
  const left = Math.max(0, Math.ceil(minX - 0.5)); const right = Math.min(width, Math.ceil(maxX - 0.5));
  const top = Math.max(0, Math.ceil(minY - 0.5)); const bottom = Math.min(height, Math.ceil(maxY - 0.5));
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Thresholds decoded mask RGBA in place: visible (alpha > 0 and brightest channel > 96) becomes opaque
 * white, the rest transparent white. Word-at-a-time on little-endian hosts (every browser in practice).
 */
export function normalizeMaskRgba(data: Uint8ClampedArray) {
  if (littleEndian && data.byteOffset % 4 === 0) {
    const words = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
    for (let index = 0; index < words.length; index += 1) {
      const value = words[index];
      const red = value & 0xff; const green = (value >>> 8) & 0xff; const blue = (value >>> 16) & 0xff;
      words[index] = value >>> 24 && (red > 96 || green > 96 || blue > 96) ? 0xffffffff : 0x00ffffff;
    }
    return;
  }
  for (let offset = 0; offset < data.length; offset += 4) {
    const visible = data[offset + 3] > 0 && Math.max(data[offset], data[offset + 1], data[offset + 2]) > 96;
    data[offset] = 255; data[offset + 1] = 255; data[offset + 2] = 255;
    data[offset + 3] = visible ? 255 : 0;
  }
}

const area = (ring: Point[]) => ring.reduce((sum, p, i) => {
  const q = ring[(i + 1) % ring.length]; return sum + p.x * q.y - q.x * p.y;
}, 0) / 2;

/** Cuts every corner half a pixel along both edges, turning stair steps into 45° chamfers. */
function halfPixelContour(ring: Point[]): Point[] {
  const samples: Point[] = [];
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[i];
    for (const q of [ring[(i + ring.length - 1) % ring.length], ring[(i + 1) % ring.length]]) {
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      if (!length) continue;
      const fraction = Math.min(0.5, length / 2) / length;
      const point = { x: p.x + (q.x - p.x) * fraction, y: p.y + (q.y - p.y) * fraction };
      const last = samples.at(-1);
      if (!last || point.x !== last.x || point.y !== last.y) samples.push(point);
    }
  }
  if (samples.length > 1 && samples[0].x === samples.at(-1)!.x && samples[0].y === samples.at(-1)!.y) samples.pop();
  return samples.filter((p, i) => {
    const a = samples[(i + samples.length - 1) % samples.length]; const b = samples[(i + 1) % samples.length];
    return (p.x - a.x) * (b.y - p.y) !== (p.y - a.y) * (b.x - p.x);
  });
}

/** Half-pixel contour instead of stair-step square edges. Never used on saved polygons. */
export function vectorizeContourMask(pixels: Uint8Array, width: number, height: number, idPrefix = 'mask'): AnnotationPolygon[] {
  const exact = vectorizeBinaryMask(pixels, width, height, idPrefix);
  const contour = (ring: PolygonNode[], prefix: string): PolygonNode[] => (
    halfPixelContour(ring).map((p, i) => ({ ...p, id: `${prefix}-${i}` }))
  );
  const candidate = exact.map(p => ({ ...p, nodes: contour(p.nodes, `${p.id}-outer`),
    holes: p.holes?.map((ring, i) => contour(ring, `${p.id}-hole${i}`)) }));
  const roundTrip = rasterizePolygons(candidate, width, height);
  return roundTrip.every((p, i) => Boolean(p) === Boolean(pixels[i])) ? candidate : exact;
}

// ─── Smoothing ──────────────────────────────────────────

function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Douglas–Peucker on a closed ring, iterative so long contours cannot overflow the stack. */
function simplifyClosed(points: Point[], tolerance: number): Point[] {
  const n = points.length;
  if (n < 4) return points;
  let far = 0; let farDistance = -1;
  for (let i = 1; i < n; i += 1) {
    const distance = (points[i].x - points[0].x) ** 2 + (points[i].y - points[0].y) ** 2;
    if (distance > farDistance) { far = i; farDistance = distance; }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[far] = 1;
  const stack = [0, far, far, n];
  while (stack.length) {
    const end = stack.pop()!; const start = stack.pop()!;
    const a = points[start]; const b = points[end % n];
    let index = -1; let max = tolerance;
    for (let i = start + 1; i < end; i += 1) {
      const distance = segmentDistance(points[i], a, b);
      if (distance > max) { max = distance; index = i; }
    }
    if (index >= 0) { keep[index] = 1; stack.push(start, index, index, end); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Keeps a vertex only when it is farther than `tolerance` from the last kept one (O(n)). */
function radialDecimate<T extends Point>(points: T[], tolerance: number): T[] {
  if (points.length < 4) return points;
  const limit = tolerance * tolerance;
  const kept = [points[0]];
  let last = points[0];
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i];
    if ((p.x - last.x) ** 2 + (p.y - last.y) ** 2 > limit) { kept.push(p); last = p; }
  }
  return kept;
}

/**
 * Zoom-dependent level-of-detail outline, display only (never saved, never rasterized for export).
 * Radial decimation first drops the dense sub-tolerance vertices of smoothed contours in linear time,
 * so Douglas–Peucker only refines the few that remain — the simplify.js two-pass scheme. The radial
 * pass uses half the tolerance, keeping the total deviation within 1.5 × `tolerance`.
 */
export function simplifyRing(points: Point[], tolerance: number): Point[] {
  return simplifyClosed(radialDecimate(points, tolerance / 2), tolerance);
}

const mix = (a: Point, b: Point, u: number): Point => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });

/**
 * Chaikin corner cutting. Each pass halves every turn angle, including at short edges, and the
 * limit curve is a quadratic B-spline (piecewise Bézier) that stays inside the control polygon.
 */
function chaikin(points: Point[], iterations = 3): Point[] {
  let current = points;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next: Point[] = [];
    for (let i = 0; i < current.length; i += 1) {
      const a = current[i]; const b = current[(i + 1) % current.length];
      next.push(mix(a, b, 0.25), mix(a, b, 0.75));
    }
    current = next;
  }
  return current;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Smooth outline for a ring: denser vertices along curves, fewer on straight runs.
 * Returns the input ring itself when smoothing would distort a tiny or thin shape.
 */
export function smoothRing<T extends Point>(ring: T[], clamp?: { width: number; height: number }): Point[] {
  if (ring.length < 3) return ring;
  const contour = halfPixelContour(ring);
  const baseArea = Math.abs(area(contour));
  if (contour.length < 6 || baseArea < 12) return ring;
  const simplified = simplifyClosed(contour, 0.55);
  if (simplified.length < 4 || Math.abs(area(simplified)) < baseArea * 0.8) return ring;
  // Final light pass drops collinear samples on straight runs but keeps dense points on curves.
  const curve = simplifyClosed(chaikin(simplified), 0.05);
  const curveArea = Math.abs(area(curve));
  if (curve.length < 4 || curveArea < baseArea * 0.85 || curveArea > baseArea * 1.15) return ring;
  return curve.map((p) => ({
    x: round3(clamp ? Math.max(0, Math.min(clamp.width, p.x)) : p.x),
    y: round3(clamp ? Math.max(0, Math.min(clamp.height, p.y)) : p.y),
  }));
}

/** Smooths every ring of a polygon. Returns the same object when nothing changed. */
export function smoothPolygon(polygon: AnnotationPolygon, clamp?: { width: number; height: number }): AnnotationPolygon {
  let changed = false;
  const ring = (nodes: PolygonNode[], suffix: string): PolygonNode[] => {
    const smoothed = smoothRing(nodes, clamp);
    if (smoothed === nodes) return nodes;
    changed = true;
    return smoothed.map((p, i) => ({ x: p.x, y: p.y, id: `${polygon.id}-${suffix}-s${i}` }));
  };
  const nodes = ring(polygon.nodes, 'outer');
  const holes = polygon.holes?.map((hole, i) => ring(hole, `hole${i}`));
  return changed ? { ...polygon, nodes, holes } : polygon;
}

// ─── Compact contours (prelabel import) ─────────────────

const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const onSegment = (p: Point, a: Point, b: Point) => (
  Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y)
);

/** Segments cross or touch (shared points included). */
function segmentsMeet(a: Point, b: Point, c: Point, d: Point) {
  const o1 = cross(a, b, c); const o2 = cross(a, b, d); const o3 = cross(c, d, a); const o4 = cross(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (o1 === 0 && onSegment(c, a, b)) || (o2 === 0 && onSegment(d, a, b))
    || (o3 === 0 && onSegment(a, c, d)) || (o4 === 0 && onSegment(b, c, d));
}

/**
 * Pairs of ring indices `[i, j]` (`i === j` for a self-intersection) whose edges cross or touch,
 * except consecutive edges of one ring at their shared vertex. Edges are swept by min x, so only
 * edges overlapping in x are compared. When no edges meet, also reports a hole outside the outer
 * ring (`[0, k]`) or inside another hole (`[k, m]`). Empty for a valid polygon with holes.
 */
function ringConflicts(rings: Point[][]): Array<[number, number]> {
  const edges: Array<{ ring: number; index: number; a: Point; b: Point; minX: number; maxX: number }> = [];
  rings.forEach((ring, r) => ring.forEach((a, index) => {
    const b = ring[(index + 1) % ring.length];
    edges.push({ ring: r, index, a, b, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x) });
  }));
  edges.sort((p, q) => p.minX - q.minX);
  const pairs = new Map<number, [number, number]>();
  let active: typeof edges = [];
  for (const edge of edges) {
    active = active.filter((other) => other.maxX >= edge.minX);
    for (const other of active) {
      const i = Math.min(edge.ring, other.ring); const j = Math.max(edge.ring, other.ring);
      if (pairs.has(i * rings.length + j)) continue;
      if (i === j) {
        const gap = Math.abs(other.index - edge.index);
        if (gap === 1 || gap === rings[i].length - 1) continue;
      }
      if (segmentsMeet(edge.a, edge.b, other.a, other.b)) pairs.set(i * rings.length + j, [i, j]);
    }
    active.push(edge);
  }
  if (pairs.size) return [...pairs.values()];
  const [outer, ...holes] = rings;
  const nested: Array<[number, number]> = [];
  holes.forEach((hole, i) => {
    if (!contains(outer, hole[0])) nested.push([0, i + 1]);
    holes.forEach((other, j) => { if (i !== j && contains(other, hole[0])) nested.push([i + 1, j + 1]); });
  });
  return nested;
}

/**
 * Douglas–Peucker of a half-pixel contour at `tolerance` px, or null when the result would
 * collapse or change the ring's area by more than 10 % (tiny and thin regions, narrow grooves).
 */
function compactRing(contour: Point[], tolerance: number): Point[] | null {
  const simplified = simplifyClosed(contour, tolerance);
  const ratio = Math.abs(area(simplified)) / Math.abs(area(contour));
  return simplified.length >= 3 && ratio >= 0.9 && ratio <= 1.1 ? simplified : null;
}

/**
 * Compacts an exact pixel-edge polygon (from `vectorizeBinaryMask`) into far fewer vertices,
 * keeping `id`, `label`, `meta` and the node id scheme `<id>-outer-<i>` / `<id>-hole<k>-<i>`.
 * Each ring is the half-pixel contour simplified at `tolerance`, else at half of it, else the
 * contour itself. Rings that would cross, touch or leave a hole outside the outer ring step
 * down one level at a time, holes before the outer ring, so a groove beside a one-pixel wall
 * does not undo the whole outline; if even the contours conflict, the exact rings are kept.
 * Used by prelabel import scripts only; the editor never compacts saved polygons.
 */
export function compactPolygon(polygon: AnnotationPolygon, tolerance = 1): AnnotationPolygon {
  const contours = [polygon.nodes, ...(polygon.holes ?? [])].map(halfPixelContour);
  if (contours.some((ring) => ring.length < 3 || !area(ring))) return polygon;
  const tolerances = [tolerance, tolerance / 2];
  const level = contours.map(() => 0);
  const ringAt = (k: number) => {
    for (; level[k] < tolerances.length; level[k] += 1) {
      const ring = compactRing(contours[k], tolerances[level[k]]);
      if (ring) return ring;
    }
    return contours[k];
  };
  const rings = contours.map((_, k) => ringAt(k));
  const relaxable = (k: number) => level[k] < tolerances.length;
  for (;;) {
    const conflicts = ringConflicts(rings);
    if (!conflicts.length) break;
    const relax = new Set<number>();
    for (const [i, j] of conflicts) {
      const hole = [j, i].find((k) => k !== 0 && relaxable(k));
      if (hole !== undefined) relax.add(hole);
      else if (relaxable(i)) relax.add(i);
      else if (relaxable(j)) relax.add(j);
    }
    if (!relax.size) return polygon; // the half-pixel contours themselves conflict
    for (const k of relax) { level[k] += 1; rings[k] = ringAt(k); }
  }
  const nodes = (ring: Point[], suffix: string): PolygonNode[] => ring.map((p, i) => ({ x: p.x, y: p.y, id: `${polygon.id}-${suffix}-${i}` }));
  const [outer, ...holes] = rings;
  return { ...polygon, nodes: nodes(outer, 'outer'), holes: holes.map((hole, i) => nodes(hole, `hole${i}`)) };
}

// ─── Exact vectorization ────────────────────────────────

function contains(ring: Point[], p: Point) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]; const b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Flood-fills one 4-connected component and walks its pixel-edge boundary into simple rings. */
function traceComponent(
  pixels: Uint8Array, width: number, height: number, seed: number, seen: Uint8Array, queue: Int32Array,
): { rings: Point[][]; bounds: ComponentBounds } {
  const stride = width + 1;
  const edges = new Map<number, number[]>();
  const add = (a: number, b: number) => { const outgoing = edges.get(a); if (outgoing) outgoing.push(b); else edges.set(a, [b]); };
  let left = width; let right = -1; let top = height; let bottom = -1;
  let head = 0; let tail = 0;
  queue[tail++] = seed; seen[seed] = 1;
  while (head < tail) {
    const cell = queue[head++]; const x = cell % width; const y = (cell - x) / width;
    if (x < left) left = x; if (x > right) right = x;
    if (y < top) top = y; if (y > bottom) bottom = y;
    const topLeft = y * stride + x; const topRight = topLeft + 1;
    const bottomRight = topLeft + stride + 1; const bottomLeft = topLeft + stride;
    // Same side order as corners [TL, TR, BR, BL]: up, right, down, left.
    let neighbor = cell - width;
    if (y === 0 || !pixels[neighbor]) add(topLeft, topRight);
    else if (!seen[neighbor]) { seen[neighbor] = 1; queue[tail++] = neighbor; }
    neighbor = cell + 1;
    if (x + 1 >= width || !pixels[neighbor]) add(topRight, bottomRight);
    else if (!seen[neighbor]) { seen[neighbor] = 1; queue[tail++] = neighbor; }
    neighbor = cell + width;
    if (y + 1 >= height || !pixels[neighbor]) add(bottomRight, bottomLeft);
    else if (!seen[neighbor]) { seen[neighbor] = 1; queue[tail++] = neighbor; }
    neighbor = cell - 1;
    if (x === 0 || !pixels[neighbor]) add(bottomLeft, topLeft);
    else if (!seen[neighbor]) { seen[neighbor] = 1; queue[tail++] = neighbor; }
  }
  const rings: Point[][] = [];
  const direction = (a: number, b: number) => b === a + 1 ? 0 : b === a + stride ? 1 : b === a - 1 ? 2 : 3;
  while (edges.size) {
    const start = edges.keys().next().value!;
    let current = start; let incoming = -1;
    const ring: Point[] = [];
    do {
      ring.push({ x: current % stride, y: Math.floor(current / stride) });
      const next = edges.get(current);
      if (!next?.length) throw new Error('Open mask boundary');
      // At a diagonal junction follow the right-hand boundary, keeping holes separate.
      const rank = (end: number) => [1, 0, 3, 2][(direction(current, end) - incoming + 4) % 4];
      if (next.length > 1 && incoming >= 0) next.sort((a, b) => rank(a) - rank(b));
      const end = next.shift()!;
      if (!next.length) edges.delete(current);
      incoming = direction(current, end); current = end;
    } while (current !== start);
    // Split pinched walks at repeated vertices into simple rings. Otherwise diagonal
    // background contacts can produce self-touching holes that later editors reject.
    const stack: Point[] = [];
    const positions = new Map<number, number>();
    for (const p of [...ring, ring[0]]) {
      const key = p.y * stride + p.x;
      const previous = positions.get(key);
      if (previous === undefined) { positions.set(key, stack.length); stack.push(p); continue; }
      const cycle = stack.slice(previous);
      for (let i = previous + 1; i < stack.length; i += 1) positions.delete(stack[i].y * stride + stack[i].x);
      stack.length = previous + 1;
      rings.push(cycle.filter((point, i) => {
        const a = cycle[(i + cycle.length - 1) % cycle.length]; const b = cycle[(i + 1) % cycle.length];
        return (point.x - a.x) * (b.y - point.y) !== (point.y - a.y) * (b.x - point.x);
      }));
    }
  }
  return { rings, bounds: { left, top, right, bottom } };
}

function componentPolygons(
  rings: Point[][], idBase: string, label: string, smooth?: { width: number; height: number },
): AnnotationPolygon[] {
  const outers = rings.filter((ring) => area(ring) > 0);
  const holes = rings.filter((ring) => area(ring) < 0);
  return outers.map((outer, index) => {
    const id = `${idBase}-${index}`;
    const nodes = (ring: Point[], suffix: string): PolygonNode[] => (smooth ? smoothRing(ring, smooth) : ring)
      .map((p, i) => ({ x: p.x, y: p.y, id: `${id}-${suffix}-${i}` }));
    return { id, label, nodes: nodes(outer, 'outer'),
      holes: holes.filter((hole) => outers.length === 1 || contains(outer, hole[0])).map((hole, i) => nodes(hole, `hole${i}`)) };
  });
}

/** Exact pixel edges. One wN per 4-connected component, including one-pixel regions. */
export function vectorizeBinaryMask(pixels: Uint8Array, width: number, height: number, idPrefix = 'mask'): AnnotationPolygon[] {
  dimensions(width, height);
  if (pixels.length !== width * height) throw new Error('Mask buffer size mismatch');
  const seen = new Uint8Array(pixels.length);
  const queue = new Int32Array(pixels.length);
  const polygons: AnnotationPolygon[] = [];
  let component = 0;
  for (let seed = 0; seed < pixels.length; seed += 1) {
    if (!pixels[seed] || seen[seed]) continue;
    component += 1;
    const { rings } = traceComponent(pixels, width, height, seed, seen, queue);
    polygons.push(...componentPolygons(rings, `${idPrefix}-w${component}`, `w${component}`));
  }
  return polygons;
}

/**
 * Keeps the binary mask and its vector components between edits. After a local edit only
 * components whose bounds touch the dirty rectangle are traced again; the rest are reused.
 */
export class MaskVectorizer {
  // Explicit fields (no parameter properties): scripts load this file with Node's strip-only TS mode.
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  private readonly smooth: boolean;
  private readonly seen: Uint8Array;
  private readonly queue: Int32Array;
  private components: Array<{ bounds: ComponentBounds; polygons: AnnotationPolygon[] }> = [];
  private dirty: PixelBounds | null = null;
  private full = true;
  private counter = 0;

  constructor(width: number, height: number, smooth = true) {
    dimensions(width, height);
    this.width = width;
    this.height = height;
    this.smooth = smooth;
    this.pixels = new Uint8Array(width * height);
    this.seen = new Uint8Array(width * height);
    this.queue = new Int32Array(width * height);
  }

  markDirty(bounds: PixelBounds) {
    const left = Math.max(0, Math.floor(bounds.left)); const top = Math.max(0, Math.floor(bounds.top));
    const right = Math.min(this.width, Math.ceil(bounds.right)); const bottom = Math.min(this.height, Math.ceil(bounds.bottom));
    if (right <= left || bottom <= top) return;
    this.dirty = this.dirty
      ? { left: Math.min(this.dirty.left, left), top: Math.min(this.dirty.top, top), right: Math.max(this.dirty.right, right), bottom: Math.max(this.dirty.bottom, bottom) }
      : { left, top, right, bottom };
  }

  markAllDirty() {
    this.full = true;
    this.dirty = null;
  }

  vectorize(idPrefix = 'mask'): AnnotationPolygon[] {
    const { width, height, pixels, seen, queue } = this;
    const smooth = this.smooth ? { width, height } : undefined;
    const emit = (traced: ReturnType<typeof traceComponent>) => {
      this.counter += 1;
      return { bounds: traced.bounds, polygons: componentPolygons(traced.rings, `${idPrefix}-w${this.counter}`, `w${this.counter}`, smooth) };
    };
    if (this.full || this.dirty) seen.fill(0);
    if (this.full) {
      this.components = [];
      for (let seed = 0; seed < pixels.length; seed += 1) {
        if (pixels[seed] && !seen[seed]) this.components.push(emit(traceComponent(pixels, width, height, seed, seen, queue)));
      }
    } else if (this.dirty) {
      // Expand by one pixel: a changed pixel can join or split its 4-neighbours' components.
      const region = {
        left: Math.max(0, this.dirty.left - 1), top: Math.max(0, this.dirty.top - 1),
        right: Math.min(width - 1, this.dirty.right), bottom: Math.min(height - 1, this.dirty.bottom),
      };
      const touches = (b: ComponentBounds) => b.left <= region.right && b.right >= region.left
        && b.top <= region.bottom && b.bottom >= region.top;
      const kept = this.components.filter((component) => !touches(component.bounds));
      const removed = this.components.filter((component) => touches(component.bounds));
      const created: typeof this.components = [];
      const scan = (b: ComponentBounds) => {
        for (let y = b.top; y <= b.bottom; y += 1) {
          for (let seed = y * width + b.left, end = y * width + b.right; seed <= end; seed += 1) {
            if (!pixels[seed] || seen[seed]) continue;
            const traced = traceComponent(pixels, width, height, seed, seen, queue);
            // Components away from the edit are unchanged and already in `kept`.
            if (touches(traced.bounds)) created.push(emit(traced));
          }
        }
      };
      scan(region);
      for (const component of removed) scan(component.bounds);
      this.components = [...kept, ...created];
    }
    this.full = false;
    this.dirty = null;
    return this.components.flatMap((component) => component.polygons);
  }
}

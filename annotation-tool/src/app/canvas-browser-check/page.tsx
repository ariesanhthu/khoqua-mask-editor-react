'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import EditorCanvas, { type CanvasViewInfo, type EditorCanvasHandle, type EditorCanvasSnapshot, type EditorHistoryState, type EditorTool } from '@/components/editor-canvas';
import CanvasMinimap from '@/components/canvas-minimap';
import { PaintModeIcon } from '@/components/paint-mode-icon';
import { explainAutoAnchorPath, pointInMask } from '@/lib/polygon-geometry';
import { planNodeAnchorDrag } from '@/lib/node-anchor';
import type { PaintMode } from '@/lib/polygon-paint';
import type { OverlayColorMode } from '@/lib/review-colors';
import type { AnnotationPolygon, MaskOperation } from '@/types';

const noop = () => {};
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="white"/><path d="M400 240v20m-10-10h20" stroke="black"/></svg>');
const blank = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"/>');
const initial: AnnotationPolygon[] = [200, 550].map((x, i) => ({ id: String(i), label: 'r' + (i + 1), nodes: [[x, 100], [x + 50, 100], [x + 50, 400], [x, 400]].map(([x, y], j) => ({ id: i + '-' + j, x, y })) }));
const operations: MaskOperation[] = [{ type: 'POLYGON_SET', polygons: initial }];
const breaks = { state: 'NOT_ANNOTATED' as const, points: [] };

/** ?spiky=1: large raster-only prediction with one connected spiky body (no saved polygons). */
function spikyScene() {
  const width = 1600; const height = 1000;
  let seed = 3;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const points: string[] = [];
  for (let i = 0; i < 160; i += 1) {
    const angle = (i / 160) * Math.PI * 2;
    const radius = i % 2 ? 260 + random() * 40 : 330 + random() * 160;
    points.push(`${(800 + Math.cos(angle) * radius * 1.6).toFixed(1)},${(500 + Math.sin(angle) * radius).toFixed(1)}`);
  }
  const photo = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#dfe"/></svg>`);
  const mask = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><polygon points="${points.join(' ')}" fill="white"/><circle cx="800" cy="500" r="60" fill="black"/></svg>`);
  return { width, height, photo, mask, operations: [] as MaskOperation[] };
}

/**
 * ?seams=1: vùng trống x 160..540, y 160..400 bao kín bởi 6 mask (L | tA | tB | tC | R ở trên/hai bên, Bm ở dưới)
 * để kiểm tra tự nối biên bằng Shift (người dùng xác nhận 2026-11-05).
 */
function seamsScene() {
  const width = 800; const height = 500;
  const boxes: Array<[number, number, number, number]> = [
    [100, 100, 160, 400], [160, 100, 300, 160], [300, 100, 400, 160], [400, 100, 540, 160], [540, 100, 600, 400], [100, 400, 600, 460],
  ];
  const polygons: AnnotationPolygon[] = boxes.map(([left, top, right, bottom], i) => ({
    id: `s${i}`, label: `r${i + 1}`,
    nodes: [[left, top], [right, top], [right, bottom], [left, bottom]].map(([x, y], j) => ({ id: `s${i}-${j}`, x, y })),
  }));
  const photo = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="white"/></svg>`);
  const mask = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`);
  return { width, height, photo, mask, operations: [{ type: 'POLYGON_SET', polygons }] as MaskOperation[] };
}

/** ?labels=1: hai mask tách rời cùng label r1 và một mask w1, để kiểm tra màu theo label và độ mờ của viền. */
function labelsScene() {
  const width = 800; const height = 500;
  const boxes: Array<[string, number, number, number, number]> = [['r1', 100, 100, 250, 300], ['r1', 500, 100, 650, 300], ['w1', 300, 320, 450, 450]];
  const polygons: AnnotationPolygon[] = boxes.map(([label, left, top, right, bottom], i) => ({
    id: `l${i}`, label,
    nodes: [[left, top], [right, top], [right, bottom], [left, bottom]].map(([x, y], j) => ({ id: `l${i}-${j}`, x, y })),
  }));
  const photo = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="white"/></svg>`);
  const mask = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`);
  return { width, height, photo, mask, operations: [{ type: 'POLYGON_SET', polygons }] as MaskOperation[] };
}

/** ?many=1: large polygon-mode file (600 saved polygons) to profile zoom/tool switches. */
function manyScene() {
  const width = 2400; const height = 1600;
  const polygons: AnnotationPolygon[] = [];
  for (let row = 0; row < 20; row += 1) {
    for (let column = 0; column < 30; column += 1) {
      const id = `m${row}-${column}`;
      const cx = 60 + column * 78; const cy = 60 + row * 76;
      const nodes = Array.from({ length: 24 }, (_, i) => {
        const angle = (i / 24) * Math.PI * 2;
        const radius = 26 + ((row * 7 + column * 3 + i) % 5) * 2;
        return { id: `${id}-${i}`, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
      });
      polygons.push({ id, label: `w${polygons.length + 1}`, nodes });
    }
  }
  const photo = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g"><stop offset="0" stop-color="#cde"/><stop offset="1" stop-color="#9b7"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#g)"/></svg>`);
  const mask = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`);
  return { width, height, photo, mask, operations: [{ type: 'POLYGON_SET', polygons }] as MaskOperation[] };
}

/** ?photo=1: ảnh hai nửa xám (trái #666, phải #999, ranh dọc x=400) để đo độ sáng + làm rõ biên bằng pixel thật. */
function photoScene() {
  const width = 800; const height = 500;
  const polygons: AnnotationPolygon[] = [{
    id: 'p0', label: 'r1',
    nodes: [[40, 40], [120, 40], [120, 120], [40, 120]].map(([x, y], j) => ({ id: `p0-${j}`, x, y })),
  }];
  const photo = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="400" height="${height}" fill="#666"/><rect x="400" width="400" height="${height}" fill="#999"/></svg>`);
  const mask = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`);
  return { width, height, photo, mask, operations: [{ type: 'POLYGON_SET', polygons }] as MaskOperation[] };
}

export default function BrowserCheck() {
  const ref = useRef<EditorCanvasHandle>(null);
  const [scene, setScene] = useState<ReturnType<typeof spikyScene> | null | undefined>(undefined);
  const [polygons, setPolygons] = useState(initial);
  const [mode, setMode] = useState<PaintMode>('add');
  const [tool, setTool] = useState<EditorTool>('select');
  const [message, setMessage] = useState('');
  const [zoom, setZoom] = useState(1);
  const [exported, setExported] = useState('');
  // Hiển thị cho script kiểm tra trình duyệt: undo/redo cục bộ khi đang chấm điểm polygon.
  const [history, setHistory] = useState<EditorHistoryState>({ local: false, canUndo: false, canRedo: false });
  const [selected, setSelected] = useState<string[]>([]);
  const [overlay, setOverlay] = useState({ opacity: 0.5, showMask: true, magnet: true });
  // Hiển thị ảnh (độ sáng + làm rõ biên) và minimap, như sidebar của workspace (người dùng xác nhận 2026-11-16).
  const [adjust, setAdjust] = useState({ brightness: 1, edge: 0 });
  // Bảng màu lớp phủ của trang duyệt (2026-11-24); mặc định 'label' như editor.
  const [colorMode, setColorMode] = useState<OverlayColorMode>('label');
  const [view, setView] = useState<CanvasViewInfo | null>(null);
  // Cho script kiểm tra đọc tọa độ node (magnet, Paint, kéo + Shift).
  useEffect(() => { (window as unknown as { __polygons?: AnnotationPolygon[] }).__polygons = polygons; }, [polygons]);
  // Đo lõi tự hoàn thiện ngay trong Chrome trên polygon hiện có: lần đầu dựng mô hình biên (cache lạnh), các lần sau
  // dùng lại cache theo mảng polygon (như khi rê chuột giữ Shift hoặc kéo node + Shift).
  useEffect(() => {
    (window as unknown as { __benchAutoComplete?: (from: [number, number], cursor: [number, number], count: number) => object }).__benchAutoComplete = (from, cursor, count) => {
      const draft = [{ x: from[0] - 30, y: from[1] - 30 }, { x: from[0], y: from[1] }];
      const time = (run: () => unknown) => { const start = performance.now(); run(); return performance.now() - start; };
      const cold = time(() => explainAutoAnchorPath(polygons, { x: cursor[0], y: cursor[1] }, draft, 14));
      let warm = 0;
      for (let index = 0; index < count; index += 1) warm += time(() => explainAutoAnchorPath(polygons, { x: cursor[0] + (index % 5), y: cursor[1] }, draft, 14));
      const [target] = polygons;
      const others = polygons.slice(1);
      let drag = 0;
      for (let index = 0; index < count; index += 1) {
        drag += time(() => planNodeAnchorDrag({ polygons, others, polygonId: target.id, nodeId: target.nodes[0].id, cursor: { x: cursor[0] + (index % 5), y: cursor[1] }, tolerance: 14 }));
      }
      return { coldMs: Number(cold.toFixed(2)), warmMsPerMove: Number((warm / count).toFixed(3)), dragMsPerMove: Number((drag / count).toFixed(3)) };
    };
  }, [polygons]);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const next = query.has('spiky') ? spikyScene() : query.has('many') ? manyScene() : query.has('seams') ? seamsScene() : query.has('labels') ? labelsScene() : query.has('photo') ? photoScene() : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read the URL once after hydration
    setScene(next);
    if (next) { setPolygons(next.operations.flatMap((operation) => operation.type === 'POLYGON_SET' ? operation.polygons : [])); setTool('select'); }
  }, []);
  const change = useCallback((snapshot: EditorCanvasSnapshot) => setPolygons(snapshot.polygons), []);
  const inspectExport = async () => {
    const blob = await ref.current!.exportMask();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 500;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
    setExported('PNG center alpha=' + ctx.getImageData(400, 250, 1, 1).data[3] + '; mask alpha=' + ctx.getImageData(220, 250, 1, 1).data[3]);
  };
  const chooseTool = (next: EditorTool) => {
    // Paint (brush) sửa trên polygon từ 2026-11-12 nên cũng cần polygon sẵn sàng.
    if (next !== 'pan') ref.current?.beginPolygonEdit();
    setTool(next);
  };
  if (scene === undefined) return null;
  return <main style={{ padding: 12 }}>
    <h1>Canvas browser check — synthetic data only</h1>
    <div style={{ display: 'flex', gap: 20, padding: 12 }}>
      <button data-paint="add" aria-pressed={mode === 'add'} onClick={() => setMode('add')}><PaintModeIcon mode="add" />Paint +</button>
      <button data-paint="subtract" aria-pressed={mode === 'subtract'} onClick={() => setMode('subtract')}><PaintModeIcon mode="subtract" />Paint −</button>
      <button onClick={() => ref.current?.undo()}>Undo</button>
      <button onClick={() => ref.current?.redo()}>Redo</button>
      <button onClick={() => ref.current?.fit()}>Fit</button>
      <button onClick={inspectExport}>Check PNG</button>
      <button data-tool="select" onClick={() => chooseTool('select')}>Select</button>
      <button data-tool="brush" onClick={() => chooseTool('brush')}>Paint</button>
      <button data-tool="polygon" onClick={() => chooseTool('polygon')}>Polygon</button>
      <button data-tool="rectangle" onClick={() => chooseTool('rectangle')}>Rectangle</button>
      <button data-tool="circle" onClick={() => chooseTool('circle')}>Circle</button>
      <button data-tool="anchor" onClick={() => chooseTool('anchor')}>Anchor</button>
      <button data-action="flush" onClick={async () => { await ref.current?.flushPendingEdits(); await ref.current?.exportMask(); setMessage('flushed'); }}>Flush</button>
      <button data-overlay="hide" onClick={() => setOverlay((value) => ({ ...value, showMask: !value.showMask }))}>Mask layer</button>
      <button data-overlay="low" onClick={() => setOverlay((value) => ({ ...value, opacity: 0.2 }))}>Opacity 20</button>
      <button data-overlay="full" onClick={() => setOverlay((value) => ({ ...value, opacity: 1 }))}>Opacity 100</button>
      <button data-overlay="magnet" onClick={() => setOverlay((value) => ({ ...value, magnet: !value.magnet }))}>Magnet</button>
      <button data-adjust="bright" onClick={() => setAdjust((value) => ({ ...value, brightness: 0.6 }))}>Bright 60</button>
      <button data-adjust="edge" onClick={() => setAdjust((value) => ({ ...value, edge: 1 }))}>Edge 100</button>
      <button data-adjust="reset" onClick={() => setAdjust({ brightness: 1, edge: 0 })}>Adjust reset</button>
    </div>
    {/* Hàng nút trên đã tràn khỏi cửa sổ 1280 px: nút màu đặt cố định ở góc, không đẩy canvas (tọa độ các kiểm tra khác giữ nguyên). */}
    <div style={{ position: 'fixed', right: 8, bottom: 8, zIndex: 50, display: 'flex', gap: 6 }}>
      {(['label', 'twoTone', 'warmCool'] as const).map((value) => (
        <button key={value} data-colors={value} aria-pressed={colorMode === value} onClick={() => setColorMode(value)}>Colors {value}</button>
      ))}
    </div>
    <p>Mode={mode}; tool={tool}; masks={polygons.length}; holes={polygons.reduce((n, p) => n + (p.holes?.length ?? 0), 0)}; center filled={String(polygons.some((p) => pointInMask({ x: 400, y: 250 }, p)))}; zoom={zoom.toFixed(4)}</p>
    <p data-testid="history">history local={String(history.local)}; canUndo={String(history.canUndo)}; canRedo={String(history.canRedo)}; last={polygons.at(-1)?.label ?? '-'}:{polygons.at(-1)?.nodes.length ?? 0}; selected={selected.length}; totalNodes={polygons.reduce((sum, polygon) => sum + polygon.nodes.length, 0)}; maxNodes={polygons.reduce((max, polygon) => Math.max(max, polygon.nodes.length + (polygon.holes ?? []).reduce((sum, hole) => sum + hole.length, 0)), 0)}</p>
    <p>{message} {exported}</p>
    <div className="editor-shell" style={{ width: 900, height: 580 }}>
      <div className="editor-main" style={{ position: 'relative', width: '100%', height: '100%' }}>
        {scene
          ? <EditorCanvas ref={ref} width={scene.width} height={scene.height} imageUrl={scene.photo} predictionUrl={scene.mask}
            initialHumanAction={scene.operations.length ? 'MODIFIED' : 'UNTOUCHED'} initialBreakpoints={breaks} initialOperations={scene.operations}
            tool={tool} paintMode={mode} maskOpacity={overlay.opacity} showMask={overlay.showMask} magnet={overlay.magnet} colorMode={colorMode}
            brightness={adjust.brightness} edgeStrength={adjust.edge} onViewChange={setView}
            onChange={change} onSelectionChange={setSelected} onHistoryChange={setHistory} onReady={noop} onMessage={setMessage} onZoomChange={setZoom} />
          : <EditorCanvas ref={ref} width={800} height={500} imageUrl={image} predictionUrl={blank}
            initialHumanAction="MODIFIED" initialBreakpoints={breaks} initialOperations={operations}
            tool={tool} paintMode={mode} maskOpacity={overlay.opacity} showMask={overlay.showMask} magnet={overlay.magnet} colorMode={colorMode}
            brightness={adjust.brightness} edgeStrength={adjust.edge} onViewChange={setView}
            onChange={change} onSelectionChange={setSelected} onHistoryChange={setHistory} onReady={noop} onMessage={setMessage} onZoomChange={setZoom} />}
      </div>
    </div>
    <div style={{ width: 210, paddingTop: 8 }}>
      <CanvasMinimap imageUrl={scene ? scene.photo : image} imageWidth={scene ? scene.width : 800} imageHeight={scene ? scene.height : 500}
        view={view} onPan={(x, y) => ref.current?.panTo(x, y)} />
    </div>
  </main>;
}

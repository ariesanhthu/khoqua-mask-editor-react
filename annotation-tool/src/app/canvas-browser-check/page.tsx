'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import EditorCanvas, { type EditorCanvasHandle, type EditorCanvasSnapshot, type EditorHistoryState, type EditorTool } from '@/components/editor-canvas';
import { pointInMask } from '@/lib/polygon-geometry';
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

export default function BrowserCheck() {
  const ref = useRef<EditorCanvasHandle>(null);
  const [scene, setScene] = useState<ReturnType<typeof spikyScene> | null | undefined>(undefined);
  const [polygons, setPolygons] = useState(initial);
  const [mode, setMode] = useState<'add' | 'erase'>('add');
  const [tool, setTool] = useState<EditorTool>('brush');
  const [message, setMessage] = useState('');
  const [zoom, setZoom] = useState(1);
  const [exported, setExported] = useState('');
  // Hiển thị cho script kiểm tra trình duyệt: undo/redo cục bộ khi đang chấm điểm polygon.
  const [history, setHistory] = useState<EditorHistoryState>({ local: false, canUndo: false, canRedo: false });
  const [selected, setSelected] = useState<string[]>([]);
  const [overlay, setOverlay] = useState({ opacity: 0.5, showMask: true, magnet: true });
  // Cho script kiểm tra đọc tọa độ node (magnet).
  useEffect(() => { (window as unknown as { __polygons?: AnnotationPolygon[] }).__polygons = polygons; }, [polygons]);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const next = query.has('spiky') ? spikyScene() : query.has('many') ? manyScene() : query.has('seams') ? seamsScene() : query.has('labels') ? labelsScene() : null;
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
    if (next !== 'brush' && next !== 'pan') ref.current?.beginPolygonEdit();
    setTool(next);
  };
  if (scene === undefined) return null;
  return <main style={{ padding: 12 }}>
    <h1>Canvas browser check — synthetic data only</h1>
    <div style={{ display: 'flex', gap: 20, padding: 12 }}>
      <button onClick={() => setMode('add')}>Add 12 px</button>
      <button onClick={() => setMode('erase')}>Erase 1 px</button>
      <button onClick={() => ref.current?.undo()}>Undo</button>
      <button onClick={() => ref.current?.redo()}>Redo</button>
      <button onClick={() => ref.current?.fit()}>Fit</button>
      <button onClick={inspectExport}>Check PNG</button>
      <button data-tool="select" onClick={() => chooseTool('select')}>Select</button>
      <button data-tool="brush" onClick={() => chooseTool('brush')}>Brush</button>
      <button data-tool="polygon" onClick={() => chooseTool('polygon')}>Polygon</button>
      <button data-tool="rectangle" onClick={() => chooseTool('rectangle')}>Rectangle</button>
      <button data-tool="circle" onClick={() => chooseTool('circle')}>Circle</button>
      <button data-tool="anchor" onClick={() => chooseTool('anchor')}>Anchor</button>
      <button data-action="flush" onClick={async () => { await ref.current?.flushPendingEdits(); await ref.current?.exportMask(); setMessage('flushed'); }}>Flush</button>
      <button data-overlay="hide" onClick={() => setOverlay((value) => ({ ...value, showMask: !value.showMask }))}>Mask layer</button>
      <button data-overlay="low" onClick={() => setOverlay((value) => ({ ...value, opacity: 0.2 }))}>Opacity 20</button>
      <button data-overlay="full" onClick={() => setOverlay((value) => ({ ...value, opacity: 1 }))}>Opacity 100</button>
      <button data-overlay="magnet" onClick={() => setOverlay((value) => ({ ...value, magnet: !value.magnet }))}>Magnet</button>
    </div>
    <p>Mode={mode}; tool={tool}; masks={polygons.length}; holes={polygons.reduce((n, p) => n + (p.holes?.length ?? 0), 0)}; center filled={String(polygons.some((p) => pointInMask({ x: 400, y: 250 }, p)))}; zoom={zoom.toFixed(4)}</p>
    <p data-testid="history">history local={String(history.local)}; canUndo={String(history.canUndo)}; canRedo={String(history.canRedo)}; last={polygons.at(-1)?.label ?? '-'}:{polygons.at(-1)?.nodes.length ?? 0}; selected={selected.length}; totalNodes={polygons.reduce((sum, polygon) => sum + polygon.nodes.length, 0)}; maxNodes={polygons.reduce((max, polygon) => Math.max(max, polygon.nodes.length + (polygon.holes ?? []).reduce((sum, hole) => sum + hole.length, 0)), 0)}</p>
    <p>{message} {exported}</p>
    <div className="editor-shell" style={{ width: 900, height: 580 }}>
      <div className="editor-main" style={{ position: 'relative', width: '100%', height: '100%' }}>
        {scene
          ? <EditorCanvas ref={ref} width={scene.width} height={scene.height} imageUrl={scene.photo} predictionUrl={scene.mask}
            initialHumanAction={scene.operations.length ? 'MODIFIED' : 'UNTOUCHED'} initialBreakpoints={breaks} initialOperations={scene.operations}
            tool={tool} brushMode={mode} brushSize={mode === 'add' ? 40 : 20} maskOpacity={overlay.opacity} showMask={overlay.showMask} magnet={overlay.magnet}
            onChange={change} onSelectionChange={setSelected} onHistoryChange={setHistory} onReady={noop} onMessage={setMessage} onZoomChange={setZoom} />
          : <EditorCanvas ref={ref} width={800} height={500} imageUrl={image} predictionUrl={blank}
            initialHumanAction="MODIFIED" initialBreakpoints={breaks} initialOperations={operations}
            tool={tool} brushMode={mode} brushSize={mode === 'add' ? 12 : 1} maskOpacity={overlay.opacity} showMask={overlay.showMask} magnet={overlay.magnet}
            onChange={change} onSelectionChange={setSelected} onHistoryChange={setHistory} onReady={noop} onMessage={setMessage} onZoomChange={setZoom} />}
      </div>
    </div>
  </main>;
}

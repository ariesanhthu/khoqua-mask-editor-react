'use client';

import { useCallback, useRef, useState } from 'react';
import EditorCanvas, { type EditorCanvasHandle, type EditorCanvasSnapshot } from '@/components/editor-canvas';
import { pointInMask } from '@/lib/polygon-geometry';
import type { AnnotationPolygon, MaskOperation } from '@/types';

const noop = () => {};
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="white"/><path d="M400 240v20m-10-10h20" stroke="black"/></svg>');
const blank = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"/>');
const initial: AnnotationPolygon[] = [200, 550].map((x, i) => ({ id: String(i), label: 'r' + (i + 1), nodes: [[x, 100], [x + 50, 100], [x + 50, 400], [x, 400]].map(([x, y], j) => ({ id: i + '-' + j, x, y })) }));
const operations: MaskOperation[] = [{ type: 'POLYGON_SET', polygons: initial }];
const breaks = { state: 'NOT_ANNOTATED' as const, points: [] };

export default function BrowserCheck() {
  const ref = useRef<EditorCanvasHandle>(null);
  const [polygons, setPolygons] = useState(initial);
  const [mode, setMode] = useState<'add' | 'erase'>('add');
  const [message, setMessage] = useState('');
  const [zoom, setZoom] = useState(1);
  const [exported, setExported] = useState('');
  const change = useCallback((snapshot: EditorCanvasSnapshot) => setPolygons(snapshot.polygons), []);
  const inspectExport = async () => {
    const blob = await ref.current!.exportMask();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 500;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
    setExported('PNG center alpha=' + ctx.getImageData(400, 250, 1, 1).data[3] + '; mask alpha=' + ctx.getImageData(220, 250, 1, 1).data[3]);
  };
  return <main style={{ padding: 12 }}>
    <h1>Canvas browser check — synthetic data only</h1>
    <div style={{ display: 'flex', gap: 20, padding: 12 }}>
      <button onClick={() => setMode('add')}>Add 12 px</button>
      <button onClick={() => setMode('erase')}>Erase 1 px</button>
      <button onClick={() => ref.current?.undo()}>Undo</button>
      <button onClick={() => ref.current?.redo()}>Redo</button>
      <button onClick={() => ref.current?.fit()}>Fit</button>
      <button onClick={inspectExport}>Check PNG</button>
    </div>
    <p>Mode={mode}; masks={polygons.length}; holes={polygons.reduce((n, p) => n + (p.holes?.length ?? 0), 0)}; center filled={String(polygons.some((p) => pointInMask({ x: 400, y: 250 }, p)))}; zoom={zoom.toFixed(4)}</p>
    <p>{message} {exported}</p>
    <div className="editor-shell" style={{ width: 900, height: 580 }}>
      <div className="editor-main" style={{ position: 'relative', width: '100%', height: '100%' }}>
        <EditorCanvas ref={ref} width={800} height={500} imageUrl={image} predictionUrl={blank}
          initialHumanAction="MODIFIED" initialBreakpoints={breaks} initialOperations={operations}
          tool="brush" brushMode={mode} brushSize={mode === 'add' ? 12 : 1} maskOpacity={0.5} showMask
          onChange={change} onSelectionChange={noop} onReady={noop} onMessage={setMessage} onZoomChange={setZoom} />
      </div>
    </div>
  </main>;
}

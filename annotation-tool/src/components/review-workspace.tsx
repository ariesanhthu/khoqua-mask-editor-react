'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AnnotationPolygon, AnnotationState, ApiError, BreakpointAnnotation, EditorBootstrap, MaskOperation, ReviewDecision } from '@/types';
import { getEditorData, getFiles, reviewFile } from '@/lib/api-client';
import { reviewLabelSummary, type OverlayColorMode } from '@/lib/review-colors';
import CanvasMinimap from './canvas-minimap';
import EditorCanvas, { type CanvasViewInfo, type EditorCanvasHandle } from './editor-canvas';
import { ANNOTATION_STATE_LABELS as STATE_LABELS, readStoredColorMode, ReviewColorModes, ReviewLegend, storeColorMode } from './review-color-controls';

/**
 * Trang duyệt theo ảnh (người dùng xác nhận 2026-11-17; lớp phủ duyệt yêu cầu 2026-11-24).
 * Chỉ xem: đọc bootstrap `GET /api/files/:id/editor` (đã kiểm quyền), KHÔNG xin khóa, không heartbeat, không ghi
 * IndexedDB, canvas luôn `readOnly` + công cụ di chuyển. Kết luận Đạt / Cần sửa gắn với revision đang xem.
 */

const emptyBreakpoints: BreakpointAnnotation = { state: 'NOT_ANNOTATED', points: [] };
const noop = () => undefined;

function operationsOf(data: EditorBootstrap): MaskOperation[] {
  return data.annotation ? data.annotation.segmentation.maskOperations ?? [] : data.prelabelOperations ?? [];
}

function polygonsOf(operations: MaskOperation[]): AnnotationPolygon[] {
  // Nét brush cũ sau POLYGON_SET cuối thì polygon đã lỗi thời: canvas hiện raster đã lưu (một màu).
  const last = operations.at(-1);
  return last?.type === 'POLYGON_SET' ? last.polygons : [];
}

export default function ReviewWorkspace({ fileId }: { fileId: string }) {
  const router = useRouter();
  const canvasRef = useRef<EditorCanvasHandle>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const [bootstrap, setBootstrap] = useState<EditorBootstrap | null>(null);
  const [loadError, setLoadError] = useState('');
  const [ready, setReady] = useState(false);
  const [colorMode, setColorMode] = useState<OverlayColorMode>(readStoredColorMode);
  const [showMask, setShowMask] = useState(true);
  const [opacity, setOpacity] = useState(() => {
    if (typeof window === 'undefined') return 0.5;
    const stored = Number(localStorage.getItem('mask-opacity'));
    return Number.isFinite(stored) && stored >= 0.1 && stored <= 1 ? stored : 0.5;
  });
  const [canvasView, setCanvasView] = useState<CanvasViewInfo | null>(null);
  const [deciding, setDeciding] = useState<ReviewDecision | null>(null);
  const [outcome, setOutcome] = useState<AnnotationState | null>(null);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [findingNext, setFindingNext] = useState(false);

  useEffect(() => {
    let active = true;
    void getEditorData(fileId)
      .then((data) => { if (active) setBootstrap(data); })
      .catch((reason: ApiError) => { if (active) setLoadError(reason.message || 'Không tải được ảnh để duyệt.'); });
    return () => { active = false; };
  }, [fileId]);

  const operations = useMemo(() => (bootstrap ? operationsOf(bootstrap) : []), [bootstrap]);
  const summary = useMemo(() => reviewLabelSummary(polygonsOf(operations)), [operations]);

  const chooseMode = (mode: OverlayColorMode) => {
    setColorMode(mode);
    setShowMask(true);
    storeColorMode(mode);
  };
  const changeOpacity = (value: number) => {
    setOpacity(value);
    localStorage.setItem('mask-opacity', String(value));
  };
  const updateZoomLabel = useCallback((scale: number) => {
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(scale * 100)}%`;
  }, []);
  const onReady = useCallback(() => setReady(true), []);

  const state = (outcome ?? bootstrap?.annotation?.status ?? 'UNSTARTED') as AnnotationState;
  const revision = bootstrap?.annotation?.revision ?? 0;
  const canDecide = Boolean(bootstrap?.annotation) && bootstrap?.annotation?.status === 'REVIEW' && !outcome && !stale;

  const decide = async (decision: ReviewDecision) => {
    setDeciding(decision);
    setError('');
    try {
      const result = await reviewFile(fileId, decision, revision);
      setOutcome(result.annotationState);
    } catch (reason) {
      const apiError = reason as ApiError;
      setError(apiError.message || 'Không lưu được kết luận duyệt. Hãy thử lại.');
      // Ảnh đã đổi/không còn chờ duyệt: kết luận trên bản đang xem không còn đúng, phải tải lại.
      if (apiError.code === 'REVISION_CONFLICT' || apiError.code === 'NOT_IN_REVIEW') setStale(true);
    } finally {
      setDeciding(null);
    }
  };

  const openNextReview = async () => {
    if (!bootstrap) return;
    setFindingNext(true);
    setError('');
    try {
      const result = await getFiles(bootstrap.file.projectId, { annotationState: 'REVIEW', lockState: 'AVAILABLE', page: '1', pageSize: '100' });
      const next = result.items.find((file) => file.id !== fileId && file.assetState === 'READY');
      if (next) router.push(`/review/${next.id}`);
      else setError('Không còn ảnh nào chờ duyệt (trong phạm vi bạn được giao) mà không ai đang mở.');
    } catch {
      setError('Không tìm được ảnh chờ duyệt tiếp theo. Hãy thử lại.');
    } finally {
      setFindingNext(false);
    }
  };

  if (loadError) {
    return (
      <main className="editor-shell review-shell review-message">
        <section className="decision-card">
          <h2>Không mở được trang duyệt</h2>
          <p>{loadError}</p>
          <button className="button primary" type="button" onClick={() => router.push('/')}>Về trang chủ</button>
        </section>
      </main>
    );
  }
  if (!bootstrap) {
    return <main className="editor-shell review-shell review-message"><p role="status">Đang tải ảnh để duyệt…</p></main>;
  }

  return (
    <main className="editor-shell review-shell">
      <div className="review-layout">
        <section className="editor-main" aria-label="Ảnh và mask đang duyệt">
          <div className="canvas-statusbar">
            <button type="button" className="review-back" title="Về trang chủ" onClick={() => router.push('/')}>← Home</button>
            <span className="canvas-file"><span className="queue-dot" />{bootstrap.file.externalKey}</span>
            <span className="save-indicator">Chỉ xem · {STATE_LABELS[state]}</span>
          </div>
          <div className="canvas-control-stack">
            <div className="viewport-zoom" aria-label="Điều khiển thu phóng">
              <button type="button" aria-label="Phóng to" title="Phóng to" onClick={() => canvasRef.current?.zoomBy(1.2)}>＋</button>
              <span ref={zoomLabelRef}>100%</span>
              <button type="button" aria-label="Thu nhỏ" title="Thu nhỏ" onClick={() => canvasRef.current?.zoomBy(1 / 1.2)}>−</button>
              <button type="button" aria-label="Vừa khung hình" title="Vừa khung hình" onClick={() => canvasRef.current?.fit()}>⤢</button>
            </div>
          </div>
          <EditorCanvas ref={canvasRef} width={bootstrap.file.width} height={bootstrap.file.height}
            imageUrl={bootstrap.assets.imageUrl} predictionUrl={bootstrap.assets.predictionMaskUrl} currentMaskUrl={bootstrap.assets.currentMaskUrl}
            initialHumanAction={bootstrap.annotation?.segmentation.humanAction ?? 'UNTOUCHED'}
            initialBreakpoints={bootstrap.annotation?.segmentation.wartPoints ?? emptyBreakpoints} initialOperations={operations}
            readOnly tool="pan" paintMode="add" maskOpacity={opacity} showMask={showMask} colorMode={colorMode}
            onChange={noop} onSelectionChange={noop} onMessage={noop} onReady={onReady}
            onViewChange={setCanvasView} onZoomChange={updateZoomLabel} />
        </section>

        <aside className="control-panel" aria-label="Duyệt ảnh">
          <div className="control-panel-title"><span>Duyệt ảnh</span>{ready ? null : <small>Đang dựng ảnh…</small>}</div>
          <div className="control-panel-scroll">
            <section className="review-facts">
              <CanvasMinimap imageUrl={bootstrap.assets.imageUrl} imageWidth={bootstrap.file.width} imageHeight={bootstrap.file.height}
                view={canvasView} onPan={(x, y) => canvasRef.current?.panTo(x, y)} />
              <dl>
                <div><dt>Trạng thái</dt><dd><span className={`state-badge ${state.toLowerCase()}`}>{STATE_LABELS[state]}</span></dd></div>
                <div><dt>Revision</dt><dd>{revision}</dd></div>
                <div><dt>Vết gợn (r*)</dt><dd>{summary.ridge.masks} mask · {summary.ridge.labels.length} label</dd></div>
                <div><dt>U vấu (w*)</dt><dd>{summary.wart.masks} mask · {summary.wart.labels.length} label</dd></div>
                {summary.other ? <div><dt>Label khác</dt><dd>{summary.other} mask</dd></div> : null}
              </dl>
              {bootstrap.lockedBy ? <p className="review-note">Đang có người mở ảnh này để sửa ({bootstrap.lockedBy}); chờ họ lưu xong rồi mới kết luận được.</p> : null}
            </section>

            <section className="review-overlay" aria-labelledby="review-overlay-title">
              <div className="section-title-row"><p id="review-overlay-title">Lớp phủ</p>
                <button type="button" className={`layer-toggle ${showMask ? 'active' : ''}`} aria-pressed={showMask} onClick={() => setShowMask((value) => !value)}>
                  {showMask ? 'Đang bật' : 'Đang ẩn'}
                </button>
              </div>
              {/* Tách nhanh vết gợn / u vấu (người dùng yêu cầu 2026-11-24); chỉ đổi màu hiển thị. */}
              <ReviewColorModes mode={colorMode} onChange={chooseMode} />
              <label className="overlay-opacity" title="Độ đậm của mask và đường biên">
                <span>Độ mờ</span>
                <input type="range" min="0.1" max="1" step="0.05" value={opacity} aria-label="Độ mờ lớp phủ (mask và đường biên)" onChange={(event) => changeOpacity(Number(event.target.value))} />
                <strong>{Math.round(opacity * 100)}%</strong>
              </label>
              <ReviewLegend summary={summary} mode={colorMode} />
            </section>

            <section className="review-decision" aria-labelledby="review-decision-title">
              <div className="section-title-row"><p id="review-decision-title">Kết luận</p><span>Theo cả ảnh</span></div>
              {outcome ? (
                <p className={`review-outcome ${outcome === 'DONE' ? 'approved' : 'rejected'}`} role="status">
                  {outcome === 'DONE' ? 'Đã duyệt Đạt: ảnh chuyển sang Hoàn thành.' : 'Đã trả về Cần sửa: ảnh chuyển về Bản nháp để người gán nhãn sửa.'}
                </p>
              ) : bootstrap.annotation?.status !== 'REVIEW' ? (
                <p className="review-note">Ảnh không ở trạng thái Cần review ({STATE_LABELS[state]}) nên không cần kết luận.</p>
              ) : null}
              {error ? <p className="notice warning" role="alert">{error}</p> : null}
              <div className="review-decision-actions">
                <button className="button primary" type="button" disabled={!canDecide || deciding !== null} onClick={() => void decide('APPROVE')}>
                  {deciding === 'APPROVE' ? 'Đang lưu…' : 'Đạt'}
                </button>
                <button className="button ghost danger" type="button" disabled={!canDecide || deciding !== null} onClick={() => void decide('REJECT')}>
                  {deciding === 'REJECT' ? 'Đang lưu…' : 'Cần sửa'}
                </button>
              </div>
              {stale ? <button className="button ghost wide" type="button" onClick={() => window.location.reload()}>Tải lại ảnh</button> : null}
              <div className="review-decision-actions">
                <button className="button secondary" type="button" disabled={findingNext} onClick={() => void openNextReview()}>{findingNext ? 'Đang tìm…' : 'Ảnh cần duyệt tiếp theo →'}</button>
                <button className="button ghost" type="button" onClick={() => router.push(`/editor/${fileId}`)}>Mở trong editor</button>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </main>
  );
}


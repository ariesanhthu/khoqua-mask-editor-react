'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  ApiError,
  BreakpointAnnotation,
  EditorBootstrap,
  HumanAction,
  LocalDraft,
  MaskOperation,
  SyncState,
} from '@/types';
import {
  acquireLock,
  getEditorData,
  releaseLock,
  saveDraft,
  sendHeartbeat,
  submitDone,
  uploadMask,
} from '@/lib/api-client';
import { deleteLocalDraft, draftKey, getLocalDraft, putLocalDraft } from '@/lib/local-drafts';
import EditorCanvas, {
  type EditorCanvasHandle,
  type EditorCanvasSnapshot,
  type EditorTool,
} from './editor-canvas';

type SaveStatus = 'SAVED' | 'SAVING' | 'OFFLINE' | 'SYNCING' | 'CONFLICT';

interface EditorSeed {
  key: number;
  humanAction: HumanAction;
  breakpoints: BreakpointAnnotation;
  operations: MaskOperation[];
  localMaskBlob?: Blob;
}

const emptyBreakpoints: BreakpointAnnotation = { state: 'NOT_ANNOTATED', points: [] };

export default function EditorWorkspace({ fileId, userId, displayName }: { fileId: string; userId: string; displayName: string }) {
  const router = useRouter();
  const canvasRef = useRef<EditorCanvasHandle>(null);
  const [bootstrap, setBootstrap] = useState<EditorBootstrap | null>(null);
  const [seed, setSeed] = useState<EditorSeed | null>(null);
  const [loadError, setLoadError] = useState('');
  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState<EditorTool>(() => {
    if (typeof window === 'undefined') return 'add';
    const stored = localStorage.getItem('editor-tool') as EditorTool | null;
    return stored && ['add', 'erase', 'point', 'pan'].includes(stored) ? stored : 'add';
  });
  const [brushSize, setBrushSize] = useState(28);
  const [opacity, setOpacity] = useState(() => {
    if (typeof window === 'undefined') return 0.5;
    const stored = Number(localStorage.getItem('mask-opacity'));
    return Number.isFinite(stored) && stored >= 0.1 && stored <= 1 ? stored : 0.5;
  });
  const [showMask, setShowMask] = useState(true);
  const [comparePrediction, setComparePrediction] = useState(false);
  const [snapshot, setSnapshot] = useState<EditorCanvasSnapshot>({
    humanAction: 'UNTOUCHED', breakpoints: emptyBreakpoints, maskOperations: [],
  });
  const snapshotRef = useRef(snapshot);
  const revisionRef = useRef(0);
  const projectIdRef = useRef('');
  const [status, setStatus] = useState<SaveStatus>('SAVED');
  const [toast, setToast] = useState('');
  const [conflict, setConflict] = useState<{ serverRevision: number; localDraft: LocalDraft } | null>(null);
  const [conflictMinimized, setConflictMinimized] = useState(false);
  const conflictRef = useRef(false);
  const dirtyVersionRef = useRef(0);
  const syncedVersionRef = useRef(0);
  const localTimerRef = useRef<number | null>(null);
  const serverTimerRef = useRef<number | null>(null);
  const syncPromiseRef = useRef<Promise<boolean> | null>(null);

  const createServerSeed = useCallback((data: EditorBootstrap): EditorSeed => ({
    key: Date.now(),
    humanAction: data.annotation?.segmentation.humanAction || 'UNTOUCHED',
    breakpoints: data.annotation?.breakpoints || emptyBreakpoints,
    operations: data.annotation?.segmentation.maskOperations || [],
  }), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const lock = await acquireLock(fileId);
        const data = await getEditorData(fileId);
        if (cancelled) return;
        data.lock.lockToken = lock.lockToken;
        revisionRef.current = lock.baseRevision;
        projectIdRef.current = data.file.projectId;
        const local = await getLocalDraft(data.file.projectId, fileId, userId);
        const serverSeed = createServerSeed(data);
        setBootstrap(data);

        if (local && local.baseServerRevision === lock.baseRevision && local.syncState !== 'SYNCED') {
          const recovered: EditorSeed = {
            key: Date.now(), humanAction: local.humanAction,
            breakpoints: local.breakpoints, operations: local.maskOperations || [],
            localMaskBlob: local.maskSnapshotBlob,
          };
          setSeed(recovered);
          setSnapshot({ humanAction: recovered.humanAction, breakpoints: recovered.breakpoints, maskOperations: recovered.operations });
          snapshotRef.current = { humanAction: recovered.humanAction, breakpoints: recovered.breakpoints, maskOperations: recovered.operations };
          dirtyVersionRef.current = 1;
          setToast('Đã khôi phục phần việc chưa đồng bộ trên thiết bị này.');
          setStatus(navigator.onLine ? 'SAVING' : 'OFFLINE');
        } else if (local && local.baseServerRevision !== lock.baseRevision && local.syncState !== 'SYNCED') {
          const localSeed: EditorSeed = {
            key: Date.now(), humanAction: local.humanAction,
            breakpoints: local.breakpoints, operations: local.maskOperations || [], localMaskBlob: local.maskSnapshotBlob,
          };
          setSeed(localSeed);
          setSnapshot({ humanAction: localSeed.humanAction, breakpoints: localSeed.breakpoints, maskOperations: localSeed.operations });
          snapshotRef.current = { humanAction: localSeed.humanAction, breakpoints: localSeed.breakpoints, maskOperations: localSeed.operations };
          conflictRef.current = true; setConflictMinimized(false); setConflict({ serverRevision: lock.baseRevision, localDraft: local }); setStatus('CONFLICT');
        } else {
          setSeed(serverSeed);
          const serverSnapshot = { humanAction: serverSeed.humanAction, breakpoints: serverSeed.breakpoints, maskOperations: serverSeed.operations };
          setSnapshot(serverSnapshot); snapshotRef.current = serverSnapshot;
        }
      } catch (error) {
        const apiError = error as ApiError;
        setLoadError(apiError.code === 'FILE_LOCKED'
          ? `Tệp đang được ${String((apiError.lockedBy as { displayName?: string })?.displayName || 'người khác')} chỉnh sửa.`
          : apiError.message || 'Không thể mở tệp.');
      }
    })();
    return () => { cancelled = true; };
  }, [createServerSeed, fileId, userId]);

  const persistLocal = useCallback(async (syncState: SyncState = 'DIRTY') => {
    if (!bootstrap || !canvasRef.current) return;
    const maskSnapshotBlob = await canvasRef.current.exportMask();
    const current = snapshotRef.current;
    await putLocalDraft({
      key: draftKey(bootstrap.file.projectId, fileId, userId),
      projectId: bootstrap.file.projectId,
      fileId,
      userId,
      baseServerRevision: revisionRef.current,
      humanAction: current.humanAction,
      maskSnapshotBlob,
      maskOperations: current.maskOperations,
      breakpoints: current.breakpoints,
      updatedAt: Date.now(),
      syncState,
    });
  }, [bootstrap, fileId, userId]);

  const syncNow = useCallback(async (): Promise<boolean> => {
    if (!bootstrap || !canvasRef.current || conflictRef.current) return false;
    if (!navigator.onLine) {
      setStatus('OFFLINE');
      await persistLocal('DIRTY').catch(() => undefined);
      return false;
    }
    if (syncPromiseRef.current) return syncPromiseRef.current;
    if (dirtyVersionRef.current === syncedVersionRef.current) return true;

    const syncingVersion = dirtyVersionRef.current;
    const task = (async () => {
      setStatus('SYNCING');
      try {
        const current = snapshotRef.current;
        let maskUploadRef: string | undefined;
        if (current.humanAction === 'MODIFIED') {
          maskUploadRef = (await uploadMask(fileId, await canvasRef.current!.exportMask())).maskUploadRef;
        }
        const result = await saveDraft(fileId, {
          baseRevision: revisionRef.current,
          segmentation: {
            humanAction: current.humanAction,
            maskUploadRef,
            maskOperations: current.maskOperations,
          },
          breakpoints: current.breakpoints,
        });
        revisionRef.current = result.revision;
        syncedVersionRef.current = syncingVersion;
        await persistLocal(dirtyVersionRef.current === syncingVersion ? 'SYNCED' : 'DIRTY');
        setStatus(dirtyVersionRef.current === syncingVersion ? 'SAVED' : 'SAVING');
        return true;
      } catch (error) {
        const apiError = error as ApiError;
        await persistLocal(apiError.code === 'REVISION_CONFLICT' || apiError.code === 'LOCK_LOST' ? 'CONFLICT' : 'DIRTY').catch(() => undefined);
        if (apiError.code === 'REVISION_CONFLICT' || apiError.code === 'LOCK_LOST') {
          conflictRef.current = true;
          const local = await getLocalDraft(bootstrap.file.projectId, fileId, userId);
          if (local) { setConflictMinimized(false); setConflict({ serverRevision: Number(apiError.serverRevision ?? revisionRef.current), localDraft: local }); }
          setStatus('CONFLICT');
        } else {
          setStatus(navigator.onLine ? 'SAVING' : 'OFFLINE');
        }
        return false;
      } finally {
        syncPromiseRef.current = null;
      }
    })();
    syncPromiseRef.current = task;
    return task;
  }, [bootstrap, fileId, persistLocal, userId]);

  const onEditorChange = useCallback((next: EditorCanvasSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
    dirtyVersionRef.current += 1;
    if (!conflictRef.current) setStatus(navigator.onLine ? 'SAVING' : 'OFFLINE');
    if (localTimerRef.current) window.clearTimeout(localTimerRef.current);
    localTimerRef.current = window.setTimeout(() => void persistLocal('DIRTY'), 350);
    if (serverTimerRef.current) window.clearTimeout(serverTimerRef.current);
    serverTimerRef.current = window.setTimeout(() => void syncNow(), 3000);
  }, [persistLocal, syncNow]);

  useEffect(() => {
    if (!bootstrap) return;
    const maximumInterval = window.setInterval(() => void syncNow(), 15_000);
    const heartbeatInterval = window.setInterval(async () => {
      try { await sendHeartbeat(fileId); }
      catch {
        await persistLocal('CONFLICT').catch(() => undefined);
        conflictRef.current = true; setStatus('CONFLICT');
        const local = await getLocalDraft(bootstrap.file.projectId, fileId, userId);
        if (local) { setConflictMinimized(false); setConflict({ serverRevision: revisionRef.current, localDraft: local }); }
      }
    }, 25_000);
    const onOffline = () => setStatus('OFFLINE');
    const onOnline = () => { if (!conflictRef.current) void syncNow(); };
    window.addEventListener('offline', onOffline); window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(maximumInterval); window.clearInterval(heartbeatInterval);
      window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline);
    };
  }, [bootstrap, fileId, persistLocal, syncNow, userId]);

  const goBack = async () => {
    await persistLocal('DIRTY').catch(() => undefined);
    await syncNow().catch(() => false);
    await releaseLock(fileId).catch(() => undefined);
    router.push('/');
  };

  const finish = async () => {
    const current = snapshotRef.current;
    if (current.humanAction === 'UNTOUCHED') {
      setToast('Hãy chấp nhận mặt nạ gợi ý hoặc chỉnh sửa mặt nạ trước.'); return;
    }
    if (current.breakpoints.state === 'NOT_ANNOTATED') {
      setToast('Hãy đánh dấu điểm đứt gãy hoặc xác nhận ảnh không có điểm đứt gãy.'); return;
    }
    setStatus('SYNCING');
    try {
      await persistLocal('DIRTY');
      const synchronized = await syncNow();
      if (!synchronized && conflictRef.current) return;
      let maskUploadRef: string | undefined;
      if (current.humanAction === 'MODIFIED') {
        maskUploadRef = (await uploadMask(fileId, await canvasRef.current!.exportMask())).maskUploadRef;
      }
      await submitDone(fileId, {
        baseRevision: revisionRef.current,
        annotation: { segmentation: { humanAction: current.humanAction, maskUploadRef }, breakpoints: current.breakpoints },
      });
      await deleteLocalDraft(bootstrap!.file.projectId, fileId, userId);
      router.push('/');
    } catch (error) {
      const apiError = error as ApiError;
      setToast(apiError.message || 'Không thể hoàn tất. Phần việc vẫn được lưu trên thiết bị.');
      setStatus(apiError.code === 'REVISION_CONFLICT' || apiError.code === 'LOCK_LOST' ? 'CONFLICT' : 'SAVING');
    }
  };

  const showLatest = async () => {
    if (!bootstrap) return;
    const lock = await acquireLock(fileId);
    const latest = await getEditorData(fileId);
    revisionRef.current = lock.baseRevision;
    setBootstrap(latest);
    await deleteLocalDraft(bootstrap.file.projectId, fileId, userId);
    const serverSeed = createServerSeed(latest);
    setSeed({ ...serverSeed, key: Date.now() });
    const next = { humanAction: serverSeed.humanAction, breakpoints: serverSeed.breakpoints, maskOperations: serverSeed.operations };
    snapshotRef.current = next; setSnapshot(next);
    dirtyVersionRef.current = 0; syncedVersionRef.current = 0;
    conflictRef.current = false; setConflict(null); setConflictMinimized(false); setStatus('SAVED');
  };

  const onCanvasReady = useCallback(() => setReady(true), []);

  const saveConflictAsVersion = async () => {
    if (!conflict || !canvasRef.current || !bootstrap) return;
    setStatus('SYNCING');
    try {
      const lock = await acquireLock(fileId);
      revisionRef.current = lock.baseRevision;
      const current = snapshotRef.current;
      const maskUploadRef = current.humanAction === 'MODIFIED'
        ? (await uploadMask(fileId, await canvasRef.current.exportMask())).maskUploadRef
        : undefined;
      await submitDone(fileId, {
        baseRevision: lock.baseRevision,
        annotation: { segmentation: { humanAction: current.humanAction === 'UNTOUCHED' ? 'MODIFIED' : current.humanAction, maskUploadRef }, breakpoints: current.breakpoints },
      });
      await deleteLocalDraft(bootstrap.file.projectId, fileId, userId);
      router.push('/');
    } catch (error) {
      setToast((error as ApiError).message || 'Chưa thể lưu phiên bản của bạn. Bản cục bộ vẫn được giữ nguyên.');
      setStatus('CONFLICT');
    }
  };

  if (loadError) return <div className="center-state"><div className="panel"><h1>Không thể mở tệp</h1><p>{loadError}</p><button className="button primary" onClick={() => router.push('/')}>Về danh sách</button></div></div>;
  if (!bootstrap || !seed) return <div className="center-state"><div className="loader" /><p>Đang xác nhận quyền chỉnh sửa…</p></div>;

  return (
    <main className="editor-shell">
      <header className="editor-header">
        <button className="button ghost" onClick={() => void goBack()}>← Danh sách</button>
        <div><p className="eyebrow">Đang chỉnh sửa</p><h1>{bootstrap.file.externalKey}</h1></div>
        <div className="editor-meta"><span>{displayName}</span><SaveIndicator status={status} /></div>
      </header>

      <div className="editor-layout">
        <aside className="task-rail panel">
          <p className="rail-title">Công cụ</p>
          <ToolButton active={tool === 'add'} label="Thêm vùng" icon="＋" onClick={() => { setTool('add'); localStorage.setItem('editor-tool', 'add'); }} />
          <ToolButton active={tool === 'erase'} label="Xóa vùng" icon="−" onClick={() => { setTool('erase'); localStorage.setItem('editor-tool', 'erase'); }} />
          <ToolButton active={tool === 'point'} label="Điểm đứt" icon="●" onClick={() => { setTool('point'); localStorage.setItem('editor-tool', 'point'); }} />
          <ToolButton active={tool === 'pan'} label="Di chuyển" icon="✥" onClick={() => { setTool('pan'); localStorage.setItem('editor-tool', 'pan'); }} />
          <div className="rail-divider" />
          <ToolButton label="Hoàn tác" icon="↶" onClick={() => canvasRef.current?.undo()} />
          <ToolButton label="Làm lại" icon="↷" onClick={() => canvasRef.current?.redo()} />
        </aside>

        <section className="editor-main">
          <div className="canvas-toolbar">
            <button onClick={() => canvasRef.current?.zoomBy(1.2)}>＋</button>
            <button onClick={() => canvasRef.current?.zoomBy(1 / 1.2)}>−</button>
            <button onClick={() => canvasRef.current?.fit()}>Vừa màn hình</button>
            <button onClick={() => void document.querySelector('.editor-main')?.requestFullscreen()}>Toàn màn hình</button>
            <label><input type="checkbox" checked={showMask} onChange={(event) => setShowMask(event.target.checked)} /> Hiện mặt nạ</label>
            <label><input type="checkbox" checked={comparePrediction} onChange={(event) => setComparePrediction(event.target.checked)} /> Xem gợi ý</label>
          </div>
          <EditorCanvas key={seed.key} ref={canvasRef} width={bootstrap.file.width} height={bootstrap.file.height}
            imageUrl={bootstrap.assets.imageUrl} predictionUrl={bootstrap.assets.predictionMaskUrl}
            currentMaskUrl={bootstrap.assets.currentMaskUrl} localMaskBlob={seed.localMaskBlob}
            initialHumanAction={seed.humanAction} initialBreakpoints={seed.breakpoints} initialOperations={seed.operations}
            tool={tool} brushSize={brushSize} maskOpacity={opacity} showMask={showMask}
            comparePrediction={comparePrediction} onChange={onEditorChange} onReady={onCanvasReady} />
        </section>

        <aside className="control-panel panel">
          <section><p className="eyebrow">Mặt nạ</p><h2>Kiểm tra vùng vân</h2>
            <button className="button success wide" onClick={() => canvasRef.current?.acceptPrediction()}>Chấp nhận gợi ý</button>
            <button className="button secondary wide" onClick={() => canvasRef.current?.resetToPrediction()}>Đặt lại theo gợi ý</button>
            <label className="range-field"><span>Cỡ cọ <strong>{brushSize}px</strong></span><input type="range" min="4" max="120" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /></label>
            <label className="range-field"><span>Độ trong <strong>{Math.round(opacity * 100)}%</strong></span><input type="range" min="0.1" max="1" step="0.05" value={opacity} onChange={(event) => { const value = Number(event.target.value); setOpacity(value); localStorage.setItem('mask-opacity', String(value)); }} /></label>
          </section>
          <section><p className="eyebrow">Điểm đứt gãy</p><h2>{snapshot.breakpoints.points.length} điểm</h2>
            <p className="helper">Chọn “Điểm đứt”, bấm để thêm, kéo để di chuyển. Chọn điểm rồi nhấn Delete để xóa.</p>
            <button className="button secondary wide" onClick={() => canvasRef.current?.deleteSelectedPoint()}>Xóa điểm đang chọn</button>
            <button className="button warning wide" onClick={() => canvasRef.current?.confirmNoBreakpoint()}>Không có điểm đứt gãy</button>
          </section>
        </aside>
      </div>

      <footer className="editor-footer">
        <span>{ready ? 'Ảnh đã sẵn sàng' : 'Đang tải ảnh…'}</span>
        <div><button className="button secondary" onClick={() => void syncNow()}>Lưu bản nháp</button><button className="button primary" disabled={!ready || status === 'SYNCING'} onClick={() => void finish()}>Hoàn tất</button></div>
      </footer>

      {toast ? <button className="toast" onClick={() => setToast('')}>{toast}</button> : null}
      {conflict && conflictMinimized ? <button className="conflict-chip" onClick={() => setConflictMinimized(false)}>Có xung đột — mở lựa chọn xử lý</button> : null}
      {conflict && !conflictMinimized ? <div className="modal-backdrop"><div className="conflict-dialog panel" role="dialog" aria-modal="true">
        <p className="eyebrow">Cần bạn quyết định</p><h2>Tệp đã được cập nhật ở nơi khác</h2>
        <p>Phần việc của bạn vẫn an toàn trên thiết bị này. Hệ thống sẽ không tự ghi đè bất kỳ phiên bản nào.</p>
        <div className="conflict-actions">
          <button className="button secondary" onClick={() => setConflictMinimized(true)}>Xem bản của tôi</button>
          <button className="button secondary" onClick={() => void showLatest()}>Bỏ bản của tôi, xem bản mới nhất</button>
          <button className="button primary" onClick={() => void saveConflictAsVersion()}>Lưu bản của tôi thành phiên bản mới</button>
        </div>
      </div></div> : null}
    </main>
  );
}

function ToolButton({ active = false, icon, label, onClick }: { active?: boolean; icon: string; label: string; onClick(): void }) {
  return <button className={`tool-button ${active ? 'active' : ''}`} onClick={onClick}><span>{icon}</span><small>{label}</small></button>;
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const copy = { SAVED: 'Đã lưu', SAVING: 'Đang chờ lưu…', OFFLINE: 'Ngoại tuyến — đã lưu trên máy', SYNCING: 'Đang đồng bộ…', CONFLICT: 'Có xung đột' };
  return <span className={`save-indicator ${status.toLowerCase()}`}>{copy[status]}</span>;
}

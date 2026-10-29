'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AnnotationPolygon,
  ApiError,
  BreakpointAnnotation,
  EditorBootstrap,
  FileListItem,
  HumanAction,
  LocalDraft,
  MaskOperation,
  SyncState,
} from '@/types';
import {
  acquireLock,
  getFiles,
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
  type EditorHistoryState,
  type EditorCanvasSnapshot,
  type EditorTool,
} from './editor-canvas';

type SaveStatus = 'LOCAL' | 'SAVED' | 'SAVING' | 'OFFLINE' | 'SYNCING' | 'CONFLICT';
type WorkspaceStep = 'mask' | 'warts';

interface EditorSeed {
  key: number;
  humanAction: HumanAction;
  breakpoints: BreakpointAnnotation;
  operations: MaskOperation[];
  localMaskBlob?: Blob;
}

const emptyBreakpoints: BreakpointAnnotation = { state: 'NOT_ANNOTATED', points: [] };

function polygonsFromOperations(operations: MaskOperation[]): AnnotationPolygon[] {
  const polygonOperation = [...operations].reverse().find((operation) => operation.type === 'POLYGON_SET');
  return polygonOperation?.type === 'POLYGON_SET' ? polygonOperation.polygons : [];
}

async function claimNextAvailableFile(projectId: string, currentFileId: string, userId: string) {
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const result = await getFiles(projectId, {
      lockState: 'AVAILABLE',
      page: String(page),
      pageSize: String(pageSize),
    });
    const candidates = result.items
      .filter((file) => file.id !== currentFileId
        && file.annotationState !== 'DONE'
        && file.assetState === 'READY'
        && (!file.assignment || file.assignment.userId === userId))
      .sort((left, right) => {
        const leftPriority = left.assignment?.userId === userId ? 0 : 1;
        const rightPriority = right.assignment?.userId === userId ? 0 : 1;
        return leftPriority - rightPriority || left.externalKey.localeCompare(right.externalKey);
      });

    for (const candidate of candidates) {
      try {
        await acquireLock(candidate.id);
        return candidate.id;
      } catch (error) {
        const apiError = error as ApiError;
        if (apiError.code !== 'FILE_LOCKED' && apiError.code !== 'ASSET_NOT_FOUND') throw error;
      }
    }
    if (page * pageSize >= result.total) return null;
  }
}

export default function EditorWorkspace({ fileId, userId, displayName }: { fileId: string; userId: string; displayName: string }) {
  const router = useRouter();
  const canvasRef = useRef<EditorCanvasHandle>(null);
  const [bootstrap, setBootstrap] = useState<EditorBootstrap | null>(null);
  const [seed, setSeed] = useState<EditorSeed | null>(null);
  const [loadError, setLoadError] = useState('');
  const [ready, setReady] = useState(false);
  const [readOnly, setReadOnly] = useState(true);
  const [queue, setQueue] = useState<FileListItem[]>([]);
  const [queuePage, setQueuePage] = useState(1);
  const [queueTotal, setQueueTotal] = useState(0);
  const [queueError, setQueueError] = useState('');
  const [navigating, setNavigating] = useState(false);
  const legacyBreakpointsRef = useRef<BreakpointAnnotation>(emptyBreakpoints);
  const changeToolRef = useRef<(tool: EditorTool, step?: WorkspaceStep) => void>(() => undefined);
  const [tool, setTool] = useState<EditorTool>(() => {
    if (typeof window === 'undefined') return 'select';
    const stored = localStorage.getItem('editor-tool') as EditorTool | null;
    return stored && ['polygon', 'rectangle', 'circle', 'anchor', 'select', 'cut', 'pan'].includes(stored) ? stored : 'select';
  });
  const [workspaceStep, setWorkspaceStep] = useState<WorkspaceStep>('mask');
  const [opacity, setOpacity] = useState(() => {
    if (typeof window === 'undefined') return 0.5;
    const stored = Number(localStorage.getItem('mask-opacity'));
    return Number.isFinite(stored) && stored >= 0.1 && stored <= 1 ? stored : 0.5;
  });
  const [showMask, setShowMask] = useState(true);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [history, setHistory] = useState<EditorHistoryState>({ local: false, canUndo: false, canRedo: false });
  const onPolygonComplete = useCallback(() => { setTool('select'); localStorage.setItem('editor-tool', 'select'); }, []);
  const [zoom, setZoom] = useState(1);
  const [selectedPolygonIds, setSelectedPolygonIds] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<EditorCanvasSnapshot>({
    humanAction: 'UNTOUCHED', breakpoints: emptyBreakpoints, maskOperations: [], polygons: [],
  });
  const snapshotRef = useRef(snapshot);
  const revisionRef = useRef(0);
  const [status, setStatus] = useState<SaveStatus>('SAVED');
  const [toast, setToast] = useState('');
  const [conflict, setConflict] = useState<{ serverRevision: number; localDraft: LocalDraft } | null>(null);
  const [conflictMinimized, setConflictMinimized] = useState(false);
  const conflictRef = useRef(false);
  const dirtyVersionRef = useRef(0);
  const syncedVersionRef = useRef(0);
  const syncPromiseRef = useRef<Promise<boolean> | null>(null);
  const transitioningFileRef = useRef(false);

  useEffect(() => {
    const onToolShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches('input, select, textarea, [contenteditable="true"]')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'escape') {
        setHelpOpen(false);
      } else if (key === 'v') {
        changeToolRef.current('select', 'mask');
      } else if (key === 'h') {
        changeToolRef.current('pan');
      } else if (key === 'p') {
        changeToolRef.current('polygon', 'mask');
      } else if (key === 'r') {
        changeToolRef.current('rectangle', 'mask');
      } else if (key === 'c') {
        changeToolRef.current('circle', 'mask');
      } else if (key === 'a') {
        changeToolRef.current('anchor', 'mask');
      } else if (key === 'm') {
        // Temporarily hidden: changeToolRef.current('point', 'warts');
      } else if (event.key === '?') {
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onToolShortcut);
    return () => window.removeEventListener('keydown', onToolShortcut);
  }, []);

  const createServerSeed = useCallback((data: EditorBootstrap): EditorSeed => {
    const annotation = data.annotation;
    return {
      key: Date.now(),
      humanAction: annotation ? annotation.segmentation.humanAction : 'UNTOUCHED',
      breakpoints: annotation?.segmentation.wartPoints ?? emptyBreakpoints,
      operations: annotation
        ? annotation.segmentation.maskOperations ?? []
        : data.prelabelOperations ?? [],
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const freshSnapshot: EditorCanvasSnapshot = {
      humanAction: 'UNTOUCHED', breakpoints: emptyBreakpoints, maskOperations: [], polygons: [],
    };
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setReady(false);
      setReadOnly(true);
      setNavigating(false);
      setQueuePage(1);
      setLoadError('');
      setBootstrap(null);
      setSeed(null);
      setSelectedPolygonIds([]);
      setSnapshot(freshSnapshot);
      snapshotRef.current = freshSnapshot;
      dirtyVersionRef.current = 0;
      syncedVersionRef.current = 0;
      conflictRef.current = false;
      transitioningFileRef.current = false;
      setConflict(null);
      setConflictMinimized(false);
      setStatus('SAVED');
      setWorkspaceStep('mask');
      setTool('pan');
      try {
        let lock = null;
        try { lock = await acquireLock(fileId); }
        catch (error) { if ((error as ApiError).code !== 'FILE_LOCKED') throw error; }
        const data = await getEditorData(fileId);
        if (cancelled) return;
        const canEdit = Boolean(lock && !data.readOnly);
        setReadOnly(!canEdit);
        if (!canEdit) setToast(`Chỉ xem · ${data.lockedBy || 'Phiên khác'} đang chỉnh sửa.`);
        revisionRef.current = lock?.baseRevision ?? data.annotation?.revision ?? 0;
        legacyBreakpointsRef.current = data.annotation?.breakpoints ?? emptyBreakpoints;
        const local = canEdit ? await getLocalDraft(data.file.projectId, fileId, userId) : undefined;
        if (cancelled) return;
        if (local && local.syncState !== 'SYNCED') legacyBreakpointsRef.current = local.breakpoints;
        const serverSeed = createServerSeed(data);
        setBootstrap(data);

        if (local && local.baseServerRevision === revisionRef.current && local.syncState !== 'SYNCED') {
          const recovered: EditorSeed = {
            key: Date.now(), humanAction: local.humanAction,
            breakpoints: local.wartPoints ?? emptyBreakpoints, operations: local.maskOperations || [],
            localMaskBlob: local.maskSnapshotBlob,
          };
          setSeed(recovered);
          const recoveredSnapshot = { humanAction: recovered.humanAction, breakpoints: recovered.breakpoints, maskOperations: recovered.operations, polygons: polygonsFromOperations(recovered.operations) };
          setSnapshot(recoveredSnapshot);
          snapshotRef.current = recoveredSnapshot;
          dirtyVersionRef.current = 1;
          setToast('Đã khôi phục phần việc chưa đồng bộ trên thiết bị này.');
          setStatus(navigator.onLine ? 'SAVING' : 'OFFLINE');
        } else if (local && local.baseServerRevision !== revisionRef.current && local.syncState !== 'SYNCED') {
          const localSeed: EditorSeed = {
            key: Date.now(), humanAction: local.humanAction,
            breakpoints: local.wartPoints ?? emptyBreakpoints, operations: local.maskOperations || [], localMaskBlob: local.maskSnapshotBlob,
          };
          setSeed(localSeed);
          const localSnapshot = { humanAction: localSeed.humanAction, breakpoints: localSeed.breakpoints, maskOperations: localSeed.operations, polygons: polygonsFromOperations(localSeed.operations) };
          setSnapshot(localSnapshot);
          snapshotRef.current = localSnapshot;
          conflictRef.current = true; setConflictMinimized(false); setConflict({ serverRevision: revisionRef.current, localDraft: local }); setStatus('CONFLICT');
        } else {
          setSeed(serverSeed);
          const serverSnapshot = { humanAction: serverSeed.humanAction, breakpoints: serverSeed.breakpoints, maskOperations: serverSeed.operations, polygons: polygonsFromOperations(serverSeed.operations) };
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
    if (!bootstrap || readOnly || transitioningFileRef.current) return;
    const current = snapshotRef.current;
    await putLocalDraft({
      key: draftKey(bootstrap.file.projectId, fileId, userId),
      projectId: bootstrap.file.projectId,
      fileId,
      userId,
      baseServerRevision: revisionRef.current,
      humanAction: current.humanAction,
      maskOperations: current.maskOperations,
      breakpoints: legacyBreakpointsRef.current,
      wartPoints: current.breakpoints,
      updatedAt: Date.now(),
      syncState,
    });
  }, [bootstrap, fileId, readOnly, userId]);

  const syncNow = useCallback(async (): Promise<boolean> => {
    if (!bootstrap || !canvasRef.current || conflictRef.current || readOnly) return false;
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
        const maskUploadRef = current.humanAction === 'MODIFIED'
          ? (await uploadMask(fileId, await canvasRef.current!.exportMask())).maskUploadRef : undefined;
        const result = await saveDraft(fileId, {
          baseRevision: revisionRef.current,
          segmentation: {
            humanAction: current.humanAction,
            wartPoints: current.breakpoints,
            maskUploadRef,
            maskOperations: current.maskOperations,
          },
          breakpoints: legacyBreakpointsRef.current,
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
          setStatus(navigator.onLine ? 'LOCAL' : 'OFFLINE');
          setToast(apiError.message || 'Chưa lưu được lên máy chủ. Bản nháp vẫn ở thiết bị.');
        }
        return false;
      } finally {
        syncPromiseRef.current = null;
      }
    })();
    syncPromiseRef.current = task;
    return task;
  }, [bootstrap, fileId, persistLocal, readOnly, userId]);

  const onEditorChange = useCallback((next: EditorCanvasSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
    dirtyVersionRef.current += 1;
    if (!conflictRef.current) setStatus(navigator.onLine ? 'SAVING' : 'OFFLINE');

  }, []);

  useEffect(() => {
    if (!bootstrap || readOnly) return;
    const maximumInterval = window.setInterval(() => {
      if (dirtyVersionRef.current === syncedVersionRef.current || transitioningFileRef.current || syncPromiseRef.current) return;
      void persistLocal(conflictRef.current ? 'CONFLICT' : 'DIRTY')
        .then(() => { if (!conflictRef.current) setStatus('LOCAL'); })
        .catch(() => setToast('Không lưu được bản nháp trên thiết bị. Hãy bấm Lưu để gửi máy chủ.'));
    }, 30_000);
    const heartbeatInterval = window.setInterval(async () => {
      try { await sendHeartbeat(fileId); }
      catch {
        if (transitioningFileRef.current) return;
        await persistLocal('CONFLICT').catch(() => undefined);
        conflictRef.current = true; setStatus('CONFLICT');
        const local = await getLocalDraft(bootstrap.file.projectId, fileId, userId);
        if (local) { setConflictMinimized(false); setConflict({ serverRevision: revisionRef.current, localDraft: local }); }
      }
    }, 30_000);
    const onOffline = () => setStatus('OFFLINE');
    const onOnline = () => { if (!conflictRef.current) setStatus('SAVING'); };
    const onPageHide = () => { void persistLocal(conflictRef.current ? 'CONFLICT' : 'DIRTY'); };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && !transitioningFileRef.current) void syncNow();
    };
    window.addEventListener('offline', onOffline); window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(maximumInterval); window.clearInterval(heartbeatInterval);
      window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [bootstrap, fileId, persistLocal, readOnly, syncNow, userId]);

  const navigateTo = async (destination: string) => {
    if (transitioningFileRef.current || navigating) return;
    setNavigating(true);
    if (!readOnly) {
      await persistLocal('DIRTY').catch(() => undefined);
      if (!await syncNow()) {
        setToast('Chưa lưu được lên máy chủ. Hãy xử lý lỗi trước khi đổi tệp.');
        setNavigating(false);
        return;
      }
    }
    transitioningFileRef.current = true;
    if (!readOnly) await releaseLock(fileId).catch(() => undefined);
    router.push(destination);
  };
  const goBack = () => navigateTo('/');

  useEffect(() => {
    if (!bootstrap) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await getFiles(bootstrap.file.projectId, { page: String(queuePage), pageSize: '50' });
        if (!cancelled) { setQueue(result.items); setQueueTotal(result.total); setQueueError(''); }
      } catch { if (!cancelled) setQueueError('Chưa tải được danh sách tệp.'); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [bootstrap, queuePage]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (readOnly || dirtyVersionRef.current === syncedVersionRef.current) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [readOnly, status]);

  const finish = async () => {
    if (readOnly || navigating || transitioningFileRef.current || conflictRef.current) return;
    const current = snapshotRef.current;
    if (current.humanAction === 'UNTOUCHED') {
      setToast('Hãy chấp nhận mặt nạ gợi ý hoặc chỉnh sửa mặt nạ trước.'); return;
    }
    /* Wart task temporarily hidden; preserve its validation for re-enabling.
    if (current.breakpoints.state === 'NOT_ANNOTATED') {
      setToast('Hãy đánh dấu u vấu hoặc xác nhận ảnh không có u vấu.'); return;
    }
    */
    setNavigating(true);
    setStatus('SYNCING');
    try {
      await persistLocal('DIRTY');
      const synchronized = await syncNow();
      if (!synchronized) { setNavigating(false); return; }
      transitioningFileRef.current = true;
      let maskUploadRef: string | undefined;
      if (current.humanAction === 'MODIFIED') {
        maskUploadRef = (await uploadMask(fileId, await canvasRef.current!.exportMask())).maskUploadRef;
      }
      await submitDone(fileId, {
        baseRevision: revisionRef.current,
        annotation: { segmentation: { wartPoints: current.breakpoints, humanAction: current.humanAction, maskUploadRef, maskOperations: current.maskOperations }, breakpoints: legacyBreakpointsRef.current },
      });
      await deleteLocalDraft(bootstrap!.file.projectId, fileId, userId);
      setToast('Đang mở nhiệm vụ khả dụng tiếp theo…');
      let nextFileId: string | null = null;
      try {
        nextFileId = await claimNextAvailableFile(bootstrap!.file.projectId, fileId, userId);
      } catch {
        router.push('/');
        return;
      }
      if (nextFileId) router.replace(`/editor/${nextFileId}`);
      else router.push('/');
    } catch (error) {
      transitioningFileRef.current = false;
      setNavigating(false);
      const apiError = error as ApiError;
      setToast(apiError.message || 'Không thể hoàn tất. Phần việc vẫn được lưu trên thiết bị.');
      setStatus(apiError.code === 'REVISION_CONFLICT' || apiError.code === 'LOCK_LOST' ? 'CONFLICT' : 'SAVING');
    }
  };

  const showLatest = async () => {
    if (!bootstrap) return;
    const latest = await getEditorData(fileId);
    revisionRef.current = latest.annotation?.revision ?? 0;
    legacyBreakpointsRef.current = latest.annotation?.breakpoints ?? emptyBreakpoints;
    setReadOnly(latest.readOnly);
    setBootstrap(latest);
    await deleteLocalDraft(bootstrap.file.projectId, fileId, userId);
    const serverSeed = createServerSeed(latest);
    setSeed({ ...serverSeed, key: Date.now() });
    const next = { humanAction: serverSeed.humanAction, breakpoints: serverSeed.breakpoints, maskOperations: serverSeed.operations, polygons: polygonsFromOperations(serverSeed.operations) };
    snapshotRef.current = next; setSnapshot(next);
    dirtyVersionRef.current = 0; syncedVersionRef.current = 0;
    conflictRef.current = false; setConflict(null); setConflictMinimized(false); setStatus('SAVED');
  };

  const onCanvasReady = useCallback(() => setReady(true), []);

  const downloadConflict = () => {
    if (!conflict) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(conflict.localDraft, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${fileId}-local-draft.json`; link.click();
    URL.revokeObjectURL(url);
  };

  const flushExplicitly = useCallback(async () => {
    if (readOnly) return true;
    await persistLocal('DIRTY').catch(() => undefined);
    return syncNow();
  }, [persistLocal, readOnly, syncNow]);

  const selectTool = useCallback(async (nextTool: EditorTool, nextStep = workspaceStep) => {
    if (navigating || status === 'SYNCING') return;
    if (nextStep !== workspaceStep && !await flushExplicitly()) return;
    setTool(readOnly ? 'pan' : nextTool);
    setWorkspaceStep(nextStep);
    localStorage.setItem('editor-tool', nextTool);
  }, [flushExplicitly, navigating, readOnly, status, workspaceStep]);
  useEffect(() => { changeToolRef.current = (nextTool, nextStep) => { void selectTool(nextTool, nextStep); }; }, [selectTool]);

  if (loadError) return <div className="center-state"><div className="panel"><h1>Không thể mở tệp</h1><p>{loadError}</p><button className="button primary" onClick={() => router.push('/')}>Về danh sách</button></div></div>;
  if (!bootstrap || !seed) return <div className="center-state"><div className="loader" /><p>Đang xác nhận quyền chỉnh sửa…</p></div>;

  const saveExplicitly = async () => {
    if (await flushExplicitly()) setToast('Đã lưu thay đổi lên máy chủ.');
  };
  const confirmPrediction = async () => {
    canvasRef.current?.acceptPrediction();
    await flushExplicitly();
  };
  const editPredictionAsPolygons = () => {
    canvasRef.current?.beginPolygonEdit();
    selectTool('select', 'mask');
  };
  /* Wart task temporarily hidden.
  const continueToBreakpoints = async () => {
    await selectTool('point', 'warts');
  };
  */
  const returnToMaskStep = async () => {
    await selectTool(tool === 'point' ? 'pan' : tool, 'mask');
  };
  const completePolygon = async () => {
    if (!canvasRef.current?.completePolygon()) return;
    await flushExplicitly();
  };
  const applyCut = async () => {
    if (!canvasRef.current?.applyCut()) return;
    await flushExplicitly();
  };
  /* Wart task temporarily hidden.
  const confirmNoBreakpoint = async () => {
    canvasRef.current?.confirmNoBreakpoint();
    await flushExplicitly();
  };
  */
  const maskConfirmed = snapshot.humanAction !== 'UNTOUCHED';
  const polygonCount = snapshot.polygons.length;
  const selectedPolygons = snapshot.polygons.filter((polygon) => selectedPolygonIds.includes(polygon.id));
  const availableLabels = [...new Set([
    'main_flesh_band',
    'wart_flesh',
    ...snapshot.polygons.map((polygon) => polygon.label).filter(Boolean),
  ])];
  /* Wart task temporarily hidden.
  const breakpointCount = snapshot.breakpoints.points.length;
  const breakpointConfirmed = snapshot.breakpoints.state !== 'NOT_ANNOTATED';
  const breakpointStatus = snapshot.breakpoints.state === 'CONFIRMED_NONE'
    ? 'Đã xác nhận không có point u vấu'
    : breakpointCount > 0
      ? `Đã đánh dấu ${breakpointCount} point u vấu`
      : 'Chưa đánh dấu point u vấu';
  */
  const initials = displayName.split(/\s+/).filter(Boolean).slice(-2).map((part) => part[0]).join('').toUpperCase() || 'U';

  return (
    <main className={`editor-shell ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}>
      <div className="editor-layout">
        <aside className="workspace-sidebar" aria-label="Dự án và tài khoản">
          <button className="sidebar-toggle left" aria-label={leftCollapsed ? 'Mở sidebar trái' : 'Thu gọn sidebar trái'} title={leftCollapsed ? 'Mở sidebar' : 'Thu gọn sidebar'} onClick={() => setLeftCollapsed((value) => !value)}>
            <Icon name={leftCollapsed ? 'chevron-right' : 'chevron-left'} />
          </button>
          <div className="project-summary">
            <button className="project-icon" aria-label="Quay lại danh sách tệp" title="Quay lại danh sách tệp" onClick={() => void goBack()}><Icon name="folder" /></button>
            <div className="sidebar-label">
              <strong>Dự án chú thích</strong>
              <small title={bootstrap.file.projectId}>Bộ dữ liệu hiện tại</small>
            </div>
          </div>
          <button className="sidebar-primary-button" onClick={() => void goBack()}><Icon name="files" /><span className="sidebar-label">Hàng đợi tệp</span></button>
          <nav className="file-queue" aria-label="Danh sách tệp">
            {queueError ? <p role="status">{queueError}</p> : null}
            {queue.map((file) => <button key={file.id} aria-current={file.id === fileId ? 'page' : undefined}
              disabled={navigating || status === 'SYNCING' || file.assetState === 'ERROR'} title={file.externalKey}
              onClick={() => { if (file.id !== fileId) void navigateTo(`/editor/${file.id}`); }}>
              <strong>{file.externalKey}</strong>
              <small>{file.id === fileId ? (readOnly ? 'Đang xem' : 'Đang sửa') : file.lock.state === 'LOCKED' ? `Chỉ xem · ${file.lock.displayName}` : file.assetState === 'ERROR' ? 'Thiếu dữ liệu' : 'Có thể làm'}</small>
              <span>{({ UNSTARTED: 'Chưa làm', DRAFT: 'Bản nháp', DONE: 'Hoàn tất' })[file.annotationState]}</span>
            </button>)}
          </nav>
          <div className="queue-pagination sidebar-label">
            <button disabled={queuePage === 1} onClick={() => setQueuePage((page) => page - 1)}>‹</button>
            <span>{queuePage} / {Math.max(1, Math.ceil(queueTotal / 50))}</span>
            <button disabled={queuePage * 50 >= queueTotal} onClick={() => setQueuePage((page) => page + 1)}>›</button>
          </div>
          <div className="sidebar-account-area">
            <button className="help-button" title="Trợ giúp và phím tắt (?)" onClick={() => setHelpOpen(true)}><span>?</span><span className="sidebar-label"><strong>Trợ giúp phím tắt</strong><small>Xem phím tắt &amp; hướng dẫn</small></span></button>
            <div className="user-profile" title={displayName}>
              <span className="editor-avatar">{initials}</span>
              <span className="sidebar-label"><strong>{displayName}</strong><small>Người chú thích</small></span>
              <span className="online-dot" aria-label="Đang trực tuyến" />
            </div>
          </div>
        </aside>

        <section className="editor-main">
          <div className="canvas-statusbar">
            <span className="canvas-file"><span className="queue-dot" />{bootstrap.file.externalKey}</span>
            {readOnly ? <span className="save-indicator">Chỉ xem · {bootstrap.lockedBy || 'Khóa không thuộc phiên này'}</span> : <SaveIndicator status={status} />}
            <button disabled={readOnly || status === 'CONFLICT' || status === 'SYNCING' || navigating} onClick={() => void saveExplicitly()}>Lưu</button>
          </div>
          {workspaceStep === 'mask' ? <button className={`layer-toggle ${showMask ? 'active' : ''}`} title={showMask ? 'Ẩn lớp phủ' : 'Hiện lớp phủ'} onClick={() => setShowMask((visible) => !visible)}><Icon name="layers" /> <span>{showMask ? 'Lớp phủ đang bật' : 'Lớp phủ đang ẩn'}</span></button> : null}

          <div className="canvas-control-stack">
            <div className="viewport-zoom" aria-label="Điều khiển thu phóng">
              <button aria-label="Phóng to" title="Phóng to" onClick={() => canvasRef.current?.zoomBy(1.2)}>＋</button>
              <span>{Math.round(zoom * 100)}%</span>
              <button aria-label="Thu nhỏ" title="Thu nhỏ" onClick={() => canvasRef.current?.zoomBy(1 / 1.2)}>−</button>
            </div>
            <fieldset className="floating-toolbar" disabled={readOnly || status === 'CONFLICT' || status === 'SYNCING' || navigating} aria-label="Công cụ chú thích">
              <ToolbarButton active={tool === 'select'} label="Chọn / chỉnh sửa (V)" icon="cursor" onClick={() => selectTool('select', 'mask')} />
              <ToolbarButton active={tool === 'pan'} label="Di chuyển ảnh (H)" icon="hand" onClick={() => selectTool('pan')} />
              <ToolbarButton active={tool === 'polygon'} label="Vẽ polygon (P)" icon="polygon" onClick={() => selectTool('polygon', 'mask')} />
              <ToolbarButton active={tool === 'rectangle'} label="Vẽ hình chữ nhật (R)" icon="rectangle" onClick={() => selectTool('rectangle', 'mask')} />
              <ToolbarButton active={tool === 'circle'} label="Vẽ vòng tròn (C)" icon="circle" onClick={() => selectTool('circle', 'mask')} />
              <ToolbarButton active={tool === 'anchor'} label="Chế độ điểm neo: Bấm viền để thêm & kéo anchor point (A)" icon="anchor" onClick={() => selectTool('anchor', 'mask')} />
              {/* Temporarily hidden: <ToolbarButton active={tool === 'point'} label="Đánh dấu point u vấu (M)" icon="pin" onClick={() => selectTool('point', 'warts')} /> */}
              <ToolbarButton active={tool === 'cut'} label="Cắt polygon" icon="scissors" onClick={() => selectTool('cut', 'mask')} />
              <ToolbarButton disabled={selectedPolygonIds.length < 2} label="Gộp polygon đã chọn" icon="merge" onClick={() => canvasRef.current?.groupSelectedPolygons()} />
              <span className="toolbar-divider" />
              <ToolbarButton active={history.local} disabled={!history.canUndo} label={history.local ? "Hoàn tác điểm (Ctrl + Z) — cục bộ" : "Hoàn tác toàn cục (Ctrl + Z)"} icon="undo" onClick={() => canvasRef.current?.undo()} />
              <ToolbarButton active={history.local} disabled={!history.canRedo} label={history.local ? "Làm lại điểm (Ctrl + Y / Ctrl + Shift + Z) — cục bộ" : "Làm lại toàn cục (Ctrl + Y / Ctrl + Shift + Z)"} icon="redo" onClick={() => canvasRef.current?.redo()} />
              <span className="toolbar-divider" />
              <ToolbarButton label="Xóa lựa chọn (Delete)" icon="trash" danger onClick={() => workspaceStep === 'warts' ? canvasRef.current?.deleteSelectedPoint() : canvasRef.current?.deleteSelection()} />
              <ToolbarButton label="Vừa khung hình" icon="fit" onClick={() => canvasRef.current?.fit()} />
            </fieldset>
          </div>

          <EditorCanvas key={seed.key} ref={canvasRef} width={bootstrap.file.width} height={bootstrap.file.height}
            imageUrl={bootstrap.assets.imageUrl} predictionUrl={bootstrap.assets.predictionMaskUrl}
            currentMaskUrl={bootstrap.assets.currentMaskUrl} localMaskBlob={seed.localMaskBlob}
            initialHumanAction={seed.humanAction} initialBreakpoints={seed.breakpoints} initialOperations={seed.operations}
            readOnly={readOnly || status === 'CONFLICT' || status === 'SYNCING' || navigating} tool={readOnly ? 'pan' : tool} maskOpacity={opacity} showMask={showMask}
            onHistoryChange={setHistory} onPolygonComplete={onPolygonComplete}
            onChange={onEditorChange} onSelectionChange={setSelectedPolygonIds} onReady={onCanvasReady} onMessage={setToast} onZoomChange={setZoom} />
        </section>

        {rightCollapsed ? <aside className="right-sidebar-rail"><button aria-label="Mở sidebar phải" title="Mở thiết lập nhiệm vụ" onClick={() => setRightCollapsed(false)}><Icon name="chevron-left" /></button></aside> : <aside className="control-panel">
          <div className="control-panel-title"><span>Thiết lập nhiệm vụ</span><button aria-label="Thu gọn sidebar phải" title="Thu gọn sidebar" onClick={() => setRightCollapsed(true)}><Icon name="chevron-right" /></button></div>
          <div className="workflow-tabs" style={{ gridTemplateColumns: '1fr' }} role="tablist" aria-label="Các bước chú thích">
            <button role="tab" aria-selected={workspaceStep === 'mask'} className={workspaceStep === 'mask' ? 'active' : maskConfirmed ? 'complete' : ''} onClick={() => void returnToMaskStep()}>
              <span>{maskConfirmed ? '✓' : '1'}</span> Vùng chọn
            </button>
            {/* Wart step temporarily hidden.
            <button role="tab" aria-selected={workspaceStep === 'warts'} className={workspaceStep === 'warts' ? 'active' : breakpointConfirmed ? 'complete' : ''} onClick={() => void continueToBreakpoints()}>
              <span>{breakpointConfirmed ? '✓' : '2'}</span> Mật độ u vấu
            </button>
            */}
          </div>

          <fieldset className="control-panel-scroll" disabled={readOnly || status === 'CONFLICT' || status === 'SYNCING' || navigating}>
            {workspaceStep === 'mask' ? <>
              {snapshot.humanAction === 'UNTOUCHED' && polygonCount === 0 ? <section className="decision-card">
                <h2>Mask ban đầu đã sẵn sàng</h2>
                <p>Giữ nguyên nếu mask đã đúng, hoặc chuyển sang polygon để chỉnh sửa trực tiếp trên cùng một lớp.</p>
                <button className="button primary wide" onClick={() => void confirmPrediction()}><span aria-hidden="true">✓</span> Giữ mask hiện tại</button>
                <button className="button secondary wide" onClick={editPredictionAsPolygons}>Chỉnh sửa bằng polygon</button>
              </section> : null}

              <section className="object-section">
                <p aria-live="polite">{history.local
                  ? 'Đang sửa polygon: Ctrl+Z hoàn tác điểm; Ctrl+Y hoặc Ctrl+Shift+Z làm lại. Enter để hoàn tất, Esc để hủy.'
                  : tool === 'anchor'
                  ? 'Chế độ điểm neo: Rê chuột lên viền mask để xem điểm thêm. Click và kéo chuột để tạo & tùy chỉnh anchor point ngay lập tức. Bấm chuột phải lên điểm để xóa.'
                  : tool === 'rectangle'
                  ? 'Chế độ hình chữ nhật: Nhấp và kéo chuột trên ảnh để tạo mask hình chữ nhật.'
                  : tool === 'circle'
                  ? 'Chế độ vòng tròn: Nhấp và kéo chuột để tạo mask vòng tròn/oval. Giữ Shift để tạo vòng tròn đều, giữ Alt để vẽ từ tâm.'
                  : 'Ctrl+Z hoàn tác toàn cục; Ctrl+Y hoặc Ctrl+Shift+Z làm lại. Polygon vừa hoàn tất được hoàn tác/làm lại cả vùng.'}</p>
                <p>Di chuột lên điểm để hiện dấu × đỏ, bấm chuột phải để xóa điểm. Polygon đã đóng cần ít nhất 3 điểm.</p>
                {tool === 'polygon' ? <button className="button primary" onClick={() => void completePolygon()}>Hoàn tất polygon</button> : null}
                {tool === 'cut' ? <button className="button primary" onClick={() => void applyCut()}>Thực hiện cắt</button> : null}
                <div className="section-title-row"><p>Thông tin đối tượng</p><span>{polygonCount} vùng</span></div>
                <PolygonLabelEditor
                  key={`${selectedPolygonIds.join(',')}:${selectedPolygons.map((polygon) => polygon.label).join(',')}`}
                  polygons={snapshot.polygons}
                  selectedPolygons={selectedPolygons}
                  availableLabels={availableLabels}
                  onSelect={(polygonId) => {
                    canvasRef.current?.selectPolygon(polygonId);
                    selectTool('select', 'mask');
                  }}
                  onApply={(label) => canvasRef.current?.updateSelectedPolygonLabel(label) || false}
                  onGroup={() => canvasRef.current?.groupSelectedPolygons() || false}
                />
                <label className="range-field"><span>Độ mờ <strong>{Math.round(opacity * 100)}%</strong></span><input type="range" min="0.1" max="1" step="0.05" value={opacity} onChange={(event) => { const value = Number(event.target.value); setOpacity(value); localStorage.setItem('mask-opacity', String(value)); }} /></label>
              </section>

              <button className="restore-button" onClick={() => canvasRef.current?.resetToPrediction()}>↻ Khôi phục mask ban đầu</button>
            </> : null}
            {/* Wart panel temporarily hidden.
            </> : <>
              <section className="breakpoint-card"><h2>Mật độ u vấu</h2><p>Click vào tâm mỗi u vấu để tạo point. Kéo để chỉnh vị trí; chọn rồi nhấn Delete để xóa.</p>
                <div className="breakpoint-status"><span>Trạng thái</span><strong className={breakpointConfirmed ? 'complete' : ''}><i />{breakpointStatus}</strong></div>
                <button className={`button secondary wide ${tool === 'point' ? 'selected' : ''}`} onClick={() => selectTool('point', 'warts')}>＋ Thêm điểm</button>
                <button className="button ghost wide" onClick={() => canvasRef.current?.deleteSelectedPoint()}>Xóa điểm đang chọn <kbd>Delete</kbd></button>
              </section>

              <button className={`no-breakpoint-option ${snapshot.breakpoints.state === 'CONFIRMED_NONE' ? 'selected' : ''}`} onClick={() => void confirmNoBreakpoint()}>
                <span aria-hidden="true">{snapshot.breakpoints.state === 'CONFIRMED_NONE' ? '✓' : ''}</span>
                <span><strong>Không có u vấu trong ảnh này</strong><small>Kiểm tra kỹ bề mặt trước khi xác nhận</small></span>
              </button>
            </>}
            */}
          </fieldset>
          <div className="panel-actions">
            <button className="button ghost" onClick={() => void goBack()}>‹ Quay lại</button>
            <button className="button primary" disabled={readOnly || !ready || history.local || status === 'SYNCING' || status === 'CONFLICT' || navigating} onClick={() => void finish()}>Hoàn tất &amp; Tiếp theo <span aria-hidden="true">→</span></button>
          {/* Original two-step actions temporarily hidden.
          {workspaceStep === 'mask' ? <>
            <button className="button ghost" onClick={() => void goBack()}>‹ Quay lại</button>
            <button className="button primary" disabled={!ready} onClick={() => void continueToBreakpoints()}>Tiếp tục đến Mật độ u vấu <span aria-hidden="true">›</span></button>
          </> : <>
            <button className="button ghost" onClick={() => void returnToMaskStep()}>Quay lại Vùng chọn</button>
            <button className="button primary" disabled={readOnly || !ready || status === 'SYNCING' || status === 'CONFLICT' || navigating} onClick={() => void finish()}>Hoàn tất &amp; Tiếp theo <span aria-hidden="true">→</span></button>
          </>}
          */}
          </div>
        </aside>}
      </div>

      {toast ? <button aria-live="polite" className="toast" onClick={() => setToast('')}>{toast}</button> : null}
      {helpOpen ? <div className="modal-backdrop help-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}><section className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
        <div className="shortcut-header"><div><span className="help-mark">?</span><span><h2 id="shortcut-title">Trợ giúp &amp; phím tắt</h2><p>Thao tác nhanh hơn trên vùng chú thích</p></span></div><button aria-label="Đóng trợ giúp" onClick={() => setHelpOpen(false)}>×</button></div>
        <div className="shortcut-content">
          <section><h3>Phím tắt</h3><Shortcut keys={['V']} label="Chọn / chỉnh sửa" /><Shortcut keys={['H']} label="Di chuyển ảnh" /><Shortcut keys={['P']} label="Vẽ polygon" /><Shortcut keys={['R']} label="Vẽ hình chữ nhật" /><Shortcut keys={['C']} label="Vẽ vòng tròn" /><Shortcut keys={['A']} label="Thêm & kéo điểm neo" />{/* <Shortcut keys={['M']} label="Đánh dấu point u vấu" /> */}<Shortcut keys={['Enter']} label="Hoàn tất polygon" /><Shortcut keys={['Esc']} label="Hủy thao tác" /><Shortcut keys={['Delete']} label="Xóa lựa chọn" /><Shortcut keys={['Ctrl', 'A']} label="Xóa tất cả polygon" /><Shortcut keys={['Ctrl', 'Z']} label={history.local ? "Hoàn tác điểm (cục bộ)" : "Hoàn tác toàn cục"} /><Shortcut keys={['Ctrl', 'Y']} label={history.local ? "Làm lại điểm (cục bộ)" : "Làm lại toàn cục"} /></section>
          <section className="usage-tips"><h3>Mẹo sử dụng</h3><p><Icon name="cursor" />Ở chế độ V, kéo khung qua các node để chọn nhiều polygon.</p><p><Icon name="polygon" />Chế độ P chỉ dùng để vẽ một polygon mới.</p><p><Icon name="rectangle" />Chế độ R: Kéo chuột để vẽ nhanh mask hình chữ nhật.</p><p><Icon name="circle" />Chế độ C: Kéo chuột để vẽ mask hình tròn/oval. Giữ Shift để tạo vòng tròn đều, Alt để vẽ từ tâm.</p><p><Icon name="anchor" />Chế độ A (Điểm neo): Click lên viền mask để tạo anchor point và kéo tùy chỉnh hình dạng mask.</p><p><Icon name="layers" />Ẩn lớp phủ khi cần quan sát ảnh gốc.</p><p><Icon name="hand" />Dùng con lăn để zoom; Shift + con lăn để cuộn ngang.</p></section>
        </div>
      </section></div> : null}
      {conflict && conflictMinimized ? <button className="conflict-chip" onClick={() => setConflictMinimized(false)}>Có xung đột — mở lựa chọn xử lý</button> : null}
      {conflict && !conflictMinimized ? <div className="modal-backdrop"><div className="conflict-dialog panel" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <p className="eyebrow">Cần bạn quyết định</p><h2 id="conflict-title">Tệp đã được cập nhật ở nơi khác</h2>
        <p>Phần việc của bạn vẫn an toàn trên thiết bị này. Hệ thống sẽ không tự ghi đè bất kỳ phiên bản nào.</p>
        <div className="conflict-actions">
          <button className="button secondary" onClick={() => setConflictMinimized(true)}>Xem bản của tôi</button>
          <button className="button secondary" onClick={() => void showLatest()}>Bỏ bản của tôi, xem bản mới nhất</button>
          <button className="button primary" onClick={() => downloadConflict()}>Tải bản nháp về máy</button>
        </div>
      </div></div> : null}
    </main>
  );
}

type IconName = 'chevron-left' | 'chevron-right' | 'cursor' | 'files' | 'fit' | 'folder' | 'hand' | 'layers' | 'merge' | 'pin' | 'polygon' | 'rectangle' | 'circle' | 'anchor' | 'redo' | 'scissors' | 'trash' | 'undo';

function ToolbarButton({ active = false, danger = false, disabled = false, icon, label, onClick }: { active?: boolean; danger?: boolean; disabled?: boolean; icon: IconName; label: string; onClick(): void }) {
  return <button type="button" aria-label={label} aria-pressed={active || undefined} className={`${active ? 'active' : ''} ${danger ? 'danger' : ''}`} disabled={disabled} title={label} onClick={onClick}><Icon name={icon} /></button>;
}

function Shortcut({ keys, label }: { keys: string[]; label: string }) {
  return <div className="shortcut-row"><span>{label}</span><span>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</span></div>;
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    'chevron-left': <path d="m15 18-6-6 6-6" />,
    'chevron-right': <path d="m9 18 6-6-6-6" />,
    cursor: <path d="m5 3 6.4 15 2.2-5.4L19 10.4 5 3Z" />,
    files: <><path d="M4 7h16v12H4z" /><path d="M8 4h8M12 10v6m-3-3h6" /></>,
    fit: <><path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5" /><path d="M8 8h8v8H8z" /></>,
    folder: <path d="M3 6h7l2 2h9v10H3z" />,
    hand: <path d="M7 11V7a1.5 1.5 0 0 1 3 0v3-5a1.5 1.5 0 0 1 3 0v5-4a1.5 1.5 0 0 1 3 0v5-2a1.5 1.5 0 0 1 3 0v5c0 4-2.6 7-6.5 7H12c-2.3 0-3.7-1.1-5-3l-2.2-3.4A1.6 1.6 0 0 1 7 12.5L9 15" />,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    merge: <><path d="M4 5h7v7H4zM13 12h7v7h-7z" /><path d="m9 15 6-6m-2 0h2v2" /></>,
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2" /></>,
    polygon: <path d="m7 4 10 2 3 10-8 5-9-7 4-10Z" />,
    rectangle: <rect x="3" y="5" width="18" height="14" rx="2" />,
    circle: <circle cx="12" cy="12" r="9" />,
    anchor: <><path d="M3 19C6 10 14 6 21 5" /><circle cx="12" cy="10" r="3.5" /><path d="M12 17v6m-3-3h6" /></>,
    redo: <><path d="m17 7 4 4-4 4" /><path d="M3 18v-2a5 5 0 0 1 5-5h13" /></>,
    scissors: <><circle cx="6" cy="7" r="3" /><circle cx="6" cy="17" r="3" /><path d="m8.7 8.4 11.3 6.1M8.7 15.6 20 9.5" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7" /><path d="M10 11v6m4-6v6" /></>,
    undo: <><path d="m7 7-4 4 4 4" /><path d="M21 18v-2a5 5 0 0 0-5-5H3" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function PolygonLabelEditor({
  availableLabels,
  onApply,
  onGroup,
  onSelect,
  polygons,
  selectedPolygons,
}: {
  availableLabels: string[];
  onApply(label: string): boolean;
  onGroup(): boolean;
  onSelect(polygonId: string): void;
  polygons: AnnotationPolygon[];
  selectedPolygons: AnnotationPolygon[];
}) {
  const sharedLabel = selectedPolygons.length > 0
    && selectedPolygons.every((polygon) => polygon.label === selectedPolygons[0].label)
    ? selectedPolygons[0].label
    : '';
  const [label, setLabel] = useState(sharedLabel);
  const selectedId = selectedPolygons.length === 1 ? selectedPolygons[0].id : '';

  return (
    <form className="polygon-label-editor" onSubmit={(event) => {
      event.preventDefault();
      onApply(label);
    }}>
      <div className="polygon-label-heading">
        <div><span aria-hidden="true">◆</span><strong>Label polygon</strong></div>
        <small>{selectedPolygons.length ? `${selectedPolygons.length} đang chọn` : 'Chưa chọn vùng'}</small>
      </div>
      <label>
        <span>Polygon ID</span>
        <select value={selectedId} onChange={(event) => event.target.value && onSelect(event.target.value)}>
          <option value="">{selectedPolygons.length > 1 ? `${selectedPolygons.length} polygon đang chọn` : 'Chọn polygon theo ID…'}</option>
          {polygons.map((polygon, index) => (
            <option key={polygon.id} value={polygon.id}>#{index + 1} · {polygon.id.slice(0, 8)} · {polygon.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Label</span>
        <input
          list="polygon-label-options"
          maxLength={80}
          placeholder="Chọn label cũ hoặc nhập label mới…"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <datalist id="polygon-label-options">
          {availableLabels.map((option) => <option key={option} value={option} />)}
        </datalist>
      </label>
      <button className="button label-apply" disabled={!selectedPolygons.length || !label.trim()}>Áp dụng label</button>
      <button
        type="button"
        className="button polygon-group"
        disabled={selectedPolygons.length < 2 || !selectedPolygons.every((polygon) => polygon.label === selectedPolygons[0]?.label)}
        onClick={() => onGroup()}
      >
        {selectedPolygons.length >= 2 ? `Gộp ${selectedPolygons.length} polygon` : 'Gộp polygon'}
      </button>
    </form>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const copy = { LOCAL: 'Đã lưu local · chưa gửi server', SAVED: 'Đã lưu server', SAVING: 'Có thay đổi · lưu local mỗi 30s', OFFLINE: 'Ngoại tuyến · chưa gửi server', SYNCING: 'Đang lưu server…', CONFLICT: 'Chỉ xem · có xung đột' };
  return <span className={`save-indicator ${status.toLowerCase()}`}><i aria-hidden="true" />{copy[status]}</span>;
}

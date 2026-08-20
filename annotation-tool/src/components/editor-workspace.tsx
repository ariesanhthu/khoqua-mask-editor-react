'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AnnotationPolygon,
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
  type EditorCanvasSnapshot,
  type EditorTool,
} from './editor-canvas';

type SaveStatus = 'SAVED' | 'SAVING' | 'OFFLINE' | 'SYNCING' | 'CONFLICT';
type WorkspaceStep = 'mask' | 'breakpoints';

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
  const [tool, setTool] = useState<EditorTool>(() => {
    if (typeof window === 'undefined') return 'select';
    const stored = localStorage.getItem('editor-tool') as EditorTool | null;
    return stored && ['polygon', 'select', 'cut', 'point', 'pan'].includes(stored) ? stored : 'select';
  });
  const [workspaceStep, setWorkspaceStep] = useState<WorkspaceStep>(() => tool === 'point' ? 'breakpoints' : 'mask');
  const [opacity, setOpacity] = useState(() => {
    if (typeof window === 'undefined') return 0.5;
    const stored = Number(localStorage.getItem('mask-opacity'));
    return Number.isFinite(stored) && stored >= 0.1 && stored <= 1 ? stored : 0.5;
  });
  const [showMask, setShowMask] = useState(true);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [selectedPolygonIds, setSelectedPolygonIds] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<EditorCanvasSnapshot>({
    humanAction: 'UNTOUCHED', breakpoints: emptyBreakpoints, maskOperations: [], polygons: [],
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
        canvasRef.current?.beginPolygonEdit();
        setTool('select');
        setWorkspaceStep('mask');
        localStorage.setItem('editor-tool', 'select');
      } else if (key === 'h') {
        setTool('pan');
        localStorage.setItem('editor-tool', 'pan');
      } else if (key === 'p') {
        setTool('polygon');
        setWorkspaceStep('mask');
        localStorage.setItem('editor-tool', 'polygon');
      } else if (key === 'm') {
        setTool('point');
        setWorkspaceStep('breakpoints');
        localStorage.setItem('editor-tool', 'point');
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
      breakpoints: annotation ? annotation.breakpoints : emptyBreakpoints,
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
          const recoveredSnapshot = { humanAction: recovered.humanAction, breakpoints: recovered.breakpoints, maskOperations: recovered.operations, polygons: polygonsFromOperations(recovered.operations) };
          setSnapshot(recoveredSnapshot);
          snapshotRef.current = recoveredSnapshot;
          dirtyVersionRef.current = 1;
          setToast('Đã khôi phục phần việc chưa đồng bộ trên thiết bị này.');
          setStatus(navigator.onLine ? 'SAVING' : 'OFFLINE');
        } else if (local && local.baseServerRevision !== lock.baseRevision && local.syncState !== 'SYNCED') {
          const localSeed: EditorSeed = {
            key: Date.now(), humanAction: local.humanAction,
            breakpoints: local.breakpoints, operations: local.maskOperations || [], localMaskBlob: local.maskSnapshotBlob,
          };
          setSeed(localSeed);
          const localSnapshot = { humanAction: localSeed.humanAction, breakpoints: localSeed.breakpoints, maskOperations: localSeed.operations, polygons: polygonsFromOperations(localSeed.operations) };
          setSnapshot(localSnapshot);
          snapshotRef.current = localSnapshot;
          conflictRef.current = true; setConflictMinimized(false); setConflict({ serverRevision: lock.baseRevision, localDraft: local }); setStatus('CONFLICT');
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
    if (!bootstrap) return;
    const current = snapshotRef.current;
    await putLocalDraft({
      key: draftKey(bootstrap.file.projectId, fileId, userId),
      projectId: bootstrap.file.projectId,
      fileId,
      userId,
      baseServerRevision: revisionRef.current,
      humanAction: current.humanAction,
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
        const result = await saveDraft(fileId, {
          baseRevision: revisionRef.current,
          segmentation: {
            humanAction: current.humanAction,
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
    localTimerRef.current = window.setTimeout(() => void persistLocal('DIRTY'), 500);
  }, [persistLocal]);

  useEffect(() => {
    if (!bootstrap) return;
    const maximumInterval = window.setInterval(() => void syncNow(), 30_000);
    const heartbeatInterval = window.setInterval(async () => {
      try { await sendHeartbeat(fileId); }
      catch {
        if (transitioningFileRef.current) return;
        await persistLocal('CONFLICT').catch(() => undefined);
        conflictRef.current = true; setStatus('CONFLICT');
        const local = await getLocalDraft(bootstrap.file.projectId, fileId, userId);
        if (local) { setConflictMinimized(false); setConflict({ serverRevision: revisionRef.current, localDraft: local }); }
      }
    }, 90_000);
    const onOffline = () => setStatus('OFFLINE');
    const onOnline = () => { if (!conflictRef.current) setStatus('SAVING'); };
    const onPageHide = () => { void persistLocal('DIRTY'); };
    window.addEventListener('offline', onOffline); window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.clearInterval(maximumInterval); window.clearInterval(heartbeatInterval);
      if (localTimerRef.current) window.clearTimeout(localTimerRef.current);
      window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [bootstrap, fileId, persistLocal, syncNow, userId]);

  const goBack = async () => {
    await persistLocal('DIRTY').catch(() => undefined);
    await syncNow().catch(() => false);
    await releaseLock(fileId).catch(() => undefined);
    router.push('/');
  };

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (status === 'SAVED') return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [status]);

  const finish = async () => {
    const current = snapshotRef.current;
    if (current.humanAction === 'UNTOUCHED') {
      setToast('Hãy chấp nhận mặt nạ gợi ý hoặc chỉnh sửa mặt nạ trước.'); return;
    }
    if (current.breakpoints.state === 'NOT_ANNOTATED') {
      setToast('Hãy đánh dấu điểm đứt gãy hoặc xác nhận ảnh không có điểm đứt gãy.'); return;
    }
    transitioningFileRef.current = true;
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
        annotation: { segmentation: { humanAction: current.humanAction, maskUploadRef, maskOperations: current.maskOperations }, breakpoints: current.breakpoints },
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
    const next = { humanAction: serverSeed.humanAction, breakpoints: serverSeed.breakpoints, maskOperations: serverSeed.operations, polygons: polygonsFromOperations(serverSeed.operations) };
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
        annotation: { segmentation: { humanAction: current.humanAction === 'UNTOUCHED' ? 'MODIFIED' : current.humanAction, maskUploadRef, maskOperations: current.maskOperations }, breakpoints: current.breakpoints },
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

  const selectTool = (nextTool: EditorTool, nextStep = workspaceStep) => {
    if (nextTool === 'select' && nextStep === 'mask') {
      canvasRef.current?.beginPolygonEdit();
    }
    setTool(nextTool);
    setWorkspaceStep(nextStep);
    localStorage.setItem('editor-tool', nextTool);
  };
  const openMaskStep = () => selectTool(tool === 'point' ? 'select' : tool, 'mask');
  const openBreakpointStep = () => selectTool('point', 'breakpoints');
  const flushExplicitly = async () => {
    await persistLocal('DIRTY').catch(() => undefined);
    await syncNow().catch(() => false);
  };
  const saveExplicitly = async () => {
    await flushExplicitly();
    setToast('Đã lưu thay đổi lên máy chủ.');
  };
  const confirmPrediction = async () => {
    canvasRef.current?.acceptPrediction();
    await flushExplicitly();
  };
  const editPredictionAsPolygons = () => {
    canvasRef.current?.beginPolygonEdit();
    selectTool('select', 'mask');
  };
  const continueToBreakpoints = async () => {
    await flushExplicitly();
    openBreakpointStep();
  };
  const returnToMaskStep = async () => {
    await flushExplicitly();
    openMaskStep();
  };
  const completePolygon = async () => {
    if (!canvasRef.current?.completePolygon()) return;
    await flushExplicitly();
  };
  const applyCut = async () => {
    if (!canvasRef.current?.applyCut()) return;
    await flushExplicitly();
  };
  const confirmNoBreakpoint = async () => {
    canvasRef.current?.confirmNoBreakpoint();
    await flushExplicitly();
  };
  const maskConfirmed = snapshot.humanAction !== 'UNTOUCHED';
  const polygonCount = snapshot.polygons.length;
  const selectedPolygons = snapshot.polygons.filter((polygon) => selectedPolygonIds.includes(polygon.id));
  const availableLabels = [...new Set([
    'main_flesh_band',
    'wart_flesh',
    ...snapshot.polygons.map((polygon) => polygon.label).filter(Boolean),
  ])];
  const breakpointCount = snapshot.breakpoints.points.length;
  const breakpointConfirmed = snapshot.breakpoints.state !== 'NOT_ANNOTATED';
  const breakpointStatus = snapshot.breakpoints.state === 'CONFIRMED_NONE'
    ? 'Đã xác nhận không có điểm ngắt'
    : breakpointCount > 0
      ? `Đã đánh dấu ${breakpointCount} điểm ngắt`
      : 'Chưa đánh dấu điểm ngắt';
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
          <nav className="workspace-nav" aria-label="Điều hướng tác vụ">
            <p className="sidebar-label">Quy trình</p>
            <button className={workspaceStep === 'mask' ? 'active' : ''} title="Vùng chọn" onClick={() => void returnToMaskStep()}>
              <span className="nav-step">1</span>
              <span className="sidebar-label"><strong>Vùng chọn</strong><small>{maskConfirmed ? 'Đã xác nhận' : 'Đang thực hiện'}</small></span>
            </button>
            <button className={workspaceStep === 'breakpoints' ? 'active' : ''} title="Điểm ngắt" onClick={() => void continueToBreakpoints()}>
              <span className="nav-step">2</span>
              <span className="sidebar-label"><strong>Điểm ngắt</strong><small>{breakpointConfirmed ? 'Đã xác nhận' : 'Chưa hoàn tất'}</small></span>
            </button>
          </nav>
          <div className="queue-card" title={bootstrap.file.externalKey}>
            <p className="sidebar-label">Tệp hiện tại</p>
            <div><span className="queue-dot" /><strong className="sidebar-label">{bootstrap.file.externalKey}</strong></div>
            <small className="sidebar-label">{bootstrap.file.width} × {bootstrap.file.height}px</small>
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
            <SaveIndicator status={status} />
            <button disabled={status === 'SYNCING'} onClick={() => void saveExplicitly()}>Lưu</button>
          </div>
          {workspaceStep === 'mask' ? <button className={`layer-toggle ${showMask ? 'active' : ''}`} title={showMask ? 'Ẩn lớp phủ' : 'Hiện lớp phủ'} onClick={() => setShowMask((visible) => !visible)}><Icon name="layers" /> <span>{showMask ? 'Lớp phủ đang bật' : 'Lớp phủ đang ẩn'}</span></button> : null}

          <div className="canvas-control-stack">
            <div className="viewport-zoom" aria-label="Điều khiển thu phóng">
              <button aria-label="Phóng to" title="Phóng to" onClick={() => canvasRef.current?.zoomBy(1.2)}>＋</button>
              <span>{Math.round(zoom * 100)}%</span>
              <button aria-label="Thu nhỏ" title="Thu nhỏ" onClick={() => canvasRef.current?.zoomBy(1 / 1.2)}>−</button>
            </div>
            <div className="floating-toolbar" aria-label="Công cụ chú thích">
              <ToolbarButton active={tool === 'select'} label="Chọn / chỉnh sửa (V)" icon="cursor" onClick={() => selectTool('select', 'mask')} />
              <ToolbarButton active={tool === 'pan'} label="Di chuyển ảnh (H)" icon="hand" onClick={() => selectTool('pan')} />
              <ToolbarButton active={tool === 'polygon'} label="Vẽ polygon (P)" icon="polygon" onClick={() => selectTool('polygon', 'mask')} />
              <ToolbarButton active={tool === 'point'} label="Đánh dấu điểm ngắt (M)" icon="pin" onClick={() => selectTool('point', 'breakpoints')} />
              <ToolbarButton active={tool === 'cut'} label="Cắt polygon" icon="scissors" onClick={() => selectTool('cut', 'mask')} />
              <span className="toolbar-divider" />
              <ToolbarButton label="Hoàn tác (Ctrl + Z)" icon="undo" onClick={() => canvasRef.current?.undo()} />
              <ToolbarButton label="Làm lại (Ctrl + Y)" icon="redo" onClick={() => canvasRef.current?.redo()} />
              <span className="toolbar-divider" />
              <ToolbarButton label="Xóa lựa chọn (Delete)" icon="trash" danger onClick={() => workspaceStep === 'breakpoints' ? canvasRef.current?.deleteSelectedPoint() : canvasRef.current?.deleteSelection()} />
              <ToolbarButton label="Vừa khung hình" icon="fit" onClick={() => canvasRef.current?.fit()} />
            </div>
          </div>

          <EditorCanvas key={seed.key} ref={canvasRef} width={bootstrap.file.width} height={bootstrap.file.height}
            imageUrl={bootstrap.assets.imageUrl} predictionUrl={bootstrap.assets.predictionMaskUrl}
            currentMaskUrl={bootstrap.assets.currentMaskUrl} localMaskBlob={seed.localMaskBlob}
            initialHumanAction={seed.humanAction} initialBreakpoints={seed.breakpoints} initialOperations={seed.operations}
            tool={tool} maskOpacity={opacity} showMask={showMask}
            onChange={onEditorChange} onSelectionChange={setSelectedPolygonIds} onReady={onCanvasReady} onMessage={setToast} onZoomChange={setZoom} />
        </section>

        {rightCollapsed ? <aside className="right-sidebar-rail"><button aria-label="Mở sidebar phải" title="Mở thiết lập nhiệm vụ" onClick={() => setRightCollapsed(false)}><Icon name="chevron-left" /></button></aside> : <aside className="control-panel">
          <div className="control-panel-title"><span>Thiết lập nhiệm vụ</span><button aria-label="Thu gọn sidebar phải" title="Thu gọn sidebar" onClick={() => setRightCollapsed(true)}><Icon name="chevron-right" /></button></div>
          <div className="workflow-tabs" role="tablist" aria-label="Các bước chú thích">
            <button role="tab" aria-selected={workspaceStep === 'mask'} className={workspaceStep === 'mask' ? 'active' : maskConfirmed ? 'complete' : ''} onClick={() => void returnToMaskStep()}>
              <span>{maskConfirmed ? '✓' : '1'}</span> Vùng chọn
            </button>
            <button role="tab" aria-selected={workspaceStep === 'breakpoints'} className={workspaceStep === 'breakpoints' ? 'active' : breakpointConfirmed ? 'complete' : ''} onClick={() => void continueToBreakpoints()}>
              <span>{breakpointConfirmed ? '✓' : '2'}</span> Điểm ngắt
            </button>
          </div>

          <div className="control-panel-scroll">
            {workspaceStep === 'mask' ? <>
              <section className="instruction-block">
                <h2>Hướng dẫn</h2>
                {tool === 'select'
                  ? <p>Kéo các điểm để chỉnh polygon. Nhấp đúp lên polygon để thêm một điểm mới vào cạnh gần nhất.</p>
                  : tool === 'polygon'
                    ? <p>Nhấp để vẽ polygon mới. Nhấp đúp hoặc nhấn <kbd>Enter</kbd> để hoàn tất.</p>
                    : tool === 'cut'
                      ? <p>Kéo một đường qua polygon đã chọn, sau đó nhấn <kbd>Enter</kbd> để cắt.</p>
                      : <p>Chọn một công cụ trên thanh nổi để bắt đầu chỉnh sửa.</p>}
                {tool === 'polygon' ? <div className="context-actions"><button className="button primary" onClick={() => void completePolygon()}>Hoàn tất polygon</button><button className="button ghost" onClick={() => canvasRef.current?.cancelCurrentPath()}>Hủy</button></div> : null}
                {tool === 'cut' ? <button className="button primary wide" onClick={() => void applyCut()}>Thực hiện cắt</button> : null}
              </section>
              {snapshot.humanAction === 'UNTOUCHED' && polygonCount === 0 ? <section className="decision-card">
                <h2>Mask ban đầu đã sẵn sàng</h2>
                <p>Giữ nguyên nếu mask đã đúng, hoặc chuyển sang polygon để chỉnh sửa trực tiếp trên cùng một lớp.</p>
                <button className="button primary wide" onClick={() => void confirmPrediction()}><span aria-hidden="true">✓</span> Giữ mask hiện tại</button>
                <button className="button secondary wide" onClick={editPredictionAsPolygons}>Chỉnh sửa bằng polygon</button>
              </section> : null}

              <section className="object-section">
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
            </> : <>
              <section className="instruction-block">
                <h2>Hướng dẫn</h2>
                <p>Nhấp vào ảnh để đánh dấu từng điểm ngắt của gờ. Kéo điểm để điều chỉnh vị trí, hoặc chọn điểm rồi nhấn Delete để xóa.</p>
              </section>

              <section className="breakpoint-card">
                <div className="breakpoint-status"><span>Trạng thái</span><strong className={breakpointConfirmed ? 'complete' : ''}><i />{breakpointStatus}</strong></div>
                <button className={`button secondary wide ${tool === 'point' ? 'selected' : ''}`} onClick={() => selectTool('point', 'breakpoints')}>＋ Thêm điểm</button>
                <button className="button ghost wide" onClick={() => canvasRef.current?.deleteSelectedPoint()}>Xóa điểm đang chọn <kbd>Delete</kbd></button>
              </section>

              <button className={`no-breakpoint-option ${snapshot.breakpoints.state === 'CONFIRMED_NONE' ? 'selected' : ''}`} onClick={() => void confirmNoBreakpoint()}>
                <span aria-hidden="true">{snapshot.breakpoints.state === 'CONFIRMED_NONE' ? '✓' : ''}</span>
                <span><strong>Không có điểm ngắt trong ảnh này</strong><small>Kiểm tra kỹ bề mặt trước khi xác nhận</small></span>
              </button>
            </>}
          </div>
          <div className="panel-actions">
          {workspaceStep === 'mask' ? <>
            <button className="button ghost" onClick={() => void goBack()}>‹ Quay lại</button>
            <button className="button primary" disabled={!ready} onClick={() => void continueToBreakpoints()}>Tiếp tục đến Điểm ngắt <span aria-hidden="true">›</span></button>
          </> : <>
            <button className="button ghost" onClick={() => void returnToMaskStep()}>Quay lại Vùng chọn</button>
            <button className="button primary" disabled={!ready || status === 'SYNCING'} onClick={() => void finish()}>Hoàn tất &amp; Tiếp theo <span aria-hidden="true">→</span></button>
          </>}
          </div>
        </aside>}
      </div>

      {toast ? <button aria-live="polite" className="toast" onClick={() => setToast('')}>{toast}</button> : null}
      {helpOpen ? <div className="modal-backdrop help-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}><section className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
        <div className="shortcut-header"><div><span className="help-mark">?</span><span><h2 id="shortcut-title">Trợ giúp &amp; phím tắt</h2><p>Thao tác nhanh hơn trên vùng chú thích</p></span></div><button aria-label="Đóng trợ giúp" onClick={() => setHelpOpen(false)}>×</button></div>
        <div className="shortcut-content">
          <section><h3>Phím tắt</h3><Shortcut keys={['V']} label="Chọn / chỉnh sửa" /><Shortcut keys={['H']} label="Di chuyển ảnh" /><Shortcut keys={['P']} label="Vẽ polygon" /><Shortcut keys={['M']} label="Đánh dấu điểm ngắt" /><Shortcut keys={['Enter']} label="Hoàn tất polygon" /><Shortcut keys={['Esc']} label="Hủy thao tác" /><Shortcut keys={['Delete']} label="Xóa lựa chọn" /><Shortcut keys={['Ctrl', 'Z']} label="Hoàn tác" /><Shortcut keys={['Ctrl', 'Y']} label="Làm lại" /></section>
          <section className="usage-tips"><h3>Mẹo sử dụng</h3><p><Icon name="cursor" />Ở chế độ V, nhấp đúp lên polygon để thêm điểm.</p><p><Icon name="polygon" />Chế độ P chỉ dùng để vẽ một polygon mới.</p><p><Icon name="layers" />Ẩn lớp phủ khi cần quan sát ảnh gốc.</p><p><Icon name="hand" />Dùng con lăn để zoom quanh vị trí con trỏ.</p></section>
        </div>
      </section></div> : null}
      {conflict && conflictMinimized ? <button className="conflict-chip" onClick={() => setConflictMinimized(false)}>Có xung đột — mở lựa chọn xử lý</button> : null}
      {conflict && !conflictMinimized ? <div className="modal-backdrop"><div className="conflict-dialog panel" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <p className="eyebrow">Cần bạn quyết định</p><h2 id="conflict-title">Tệp đã được cập nhật ở nơi khác</h2>
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

type IconName = 'chevron-left' | 'chevron-right' | 'cursor' | 'files' | 'fit' | 'folder' | 'hand' | 'layers' | 'pin' | 'polygon' | 'redo' | 'scissors' | 'trash' | 'undo';

function ToolbarButton({ active = false, danger = false, icon, label, onClick }: { active?: boolean; danger?: boolean; icon: IconName; label: string; onClick(): void }) {
  return <button type="button" aria-label={label} aria-pressed={active || undefined} className={`${active ? 'active' : ''} ${danger ? 'danger' : ''}`} title={label} onClick={onClick}><Icon name={icon} /></button>;
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
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2" /></>,
    polygon: <path d="m7 4 10 2 3 10-8 5-9-7 4-10Z" />,
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
  const copy = { SAVED: 'Đã đồng bộ', SAVING: 'Đã lưu cục bộ · đồng bộ ≤30s', OFFLINE: 'Ngoại tuyến · đã lưu cục bộ', SYNCING: 'Đang đồng bộ…', CONFLICT: 'Có xung đột' };
  return <span className={`save-indicator ${status.toLowerCase()}`}><i aria-hidden="true" />{copy[status]}</span>;
}

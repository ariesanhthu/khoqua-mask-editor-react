'use client';
import { draftFitsImage } from '@/lib/draft-coordinates';

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
} from '@/lib/api-client';
import { deleteLocalDraft, draftKey, getLocalDraft, putLocalDraft } from '@/lib/local-drafts';
import { labelsForKind, nextLabel, polygonLabelKind, type PolygonLabelKind } from '@/lib/polygon-labels';
import { parseWebPolygonImport } from '@/lib/web-import';
import type { BrushMode } from '@/lib/polygon-geometry';
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

// Cỡ nét tính bằng pixel của ảnh gốc, không đổi theo mức thu phóng.
const BRUSH_MIN_SIZE = 1;
const BRUSH_MAX_SIZE = 200;
const BRUSH_SLIDER_MAX_SIZE = 64;
const clampBrushSize = (size: number) => Math.max(BRUSH_MIN_SIZE, Math.min(BRUSH_MAX_SIZE, Math.round(size)));

// So sanh noi dung ban nhap tren thiet bi voi du lieu may chu. Chenh lech revision
// khong dong nghia voi xung dot: neu noi dung y het nhau thi ban nhap chi la rac con
// sot lai tu phien truoc, khong can hoi nguoi dung.
function draftMatchesServerSeed(draft: LocalDraft, seed: EditorSeed) {
  if (draft.humanAction !== seed.humanAction) return false;
  if (JSON.stringify(draft.maskOperations ?? []) !== JSON.stringify(seed.operations)) return false;
  return JSON.stringify(draft.wartPoints ?? emptyBreakpoints) === JSON.stringify(seed.breakpoints);
}

// May chu dung lai mask tu POLYGON_SET, khong nhan anh PNG. Net brush chua kip chuyen thanh polygon
// (worker loi/cham) thi chua duoc gui, neu khong mo lai se mat net ve.
function hasUnconvertedBrush(snapshot: EditorCanvasSnapshot) {
  const last = snapshot.maskOperations.at(-1);
  return snapshot.humanAction === 'MODIFIED' && (last?.type === 'BRUSH_ADD' || last?.type === 'BRUSH_ERASE');
}

function polygonsFromOperations(operations: MaskOperation[]): AnnotationPolygon[] {
  // Brush strokes after the last POLYGON_SET mean those polygons are stale: the saved raster wins.
  const last = operations.at(-1);
  return last?.type === 'POLYGON_SET' ? last.polygons : [];
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
    return stored && ['polygon', 'rectangle', 'circle', 'anchor', 'select', 'cut', 'brush', 'pan'].includes(stored) ? stored : 'select';
  });
  const [workspaceStep, setWorkspaceStep] = useState<WorkspaceStep>('mask');
  const [opacity, setOpacity] = useState(() => {
    if (typeof window === 'undefined') return 0.5;
    const stored = Number(localStorage.getItem('mask-opacity'));
    return Number.isFinite(stored) && stored >= 0.1 && stored <= 1 ? stored : 0.5;
  });
  const [brushMode, setBrushMode] = useState<BrushMode>(() => (
    typeof window !== 'undefined' && localStorage.getItem('brush-mode') === 'erase' ? 'erase' : 'add'
  ));
  const [brushSize, setBrushSize] = useState(() => {
    if (typeof window === 'undefined') return 8;
    const stored = Number(localStorage.getItem('brush-size'));
    return Number.isFinite(stored) && stored >= BRUSH_MIN_SIZE ? clampBrushSize(stored) : 8;
  });
  const [showMask, setShowMask] = useState(true);
  // Magnet trong Select (V): kéo node tới gần điểm của mask khác thì dính vào điểm đó (người dùng xác nhận 2026-11-05).
  const [magnet, setMagnet] = useState(() => typeof window === 'undefined' || localStorage.getItem('select-magnet') !== '0');
  const changeOpacity = (value: number) => {
    setOpacity(value);
    localStorage.setItem('mask-opacity', String(value));
  };
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [history, setHistory] = useState<EditorHistoryState>({ local: false, canUndo: false, canRedo: false });
  const onPolygonComplete = useCallback(() => { setTool('select'); localStorage.setItem('editor-tool', 'select'); }, []);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const updateZoomLabel = useCallback((scale: number) => {
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(scale * 100)}%`;
  }, []);
  const toolRef = useRef(tool);
  const brushSizeRef = useRef(brushSize);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { brushSizeRef.current = brushSize; localStorage.setItem('brush-size', String(brushSize)); }, [brushSize]);
  useEffect(() => { localStorage.setItem('brush-mode', brushMode); }, [brushMode]);
  const [selectedPolygonIds, setSelectedPolygonIds] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<EditorCanvasSnapshot>({
    humanAction: 'UNTOUCHED', breakpoints: emptyBreakpoints, maskOperations: [], polygons: [],
  });
  const snapshotRef = useRef(snapshot);
  const revisionRef = useRef(0);
  const [status, setStatus] = useState<SaveStatus>('SAVED');
  const [toast, setToast] = useState('');
  const [conflict, setConflict] = useState<{ serverRevision: number; localDraft: LocalDraft } | null>(null);
  const [staleDraft, setStaleDraft] = useState<LocalDraft | null>(null);
  const staleDraftRef = useRef<LocalDraft | null>(null);
  const [draftDecisionPending, setDraftDecisionPending] = useState(false);
  const prefetchedAssetsRef = useRef<HTMLImageElement[]>([]);
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
      } else if (key === 'b' || key === 'e') {
        setBrushMode(key === 'e' ? 'erase' : 'add');
        changeToolRef.current('brush', 'mask');
      } else if ((event.key === '[' || event.key === ']') && toolRef.current === 'brush') {
        const step = Math.max(1, Math.round(brushSizeRef.current * 0.2));
        setBrushSize(clampBrushSize(brushSizeRef.current + (event.key === '[' ? -step : step)));
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
    // Anh goc va mask du doan khong phu thuoc vao khoa hay bootstrap. Tai chung ngay
    // tu dau de chung chay song song voi hai vong goi kia; luc canvas can thi trinh
    // duyet da co san trong cache.
    // Giu tham chieu toi luc canvas dung xong, de trinh duyet khong bo request giua chung.
    prefetchedAssetsRef.current = ['image', 'prediction'].map((asset) => {
      const image = new Image();
      image.src = `/api/files/${fileId}/assets/${asset}`;
      return image;
    });
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
      setStaleDraft(null);
      setDraftDecisionPending(false);
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
        const serverSeed = createServerSeed(data);
        const local = canEdit ? await getLocalDraft(data.file.projectId, fileId, userId) : undefined;
        if (cancelled) return;
        // Mo file luon bat dau tu du lieu may chu: moi lan roi khoi tep deu da dong bo,
        // nen ban nhap tren thiet bi chi la luoi an toan cho luc mat dien hoac mat mang
        // giua chung. No khong duoc tu de len ban da nam tren may chu.
        const unsyncedDraft = local && local.syncState !== 'SYNCED' && !draftMatchesServerSeed(local, serverSeed)
          ? local
          : undefined;
        // Ban nhap trung noi dung may chu chi la rac con sot lai; ban chua gui thi giu
        // nguyen trong IndexedDB cho toi khi nguoi dung dung no hoac sua de len.
        if (local && !unsyncedDraft) {
          await deleteLocalDraft(data.file.projectId, fileId, userId).catch(() => undefined);
        }
        setBootstrap(data);
        if (unsyncedDraft) {
          const localSeed: EditorSeed = {
            key: Date.now(),
            humanAction: unsyncedDraft.humanAction,
            breakpoints: unsyncedDraft.wartPoints ?? emptyBreakpoints,
            operations: unsyncedDraft.maskOperations || [],
            localMaskBlob: unsyncedDraft.maskSnapshotBlob,
          };
          const safeSeed = draftFitsImage(unsyncedDraft, data) ? localSeed : serverSeed;
          setSeed(safeSeed);
          const localSnapshot = { humanAction: safeSeed.humanAction, breakpoints: safeSeed.breakpoints, maskOperations: safeSeed.operations, polygons: polygonsFromOperations(safeSeed.operations) };
          setSnapshot(localSnapshot); snapshotRef.current = localSnapshot;
          setStaleDraft(unsyncedDraft);
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

  // Ban nhap chi nen mang co DIRTY khi that su con thay doi chua gui len may chu.
  // Neu da dong bo xong ma van ghi DIRTY thi lan mo file sau se bao xung dot gia.
  const pendingSyncState = useCallback((): SyncState => {
    if (conflictRef.current) return 'CONFLICT';
    return dirtyVersionRef.current === syncedVersionRef.current ? 'SYNCED' : 'DIRTY';
  }, []);

  useEffect(() => { staleDraftRef.current = staleDraft; }, [staleDraft]);

  const persistLocal = useCallback(async (syncState: SyncState = 'DIRTY') => {
    if (!bootstrap || readOnly || transitioningFileRef.current) return;
    // Chi di ngang qua tep ma khong sua gi thi khong duoc ghi de len ban nhap chua gui:
    // do van la phan viec duy nhat con lai cua lan mat dien hoac mat mang truoc do.
    if (staleDraftRef.current && dirtyVersionRef.current === syncedVersionRef.current) return;
    await canvasRef.current?.flushPendingEdits();
    const current = snapshotRef.current;
    // Chi luu anh mask vao ban nhap tren thiet bi khi con net brush chua thanh polygon; binh thuong
    // cac thao tac da du de dung lai mask. Anh nay khong bao gio gui len may chu.
    const maskSnapshotBlob = hasUnconvertedBrush(current)
      ? await canvasRef.current?.exportMask()
      : undefined;
    await putLocalDraft({
      key: draftKey(bootstrap.file.projectId, fileId, userId),
      projectId: bootstrap.file.projectId,
      fileId,
      userId,
      baseServerRevision: revisionRef.current,
      coordinateSpace: { width: bootstrap.file.width, height: bootstrap.file.height, imageUrl: bootstrap.assets.imageUrl },
      humanAction: current.humanAction,
      maskSnapshotBlob,
      maskOperations: current.maskOperations,
      breakpoints: legacyBreakpointsRef.current,
      wartPoints: current.breakpoints,
      updatedAt: Date.now(),
      syncState,
    });
  }, [bootstrap, fileId, readOnly, userId]);

  const syncNow = useCallback(async (): Promise<boolean> => {
    if (!bootstrap || !canvasRef.current || conflictRef.current || readOnly) return false;
    await canvasRef.current.flushPendingEdits();
    if (!navigator.onLine) {
      setStatus('OFFLINE');
      await persistLocal('DIRTY').catch(() => undefined);
      return false;
    }
    if (syncPromiseRef.current) return syncPromiseRef.current;
    if (dirtyVersionRef.current === syncedVersionRef.current) {
      // Khong con gi de gui, nhung ban nhap tren thiet bi co the dang mang co DIRTY
      // do persistLocal duoc goi truoc do (navigateTo, pagehide). Danh dau SYNCED lai
      // de lan mo file sau khong bi coi la xung dot gia.
      await persistLocal('SYNCED').catch(() => undefined);
      return true;
    }

    const syncingVersion = dirtyVersionRef.current;
    const task = (async () => {
      setStatus('SYNCING');
      try {
        const current = snapshotRef.current;
        if (hasUnconvertedBrush(current)) {
          throw {
            code: 'INVALID_ANNOTATION',
            message: 'Nét vẽ chưa chuyển xong thành polygon nên chưa gửi máy chủ. Hãy bấm Lưu lại sau vài giây; bản vẽ vẫn ở thiết bị.',
          } satisfies ApiError;
        }
        // Khong upload anh PNG: may chu dung lai mask tu maskOperations (POLYGON_SET).
        const result = await saveDraft(fileId, {
          baseRevision: revisionRef.current,
          segmentation: {
            humanAction: current.humanAction,
            wartPoints: current.breakpoints,
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

  // Moi thao tac ve chi cap nhat snapshot trong bo nho. Khong ghi IndexedDB/PNG va khong
  // goi server theo tung net: ban nhap local duoc ghi theo chu ky 30s (interval ben duoi),
  // con server chi nhan khi bam Luu, doi tab/tep, an trang hoac Hoan tat.
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
      catch (error) {
        if (transitioningFileRef.current) return;
        // Mat mang khong dong nghia voi mat khoa: khoa con hieu luc het LOCK_TTL nen
        // nhip sau van gia han duoc. Chi khi may chu bao LOCK_LOST moi la mat quyen sua.
        if ((error as ApiError).code !== 'LOCK_LOST') {
          if (!navigator.onLine && !conflictRef.current) setStatus('OFFLINE');
          return;
        }
        await persistLocal('CONFLICT').catch(() => undefined);
        conflictRef.current = true; setStatus('CONFLICT');
        const local = await getLocalDraft(bootstrap.file.projectId, fileId, userId);
        if (local) { setConflictMinimized(false); setConflict({ serverRevision: revisionRef.current, localDraft: local }); }
      }
    }, 30_000);
    const onOffline = () => setStatus('OFFLINE');
    const onOnline = () => { if (!conflictRef.current) setStatus('SAVING'); };
    const onPageHide = () => { void persistLocal(pendingSyncState()); };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'hidden' || transitioningFileRef.current) return;
      void persistLocal(pendingSyncState()).catch(() => undefined).then(() => syncNow());
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
  }, [bootstrap, fileId, pendingSyncState, persistLocal, readOnly, syncNow, userId]);

  const navigateTo = async (destination: string) => {
    if (transitioningFileRef.current || navigating) return;
    setNavigating(true);
    if (!readOnly) {
      await persistLocal(pendingSyncState()).catch(() => undefined);
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
    // Danh sach chi doi khi co nguoi khac nhan/nha khoa. Lam moi 8s la qua day voi
    // do tre ~0.3s moi truy van; tab an thi khong can lam moi chut nao.
    const refreshIfVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    const timer = window.setInterval(refreshIfVisible, 20_000);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [bootstrap, queuePage]);

  // Che do chi xem khong giu khoa nen khong biet nguoi dang sua vua luu gi. Hoi lai may chu
  // dinh ky (chi khi tab dang hien) va nap ban moi khi revision doi; neu khong, nguoi xem
  // mo tep truoc luc nguoi kia luu se thay du lieu cu cho toi khi tu tai lai trang.
  useEffect(() => {
    if (!bootstrap || !readOnly) return;
    let cancelled = false;
    const shownRevision = bootstrap.annotation?.revision ?? 0;
    const checkLatest = async () => {
      if (document.visibilityState !== 'visible' || transitioningFileRef.current) return;
      try {
        const latest = await getEditorData(fileId);
        const latestRevision = latest.annotation?.revision ?? 0;
        if (cancelled || latestRevision === shownRevision) return;
        revisionRef.current = latestRevision;
        legacyBreakpointsRef.current = latest.annotation?.breakpoints ?? emptyBreakpoints;
        const serverSeed = createServerSeed(latest);
        const next = { humanAction: serverSeed.humanAction, breakpoints: serverSeed.breakpoints, maskOperations: serverSeed.operations, polygons: polygonsFromOperations(serverSeed.operations) };
        setBootstrap(latest);
        setSeed(serverSeed);
        snapshotRef.current = next; setSnapshot(next);
        setToast(`Đã tải bản mới nhất từ máy chủ (revision ${latestRevision}).`);
      } catch {
        // Mat mang tam thoi: thu lai o nhip sau.
      }
    };
    const onVisible = () => { void checkLatest(); };
    const timer = window.setInterval(onVisible, 15_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [bootstrap, createServerSeed, fileId, readOnly]);

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
    await canvasRef.current?.flushPendingEdits();
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
      // syncNow da chuyen net brush thanh polygon va gui thanh cong; dung dung snapshot vua gui.
      const synced = snapshotRef.current;
      await submitDone(fileId, {
        baseRevision: revisionRef.current,
        annotation: { segmentation: { wartPoints: synced.breakpoints, humanAction: synced.humanAction, maskOperations: synced.maskOperations }, breakpoints: legacyBreakpointsRef.current },
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

  // Server duoc tai de doi chieu, nhung canvas van giu nguyen ban ve cuc bo cho toi khi
  // nguoi dung chu dong chon phien ban muon tiep tuc.
  const keepLocalDraft = () => {
    if (!staleDraft || !bootstrap || !draftFitsImage(staleDraft, bootstrap) || readOnly || conflictRef.current) return;
    legacyBreakpointsRef.current = staleDraft.breakpoints;
    staleDraftRef.current = null;
    dirtyVersionRef.current += 1;
    setStaleDraft(null);
    setStatus(navigator.onLine ? 'SAVING' : 'OFFLINE');
    setToast('Đang giữ bản vẽ trên thiết bị. Bấm Lưu để cập nhật lên máy chủ.');
  };

  const applyServerDraft = async () => {
    if (!bootstrap || !staleDraft || draftDecisionPending) return;
    setDraftDecisionPending(true);
    try {
      await deleteLocalDraft(bootstrap.file.projectId, fileId, userId);
      const serverSeed = createServerSeed(bootstrap);
      const serverSnapshot = { humanAction: serverSeed.humanAction, breakpoints: serverSeed.breakpoints, maskOperations: serverSeed.operations, polygons: polygonsFromOperations(serverSeed.operations) };
      setSeed({ ...serverSeed, key: Date.now() });
      setSnapshot(serverSnapshot); snapshotRef.current = serverSnapshot;
      legacyBreakpointsRef.current = bootstrap.annotation?.breakpoints ?? emptyBreakpoints;
      dirtyVersionRef.current = 0; syncedVersionRef.current = 0;
      staleDraftRef.current = null; setStaleDraft(null);
      setStatus('SAVED');
      setToast('Đã cập nhật canvas theo dữ liệu trên máy chủ.');
    } catch {
      setToast('Chưa thể cập nhật theo máy chủ. Bản vẽ hiện tại trên thiết bị vẫn được giữ nguyên.');
    } finally {
      setDraftDecisionPending(false);
    }
  };

  const flushExplicitly = useCallback(async () => {
    if (readOnly) return true;
    await persistLocal(pendingSyncState()).catch(() => undefined);
    return syncNow();
  }, [pendingSyncState, persistLocal, readOnly, syncNow]);

  const selectTool = useCallback(async (nextTool: EditorTool, nextStep = workspaceStep) => {
    if (navigating || status === 'SYNCING') return;
    if (nextStep !== workspaceStep && !await flushExplicitly()) return;
    if (!readOnly && !conflictRef.current && (['select', 'polygon', 'rectangle', 'circle', 'anchor', 'cut'].includes(nextTool)) && nextStep === 'mask') canvasRef.current?.beginPolygonEdit();
    if (nextTool === 'brush') setShowMask(true);
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
  const importPolygonJson = async (file: File) => {
    if (readOnly || conflictRef.current || navigating || status === 'SYNCING') return;
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('JSON phải nhỏ hơn 50 MB.');
      const parsed = parseWebPolygonImport(JSON.parse(await file.text()), bootstrap.file.externalKey, bootstrap.file.width, bootstrap.file.height);
      const breakpoints = parsed.wartPoints ?? snapshotRef.current.breakpoints;
      const next = { humanAction: 'MODIFIED' as const, breakpoints, maskOperations: parsed.operations,
        polygons: polygonsFromOperations(parsed.operations) };
      snapshotRef.current = next;
      setSnapshot(next);
      setSelectedPolygonIds([]);
      setReady(false);
      setSeed({ key: Date.now(), humanAction: 'MODIFIED', breakpoints, operations: parsed.operations });
      dirtyVersionRef.current += 1;
      setStatus(navigator.onLine ? 'SAVING' : 'OFFLINE');
      setTool('select');
      setWorkspaceStep('mask');
      setShowMask(true);
      const coco = parsed.coco;
      setToast(coco
        ? `Đã nhập ${next.polygons.length} polygon từ COCO 1.0 (${coco.fileName})`
          + (coco.skipped ? `, bỏ qua ${coco.skipped} annotation thuộc ${coco.skippedCategories.join(', ')}` : '')
          + (coco.invalid ? `, ${coco.invalid} annotation không đọc được hình học` : '')
          + '. Bấm Lưu để tạo version trên máy chủ.'
        : `Đã nhập ${next.polygons.length} polygon từ JSON. Bấm Lưu để tạo version trên máy chủ.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Không đọc được JSON polygon.');
    }
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
  // Hoan tat mot polygon chi la mot thao tac ve: khong gui server (xem onEditorChange).
  const completePolygon = () => {
    canvasRef.current?.completePolygon();
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
          {workspaceStep === 'mask' ? <div className={`overlay-controls ${tool === 'brush' ? 'with-brush-toolbar' : ''}`}>
            <button className={`layer-toggle ${showMask ? 'active' : ''}`} title={showMask ? 'Ẩn lớp phủ' : 'Hiện lớp phủ'} onClick={() => setShowMask((visible) => !visible)}><Icon name="layers" /> <span>{showMask ? 'Lớp phủ đang bật' : 'Lớp phủ đang ẩn'}</span></button>
            <button className={`layer-toggle magnet-toggle ${magnet ? 'active' : ''}`} aria-pressed={magnet} title={magnet ? 'Tắt magnet: kéo node trong chế độ V không dính vào điểm gần đó' : 'Bật magnet: kéo node trong chế độ V dính vào điểm gần đó'} onClick={() => setMagnet((value) => { localStorage.setItem('select-magnet', value ? '0' : '1'); return !value; })}><Icon name="magnet" /> <span>{magnet ? 'Magnet đang bật' : 'Magnet đang tắt'}</span></button>
            {showMask ? <div className="overlay-options">
              <label className="overlay-opacity" title="Độ đậm của mask và đường biên">
                <span>Độ mờ</span>
                <input type="range" min="0.1" max="1" step="0.05" value={opacity} aria-label="Độ mờ lớp phủ (mask và đường biên)" onChange={(event) => changeOpacity(Number(event.target.value))} />
                <strong>{Math.round(opacity * 100)}%</strong>
              </label>
            </div> : null}
          </div> : null}

          {workspaceStep === 'mask' && tool === 'brush' ? <fieldset className="brush-toolbar" disabled={readOnly || status === 'CONFLICT' || status === 'SYNCING' || navigating} aria-label="Công cụ bút vẽ và tẩy">
            <div className="brush-mode-switch" role="group" aria-label="Chế độ nét vẽ">
              <button type="button" className={brushMode === 'add' ? 'active' : ''} aria-pressed={brushMode === 'add'} title="Bút vẽ — tô thêm mask (B)" onClick={() => setBrushMode('add')}>
                <Icon name="brush" /><span>Bút vẽ</span>
              </button>
              <button type="button" className={brushMode === 'erase' ? 'active erase' : ''} aria-pressed={brushMode === 'erase'} title="Tẩy — tẩy xuyên qua mask để tách vùng (E)" onClick={() => setBrushMode('erase')}>
                <Icon name="eraser" /><span>Tẩy</span>
              </button>
            </div>
            <span className="toolbar-divider" />
            <label className="brush-size-field">
              <span>Cỡ nét</span>
              <input type="range" min={BRUSH_MIN_SIZE} max={BRUSH_SLIDER_MAX_SIZE} step="1" value={Math.min(brushSize, BRUSH_SLIDER_MAX_SIZE)}
                onChange={(event) => setBrushSize(clampBrushSize(Number(event.target.value)))} />
              <input className="brush-size-number" type="number" min={BRUSH_MIN_SIZE} max={BRUSH_MAX_SIZE} step="1" value={brushSize}
                aria-label="Cỡ nét theo pixel" onChange={(event) => setBrushSize(clampBrushSize(Number(event.target.value)))} />
            </label>
          </fieldset> : null}

          <div className="canvas-control-stack">
            <div className="viewport-zoom" aria-label="Điều khiển thu phóng">
              <button aria-label="Phóng to" title="Phóng to" onClick={() => canvasRef.current?.zoomBy(1.2)}>＋</button>
              <span ref={zoomLabelRef}>100%</span>
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
              <ToolbarButton active={tool === 'brush'} label="Bút vẽ / Tẩy mask (B)" icon="brush" onClick={() => selectTool('brush', 'mask')} />
              <ToolbarButton disabled={selectedPolygonIds.length < 2} label="Gộp polygon đã chọn" icon="merge" onClick={() => canvasRef.current?.groupSelectedPolygons()} />
              <ToolbarButton disabled={selectedPolygonIds.length < 1} label="Làm mịn biên polygon đã chọn" icon="smooth" onClick={() => canvasRef.current?.smoothSelectedPolygons()} />
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
            readOnly={readOnly || status === 'CONFLICT' || status === 'SYNCING' || navigating} tool={readOnly ? 'pan' : tool} maskOpacity={opacity} showMask={showMask} magnet={magnet}
            brushMode={brushMode} brushSize={brushSize}
            onHistoryChange={setHistory} onPolygonComplete={onPolygonComplete}
            onChange={onEditorChange} onSelectionChange={setSelectedPolygonIds} onReady={onCanvasReady} onMessage={setToast} onZoomChange={updateZoomLabel} />
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
                <label className="button ghost" title="Prelabel bitter-melon-prelabel-1.1 hoặc COCO 1.0 (instances_*.json, coco.json) của ảnh đang mở">Nhập JSON polygon / COCO 1.0
                  <input type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    if (file) void importPolygonJson(file);
                  }} />
                </label>
                {/* Thông báo của editor hiện ở đây thay cho toast nổi trên canvas (người dùng xác nhận 2026-11-05);
                    chưa có thông báo thì hiện gợi ý ngắn theo công cụ. */}
                <div className={`panel-message ${toast ? 'has-message' : ''}`} role="status" aria-live="polite">
                  {toast ? <><span>{toast}</span><button type="button" aria-label="Ẩn thông báo" title="Ẩn thông báo" onClick={() => setToast('')}>×</button></> : <span>{history.local
                  ? 'Đang vẽ polygon: Ctrl+Z gỡ từng điểm; Ctrl+Y hoặc Ctrl+Shift+Z chấm lại; Esc để hủy. Giữ Shift và trỏ vào trong mask kế bên để xem đường bám biên từ điểm vừa chấm; Shift + chuột trái để chèn các điểm đó (chưa hoàn tất). Nhấp đúp lên một điểm hoặc Enter để hoàn tất.'
                  : tool === 'anchor'
                  ? 'Chế độ điểm neo: Rê chuột lên viền mask để xem điểm thêm. Click và kéo chuột để tạo & tùy chỉnh anchor point ngay lập tức. Bấm chuột phải lên điểm để xóa.'
                  : tool === 'rectangle'
                  ? 'Chế độ hình chữ nhật: Nhấp và kéo chuột trên ảnh để tạo mask hình chữ nhật.'
                  : tool === 'circle'
                  ? 'Chế độ vòng tròn: Nhấp và kéo chuột để tạo mask vòng tròn/oval. Giữ Shift để tạo vòng tròn đều, giữ Alt để vẽ từ tâm.'
                  : tool === 'select'
                  ? `Chế độ chỉnh sửa: kéo node để chỉnh; chuột phải lên điểm để xóa.${magnet ? ' Magnet bật: node dính vào điểm gần đó.' : ''} Ctrl+Z hoàn tác.`
                  : 'Ctrl+Z hoàn tác toàn cục; Ctrl+Y hoặc Ctrl+Shift+Z làm lại.'}</span>}
                </div>
                {tool === 'polygon' ? <button className="button primary" onClick={() => void completePolygon()}>Hoàn tất polygon</button> : null}
                <div className="section-title-row"><p>Thông tin đối tượng</p><span>{polygonCount} vùng</span></div>
                <PolygonLabelEditor
                  key={`${selectedPolygonIds.join(',')}:${selectedPolygons.map((polygon) => `${polygon.label}:${Boolean(polygon.meta?.locked)}`).join(',')}`}
                  polygons={snapshot.polygons}
                  selectedPolygons={selectedPolygons}
                  onSelect={(polygonId) => {
                    canvasRef.current?.selectPolygon(polygonId);
                    selectTool('select', 'mask');
                  }}
                  onApply={(label, kind) => canvasRef.current?.updateSelectedPolygonLabel(label, kind) || false}
                  onGroup={() => canvasRef.current?.groupSelectedPolygons() || false}
                  onToggleLock={() => canvasRef.current?.toggleSelectedPolygonLock() || false}
                />
                <label className="range-field"><span>Độ mờ <strong>{Math.round(opacity * 100)}%</strong></span><input type="range" min="0.1" max="1" step="0.05" value={opacity} onChange={(event) => changeOpacity(Number(event.target.value))} /></label>
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

      {toast ? <button aria-live="polite" className={`toast ${!rightCollapsed && workspaceStep === 'mask' ? 'in-sidebar' : ''}`} onClick={() => setToast('')}>{toast}</button> : null}
      {helpOpen ? <div className="modal-backdrop help-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}><section className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
        <div className="shortcut-header"><div><span className="help-mark">?</span><span><h2 id="shortcut-title">Trợ giúp &amp; phím tắt</h2><p>Thao tác nhanh hơn trên vùng chú thích</p></span></div><button aria-label="Đóng trợ giúp" onClick={() => setHelpOpen(false)}>×</button></div>
        <div className="shortcut-content">
          <section><h3>Phím tắt</h3><Shortcut keys={['V']} label="Chọn / chỉnh sửa" /><Shortcut keys={['H']} label="Di chuyển ảnh" /><Shortcut keys={['P']} label="Vẽ polygon" /><Shortcut keys={['B']} label="Bút vẽ mask" /><Shortcut keys={['E']} label="Tẩy mask" /><Shortcut keys={['1']} label="Gán label u vấu mới (w*)" /><Shortcut keys={['2']} label="Gán label vết gợn mới (r*)" /><Shortcut keys={['[', ']']} label="Giảm / tăng cỡ nét" /><Shortcut keys={['R']} label="Vẽ hình chữ nhật" /><Shortcut keys={['C']} label="Vẽ vòng tròn" /><Shortcut keys={['A']} label="Thêm & kéo điểm neo" />{/* <Shortcut keys={['M']} label="Đánh dấu point u vấu" /> */}<Shortcut keys={['Enter']} label="Hoàn tất polygon" /><Shortcut keys={['Esc']} label="Hủy thao tác" /><Shortcut keys={['Delete']} label="Xóa lựa chọn" /><Shortcut keys={['Ctrl', 'A']} label="Chọn tất cả polygon" /><Shortcut keys={['Ctrl', 'Z']} label={history.local ? "Hoàn tác điểm (cục bộ)" : "Hoàn tác toàn cục"} /><Shortcut keys={['Ctrl', 'Y']} label={history.local ? "Làm lại điểm (cục bộ)" : "Làm lại toàn cục"} /></section>
          <section className="usage-tips"><h3>Mẹo sử dụng</h3><p><Icon name="cursor" />Ở chế độ V, kéo khung qua các node để chọn nhiều polygon.</p><p><Icon name="polygon" />Chế độ P chỉ dùng để vẽ một polygon mới. Nhấp chuột trái chấm điểm; giữ Shift + trỏ vào trong mask kế bên rồi Shift + chuột trái để chèn các điểm bám biên còn trống (không gộp mask); nhấp đúp lên một điểm để hoàn tất.</p><p><Icon name="eraser" />Ở chế độ B, tẩy xuyên qua mask để tách vùng; mỗi vùng khép kín thành một mask riêng.</p><p><Icon name="rectangle" />Chế độ R: Kéo chuột để vẽ nhanh mask hình chữ nhật.</p><p><Icon name="circle" />Chế độ C: Kéo chuột để vẽ mask hình tròn/oval. Giữ Shift để tạo vòng tròn đều, Alt để vẽ từ tâm.</p><p><Icon name="anchor" />Chế độ A (Điểm neo): Click lên viền mask để tạo anchor point và kéo tùy chỉnh hình dạng mask.</p><p><Icon name="layers" />Ẩn lớp phủ khi cần quan sát ảnh gốc.</p><p><Icon name="hand" />Dùng con lăn để zoom; Shift + con lăn để cuộn ngang; Ctrl + Shift + con lăn để cuộn dọc; kéo thanh cuộn ở mép canvas khi đã phóng to.</p></section>
        </div>
      </section></div> : null}
      {staleDraft && !conflict ? <div className="modal-backdrop draft-choice-backdrop"><section className="draft-choice-dialog" role="dialog" aria-modal="true" aria-labelledby="draft-choice-title" aria-describedby="draft-choice-description">
        <div className="draft-choice-icon" aria-hidden="true"><Icon name="files" /></div>
        <p className="eyebrow">Có bản vẽ chưa đồng bộ</p>
        <h2 id="draft-choice-title">Bạn muốn tiếp tục thế nào?</h2>
        <p id="draft-choice-description">Hệ thống phát hiện bản vẽ trên thiết bị chưa được gửi lên. {draftFitsImage(staleDraft, bootstrap) ? 'Canvas đang hiển thị bản vẽ trên thiết bị.' : 'Ảnh đã đổi hoặc bản nháp thiếu thông tin crop. Canvas hiển thị bản máy chủ; bản nháp được giữ để tải về, không ép sang ảnh khác.'}</p>
        <button className="button ghost" onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(staleDraft, null, 2)], { type: 'application/json' }));
          const link = document.createElement('a'); link.href = url; link.download = `${fileId}-local-draft.json`; link.click(); URL.revokeObjectURL(url);
        }}>Tải bản nháp chưa đồng bộ</button>
        <div className="draft-choice-options">
          <button className="draft-choice-option device" type="button" disabled={draftDecisionPending || !draftFitsImage(staleDraft, bootstrap)} onClick={keepLocalDraft}>
            <strong>Giữ bản vẽ hiện tại</strong>
            <span>Tiếp tục với phần đang làm dở trên thiết bị. Bạn cần bấm Lưu để gửi bản này lên máy chủ.</span>
          </button>
          <button className="draft-choice-option server" type="button" disabled={draftDecisionPending} onClick={() => void applyServerDraft()}>
            <strong>{draftDecisionPending ? 'Đang cập nhật…' : 'Cập nhật từ máy chủ'}</strong>
            <span>Thay canvas bằng phiên bản đã đồng bộ. Bản vẽ chưa gửi trên thiết bị sẽ bị bỏ.</span>
          </button>
        </div>
        <p className="draft-choice-note">Chưa có dữ liệu nào bị thay thế cho đến khi bạn chọn.</p>
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

type IconName = 'brush' | 'chevron-left' | 'chevron-right' | 'cursor' | 'eraser' | 'files' | 'fit' | 'folder' | 'hand' | 'layers' | 'merge' | 'pin' | 'polygon' | 'redo' | 'smooth' | 'trash' | 'undo' | 'rectangle' | 'circle' | 'anchor' | 'magnet';

function ToolbarButton({ active = false, danger = false, disabled = false, icon, label, onClick }: { active?: boolean; danger?: boolean; disabled?: boolean; icon: IconName; label: string; onClick(): void }) {
  return <button type="button" aria-label={label} aria-pressed={active || undefined} className={`${active ? 'active' : ''} ${danger ? 'danger' : ''}`} disabled={disabled} title={label} onClick={onClick}><Icon name={icon} /></button>;
}

function Shortcut({ keys, label }: { keys: string[]; label: string }) {
  return <div className="shortcut-row"><span>{label}</span><span>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</span></div>;
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    brush: <><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" /><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02Z" /></>,
    smooth: <path d="M3 17c3-8 6-10 9-5s6 3 9-5" />,
    'chevron-left': <path d="m15 18-6-6 6-6" />,
    'chevron-right': <path d="m9 18 6-6-6-6" />,
    cursor: <path d="m5 3 6.4 15 2.2-5.4L19 10.4 5 3Z" />,
    eraser: <><path d="m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21" /><path d="M22 21H7M5 11l8 8" /></>,
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
    magnet: <><path d="M6 3v8a6 6 0 0 0 12 0V3" /><path d="M6 3h4v8a2 2 0 0 0 4 0V3h4" /><path d="M6 7h4m4 0h4" /></>,
    redo: <><path d="m17 7 4 4-4 4" /><path d="M3 18v-2a5 5 0 0 1 5-5h13" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7" /><path d="M10 11v6m4-6v6" /></>,
    undo: <><path d="m7 7-4 4 4 4" /><path d="M21 18v-2a5 5 0 0 0-5-5H3" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function PolygonLabelEditor({
  onApply,
  onGroup,
  onSelect,
  onToggleLock,
  polygons,
  selectedPolygons,
}: {
  onApply(label: string, kind: PolygonLabelKind): boolean;
  onGroup(): boolean;
  onSelect(polygonId: string): void;
  onToggleLock(): boolean;
  polygons: AnnotationPolygon[];
  selectedPolygons: AnnotationPolygon[];
}) {
  const sharedLabel = selectedPolygons.length > 0
    && selectedPolygons.every((polygon) => polygon.label === selectedPolygons[0].label)
    ? selectedPolygons[0].label
    : '';
  const selectedId = selectedPolygons.length === 1 ? selectedPolygons[0].id : '';
  const selectedKind = selectedPolygons.length > 0
    && selectedPolygons.every((polygon) => polygonLabelKind(polygon) === polygonLabelKind(selectedPolygons[0]))
    ? polygonLabelKind(selectedPolygons[0])
    : null;
  const ridgeLabels = labelsForKind(polygons, 'ridge');
  const wartLabels = labelsForKind(polygons, 'wart');
  const [activeKind, setActiveKind] = useState<PolygonLabelKind | null>(selectedKind);
  const selectedPolygon = selectedPolygons.length === 1 ? selectedPolygons[0] : null;

  const assign = (label: string, kind: PolygonLabelKind) => {
    if (label && selectedPolygons.length) onApply(label, kind);
  };

  return (
    <div className="polygon-label-editor">
      <div className="polygon-label-heading">
        <div><span aria-hidden="true">◆</span><strong>Label polygon</strong></div>
        <small>{selectedPolygons.length ? `${selectedPolygons.length} đang chọn` : 'Chưa chọn vùng'}</small>
      </div>
      <div className="polygon-selection-row">
        <label>
          <span>Polygon</span>
          <select value={selectedId} onChange={(event) => event.target.value && onSelect(event.target.value)}>
            <option value="">{selectedPolygons.length > 1 ? `${selectedPolygons.length} polygon đang chọn` : 'Chọn polygon…'}</option>
            {polygons.map((polygon, index) => (
              <option key={polygon.id} value={polygon.id}>#{index + 1} · {polygon.label}</option>
            ))}
          </select>
        </label>
        {selectedPolygon ? <button
          type="button"
          className={`polygon-lock ${selectedPolygon.meta?.locked ? 'locked' : ''}`}
          aria-pressed={selectedPolygon.meta?.locked === true}
          title={selectedPolygon.meta?.locked ? 'Mở khóa polygon' : 'Khóa polygon'}
          onClick={onToggleLock}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="10" width="14" height="11" rx="2" />
            <path d={selectedPolygon.meta?.locked ? 'M8 10V7a4 4 0 0 1 8 0v3' : 'M8 10V7a4 4 0 0 1 7.5-2'} />
            <path d="M12 14v3" />
          </svg>
          {selectedPolygon.meta?.locked ? 'Đã khóa' : 'Khóa'}
        </button> : null}
      </div>
      <div className="label-kind-choice" role="group" aria-label="Chọn loại label">
        <button type="button" className={activeKind === 'ridge' ? 'active ridge' : ''} onClick={() => setActiveKind('ridge')}>
          <span aria-hidden="true">R</span><strong>Vết gợn</strong>
        </button>
        <button type="button" className={activeKind === 'wart' ? 'active wart' : ''} onClick={() => setActiveKind('wart')}>
          <span aria-hidden="true">W</span><strong>U vấu</strong>
        </button>
      </div>
      {activeKind ? <LabelGroup
        kind={activeKind}
        title={activeKind === 'ridge' ? 'Vết gợn' : 'U vấu'}
        labels={activeKind === 'ridge' ? ridgeLabels : wartLabels}
        value={selectedKind === activeKind ? sharedLabel : ''}
        disabled={!selectedPolygons.length || selectedPolygons.some((polygon) => polygon.meta?.locked)}
        onAssign={assign}
        onCreate={() => assign(nextLabel(polygons, activeKind), activeKind)}
      /> : <p className="label-kind-hint">Chọn loại label trước, sau đó chọn ID hoặc tạo mới.</p>}
      <button
        type="button"
        className="button polygon-group"
        disabled={selectedPolygons.length < 2 || !selectedPolygons.every((polygon) => polygon.label === selectedPolygons[0]?.label)}
        onClick={() => onGroup()}
      >
        {selectedPolygons.length >= 2 ? `Gộp ${selectedPolygons.length} polygon` : 'Gộp polygon'}
      </button>
    </div>
  );
}

function LabelGroup({
  disabled,
  kind,
  labels,
  onAssign,
  onCreate,
  title,
  value,
}: {
  disabled: boolean;
  kind: PolygonLabelKind;
  labels: string[];
  onAssign(label: string, kind: PolygonLabelKind): void;
  onCreate(): void;
  title: string;
  value: string;
}) {
  return <section className={`polygon-label-group ${kind}`}>
    <div><strong>{title}</strong><small>{kind === 'ridge' ? 'r1, r2, r3…' : 'w1, w2, w3…'}</small></div>
    <div className="polygon-label-controls">
      <select
        aria-label={`Chọn label ${title}`}
        disabled={disabled || labels.length === 0}
        value={value}
        onChange={(event) => onAssign(event.target.value, kind)}
      >
        <option value="">{labels.length ? 'Chọn label…' : 'Chưa có label'}</option>
        {labels.map((label) => <option key={label} value={label}>{label}</option>)}
      </select>
      <button type="button" className="button label-create" disabled={disabled} onClick={onCreate}>＋ Tạo mới</button>
    </div>
  </section>;
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const copy = { LOCAL: 'Đã lưu local · chưa gửi server', SAVED: 'Đã lưu server', SAVING: 'Có thay đổi · lưu local mỗi 30s', OFFLINE: 'Ngoại tuyến · chưa gửi server', SYNCING: 'Đang lưu server…', CONFLICT: 'Chỉ xem · có xung đột' };
  return <span className={`save-indicator ${status.toLowerCase()}`}><i aria-hidden="true" />{copy[status]}</span>;
}

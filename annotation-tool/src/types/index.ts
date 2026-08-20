// ─── Enums & Literals ───────────────────────────────────

export type UserRole = 'ADMIN' | 'ANNOTATOR' | 'REVIEWER';
export type AnnotationState = 'UNSTARTED' | 'DRAFT' | 'DONE';
export type HumanAction = 'UNTOUCHED' | 'ACCEPTED' | 'MODIFIED';
export type BreakpointState = 'NOT_ANNOTATED' | 'ANNOTATED' | 'CONFIRMED_NONE';
export type AnnotationStatus = 'DRAFT' | 'DONE';
export type SyncState = 'SYNCED' | 'DIRTY' | 'SYNCING' | 'CONFLICT';
export type SessionCloseReason = 'DONE' | 'SWITCH_FILE' | 'EXPLICIT_RELEASE' | 'LOCK_EXPIRED' | 'UNKNOWN';

export type ErrorCode =
  | 'FILE_LOCKED' | 'LOCK_LOST' | 'REVISION_CONFLICT'
  | 'INVALID_ANNOTATION' | 'ASSET_NOT_FOUND' | 'DRIVE_SYNC_ERROR'
  | 'FILE_NOT_FOUND' | 'UNAUTHORIZED' | 'FORBIDDEN';

export type LockState =
  | { state: 'AVAILABLE' }
  | { state: 'LOCKED'; userId: string; displayName: string; expiresAt: string };

// ─── Annotation Payloads ────────────────────────────────

export interface BreakpointPoint {
  id: string;
  x: number;
  y: number;
}

export interface PolygonNode {
  id: string;
  x: number;
  y: number;
}

export interface AnnotationPolygonMeta {
  semantic?: 'main_flesh_band' | 'wart_flesh' | string;
  mainGroupId?: string | number;
  wartId?: string | number;
  fragmentIndex?: number;
  corridorId?: string | number;
  primitiveId?: string | number;
  source?: 'model' | 'human';
}

export interface AnnotationPolygon {
  id: string;
  label: string;
  nodes: PolygonNode[];
  meta?: AnnotationPolygonMeta;
}

export interface SegmentationAnnotation {
  sourcePredictionDriveFileId: string;
  humanAction: HumanAction;
  maskStorageKey?: string;
  maskOperations?: MaskOperation[];
}

export interface BreakpointAnnotation {
  state: BreakpointState;
  points: BreakpointPoint[];
}

export interface Annotation {
  datasetFileId: string;
  revision: number;
  segmentation: SegmentationAnnotation;
  breakpoints: BreakpointAnnotation;
  lastEditedBy: string;
  updatedAt: string;
  status: AnnotationStatus;
}

// ─── API DTOs ───────────────────────────────────────────

export interface FileListItem {
  id: string;
  externalKey: string;
  thumbnailUrl?: string;
  annotationState: AnnotationState;
  assetState: 'READY' | 'ERROR';
  lock: LockState;
  assignment?: { userId: string; displayName: string };
  latestRevision: number;
  latestVersionNumber: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface LockAcquireResponse {
  sessionId: string;
  lockToken: string;
  expiresAt: string;
  baseRevision: number;
}

export interface HeartbeatResponse {
  expiresAt: string;
}

export interface EditorBootstrap {
  file: { id: string; projectId: string; externalKey: string; width: number; height: number };
  assets: { imageUrl: string; predictionMaskUrl: string; currentMaskUrl?: string };
  annotation: Annotation | null;
  prelabelOperations?: MaskOperation[];
  lock: { sessionId: string; lockToken: string; expiresAt: string };
}

export interface SaveDraftRequest {
  baseRevision: number;
  segmentation: { humanAction: HumanAction; maskUploadRef?: string; maskOperations?: MaskOperation[] };
  breakpoints: BreakpointAnnotation;
}

export interface SaveDraftResponse {
  revision: number;
  savedAt: string;
}

export interface DoneRequest {
  baseRevision: number;
  annotation: {
    segmentation: { humanAction: HumanAction; maskUploadRef?: string; maskOperations?: MaskOperation[] };
    breakpoints: BreakpointAnnotation;
  };
}

export interface DoneResponse {
  revision: number;
  versionNumber: number;
  annotationState: 'DONE';
  lockState: 'AVAILABLE';
}

export interface ApiError {
  code: ErrorCode;
  message: string;
  [key: string]: unknown;
}

export interface CurrentUser {
  id: string;
  displayName: string;
  role: UserRole;
}

export interface ProjectSummary {
  id: string;
  name: string;
  driveFolderId: string;
  exportDriveFolderId: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Mask Operations (Client) ───────────────────────────

export type MaskOperation =
  | { type: 'BRUSH_ADD'; brushSize: number; points: Array<{ x: number; y: number }> }
  | { type: 'BRUSH_ERASE'; brushSize: number; points: Array<{ x: number; y: number }> }
  | { type: 'POLYGON_SET'; polygons: AnnotationPolygon[] }
  | { type: 'RESET_TO_PREDICTION' };

// ─── Local Draft (IndexedDB) ────────────────────────────

export interface LocalDraft {
  key: string;
  projectId: string;
  fileId: string;
  userId: string;
  baseServerRevision: number;
  humanAction: HumanAction;
  maskSnapshotBlob?: Blob;
  maskOperations?: MaskOperation[];
  breakpoints: BreakpointAnnotation;
  updatedAt: number;
  syncState: SyncState;
}

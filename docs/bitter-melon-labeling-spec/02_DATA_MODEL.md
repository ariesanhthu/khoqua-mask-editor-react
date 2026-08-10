# 02 — Data Model

This document defines the minimum shared data model.

Names may be adapted to the selected ORM, but behavior and relationships should remain equivalent.

---

## 1. Core entities

```text
User
Project
Dataset
DatasetFile
Assignment
FileLock
Annotation
AnnotationVersion
AnnotationSession
```

---

## 2. User

```ts
type User = {
  id: string;
  displayName: string;
  email?: string;
  role: "ADMIN" | "ANNOTATOR" | "REVIEWER";
  createdAt: string;
};
```

Authentication implementation may vary.

---

## 3. Project

```ts
type Project = {
  id: string;
  name: string;
  driveFolderId: string;
  createdAt: string;
  updatedAt: string;
};
```

A project may contain one or more datasets.

---

## 4. Dataset

```ts
type Dataset = {
  id: string;
  projectId: string;
  name: string;
  datasetVersion?: string;
  algorithmVersion?: string;
  manifestDriveFileId?: string;
  createdAt: string;
  updatedAt: string;
  lastDriveSyncAt?: string;
};
```

---

## 5. DatasetFile

```ts
type AnnotationState = "UNSTARTED" | "DRAFT" | "DONE";

type DatasetFile = {
  id: string;
  datasetId: string;

  externalKey: string;      // e.g. BM_000123
  imageDriveFileId: string;
  predictionDriveFileId: string;

  imageFilename: string;
  predictionFilename: string;

  width?: number;
  height?: number;

  annotationState: AnnotationState;

  latestRevision: number;   // monotonic integer
  latestVersionNumber: number;

  createdAt: string;
  updatedAt: string;
};
```

Rules:

- `externalKey` is unique within a dataset.
- `latestRevision` increases on accepted shared draft mutation.
- `latestVersionNumber` increases only on completed immutable versions.

---

## 6. Assignment

```ts
type Assignment = {
  id: string;
  datasetFileId: string;
  userId: string;
  assignedBy?: string;
  createdAt: string;
};
```

Assignment means:

> who is expected to work on the file.

It does **not** mean:

> who currently owns the edit lock.

---

## 7. FileLock

```ts
type FileLock = {
  datasetFileId: string;   // unique: one active lock per file

  userId: string;
  sessionId: string;
  lockTokenHash: string;

  acquiredAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
};
```

Rules:

- at most one active non-expired lock per file;
- lock acquisition must be atomic;
- expired locks may be replaced;
- all mutation endpoints must validate the lock token.

Do not expose the stored token hash to clients.

---

## 8. Annotation

Represents the latest shared mutable annotation state.

```ts
type Annotation = {
  datasetFileId: string;

  revision: number;

  segmentation: SegmentationAnnotation;
  breakpoints: BreakpointAnnotation;

  lastEditedBy: string;
  updatedAt: string;

  status: "DRAFT" | "DONE";
};
```

---

## 9. Segmentation annotation

The application receives a pre-generated prediction mask.

The user may:

- accept it unchanged;
- modify it;
- reset to prediction.

Recommended shared representation:

```ts
type SegmentationAnnotation = {
  sourcePredictionDriveFileId: string;

  humanAction:
    | "UNTOUCHED"
    | "ACCEPTED"
    | "MODIFIED";

  maskStorageKey?: string;
};
```

`maskStorageKey` points to the current materialized annotation mask in backend storage.

The final human annotation must not overwrite the original prediction mask.

---

## 10. Breakpoint annotation

```ts
type BreakpointPoint = {
  id: string;
  x: number;
  y: number;
};

type BreakpointAnnotation = {
  state:
    | "NOT_ANNOTATED"
    | "ANNOTATED"
    | "CONFIRMED_NONE";

  points: BreakpointPoint[];
};
```

Important:

```text
points = []
```

does **not** automatically mean `CONFIRMED_NONE`.

The user must explicitly confirm no breakpoint.

---

## 11. AnnotationVersion

Immutable snapshot created on `Done`.

```ts
type AnnotationVersion = {
  id: string;
  datasetFileId: string;

  versionNumber: number;
  baseRevision: number;

  segmentation: SegmentationAnnotation;
  breakpoints: BreakpointAnnotation;

  createdBy: string;
  createdAt: string;
};
```

Rules:

- immutable after creation;
- never update old versions;
- re-editing a `DONE` file later creates a new version.

---

## 12. AnnotationSession

```ts
type AnnotationSession = {
  id: string;
  datasetFileId: string;
  userId: string;

  baseRevision: number;

  openedAt: string;
  lastActivityAt: string;

  closedAt?: string;
  closeReason?:
    | "DONE"
    | "SWITCH_FILE"
    | "EXPLICIT_RELEASE"
    | "LOCK_EXPIRED"
    | "UNKNOWN";
};
```

A session is useful for:

- lock ownership;
- metrics;
- recovery diagnostics;
- revision conflict detection.

---

## 13. Suggested relational schema

Pseudo-SQL:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  drive_folder_id TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE datasets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  dataset_version TEXT,
  algorithm_version TEXT,
  manifest_drive_file_id TEXT,
  last_drive_sync_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE dataset_files (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  external_key TEXT NOT NULL,
  image_drive_file_id TEXT NOT NULL,
  prediction_drive_file_id TEXT NOT NULL,
  image_filename TEXT NOT NULL,
  prediction_filename TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  annotation_state TEXT NOT NULL,
  latest_revision INTEGER NOT NULL DEFAULT 0,
  latest_version_number INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  UNIQUE(dataset_id, external_key)
);

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  dataset_file_id TEXT NOT NULL REFERENCES dataset_files(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  assigned_by TEXT,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE file_locks (
  dataset_file_id TEXT PRIMARY KEY REFERENCES dataset_files(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL,
  lock_token_hash TEXT NOT NULL,
  acquired_at TIMESTAMP NOT NULL,
  last_heartbeat_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL
);

CREATE TABLE annotations (
  dataset_file_id TEXT PRIMARY KEY REFERENCES dataset_files(id),
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  segmentation_json TEXT NOT NULL,
  breakpoints_json TEXT NOT NULL,
  last_edited_by TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE annotation_versions (
  id TEXT PRIMARY KEY,
  dataset_file_id TEXT NOT NULL REFERENCES dataset_files(id),
  version_number INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  segmentation_json TEXT NOT NULL,
  breakpoints_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  UNIQUE(dataset_file_id, version_number)
);

CREATE TABLE annotation_sessions (
  id TEXT PRIMARY KEY,
  dataset_file_id TEXT NOT NULL REFERENCES dataset_files(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  base_revision INTEGER NOT NULL,
  opened_at TIMESTAMP NOT NULL,
  last_activity_at TIMESTAMP NOT NULL,
  closed_at TIMESTAMP,
  close_reason TEXT
);
```

SQLite is sufficient for an initial small-team deployment.

PostgreSQL may replace it later without changing the model semantics.

---

## 14. File list DTO

Recommended response shape:

```ts
type FileListItem = {
  id: string;
  externalKey: string;

  thumbnailUrl?: string;

  annotationState: "UNSTARTED" | "DRAFT" | "DONE";

  lock:
    | { state: "AVAILABLE" }
    | {
        state: "LOCKED";
        userId: string;
        displayName: string;
        expiresAt: string;
      };

  assignment?: {
    userId: string;
    displayName: string;
  };

  latestRevision: number;
  latestVersionNumber: number;
};
```

---

## 15. Editor bootstrap DTO

```ts
type EditorBootstrap = {
  file: {
    id: string;
    externalKey: string;
    width: number;
    height: number;
  };

  assets: {
    imageUrl: string;
    predictionMaskUrl: string;
  };

  annotation: Annotation | null;

  lock: {
    sessionId: string;
    lockToken: string;
    expiresAt: string;
  };
};
```

---

## 16. Revision rules

Revision is monotonically increasing.

Example:

```text
server revision 12
client opens revision 12
client autosaves -> server revision 13
client autosaves -> server revision 14
```

A write containing `baseRevision = 12` when server is already at `14` must be rejected.

Never silently apply stale writes.

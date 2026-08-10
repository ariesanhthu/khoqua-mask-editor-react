# 07 — Implementation Plan

## 1. Recommended stack

### Frontend

```text
Next.js
React
TypeScript
Canvas library or custom Canvas/WebGL editor
IndexedDB wrapper
```

Suitable IndexedDB wrappers include:

- Dexie;
- idb.

Do not use `localStorage` for annotation bodies.

---

### Backend

```text
FastAPI
Python
SQLAlchemy / SQLModel or equivalent
SQLite for V1
```

Possible later migration:

```text
PostgreSQL
```

---

### Storage

V1:

```text
backend filesystem
```

For:

- materialized draft masks;
- annotation versions;
- temporary export artifacts.

Google Drive remains the source dataset storage.

---

## 2. Implementation sequence

### Phase 1 — Backend foundation

Implement:

- project;
- dataset;
- dataset file;
- users;
- file listing;
- SQLite schema;
- basic authentication placeholder if needed.

Acceptance:

- project loads;
- file list can be returned from database.

---

### Phase 2 — Drive sync

Implement:

- configured Drive folder;
- manifest reader;
- file-ID resolution;
- dataset index upsert;
- image/prediction fetch endpoint.

Acceptance:

- web does not need manual image upload;
- backend indexes Drive dataset;
- one file can load its image and prediction.

---

### Phase 3 — Locking

Implement:

- atomic lock acquisition;
- lock token;
- heartbeat;
- TTL;
- unlock;
- lock expiry;
- `423 FILE_LOCKED`.

Acceptance:

- two users cannot edit same file simultaneously;
- different files may be edited concurrently;
- crashed browser lock eventually expires.

---

### Phase 4 — Annotation editor

Implement P0 tools:

#### Segmentation

- display prediction;
- add brush;
- erase brush;
- brush size;
- reset;
- undo/redo;
- opacity.

#### Breakpoint

- add;
- move;
- delete;
- explicit no-breakpoint.

Acceptance:

- all editing renders locally without API wait.

---

### Phase 5 — IndexedDB autosave

Implement:

- local draft record;
- debounced local persistence;
- reload recovery;
- last opened file metadata.

Acceptance test:

```text
edit mask
place breakpoint
refresh browser
latest work returns
```

without requiring a successful server save immediately before refresh.

---

### Phase 6 — Backend autosave + revisions

Implement:

- draft endpoint;
- revision checking;
- batched/debounced client sync;
- save state indicator.

Acceptance:

- no request per pointer move;
- server revision increments correctly;
- stale write gets `REVISION_CONFLICT`.

---

### Phase 7 — Offline behavior

Implement:

- online/offline detection;
- pause server sync;
- continue current editor;
- local persistence;
- reconnect lock/revision check;
- conflict-safe behavior.

Acceptance:

```text
open file online
disconnect network
edit
refresh if desired
reconnect
```

Work remains recoverable.

---

### Phase 8 — Done/versioning

Implement:

- final validation;
- flush draft;
- immutable annotation version;
- mark DONE;
- release lock;
- allow re-edit.

Acceptance:

```text
User A Done
file becomes available
User B opens same file
User B edits
User B Done
```

Two completed versions exist.

---

### Phase 9 — Export

Implement:

- materialized binary mask;
- breakpoints JSONL;
- export manifest;
- optional Drive export.

Acceptance:

- exported annotation is deterministic;
- prediction mask remains unchanged;
- final human mask is separate.

---

## 3. P0 feature checklist

### Dataset

- [ ] load project from configured Drive
- [ ] sync manifest
- [ ] file list
- [ ] lazy image loading
- [ ] lazy prediction loading

### Multi-user

- [ ] lock file
- [ ] heartbeat
- [ ] TTL
- [ ] lock owner display
- [ ] release on Done
- [ ] re-edit completed file

### Segmentation

- [ ] prediction overlay
- [ ] add brush
- [ ] erase brush
- [ ] brush size
- [ ] undo
- [ ] redo
- [ ] reset to prediction
- [ ] opacity
- [ ] accept prediction

### Breakpoint

- [ ] add point
- [ ] move point
- [ ] delete point
- [ ] confirmed no breakpoint

### Persistence

- [ ] RAM live state
- [ ] IndexedDB draft
- [ ] local reload recovery
- [ ] server debounced autosave
- [ ] revision check
- [ ] conflict preservation

### Completion

- [ ] validation
- [ ] Done
- [ ] immutable version
- [ ] release lock
- [ ] export data

---

## 4. Explicit non-goals for V1

Do not implement unless required later:

- live collaborative editing of the same file;
- automatic merge of segmentation conflicts;
- in-browser execution of the unsupervised pipeline;
- model training;
- active learning;
- advanced reviewer workflow;
- mobile annotation;
- chat;
- Kubernetes;
- microservices;
- complex RBAC;
- public cloud deployment;
- full-dataset offline download.

---

## 5. Required end-to-end scenarios

Codex should not consider the system complete until these pass.

### Scenario A — normal annotation

```text
open project
select available file
acquire lock
load image + prediction
edit segmentation
add breakpoints
autosave
Done
release lock
```

---

### Scenario B — two users

```text
A opens file 1
B tries file 1 -> blocked
B opens file 2 -> allowed
A Done file 1
B may now open file 1
```

---

### Scenario C — refresh

```text
A edits file
latest changes persist to IndexedDB
A refreshes page
local work restores
```

---

### Scenario D — network loss

```text
A edits file
network disconnects
A continues editing
changes persist locally
network returns
revision/lock is checked
changes sync if safe
```

---

### Scenario E — crashed browser

```text
A acquires file lock
browser dies
no more heartbeat
TTL expires
B can later acquire file
```

---

### Scenario F — offline conflict

```text
A loses network
A keeps editing locally
A lock expires
B edits and completes file
A reconnects
server revision differs
A local work is preserved
A cannot overwrite B silently
```

---

### Scenario G — re-edit Done file

```text
file is DONE and AVAILABLE
A acquires lock
latest human annotation loads
A edits
A Done
new immutable version is created
```

---

## 6. Performance acceptance criteria

The exact numeric target depends on hardware, but behavior must satisfy:

- brush interaction has no network-dependent latency;
- point placement appears immediately;
- autosave creates no visible canvas stall;
- no full mask upload per pointer movement;
- project list does not download all full-resolution images;
- only selected and nearby prefetched assets are loaded.

---

## 7. Logging

Backend should log:

- lock acquired;
- lock denied;
- lock expired;
- lock released;
- draft save;
- revision conflict;
- Done;
- Drive sync error.

Do not log secret lock tokens.

Client may log development diagnostics, but production UI should show non-technical messages.

---

## 8. Environment variables

Suggested:

```text
DATABASE_URL=
ANNOTATION_STORAGE_PATH=

GOOGLE_DRIVE_AUTH_MODE=
GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON=
GOOGLE_DRIVE_ROOT_FOLDER_ID=

LOCK_TTL_SECONDS=
LOCK_HEARTBEAT_SECONDS=
```

Do not expose Drive secrets using `NEXT_PUBLIC_*`.

---

## 9. Final implementation constraint

When requirements appear to conflict, preserve these priorities in order:

```text
1. Never lose user annotation silently.
2. Never allow silent cross-user overwrite.
3. Keep interaction independent from network latency.
4. Keep prediction immutable.
5. Keep Drive out of the real-time edit loop.
6. Prefer simple implementation over premature infrastructure.
```

# 01 — System Architecture

## 1. Goal

Build a multi-user annotation web application that:

- loads source images and unsupervised prediction masks from Google Drive;
- allows annotators to correct segmentation masks;
- allows annotators to label ridge breakpoints;
- prevents two users from editing the same file at the same time;
- autosaves work locally without interrupting interaction;
- autosaves shared drafts to the backend asynchronously;
- recovers work after refresh, browser crash, or temporary network loss;
- allows completed files to be edited again.

The unsupervised algorithm is not executed by this application.

---

## 2. High-level architecture

```text
                       GOOGLE DRIVE
              images + prediction masks
                         |
                         | index / fetch
                         v
+---------------------------------------------------+
|                  BACKEND API                      |
|                                                   |
|  Authentication                                   |
|  Project / dataset index                          |
|  File metadata                                    |
|  Lock coordinator                                 |
|  Annotation revisions                             |
|  Draft persistence                                |
|  Drive synchronization                            |
|                                                   |
|             Database + file storage               |
+-----------------------+---------------------------+
                        |
                        | REST + optional SSE/WS
                        v
+---------------------------------------------------+
|                   WEB CLIENT                      |
|                                                   |
|  File browser                                     |
|  Annotation canvas                                |
|  Segmentation editor                              |
|  Breakpoint editor                                |
|                                                   |
|  RAM         -> live state                        |
|  IndexedDB   -> local draft/recovery              |
|  localStorage-> preferences only                  |
+---------------------------------------------------+
```

---

## 3. Component responsibilities

### 3.1 Google Drive

Responsibilities:

- store source images;
- store unsupervised prediction masks;
- optionally store exported final annotation artifacts;
- expose one configured project/dataset folder to the backend.

Drive is **not responsible for**:

- current file lock state;
- annotation session state;
- autosave;
- revision conflict control;
- real-time collaboration;
- `DOING` / `DONE` coordination.

---

### 3.2 Backend API

The backend is the coordination authority.

It owns:

- project metadata;
- dataset metadata;
- file index;
- annotation status;
- active lock;
- lock expiration;
- user identity;
- revision number;
- annotation version history;
- current shared draft;
- final submitted annotation.

The backend must enforce all concurrency rules.

The browser must never be trusted to enforce single-editor behavior on its own.

---

### 3.3 Browser application

The browser owns the interaction loop.

It must:

- render edits immediately;
- keep the active annotation in memory;
- persist local recovery data to IndexedDB asynchronously;
- batch/debounce server autosaves;
- continue editing the currently opened file during temporary network loss;
- restore unfinished local work after reload;
- surface connection/save state without blocking the editor.

---

## 4. Storage hierarchy

### Tier 1 — RAM

Used for:

- current mask bitmap/canvas state;
- current breakpoints;
- active tool;
- zoom/pan;
- current undo/redo history;
- dirty state.

Properties:

- fastest;
- synchronous from UI perspective;
- lost on refresh;
- must be backed by IndexedDB.

---

### Tier 2 — IndexedDB

Used for:

- unsynced draft;
- current mask snapshot;
- mask edit operations;
- breakpoints;
- base revision;
- last local update time;
- cached current image/prediction;
- optionally next few preloaded assets.

Properties:

- asynchronous;
- large enough for binary data;
- survives refresh/restart;
- local to browser/device.

---

### Tier 3 — Backend

Used for:

- shared draft;
- latest revision;
- locks;
- annotation versions;
- completed annotation;
- cross-user synchronization.

Properties:

- shared authority;
- revision-controlled;
- must reject stale updates.

---

### Tier 4 — Google Drive

Used for:

- original dataset;
- prediction artifacts;
- exported final outputs.

Drive writes must occur at coarse boundaries, not during every editor interaction.

---

## 5. Core data flow

### 5.1 Open project

```text
Browser
  |
  | GET project/files
  v
Backend
  |
  | indexed metadata
  v
Browser file list
```

The browser must not enumerate the entire Drive folder directly.

The backend owns Drive indexing.

---

### 5.2 Open file for editing

```text
User selects file
    |
    v
POST /files/{id}/lock
    |
    +-- lock acquired ----> editor may open in edit mode
    |
    +-- lock denied ------> show read-only / unavailable state
```

After lock acquisition:

```text
GET file metadata
GET latest annotation
GET/fetch image + prediction asset
CHECK IndexedDB local draft
RESOLVE recovery state
OPEN editor
```

---

### 5.3 Edit interaction

```text
Mouse / pointer / keyboard
        |
        v
Update RAM state
        |
        +--> render immediately
        |
        +--> schedule IndexedDB persistence
        |
        +--> schedule backend draft sync
```

No edit may wait for a server round trip.

---

### 5.4 Done

```text
User clicks Done
    |
    v
Flush local state
    |
    v
Submit latest draft to backend
    |
    v
Create immutable annotation version
    |
    v
Mark annotation status = DONE
    |
    v
Release lock
    |
    v
Optional Drive export/sync
```

---

## 6. State separation

The system must keep three independent dimensions.

### Annotation state

```text
UNSTARTED
DRAFT
DONE
```

### Lock state

```text
AVAILABLE
LOCKED(user_id)
```

### Assignment state

```text
UNASSIGNED
ASSIGNED(user_id)
```

Never combine them into one field.

Example:

```text
annotation_state = DONE
lock_state       = AVAILABLE
assigned_to      = user_02
```

Meaning:

- the file has a completed annotation;
- nobody is currently editing it;
- user_02 is the intended owner.

---

## 7. Re-edit semantics

`DONE` is not read-only.

When a completed file is reopened:

1. acquire a new lock;
2. load the latest completed annotation;
3. start a new editing session;
4. preserve the previous completed version;
5. save later completion as a new version.

Never overwrite the only copy of a completed annotation.

---

## 8. Real-time requirements

### Must be immediate

- brush stroke rendering;
- erase rendering;
- point creation;
- point move;
- point delete;
- undo/redo;
- opacity changes;
- zoom/pan.

### May be asynchronous

- IndexedDB write;
- server autosave;
- lock heartbeat;
- Drive sync;
- analytics.

---

## 9. Connection behavior

### Online

```text
RAM -> IndexedDB -> Backend
```

### Temporary offline

```text
RAM -> IndexedDB
```

Current-file editing continues.

Do not allow acquiring a new shared file lock while fully offline.

### Reconnect

```text
IndexedDB draft
  |
  v
revision check
  |
  +-- valid -> sync
  |
  +-- stale/conflict -> preserve local draft and show conflict UI
```

---

## 10. Non-functional requirements

### UX

- no full-page spinner during annotation;
- no network wait after every click;
- no popup on every autosave;
- no visible Drive IDs for annotators;
- no technical terminology required for basic workflow.

### Reliability

- browser refresh must recover local work;
- stale sessions must not lock a file forever;
- backend must reject stale revision writes;
- local unsynced work must never be silently dropped.

### Performance

- load only selected image/prediction;
- use thumbnail/index list for browsing;
- prefetch only a small number of nearby files;
- do not re-upload a full mask after every pointer movement.

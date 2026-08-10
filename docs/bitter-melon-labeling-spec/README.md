# Bitter Melon Annotation Tool — Implementation Spec

This folder is the implementation contract for the annotation web app.

The application is a **multi-user, human-in-the-loop annotation system** for two tasks:

1. **Bitter melon ridge segmentation**
   - A pre-generated unsupervised mask already exists on Google Drive.
   - Annotators only verify or correct the mask.
2. **Ridge breakpoint annotation**
   - Annotators place, move, or remove breakpoint points.

The unsupervised pipeline is **outside the web application**. The web app starts from a Drive folder that already contains source images and prediction masks.

## Core architecture decision

Use a web application with four distinct state/storage layers:

```text
Google Drive
    |
    | source images + prediction masks
    v
Backend API
    |
    | shared state, locks, revisions, annotations
    v
Browser
    |
    +-- RAM        -> live editor state
    +-- IndexedDB  -> local draft/offline recovery
    +-- localStorage -> small preferences only
```

### Source of truth

| Data | Source of truth |
|---|---|
| Original images | Google Drive |
| Prediction masks | Google Drive |
| File index / metadata | Backend database |
| Current shared annotation | Backend database/storage |
| Lock ownership | Backend database |
| Annotation revision/version | Backend |
| Current editor state | Browser RAM |
| Unsynced local draft | IndexedDB |
| UI preferences | localStorage |

Do **not** use Google Drive as the real-time annotation database.

Do **not** write annotation state to Drive after every brush stroke or point edit.

Do **not** use `localStorage` for full masks or large annotation drafts.

## Files in this spec

1. `01_SYSTEM_ARCHITECTURE.md`
   - system components
   - responsibilities
   - source-of-truth rules
   - request/data flow

2. `02_DATA_MODEL.md`
   - backend entities
   - statuses
   - relational schema
   - annotation payloads

3. `03_API_LOCKING_AND_CONCURRENCY.md`
   - REST API
   - file locking
   - heartbeat
   - revision conflict handling
   - done/re-edit behavior

4. `04_CLIENT_STATE_AUTOSAVE_OFFLINE.md`
   - RAM state
   - IndexedDB schema
   - autosave strategy
   - reload recovery
   - offline behavior
   - conflict recovery

5. `05_GOOGLE_DRIVE_SYNC_AND_STORAGE.md`
   - expected Drive structure
   - manifest contract
   - Drive indexing
   - lazy loading
   - final export

6. `06_ANNOTATION_UI_AND_WORKFLOWS.md`
   - non-technical user flows
   - segmentation editor
   - breakpoint editor
   - file list
   - UX requirements

7. `07_IMPLEMENTATION_PLAN.md`
   - recommended stack
   - implementation phases
   - acceptance criteria
   - explicit non-goals

## Required implementation principles

1. A user action must render immediately from local RAM state.
2. Annotation editing must never wait for a network request.
3. Autosave must be invisible during normal use.
4. Reloading the page must preserve the latest local work.
5. Losing network must not destroy the current annotation.
6. A file may have only one active editor at a time.
7. `DONE` does not mean immutable/read-only.
8. Editing a completed file creates a new annotation revision/version.
9. A lock must expire automatically if a browser crashes or disconnects.
10. Prediction and ground truth must remain separate.
11. No local unsynced work may be silently discarded.
12. All destructive actions must be explicit and reversible where possible.

## Suggested repository structure

```text
apps/
  web/
  api/

packages/
  shared-types/

services/
  drive-sync/

docs/
  <copy these spec files here>
```

The exact folder structure is flexible, but the behavioral contract in this specification is not.

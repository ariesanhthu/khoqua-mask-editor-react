# 04 — Client State, Autosave, and Offline Recovery

## 1. Primary UX rule

Editing must remain smooth regardless of save latency.

Never use this interaction pattern:

```text
user action
-> network request
-> wait
-> render result
```

Use:

```text
user action
-> update RAM
-> render immediately
-> schedule background persistence
```

---

## 2. State layers

### RAM

Contains current live state:

```ts
type EditorState = {
  fileId: string;
  baseServerRevision: number;

  segmentation: {
    maskBitmap: unknown;
    humanAction: "UNTOUCHED" | "ACCEPTED" | "MODIFIED";
  };

  breakpoints: {
    state: "NOT_ANNOTATED" | "ANNOTATED" | "CONFIRMED_NONE";
    points: Array<{id:string; x:number; y:number;}>;
  };

  undoStack: unknown[];
  redoStack: unknown[];

  dirty: boolean;
};
```

---

## 3. localStorage usage

Allowed:

- last project ID;
- last opened file ID;
- user display preferences;
- mask opacity;
- editor tool preference;
- optional panel layout.

Do not store:

- binary mask;
- full canvas snapshots;
- large operation arrays;
- cached images;
- cached prediction masks.

Reason:

`localStorage` is synchronous and can block the main thread.

---

## 4. IndexedDB usage

Suggested stores:

```text
drafts
cachedAssets
```

### Draft record

```ts
type LocalDraft = {
  key: string; // projectId:fileId:userId

  projectId: string;
  fileId: string;
  userId: string;

  baseServerRevision: number;

  maskSnapshotBlob?: Blob;
  maskOperations?: MaskOperation[];

  breakpoints: {
    state: "NOT_ANNOTATED" | "ANNOTATED" | "CONFIRMED_NONE";
    points: Array<{id:string; x:number; y:number;}>;
  };

  updatedAt: number;

  syncState:
    | "SYNCED"
    | "DIRTY"
    | "SYNCING"
    | "CONFLICT";
};
```

---

## 5. Segmentation operation model

Do not export/upload the entire mask on every pointer movement.

Recommended editor behavior:

```text
base materialized mask
+
operation log
```

Example:

```ts
type MaskOperation =
  | {
      type: "BRUSH_ADD";
      brushSize: number;
      points: Array<{x:number; y:number;}>;
    }
  | {
      type: "BRUSH_ERASE";
      brushSize: number;
      points: Array<{x:number; y:number;}>;
    }
  | {
      type: "RESET_TO_PREDICTION";
    };
```

A pointer stroke is one operation:

```text
pointerdown
pointermove...
pointermove...
pointerup
=> one operation
```

Do not write on every `pointermove`.

---

## 6. Snapshot compaction

To avoid an unbounded operation log:

```text
mask snapshot
+
operations 1..N
```

After a threshold, for example:

```text
N >= 50
or
operation bytes >= configured threshold
```

materialize:

```text
new mask snapshot
clear compacted operations
```

This compaction must run asynchronously or off the interaction path.

---

## 7. Local autosave scheduler

Recommended behavior:

### On user operation completion

1. update RAM;
2. mark editor dirty;
3. enqueue IndexedDB save.

Use short debounce, for example:

```text
250–500 ms after activity
```

Exact value is configurable.

The user must not see a spinner for local persistence.

---

## 8. Server autosave scheduler

Use two triggers:

### Idle debounce

If user stops interacting:

```text
2–5 seconds idle
-> sync latest draft to backend
```

### Maximum interval

If user continuously works:

```text
every 10–20 seconds
-> sync a batched latest state
```

This prevents a long unsynced period without creating a request per action.

---

## 9. Save state UI

Header may show only one compact indicator.

States:

```text
Saved
Saving…
Offline — saved locally
Syncing…
Conflict
```

Do not show modal dialogs for normal autosave.

Do not block canvas.

---

## 10. Page refresh recovery

On editor bootstrap:

```text
1. fetch server annotation and server revision
2. read IndexedDB draft for project:file:user
3. compare local and server state
```

Cases:

### Case A — no local draft

Use server state.

### Case B — local draft is based on current server revision and is newer locally

Restore local draft automatically.

Show non-blocking toast:

```text
Unsaved work recovered
```

### Case C — local draft is already synced/equivalent

Use either consistent copy and continue.

### Case D — local draft base revision is stale

Do not overwrite server.

Mark conflict.

Preserve both states.

---

## 11. Offline behavior

When network disappears:

- do not close editor;
- do not clear lock UI immediately;
- continue current-file editing;
- keep local persistence active;
- pause backend autosave;
- keep heartbeat attempts;
- show `Offline — saved locally`.

Important:

The server-side lock may expire during a long outage.

Therefore offline edits are not guaranteed to retain exclusive shared ownership.

They are only guaranteed to remain locally recoverable.

---

## 12. Reconnect behavior

On reconnect:

```text
1. verify current lock/session
2. fetch latest server revision
3. compare with local draft base revision
```

### Lock still valid + revision compatible

Sync local draft.

### Lock lost but server has not changed

Attempt to reacquire lock.

If reacquired:

- sync local draft.

### Lock lost and server revision changed

Conflict.

Do not autosave over server.

---

## 13. Conflict UX

Message:

```text
This file was updated while you were offline.

Your work is still saved on this device.
```

Actions:

```text
View latest version
View my local draft
Save my draft as a new version
```

For V1, automatic segmentation merge is not required.

Important:

Never delete local conflict data automatically after opening the conflict screen.

Delete only after:

- user explicitly discards it; or
- user successfully resolves/saves it.

---

## 14. Undo/redo

Undo/redo is client-local interaction history.

Requirements:

- instant;
- must not call backend;
- each complete user action is one undo step;
- point drag should be one undo step, not hundreds;
- brush stroke should be one undo step.

It is acceptable for full historical undo to reset after page reload in V1, as long as the latest annotation state is recovered.

If preserving undo across reload is easy using operation logs, it may be implemented.

---

## 15. Asset caching

Recommended IndexedDB cache:

```text
current image
current prediction
next 2–5 likely files
```

Use bounded cache size.

Do not cache entire dataset by default.

---

## 16. New file acquisition while offline

Do not allow a user to start editing a different shared file while the backend is unreachable.

Reason:

The client cannot guarantee exclusive lock ownership.

UI:

```text
You are offline. Reconnect before opening another file.
```

Current file remains editable.

---

## 17. Closing tab

Before unload/pagehide:

- persist latest local draft to IndexedDB;
- optionally send best-effort lock release;
- optionally send best-effort draft sync if safe.

Correctness must not depend on these calls succeeding.

---

## 18. Performance constraints

Avoid:

- serializing a large canvas on every pointer move;
- synchronous localStorage writes during drawing;
- uploading PNG masks on every stroke;
- React state updates for every raw pixel if canvas can handle drawing independently.

Prefer:

- canvas/WebGL-backed drawing;
- refs/internal editor state for high-frequency pointer events;
- batched state commits;
- background persistence.

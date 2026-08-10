# 03 — API, Locking, and Concurrency

## 1. API principles

- REST is sufficient for core behavior.
- Optional SSE/WebSocket may be used only for live file-list updates.
- Every mutation must be authenticated.
- Every annotation mutation must validate the active lock.
- Every annotation mutation must validate the expected revision.
- Lock acquisition must be atomic.

---

## 2. File list

### `GET /api/projects/{projectId}/files`

Query examples:

```text
?annotationState=DONE
?lockState=AVAILABLE
?assignedTo=me
?search=BM_0012
?page=1&pageSize=50
```

Response:

```json
{
  "items": [],
  "page": 1,
  "pageSize": 50,
  "total": 0
}
```

---

## 3. Acquire lock

### `POST /api/files/{fileId}/lock`

Request:

```json
{}
```

The server must perform atomic logic:

```text
BEGIN TRANSACTION

read current lock

if no lock:
    create lock
    success

if lock expired:
    replace lock
    success

if lock belongs to same active session/user:
    optionally renew
    success

otherwise:
    reject with 423 Locked

COMMIT
```

Success:

```json
{
  "sessionId": "sess_...",
  "lockToken": "opaque-secret-token",
  "expiresAt": "2026-08-10T06:30:00Z",
  "baseRevision": 14
}
```

Locked response:

```http
423 Locked
```

```json
{
  "code": "FILE_LOCKED",
  "message": "File is currently being edited.",
  "lockedBy": {
    "userId": "user_02",
    "displayName": "Minh"
  },
  "expiresAt": "..."
}
```

---

## 4. Lock token

The lock token is an opaque secret returned only to the lock owner.

Client sends it with mutation requests:

```http
X-Annotation-Lock-Token: <token>
```

Backend stores only a secure hash if practical.

All of these must validate the token:

- heartbeat;
- save draft;
- done;
- explicit unlock.

---

## 5. Heartbeat

### `POST /api/files/{fileId}/lock/heartbeat`

Headers:

```text
X-Annotation-Lock-Token
```

Recommended client interval:

```text
20–30 seconds
```

Recommended TTL:

```text
2–5 minutes
```

Success:

```json
{
  "expiresAt": "..."
}
```

Heartbeat must be small and independent from annotation payloads.

---

## 6. Explicit unlock

### `DELETE /api/files/{fileId}/lock`

Used when:

- user intentionally returns to file list;
- user switches to another file;
- user exits edit mode.

Server:

1. validates token;
2. saves nothing implicitly unless requested by caller;
3. removes active lock;
4. closes annotation session.

Do not rely on this endpoint for crash safety.

TTL is mandatory.

---

## 7. Browser close / pagehide

Client may send a best-effort release request using `sendBeacon` or `fetch(..., {keepalive:true})`.

However:

- browser may crash;
- OS may kill process;
- network may be disconnected.

Therefore lock expiration remains the authority.

---

## 8. Get editor data

### `GET /api/files/{fileId}/editor`

Must require either:

- active edit lock owned by current user; or
- explicit read-only mode.

Edit response:

```json
{
  "file": {},
  "assets": {},
  "annotation": {},
  "lock": {
    "sessionId": "...",
    "expiresAt": "..."
  }
}
```

Do not return another user's lock token.

---

## 9. Save draft

### `PATCH /api/files/{fileId}/annotation`

Headers:

```text
X-Annotation-Lock-Token
```

Request:

```json
{
  "baseRevision": 14,
  "segmentation": {
    "humanAction": "MODIFIED",
    "maskUploadRef": "..."
  },
  "breakpoints": {
    "state": "ANNOTATED",
    "points": [
      {"id":"p1","x":100.2,"y":212.8}
    ]
  }
}
```

Server transaction:

```text
validate lock
validate lock not expired
validate current revision == baseRevision

persist materialized annotation
increment revision
set annotation state = DRAFT unless currently finalizing
update latest revision
update session activity
```

Response:

```json
{
  "revision": 15,
  "savedAt": "..."
}
```

---

## 10. Revision conflict

If:

```text
request.baseRevision != server.latestRevision
```

return:

```http
409 Conflict
```

```json
{
  "code": "REVISION_CONFLICT",
  "serverRevision": 20
}
```

Client behavior is defined in `04_CLIENT_STATE_AUTOSAVE_OFFLINE.md`.

Never merge segmentation masks automatically unless a dedicated merge strategy is explicitly implemented.

---

## 11. Lost lock

If the lock token is invalid or the lock has expired:

```http
409 Conflict
```

or:

```http
423 Locked
```

Recommended error:

```json
{
  "code": "LOCK_LOST",
  "message": "Your edit lock is no longer active."
}
```

Client must:

- stop shared autosave;
- preserve local draft;
- keep editor state in RAM/IndexedDB;
- offer conflict/recovery UI;
- never discard local work.

---

## 12. Done

### `POST /api/files/{fileId}/done`

Headers:

```text
X-Annotation-Lock-Token
```

Request:

```json
{
  "baseRevision": 15,
  "annotation": {
    "segmentation": {},
    "breakpoints": {}
  }
}
```

Server transaction:

```text
1. validate active lock
2. validate revision
3. persist final current annotation
4. increment revision
5. create immutable AnnotationVersion
6. increment latestVersionNumber
7. set DatasetFile.annotationState = DONE
8. remove lock
9. close session with reason DONE
10. commit
```

Response:

```json
{
  "revision": 16,
  "versionNumber": 3,
  "annotationState": "DONE",
  "lockState": "AVAILABLE"
}
```

The Drive export may run after this transaction.

Do not keep the file locked while waiting for a slow Drive export.

---

## 13. Re-edit completed file

Same lock endpoint is used.

Flow:

```text
DONE + AVAILABLE
    |
    v
POST /lock
    |
    v
new session
    |
    v
load latest completed annotation as base
    |
    v
edit
    |
    v
Done -> create next version
```

Do not reset to prediction automatically when reopening a completed file.

---

## 14. Switch file

Recommended client sequence:

```text
1. flush IndexedDB
2. attempt final draft sync
3. release current lock
4. acquire new file lock
5. open new file
```

If server draft sync fails because of network loss:

- keep local draft;
- release may also fail;
- do not acquire a new file while offline;
- user may continue current file locally.

---

## 15. Concurrent lock race

Case:

```text
User A clicks file
User B clicks same file nearly simultaneously
```

Expected:

```text
one lock insert/replace succeeds
the other request gets FILE_LOCKED
```

This must be guaranteed by:

- transaction;
- unique key on `file_locks.dataset_file_id`;
- database-level atomicity.

Do not implement:

```text
GET lock
if empty
POST lock
```

as two independent non-transactional operations.

---

## 16. Suggested lock expiry cleanup

A periodic backend cleanup job may remove expired locks.

However lock acquisition must also treat expired locks as replaceable even if cleanup has not yet run.

Do not make correctness depend on the cleanup scheduler.

---

## 17. Optional live file status

V1 may poll:

```text
GET /files every 5–10 seconds
```

Later, SSE/WebSocket can push:

```text
FILE_LOCKED
FILE_UNLOCKED
FILE_DONE
```

Polling is acceptable for a small team.

---

## 18. Error codes

Use stable machine-readable codes.

Recommended:

```text
FILE_LOCKED
LOCK_LOST
REVISION_CONFLICT
INVALID_ANNOTATION
ASSET_NOT_FOUND
DRIVE_SYNC_ERROR
FILE_NOT_FOUND
UNAUTHORIZED
FORBIDDEN
```

UI should map them to non-technical messages.

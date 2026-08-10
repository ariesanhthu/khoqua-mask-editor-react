# 05 — Google Drive Sync and Storage

## 1. Role of Google Drive

Google Drive is the external dataset store.

The annotation tool assumes the unsupervised pipeline has already produced:

- source image;
- corresponding prediction mask.

The web application does not run the unsupervised algorithm.

---

## 2. Recommended Drive layout

```text
BitterMelon/
|
+-- manifest.json
|
+-- images/
|   +-- BM_000001.jpg
|   +-- BM_000002.jpg
|   +-- ...
|
+-- predictions/
|   +-- BM_000001.png
|   +-- BM_000002.png
|   +-- ...
|
+-- exports/                # optional
    +-- ...
```

The file stem should match when possible:

```text
images/BM_000123.jpg
predictions/BM_000123.png
```

---

## 3. Manifest contract

Recommended `manifest.json`:

```json
{
  "dataset_version": "2026-08-10",
  "algorithm_version": "unsupervised-v1",
  "items": [
    {
      "id": "BM_000001",
      "image": "images/BM_000001.jpg",
      "prediction": "predictions/BM_000001.png"
    }
  ]
}
```

The backend may resolve these paths to Drive file IDs during sync.

The manifest should be treated as dataset input metadata, not annotation state.

---

## 4. Drive integration responsibility

Only the backend should access Drive APIs.

Recommended flow:

```text
Admin configures project Drive folder
        |
        v
Backend authenticates to Drive
        |
        v
Read manifest
        |
        v
Resolve image/prediction files
        |
        v
Upsert dataset file index
```

The browser should request assets through backend-generated URLs/proxy endpoints.

Do not expose Drive credentials to the browser.

---

## 5. Project initialization

Admin setup:

```text
Project name
Drive folder ID / folder URL
```

Backend stores normalized `driveFolderId`.

Then:

```text
POST /api/projects/{projectId}/sync-drive
```

Response may contain:

```json
{
  "added": 1200,
  "updated": 0,
  "missing": 0,
  "errors": []
}
```

---

## 6. Sync behavior

Sync must be idempotent.

Running it multiple times must not duplicate dataset files.

Use:

```text
(dataset_id, external_key)
```

as a uniqueness boundary.

During sync:

- new manifest entries -> insert;
- existing matching entries -> update Drive IDs if needed;
- missing files -> flag error;
- do not silently delete annotations when a source asset disappears.

---

## 7. Missing asset handling

If an image or prediction is missing:

```text
asset_state = ERROR
```

File should not be editable normally.

UI should show:

```text
Source image or prediction is missing.
```

Admin may resync after correcting Drive contents.

---

## 8. Lazy asset loading

Do not load all source assets when project opens.

File list request returns metadata and optionally thumbnails.

When a user opens one file:

```text
GET /api/files/{id}/assets/image
GET /api/files/{id}/assets/prediction
```

or signed/proxied URLs.

---

## 9. Prefetch

After current editor is stable, browser may prefetch a small number of next candidate files.

Example:

```text
current file
+ next 2 files
```

Prefetch must be best-effort and cancelable.

Do not download thousands of files.

---

## 10. Backend asset cache

Optional but recommended if Drive latency is noticeable.

Backend may keep a bounded local cache:

```text
.cache/
  images/
  predictions/
```

Cache key should include Drive file ID/version metadata if available.

The cache is disposable.

Drive remains source of truth for source assets.

---

## 11. Final annotation storage

Shared annotation state should first be persisted in backend-controlled storage.

Recommended:

```text
annotation-storage/
  dataset-id/
    file-id/
      revisions/
      versions/
```

Do not make a successful `Done` operation depend on synchronous Drive upload.

---

## 12. Drive export

After `Done`, backend may enqueue or trigger an export.

Recommended output:

```text
exports/
  dataset-version/
    masks/
      BM_000001.png
    breakpoints.jsonl
    manifest.jsonl
```

### Binary mask convention

```text
0   = background
255 = ridge
```

### Breakpoint JSONL example

```json
{"image_id":"BM_000001","state":"ANNOTATED","points":[{"x":213.4,"y":418.7}]}
```

### No breakpoint example

```json
{"image_id":"BM_000002","state":"CONFIRMED_NONE","points":[]}
```

---

## 13. Export versioning

Do not overwrite an exported dataset without traceability.

Suggested folder:

```text
exports/
  export_2026-08-10_1320/
```

or use an explicit dataset/export version.

---

## 14. Credentials

Preferred deployment options:

- service account with access to the shared Drive folder; or
- backend OAuth flow for a controlled internal account.

Do not embed secrets in frontend source.

Environment variables should contain only backend-side secrets.

---

## 15. Drive failure behavior

If Drive is temporarily unavailable while annotating a file whose assets are already loaded:

- editor remains usable;
- annotation autosave to backend remains usable;
- Drive export can retry later.

If Drive is unavailable before opening an uncached file:

- file cannot load;
- show a recoverable error;
- do not mark annotation as failed or lost.

---

## 16. Drive sync is not annotation sync

Keep these concepts separate:

```text
Drive Sync
= update source dataset index/assets

Annotation Sync
= save user edits to backend
```

They must not share the same status or API.

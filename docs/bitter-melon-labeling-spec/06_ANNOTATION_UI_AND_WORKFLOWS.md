# 06 — Annotation UI and Workflows

## 1. Target user

The main annotator is non-technical.

The UI must not require knowledge of:

- segmentation algorithms;
- Google Drive IDs;
- JSON;
- coordinate systems;
- databases;
- lock tokens;
- revisions.

The user should understand only:

```text
Choose file
-> Check/fix mask
-> Mark breakpoints
-> Done
```

---

## 2. Main screens

Only these are required for V1:

```text
1. Login
2. Project / file list
3. Annotation workspace
4. Optional admin/settings screen
```

Review/version history may be added in a later phase.

---

## 3. File list

Required filters:

```text
All
Available
Doing
Done
Draft
My files
```

Each file card/row should show:

- thumbnail;
- external ID;
- annotation state;
- lock state;
- lock owner if doing;
- assignment if relevant.

Example:

```text
BM_00041
Done
Available
```

```text
BM_00042
Draft
Locked by Minh
```

---

## 4. File availability rules

### Available

User may click `Edit`.

### Locked by another user

User may not edit.

Optional:

```text
View only
```

### Locked by current user/session

Resume editor.

---

## 5. Open-file flow

User clicks `Edit`.

UI state:

```text
Acquiring file...
```

This may show a short loader because the lock must be confirmed before edit mode.

After acquisition:

- image loads;
- prediction loads;
- server annotation loads;
- local IndexedDB draft is checked;
- editor appears.

Once editor appears, normal editing must be non-blocking.

---

## 6. Annotation workspace layout

Recommended:

```text
+------------------------------------------------------+
| BM_00342        Editing as Thư          Saved        |
+------------+-----------------------------+-----------+
|            |                             |           |
| Task       |                             | Controls  |
|            |           IMAGE             |           |
| Ridge      |                             | Mask      |
| Breakpoint |                             | Opacity   |
|            |                             | Brush     |
|            |                             |           |
+------------+-----------------------------+-----------+
| Previous        Save draft       Done / Next         |
+------------------------------------------------------+
```

Image area must dominate the screen.

---

## 7. Common image controls

Required:

- zoom in;
- zoom out;
- mouse-wheel zoom;
- pan;
- fit to screen;
- reset view;
- fullscreen;
- show/hide prediction;
- show/hide current annotation;
- mask opacity.

All controls must be accessible by mouse.

Keyboard shortcuts are optional accelerators.

---

# PART A — Ridge Segmentation

## 8. Initial state

Load:

```text
original image
prediction mask
latest annotation if it exists
```

If file is `UNSTARTED`, the prediction is the initial suggested mask.

If file is `DRAFT` or `DONE`, load the latest human annotation as current editable state.

Do not overwrite current human annotation with prediction.

---

## 9. High-level segmentation actions

Required buttons:

```text
Accept suggested mask
Fix mask
Reset to suggestion
```

If accepted without edits:

```text
humanAction = ACCEPTED
```

If modified:

```text
humanAction = MODIFIED
```

---

## 10. Editing tools

P0 required:

```text
Add brush
Erase brush
Brush size
Undo
Redo
Reset to prediction
```

Optional P1:

```text
Lasso
Polygon add/remove
Fill region
Expand mask
Shrink mask
Remove small isolated regions
Fill small holes
```

UI must use non-technical names.

Avoid labels like:

```text
morphological dilation
erosion
opening
closing
```

---

## 11. Mask display

Required:

- visible overlay;
- adjustable opacity;
- hide/show;
- optionally outline-only.

Prediction and current human mask should be visually distinguishable.

A quick comparison shortcut may be added:

```text
hold P -> prediction
release -> current annotation
```

---

# PART B — Breakpoint Annotation

## 12. Breakpoint mode

Required actions:

```text
Add point
Move point
Delete point
Undo
Redo
Confirm no breakpoint
```

Point data:

```ts
{id, x, y}
```

Coordinates are stored in original-image coordinate space.

---

## 13. Point interaction

### Add

Click image.

### Move

Drag point.

### Delete

Select point + Delete key or visible delete action.

A point drag is one undo operation.

---

## 14. No breakpoint

Must be explicit.

Required control:

```text
No breakpoint in this image
```

Data:

```text
state = CONFIRMED_NONE
points = []
```

Do not infer this state from an empty point list.

---

## 15. Optional magnifier

Recommended if pixel-level point accuracy matters.

When pointer hovers near the image:

```text
magnified local patch
crosshair
```

May be P1.

---

## 16. Validation

Before `Done`, validate:

### Segmentation

- mask exists;
- mask dimensions match image;
- mask is not corrupt.

### Breakpoints

One of:

```text
ANNOTATED
CONFIRMED_NONE
```

`NOT_ANNOTATED` cannot be completed.

Optional domain validation:

- warn if a breakpoint is far from the segmentation mask.

Do not hard-block this unless the domain rule is certain.

---

## 17. Save behavior in UI

Normal editing:

```text
Saved
Saving...
Offline — saved locally
```

No modal.

No full-screen loader.

No disabled canvas.

---

## 18. Done behavior

User clicks `Done`.

Only here may the UI briefly show a committing state:

```text
Finishing...
```

On success:

```text
Done
-> lock released
-> file becomes available for editing again
-> navigate to file list or next available file
```

---

## 19. Switching files before Done

If current file contains changes:

- autosave local;
- attempt server draft save;
- release lock;
- open next file.

Optional lightweight confirmation:

```text
Your current work is saved as a draft.
Continue?
```

Avoid scary "unsaved changes will be lost" prompts when the data is actually safely persisted.

---

## 20. Offline indicator

When offline:

```text
Offline — changes saved on this device
```

The current editor remains active.

Do not allow starting another shared file while offline.

---

## 21. Reload recovery

If local draft is newer than server and not conflicting:

- restore automatically;
- show small toast:

```text
Unsaved work recovered
```

Do not require a modal confirmation in normal recovery.

---

## 22. Conflict screen

If the file changed elsewhere while the user was offline:

```text
This file was updated while you were offline.
Your work is still saved on this device.
```

Actions:

```text
View latest
View my draft
Save my draft as a new version
```

Never silently overwrite one with the other.

---

## 23. Non-technical copy

Prefer:

```text
Suggested mask
Current mask
Add area
Erase area
No breakpoint
Saved
Being edited by Minh
```

Avoid:

```text
prediction tensor
binary segmentation operation
revision mismatch
lease conflict
lock TTL
IndexedDB recovery
```

Technical details belong in logs/admin tools, not the annotator interface.

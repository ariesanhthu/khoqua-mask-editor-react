Bạn đang làm việc với repo:

```text
https://github.com/ariesanhthu/khoqua-mask-editor-react
```

Web app chính nằm trong:

```text
annotation-tool/
```

Tôi đã có sẵn một **folder output V7** từ pipeline phân đoạn khổ qua. Không chạy inference/model lại. Nhiệm vụ của bạn là:

1. đọc cấu trúc output V7 hiện có;
2. convert các output cần thiết thành một dataset production gọn;
3. sửa Khổ qua Mask Editor để load trực tiếp **polygon prelabel có label + vertex**, thay vì chỉ load PNG rồi vectorize lại;
4. giữ tương thích với workflow hiện tại của editor;
5. không đưa các intermediate/debug artifact không cần thiết vào source dataset production.

---

# 1. Quan trọng: hiểu đúng editor hiện tại

Repo hiện đã có polygon editor.

Các type hiện tại:

```ts
export interface PolygonNode {
  id: string;
  x: number;
  y: number;
}

export interface AnnotationPolygon {
  id: string;
  label: string;
  nodes: PolygonNode[];
}

export type MaskOperation =
  | {
      type: 'POLYGON_SET';
      polygons: AnnotationPolygon[];
    }
  | ...
```

Editor hiện đã hỗ trợ:

* vẽ polygon;
* chọn polygon;
* drag polygon;
* drag từng node;
* double click cạnh để thêm node;
* delete node;
* cut polygon;
* đổi label polygon;
* undo/redo;
* rasterize polygon thành mask khi save/export.

Không implement lại polygon editor.

Hiện tại dataset importer chỉ hỗ trợ:

```ts
interface ManifestItem {
  id: string;
  image: string;
  prediction: string;
  width?: number;
  height?: number;
}
```

và editor hiện nhận:

```text
image
+
prediction mask
```

Nếu người dùng bắt đầu sửa polygon, frontend mới vectorize prediction PNG thành polygon.

**Đây là phần cần thay đổi.**

Output V7 đã có polygon chính xác từ model, vì vậy:

> Không vectorize lại PNG nếu V7 đã cung cấp polygon.

Phải load polygon V7 trực tiếp thành `POLYGON_SET`.

---

# 2. Không thay đổi pipeline V7

Folder V7 đã được sinh xong.

Không:

* chạy SAM3 lại;
* chạy semantic grouping lại;
* chạy corridor detection lại;
* thay đổi segmentation algorithm;
* regenerate primitive.

Chỉ đọc output hiện có và convert.

Output V7 có các thành phần như:

```text
SAM3_BitterMelon_V7/
├── images/
│   └── <image_id>/
│       ├── prelabel_v7.json
│       ├── main_flesh_instance_labels_uint16.png
│       ├── wart_flesh_instance_labels_uint16.png
│       ├── flattened_repaired.png
│       ├── glare_mask.png
│       ├── dark_edge.png
│       ├── groove_score.png
│       ├── flesh_score.png
│       ├── sam_candidate_audit.csv
│       ├── corridors/
│       │   └── corridor_XX/
│       │       ├── 01_corridor.png
│       │       ├── 02_dark_barrier.png
│       │       ├── 03_flesh_seed.png
│       │       ├── 04_primitive_reconstruction.png
│       │       ├── primitive_XX_final.png
│       │       ├── primitive_XX_meta.json
│       │       └── semantic_groups.csv
│       └── ...
│
├── prelabels_v7_coco.json
├── batch_summary.csv
└── ...
```

`corridors/`, `primitive_*`, score maps và audit files là intermediate/debug.

Không cần upload chúng vào production dataset.

Ví dụ `primitive_08_meta.json` chỉ chứa các thông tin audit như bbox, centroid, orientation, SAM metrics, positive/negative SAM prompt geometry. Nó không phải geometry cuối để editor vẽ.

---

# 3. Source of truth cho polygon phải là `prelabel_v7.json`

Không lấy polygon bằng cách contour lại:

```text
prediction.png
```

Không contour lại:

```text
main_flesh_instance_labels_uint16.png
```

nếu `prelabel_v7.json` đã có polygon.

Phải preserve polygon từ V7.

V7 có hai semantic chính:

```text
main_flesh_band
wart_flesh
```

Không merge hai class này trong vector annotation.

---

# 4. Mapping V7 semantic

## `main_flesh_band`

Một main flesh band có thể gồm nhiều đoạn rời nhau nhưng thuộc cùng một vân.

Ví dụ logic V7:

```text
main_flesh_bands[]
    main_group_id
    corridor_id

    fragments[]
        fragment_index
        primitive_id
        bbox_xywh
        polygons
```

Mỗi fragment polygon phải trở thành một polygon riêng trong editor.

Nhưng các polygon thuộc cùng vân phải giữ chung:

```text
mainGroupId
```

Ví dụ:

```text
main_group_id = 4

fragment 1 → polygon A
fragment 2 → polygon B
fragment 3 → polygon C
```

Không merge A+B+C thành một polygon giả.

Không nối thẳng các vùng disconnected.

## `wart_flesh`

Mapping:

```text
wart_flesh_instances[]
    wart_id
    corridor_id
    primitive_id
    bbox_xywh
    polygons
```

Mỗi polygon được đưa vào editor với:

```text
label = "wart_flesh"
```

---

# 5. Không duplicate polygon của main group

Nếu cấu trúc V7 có cả:

```text
main_flesh_bands[].polygons
```

và:

```text
main_flesh_bands[].fragments[].polygons
```

thì production converter phải dùng:

```text
fragments[].polygons
```

làm nguồn polygon edit.

Không thêm đồng thời `group.polygons` và `fragment.polygons`, vì sẽ tạo geometry trùng.

Group-level polygons chỉ có thể dùng cho validation/audit nếu cần.

---

# 6. Convert coordinate format

V7 polygon có thể đang ở COCO flattened format:

```json
[
  855, 91,
  872, 84,
  910, 86,
  944, 97
]
```

Convert thành native structure của frontend:

```json
[
  {
    "id": "node_1",
    "x": 855,
    "y": 91
  },
  {
    "id": "node_2",
    "x": 872,
    "y": 84
  },
  {
    "id": "node_3",
    "x": 910,
    "y": 86
  },
  {
    "id": "node_4",
    "x": 944,
    "y": 97
  }
]
```

Mọi tọa độ phải dùng:

```text
coordinateSpace = image_pixels
```

Gốc:

```text
(0, 0) = top-left của ảnh gốc
```

Không lưu coordinate sau zoom/pan/canvas scaling.

---

# 7. Production dataset mới

Tạo converter riêng, ví dụ:

```text
scripts/convert-v7-prelabels.ts
```

hoặc Python script nếu thuận tiện hơn:

```text
scripts/convert_v7_prelabels.py
```

Converter nhận:

```text
V7_OUTPUT_DIR
```

và tạo:

```text
prelabel-dataset/
├── manifest.json
├── images/
│   ├── <image_id>.jpg
│   └── ...
├── predictions/
│   ├── <image_id>.png
│   └── ...
└── prelabels/
    ├── <image_id>.json
    └── ...
```

Không copy debug files vào folder này.

---

# 8. `manifest.json`

Mở rộng schema hiện tại, không phá backward compatibility.

Format:

```json
{
  "dataset_version": "2026-08-20",
  "algorithm_version": "bitter-melon-v7",
  "items": [
    {
      "id": "BM_000001",
      "image": "images/BM_000001.jpg",
      "prediction": "predictions/BM_000001.png",
      "prelabel": "prelabels/BM_000001.json",
      "width": 1406,
      "height": 614
    }
  ]
}
```

Sửa TypeScript:

```ts
interface ManifestItem {
  id: string;
  image: string;
  prediction: string;
  prelabel?: string;
  width?: number;
  height?: number;
}
```

`prelabel` phải optional để dataset cũ vẫn load được.

---

# 9. `prelabels/<image_id>.json`

Format production:

```json
{
  "schemaVersion": "bitter-melon-prelabel-1.0",
  "imageId": "BM_000001",
  "coordinateSpace": "image_pixels",
  "width": 1406,
  "height": 614,

  "maskOperations": [
    {
      "type": "POLYGON_SET",
      "polygons": [
        {
          "id": "main_4_frag_1_poly_1",
          "label": "main_flesh_band",

          "nodes": [
            {
              "id": "main_4_frag_1_poly_1_node_1",
              "x": 855,
              "y": 91
            },
            {
              "id": "main_4_frag_1_poly_1_node_2",
              "x": 872,
              "y": 84
            },
            {
              "id": "main_4_frag_1_poly_1_node_3",
              "x": 910,
              "y": 86
            }
          ],

          "meta": {
            "semantic": "main_flesh_band",
            "mainGroupId": 4,
            "fragmentIndex": 1,
            "corridorId": 3,
            "primitiveId": 8
          }
        },

        {
          "id": "wart_2_poly_1",
          "label": "wart_flesh",

          "nodes": [
            {
              "id": "wart_2_poly_1_node_1",
              "x": 410,
              "y": 213
            },
            {
              "id": "wart_2_poly_1_node_2",
              "x": 421,
              "y": 207
            },
            {
              "id": "wart_2_poly_1_node_3",
              "x": 433,
              "y": 213
            }
          ],

          "meta": {
            "semantic": "wart_flesh",
            "wartId": 2,
            "corridorId": 5,
            "primitiveId": 11
          }
        }
      ]
    }
  ]
}
```

---

# 10. Extend `AnnotationPolygon` để giữ provenance

Hiện tại:

```ts
export interface AnnotationPolygon {
  id: string;
  label: string;
  nodes: PolygonNode[];
}
```

Mở rộng backward-compatible:

```ts
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
```

Mọi polygon cũ không có `meta` vẫn hoạt động.

Không dùng `meta` để quyết định geometry rendering.

---

# 11. Stable ID

Không dùng `crypto.randomUUID()` khi convert V7 prelabel.

Prelabel ID phải deterministic để cùng một V7 output convert nhiều lần vẫn có cùng ID.

Ví dụ:

```text
main_<mainGroupId>_frag_<fragmentIndex>_poly_<polygonIndex>
```

Node:

```text
<polygonId>_node_<nodeIndex>
```

Wart:

```text
wart_<wartId>_poly_<polygonIndex>
```

Điều này giúp:

* trace lỗi;
* compare dataset version;
* stable autosave;
* tránh object identity thay đổi không cần thiết.

---

# 12. Prediction PNG vẫn phải giữ

Không bỏ `prediction`.

Repo hiện tại vẫn dùng prediction mask trong bootstrap và fallback.

Tạo:

```text
predictions/<image_id>.png
```

từ union:

```python
surface = (
    (main_flesh_instance_labels_uint16 > 0)
    |
    (wart_flesh_instance_labels_uint16 > 0)
)

prediction = surface.astype(np.uint8) * 255
```

Prediction phải:

```text
PNG
grayscale
uint8
0 = non-surface
255 = surface
```

và có width/height đúng bằng ảnh.

Prediction chỉ là:

```text
fallback / raster compatibility / preview
```

Không phải source of truth cho polygon nếu `prelabel` tồn tại.

---

# 13. Load rule trong editor

Flow hiện tại cần đổi thành:

```text
open file
    ↓
existing human annotation?
    │
    ├── YES
    │     ↓
    │  load saved human annotation
    │
    └── NO
          ↓
       prelabel exists?
          │
          ├── YES
          │     ↓
          │  load V7 POLYGON_SET directly
          │
          └── NO
                ↓
             use prediction PNG
```

Priority phải là:

```text
1. saved human annotation
2. V7 polygon prelabel
3. prediction PNG
```

Không để V7 prelabel overwrite annotation người dùng đã save.

---

# 14. Không đánh dấu prelabel là human modification

Khi một file chưa từng được user chỉnh và được initialize từ V7 polygons:

```text
humanAction = UNTOUCHED
```

Không tự set:

```text
MODIFIED
```

chỉ vì polygon được preloaded.

`MODIFIED` chỉ xảy ra khi user thực sự:

* drag node;
* add node;
* delete node;
* move polygon;
* cut;
* create/delete polygon;
* đổi label;
* thực hiện edit khác.

---

# 15. Sửa backend importer

Hiện `drive-service.ts` chỉ resolve:

```text
image
prediction
```

Thêm resolve optional:

```text
prelabel
```

Nếu `item.prelabel` tồn tại:

```ts
const prelabelRef = await resolve(item.prelabel);
```

Persist reference trong database.

Không parse toàn bộ prelabel JSON trong bước sync nếu không cần.

Chỉ lưu reference/storage key.

---

# 16. Database migration

Thêm field optional cho dataset file, ví dụ:

```text
prelabel_file_id
```

hoặc tên trung lập hơn nếu chuẩn bị hỗ trợ nhiều storage:

```text
prelabel_storage_ref
```

Không overload:

```text
prediction_drive_file_id
```

vì prediction raster và polygon prelabel là hai asset khác nhau.

Migration phải backward-compatible.

Dataset cũ:

```text
prelabel = NULL
```

vẫn hoạt động bình thường.

---

# 17. Bootstrap API

`EditorBootstrap` hiện có:

```ts
assets: {
  imageUrl: string;
  predictionMaskUrl: string;
  currentMaskUrl?: string;
}
```

Extend:

```ts
assets: {
  imageUrl: string;
  predictionMaskUrl: string;
  currentMaskUrl?: string;
  prelabelUrl?: string;
}
```

Hoặc backend parse JSON và trả:

```ts
prelabelOperations?: MaskOperation[];
```

**Ưu tiên cách thứ hai** nếu thuận tiện:

```ts
interface EditorBootstrap {
  ...
  prelabelOperations?: MaskOperation[];
}
```

Frontend không cần thêm một fetch riêng.

---

# 18. Initialize editor seed đúng cách

Hiện server seed lấy operations từ saved annotation.

Sửa logic thành tương đương:

```ts
const savedOperations =
  data.annotation?.segmentation.maskOperations;

const initialOperations =
  savedOperations && savedOperations.length
    ? savedOperations
    : data.prelabelOperations ?? [];
```

Nhưng cần phân biệt trường hợp annotation đã tồn tại và cố ý không có polygon.

Rule chính xác:

```text
if annotation exists:
    use annotation.maskOperations exactly

else if prelabel exists:
    use prelabel.maskOperations

else:
    []
```

Không dùng toán tử fallback kiểu:

```ts
savedOperations || prelabel
```

nếu semantics có thể làm annotation rỗng bị thay bằng prediction.

---

# 19. Không vectorize mask nếu prelabel đã được load

Editor hiện có:

```ts
beginPolygonEdit()
```

và nếu chưa có polygon thì gọi:

```ts
vectorizeMask(source)
```

Giữ logic này làm fallback.

Nhưng nếu initial operations đã chứa:

```text
POLYGON_SET
```

thì:

```text
polygonModeRef.current = true
```

và editor phải dùng polygon đó trực tiếp.

Không chạy:

```text
vectorizeMask()
```

lần nữa.

---

# 20. Preserve `meta` trong mọi polygon operation

Kiểm tra toàn bộ các function như:

```text
clonePolygons
move polygon
move node
add node
delete node
split/cut polygon
update label
undo
redo
POLYGON_SET serialization
```

Không được làm mất:

```text
polygon.meta
```

Ví dụ `clonePolygons()` phải preserve metadata.

Nếu cut một model polygon thành hai polygon:

* tạo ID mới cho hai polygon;
* preserve relevant `meta`;
* có thể thêm:

```ts
meta: {
  ...original.meta,
  source: 'human'
}
```

Không silently bỏ `mainGroupId`, `corridorId`, `primitiveId`.

---

# 21. Class/label

V7 dùng tối thiểu:

```text
main_flesh_band
wart_flesh
```

Editor phải render label này.

Không đổi thành:

```text
Vùng hư hại
```

khi load prelabel.

Polygon do user tự tạo mới có thể dùng label active hiện tại.

Nếu UI đã có class picker, add đúng hai class:

```text
main_flesh_band
wart_flesh
```

Tên hiển thị có thể là:

```text
Vân chính
U vấu
```

nhưng value lưu phải stable:

```text
main_flesh_band
wart_flesh
```

---

# 22. Không upload `corridors/` production

Không copy các file sau vào production dataset:

```text
corridors/
primitive_*_final.png
primitive_*_meta.json
semantic_groups.csv

glare_mask.png
dark_edge.png
groove_score.png
flesh_score.png
flattened_repaired.png

sam_candidate_audit.csv
02_debug_overview.png

prelabels_v7_coco.json
batch_summary.csv
contact_sheet_v7.png
```

Các file đó được giữ nguyên trong V7 archive/debug folder.

Production chỉ giữ:

```text
original image
binary prediction
polygon prelabel
manifest
```

---

# 23. Tuy nhiên giữ trace từ corridor

Không upload corridor artifacts nhưng preserve các ID hữu ích:

```text
corridorId
primitiveId
mainGroupId
fragmentIndex
wartId
```

trong:

```text
polygon.meta
```

Ví dụ:

```json
{
  "meta": {
    "semantic": "main_flesh_band",
    "mainGroupId": 4,
    "fragmentIndex": 2,
    "corridorId": 3,
    "primitiveId": 8,
    "source": "model"
  }
}
```

Nhờ đó nếu label sai vẫn trace ngược được về V7 archive.

---

# 24. Vercel Blob: không làm migration storage ngoài scope nếu chưa cần

Repo hiện tại dùng Vercel Blob chủ yếu để lưu mask người dùng đã chỉnh.

Source dataset hiện được sync từ:

```text
Google Drive
hoặc local directory
```

Không tự ý rewrite toàn storage architecture trong task này.

Scope bắt buộc là:

```text
V7 folder
→ production dataset
→ Drive/local source sync
→ web load polygon prelabel
→ edited result vẫn save theo architecture hiện tại
```

Nếu source assets bắt buộc phải chuyển sang Vercel Blob, hãy report riêng trước khi thực hiện vì đó là một migration khác gồm:

* database;
* asset resolver;
* sync/import service;
* auth/private delivery;
* project creation flow.

Không trộn migration đó vào task polygon-prelabel này.

---

# 25. Validation converter

Trước khi dataset được coi là hợp lệ, validate:

### File level

* `manifest.json` valid JSON;
* không duplicate `id`;
* image tồn tại;
* prediction tồn tại;
* prelabel tồn tại nếu khai báo;
* không absolute path;
* không `..`;
* dùng `/`.

### Image

* width > 0;
* height > 0.

### Prediction

* cùng width/height ảnh;
* PNG;
* uint8;
* unique values subset:

```text
{0, 255}
```

### Polygon

Mỗi polygon:

```text
nodes.length >= 3
```

Mỗi node:

```text
Number.isFinite(x)
Number.isFinite(y)

0 <= x <= width
0 <= y <= height
```

Không NaN.

Không Infinity.

Không flattened array còn sót lại.

### Semantic

Chỉ chấp nhận V7 labels:

```text
main_flesh_band
wart_flesh
```

trừ khi có documented extension.

---

# 26. Validation geometry count

Converter phải in count trước và sau conversion:

```text
V7 main fragments
V7 main polygons
V7 wart instances
V7 wart polygons

↓

Web main polygons
Web wart polygons
```

Các count phải reconcile.

Ví dụ:

```text
V7 main polygons       : 84
Web main polygons      : 84

V7 wart polygons       : 126
Web wart polygons      : 126
```

Nếu không khớp:

```text
FAIL
```

Không silently bỏ malformed polygon.

Report ID cụ thể.

---

# 27. Final validation output

In cuối script:

```text
V7 → WEB PRELABEL EXPORT
================================

Images                     : 128
Prediction masks           : 128
Prelabel JSON files        : 128

Main groups                : ...
Main fragments             : ...
Main polygons              : ...

Wart instances             : ...
Wart polygons              : ...

Invalid polygons           : 0
Out-of-bound nodes         : 0
Duplicate IDs              : 0
Missing images             : 0
Missing predictions        : 0
Missing prelabels          : 0
Dimension mismatches       : 0

STATUS: READY FOR WEB
```

Nếu bất kỳ required error nào > 0:

```text
STATUS: FAILED
```

---

# 28. Test bắt buộc

Tạo ít nhất một fixture/test bằng một V7 sample thật.

Test:

### A. Import

Sync dataset.

Expected:

```text
missing = 0
```

### B. Open editor

Ngay khi mở ảnh lần đầu:

* image xuất hiện;
* prediction vẫn tồn tại;
* polygon V7 đã xuất hiện;
* không phải bấm convert mask;
* vertices có thể chọn;
* node có thể kéo;
* polygon có đúng label.

### C. Main group

Nếu một main group có 3 fragments:

* thấy 3 polygon;
* cả 3 preserve cùng `mainGroupId`.

### D. Wart

Wart polygon:

```text
label = wart_flesh
```

không bị đổi thành `main_flesh_band`.

### E. Edit

Move một vertex.

Reload.

Expected:

```text
human edit được ưu tiên
```

V7 prelabel không overwrite edit.

### F. Reset

Nếu chức năng Reset to prediction hiện được giữ:

* reset vẫn hoạt động theo semantics hiện tại;
* document rõ rằng reset raster có thể làm polygon mode quay về prediction fallback.

Không tự động xóa source prelabel asset.

---

# 29. Không phá các feature hiện tại

Sau khi sửa phải chạy:

```bash
npm run typecheck
npm run lint
npm run build
```

Không để regression ở:

* auth;
* locking;
* heartbeat;
* autosave;
* IndexedDB draft;
* annotation revisions;
* Done workflow;
* prediction mask;
* current mask;
* export;
* polygon tool;
* point/breakpoint tool;
* undo/redo.

---

# 30. Deliverables

Sau khi hoàn thành, report rõ:

## Files modified

Ví dụ:

```text
annotation-tool/src/types/index.ts
annotation-tool/src/lib/drive-service.ts
annotation-tool/src/lib/db.ts
annotation-tool/src/lib/annotation-service.ts
annotation-tool/src/components/editor-workspace.tsx
...
```

## Files added

Ví dụ:

```text
scripts/convert_v7_prelabels.py
```

## Schema changes

Ghi rõ:

```text
manifest.prelabel
AnnotationPolygon.meta
database prelabel reference
EditorBootstrap prelabelOperations
```

## Conversion example

Cho một V7 object thực tế:

```text
V7 fragment
→
web polygon JSON
```

## Validation result

Paste full result:

```text
STATUS: READY FOR WEB
```

## Build result

```text
typecheck: PASS
lint: PASS
build: PASS
```

---

# Definition of Done

Task chỉ được coi là DONE khi:

1. Có thể lấy folder output V7 có sẵn và convert mà không chạy model lại.
2. Production dataset không chứa corridor/debug artifacts.
3. Mỗi ảnh có:

   * original image;
   * binary prediction;
   * polygon prelabel JSON.
4. Web importer đọc optional `prelabel`.
5. Khi mở ảnh chưa annotate:

   * polygon V7 được load trực tiếp;
   * label đúng;
   * vertices đúng;
   * không vectorize prediction lại.
6. Human annotation luôn override prelabel.
7. Polygon metadata không bị mất sau edit/save.
8. Dataset cũ không có `prelabel` vẫn hoạt động.
9. Typecheck/lint/build pass.
10. Có validation chứng minh không bị mất polygon trong quá trình convert.

Không tự ý thay đổi thuật toán V7 và không mở rộng scope sang một storage migration lớn nếu chưa được yêu cầu.

# Annotation package schema 2.0

Tài liệu này mô tả định dạng ZIP mà Khổ qua Mask Editor đọc, cùng các file schema `2.0` được xuất để phân đoạn **instance từng vân** nhưng vẫn giữ output mask nhị phân cũ.

## 1. Quy ước chung

- Mọi tọa độ dùng `coordinateSpace: "image_pixels"`, gốc ở góc trái trên của ảnh.
- Mọi mask có đúng `width × height` của ảnh gốc.
- Điểm JSON dùng cặp `[x, y]` và có thể là số thực.
- `surface_mask_edited.png` và các mask nhị phân dùng `0` hoặc `255`.
- Label instance hợp lệ nằm trong `1..16777215` (`0xFFFFFF`); `0` được dành riêng.
- ID chuỗi (`id`) dùng để liên kết metadata/stroke; số nguyên `label` mới là giá trị được mã hóa vào PNG.

## 2. ZIP đầu vào

App tìm một file có đường dẫn kết thúc bằng `dataset_manifest.json`, vì vậy ZIP có thể có thêm một thư mục bao ngoài. Cấu trúc logic:

```text
dataset_manifest.json
items/<image_id>/
  manifest.json
  <các file được manifest.files trỏ tới>
```

### `dataset_manifest.json`

Các trường app sử dụng:

```json
{
  "schemaVersion": "1.0",
  "datasetName": "Sample surface seg tests",
  "itemCount": 1,
  "items": [
    {
      "imageId": "sample_01",
      "folder": "items/sample_01",
      "manifest": "items/sample_01/manifest.json",
      "width": 1920,
      "height": 800
    }
  ]
}
```

`items` phải là mảng không rỗng. Các trường bổ sung được giữ lại khi xuất toàn dataset.

### Item `manifest.json`

Các trường bắt buộc để tải một item:

```json
{
  "schemaVersion": "1.0",
  "imageId": "sample_01",
  "width": 1920,
  "height": 800,
  "files": {
    "original": "original.png",
    "fruitMask": "fruit_mask.png",
    "surfaceMaskInitial": "surface_mask_initial.png",
    "contours": "contours.json"
  }
}
```

Các khóa file tùy chọn:

```json
{
  "grooveMaskInitial": "groove_mask_initial.png",
  "overlayInitial": "overlay_initial.png",
  "grooveScore": "groove_score.png",
  "smoothScore": "smooth_score.png",
  "annotation": "annotation.json",
  "ridgeInstanceMask": "ridge_instance_mask.png",
  "ridgeInstanceOverlay": "ridge_instance_overlay.png",
  "ridgeInstances": "ridge_instances.json",
  "ridgeMasksFolder": "ridge_masks"
}
```

Khi import, geometry round-trip được đọc từ file `files.contours`; app không tái dựng geometry từ `ridge_instance_mask.png`. Schema cũ chỉ có polygon vẫn hợp lệ. Schema 2.0 có thể dùng khóa `ridgeInstances`; alias `instances` cũng được chấp nhận khi import.

Dataset mẫu đi kèm nằm ở `SAM/Sample-surface-seg-tests-20260713T034634Z-2-001.zip` (`84,392,076` byte). Thư mục cùng tên không có file và không phải input của app.

## 3. Cấu trúc output

Khi xuất toàn dataset:

```text
dataset_manifest.json
items/<image_id>/
  original.png
  fruit_mask.png
  surface_mask_edited.png
  groove_mask_edited.png
  overlay_edited.png
  ridge_instance_mask.png
  ridge_instance_overlay.png
  ridge_instances.json
  ridge_masks/
    ridge_0001.png
    ridge_0002.png
    ...
  contours_edited.json
  annotation.json
  manifest.json
  groove_score.png          # nếu input có
  smooth_score.png          # nếu input có
```

ZIP của một ảnh có `dataset_manifest.json` một-item ở root để chính editor có thể mở lại, còn nội dung ảnh đặt dưới thư mục `<image_id>/`. Chức năng ghi folder tạo thư mục `<image_id>/`, ghi cả hai score tùy chọn và `ridge_masks/` trong folder người dùng chọn.

### Output nhị phân kế thừa

- `surface_mask_edited.png`: surface sau khi rasterize polygon + brush và cắt theo fruit mask.
- `groove_mask_edited.png`: `255` khi pixel nằm trong fruit và không thuộc surface; còn lại `0`.
- `overlay_edited.png`: ảnh gốc trộn surface màu xanh và groove màu hồng.

Hai mask nhị phân là PNG grayscale theo nội dung nhưng được ghi qua canvas RGBA, với ba kênh `R=G=B` bằng `0` hoặc `255`.

## 4. `ridge_instance_mask.png`

Đây là PNG lossless với 24 bit dữ liệu label nằm trong ba kênh RGB. Trình duyệt có thể ghi container PNG dạng RGB hoặc RGBA; nếu có kênh alpha thì bỏ qua alpha khi giải mã label. Mỗi pixel lưu theo thứ tự byte little-endian:

```text
label = R + 256*G + 65536*B

R =  label        & 255
G = (label >> 8)  & 255
B = (label >> 16) & 255
```

Ví dụ:

| Label | R | G | B |
|---:|---:|---:|---:|
| 0 | 0 | 0 | 0 |
| 1 | 1 | 0 | 0 |
| 256 | 0 | 1 | 0 |
| 65536 | 0 | 0 | 1 |
| 66051 (`0x010203`) | 3 | 2 | 1 |

Không đọc ảnh này như màu phân lớp thông thường và không chuyển sang grayscale trước khi giải mã.

### Cảnh báo về label 0

`label === 0` có ba khả năng:

1. background ngoài quả;
2. groove/rãnh trong quả;
3. pixel surface chưa được instance nào gán.

Phải dùng `surface_mask_edited.png` để phân biệt trường hợp 3:

```python
unassigned = (surface_mask_edited > 127) & (ridge_label == 0)
```

Nếu cần tách background khỏi groove, kết hợp thêm `fruit_mask.png`: groove là `fruit > 127 && surface == 0`; background là `fruit == 0`. `unassigned.sum()` phải bằng `0` trước khi đặt trạng thái `approved`.

## 5. `ridge_instance_overlay.png`

Overlay instance là PNG RGBA:

- ngoài fruit: alpha `0`;
- groove: hồng `(235, 45, 105, 255)`;
- surface chưa gán: cam `(245, 158, 11, 255)`;
- surface đã gán: màu `color` của instance;
- instance có `visible: false`: alpha `0` ở vùng instance đó.

Đây là ảnh phục vụ hiển thị/kiểm tra, không phải nguồn label chuẩn. Trạng thái ẩn chỉ ảnh hưởng overlay; `ridge_instance_mask.png` và mask nhị phân của instance vẫn giữ nguyên label.

## 6. `ridge_instances.json`

Ví dụ đầy đủ:

```json
{
  "schemaVersion": "2.0",
  "imageId": "sample_01",
  "task": "bitter_gourd_ridge_instance_segmentation",
  "coordinateSpace": "image_pixels",
  "width": 1920,
  "height": 800,
  "encoding": {
    "file": "ridge_instance_mask.png",
    "type": "rgb24_label_little_endian",
    "formula": "label = R + 256*G + 65536*B",
    "zero": "background_or_groove_or_unassigned_surface",
    "disambiguateUnassignedWith": "surface_mask_edited.png"
  },
  "complete": true,
  "unassignedSurfacePixelCount": 0,
  "invalidSeedCount": 0,
  "emptyInstanceCount": 0,
  "instances": [
    {
      "id": "ridge_1",
      "label": 1,
      "name": "Vân 1",
      "color": "#22c55e",
      "seeds": [[320, 140], [355, 280]],
      "pixelCount": 48210,
      "bbox": { "x": 250, "y": 70, "width": 180, "height": 620 },
      "binaryMask": "ridge_masks/ridge_0001.png"
    }
  ],
  "updatedAt": "2026-07-13T12:34:56.000Z"
}
```

Quy tắc:

- `complete` chỉ `true` khi `unassignedSurfacePixelCount === 0`, `invalidSeedCount === 0` và `emptyInstanceCount === 0`.
- `pixelCount` đếm pixel mang đúng label của instance sau khi áp dụng cọ ID.
- `bbox` bao quanh pixel của instance theo `{x, y, width, height}` và là `null` nếu instance không có pixel.
- `binaryMask` trỏ tới mask `0/255` riêng của instance.
- Danh sách được sắp theo `label` tăng dần.

`visible` và `locked` không nằm trong file thống kê này; chúng được lưu trong `contours_edited.json` để round-trip editor.

## 7. `ridge_masks/ridge_XXXX.png`

Mỗi instance luôn có một file mask nhị phân:

```text
pixel = 255 nếu ridge_instance_label == label
pixel =   0 trong mọi trường hợp khác
```

Tên file là `ridge_${label.toString().padStart(4, "0")}.png`. Vì vậy label lớn hơn bốn chữ số không bị cắt, ví dụ label `12345` tạo `ridge_12345.png`.

## 8. `contours_edited.json` — round-trip geometry

Đây là nguồn dữ liệu có thể mở lại để tiếp tục chỉnh sửa. Payload xuất:

```json
{
  "schemaVersion": "2.0",
  "imageId": "sample_01",
  "coordinateSpace": "image_pixels",
  "width": 1920,
  "height": 800,
  "polygons": [
    {
      "id": "poly_00000",
      "isHole": false,
      "points": [[100, 50], [200, 55], [210, 90]]
    },
    {
      "id": "poly_00001",
      "isHole": true,
      "points": [[140, 60], [160, 65], [150, 80]]
    }
  ],
  "brushStrokes": [
    {
      "id": "stroke_00000",
      "mode": "add",
      "size": 14,
      "points": [[400, 100], [405, 110]]
    },
    {
      "id": "stroke_00001",
      "mode": "erase",
      "size": 20,
      "points": [[500, 100]]
    }
  ],
  "ridgeInstances": [
    {
      "id": "ridge_1",
      "label": 1,
      "name": "Vân trái",
      "color": "#22c55e",
      "visible": true,
      "locked": false,
      "seeds": [[320, 140], [355, 280]]
    }
  ],
  "instanceBrushStrokes": [
    {
      "id": "instance_stroke_00000",
      "mode": "assign",
      "instanceId": "ridge_1",
      "size": 14,
      "points": [[360, 210], [370, 215]]
    },
    {
      "id": "instance_stroke_00001",
      "mode": "reset",
      "size": 14,
      "points": [[375, 220]]
    }
  ],
  "updatedAt": "2026-07-13T12:34:56.000Z"
}
```

### Ý nghĩa các trường round-trip

| Nhóm | Trường | Ý nghĩa |
|---|---|---|
| `polygons[]` | `id` | ID polygon ổn định trong editor. |
|  | `isHole` | `false`: thêm surface; `true`: trừ surface để tạo rãnh/hole. |
|  | `points` | Các đỉnh polygon theo pixel ảnh gốc. |
| `brushStrokes[]` | `mode` | `add` thêm surface; `erase` xóa surface. |
|  | `size` | Đường kính cọ theo pixel ảnh. |
|  | `points` | Đường đi của cọ; một điểm tạo một chấm tròn. |
| `ridgeInstances[]` | `id` | Khóa liên kết từ `instanceBrushStrokes[].instanceId`. |
|  | `label` | Số nguyên dương được ghi vào mask RGB24. |
|  | `name`, `color` | Tên và màu hiển thị. |
|  | `visible`, `locked` | Trạng thái hiển thị và khóa chỉnh sửa trong editor. |
|  | `seeds` | Một hoặc nhiều seed dẫn vùng cho instance. |
| `instanceBrushStrokes[]` | `mode` | `assign` ép về instance đích; `reset` trả về label nền do seed sinh ra. |
|  | `instanceId` | Bắt buộc về ngữ nghĩa với `assign`; bị bỏ qua/không xuất với `reset`. |
|  | `size`, `points` | Đường kính và đường đi cọ trong không gian ảnh. |

Thứ tự rasterize:

1. vẽ polygon surface;
2. trừ polygon hole;
3. áp dụng brush `add/erase`;
4. cắt surface theo `fruit_mask.png`;
5. lan label từ seed trong surface;
6. gán component surface rời không chứa seed cho seed gần centroid nhất;
7. áp dụng `instanceBrushStrokes` theo đúng thứ tự mảng.

Một nét `reset` khôi phục kết quả ở bước 5 tại vùng cọ, không tạo vùng chưa gán một cách chủ ý.

### Chuẩn hóa khi import

- Point có thể là `[x, y]` hoặc `{ "x": x, "y": y }`.
- Brush không có điểm hoặc có `mode` không hợp lệ bị bỏ qua; `size` được ép tối thiểu `1`.
- Label thiếu, trùng, không dương hoặc lớn hơn `0xFFFFFF` được thay bằng label dương chưa dùng.
- Instance thiếu tên dùng `Vân <label>`; màu không hợp lệ dùng bảng màu mặc định; `visible` mặc định `true`, `locked` mặc định `false`.
- Polygon input có thể có `area`, nhưng output `contours_edited.json` không ghi lại trường này.

## 9. `annotation.json`

```json
{
  "schemaVersion": "2.0",
  "imageId": "sample_01",
  "reviewStatus": "approved",
  "reviewer": "Nguyen Van A",
  "notes": "Đã kiểm tra biên từng vân",
  "sourceSeedMethod": "distance_core",
  "ridgeInstanceCount": 8,
  "unassignedSurfacePixelCount": 0,
  "invalidSeedCount": 0,
  "emptyInstanceCount": 0,
  "updatedAt": "2026-07-13T12:34:56.000Z"
}
```

`reviewStatus` nhận một trong `unreviewed`, `in_review`, `approved`, `rejected`. UI chặn chuyển sang `approved` nếu chưa có instance, còn pixel surface chưa gán, có seed lỗi hoặc có instance không sở hữu pixel nào.

## 10. Item `manifest.json` sau export

App nâng `schemaVersion` lên `2.0`, giữ các trường input chưa biết và cập nhật:

```json
{
  "schemaVersion": "2.0",
  "seedMethod": "manual_instance_edit",
  "sourceSeedMethod": "<seedMethod của input hoặc unknown>",
  "files": {
    "original": "original.png",
    "fruitMask": "fruit_mask.png",
    "surfaceMaskInitial": "surface_mask_edited.png",
    "grooveMaskInitial": "groove_mask_edited.png",
    "overlayInitial": "overlay_edited.png",
    "contours": "contours_edited.json",
    "annotation": "annotation.json",
    "ridgeInstanceMask": "ridge_instance_mask.png",
    "ridgeInstanceOverlay": "ridge_instance_overlay.png",
    "ridgeInstances": "ridge_instances.json",
    "ridgeMasksFolder": "ridge_masks"
  },
  "instanceEncoding": {
    "type": "rgb24_label_little_endian",
    "backgroundOrGrooveOrUnassigned": 0,
    "formula": "label = R + 256*G + 65536*B"
  },
  "ridgeInstanceCount": 8,
  "unassignedSurfacePixelCount": 0,
  "invalidSeedCount": 0,
  "emptyInstanceCount": 0,
  "updatedAt": "2026-07-13T12:34:56.000Z"
}
```

Tên khóa `surfaceMaskInitial`, `grooveMaskInitial` và `overlayInitial` được giữ để tương thích loader cũ, nhưng sau export chúng trỏ tới các file `*_edited.png`.

## 11. `dataset_manifest.json` sau export toàn bộ

App nâng schema và thêm mô tả task:

```json
{
  "schemaVersion": "2.0",
  "datasetName": "<tên cũ> — ridge instance edited",
  "datasetType": "bitter_gourd_ridge_instance_annotation",
  "instanceTask": {
    "category": "ridge",
    "encoding": "rgb24_label_little_endian",
    "legacyBinaryMasksPreserved": true
  },
  "itemCount": 1,
  "items": [
    {
      "imageId": "sample_01",
      "folder": "items/sample_01",
      "manifest": "items/sample_01/manifest.json",
      "width": 1920,
      "height": 800,
      "reviewStatus": "approved"
    }
  ],
  "updatedAt": "2026-07-13T12:34:56.000Z"
}
```

Các trường top-level chưa biết từ manifest đầu vào được giữ lại, nhưng mảng `items` được tạo lại theo các item đã xuất.

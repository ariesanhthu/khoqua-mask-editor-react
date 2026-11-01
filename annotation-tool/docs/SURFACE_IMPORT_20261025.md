# Nhập 117 ảnh surface (COCO 1.0) lên production — 2026-10-25

Trạng thái: **đã ghi lên production** (Neon + Vercel Blob của https://bitter-melon-annotation.vercel.app) ngày 2026-10-25. Không deploy code; không đổi schema.

## 1. Yêu cầu

**Người dùng xác nhận (2026-10-25):** dữ liệu run `drive/surface-20261024T233503-6d65f3139d8f` đã có; đưa lên server, **bỏ các ảnh `_01` đã được gán nhãn**; chuyển sang polygon chuẩn website, **ít điểm**. Sau lần nhập đầu (ảnh nguyên 3300×1000): **giữ kích thước pixel của ảnh cùng polygon, không scale, chỉ crop phần đen** — xem §7.

**Giả định của agent (chưa được người dùng xác nhận, đổi được):**

- Mỗi vùng thịt liên thông 4 hướng (một annotation COCO, danh mục `flesh`) là một instance `w<n>` (u vấu), giống định dạng 11 ảnh `_01` đang có trên production (`<ảnh>-w<n>`, không `meta`, giữ lỗ). Giữ cả vùng rất nhỏ (1–4 pixel) như prediction gốc.
- Khung crop là `crop_bbox_xyxy` của notebook (§7), không tự dò nền đen.
- Thêm vào dự án/dataset duy nhất hiện có ("Bitter Melon V7 Prelabel"). Lúc nhập production chưa có tính năng nhóm; sau khi deploy cùng ngày, ảnh được chia nhóm trên Home (tên ảnh `<giống>_<số>`).

## 2. Dữ liệu nguồn

Run `surface-20261024T233503-6d65f3139d8f` (pipeline `surface`, trạng thái `success`): 11 giống, 128 ảnh 3300×1000 không xoay EXIF, mỗi giống một `annotations/instances_default.json` (COCO 1.0, RLE nén, danh mục duy nhất `flesh`), `masks/` (255 = thịt), `metadata/`. Bỏ 11 ảnh `_01` → **117 ảnh, 16.606 annotation**. Script kiểm hợp RLE của mọi annotation đúng bằng mask của run (0 pixel lệch), không annotation nào chồng nhau, mọi pixel nằm trong `bbox`.

## 3. Polygon ít điểm (`compactPolygon` trong `src/lib/mask-pixels.ts`)

Mỗi annotation: giải mã RLE (`decodeCocoRle`) → biên pixel chính xác (`vectorizeBinaryMask`, giữ lỗ) → `compactPolygon`:

1. Contour nửa pixel (cắt góc bậc thang 0,5 px, như contour polygon hiện có trên production).
2. Douglas–Peucker với dung sai `t`; ring nào mất/thêm > 10 % diện tích hoặc còn < 3 điểm thì thử `t/2`, rồi giữ contour nửa pixel (vùng nhỏ, rãnh mảnh không biến mất).
3. Ring cắt/chạm nhau hoặc lỗ lọt ra ngoài biên ngoài: hạ từng ring một bậc (lỗ trước biên ngoài), nên một rãnh sát vách 1 px không làm cả polygon mất phần đã gọn. Nếu cả contour nửa pixel vẫn xung đột thì giữ biên chính xác.

**Dung sai tự động** = ¾ kích thước một pixel của ảnh mà notebook thực sự xử lý, tối thiểu 1 px (`crop_bbox_xyxy` so với `processed_hw` trong metadata). Lý do: mask notebook 27 được tính ở chiều dài 1200 px rồi phóng về ảnh gốc bằng `INTER_NEAREST`, tạo bậc thang 2–3 px không mang thông tin; dung sai cố định 1 px gần như không giảm điểm ở 8884 (×2,7). Biên không bao giờ dịch quá ¾ pixel mô hình.

Prediction PNG (1 kênh, 0/255) được **dựng lại từ polygon đã gọn** bằng `rasterizePolygons`, nên prelabel và mask gợi ý trùng từng pixel (cùng bất biến với các lần nhập trước và `dataset-import-service`).

| Giống | Ảnh | Dung sai (px) | Điểm: chính xác → gọn | Tỉ lệ | IoU thấp nhất so với mask run |
| --- | ---: | --- | --- | ---: | ---: |
| 8582 | 11 | 1–1,02 | 163.708 → 48.491 | 0,30 | 0,990 |
| 8769 | 11 | 1,66–1,94 | 188.976 → 75.425 | 0,40 | 0,978 |
| 8884 | 11 | 1,98–2,06 | 137.126 → 60.716 | 0,44 | 0,982 |
| 8964 | 11 | 1,03–1,48 | 413.990 → 218.532 | 0,53 | 0,955 |
| 8993 | 15 | 1 | 476.246 → 229.525 | 0,48 | 0,968 |
| DC3 | 7 | 1,58–1,67 | 108.258 → 41.144 | 0,38 | 0,983 |
| Draco | 7 | 1,4–1,64 | 133.734 → 47.503 | 0,36 | 0,973 |
| TVI8573 | 11 | 1,08–1,16 | 176.998 → 57.908 | 0,33 | 0,989 |
| TVI8711 | 11 | 1,35–1,54 | 174.272 → 67.619 | 0,39 | 0,985 |
| TVI8909 | 3 | 1,13–1,16 | 50.442 → 16.539 | 0,33 | 0,989 |
| VIN005 | 19 | 1,03–1,28 | 304.210 → 104.020 | 0,34 | 0,988 |
| **Tổng** | **117** | | **2.327.960 → 967.422** | **0,42** | **0,955** |

IoU thấp nhất ở 8964/8993 (mask thuật toán "wild" rất vụn, nhiều vùng nhỏ nên tỉ lệ pixel biên cao). 0 pixel thuộc hai instance; prelabel lớn nhất 1,2 MB (bản `8964_01` hiện có trên production là 4,0 MB).

## 4. Quy trình đã chạy

```powershell
# 1. Dựng dataset cục bộ (chỉ đọc run, ghi artifacts/ — gitignore)
node --experimental-strip-types --loader ./scripts/resolve-typescript.mjs scripts/build-surface-dataset.mjs `
  ../drive/surface-20261024T233503-6d65f3139d8f/artifacts/surface artifacts/surface-dataset-20261024T233503
# 2. Backup production chỉ đọc (DB repeatable-read read-only + toàn bộ Blob), ngoài repo
node --env-file=.env.local scripts/backup-server.mjs F:/ANHTHU/1-HCMUS/0-KLTN/server-backup-20261025-before-surface-import
# 3. Dry run rồi ghi
node --experimental-strip-types --env-file=.env.local scripts/import-surface-dataset.mjs <backup> artifacts/surface-dataset-20261024T233503
node --experimental-strip-types --env-file=.env.local scripts/import-surface-dataset.mjs <backup> artifacts/surface-dataset-20261024T233503 --apply
```

- Backup: 1 dự án, 1 dataset, 11 `dataset_files` (cả 11 ảnh `_01` ở trạng thái DONE), 11 annotation, 105 version, 249 Blob; `complete: true`, SHA-256 database khớp.
- `import-surface-dataset.mjs` **chỉ thêm**: kiểm checksum/kích thước/quy tắc prelabel (như `parsePrelabelOperations`) và prediction = raster của prelabel; từ chối nếu dataset đổi sau backup hoặc mã ảnh đã tồn tại; Blob ghi với `allowOverwrite: false` dưới `datasets/surface-20261024T233503-6d65f3139d8f/` (images, predictions, prelabels, manifest.json); một transaction khóa hàng `datasets` rồi chèn 117 hàng giống hệt cách *Đồng bộ nguồn* chèn ảnh mới (`blob:` reference, tên tệp, kích thước, `UNSTARTED`). Không sửa 11 hàng cũ, không đổi manifest nguồn của dự án (bấm *Đồng bộ nguồn* sau này vẫn chỉ đụng 11 ảnh `_01` như trước).
- Báo cáo (id từng hàng mới): `surface-import-report.json` trong thư mục backup.

## 5. Kiểm chứng

- `mask-pixels.test.ts`: 4 test mới cho `compactPolygon` (ít điểm mà gần như cùng pixel, vùng 1 pixel/vạch 1 px giữ đúng pixel, lỗ sát vách 1 px không cắt biên, vùng rời không chồng nhau trên mask ngẫu nhiên). Toàn bộ: typecheck, 184 test / 26 file, lint, build qua.
- E2E trên dev server **cô lập** (PGlite + lưu file tạm; `/api/health` báo không DB/Blob): tạo dự án từ thư mục dataset, *Đồng bộ nguồn* thêm 117/117, API editor của cả 117 ảnh trả đúng số polygon/điểm và kích thước, byte ảnh/prediction trùng SHA-256 manifest. Chrome headless mở editor `8964_09` (235 vùng) và `8582_02`: không lỗi console.
- Production sau khi ghi (chỉ đọc): 128 hàng; 11 hàng cũ giống hệt backup; 117 hàng mới đúng reference/kích thước/`UNSTARTED`, chưa có annotation; tải lại 351/351 Blob bằng cùng cách đọc của app (`get` theo pathname, private) — SHA-256 khớp. Fingerprint DB/Blob của `.env.local` trùng `/api/health` của site production.

**Chưa kiểm chứng:** mở 117 ảnh mới trong editor trên site production bằng tài khoản thật (không đăng nhập production trong phiên này); hiệu năng editor với ảnh nhiều điểm nhất (~35 nghìn điểm) trên máy thật; thumbnail tạo lần đầu trên Vercel.

## 6. Hoàn nguyên (nếu cần)

Khi chưa ai gán nhãn ảnh mới: xóa 117 hàng `dataset_files` có id trong `surface-import-report.json` (sau khi kiểm `annotations`, `annotation_versions`, `file_locks`, `annotation_sessions` không tham chiếu) và các Blob dưới `datasets/surface-20261024T233503-6d65f3139d8f/` và `…-crop/`. Đây là thao tác ghi production, cần người dùng yêu cầu rõ. Không khôi phục đè database từ backup khi người dùng đang làm việc.

## 7. Crop phần nền đen (lần 2, cùng ngày)

**Người dùng xác nhận:** giữ kích thước pixel của ảnh cùng polygon, **không scale**, chỉ cắt phần đen.

- Khung cắt = `crop_bbox_xyxy` của notebook (mask của cả 117 ảnh nằm trong khung, cách mép ≥ 32 px), góc trên-trái lùi về lưới khối JPEG 16 px để `jpegtran -perfect -crop` cắt **không nén lại**: phần trong giống từng pixel ảnh gốc, chỉ viền ngoài 2 px lệch ≤ 2 mức do nội suy chroma 4:2:0 khi giải mã (script kiểm từng ảnh). Không đổi tỉ lệ; polygon và prediction dịch đúng số pixel nguyên `crop.left/top` (ghi trong manifest cùng `sourceSize`, `sourceImageSha256`). Script từ chối nếu có pixel thịt nằm ngoài khung.
- Kích thước sau cắt: rộng 905–3300 px, cao 389–998 px; tổng ảnh 58,2 → 37,3 MB. Polygon giống bản chưa cắt (cùng số polygon; tối đa ±24 điểm/ảnh và IoU ±0,0001 do Douglas–Peucker so sánh số thực ở tọa độ khác).
- Lệnh: `build-surface-dataset.mjs … artifacts/surface-dataset-20261024T233503-crop --jpegtran <jpegtran.exe>` (mặc định `--crop pipeline`; `jpegtran` có trong miniconda của máy), backup mới `F:/ANHTHU/1-HCMUS/0-KLTN/server-backup-20261025-before-surface-crop` (128 ảnh, 601 Blob), rồi `import-surface-dataset.mjs <backup> <dataset> --replace [--apply]`.
- `--replace` chỉ đổi reference ảnh/prediction/prelabel, tên tệp, kích thước, `updated_at` của 117 hàng, và chỉ khi ảnh **chưa ai đụng**: `UNSTARTED`, revision/version 0, không annotation, version, session, khóa còn hạn (kiểm lại trong transaction có `FOR UPDATE`). Blob mới dưới `datasets/surface-20261024T233503-6d65f3139d8f-crop/`; Blob bản chưa cắt giữ lại (không còn hàng nào tham chiếu). Báo cáo: `surface-replace-report.json` trong backup.
- Kiểm chứng trước khi ghi: E2E dev server cô lập 117/117 với dữ liệu đã cắt; Chrome headless mở `8582_02` (174 vùng) và `8964_09` không lỗi console, polygon nằm đúng trên quả.

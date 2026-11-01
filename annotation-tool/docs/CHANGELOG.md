# Nhật ký thay đổi và quyết định

Mục mới thêm **lên đầu**. Ghi ngày tuyệt đối. Mỗi mục phân biệt rõ:

- **Người dùng xác nhận:** yêu cầu/quyết định do người dùng nêu hoặc duyệt.
- **Đã kiểm chứng:** lệnh/test thật đã chạy, kèm kết quả.
- **Chưa kiểm chứng:** việc chưa làm hoặc không làm được (ví dụ UI chuột, production, Drive).

Mẫu một mục:

```markdown
## YYYY-MM-DD — Tiêu đề ngắn

- **Thay đổi:** …
- **Kiến trúc/ảnh hưởng:** module, API, schema, dữ liệu cũ bị tác động (hoặc “không”).
- **Người dùng xác nhận:** …
- **Đã kiểm chứng:** `npm run typecheck` / `npm test` (N test) / `npm run lint` / `npm run build` …
- **Chưa kiểm chứng:** …
- **Tài liệu đã cập nhật:** …
```

---

## 2026-11-01 — Khôi phục admin/phân công v2 và gộp master mới

- **Người dùng yêu cầu:** gộp master local với remote; giữ mọi bản label đã lưu và phân công của `label03`.
- **Thay đổi:** giữ bốn commit local cùng tính năng v2 chưa commit, ghép công cụ editor và hỗ trợ prelabel từ remote. Không reset, nhập lại dữ liệu hoặc deploy production.
- **Đã kiểm chứng dữ liệu:** production có 128 ảnh cùng các phân công cũ; checksum của năm annotation hiện tại do `label03` sửa khớp API editor đang deploy. API nhóm đang deploy trả 404 (code cũ).
- **Đã kiểm chứng code:** 248 test / 28 file; typecheck, lint và build cô lập; 29 kiểm tra canvas, 12 kiểm tra dashboard bằng dữ liệu giả. Chưa hoàn tất profile hover/autofill trên cảnh polygon dày.
- **Chi tiết và bản sao:** [MERGE_RECOVERY_20261101.md](MERGE_RECOVERY_20261101.md).


## 2026-10-30 — Mở prelabel schema 1.0 và 1.1 trên Vercel

- **Người dùng xác nhận:** sửa lỗi 500 khi mở ảnh khác do prelabel khác schema; tạm bỏ qua Cloudflare; không sửa database.
- **Thay đổi:** bộ đọc hỗ trợ schema 1.0/1.1 và nhãn legacy/instance, giữ nguyên dữ liệu nguồn; API editor trả `422 INVALID_ANNOTATION` cho prelabel hỏng thay vì lỗi 500 không có thông báo.
- **Ảnh hưởng:** chỉ parser prelabel và đường tải prelabel trong API editor; không thay database, storage backend, auth, lock, lưu annotation hay renderer.
- **Đã kiểm chứng:** test mới tái hiện lỗi trên code cũ; 25 test parser/API qua sau sửa. `npm run typecheck`, `npm test` (76 test / 7 file), `npm run lint`, `npm run build` đều qua. Đọc 3 prelabel thật (`8769_02`, `8769_03`, `8582_01`) bằng kết nối Postgres `read only` và Blob GET: bộ đọc mới qua, label/toạ độ/metadata giữ nguyên.
- **Chưa kiểm chứng:** thao tác vẽ/lưu/xin khoá trên production; không thực hiện để tránh thay dữ liệu thật.
- **Chi tiết:** [PRELABEL_COMPATIBILITY.md](PRELABEL_COMPATIBILITY.md).


## 2026-10-25 — Crop nền đen 117 ảnh surface, deploy Vercel, kiểm tra đăng nhập production

- **Thay đổi:**
  - `build-surface-dataset.mjs`: `--crop pipeline` (mặc định) cắt nền đen theo `crop_bbox_xyxy` của notebook, không scale, bằng `jpegtran` không nén lại; polygon/prediction dịch đúng số pixel nguyên. `import-surface-dataset.mjs`: thêm `--replace` (đổi asset của ảnh chưa ai đụng, kiểm lại trong transaction).
  - **Dữ liệu production:** 117 ảnh surface dùng bản crop (Blob `datasets/surface-20261024T233503-6d65f3139d8f-crop/`); Blob bản chưa crop giữ lại, không còn tham chiếu. Chi tiết: [SURFACE_IMPORT_20261025.md](SURFACE_IMPORT_20261025.md) §7.
  - **Deploy production** từ working tree (chưa commit): toàn bộ thay đổi 2026-10-25 trong CHANGELOG này (nhóm/phân công/nhập thư mục, R2 code chưa bật, tối ưu render, COCO trong editor, crop). Lần chạy đầu tạo bảng/cột nhóm bằng `initializeSchema` (chỉ thêm).
  - Thêm `.vercelignore` ở gốc repo: deploy từ gốc trước đây tải cả `drive/` (414 MB) và `annotation-tool/artifacts/` (591 MB) nên CLI báo "Upload aborted"; deploy bằng `npx vercel@latest --prod --yes --archive=tgz`.
- **Kiến trúc/ảnh hưởng:** không đổi code app trong bước này. Người không phải ADMIN chỉ thấy nhóm được giao (GROUPS_AND_IMPORT §6); tại thời điểm kiểm tra, ảnh đã được chia nhóm theo giống trên Home (không do agent làm).
- **Người dùng xác nhận (2026-10-25):** giữ kích thước ảnh cùng polygon, không scale, chỉ crop phần đen; deploy Vercel, đăng nhập trên web bằng tài khoản ADMIN trong env và test.
- **Đã kiểm chứng:** build dataset crop (117 ảnh, phần trong ảnh giống từng pixel bản gốc, mọi pixel thịt nằm trong khung); E2E dev server cô lập 117/117 + Chrome headless mở editor. Backup chỉ đọc trước khi thay (`server-backup-20261025-before-surface-crop`). Sau khi thay: 128 hàng, 11 ảnh `_01` giống hệt backup, 351/351 Blob trùng SHA-256. typecheck/lint sạch (test 184/26 và build đã chạy trước bước này, chỉ script/tài liệu đổi sau đó). Deployment `● Ready`, alias https://bitter-melon-annotation.vercel.app. Trên production: `/api/health` đủ cấu hình; đăng nhập ADMIN qua API và qua form thật (Chrome headless, không bấm nút seed) vào được Home, không lỗi console; API editor (GET, không xin khóa) của cả 117 ảnh mới đúng kích thước/số polygon, khi đã warm 1,1–2,4 s cho ảnh nặng nhất (lần gọi đầu sau deploy 51 s); byte ảnh/prediction của 3 ảnh mẫu trùng manifest, thumbnail WebP tạo được.
- **Chưa kiểm chứng:** mở editor (xin khóa, vẽ, lưu) trên production — cố ý không làm để không tạo khóa/bản nháp trên ảnh thật; tài khoản người gán nhãn; thiết bị thật.
- **Tài liệu đã cập nhật:** SURFACE_IMPORT_20261025 §1/§7, trạng thái deploy trong GROUPS_AND_IMPORT, EDITOR_RENDERING, EDITOR_PIPELINE, ARCHITECTURE; `docs/vercel-cicd.md` gốc repo.

## 2026-10-25 — Nhập 117 ảnh surface (COCO 1.0) lên production với polygon ít điểm

- **Thay đổi:**
  - `mask-pixels.ts` thêm `compactPolygon` (contour nửa pixel + Douglas–Peucker, hạ bậc từng ring khi rỗng/cắt nhau/lỗ lọt ngoài, cuối cùng giữ biên chính xác). Chỉ script nhập dùng; editor không đổi.
  - Script mới: `scripts/build-surface-dataset.mjs` (run COCO 1.0 → manifest/ảnh/prediction/prelabel cục bộ, dung sai tự động = ¾ pixel ảnh notebook xử lý, tối thiểu 1 px), `scripts/import-surface-dataset.mjs` (chỉ thêm ảnh mới vào dataset production, cần backup đã kiểm, dry run mặc định).
  - **Dữ liệu production:** thêm 117 ảnh (11 giống, bỏ 11 ảnh `_01` đã gán nhãn) vào dự án "Bitter Melon V7 Prelabel": 16.606 instance `w*`, 2,33 triệu → 0,97 triệu điểm (×0,42). Blob dưới `datasets/surface-20261024T233503-6d65f3139d8f/`. Chi tiết, số liệu và hoàn nguyên: [SURFACE_IMPORT_20261025.md](SURFACE_IMPORT_20261025.md).
- **Kiến trúc/ảnh hưởng:** không đổi API, schema, type, editor, export, save policy, khóa. Production chỉ được **thêm** 117 hàng `dataset_files` + 352 Blob; 11 hàng cũ, annotation, version và manifest nguồn của dự án giữ nguyên (đã đối chiếu với backup).
- **Người dùng xác nhận (2026-10-25):** đưa run `surface-20261024T233503-6d65f3139d8f` lên server, bỏ ảnh `_01` đã gán nhãn, chuyển sang polygon chuẩn website, ít điểm.
- **Giả định của agent (chưa được người dùng xác nhận):** mỗi vùng `flesh` liên thông là một `w<n>` như 11 ảnh `_01`; giữ cả vùng 1–4 pixel; ảnh gốc 3300×1000 không crop; dung sai tự động như trên; chưa chia nhóm theo giống (production chưa có tính năng nhóm).
- **Đã kiểm chứng:** `npm run typecheck` sạch; `npm test` **184 test / 26 file** (+4 test `compactPolygon`); `npm run lint` sạch; `npm run build` thành công (env giả); `canvas-browser-check` 21/21. E2E dev server cô lập: *Đồng bộ nguồn* thêm 117/117, API editor của cả 117 ảnh khớp manifest, Chrome headless mở editor không lỗi console. Backup chỉ đọc trước khi ghi (`F:/ANHTHU/1-HCMUS/0-KLTN/server-backup-20261025-before-surface-import`). Sau khi ghi: 128 hàng, 11 hàng cũ giống hệt backup, 351/351 Blob tải lại trùng SHA-256, fingerprint DB/Blob trùng `/api/health` production.
- **Chưa kiểm chứng:** mở ảnh mới trên site production bằng tài khoản thật; hiệu năng ảnh ~35 nghìn điểm trên máy thật; thumbnail lần đầu trên Vercel. Chưa commit, không deploy code.
- **Tài liệu đã cập nhật:** SURFACE_IMPORT_20261025 (mới), README (docs), AGENT_GUIDE (bản đồ ảnh hưởng), ARCHITECTURE (bản đồ code), ENGINEERING_POLICY và `CLAUDE.md` gốc (baseline).

## 2026-10-25 — Tối ưu render editor (paint, chỉnh segment, zoom, tải ảnh, chuyển brush ↔ polygon) và nhập COCO 1.0 trong editor

- **Thay đổi:**
  - Canvas (`editor-canvas.tsx`): cờ bẩn theo từng lớp; ảnh gốc chỉ vẽ lại khi đổi view/kích thước; thêm lớp `draft-layer` cho polygon đang vẽ + khung chọn; image pyramid cho ảnh ≥ 1024 px khi thu nhỏ; `image.decode()` trước khung đầu; tỉ lệ pixel tối đa 1.5×, 1× khi `deviceMemory` < 4 GB; kéo node chỉ thay dirty rectangle của lớp vector qua back buffer; khôi phục vùng polygon khóa bỏ qua khi không có polygon khóa; raster nhị phân dựng trong hình chữ nhật pixel của polygon, ghi thẳng từng đoạn quét; dựng raster khi vào Brush chạy lúc rảnh; file `POLYGON_SET` không tải/chuẩn hóa mask đã lưu; mask dự đoán chuẩn hóa lười khi Khôi phục/Giữ mask gợi ý.
  - Worker (`brush-worker.ts`): thêm `INIT_POLYGONS` (worker tự rasterize từ polygon), kết quả vector gửi dạng typed array (`polygon-pack.ts`, mới).
  - Module mới: `polygon-draft.ts` (lịch sử điểm polygon đang vẽ, tách nguyên hành vi cũ), `vector-identity.ts` (bounds cache không cấp phát + gán id theo IoU dùng lưới, kết quả như quét O(n²)), `polygon-pack.ts`. `mask-pixels.ts` thêm `forEachPolygonSpan` (lõi quét dòng, `rasterizePolygons` dùng lại), `polygonPixelRect`, `normalizeMaskRgba`; `simplifyRing` (chỉ dùng cho LOD hiển thị) thêm bước radial-distance. `canvas-view.ts` thêm `renderPixelRatio`, `photoPyramidSizes`, `photoLevelFor`.
  - Nhập JSON trong editor (`web-import.ts`, nút đổi tên “Nhập JSON polygon / COCO 1.0”): nhận thêm COCO 1.0 cho ảnh đang mở (chọn ảnh theo tên/`external_key`, ánh xạ danh mục tự động, polygon + RLE qua `cocoImagePolygons`); thông báo nêu số annotation bị bỏ qua.
  - Trang `/canvas-browser-check` (dữ liệu giả) thêm cảnh `?many=1` (600 polygon), hiển thị trạng thái undo/selection; thêm `scripts/canvas-browser-check.mjs` (Chrome headless qua DevTools Protocol, không dependency mới).
  - Sửa lỗi: file có `POLYGON_SET` rỗng giữ raster dự đoán/đã lưu trong bộ nhớ dù không hiển thị, nên nét brush đầu tiên làm vùng dự đoán xuất hiện lại. Nay raster luôn khớp polygon.
- **Kiến trúc/ảnh hưởng:** Không đổi API, schema, type dùng chung, định dạng lưu/export, save policy, khóa, mapping chuột/phím. `rasterizePolygons` (dùng ở export, version route, dataset import, script) giữ đúng từng pixel: test so với bản sao nguyên văn của thuật toán cũ trên polygon ngẫu nhiên (lỗ, chồng lấn, tọa độ lẻ, ngoài ảnh). JSON polygon từ worker giống từng byte trước/sau (test). Raster worker khởi tạo từ polygon cho cùng kết quả vector hóa (510 thành phần trên cùng chuỗi nét, trước và sau). Undo/redo, hợp đồng vẽ polygon và Select không đổi.
- **Người dùng xác nhận (2026-10-25):** refactor, cập nhật đầy đủ comment/docs/rule; tối ưu cho thiết bị; bổ sung định dạng COCO 1.0; paint và chỉnh segment không lag; tìm hiểu thuật toán tối ưu render khi zoom, vẽ segment, tải, chuyển paint ↔ polygon; **không phá vỡ tính năng hiện có**, đặc biệt undo từng điểm khi đang vẽ polygon.
- **Giả định của agent (chưa được người dùng xác nhận):** “bổ sung COCO 1.0” được hiểu là cho nút nhập JSON trong editor nhận COCO 1.0 (nhập thư mục COCO ở Home đã có; export không đổi); ánh xạ danh mục tự động, không có hộp thoại; máy < 4 GB vẽ lớp canvas ở 1×; sửa lỗi `POLYGON_SET` rỗng ở trên.
- **Đã kiểm chứng:** `npm run typecheck` sạch; `npm test` 180 test / 26 file qua (158 → 180, chạy lại 2 lần ổn định); `npm run lint` sạch; `npm run build` thành công (env DB/Blob giả). `node scripts/canvas-browser-check.mjs` trên dev server cô lập: 21/21 (undo/redo từng điểm, nút Hoàn tác/Làm lại, double-click, chuột phải, Esc, brush → vector hóa, undo brush, export PNG, zoom, kéo node, dirty rectangle trùng pixel với vẽ toàn bộ trên ảnh chụp ghép lớp). Số đo 4× CPU (chi tiết [EDITOR_RENDERING.md](EDITOR_RENDERING.md) §5): brush → select long task ~800 → ~250 ms; 3 nét brush đầu 111–176 → 0 ms; kéo node p95 khung 50 → 17 ms; mở file polygon bỏ ~500 ms chuẩn hóa mask (CPU profile). Script Node strip-types vẫn import được `mask-pixels.ts`.
- **Chưa kiểm chứng:** thiết bị thật (điện thoại/tablet/laptop yếu), ảnh thật 12 MP ~1600 polygon, Safari/Firefox, production build, mất GPU context thật; workspace (lưu, khóa, đổi file/tab) trên trình duyệt; nhập file COCO thật từ CVAT bằng nút trong editor. Chưa commit, chưa deploy.
- **Tài liệu đã cập nhật:** EDITOR_RENDERING (mới), EDITOR_PIPELINE (pipeline, hợp đồng vẽ polygon, COCO trong editor, invariant), ARCHITECTURE (yêu cầu 12, bản đồ code, việc còn lại), AGENT_GUIDE (bản đồ ảnh hưởng, bẫy đã biết), ENGINEERING_POLICY (baseline, E2E canvas), GROUPS_AND_IMPORT, README (docs), `CLAUDE.md` gốc repo.

## 2026-10-25 — Nhóm ảnh, phân công theo nhóm, nhập thư mục (mặc định / COCO 1.0), Home theo nhóm

- **Thay đổi:** Schema thêm `file_groups`, `group_assignments`, cột `dataset_files.group_id`. Module mới `file-groups.ts`, `coco-import.ts`, `import-plan.ts` (chạy ở trình duyệt), `access-service.ts`, `group-service.ts`, `dataset-import-service.ts`; route mới `GET /api/projects/:id/groups`, `PUT …/groups/:groupId/assignees`, `POST …/groups/auto`, `POST /api/projects/:id/import`. Route sửa: `GET /api/projects` và `GET …/files` lọc theo phân công (thêm `groupId`, `annotationState` nhiều giá trị, trường `group`); `GET /api/files/:id/editor` và `POST …/lock` trả 403 cho ảnh ngoài nhóm được giao; `POST /api/projects` kiểm ADMIN từ DB và nhận `source: 'upload'`. `prelabel-service` tách `parsePrelabelOperations` (hành vi `loadPrelabelOperations` giữ nguyên); `object-store` thêm `datasetObjectReference`. Home (`dashboard.tsx`) trình bày lại: thanh dự án + tiến độ, thẻ nhóm → danh sách ảnh theo nhóm (lọc có đếm, tìm, Làm ảnh tiếp theo), ADMIN có tab Nhập dữ liệu/Quản trị, hộp thoại Phân công, thẻ Chưa phân nhóm + Tự động chia nhóm. Thêm `group-assign-dialog.tsx`, `dataset-import.tsx`, CSS mới cuối `globals.css` (chỉ thêm, dùng token sẵn có).
- **Kiến trúc/ảnh hưởng:** Schema chỉ thêm, idempotent; vân tay schema đổi nên lần khởi động đầu chạy lại các lệnh DDL. Type chỉ thêm (`FileListItem.group?`, `FileGroupSummary`, `FileGroupList`, `UserSummary`, `DatasetImportResult`, `ErrorCode` + `INVALID_DATASET`). Editor không sửa dòng nào, nhưng sidebar/Done & Next nhận danh sách đã lọc và ảnh ngoài nhóm hiện "Không thể mở tệp". Heartbeat/lưu/Hoàn tất/mask, export ZIP/Drive, version, asset route không đổi. **Dữ liệu production có sẵn chưa có nhóm**: sau khi deploy, người gán nhãn không thấy ảnh cho tới khi ADMIN bấm Tự động chia nhóm và Phân công (không có migration tự động).
- **Người dùng xác nhận (2026-10-25):** trình bày lại UX trang chính, giữ design, không sửa trang editor; admin giao việc cho người dùng, người dùng chỉ thấy việc được giao; giao theo nhóm, tải cả thư mục thì mỗi thư mục con (mỗi giống) thành một nhóm; người gán nhãn xem theo nhóm, bấm nhóm thấy danh sách ảnh; tải lên hỗ trợ COCO 1.0, định dạng có sẵn giữ làm mặc định và không bị xóa.
- **Giả định của agent (chưa được người dùng xác nhận):** REVIEWER như ANNOTATOR; một nhóm giao được nhiều người; Cập nhật Drive/Tải ZIP giữ phạm vi cả dự án; từ chối JPEG có EXIF xoay; nhóm = thư mục đầu tiên không phải thư mục cấu trúc (`images`, `annotations`, `predictions`, `prelabels`, `masks`, `default`…), có tùy chọn chia theo tiền tố tên ảnh; gợi ý ánh xạ danh mục COCO theo tên (admin sửa được).
- **Test cũ bị chạm (không đổi assertion):** `editor-prediction.test.ts` thêm `can_access: true` vào dòng DB giả lập vì truy vấn bootstrap có cột mới, và thêm test 403. `api-client.test.ts` đặt timeout 20s riêng cho test gzip ~10 MB: đo được 3.3–3.7s/5s ngay cả ở baseline khi cả bộ chạy song song, thêm file test PGlite là vượt ngưỡng.
- **Đã kiểm chứng:** `npm run typecheck` sạch; `npm test` 158 test / 23 file qua (113 → 158), chạy lại 2 lần ổn định; `npm run lint` 0 vấn đề; `npm run build` thành công. E2E HTTP trên dev server cô lập (PGlite + storage trong thư mục tạm, `/api/health` báo không có DB/Blob thật): 29/29 kiểm tra qua — nhập COCO (polygon + RLE) → mask gợi ý đúng pixel, quyền theo nhóm (dự án/nhóm/ảnh, 403 khóa/editor, 409 nhập lại khi đang sửa, không phải ADMIN không nhập được), nhập định dạng mặc định với 11 ảnh V7 thật từ `drive/prelabel-production` (chỉ đọc) theo tên ảnh thành 11 nhóm, polygon và byte PNG giữ nguyên; Home render, 16 chunk client tải được. Đã dừng server, xóa 1 thumbnail cache do lần thử tạo trong `annotation-storage/thumbnails`.
- **Chưa kiểm chứng:** tương tác trên trình duyệt (không có trình duyệt trong phiên): chọn thư mục, xem trước, ánh xạ danh mục, hộp thoại phân công, bộ lọc, quay về nhóm từ editor, giao diện mobile; ghi lên Vercel Blob/R2 thật; giới hạn 4.5 MB/request trên Vercel; file COCO rất lớn; dữ liệu production. Chưa commit/deploy.
- **Tài liệu đã cập nhật:** GROUPS_AND_IMPORT (mới), ARCHITECTURE, EDITOR_PIPELINE, AGENT_GUIDE, ENGINEERING_POLICY (baseline), README (docs + app), `CLAUDE.md` gốc repo.

## 2026-10-25 — Lớp lưu trữ đối tượng, hỗ trợ Cloudflare R2 (chưa bật)

- **Thay đổi:** Thêm `src/lib/object-store.ts` (+ test) với backend `r2` / `blob` / `filesystem`; `storage.ts` và `drive-service.ts` (đọc `blob:`) gọi qua lớp này; `/api/health` nhận biết R2; thêm dependency `aws4fetch` (ký SigV4, nhỏ, không kéo AWS SDK); thêm `scripts/migrate-blob-to-r2.mjs` (mặc định dry-run); `.env.example` thêm `STORAGE_BACKEND`, `R2_*`; tài liệu [CLOUDFLARE_R2_STORAGE.md](CLOUDFLARE_R2_STORAGE.md).
- **Kiến trúc/ảnh hưởng:** Mặc định không đổi hành vi (không đặt `STORAGE_BACKEND` ⇒ như cũ), nên Vercel không đổi cho đến khi bạn đặt biến. Định dạng `maskStorageKey` và `blob:` giữ nguyên. Một khác biệt có chủ đích: tham chiếu `blob:` của dataset luôn đọc từ Blob/R2, không còn phụ thuộc cách `getBlob` được gọi trực tiếp. Script thao tác dữ liệu vẫn dùng Blob.
- **Người dùng xác nhận (2026-10-25):** tạm giữ Vercel để chạy app, chuyển nơi lưu file sang Cloudflare R2. Phương án chạy cả app trên Cloudflare Containers tạm dừng.
- **Đã kiểm chứng:** `npm run typecheck` sạch; `npm test` 113 test / 18 file qua (98 → 113, thêm 15 của `object-store.test.ts`); `npm run lint` sạch; `npm run build` thành công.
- **Chưa kiểm chứng:** mọi thao tác với R2 thật — R2 chưa bật (API báo cần bật trong dashboard; endpoint S3 lỗi bắt tay TLS). `migrate-blob-to-r2.mjs` chưa chạy. Chưa đo độ trễ; chưa kiểm thử UI.
- **Tài liệu đã cập nhật:** CLOUDFLARE_R2_STORAGE, README (annotation-tool), `.env.example`, ARCHITECTURE, AGENT_GUIDE, ENGINEERING_POLICY (baseline), README (docs).

## 2026-10-25 — Chuẩn bị chạy trên Cloudflare Containers (chưa deploy)

- **Thay đổi:** Thêm `cloudflare/` (Worker `AppContainer`, `wrangler.jsonc`, package riêng), `annotation-tool/Dockerfile`, `.dockerignore`; `next.config.ts` bật `output: 'standalone'` chỉ khi `NEXT_OUTPUT=standalone`; `.gitignore` thêm `.wrangler/`, `.dev.vars*`; tài liệu [CLOUDFLARE_DEPLOY.md](CLOUDFLARE_DEPLOY.md).
- **Kiến trúc/ảnh hưởng:** Không đổi code nghiệp vụ, API, schema. Build Vercel không đổi (biến `NEXT_OUTPUT` không được đặt). Cloudflare là bản song song, cùng database/Blob nếu dùng cùng secret.
- **Người dùng xác nhận (2026-10-25):** Chọn Cloudflare Containers (không dùng Workers/OpenNext, không chỉ dùng R2/DNS). Token Cloudflare đã được cung cấp để thiết lập.
- **Đã kiểm chứng:** token `active`; `cd cloudflare && npx tsc --noEmit` sạch; `wrangler deploy --dry-run --containers-rollout=none` hợp lệ (Worker 54.54 KiB); `npm run typecheck` và ESLint cho `next.config.ts` sạch; bản sao sạch không có `.env*` chạy `npm ci` + `NEXT_OUTPUT=standalone npm run build` thành công, `server.js` và `sharp` có trong `.next/standalone`; chạy thử `node server.js` cô lập: `/login` 200, `/api/projects` không đăng nhập 401, `/api/health` 503 `configuration_required` đúng như khi thiếu cấu hình.
- **Chưa kiểm chứng:** build/chạy image Docker thật (máy chưa có Docker); deploy (account **chưa có Workers Paid**, Containers API từ chối); Workers Builds có build được image không; hành vi trên Cloudflare (cold start, bộ nhớ export ZIP, cookie/Host, Google OAuth callback); `npm test`, `npm run lint` toàn dự án và `npm run build` chế độ Vercel không chạy lại vì không đổi code nghiệp vụ.
- **Tài liệu đã cập nhật:** CLOUDFLARE_DEPLOY, ARCHITECTURE (ghi chú hosting), AGENT_GUIDE, README (docs), `CLAUDE.md`.

## 2026-10-25 — Thiết lập quy định cho Claude và Cloudflare MCP

- **Thay đổi:** Thêm `CLAUDE.md` ở gốc repo; thêm [ENGINEERING_POLICY.md](ENGINEERING_POLICY.md), [AGENT_GUIDE.md](AGENT_GUIDE.md), [README.md](README.md) (mục lục docs) và nhật ký này; thêm `.mcp.json` đăng ký Cloudflare MCP (`cloudflare-api`, `cloudflare-docs`).
- **Kiến trúc/ảnh hưởng:** Không đổi code ứng dụng, schema hay API. Chỉ thêm tài liệu và cấu hình MCP cấp dự án.
- **Người dùng xác nhận (2026-10-25):**
  1. Mọi tính năng mới hoặc thay đổi thành phần khác phải được test và kiểm tra để không ảnh hưởng, làm thay đổi hay phá vỡ chức năng khác.
  2. Luôn viết và cập nhật docs cho điều đã thay đổi: kiến trúc, tính năng được người dùng xác nhận.
  3. Thiết lập Cloudflare MCP cho dự án.
- **Đã kiểm chứng (baseline trước khi thêm docs):** `npm run typecheck` sạch; `npm run lint` không có cảnh báo; `npm test` 98 test / 17 file qua. Không chạy `npm run build` trong lần này vì không đổi code.
- **Chưa kiểm chứng:** Kết nối OAuth tới Cloudflare MCP (cần người dùng approve server và xác thực qua `/mcp`). `claude` CLI không có trong PATH của shell phiên này nên cấu hình được ghi trực tiếp vào `.mcp.json`.
- **Tài liệu đã cập nhật:** `CLAUDE.md`, `annotation-tool/CLAUDE.md`, ENGINEERING_POLICY, AGENT_GUIDE, README (docs), CHANGELOG.

## Lịch sử trước đó (tóm tắt từ tài liệu hiện có)

Nguồn là các tài liệu chuyên đề; mở file tương ứng để xem chi tiết và ngày.

- **2026-10-04** — Xuất ground truth “consistent”: mask Canvas native + viền 2px, COCO RLE suy ra từ cùng một raster. Người dùng chọn `native-canvas-separated.png` cho `8582_01`. → [GROUND_TRUTH_EXPORT.md](GROUND_TRUTH_EXPORT.md)
- **2026-09-14** — Dữ liệu Drive gốc + polygon bảo toàn; thêm version ảnh (ADMIN xem/xóa/đặt làm bản chính); sửa ZIP đủ ảnh/mask/JSON và vectorizer giữ pixel. → [DRIVE_NATIVE_20260914.md](DRIVE_NATIVE_20260914.md), [IMAGE_VERSIONS.md](IMAGE_VERSIONS.md), [ZIP_PIXEL_AUDIT.md](ZIP_PIXEL_AUDIT.md)
- **2026-09-09** — Bàn giao kiến trúc: save policy (nháp local 30s, server khi bấm lưu/đổi tab/file/Hoàn tất), khóa file có TTL, point u vấu `segmentation.wartPoints`, export Drive gồm DRAFT + DONE. Yêu cầu đã chốt nằm ở [ARCHITECTURE.md](ARCHITECTURE.md).
- **Trước đó** — Chuyển hoàn toàn sang Next.js full-stack trên Vercel; instance label `r*`/`w*`; polygon tools; CI/CD GitHub Actions → Vercel (`docs/prelabel-instance-labels.md`, `docs/vercel-cicd.md` ở gốc repo).

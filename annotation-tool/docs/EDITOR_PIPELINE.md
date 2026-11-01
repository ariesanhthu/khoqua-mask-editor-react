# Editor pipeline và hợp đồng chức năng

Merge 2026-11-01: giữ Home theo nhóm/phân công và pipeline lưu/brush/undo v2; thêm công cụ R (hình chữ nhật), C (tròn/oval), A (điểm neo), Ctrl+A chọn toàn bộ, snap/tự nối biên/điền vùng kín từ remote. Polygon mới dùng nhãn `w*`; dữ liệu đã lưu không tự bị đổi khi mở. Các công cụ mới dùng chung lịch sử, revision và đồng bộ raster của local. Xem [MERGE_RECOVERY_20261101.md](MERGE_RECOVERY_20261101.md).

Kiến trúc và backlog: [ARCHITECTURE.md](ARCHITECTURE.md). Bản cập nhật và quy trình bảo toàn dữ liệu ngày 2026-09-14: [DRIVE_NATIVE_20260914.md](DRIVE_NATIVE_20260914.md). Đã deploy Vercel. Tối ưu render 2026-10-25 (đã deploy cùng ngày): [EDITOR_RENDERING.md](EDITOR_RENDERING.md). Thao tác chuột/phím trên canvas được kiểm tra tự động bằng Chrome headless trên trang dữ liệu giả (`scripts/canvas-browser-check.mjs`); chưa kiểm thử tay trên thiết bị thật và dữ liệu thật.

## Pipeline dữ liệu

1. API editor trả ảnh, prediction mask, revision và annotation hiện tại.
2. Trình duyệt tải đồng thời các asset theo URL có phiên bản crop. Annotation đã lưu được đọc nguyên vẹn; không tự vector hóa lại khi mở hoặc tải ZIP.
3. `EditorCanvas` giữ zoom, pan, polygon, node và selection trong `ref`; pointer-move chỉ vẽ lại canvas qua `requestAnimationFrame`. Sáu lớp canvas, mỗi lớp có cờ bẩn riêng (cập nhật 2026-10-25, chi tiết và số đo: [EDITOR_RENDERING.md](EDITOR_RENDERING.md)): `stage` (ảnh gốc, chỉ vẽ lại khi đổi view/kích thước; thu nhỏ thì lấy từ image pyramid), `raster-mask-layer`, `vector-layer` (kéo node chỉ thay dirty rectangle qua back buffer), `draft-layer` (polygon đang vẽ + khung chọn), lớp nét brush và vòng cọ. Polygon bất biến giữ cache Path2D/bounds/LOD; chỉ hiện node của polygon đã chọn (handle vẽ gộp thành 2 path). Lớp tô polygon dùng `fill(Path2D)` có khử răng cưa; raster nhị phân cho export chỉ dựng lại khi cần (`ensureMaskRaster`, chỉ trong hình chữ nhật pixel của polygon).
4. Brush: nét đang kéo vẽ trên overlay screen-space; nhả chuột thì tô đúng vùng bounds của nét lên mask/tint, không render lại toàn ảnh. Worker (tạo một lần) được khởi tạo từ polygon (`INIT_POLYGONS`, cùng quy tắc tâm pixel) hoặc từ raster (`INIT_MASK`, file chỉ có raster), sau đó chỉ nhận vùng thay đổi (`PUT_PATCH`). **Không vector hóa sau mỗi nét** — chỉ khi rời công cụ Brush hoặc vào Select/Polygon. `MaskVectorizer` chỉ dò lại các thành phần chạm vùng bẩn, rồi làm mịn biên (contour nửa pixel → Douglas–Peucker → Chaikin/B-spline); kết quả gửi về dạng typed array (`polygon-pack.ts`). Nút “Làm mịn biên” áp dụng cùng thuật toán cho polygon đã chọn (có undo); annotation đã lưu không tự bị làm mịn.
5. Một thao tác hoàn tất mới tạo history và cập nhật snapshot React trong bộ nhớ. Không có timer theo từng thao tác: draft ghi IndexedDB mỗi 30 giây, khi ẩn trang/đổi tab trình duyệt và trước khi đổi file.
6. Chỉ Lưu, đổi tab bước/file, ẩn trang, xác nhận mask và Hoàn tất mới gửi server; vẽ/hoàn tất polygon không gửi server. Chuyển file chờ lưu thành công rồi nhả khóa; khi conflict giữ draft cho đến khi người dùng tự chọn cách xử lý.
6. Chỉ nút Cập nhật Drive ở Home ghi lên Drive bằng OAuth server. ZIP giữ nguyên chuỗi JSON, nodes/holes, label, metadata, byte ảnh và raster đã lưu; SVG boundary/overlay giữ tọa độ vector. Chỉ render raster bổ sung nếu chưa có raster lưu. ADMIN tải thêm các version cùng crop lịch sử. Tải ZIP không ghi Drive.
7. Tab Mật độ u vấu dùng click tạo point, không phải score. Canvas point editor cũ được tái sử dụng; workspace map sang `segmentation.wartPoints`, không ghi đè `annotation.breakpoints` legacy.
8. File bị khóa vẫn mở được chỉ xem. Backend kiểm tra token/user/TTL/revision cho mỗi lần ghi; UI chặn sửa qua controls, canvas và phím tắt. Các edge case lifecycle/offline cần tiếp tục kiểm thử theo backlog.
9. Phân công theo nhóm (2026-10-25, code editor không đổi): người không phải ADMIN chỉ được bootstrap/xin khóa ảnh thuộc nhóm được giao; ảnh khác trả 403 và editor hiện màn "Không thể mở tệp" sẵn có. Sidebar và Done & Next dùng cùng API danh sách nên chỉ gồm ảnh của các nhóm được giao (mọi nhóm được giao, không riêng nhóm đang làm). Bỏ giao giữa phiên không chặn heartbeat/lưu/Hoàn tất. Xem [GROUPS_AND_IMPORT.md](GROUPS_AND_IMPORT.md).

10. Nút “Nhập JSON polygon / COCO 1.0” (2026-10-25) nhận prelabel `bitter-melon-prelabel-1.1` như cũ hoặc file **COCO 1.0** (`instances_*.json` của CVAT, `coco.json` trong ZIP xuất của tool). Ảnh được chọn theo tên tệp (bỏ đuôi) hoặc `external_key` trùng mã ảnh đang mở, file chỉ có một ảnh thì dùng ảnh đó; kích thước phải khớp. Danh mục tự ánh xạ như màn nhập thư mục (vết gợn → `r*`, u vấu → `w*`, còn lại bỏ qua và báo trong thông báo); polygon/RLE đổi bằng `cocoImagePolygons` (giữ lỗ, giữ `attributes.label`). File không có annotation cho ảnh hoặc chỉ có danh mục bị bỏ qua thì bị từ chối, không xóa canvas. Như mọi lần nhập, kết quả chỉ lên máy chủ khi bấm Lưu. Code: `src/lib/web-import.ts`.

## Hợp đồng vẽ polygon (công cụ P)

Người dùng nhấn mạnh (2026-10-25) giữ nguyên hành vi này; khóa bằng `src/lib/polygon-draft.test.ts` và `scripts/canvas-browser-check.mjs`.

- Mỗi click chấm một điểm; click lại điểm đầu (khi đã có ≥ 3 điểm), Enter, nút “Hoàn tất polygon” hoặc double-click thì hoàn tất. Double-click bỏ đỉnh trùng do lần pointer-down thứ hai.
- Đang chấm điểm: **Ctrl+Z gỡ đúng một điểm vừa chấm** mỗi lần; Ctrl+Y/Ctrl+Shift+Z chấm lại; nút Hoàn tác/Làm lại trên thanh công cụ có cùng hiệu ứng và hiện trạng thái “cục bộ”. Chấm điểm mới sau khi undo bỏ nhánh redo.
- Chuột phải lên một điểm của bản nháp xóa điểm đó (hoàn tác được).
- Gỡ hết điểm rồi undo tiếp: rời bản nháp, undo chuyển sang lịch sử chung (ví dụ hoàn tác cả polygon vừa hoàn tất trước đó). Polygon đã hoàn tất được hoàn tác cả vùng bằng một bước.
- Esc hủy bản nháp. Đổi sang công cụ khác ngoài Pan cũng hủy bản nháp; Pan giữ bản nháp.
- “Hoàn tất & Tiếp theo” bị khóa khi đang có điểm nháp (undo cục bộ).

## Hợp đồng thao tác trong Select

- Chuột trái vào node: chọn và kéo node.
- Kéo chuột trái từ khoảng trống hoặc bắt đầu ngay trên phần fill polygon: marquee chọn các node nằm trong khung; click đơn trên fill vẫn chọn polygon.
- Double-click gần biên: chèn node vào đúng cạnh gần nhất; double-click gần node có sẵn chỉ chọn node đó.
- Chuột phải: chọn toàn bộ node của polygon dưới con trỏ.
- Giữ và kéo chuột phải: di chuyển toàn polygon; `Shift/Ctrl/Cmd` cho phép chọn và kéo nhiều polygon.
- Merge nhận các polygon có node được chọn, cho phép khác label và luôn trả về một outer ring hợp lệ.
- Trong công cụ Select, `1` tạo/gán label u vấu kế tiếp (`w*`) và `2` tạo/gán label vết gợn kế tiếp (`r*`) cho toàn bộ polygon đang chọn.
- Đổi tool không được reset zoom/pan. Chỉ nút “Vừa khung hình” hoặc đổi sang file khác được fit lại.
- Zoom vượt viewport phải hiện scrollbar ngang/dọc; Fit đưa surface về 100%, scroll về 0 và tự ẩn scrollbar.

## Invariant khi sửa conflict

- Không xóa hoặc thay mapping chuột ở trên nếu không có yêu cầu thay thế rõ ràng.
- Không gọi `fit()` do đổi tool hoặc selection.
- Không ghi server trong pointer-move hoặc theo timer annotation; commit snapshot và lưu server là hai bước khác nhau.
- Không xóa draft IndexedDB khi save lỗi, mất lock hoặc revision conflict.
- Không để client giữ OAuth token Drive; mọi sync/export dùng credential server.
- Không đổi hợp đồng vẽ polygon ở trên (undo từng điểm) khi refactor canvas; chạy `polygon-draft.test.ts` và kịch bản trình duyệt.
- Render: không vẽ lại ảnh gốc cho thay đổi nội dung; không `getImageData` trên lớp hiển thị; raster nhị phân và raster của worker phải đúng từng pixel với `rasterizePolygons`. Danh sách đầy đủ: [EDITOR_RENDERING.md](EDITOR_RENDERING.md) §6.
- Sau khi sửa canvas: chạy `node scripts/canvas-browser-check.mjs http://localhost:3217` trên dev server cô lập (hướng dẫn ở đầu script) ngoài 4 cổng.
- Trước khi deploy phải chạy `npm run typecheck`, `npm test`, `npm run lint` và `npm run build`.

## Đọc prelabel — cập nhật 2026-10-30

Ảnh chưa có annotation mở được cả prelabel schema 1.0 và 1.1, nhãn legacy hoặc instance `rN`/`wN`. Bộ đọc không sửa dữ liệu nguồn. Prelabel sai cấu trúc trả lỗi 422 có thông báo, không thay bằng mask rỗng. Annotation đã lưu không bị tái tạo từ prelabel. Chi tiết: [PRELABEL_COMPATIBILITY.md](PRELABEL_COMPATIBILITY.md).

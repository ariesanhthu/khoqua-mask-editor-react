# Editor pipeline và hợp đồng chức năng

Kiến trúc, yêu cầu đã chốt, kết quả kiểm tra Drive và backlog bàn giao: [ARCHITECTURE.md](ARCHITECTURE.md). Bản cập nhật 2026-09-09 hiện chỉ ở working tree; chưa deploy và chưa kiểm tra UI/E2E đầy đủ.

## Pipeline dữ liệu

1. API editor trả ảnh, prediction mask, revision và annotation hiện tại.
2. Trình duyệt tải đồng thời các asset; mask chỉ được vector hóa khi người dùng bắt đầu sửa polygon.
3. `EditorCanvas` giữ zoom, pan, polygon, node và selection trong `ref`; pointer-move chỉ vẽ lại canvas qua `requestAnimationFrame`.
4. Một thao tác hoàn tất mới tạo history và cập nhật snapshot React. Draft được ghi vào IndexedDB mỗi 30 giây; timer không gửi annotation/mask lên server.
5. Các thao tác Lưu, đổi tab/file, xác nhận và Hoàn tất mới gửi server. Chuyển file chờ lưu thành công rồi nhả khóa; khi conflict giữ draft cho đến khi người dùng tự chọn cách xử lý.
6. Chỉ nút Cập nhật Drive ở Home ghi lên Drive bằng OAuth server. Export đọc cả DRAFT/DONE đã lưu server, xuất mask, manifest, breakpoint legacy và `wart-points.jsonl`. Tải ZIP không ghi Drive.
7. Tab Mật độ u vấu dùng click tạo point, không phải score. Canvas point editor cũ được tái sử dụng; workspace map sang `segmentation.wartPoints`, không ghi đè `annotation.breakpoints` legacy.
8. File bị khóa vẫn mở được chỉ xem. Backend kiểm tra token/user/TTL/revision cho mỗi lần ghi; UI chặn sửa qua controls, canvas và phím tắt. Các edge case lifecycle/offline cần tiếp tục kiểm thử theo backlog.

## Hợp đồng thao tác trong Select

- Chuột trái vào node: chọn và kéo node; phần fill không bắt thao tác chuột trái.
- Kéo chuột trái từ khoảng trống: marquee chọn các node nằm trong khung.
- Double-click gần biên: chèn node vào đúng cạnh gần nhất; double-click gần node có sẵn chỉ chọn node đó.
- Chuột phải: chọn toàn bộ node của polygon dưới con trỏ.
- Giữ và kéo chuột phải: di chuyển toàn polygon; `Shift/Ctrl/Cmd` cho phép chọn và kéo nhiều polygon.
- Merge nhận các polygon có node được chọn, cho phép khác label và luôn trả về một outer ring hợp lệ.
- Đổi tool không được reset zoom/pan. Chỉ nút “Vừa khung hình” hoặc đổi sang file khác được fit lại.
- Zoom vượt viewport phải hiện scrollbar ngang/dọc; Fit đưa surface về 100%, scroll về 0 và tự ẩn scrollbar.

## Invariant khi sửa conflict

- Không xóa hoặc thay mapping chuột ở trên nếu không có yêu cầu thay thế rõ ràng.
- Không gọi `fit()` do đổi tool hoặc selection.
- Không ghi server trong pointer-move hoặc theo timer annotation; commit snapshot và lưu server là hai bước khác nhau.
- Không xóa draft IndexedDB khi save lỗi, mất lock hoặc revision conflict.
- Không để client giữ OAuth token Drive; mọi sync/export dùng credential server.
- Trước khi deploy phải chạy `npm run typecheck`, `npm test`, `npm run lint` và `npm run build`.

## Đọc prelabel — cập nhật 2026-10-30

Ảnh chưa có annotation mở được cả prelabel schema 1.0 và 1.1, nhãn legacy hoặc instance `rN`/`wN`. Bộ đọc không sửa dữ liệu nguồn. Prelabel sai cấu trúc trả lỗi 422 có thông báo, không thay bằng mask rỗng. Annotation đã lưu không bị tái tạo từ prelabel. Chi tiết: [PRELABEL_COMPATIBILITY.md](PRELABEL_COMPATIBILITY.md).

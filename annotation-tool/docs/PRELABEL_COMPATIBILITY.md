# Tương thích prelabel trên Vercel

Cập nhật: 2026-10-30.

## Lỗi và phạm vi sửa

Production từ commit `0455d4b` chỉ nhận `bitter-melon-prelabel-1.0` với nhãn `main_flesh_band`/`wart_flesh`. Dữ liệu surface trong Vercel Blob dùng `bitter-melon-prelabel-1.1` và nhãn instance `w1`, `w2`, ... nên ảnh chưa có annotation lỗi khi `GET /api/files/:fileId/editor` đọc prelabel. Ảnh có annotation đã lưu bỏ qua bước này.

`prelabel-service.ts` nhận cả schema 1.0 và 1.1, cùng nhãn legacy và nhãn instance `rN`/`wN` (N là số nguyên dương). Bộ đọc giữ nguyên label, ID, metadata, toạ độ và trường polygon mở rộng; không tự chuyển nhãn, làm mịn, vector hoá hay ghi lại dữ liệu. Vẫn kiểm tra kích thước, hệ toạ độ, POLYGON_SET, node ID duy nhất, bounds và cấu trúc interior rings nếu có.

Dữ liệu JSON/schema/geometry không hợp lệ sinh `PrelabelValidationError`. API editor trả `422 INVALID_ANNOTATION` kèm thông báo, không tạo mask rỗng để tiếp tục chỉnh sửa. Lỗi tải storage không bị giả thành lỗi định dạng. Annotation đã lưu vẫn được trả nguyên trạng và không tải prelabel.

## Giới hạn triển khai

- Bản sửa dựa trên `origin/master`, giữ nguyên canvas và các thay đổi công cụ polygon mới nhất trên nhánh đó.
- Không sửa `db.ts`, không thêm migration, không ghi database/Blob/Drive trong quá trình kiểm tra.
- Vẫn dùng Vercel Blob. Người dùng yêu cầu tạm bỏ qua Cloudflare ngày 2026-10-30; không cập nhật key hoặc bật R2.
- Đây là sửa hợp đồng đọc prelabel/API. Không thay thuật toán hiển thị hoặc export polygon của nhánh production.

## Kiểm chứng

Test hồi quy `prelabel-service.test.ts` tái hiện lỗi nhận schema 1.1 trên code cũ trước khi sửa. Test parser kiểm tra tương thích hai phiên bản, giữ nguyên dữ liệu và từ chối dữ liệu hỏng. `editor-prelabel.test.ts` dùng mock auth/database và Blob để kiểm tra bootstrap 200, lỗi định dạng 422 và đường đi annotation đã lưu. Không dùng database production trong test.

Chạy đủ `npm run typecheck`, `npm test`, `npm run lint`, `npm run build` trước khi deploy. Không kiểm tra vẽ/lưu/xin khoá trên dữ liệu production.

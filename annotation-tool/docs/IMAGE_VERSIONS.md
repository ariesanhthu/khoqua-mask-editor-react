# Version ảnh — 2026-09-14

Đã triển khai tại https://bitter-melon-annotation.vercel.app.

- Dashboard: ADMIN chọn **Xem / xóa version** trên từng ảnh. Xem ảnh/mask, chỉnh độ rõ mask và zoom. Xóa cần xác nhận trong giao diện.
- API danh sách, chi tiết, asset và DELETE đều kiểm tra role ADMIN trực tiếp từ bảng users; không tin riêng role trong JWT.
- **Đặt làm bản chính**: trong dialog version, chọn version → "Đặt làm bản chính cho mọi người" → xác nhận. Annotation và crop ảnh của file chuyển sang version đó cho mọi người; bản chính cũ được lưu thành version mới (không tạo bản sao trùng version được chọn). Danh sách gắn nhãn "Bản chính" cho version trùng dữ liệu + crop với bản hiện tại. Bị chặn nếu người khác đang giữ khóa editor; khóa của chính ADMIN (tab khác) được nhả, tab đó rơi vào xung đột và giữ bản nháp.
- Xóa chỉ xóa bản lịch sử được chọn, không xóa bản đang chỉnh sửa hoặc Blob dùng chung. Số version không tái sử dụng.
- Version mới lưu asset_snapshot_json (ảnh, prediction, width, height), tránh lệch tọa độ giữa các crop.
- 8964_01: snapshot server v3, NB29 flesh v4; v1–v2 vẫn giữ. 8993_01: snapshot server v1, NB29 flesh v2.
- Bản hiện tại của hai ảnh là NB29 flesh, trạng thái DRAFT. Điểm u vấu/breakpoint cũ giữ trong snapshot server; bản mới bắt đầu chưa gán điểm vì crop khác nhau.
- Manifest nguồn mới: blob:datasets/manifest.json, gồm đủ 11 ảnh. Chỉ 2 ảnh được thay dữ liệu.

## Backup trước thay đổi

Thư mục: F:/ANHTHU/1-HCMUS/0-KLTN/server-backup-20260914-before-versions (ngoài repository).

- database.json: snapshot transaction PostgreSQL repeatable-read, read-only, gồm tất cả bảng public.
- blobs/: 119 Blob tải về, giữ pathname.
- backup-report.json: số dòng, checksum SHA-256, trạng thái complete.
- import-report.json: ánh xạ file và số version vừa nạp.
- deployment-verification.json: kết quả kiểm tra production.

Tất cả 49 asset được các ảnh/annotation/version trong snapshot tham chiếu đều có trong backup. Khôi phục nên thực hiện trước trên database/Blob store riêng, giữ nguyên IDs và đường dẫn; không ghi đè production đang được người dùng chỉnh sửa.

## Kiểm tra

59 test qua (gồm chặn anonymous/ANNOTATOR/REVIEWER, JWT ADMIN cũ, scope file khi xóa, giữ annotation hiện tại, lịch sử và counter). Build, typecheck và lint qua. Không có browser kết nối trong phiên này, nên chưa xác minh tương tác giao diện bằng trình duyệt; các API production được kiểm tra bằng script verify-version-deployment.mjs.

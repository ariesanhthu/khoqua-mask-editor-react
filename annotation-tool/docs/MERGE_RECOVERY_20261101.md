# Khôi phục code v2 và kiểm tra dữ liệu label03 — 2026-11-01

## Nguyên nhân đã xác minh

`master` local ở `b6fa83d` có 4 commit riêng sau `b2301f6`, trong khi remote đi theo nhánh khác. Ngoài các commit này, giao diện Home theo nhóm, phân công, nhập dữ liệu và quản lý version còn nằm trong working tree chưa commit. Vì thế bản deploy lấy code từ remote thiếu các chức năng v2 từng được deploy trực tiếp từ máy local.

`origin/master` ở `5f23864` đã chứa `codex/prelabel-schema-fix` qua PR #1. Gộp remote vào code local phải giữ cả 4 commit riêng và các file v2 chưa commit.

## Dữ liệu production đã kiểm tra chỉ đọc

Database hiện có 128 ảnh, 16 annotation hiện tại và 106 version lịch sử. Tài khoản `label03` vẫn tồn tại với vai trò `ANNOTATOR`; phân công nhóm `8582` và `8964` vẫn còn, mỗi nhóm 12 ảnh.

Năm annotation có người sửa cuối là `label03`:

| Ảnh | Revision | Polygon | Trạng thái |
| --- | ---: | ---: | --- |
| 8964_02 | 56 | 116 | DRAFT |
| 8993_03 | 1 | 352 | DRAFT |
| 8582_03 | 1 | 112 | DRAFT |
| 8582_04 | 1 | 52 | DRAFT |
| 8582_05 | 1 | 47 | DRAFT |

Đối chiếu trực tiếp website production: cả 5 request `GET /api/files/:id/editor` trả 200, `readOnly: true`, và checksum JSON segmentation khớp database. Endpoint nhóm `GET /api/projects/:id/groups` trên production trả **404**: bản đang chạy thiếu API v2, trong khi bảng nhóm/phân công và annotation vẫn có dữ liệu.

Phạm vi kết luận: xác nhận các bản lưu trên vẫn tồn tại; không đủ bằng chứng để bảo đảm mọi bản nháp từng làm trên mọi thiết bị đã được gửi lên server. Ảnh `8993_03` có dữ liệu của `label03` nhưng ngoài hai nhóm đang được giao; khôi phục bộ lọc phân công không tự thêm ảnh này vào nhóm và không xóa annotation của nó.

Toàn bộ truy vấn kiểm tra và sao lưu dùng transaction `REPEATABLE READ READ ONLY`, đã xác nhận `transaction_read_only=on`. Không gọi seed, import, sync, activate, delete hay xin khóa trên production.

## Bản sao cục bộ

- Code trước merge: nhánh `backup/local-admin-before-merge-20261101`, commit `08d95ca`.
- Metadata kiểm tra: `annotation-tool/artifacts/data-audit-metadata-20261101.json`.
- Kết quả đối chiếu API production: `annotation-tool/artifacts/production-label03-readonly-20261101.json`.
- Bản sao 5 annotation, 1 version do tài khoản tạo và 2 phân công: `annotation-tool/artifacts/label03-saved-annotations-20261101.json` (1.799.494 byte; SHA-256 `1264a8a932485ac71ff3fdbd47ffed169ac3326212b4df8ee8efa5396d3810d0`). Đây là bản sao riêng cho tài khoản, không phải backup toàn hệ thống. Các file artifacts được gitignore và không được đưa lên Git.
- Bản sao độc lập ngoài repository của cả ba file kiểm tra/backup trên: `F:/ANHTHU/1-HCMUS/0-KLTN/server-backup-20261101-label03-merge/`; checksum tệp annotation khớp bản gốc.

## Quy tắc xử lý merge

- Giữ Home v2, quyền theo nhóm, import, quản lý version và pipeline brush/undo local.
- Ghép rectangle/circle/anchor, snap, tự nối biên, điền vùng kín và Ctrl+A từ remote vào pipeline local; polygon mới mặc định thuộc nhóm u vấu (`w*`).
- Giữ raster/export dựa trên node thật như code local; đường cong xem trước dùng trong bản nháp, thao tác anchor áp dụng biến dạng lên node. Không tự sửa hoặc làm mịn annotation đã lưu khi mở ảnh.
- Giữ hỗ trợ prelabel 1.0/1.1 và lỗi 422 có cấu trúc; đọc prelabel không đổi nhãn legacy, frontend/service chuẩn hóa tại những điểm vốn có.
- Test route prelabel cập nhật mock theo truy vấn JOIN của v2; giữ nguyên assertion về dữ liệu đã lưu. Kiểm tra trình duyệt đổi kỳ vọng nhãn polygon mới từ `r3…` thành `w1…` theo mặc định trên remote, giữ nguyên kiểm tra số node và undo.

Chưa push/deploy trong lần kiểm tra này. Muốn UI production trở lại v2 cần deploy code đã gộp với nguyên cấu hình database/storage hiện có; không cần nhập lại hoặc reset dữ liệu.

## Kiểm chứng bản gộp

- `npm run typecheck`, `npm --prefix annotation-tool test -- --reporter=dot`: 248 test / 28 file qua, gồm quyền theo nhóm, giữ annotation đã lưu, version, prelabel cũ/mới, brush và hình học từ cả hai nhánh.
- `npm run lint`: sạch. `npm run build`: thành công với biến database/storage giả, không kết nối production.
- `SKIP_PERF=1 node scripts/canvas-browser-check.mjs http://localhost:3217 artifacts/canvas-merge-20261101.json`: **29/29**; giữ undo từng điểm, brush, PNG, pixel dirty rectangle; thêm rectangle/circle/anchor, Ctrl+A/Delete/undo.
- Kiểm tra dashboard bằng Chrome headless với mọi API được thay bằng fixture giả: **12/12**, gồm nhóm được giao, tiếp tục bản nháp, ba tab admin, form tạo dự án/người dùng, nhập dữ liệu, hộp thoại phân công giữ lựa chọn hiện có; không phát sinh request ghi.
- Chưa kiểm thử tương tác trên production hoặc thiết bị thật. Lần profile đầy đủ với hover/autofill trên cảnh 600 polygon không kết thúc trong phiên; đã dừng và chạy lại bộ chức năng bằng `SKIP_PERF=1`. Hiệu năng hover/autofill trên dữ liệu dày cần đánh giá riêng, không suy ra từ các kiểm tra đã qua.

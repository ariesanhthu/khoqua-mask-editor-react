# Nhật ký thay đổi

## 2026-10-30 — Mở prelabel schema 1.0 và 1.1 trên Vercel

- **Người dùng xác nhận:** sửa lỗi 500 khi mở ảnh khác do prelabel khác schema; tạm bỏ qua Cloudflare; không sửa database.
- **Thay đổi:** bộ đọc hỗ trợ schema 1.0/1.1 và nhãn legacy/instance, giữ nguyên dữ liệu nguồn; API editor trả `422 INVALID_ANNOTATION` cho prelabel hỏng thay vì lỗi 500 không có thông báo.
- **Ảnh hưởng:** chỉ parser prelabel và đường tải prelabel trong API editor; không thay database, storage backend, auth, lock, lưu annotation hay renderer.
- **Đã kiểm chứng:** test mới tái hiện lỗi trên code cũ; 25 test parser/API qua sau sửa. `npm run typecheck`, `npm test` (76 test / 7 file), `npm run lint`, `npm run build` đều qua. Đọc 3 prelabel thật (`8769_02`, `8769_03`, `8582_01`) bằng kết nối Postgres `read only` và Blob GET: bộ đọc mới qua, label/toạ độ/metadata giữ nguyên.
- **Chưa kiểm chứng:** thao tác vẽ/lưu/xin khoá trên production; không thực hiện để tránh thay dữ liệu thật.
- **Chi tiết:** [PRELABEL_COMPATIBILITY.md](PRELABEL_COMPATIBILITY.md).

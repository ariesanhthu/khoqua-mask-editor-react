# Bitter Melon Annotation Tool — Next.js

Ứng dụng gán nhãn nhiều người dùng cho hai tác vụ:

- kiểm tra/chỉnh sửa mặt nạ phân đoạn vân khổ qua;
- thêm, di chuyển, xóa hoặc xác nhận không có điểm đứt gãy.

Frontend và backend đều nằm trong Next.js App Router. Không có backend Python.

## Chạy cục bộ

Yêu cầu Node.js 20+.

```bash
npm install
copy .env.example .env.local
npm run dev
```

Mở `http://localhost:3000/login`. Trong môi trường development có thể bấm “Tạo dữ liệu mẫu”, sau đó đăng nhập bằng `Thư / 123456` hoặc `Admin / admin123`.

Khi triển khai production với database trống, đặt `BOOTSTRAP_ADMIN_PASSWORD` (tối thiểu 8 ký tự). Tài khoản admin đầu tiên chỉ được tự tạo khi bảng người dùng chưa có dữ liệu.

## Cấu hình dữ liệu

Quản trị viên tạo dự án bằng một trong hai loại nguồn:

- đường dẫn tuyệt đối đến thư mục local có `manifest.json`, `images/`, `predictions/`;
- URL/ID thư mục Google Drive đã chia sẻ cho service account.

Với Google Drive, đặt `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` bằng chuỗi JSON hoặc đường dẫn tuyệt đối đến file JSON của service account. Credential chỉ được đọc ở server.

## Lưu trữ

- SQLite: `data/annotation.db` (WAL mode);
- mask người dùng: `annotation-storage/<dataset>/<file>/revisions/`;
- bản xuất: `annotation-storage/exports/<project>/export_<timestamp>/`;
- bản nháp trình duyệt: IndexedDB;
- `localStorage` chỉ chứa tùy chọn nhỏ như cỡ hiển thị/opacity và project gần nhất;
- JWT đăng nhập nằm trong cookie `httpOnly`.

## Kiểm tra

```bash
npm run typecheck
npm run lint
npm run build
```

## Docker

```bash
docker compose up --build
```

Hai volume `annotation-data` và `annotation-storage` giữ SQLite/mask qua các lần khởi động lại. Ứng dụng không phù hợp với filesystem tạm thời của serverless.

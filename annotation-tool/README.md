# Bitter Melon Annotation Tool — Next.js

Tài liệu ngắn về pipeline editor, thao tác chuột và invariant chống regression: [docs/EDITOR_PIPELINE.md](docs/EDITOR_PIPELINE.md).

Agent tiếp tục công việc: đọc [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) để nắm kiến trúc, yêu cầu đã chốt, kết quả kiểm tra Drive và các task chưa làm xong. Thay đổi ngày 2026-09-09 chưa deploy; cần hoàn tất kiểm tra UI/E2E theo tài liệu bàn giao.

Ứng dụng gán nhãn nhiều người dùng cho mặt nạ phân đoạn vân khổ qua và point mật độ u vấu; dữ liệu điểm đứt gãy cũ được giữ riêng. UI và backend đều dùng Next.js App Router; không có backend Python, Vite hay Docker.

## Chạy cục bộ

Yêu cầu Node.js 20+.

```bash
npm install
copy .env.example .env.local
npm run dev
```

Nếu không có `DATABASE_URL`, development dùng PostgreSQL nhúng PGlite tại `data/pglite`. Có thể gọi `/api/seed` trong development để tạo dữ liệu mẫu và đăng nhập bằng `Admin / admin123` hoặc `Thư / 123456`.

## Kiến trúc lưu trữ

- PostgreSQL serverless: người dùng, project, chỉ mục file, lock, session, revision và annotation.
- Vercel Blob riêng tư: các mask PNG do người gán nhãn chỉnh sửa.
- Google Drive: ảnh nguồn, prediction mask và thư mục xuất ground truth.
- IndexedDB: bản nháp/offline recovery trong trình duyệt.
- Cookie `httpOnly`: JWT đăng nhập.

Editor lưu IndexedDB mỗi 30 giây. Lưu/đổi tab hoặc file/Hoàn tất mới gửi server. Google Drive chỉ ghi khi bấm Cập nhật Drive ở Home: upsert `masks/`, `manifest.jsonl`, `breakpoints.jsonl` và `wart-points.jsonl` ngay trong thư mục đích, gồm bản nháp và bản hoàn tất đã lưu server. Thao tác Đồng bộ nguồn đọc manifest nguồn; Tải ZIP không ghi Drive.

## Cấu trúc Drive nguồn

```text
source-folder/
  manifest.json
  images/
  predictions/
```

`manifest.json`:

```json
{
  "dataset_version": "2026-08-10",
  "algorithm_version": "unsupervised-v1",
  "items": [
    {
      "id": "BM_000001",
      "image": "images/BM_000001.jpg",
      "prediction": "predictions/BM_000001.png",
      "width": 1024,
      "height": 768
    }
  ]
}
```

Service account trong `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` dùng đọc nguồn Drive khi cần. Ghi Drive đích dùng tài khoản Google đã kết nối qua OAuth ở server, cần quyền ghi vào thư mục đích. Drive đích mặc định của dự án này là `DATABASE-GT` (`147cVK2C7EZiupfMJQntP5Nc6tkkhqchN`).

## Deploy Vercel

1. Tạo project Vercel với Root Directory là `annotation-tool`.
2. Kết nối một Postgres serverless và đặt `DATABASE_URL`.
3. Kết nối một Vercel Blob store riêng tư.
4. Đặt các biến `SECRET_KEY`, `BOOTSTRAP_ADMIN_*`, `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` và `GOOGLE_DRIVE_EXPORT_FOLDER_ID`.
   Để ghi Drive qua OAuth, cấu hình thêm `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, rồi kết nối tài khoản Google từ Home bằng admin.
5. Deploy production.

Ứng dụng cố ý báo lỗi khi chạy trên Vercel mà thiếu `DATABASE_URL` hoặc Blob store; không fallback về filesystem tạm.

## Kiểm tra

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

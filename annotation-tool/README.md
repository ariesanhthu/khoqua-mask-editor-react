# Bitter Melon Annotation Tool — Next.js

Ứng dụng gán nhãn nhiều người dùng cho mặt nạ phân đoạn vân khổ qua và điểm đứt gãy. UI và backend đều dùng Next.js App Router; không có backend Python, Vite hay Docker.

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

Google Drive không nằm trong vòng lặp chỉnh sửa thời gian thực. Chỉ thao tác Sync đọc `manifest.json`; thao tác Export tạo một thư mục `export_<timestamp>` mới trong Drive đích.

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

Service account trong `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` phải được chia sẻ quyền đọc thư mục nguồn và quyền Editor cho Drive đích. Drive đích mặc định của dự án này là `DATABASE-GT` (`147cVK2C7EZiupfMJQntP5Nc6tkkhqchN`).

## Deploy Vercel

1. Tạo project Vercel với Root Directory là `annotation-tool`.
2. Kết nối một Postgres serverless và đặt `DATABASE_URL`.
3. Kết nối một Vercel Blob store riêng tư.
4. Đặt các biến `SECRET_KEY`, `BOOTSTRAP_ADMIN_*`, `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` và `GOOGLE_DRIVE_EXPORT_FOLDER_ID`.
5. Deploy production.

Ứng dụng cố ý báo lỗi khi chạy trên Vercel mà thiếu `DATABASE_URL` hoặc Blob store; không fallback về filesystem tạm.

## Kiểm tra

```bash
npm run typecheck
npm run lint
npm run build
```

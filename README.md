# Bitter Melon Annotation Tool

Ứng dụng đã được chuyển hoàn toàn sang **Next.js full-stack**. Mã Vite cũ và thư mục build `dist/` không còn được sử dụng.

## Production

- Website: [https://bitter-melon-annotation.vercel.app](https://bitter-melon-annotation.vercel.app)
- Health check: [https://bitter-melon-annotation.vercel.app/api/health](https://bitter-melon-annotation.vercel.app/api/health)
- Nền tảng: Next.js App Router trên Vercel; backend nằm trong Route Handlers của Next.js, không dùng Python hoặc Docker.

PostgreSQL, private Vercel Blob và JWT đã được kết nối. Để bật luồng đồng bộ/xuất Google Drive, cần đặt `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` bằng toàn bộ JSON key của service account (email riêng lẻ không đủ) rồi redeploy.

Cloudflare là phương án Containers riêng, dùng Worker `khoqua`, root `/cloudflare`, build `npm ci`, deploy `npx wrangler deploy`. Root `/annotation-tool` khiến Wrangler tự tạo OpenNext và lỗi self-reference 10143. Account hiện còn Free, chưa đủ điều kiện chạy Containers; xem [cấu hình và điểm chặn Cloudflare](annotation-tool/docs/CLOUDFLARE_DEPLOY.md). Production v2 hiện chạy trên Vercel.

Mã ứng dụng nằm trong [`annotation-tool/`](annotation-tool/README.md). Có thể chạy ngay từ thư mục gốc:

```bash
npm install --prefix annotation-tool
npm run dev
```

Cấu hình local nằm tại `annotation-tool/.env`. Production cần PostgreSQL serverless, Vercel Blob riêng tư, JWT secret và service account Google Drive; xem hướng dẫn đầy đủ trong [`annotation-tool/README.md`](annotation-tool/README.md).

Các tài liệu thiết kế và hợp đồng hành vi nằm trong [`docs/bitter-melon-labeling-spec/`](docs/bitter-melon-labeling-spec/README.md).

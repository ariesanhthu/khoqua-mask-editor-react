# Vercel CI/CD

Workflow [`.github/workflows/vercel.yml`](../.github/workflows/vercel.yml) chạy kiểm tra ứng dụng trước khi deploy:

- Pull request vào `master`: test, typecheck, build và tạo Preview Deployment.
- Push hoặc merge vào `master`: test, typecheck, build và deploy Production.
- `workflow_dispatch`: cho phép chạy Production thủ công từ GitHub Actions.

## GitHub Secrets

Thêm ba repository secrets tại **GitHub → Settings → Secrets and variables → Actions**:

| Secret | Giá trị |
| --- | --- |
| `VERCEL_TOKEN` | Access token tạo tại Vercel Account Settings → Tokens |
| `VERCEL_ORG_ID` | `orgId` trong `.vercel/project.json` local |
| `VERCEL_PROJECT_ID` | `projectId` trong `.vercel/project.json` local |

Không commit thư mục `.vercel`; thư mục này chứa thông tin liên kết project local. Root `.gitignore` đã có rule để bỏ qua các file Vercel local mới. Hai file `.vercel` đang được Git theo dõi từ trước vẫn được giữ nguyên trong thay đổi này.

## Cấu hình project Vercel

Project hiện được link với tên `bitter-melon-annotation`. Trong Vercel Project Settings, đặt **Root Directory** là repository root vì pipeline chạy Vercel CLI tại root đã được link. Build command của workspace là `npm run build`, chuyển tiếp sang ứng dụng `annotation-tool`.

Các biến mà ứng dụng cần khi chạy phải được thêm trong **Vercel → Project Settings → Environment Variables** cho Preview/Production, gồm tối thiểu:

- `SECRET_KEY` (ít nhất 32 ký tự)
- `DATABASE_URL` hoặc `POSTGRES_URL` / `NEON_DATABASE_URL`
- `BLOB_READ_WRITE_TOKEN` hoặc Vercel Blob store đã được kết nối

Các biến Google Drive/OAuth chỉ cần thêm nếu bật tính năng tương ứng.

Nếu Vercel Git Integration đang tự deploy cùng repository, tắt **Git → Connected Git Repository** hoặc cấu hình Ignored Build Step để tránh mỗi commit tạo hai deployment.

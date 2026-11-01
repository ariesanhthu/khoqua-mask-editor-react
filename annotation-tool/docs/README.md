# Mục lục tài liệu kỹ thuật

Đọc theo thứ tự khi bắt đầu làm việc (người hoặc agent):

| # | Tài liệu | Nội dung |
| --- | --- | --- |
| 1 | [AGENT_GUIDE.md](AGENT_GUIDE.md) | Claude được/không được làm gì, quy trình, bản đồ ảnh hưởng, Cloudflare MCP |
| 2 | [ENGINEERING_POLICY.md](ENGINEERING_POLICY.md) | Quy định: phân tích ảnh hưởng, test, 4 cổng chất lượng, tài liệu, an toàn dữ liệu, git/deploy |
| 3 | [ARCHITECTURE.md](ARCHITECTURE.md) | Kiến trúc, bản đồ code, API, yêu cầu người dùng đã chốt, việc còn lại |
| 4 | [EDITOR_PIPELINE.md](EDITOR_PIPELINE.md) | Pipeline editor, hợp đồng thao tác chuột, hợp đồng vẽ polygon (undo từng điểm), invariant chống hồi quy |
| 5 | [CHANGELOG.md](CHANGELOG.md) | Nhật ký thay đổi và quyết định được người dùng xác nhận |

Tài liệu chuyên đề (snapshot theo ngày, đọc khi làm đúng vùng đó):

| Tài liệu | Chủ đề |
| --- | --- |
| [EDITOR_RENDERING.md](EDITOR_RENDERING.md) | Thuật toán render editor (lớp canvas, pyramid, dirty rectangle, worker), số đo trước/sau, kiểm tra Chrome headless |
| [DRIVE_NATIVE_20260914.md](DRIVE_NATIVE_20260914.md) | Dữ liệu Drive gốc, polygon bảo toàn, import có backup |
| [SURFACE_IMPORT_20261025.md](SURFACE_IMPORT_20261025.md) | Nhập 117 ảnh surface (COCO 1.0) lên production, polygon ít điểm (`compactPolygon`), backup, kiểm chứng, hoàn nguyên |
| [IMAGE_VERSIONS.md](IMAGE_VERSIONS.md) | Version ảnh, xem/xóa/đặt làm bản chính (ADMIN) |
| [GROUPS_AND_IMPORT.md](GROUPS_AND_IMPORT.md) | Nhóm ảnh, phân công theo nhóm, quyền xem, Home theo nhóm, nhập thư mục (mặc định / COCO 1.0) |
| [ZIP_PIXEL_AUDIT.md](ZIP_PIXEL_AUDIT.md) | Kiểm tra notebook 28 và sửa ZIP pixel-exact |
| [GROUND_TRUTH_EXPORT.md](GROUND_TRUTH_EXPORT.md) | Xuất/kiểm ground truth, COCO RLE, audit độc lập |
| [CLOUDFLARE_R2_STORAGE.md](CLOUDFLARE_R2_STORAGE.md) | Lưu file trên Cloudflare R2 thay Vercel Blob: backend, quy trình chuyển, hoàn nguyên, chưa kiểm chứng |
| [CLOUDFLARE_DEPLOY.md](CLOUDFLARE_DEPLOY.md) | Chạy app trên Cloudflare Containers (chuẩn bị xong, chưa deploy): kiến trúc, secret, điều kiện, kiểm tra |

Ngoài thư mục này (gốc repo `docs/`): `vercel-cicd.md` (deploy/CI), `prelabel-instance-labels.md` (nhãn `r*`/`w*`), `annotation-package-schema.md`, `bitter-melon-labeling-spec/` (đặc tả thiết kế), `UI Style Guide – Annotation Tool (Light Mode).md`.

Quy tắc: thay đổi code ⇒ cập nhật tài liệu tương ứng và `CHANGELOG.md` trong cùng lần làm việc (xem ENGINEERING_POLICY §5).

# Tóm tắt các công việc cần làm thêm và thay đổi so với Spec ban đầu

Dựa trên quá trình phân tích thư mục `docs/bitter-melon-labeling-spec/` và thực tế triển khai hệ thống, dưới đây là tóm tắt các điểm khác biệt (do thay đổi công nghệ) và các tính năng/công việc cần làm thêm mà spec chưa đề cập chi tiết.

## 1. Thay đổi về Kiến trúc (Architecture Shift)
* **Spec ban đầu:** Đề xuất tách biệt Frontend (React/Vite) và Backend (Python FastAPI + SQLAlchemy).
* **Triển khai thực tế:** Chuyển sang mô hình **Next.js Full-stack (App Router)**.
  * **Lý do:** Giảm thiểu độ phức tạp khi vận hành (chỉ cần chạy 1 project thay vì 2), dễ dàng chia sẻ Types (TypeScript) giữa Frontend và API, setup nhanh hơn.
  * **Database:** Thay vì dùng Python SQLAlchemy, chúng ta sử dụng `better-sqlite3` chạy trực tiếp trong môi trường Node.js của Next.js. Logic Database và SQL Schema đã được code thuần bằng SQL.

## 2. Quản lý Xác thực & Bảo mật (Authentication)
* **Khoảng trống trong Spec:** Spec có nhắc đến `Role` (ADMIN, ANNOTATOR, REVIEWER) và API `/login` nhưng chưa quy định cách lưu token an toàn.
* **Cần làm thêm:** 
  * Triển khai hệ thống xác thực bằng **JWT (JSON Web Token)**.
  * Token phải được lưu trong **`httpOnly` cookies** để chống tấn công XSS, đồng thời Next.js Server Components có thể dễ dàng đọc được cookie này để bảo vệ các trang (auth guard).

## 3. Xử lý Ảnh và Mask (Asset & Canvas Management)
* **Khoảng trống trong Spec:** Spec đề cập hình ảnh lấy từ Google Drive và dùng Konva.js để vẽ.
* **Cần làm thêm:**
  * **Proxy Assets:** Client (trình duyệt) không nên gọi trực tiếp đến Google Drive vì sẽ làm lộ Token. Cần xây dựng API proxy (vd: `/api/files/.../assets/image`) để Next.js fetch ảnh từ Drive và stream về cho client. *(Hiện tại mình đã code sẵn khung API này và đang trả về ảnh giả lập cho mục đích Dev)*.
  * **Lưu Mask (Save):** Cần làm rõ logic export hình ảnh từ Konva Canvas. Khi user bấm Save, Frontend cần biến đổi nét vẽ thành file ảnh (PNG/Base64) để gửi lên API lưu vào thư mục `annotation-storage` trên server.

## 4. Giao diện Quản trị (Admin Dashboard)
* **Khoảng trống trong Spec:** Spec tập trung rất kỹ vào trải nghiệm của Annotator (Workspace, File List) nhưng hoàn toàn thiếu giao diện cho Admin.
* **Cần làm thêm:**
  * Xây dựng trang quản lý Projects & Users dành riêng cho role `ADMIN`.
  * Giao diện để Admin kết nối thư mục Google Drive.
  * Nút **"Sync from Drive"** để trigger API đồng bộ file (Manifest.json).

## 5. Môi trường Triển khai (Deployment)
* **Khoảng trống trong Spec:** Chưa đề cập đến cách host ứng dụng.
* **Cần làm thêm:** 
  * Do hệ thống sử dụng **SQLite** và **local file storage** (lưu mask), ứng dụng này **không thể** host trên các nền tảng Serverless thông thường như Vercel (vì mất dữ liệu sau mỗi lần serverless function tắt).
  * Giải pháp: Cần viết thêm file `Dockerfile` và `docker-compose.yml` để dễ dàng deploy hệ thống lên một máy chủ ảo (VPS) có ổ cứng vật lý.

## 6. Xử lý xung đột UI nâng cao (Conflict UI)
* **Khoảng trống trong Spec:** Spec 06 có nói về việc phát hiện xung đột Revision (mã 409) nhưng chưa có thiết kế giao diện cho việc giải quyết.
* **Cần làm thêm:** Thiết kế một Modal/Dialog khi xảy ra `REVISION_CONFLICT`. Dialog này cần thông báo cho user biết: "File này đã được người khác chỉnh sửa trong lúc bạn mất mạng. Bạn muốn ghi đè (Overwrite) hay Hủy bỏ các thay đổi của mình (Discard)?".

---
**Cập nhật 2026-08-10:** Các phần nêu trên đã được triển khai trong `annotation-tool/`:

* Next.js App Router đảm nhiệm cả UI và backend; không có backend Python.
* Login dùng JWT trong cookie `httpOnly`; có bootstrap admin cho production.
* Dashboard file/project, bộ lọc, trạng thái lock/assignment và giao diện quản trị project/user/Drive sync.
* Canvas P0 cho mask và breakpoint, zoom/pan/fullscreen, undo/redo, xác nhận không có breakpoint.
* IndexedDB recovery, autosave local/server theo lô, heartbeat, offline state và conflict UI không ghi đè im lặng.
* Mask PNG được kiểm tra kích thước, chuẩn hóa nhị phân và lưu tách khỏi prediction trong `annotation-storage`.
* Drive/local manifest sync, asset proxy, xuất mask + JSONL, Dockerfile và Docker Compose.
* Mã nguồn/build/dependency Vite cũ đã được dọn khỏi thư mục gốc.

Đã chạy thành công TypeScript, ESLint, Next.js production build và API E2E cho các luồng lock, heartbeat, revision conflict, Done, re-edit và hai người dùng. Chưa kiểm thử trực quan tự động vì phiên làm việc không có browser khả dụng; tích hợp Google Drive thật cần credential/dataset thật của môi trường triển khai.

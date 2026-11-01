# Kiểm tra notebook 28 và sửa ZIP — 2026-09-14

Notebook 28 chỉ chạy ảnh đầu tiên của 8964 và 8993. Không có bước xuất prelabel JSON hoặc version riêng trên server. Các hàm xử lý giống baseline được nhúng vào notebook 29. Đã chạy lại notebook 28 và đối chiếu: primitive mask khớp 100% baseline_flesh.png của notebook 29.

| Ảnh | Notebook 28 pixels / vùng | Khác mask cuối notebook 29 |
| --- | --- | --- |
| 8964 | 180766 / 359 | 7084 pixel |
| 8993 | 260330 / 313 | 7892 pixel |

Server hiện dùng NB29: 8964 v4, 8993 v2. Không tự thay bằng NB28 khi chưa có lựa chọn của người dùng.

## Kết quả kiểm tra lỗi

ZIP trước sửa có 10 PNG mask, không có JSON annotation riêng và bỏ Draco_01 (chưa có annotation). Hai PNG NB29 trong ZIP khớp từng pixel với mask notebook gốc.

Vectorizer trong editor trước sửa: thu nhỏ về khoảng 512px, lọc vùng dưới 6 ô, lấy một contour ngoài, simplify biên với dung sai >= 2.5px. Đây là luồng làm mất rãnh mảnh/lỗ/vùng nhỏ. Prelabel V7 cũ cũng không khớp raster nguồn, ví dụ 8769 lệch 112996 pixel và 8884 lệch 166382 pixel, trước chỉnh sửa thủ công.

## Thay đổi

- mask-pixels.ts dùng toàn bộ pixel gốc, liên thông 4 hướng, giữ vùng 1px, giữ holes; chỉ bỏ đỉnh thẳng hàng. Vùng liên thông có cùng nhãn wN.
- Raster hóa tại tâm pixel, không antialias hoặc cộng chồng alpha, dùng chung cho exportMask trong editor, ZIP/Drive và xem version.
- Editor dùng prediction raster làm nguồn polygon cho UNSTARTED/UNTOUCHED/ACCEPTED, giữ nguyên points. Không thay annotation MODIFIED.
- ZIP gồm đủ images/<id>.png, masks/<id>.png, annotations/<id>.json và manifest cho cả 11 ảnh. JSON schema 1.1 có maskOperations, trạng thái/revision/version và points. Nếu bất kỳ asset bị lỗi, trả lỗi rõ thay vì ZIP thiếu file.
- Drive vẫn chỉ được ghi khi người dùng chủ động cập nhật; thêm mask_encoding để lần sync tiếp theo không bỏ qua bản render cũ.
- scripts/rebuild-pixel-prelabels.mjs tạo bộ prelabel chính xác từ backup, không ghi lên server.

Backup mới: F:/ANHTHU/1-HCMUS/0-KLTN/server-backup-20260914-before-zip-fix.
Bộ nguồn đã sửa: F:/ANHTHU/1-HCMUS/0-KLTN/SAM-TMP/prelabels_pixel_exact_20260914.
Báo cáo/ZIP kiểm tra: F:/ANHTHU/1-HCMUS/0-KLTN/SAM-TMP/audit_nb28_zip.

69 test qua, gồm toàn bộ 512 mask 3x3, lỗ, tiếp xúc chéo, rãnh 1px trên ảnh 1200px, kiểm tra giữ nguyên annotation MODIFIED. Round-trip mask thật của cả NB28/NB29: sai khác 0 pixel.

## Xác minh production sau triển khai

Deployment: dpl_GDmwYkFn8fmZh63eeQAZtj1Ves61, trạng thái READY, alias https://bitter-melon-annotation.vercel.app.

Đã tải ZIP thật qua API production và xác minh đủ 11 ảnh PNG, 11 mask PNG và 11 JSON annotation. Mọi JSON raster hóa lại đều khớp mask đi kèm (0 pixel khác biệt); hai mask NB29 tiếp tục khớp mask notebook gốc. Editor của Draco và các annotation UNTOUCHED khớp prediction nguồn.

File tải về đã kiểm tra: SAM-TMP/audit_nb28_zip/ground-truth-fixed.zip.
Không ghi đè annotation thủ công hoặc xóa version trong lần sửa này. Bộ JSON nguồn được tái tạo từ prediction nằm ở SAM-TMP/prelabels_pixel_exact_20260914, chưa được nạp như version mới cho các ảnh đã chỉnh sửa.

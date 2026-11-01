# Dữ liệu Drive gốc và polygon được bảo toàn

## Hệ tọa độ

Ảnh làm việc là byte JPEG gốc trong `drive/prelabel-production/images/`. Notebook 27 áp dụng cho 9 ảnh thường, notebook 29 áp dụng cho 8964 và 8993. Chạy lại detector từ ảnh Drive, vô hiệu hóa bước crop/resize đầu vào của `local_pipeline`; xác nhận `result.rgb` bằng tuyệt đối với ảnh Drive đã decode. SPAM dùng checkpoint thật, tiền xử lý nội bộ theo notebook, đầu ra được xử lý trên hệ tọa độ ảnh Drive. Không sử dụng lại flesh mask từ lần chạy Colab trên ảnh khác.

Script: `SAM-TMP/build_drive_native_dataset.py` tại workspace. Kết quả: `SAM-TMP/drive_native_nb27_nb29_20260914/`. Manifest lưu SHA-256 của ảnh nguồn, notebook, mask và backend SPAM. Một vùng liên thông 4-neighbor có một nhãn wN; không semantic. Contour giữ holes, dùng tọa độ nửa pixel. Cả 11 ảnh có sai khác 0 pixel khi dựng lại mask từ polygon.

## Database và lịch sử

Backup đầy đủ trước thay đổi tại `server-backup-20260914-before-drive-rerun-retry/` trong workspace: 11 annotation, 41 version, 168 blob, checksum kiểm chứng. Lần backup trước đó bị ngắt mạng và không được dùng để import.

`scripts/import-drive-native.mjs` kiểm tra backup, revision, khóa đang hoạt động và SHA-256 ảnh lịch sử. Mỗi ảnh được thêm ba version: giữ nguyên bản trước khôi phục, kết quả notebook chạy lại trên Drive, và bản polygon gốc trên Drive để tiếp tục chỉnh sửa. Không xóa hay sửa 41 version cũ. Bản hiện tại giữ nguyên chuỗi segmentation/breakpoint JSON từ version Drive đã chọn; revision tăng để chặn phiên cũ ghi đè.

ADMIN có thể tiếp tục chỉnh một version trong cửa sổ lịch sử. API kiểm tra quyền trong database, từ chối khi revision đã thay đổi hoặc ảnh đang được mở để sửa; chụp lại bản hiện tại trước khi chuyển. Xem lịch sử mặc định dùng SVG polygon, có chế độ xem pixel riêng.

## Xuất dữ liệu

- `annotations/`: annotation đầy đủ, không dựng lại polygon từ mask.
- `saved/`: nguyên chuỗi JSON trên database; `images/` và `masks/` giữ byte ảnh/raster đã lưu.
- `polygons/<ảnh>/`: JSON, PNG toàn kích thước ảnh và SVG riêng cho từng polygon; `index.json` ánh xạ ID/nhãn. Các polygon chồng lấn vẫn là những file độc lập.
- `boundaries/`, `overlays/`: vector gốc.
- `pixel-audit/<ảnh>/`: mask dựng bổ sung từ vector, bản đồ sai khác và số pixel khác raster đã lưu. Đỏ là pixel có trong vector nhưng thiếu trong raster; xanh là chiều ngược lại. Báo cáo không chỉnh sửa dữ liệu gốc.
- `versions/`: lịch sử trong ZIP của ADMIN. Nút tải riêng một version xuất cả các polygon độc lập của version đó.

## Editor

Không tự ép polygon đang có thành raster hoặc tự vectorize lại khi mở/tải dữ liệu. Chọn tool trên một bộ polygon rỗng do người dùng xóa không tái tạo prediction. Xác nhận giữ nguyên geometry; khôi phục prediction là một thao tác có Undo. Chuyển raster sang polygon chỉ khi người dùng yêu cầu, có kiểm tra round-trip pixel.

Ảnh/mask khác kích thước annotation sẽ bị từ chối tải thay vì kéo giãn. Bản nháp lưu kích thước và URL phiên bản ảnh; không áp dụng bản nháp khác crop. Bản nháp cũ thiếu hệ tọa độ chỉ tiếp tục trực tiếp khi revision server chưa đổi; vẫn cho tải bản nháp về.

Zoom giữ trong ref; cache Path2D/bounds dựa trên polygon bất biến; chỉ vẽ node của polygon được chọn. Nét cọ chạy trong worker, lưu và xuất chờ worker hoàn tất.

## Kiểm tra

79 test tự động đã qua; lint và production build qua. Kiểm tra production bằng `scripts/verify-drive-native.mjs` đối chiếu SHA-256 ảnh, chuỗi JSON lịch sử, geometry trả qua editor API, quyền ADMIN, ZIP dự án và ZIP version NB29. Báo cáo kết quả lưu trong backup khi script hoàn tất.

Chưa kiểm thử chuột/zoom trực tiếp trên trình duyệt: công cụ computer-use không có browser kết nối. Không coi test thuật toán và API là chứng minh FPS hay hành vi chuột trên thiết bị thật.

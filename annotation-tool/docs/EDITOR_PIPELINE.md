# Editor pipeline và hợp đồng chức năng

Merge 2026-11-01: giữ Home theo nhóm/phân công và pipeline lưu/brush/undo v2; thêm công cụ R (hình chữ nhật), C (tròn/oval), A (điểm neo), Ctrl+A chọn toàn bộ, snap/tự nối biên/điền vùng kín từ remote. Polygon mới dùng nhãn `w*`; dữ liệu đã lưu không tự bị đổi khi mở. Các công cụ mới dùng chung lịch sử, revision và đồng bộ raster của local. Xem [MERGE_RECOVERY_20261101.md](MERGE_RECOVERY_20261101.md).

Kiến trúc và backlog: [ARCHITECTURE.md](ARCHITECTURE.md). Bản cập nhật và quy trình bảo toàn dữ liệu ngày 2026-09-14: [DRIVE_NATIVE_20260914.md](DRIVE_NATIVE_20260914.md). Đã deploy Vercel. Tối ưu render 2026-10-25 (đã deploy cùng ngày): [EDITOR_RENDERING.md](EDITOR_RENDERING.md). Thao tác chuột/phím trên canvas được kiểm tra tự động bằng Chrome headless trên trang dữ liệu giả (`scripts/canvas-browser-check.mjs`); chưa kiểm thử tay trên thiết bị thật và dữ liệu thật.

## Pipeline dữ liệu

1. API editor trả ảnh, prediction mask, revision và annotation hiện tại.
2. Trình duyệt tải đồng thời các asset theo URL có phiên bản crop. Annotation đã lưu được đọc nguyên vẹn; không tự vector hóa lại khi mở hoặc tải ZIP.
3. `EditorCanvas` giữ zoom, pan, polygon, node và selection trong `ref`; pointer-move chỉ vẽ lại canvas qua `requestAnimationFrame`. Sáu lớp canvas, mỗi lớp có cờ bẩn riêng (cập nhật 2026-10-25, chi tiết và số đo: [EDITOR_RENDERING.md](EDITOR_RENDERING.md)): `stage` (ảnh gốc, chỉ vẽ lại khi đổi view/kích thước; thu nhỏ thì lấy từ image pyramid), `raster-mask-layer`, `vector-layer` (kéo node chỉ thay dirty rectangle qua back buffer), `draft-layer` (polygon đang vẽ + khung chọn), lớp nét brush và vòng cọ. Polygon bất biến giữ cache Path2D/bounds/LOD; chỉ hiện node của polygon đã chọn (handle vẽ gộp thành 2 path). Lớp tô polygon dùng `fill(Path2D)` có khử răng cưa; raster nhị phân cho export chỉ dựng lại khi cần (`ensureMaskRaster`, chỉ trong hình chữ nhật pixel của polygon).
4. Brush: nét đang kéo vẽ trên overlay screen-space; nhả chuột thì tô đúng vùng bounds của nét lên mask/tint, không render lại toàn ảnh. Worker (tạo một lần) được khởi tạo từ polygon (`INIT_POLYGONS`, cùng quy tắc tâm pixel) hoặc từ raster (`INIT_MASK`, file chỉ có raster), sau đó chỉ nhận vùng thay đổi (`PUT_PATCH`). **Không vector hóa sau mỗi nét** — chỉ khi rời công cụ Brush hoặc vào Select/Polygon. `MaskVectorizer` chỉ dò lại các thành phần chạm vùng bẩn, rồi làm mịn biên (contour nửa pixel → Douglas–Peucker → Chaikin/B-spline); kết quả gửi về dạng typed array (`polygon-pack.ts`). Nút “Làm mịn biên” áp dụng cùng thuật toán cho polygon đã chọn (có undo); annotation đã lưu không tự bị làm mịn.
5. Một thao tác hoàn tất mới tạo history và cập nhật snapshot React trong bộ nhớ. Không có timer theo từng thao tác: draft ghi IndexedDB mỗi 30 giây, khi ẩn trang/đổi tab trình duyệt và trước khi đổi file.
6. Chỉ Lưu, đổi tab bước/file, ẩn trang, xác nhận mask và Hoàn tất mới gửi server; vẽ/hoàn tất polygon không gửi server. Chuyển file chờ lưu thành công rồi nhả khóa; khi conflict giữ draft cho đến khi người dùng tự chọn cách xử lý.
6. Chỉ nút Cập nhật Drive ở Home ghi lên Drive bằng OAuth server. ZIP giữ nguyên chuỗi JSON, nodes/holes, label, metadata, byte ảnh và raster đã lưu; SVG boundary/overlay giữ tọa độ vector. Chỉ render raster bổ sung nếu chưa có raster lưu. ADMIN tải thêm các version cùng crop lịch sử. Tải ZIP không ghi Drive.
7. Tab Mật độ u vấu dùng click tạo point, không phải score. Canvas point editor cũ được tái sử dụng; workspace map sang `segmentation.wartPoints`, không ghi đè `annotation.breakpoints` legacy.
8. File bị khóa vẫn mở được chỉ xem. Backend kiểm tra token/user/TTL/revision cho mỗi lần ghi; UI chặn sửa qua controls, canvas và phím tắt. Các edge case lifecycle/offline cần tiếp tục kiểm thử theo backlog.
9. Phân công theo nhóm (2026-10-25, code editor không đổi): người không phải ADMIN chỉ được bootstrap/xin khóa ảnh thuộc nhóm được giao; ảnh khác trả 403 và editor hiện màn "Không thể mở tệp" sẵn có. Sidebar và Done & Next dùng cùng API danh sách nên chỉ gồm ảnh của các nhóm được giao (mọi nhóm được giao, không riêng nhóm đang làm). Bỏ giao giữa phiên không chặn heartbeat/lưu/Hoàn tất. Xem [GROUPS_AND_IMPORT.md](GROUPS_AND_IMPORT.md).

10. Nút “Nhập JSON polygon / COCO 1.0” (2026-10-25) nhận prelabel `bitter-melon-prelabel-1.1` như cũ hoặc file **COCO 1.0** (`instances_*.json` của CVAT, `coco.json` trong ZIP xuất của tool). Ảnh được chọn theo tên tệp (bỏ đuôi) hoặc `external_key` trùng mã ảnh đang mở, file chỉ có một ảnh thì dùng ảnh đó; kích thước phải khớp. Danh mục tự ánh xạ như màn nhập thư mục (vết gợn → `r*`, u vấu → `w*`, còn lại bỏ qua và báo trong thông báo); polygon/RLE đổi bằng `cocoImagePolygons` (giữ lỗ, giữ `attributes.label`). File không có annotation cho ảnh hoặc chỉ có danh mục bị bỏ qua thì bị từ chối, không xóa canvas. Như mọi lần nhập, kết quả chỉ lên máy chủ khi bấm Lưu. Code: `src/lib/web-import.ts`.

## Hợp đồng vẽ polygon (công cụ P)

Người dùng nhấn mạnh (2026-10-25) giữ nguyên hành vi này; khóa bằng `src/lib/polygon-draft.test.ts` và `scripts/canvas-browser-check.mjs`.

- Mỗi click chấm một điểm; nhấp lên một điểm đã chấm không chấm thêm. **Hoàn tất (người dùng xác nhận 2026-11-06): nhấp đúp lên một điểm đã chấm, Enter, hoặc nút “Hoàn tất polygon”.** Nhấp đơn lên điểm đầu và nhấp đúp ở chỗ trống không còn hoàn tất (nhấp đúp ở chỗ trống chỉ chấm đúng một điểm như nhấp đơn). Thay cho hợp đồng 2026-10-25 “click lại điểm đầu hoặc double-click ở đâu cũng hoàn tất”.
- Đang chấm điểm: **Ctrl+Z gỡ đúng một điểm vừa chấm** mỗi lần; Ctrl+Y/Ctrl+Shift+Z chấm lại; nút Hoàn tác/Làm lại trên thanh công cụ có cùng hiệu ứng và hiện trạng thái “cục bộ”. Chấm điểm mới sau khi undo bỏ nhánh redo.
- Chuột phải lên một điểm của bản nháp xóa điểm đó (hoàn tác được).
- Gỡ hết điểm rồi undo tiếp: rời bản nháp, undo chuyển sang lịch sử chung (ví dụ hoàn tác cả polygon vừa hoàn tất trước đó). Polygon đã hoàn tất được hoàn tác cả vùng bằng một bước.
- Esc hủy bản nháp. Đổi sang công cụ khác ngoài Pan cũng hủy bản nháp; Pan giữ bản nháp.
- “Hoàn tất & Tiếp theo” bị khóa khi đang có điểm nháp (undo cục bộ).

## Auto anchor khi vẽ polygon (Shift) — người dùng xác nhận 2026-11-06 & 2026-11-07

Rule chốt qua hỏi–đáp ngày 2026-11-06 và cập nhật kiến trúc ngày 2026-11-07 (Connected Components & Collective Boundary Envelope):
- **Cơ chế gộp biên bao ngoài tổng quát (2026-11-07)**: Dựa trên các mask có sẵn, gộp lại thành mask chung theo thành phần đồ thị liên thông (kề/chạm nhau thì merge, tách rời thì tuyệt đối KHÔNG merge).
- **Bảo toàn diện tích tuyệt đối**: Diện tích không đổi sau khi merge ({merged} = S(A \cup B) = S_A + S_B - S_{A \cap B}$), không tạo bridge qua khoảng trống.
- **Bảo tồn lỗ rỗng Ring**: Nếu chuỗi mask tạo thành Ring có khoảng trống ở giữa, toàn bộ holeRings được bảo toàn, không auto-fill ruột bên trong, đường bám chỉ chạy trên outerRing.
- **Bảo toàn tính vẹn toàn của mask**: State canvas/mask gốc không bị thay đổi hay gộp ID; phép gộp chỉ là hình học ảo để lấy biên ngoài.

- **Nhấp chuột trái thường**: chấm một điểm bình thường (snap/chèn đỉnh vào biên mask khác như trước), không áp dụng gì thêm, không hoàn tất.
- **Giữ Shift + trỏ vào bên trong mask kế bên** (hoặc sát biên ngoài mask): xem trước (viền xanh lá) đường bám biên chạy **từ điểm vừa chấm** tới **điểm trên biên tự do của mask đó gần con trỏ nhất**. Nhấn/nhả Shift bật/tắt xem trước ngay.
- **Shift + chuột trái**: chèn các điểm của đường đó vào bản nháp (điểm đích thành đỉnh của mask chứa nó). **Không hoàn tất, không chuyển sang V**; vẽ tiếp được, Ctrl+Z gỡ từng điểm. Lần Shift + chuột trái kế tiếp chạy tiếp từ điểm cuối vừa chèn. Không có đường hợp lệ (điểm vừa chấm không nằm trên biên tự do, hoặc con trỏ không ở trong/sát mask nào) thì không chèn gì và báo lý do.
- Đích trỏ gần điểm đầu (trong ngưỡng bắt điểm) và điểm đầu nằm trên biên tự do: đường nối về đúng điểm đầu (khép polygon theo biên), vẫn chưa hoàn tất.
- Rule đường đi (ví dụ mask lân cận A→B→C→D→A, cạnh C→D đã dính mask khác): chỉ đi trên phần biên tự do D→A→B (biên có thể bao polygon mới), loang qua nhiều mask theo biên đó; không đi phần biên đã dính/đè mask khác (≤ 2.5 px ảnh, người dùng giữ ngưỡng này); không đi lại phần biên bản nháp đã nối. Trong hai chiều đi quanh biên tới đích, **chọn đường ngắn nhất** (quyết định của agent: rule không nêu; muốn đi phía kia thì Shift + chuột trái từng chặng). Khi khép về điểm đầu, ưu tiên chiều không bao mask vào trong polygon.
- Điền vùng kín (nhấp vào vùng trống bị bao kín khi chưa có điểm nháp) không đổi.

Thuật toán (`src/lib/polygon-geometry.ts`): `findAutoAnchorPath` = `autoAnchorTarget` (đích dưới con trỏ) + `freeBoundaryRoutes` (Dijkstra trên đồ thị biên tự do, dùng chung với `findMultiPolygonAutofillPath`):

1. **Chỉ đi trên biên tự do.** Cạnh mask bị loại nếu có cạnh của mask khác chạy gần song song sát bên (≤ 2.5 px ảnh, chân đường vuông góc nằm trên cạnh kia) hoặc nằm trong mask khác.
2. **Không đi lại phần biên bản nháp đã nối.** Cạnh chạm bản nháp (≤ 0.5 px) bị loại, trừ tại điểm vừa chấm (và điểm đầu khi khép), nơi chỉ coi là chạm khi hai đoạn chồng lên nhau.
3. **Đi qua chỗ nối giữa các mask.** Đỉnh của các mask khác nhau cách nhau ≤ 2.5 px được gộp thành một nút (mỗi nút tối đa một đỉnh của mỗi mask); cạnh được tách tại đỉnh của mask khác nằm trên nó (chỗ nối chữ T).
4. **Polygon mới luôn ở cùng một phía.** Mỗi đường chỉ đi theo một chiều nhất quán (mask luôn bên trái hoặc luôn bên phải), Dijkstra chạy cho cả hai chiều.
5. Không gộp, không làm mịn mask cũ; điểm chèn là đỉnh thật của mask cũ (tại chỗ chuyển mask giữ đỉnh của cả hai mask).
6. Đồ thị biên cache theo mảng polygon (canvas luôn tạo mảng mới khi đổi, không sửa tại chỗ). Đo bằng Node trên máy dev: ~30 ms dựng cho cảnh 15–20 nghìn đỉnh, mỗi lần rê chuột ~0.2–1 ms.

Khóa bằng `polygon-geometry.test.ts` (describe “findAutoAnchorPath” và “free boundary only”) và các kiểm tra cảnh `?seams=1` trong `scripts/canvas-browser-check.mjs`. Chưa thử trên dữ liệu thật, thiết bị thật hay mask vector hóa có khe hở > 2.5 px.

## Lớp phủ: màu theo label và độ mờ (người dùng xác nhận 2026-11-05)

- Nút **Lớp phủ** (góc trên trái canvas) có thêm thẻ **Độ mờ** khi lớp phủ đang bật; thanh này dùng chung giá trị với thanh “Độ mờ” ở panel phải (lưu `mask-opacity` trong localStorage).
- **Màu theo label là chế độ mặc định và duy nhất** (người dùng xác nhận 2026-11-06; bỏ ô bật/tắt và chế độ một màu của 2026-11-05): mask và viền tô theo màu của label, cùng label cùng màu kể cả hai vùng tách rời (ví dụ hai mask cùng là `r1`), label khác màu khác. Màu chỉ phụ thuộc chuỗi label (`src/lib/label-colors.ts`), ổn định giữa các ảnh, bỏ dải xanh lá để không lẫn vào nền khổ qua. Chỉ hiển thị: không lưu vào annotation, không ảnh hưởng export/ZIP/Drive.
- **Độ mờ áp dụng cả đường biên**: viền của mọi polygon (thường, khóa, đang chọn) đậm nhạt cùng phần tô. Node và tag label của polygon đang chọn luôn rõ để vẫn chỉnh được khi kéo thấp.
- Giới hạn: trong lúc đang tô brush (raster chưa vector hóa) lớp phủ vẫn một màu vì raster không có label; vẽ lại theo label sau khi vector hóa (rời brush). Polygon khóa vẫn tô trắng/viền xám. Bản nháp polygon đang vẽ giữ màu tím.
- Khi đang dùng brush, cả nhóm lớp phủ nằm dưới thanh brush (thanh brush che nút lớp phủ khi vùng canvas hẹp ~700 px). Màn hình ≤ 760 px: tùy chọn thành một hàng gọn cạnh nút.

## Hợp đồng thao tác trong Select

- Chuột trái vào node: chọn và kéo node.
- Kéo chuột trái từ khoảng trống hoặc bắt đầu ngay trên phần fill polygon: marquee chọn các node nằm trong khung; click đơn trên fill vẫn chọn polygon.
- Double-click gần biên: chèn node vào đúng cạnh gần nhất; double-click gần node có sẵn chỉ chọn node đó.
- Chuột phải: chọn toàn bộ node của polygon dưới con trỏ.
- Giữ và kéo chuột phải: di chuyển toàn polygon; `Shift/Ctrl/Cmd` cho phép chọn và kéo nhiều polygon.
- Merge nhận các polygon có node được chọn, cho phép khác label và luôn trả về một outer ring hợp lệ.
- Trong công cụ Select, `1` tạo/gán label u vấu kế tiếp (`w*`) và `2` tạo/gán label vết gợn kế tiếp (`r*`) cho toàn bộ polygon đang chọn.
- Đổi tool không được reset zoom/pan. Chỉ nút “Vừa khung hình” hoặc đổi sang file khác được fit lại.
- Zoom vượt viewport phải hiện scrollbar ngang/dọc; Fit tự ẩn scrollbar. Từ 2026-11-05 (người dùng yêu cầu bật lại) đây là **thanh cuộn tự vẽ** ở mép canvas theo view ảo (`viewRef`), không phải cuộn gốc của trình duyệt (bị bỏ từ 2026-09-11 khi chuyển sang các lớp canvas cỡ màn hình): kéo thumb để cuộn, bấm vào rãnh để nhảy tới đó; phần đã kéo ra ngoài ảnh cũng tính vào chiều dài cuộn.
- Con lăn: zoom; **Shift + con lăn** cuộn ngang; **Ctrl + Shift + con lăn** cuộn dọc (2026-11-05). Ctrl không kèm Shift vẫn là zoom (pinch trên touchpad gửi wheel có ctrlKey).
- **Magnet (người dùng xác nhận 2026-11-05):** trong Select (V), kéo node tới gần (≤ 10 px màn hình) một đỉnh của mask khác thì node dính đúng vào đỉnh đó (vòng xanh chỉ báo); khi kéo nhiều node, cả nhóm dịch cùng một đoạn theo node đang nắm. Không hút vào đỉnh của chính polygon đang kéo. Nút bật/tắt (icon nam châm) nằm dưới nút Lớp phủ ở góc trên trái; mặc định bật, nhớ theo trình duyệt (`select-magnet`). Không áp dụng cho công cụ A (anchor) và kéo cả polygon. Hàm: `nearestMagnetVertex`.
- **Thông báo của editor** hiện trong sidebar phải, thay cho hai đoạn gợi ý cũ (Ctrl+Z… / Di chuột lên điểm…) (người dùng xác nhận 2026-11-05); chưa có thông báo thì ô đó hiện gợi ý ngắn theo công cụ; nút × ẩn thông báo. Toast nổi chỉ còn khi sidebar phải thu gọn, đang ở bước khác, hoặc màn hình ≤ 760 px (sidebar ẩn), để lỗi lưu không bị mất.

## Invariant khi sửa conflict

- Không xóa hoặc thay mapping chuột ở trên nếu không có yêu cầu thay thế rõ ràng.
- Không gọi `fit()` do đổi tool hoặc selection.
- Không ghi server trong pointer-move hoặc theo timer annotation; commit snapshot và lưu server là hai bước khác nhau.
- Không xóa draft IndexedDB khi save lỗi, mất lock hoặc revision conflict.
- Không để client giữ OAuth token Drive; mọi sync/export dùng credential server.
- Không đổi hợp đồng vẽ polygon ở trên (undo từng điểm) khi refactor canvas; chạy `polygon-draft.test.ts` và kịch bản trình duyệt.
- Render: không vẽ lại ảnh gốc cho thay đổi nội dung; không `getImageData` trên lớp hiển thị; raster nhị phân và raster của worker phải đúng từng pixel với `rasterizePolygons`. Danh sách đầy đủ: [EDITOR_RENDERING.md](EDITOR_RENDERING.md) §6.
- Sau khi sửa canvas: chạy `node scripts/canvas-browser-check.mjs http://localhost:3217` trên dev server cô lập (hướng dẫn ở đầu script) ngoài 4 cổng.
- Trước khi deploy phải chạy `npm run typecheck`, `npm test`, `npm run lint` và `npm run build`.

## Đọc prelabel — cập nhật 2026-10-30

Ảnh chưa có annotation mở được cả prelabel schema 1.0 và 1.1, nhãn legacy hoặc instance `rN`/`wN`. Bộ đọc không sửa dữ liệu nguồn. Prelabel sai cấu trúc trả lỗi 422 có thông báo, không thay bằng mask rỗng. Annotation đã lưu không bị tái tạo từ prelabel. Chi tiết: [PRELABEL_COMPATIBILITY.md](PRELABEL_COMPATIBILITY.md).

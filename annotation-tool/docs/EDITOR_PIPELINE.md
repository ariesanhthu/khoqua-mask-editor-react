# Editor pipeline và hợp đồng chức năng

Merge 2026-11-01: giữ Home theo nhóm/phân công và pipeline lưu/brush/undo v2; thêm công cụ R (hình chữ nhật), C (tròn/oval), A (điểm neo), Ctrl+A chọn toàn bộ, snap/tự nối biên/điền vùng kín từ remote. Polygon mới dùng nhãn `w*`; dữ liệu đã lưu không tự bị đổi khi mở. Các công cụ mới dùng chung lịch sử, revision và đồng bộ raster của local. Xem [MERGE_RECOVERY_20261101.md](MERGE_RECOVERY_20261101.md).

Kiến trúc và backlog: [ARCHITECTURE.md](ARCHITECTURE.md). Bản cập nhật và quy trình bảo toàn dữ liệu ngày 2026-09-14: [DRIVE_NATIVE_20260914.md](DRIVE_NATIVE_20260914.md). Đã deploy Vercel. Tối ưu render 2026-10-25 (đã deploy cùng ngày): [EDITOR_RENDERING.md](EDITOR_RENDERING.md). Thao tác chuột/phím trên canvas được kiểm tra tự động bằng Chrome headless trên trang dữ liệu giả (`scripts/canvas-browser-check.mjs`); chưa kiểm thử tay trên thiết bị thật và dữ liệu thật.

## Pipeline dữ liệu

Home (2026-11-16): nút **Tải ảnh hoàn tất** cạnh **Tải ZIP về máy**, mọi vai trò đều dùng được. Server chọn annotation hiện tại `DONE` trong các nhóm có quyền xem, không dựa vào bộ lọc/phân trang Home hoặc version lịch sử. Gói nhẹ có `images/` (nguyên byte ảnh gốc), `coco.json` (RLE độc lập như ZIP hiện có, giữ lỗ/chồng lấn) và `polygons/*.json` (nodes/holes/ID/label/meta nguyên vẹn). Không đọc prediction/raster để tự tạo polygon; ảnh hoàn tất cũ chưa có polygon hiện hành phải báo rõ thay vì xuất annotation rỗng sai. `POLYGON_SET` rỗng đã lưu là hợp lệ. Nút báo tiến trình/lỗi tại Home; không ghi DB/Blob/Drive, không đổi nút ZIP đầy đủ hoặc save/lock.

1. API editor trả ảnh, prediction mask, revision và annotation hiện tại.
2. Trình duyệt tải đồng thời các asset theo URL có phiên bản crop. Annotation đã lưu được đọc nguyên vẹn; không tự vector hóa lại khi mở hoặc tải ZIP.
3. `EditorCanvas` giữ zoom, pan, polygon, node và selection trong `ref`; pointer-move chỉ vẽ lại canvas qua `requestAnimationFrame`. Bốn lớp canvas (từ 2026-11-12; bỏ lớp nét brush và vòng cọ), mỗi lớp có cờ bẩn riêng (chi tiết và số đo: [EDITOR_RENDERING.md](EDITOR_RENDERING.md)): `stage` (ảnh gốc, chỉ vẽ lại khi đổi view/kích thước; thu nhỏ thì lấy từ image pyramid), `raster-mask-layer`, `vector-layer` (kéo node chỉ thay dirty rectangle qua back buffer; gợi ý neo), `draft-layer` (polygon đang vẽ P/Paint + khung chọn + đường tự hoàn thiện). Polygon bất biến giữ cache Path2D/bounds/LOD; chỉ hiện node của polygon đã chọn (handle vẽ gộp thành 2 path). Lớp tô polygon dùng `fill(Path2D)` có khử răng cưa; raster nhị phân cho export chỉ dựng lại khi cần (`ensureMaskRaster`, chỉ trong hình chữ nhật pixel của polygon).
4. Paint (B, từ 2026-11-12): vẽ polygon như P rồi nối (+) / trừ (−) bằng phép boolean polygon (`polygon-paint.ts`); **không tô pixel, không vector hóa** (xem "Hợp đồng Paint" bên dưới). Worker (tạo một lần) chỉ còn chuyển **một lần** mask chỉ có raster (mask dự đoán, "Khôi phục mask ban đầu", annotation cũ lưu bằng nét brush) sang polygon khi vào công cụ polygon/Paint (`INIT_MASK` + `VECTORIZE`): `MaskVectorizer` dò các thành phần rồi làm mịn biên (contour nửa pixel → Douglas–Peucker → Chaikin/B-spline); kết quả gửi về dạng typed array (`polygon-pack.ts`). Nút “Làm mịn biên” áp dụng cùng thuật toán cho polygon đã chọn (có undo); annotation đã lưu không tự bị làm mịn.
5. Một thao tác hoàn tất mới tạo history và cập nhật snapshot React trong bộ nhớ. Không có timer theo từng thao tác: draft ghi IndexedDB mỗi 30 giây, khi ẩn trang/đổi tab trình duyệt và trước khi đổi file.
6. Chỉ Lưu, đổi tab bước/file, ẩn trang, xác nhận mask và Hoàn tất mới gửi server; vẽ/hoàn tất polygon không gửi server. Chuyển file chờ lưu thành công rồi nhả khóa; khi conflict giữ draft cho đến khi người dùng tự chọn cách xử lý.
6. Chỉ nút Cập nhật Drive ở Home ghi lên Drive bằng OAuth server. ZIP giữ nguyên chuỗi JSON, nodes/holes, label, metadata, byte ảnh và raster đã lưu; SVG boundary/overlay giữ tọa độ vector. Chỉ render raster bổ sung nếu chưa có raster lưu. ADMIN tải thêm các version cùng crop lịch sử. Tải ZIP không ghi Drive.
7. Tab Mật độ u vấu dùng click tạo point, không phải score. Canvas point editor cũ được tái sử dụng; workspace map sang `segmentation.wartPoints`, không ghi đè `annotation.breakpoints` legacy.
8. File bị khóa vẫn mở được chỉ xem. Backend kiểm tra token/user/TTL/revision cho mỗi lần ghi; UI chặn sửa qua controls, canvas và phím tắt. Các edge case lifecycle/offline cần tiếp tục kiểm thử theo backlog.
9. Phân công theo nhóm (2026-10-25, code editor không đổi): người không phải ADMIN chỉ được bootstrap/xin khóa ảnh thuộc nhóm được giao; ảnh khác trả 403 và editor hiện màn "Không thể mở tệp" sẵn có. Sidebar và Done & Next dùng cùng API danh sách nên chỉ gồm ảnh của các nhóm được giao (mọi nhóm được giao, không riêng nhóm đang làm). Bỏ giao giữa phiên không chặn heartbeat/lưu/Hoàn tất. Xem [GROUPS_AND_IMPORT.md](GROUPS_AND_IMPORT.md).

10. Nút “Nhập JSON polygon / COCO 1.0” (2026-10-25) nhận prelabel `bitter-melon-prelabel-1.1` như cũ hoặc file **COCO 1.0** (`instances_*.json` của CVAT, `coco.json` trong ZIP xuất của tool). Ảnh được chọn theo tên tệp (bỏ đuôi) hoặc `external_key` trùng mã ảnh đang mở, file chỉ có một ảnh thì dùng ảnh đó; kích thước phải khớp. Danh mục tự ánh xạ như màn nhập thư mục (vết gợn → `r*`, u vấu → `w*`, còn lại bỏ qua và báo trong thông báo); polygon/RLE đổi bằng `cocoImagePolygons` (giữ lỗ, giữ `attributes.label`). File không có annotation cho ảnh hoặc chỉ có danh mục bị bỏ qua thì bị từ chối, không xóa canvas. Như mọi lần nhập, kết quả chỉ lên máy chủ khi bấm Lưu. Code: `src/lib/web-import.ts`.

## Hợp đồng vẽ polygon (công cụ P)

Người dùng nhấn mạnh (2026-10-25) giữ nguyên hành vi này; khóa bằng `src/lib/polygon-draft.test.ts` và `scripts/canvas-browser-check.mjs`.

- Mỗi click chấm một điểm; nhấp lên một điểm đã chấm không chấm thêm. **Hoàn tất (người dùng xác nhận 2026-11-06, mở rộng 2026-11-16, sửa cách nhận biết 2026-11-17): nhấp đúp lên BẤT KỲ điểm đã chấm nào — kể cả điểm vừa vẽ xong — Enter, hoặc nút “Hoàn tất polygon”.** "Nhấp đúp" = hai lần nhấp trúng cùng một điểm trong 500 ms, do `onPointerDown` tự đếm (`draftTouchRef`), KHÔNG dùng sự kiện `dblclick`: chấm điểm rồi nhấp đúp ngay bị trình duyệt gộp thành chuỗi 1-2-3 (dblclick nổ ở cú thứ hai, khi điểm vừa sinh ra) nên dựa vào `dblclick` thì thao tác đó không bao giờ hoàn tất. Cú nhấp tạo điểm không tính là trúng: nhấp đơn lên điểm đầu và nhấp đúp ở chỗ trống không hoàn tất (nhấp đúp ở chỗ trống chỉ chấm đúng một điểm). Tầm trúng điểm bằng tầm neo (14 px màn hình), để điểm bị neo kéo tới biên vẫn trúng khi nhấp lại chỗ cũ. Thay cho hợp đồng 2026-10-25 “click lại điểm đầu hoặc double-click ở đâu cũng hoàn tất”.
- Đang chấm điểm: **Ctrl+Z gỡ đúng một điểm vừa chấm** mỗi lần; Ctrl+Y/Ctrl+Shift+Z chấm lại; nút Hoàn tác/Làm lại trên thanh công cụ có cùng hiệu ứng và hiện trạng thái “cục bộ”. Chấm điểm mới sau khi undo bỏ nhánh redo.
- Chuột phải lên một điểm của bản nháp xóa điểm đó (hoàn tác được).
- Gỡ hết điểm rồi undo tiếp: rời bản nháp, undo chuyển sang lịch sử chung (ví dụ hoàn tác cả polygon vừa hoàn tất trước đó). Polygon đã hoàn tất được hoàn tác cả vùng bằng một bước.
- Esc hủy bản nháp. Đổi sang công cụ khác ngoài Pan cũng hủy bản nháp; Pan giữ bản nháp.
- “Hoàn tất & Tiếp theo” bị khóa khi đang có điểm nháp (undo cục bộ). Nút **Review** cạnh nó (thay “‹ Quay lại” từ 2026-11-25) và tab Review cũng bị khóa trong lúc đó.
- **Tab Review (người dùng yêu cầu 2026-11-25):** panel phải có 2 tab **Vùng chọn · Review**, đổi tại chỗ. Tab Review: canvas chỉ xem, 3 chế độ màu duyệt, kết luận **Đạt & Tiếp theo** (được cả từ Bản nháp khi đang giữ khóa) / **Cần sửa**. Chọn công cụ vẽ (V, P, B, R, C, A) quay về Gán nhãn. Save policy không đổi: sang tab Review lưu phần sửa treo như mọi lần đổi tab. Chi tiết: [REVIEW_AND_ASSIGNMENT.md](REVIEW_AND_ASSIGNMENT.md) §4b.

## Neo và Tự hoàn thiện — người dùng xác nhận 2026-11-12 (thay mục "Auto anchor" 2026-11-06 & 2026-11-07)

Hai khái niệm tách biệt, dùng chung cho P, Paint và kéo điểm trong Select (code: `src/lib/mask-anchor.ts`):

- **Neo (anchor)**: con trỏ hoặc điểm đang kéo tới gần biên mask (≤ 14 px màn hình) thì điểm nối vào đúng điểm đó trên biên. Rất gần một đỉnh (≤ 3 px, hoặc ≤ min(0.35 × dung sai, 4) với đỉnh anchor) thì trùng đỉnh đó; không thì là điểm trên cạnh và mask kia được chèn đỉnh này, nên hai mask chung điểm. Mask khóa không bị chèn đỉnh. Xét cả biên lỗ (mở rộng 2026-11-12; `findSnapTargetToPolygons` cũ chỉ xét vòng ngoài). Hàm: `findAnchorTarget` + `applyAnchor`.
- **Tự hoàn thiện**: từ một điểm đã neo trên biên mask đích, polygon tự tạo các điểm dọc **biên tự do** của mask đích (đỉnh thật của nó) tới điểm neo kế tiếp, để biên khớp thay vì là đoạn thẳng. Không đi qua seam giữa hai mask, không nối qua khoảng trống, không gộp hay sửa mask đích (ngoài việc chèn đỉnh ở điểm neo). Hàm: `findCompletionRoute`; adapter giữ tên cũ `findAutoAnchorPath` (vẽ) và `findMultiPolygonAutofillPath` (chỉ test dùng).

**Khi nào chạy:**

- **P và Paint (vẽ)**: nhấp gần biên thì neo. Tự hoàn thiện bằng Shift, **Shift = chèn điểm, nhấp đúp lên điểm = hoàn tất — hai việc tách bạch (người dùng xác nhận 2026-11-16, thay rule xem-trước-rồi-Shift-nhấp 2026-11-06)**:
  - **Nhấn phím Shift** (một lần, không lặp khi giữ) khi đang vẽ: CHÈN ngay các điểm bám biên tự do từ điểm vừa chấm tới điểm biên gần con trỏ nhất của mask dưới con trỏ vào BẢN NHÁP. Không hoàn tất mask, không đổi công cụ; bản nháp vẫn chỉnh sửa được (Ctrl+Z gỡ từng điểm, chuột phải xóa điểm). Thả Shift giữ nguyên các điểm đã chèn.
  - Nhấn Shift lần nữa tại chỗ không tạo điểm trùng (điểm cuối đã nằm ở đích nên lõi trả NO_ROUTE, im lặng); rê con trỏ sang chỗ khác rồi nhấn Shift chèn tiếp từ điểm cuối. Nhấn Shift mà không có đường thì im lặng giữ bản nháp (không spam thông báo).
  - Giữ Shift và rê tiếp vẫn hiện xem trước (đường xanh lá) cho đoạn kế tiếp; mất tiêu điểm cửa sổ (Alt+Tab) dọn xem trước như thả Shift.
  - Shift + chuột trái chèn như nhấn phím, tại vị trí nhấp (cùng hàm `insertAutoComplete`); điểm đích được neo vào mask chứa nó. Lần kế tiếp chạy tiếp từ điểm cuối vừa chèn.
  - Đích gần điểm đầu (trong ngưỡng bắt điểm) và điểm đầu nằm trên cùng vòng biên: đường khép về đúng điểm đầu, vẫn chưa hoàn tất.
  - Không có đường thì không chèn gì và báo đúng lý do: không có mask dưới con trỏ / điểm vừa chấm chưa neo trên biên tự do / hai mask cách nhau quá 2.5 px / mask đang trỏ không chung vòng biên.
  - Hoàn tất bình thường không tự thêm điểm (khác bản tự động 2026-10-30).
- **Select (V), kéo đúng một node + giữ Shift**: xem mục "Kéo điểm + Shift" bên dưới.
- **Điền vùng kín** (P, nhấp vào vùng trống bị bao kín khi chưa có điểm nháp) không đổi.

**Thuật toán tự hoàn thiện** (sửa 4 lỗi của lõi 2026-11-07, giữ hướng gộp ảo thành biên chung):

1. **Nhóm liên thông**: hai mask liền nhau khi cách nhau ≤ **2.5 px ảnh** (`TOUCH_TOLERANCE`, **không đổi theo zoom**; lõi 2026-11-07 dùng `max(7/zoom, 4)` nên khi thu nhỏ nối qua khe hở tới ~28 px). Chạm = đỉnh cách cạnh ≤ 2.5 px theo cả hai chiều, hoặc hai cạnh cắt nhau, hoặc mask nằm trọn trong mask kia. Mask khác nhóm không bao giờ được nối.
2. **Biên tự do** = các vòng của phép hợp ảo **cả nhóm** (vòng ngoài, khoảng trống bị bao kín, lỗ sẵn có). Lõi cũ chỉ hợp các mask trên chuỗi, nên seam với mask ngoài chuỗi vẫn có thể bị đi.
   - Trên bản sao, đỉnh cách biên mask khác ≤ 2.5 px được kéo lên biên đó để khép khe hở dưới pixel. Seam nội bộ biến mất vì không còn vòng nào đi qua nó.
   - Đỉnh của vòng hợp được thay bằng đỉnh gốc gần nhất (≤ 0.5 px), rồi chèn lại đỉnh gốc nằm trên cạnh (≤ 2 px). Nhờ vậy điểm chèn luôn là đỉnh thật, và chỗ chuyển mask giữ đỉnh của cả hai mask.
   - Mask gốc không đổi.
3. Đi trên **vòng chứa điểm xuất phát** (≤ dung sai): ở ngoài thì vòng ngoài, vẽ trong khoảng trống bị bao kín thì vòng của khoảng trống đó.
4. **Đích** = điểm gần con trỏ nhất trên các cạnh của vòng thuộc **mask dưới con trỏ** (lõi cũ không kiểm), đặt lại đúng lên biên gốc của mask đó.
5. **Chọn chiều**, theo thứ tự ưu tiên (quyết định của agent, giữ được mọi test cũ):
   1. chiều không làm polygon chồng lên mask của nhóm;
   2. cả hai cùng chồng thì chiều chồng ít hơn;
   3. polygon không tự cắt;
   4. gần hình đang dựng hơn (`pathDistanceToDraft`);
   5. ngắn hơn.
6. **Cache** đồ thị chạm, nhóm và vòng hợp theo danh tính mảng polygon (canvas không bao giờ sửa mảng tại chỗ): rê chuột/kéo trên cùng mảng chỉ chiếu điểm và chọn chiều. Đo 2026-11-12 (600 mask, 4× CPU): dựng 188–284 ms một lần, rê 2.9–6.7 ms, kéo 1.7–2.7 ms.
7. `findMultiPolygonAutofillPath` giữ luật chống đi vòng xa (02d5c16): điểm nào của đường cách bản nháp > max(3 × dung sai, 50, 1.5 × kích thước bản nháp) và > 100 px thì bỏ cả đường.
8. **Cửa sổ cục bộ (2026-11-16, sửa "đè Shift bị treo" trên dữ liệu thật)**: trong prelabel thật cả quả khổ qua là MỘT nhóm ~130 mảnh chạm nhau, hợp cả nhóm mỗi lần mảng đổi tốn hàng trăm ms. Lõi chỉ hợp các mask của nhóm giao một cửa sổ quanh điểm xuất phát + con trỏ + hình đang dựng (lề 64 px, làm tròn lưới 128 px để rê chuột trúng cache):
   - cạnh của vòng cục bộ nằm sát (≤ 2.5 px) hoặc trong mask cùng nhóm ở **ngoài** cửa sổ bị **chặn** — trong phép hợp cả nhóm nó là seam, đường không được đi qua;
   - phần chồng đo trên **hợp con** của các mask giao hộp bao ứng viên (cache theo danh sách mask), không cắt cả vòng hợp lớn;
   - kết quả cửa sổ chỉ được nhận khi chắc chắn trùng kết quả cả nhóm (không đi qua cạnh chặn, mọi mask giao hộp bao hai chiều đều đã hợp); không chắc thì nới cửa sổ một lần rồi mới dùng cả nhóm. Cờ `exhaustive` (chỉ test dùng) ép hợp cả nhóm để so sánh.
   - Khóa bằng property test trong `mask-anchor.test.ts`: 100 truy vấn ngẫu nhiên trên dải 40 mask chồng nhau, kết quả cửa sổ phải trùng từng điểm với `exhaustive`; tắt cả hai lớp bảo vệ thì test đổ (hai lớp dự phòng lẫn nhau).
   - `topmostMaskAt` lọc trước theo hộp bao; `maskClipGeometry` (geometry-primitives) sửa mask tự chạm/tự cắt (≈26 % polygon prelabel vector hóa, đo 2026-11-13 trên `drive/prelabel-production`) bằng một lần union luật non-zero để chúng vẫn neo/đi biên được thay vì bị bỏ qua.
   - Đo trên `DC3_01` (133 mask một nhóm, Node): dựng lần đầu ~345 ms (hợp cả nhóm cũ ~780 ms), rê ~5.4 ms/lần, kéo node + Shift ~62 ms/lần (trước đây treo vì vừa hợp cả nhóm vừa cắt với cả vòng hợp mỗi lần rê). Trình duyệt 600 mask, 4× CPU: dựng 167 ms, rê 4.6 ms, kéo 2.2 ms.

Khóa bằng:
- `mask-anchor.test.ts`: 4 test tái hiện lỗi (viết trước khi sửa), test neo, test lý do thất bại;
- các describe cũ trong `polygon-geometry.test.ts` (`findAutoAnchorPath`, "free boundary only", connected component envelope), qua nguyên;
- cảnh `?seams=1` trong `scripts/canvas-browser-check.mjs`.

Chưa thử thao tác tay trên thiết bị thật; số đo dữ liệu thật ở mục 8 chạy bằng Node trên file prelabel, chưa phải phiên gán nhãn thật.

## Kéo điểm + Shift trong Select — người dùng xác nhận 2026-11-12

- Kéo **đúng một** node N của polygon P (không khóa) và giữ Shift; nhấn/nhả giữa chừng thì bật/tắt ngay.
  - N **neo** vào biên mask Q ≠ P đang trỏ tới: sát biên ≤ 14 px màn hình, hoặc con trỏ trong Q thì lấy điểm biên gần nhất.
  - Điểm kề M (trước/sau, chỉ vòng ngoài) nào đã nằm trên cùng vòng biên tự do (≤ 2.5 px) thì cạnh M→N được **tự hoàn thiện** bằng các đỉnh thật của Q, theo cùng lõi và cùng luật chọn chiều như khi vẽ.
  - Không điểm kề nào thỏa thì chỉ neo.
- P mới phải là vòng đơn; không thì lùi về một phía (route ngắn hơn), rồi chỉ neo. Node trong lỗ chỉ neo. Đỉnh neo được chèn vào Q nếu rơi giữa cạnh và Q không khóa.
- Xem trước: đường xanh lá + vòng tại điểm neo; magnet tắt khi đang neo. **Nhả chuột = hoàn tất**, một bước history (Ctrl+Z hoàn tác cả P và đỉnh chèn vào Q).
- Không giữ Shift: kéo thường, magnet như cũ. Shift + bấm để chọn thêm node vẫn như cũ; kéo nhiều node thì Shift không có tác dụng. Công cụ A không đổi.
- Code: `src/lib/node-anchor.ts` (`planNodeAnchorDrag`, hàm thuần); canvas chỉ xem trước `preview` và commit `next`. Khóa bằng `node-anchor.test.ts` và kịch bản "Shift + drag" trong `canvas-browser-check`.

## Gợi ý neo — người dùng yêu cầu 2026-11-12

- **Khi nào hiện**: ở P và Paint (luôn); trong Select chỉ **khi đang kéo node**. Ẩn theo lớp phủ.
- **Hiện gì**: các đỉnh (vòng ngoài và lỗ) của polygon khác trong khung nhìn, dạng chấm rỗng 2 px, nền trắng, viền màu label (mask khóa: xám), để biết đưa chuột tới đâu.
- Không hiện cho polygon đang chọn (đã có handle tím riêng) và polygon quá nhỏ trên màn hình (< 24 px).
- Điểm sắp được neo vẫn hiện vòng chỉ báo xanh trên lớp draft. Cách vẽ và hiệu năng: [EDITOR_RENDERING.md](EDITOR_RENDERING.md) §4.8.

## Hợp đồng Paint (công cụ B) — người dùng xác nhận 2026-11-12

- **Không tô pixel nữa**: Paint vẽ polygon **giống hệt P**, dùng chung bản nháp và code:
  - nhấp chấm điểm (gần biên thì neo);
  - nhấp đúp lên một điểm / Enter / nút "Áp dụng" để áp dụng;
  - Ctrl+Z gỡ từng điểm, chuột phải xóa điểm, Esc hủy, Shift tự hoàn thiện;
  - không có điền vùng kín.

  Áp dụng xong **ở lại Paint**; đổi +/− giữ bản nháp. Đổi sang công cụ khác ngoài Pan thì hủy bản nháp (P và Paint không dùng chung bản nháp của nhau).
- **(+) nối**:
  - Ứng viên: mask không khóa mà polygon chồng lên hoặc chạm (trùng cạnh/trùng điểm, ≤ 2.5 px).
  - Đích: ứng viên đang chọn (nhiều thì chồng nhiều nhất); không có thì mask bị chồng nhiều nhất; chỉ chạm thì mask lớn nhất.
  - Phần chồng lên **các mask khác** (kể cả mask khóa) bị cắt bỏ, nên chúng giữ nguyên, **không dính**.
  - Đỉnh cách biên đích ≤ 2.5 px được kéo lên biên để seam tan. Kết quả giữ id, nhãn, meta, lỗ của đích và id các đỉnh không đổi.
  - Chỉ chạm tại một điểm (ra hai mảnh rời): mảnh mới là polygon riêng **cùng nhãn** (quyết định của agent).
  - Không chạm mask nào: tạo mask mới nhãn `w*` như P. Vẽ lọt hẳn trong mask: báo, không đổi gì.
- **(−) trừ**:
  - Trừ khỏi mọi mask không khóa mà polygon chồng lên. Ở giữa thì thành lỗ.
  - Cắt đôi thì mảnh lớn giữ id, mảnh còn lại là mask riêng cùng nhãn. Trừ hết thì xóa mask.
  - Mask tự chạm/tự cắt (≈26 % polygon prelabel vector hóa) gần vùng vẽ **không còn chặn thao tác**: Paint dùng hình học đã sửa (`maskClipGeometry`). Trước 2026-11-16 chỉ cần một mask như vậy nằm gần là báo "Biên mask … không hợp lệ" và bản nháp không bao giờ áp dụng được (đo: 52 % lần trừ trên dữ liệu thật bị từ chối — đây là lỗi "không hoàn tất được polygon ở chế độ trừ").
  - **Đường cắt 2 điểm = TÁCH mask (spec người dùng 2026-11-16, code `src/lib/mask-cut.ts`)**: bản nháp có ĐÚNG 2 điểm thì áp dụng (nhấp đúp lên điểm / Enter / nút) không trừ diện tích mà chia mask:
    - Hai đầu trên biên (neo sẵn, hoặc lệch trong dung sai thì được đưa về biên): mask thành hai mask độc lập, **không khe hở** — đường cắt là biên chung, mỗi mảnh có đỉnh riêng cùng tọa độ tại hai giao điểm; tổng diện tích giữ nguyên.
    - Đường qua mask lõm cắt biên 4, 6… lần chia thành 3, 4… mask trong một lần.
    - **Chỉ cấp ID mới khi mask thực sự bị chia** (theo cấu trúc liên thông, không theo số đường cắt): đường kết thúc giữa mask không tạo mask/ID mới mà thành **đường chờ** (nét đỏ đứt, giữ trong phiên). Mỗi đường mới được đánh giá cùng toàn bộ đường chờ trên một đồ thị (đỉnh = giao với biên, giao giữa các đường, đầu mút; cạnh = đoạn trong mask): có đường đi nối hai đỉnh biên khác nhau thì tách dọc đường đó, lặp lại; phần đường thừa tiếp tục chờ trên mảnh chứa nó. Esc khi không có bản nháp bỏ các đường chờ.
    - **ID**: mảnh lớn nhất giữ id gốc, các mảnh khác nhận id mới (cơ chế `createId` sẵn có); nhãn/meta giữ nguyên (quyết định của agent theo rule 2026-11-12 "mảnh tách cùng nhãn" — nếu cần nhãn mới cho mảnh tách thì đổi một dòng).
    - Mask đích: mask đang chọn trong số bị cắt; không chọn thì mask mà đường nằm trong nhiều nhất (quyết định của agent — prelabel thật là mosaic chồng mép, báo "nhiều mask" như công cụ cắt sẽ chặn gần như mọi lần). Mask khác giữ nguyên tham chiếu; mask khóa không bị tách.
    - Giới hạn (báo rõ, không làm tạm): đường chờ **không được lưu** (mô hình polygon không biểu diễn được khe rộng 0) và không vào undo; đường cắt chạm **lỗ** của mask bị từ chối (lõi `splitPolygonWithCut` chưa tách qua vòng lỗ; lỗ đi theo mảnh chứa nó khi đường không chạm lỗ).
  - Không chồng mask nào: báo, giữ bản nháp. Lỗi clipping: báo, không đổi gì.
- **Phím** (ở mọi công cụ trong bước Vùng chọn, như B/E): `=` / `+` / B → Paint (+); `-` / E → Paint (−).
- **Icon**: thanh chế độ có icon riêng (`paint-mode-icon.tsx`: đa giác + dấu ＋/−) kèm phím ngay trên nút. Nút Paint trên thanh công cụ đổi icon theo chế độ. Bản nháp (−) màu đỏ.
- **Bỏ chuyển raster → polygon trong Paint** (nguyên nhân mask "dính"): không còn lớp nét brush, cỡ nét, `[`/`]`, vector hóa sau khi tô.
  - Mask chỉ có raster (ảnh không prelabel, "Khôi phục mask ban đầu", annotation cũ lưu bằng nét brush) vẫn được chuyển một lần như cũ khi vào công cụ polygon/Paint.
  - Lưu vẫn như cũ: POLYGON_SET (COCO) + PNG raster xuất từ polygon.
- Code: `src/lib/polygon-paint.ts` (`applyPolygonPaint`, hàm thuần). Khóa bằng `polygon-paint.test.ts` và các kịch bản Paint trong `canvas-browser-check`.

## Lớp phủ: màu theo label và độ mờ (người dùng xác nhận 2026-11-05)

- Nút **Lớp phủ** (góc trên trái canvas) có thêm thẻ **Độ mờ** khi lớp phủ đang bật; thanh này dùng chung giá trị với thanh “Độ mờ” ở panel phải (lưu `mask-opacity` trong localStorage).
- **Màu theo label là chế độ mặc định và duy nhất** (người dùng xác nhận 2026-11-06; bỏ ô bật/tắt và chế độ một màu của 2026-11-05): mask và viền tô theo màu của label, cùng label cùng màu kể cả hai vùng tách rời (ví dụ hai mask cùng là `r1`), label khác màu khác. Màu chỉ phụ thuộc chuỗi label (`src/lib/label-colors.ts`), ổn định giữa các ảnh, bỏ dải xanh lá để không lẫn vào nền khổ qua. Chỉ hiển thị: không lưu vào annotation, không ảnh hưởng export/ZIP/Drive.
- **Độ mờ áp dụng cả đường biên**: viền của mọi polygon (thường, khóa, đang chọn) đậm nhạt cùng phần tô. Node và tag label của polygon đang chọn luôn rõ để vẫn chỉnh được khi kéo thấp.
- Giới hạn: mask chỉ có raster (chưa chuyển sang polygon) hiện một màu vì raster không có label; vẽ lại theo label sau khi chuyển. Polygon khóa vẫn tô trắng/viền xám. Bản nháp polygon đang vẽ giữ màu tím (Paint (−): đỏ).
- Khi đang dùng Paint, cả nhóm lớp phủ nằm dưới thanh chế độ Paint (thanh che nút lớp phủ khi vùng canvas hẹp ~700 px). Màn hình ≤ 760 px: tùy chọn thành một hàng gọn cạnh nút.
- **Trang duyệt (người dùng yêu cầu 2026-11-24):** `EditorCanvas` nhận prop tùy chọn `colorMode` (`'label'` mặc định | `'twoTone'` Xanh – Đỏ | `'warmCool'` Nóng – Lạnh). Hàm màu là `overlayColor` trong `src/lib/review-colors.ts`. Chỉ `r*`/`w*` được tách màu, label khác tô xám. Cùng label vẫn cùng màu. Chỉ hiển thị. Tab **Gán nhãn** của editor truyền `'label'` (chế độ duy nhất khi sửa). Tab **Review** (người dùng yêu cầu 2026-11-25) truyền chế độ đã chọn, kèm `readOnly` + `pan`. Chi tiết và giả định màu: [REVIEW_AND_ASSIGNMENT.md](REVIEW_AND_ASSIGNMENT.md) §4b, §5.

## Hợp đồng thao tác trong Select

- Chuột trái vào node: chọn và kéo node. **Giữ Shift trong lúc kéo đúng một node**: neo vào biên mask đang trỏ + tự hoàn thiện (người dùng xác nhận 2026-11-12, mục "Kéo điểm + Shift" ở trên); trong lúc kéo hiện gợi ý neo.
- Kéo chuột trái từ khoảng trống hoặc bắt đầu ngay trên phần fill polygon: marquee chọn các node nằm trong khung; click đơn trên fill vẫn chọn polygon.
- Double-click gần biên: chèn node vào đúng cạnh gần nhất; double-click gần node có sẵn chỉ chọn node đó.
- Chuột phải: chọn toàn bộ node của polygon dưới con trỏ.
- Giữ và kéo chuột phải: di chuyển toàn polygon; `Shift/Ctrl/Cmd` cho phép chọn và kéo nhiều polygon.
- Merge nhận các polygon có node được chọn, cho phép khác label và luôn trả về một outer ring hợp lệ.
- Trong công cụ Select, `1` tạo/gán label u vấu kế tiếp (`w*`) và `2` tạo/gán label vết gợn kế tiếp (`r*`) cho toàn bộ polygon đang chọn.
- Đổi tool không được reset zoom/pan. Chỉ nút “Vừa khung hình” hoặc đổi sang file khác được fit lại.
- Zoom vượt viewport phải hiện scrollbar ngang/dọc; Fit tự ẩn scrollbar. Từ 2026-11-05 (người dùng yêu cầu bật lại) đây là **thanh cuộn tự vẽ** ở mép canvas theo view ảo (`viewRef`), không phải cuộn gốc của trình duyệt (bị bỏ từ 2026-09-11 khi chuyển sang các lớp canvas cỡ màn hình): kéo thumb để cuộn, bấm vào rãnh để nhảy tới đó; phần đã kéo ra ngoài ảnh cũng tính vào chiều dài cuộn.
- Con lăn: zoom; **Shift + con lăn** cuộn ngang; **Ctrl + Shift + con lăn** cuộn dọc (2026-11-05). Ctrl không kèm Shift vẫn là zoom (pinch trên touchpad gửi wheel có ctrlKey).
- **Magnet (người dùng xác nhận 2026-11-05; phạm vi + độ mạnh sửa 2026-11-16):** trong Select (V), kéo node tới gần (≤ **6 px màn hình**, `MAGNET_RADIUS` — 10 px bị báo "hơi mạnh") một đỉnh của mask khác thì node dính đúng vào đỉnh đó (vòng xanh chỉ báo); khi kéo nhiều node, cả nhóm dịch cùng một đoạn theo node đang nắm. Không hút vào đỉnh của chính polygon đang kéo. Nút bật/tắt (icon nam châm) nằm dưới nút Lớp phủ ở góc trên trái; mặc định bật, nhớ theo trình duyệt (`select-magnet`). **Nút này tắt MỌI hít tự động** (người dùng xác nhận 2026-11-16, vì nút từng chỉ tắt magnet kéo node nên "không tắt được"): tắt magnet thì cả neo khi chấm điểm bằng P/Paint lẫn vòng chỉ báo khi rê cũng tắt — chấm đúng vị trí con trỏ, không chèn đỉnh vào mask khác. Giữ Shift (neo + tự hoàn thiện) và công cụ A (anchor) vẫn hít vì là thao tác chủ động. Không áp dụng cho kéo cả polygon; tắt khi đang neo bằng Shift. Hàm: `nearestMagnetVertex`, cổng chung `autoSnapTarget` trong canvas.
- **Thông báo của editor** hiện trong sidebar phải, thay cho hai đoạn gợi ý cũ (Ctrl+Z… / Di chuột lên điểm…) (người dùng xác nhận 2026-11-05); chưa có thông báo thì ô đó hiện gợi ý ngắn theo công cụ; nút × ẩn thông báo. Toast nổi chỉ còn khi sidebar phải thu gọn, đang ở bước khác, hoặc màn hình ≤ 760 px (sidebar ẩn), để lỗi lưu không bị mất.

## Invariant khi sửa conflict

- Không xóa hoặc thay mapping chuột ở trên nếu không có yêu cầu thay thế rõ ràng.
- Không gọi `fit()` do đổi tool hoặc selection.
- Không ghi server trong pointer-move hoặc theo timer annotation; commit snapshot và lưu server là hai bước khác nhau.
- Không xóa draft IndexedDB khi save lỗi, mất lock hoặc revision conflict.
- Xung đột lưu (người dùng xác nhận 2026-11-07): luôn hiện hai bản (ảnh + mask) để người dùng chọn. “Giữ bản của tôi” chỉ ghi sau khi xin lại được khóa và lưu với `newVersion: true` (bản kia còn trong lịch sử). Không tự chọn thay người dùng.
- Không để client giữ OAuth token Drive; mọi sync/export dùng credential server.
- Không đổi hợp đồng vẽ polygon ở trên (undo từng điểm) khi refactor canvas; chạy `polygon-draft.test.ts` và kịch bản trình duyệt.
- Render: không vẽ lại ảnh gốc cho thay đổi nội dung; không `getImageData` trên lớp hiển thị; raster nhị phân và raster của worker phải đúng từng pixel với `rasterizePolygons`. Danh sách đầy đủ: [EDITOR_RENDERING.md](EDITOR_RENDERING.md) §6.
- Sau khi sửa canvas: chạy `node scripts/canvas-browser-check.mjs http://localhost:3217` trên dev server cô lập (hướng dẫn ở đầu script) ngoài 4 cổng.
- Trước khi deploy phải chạy `npm run typecheck`, `npm test`, `npm run lint` và `npm run build`.

## Đọc prelabel — cập nhật 2026-10-30

Ảnh chưa có annotation mở được cả prelabel schema 1.0 và 1.1, nhãn legacy hoặc instance `rN`/`wN`. Bộ đọc không sửa dữ liệu nguồn. Prelabel sai cấu trúc trả lỗi 422 có thông báo, không thay bằng mask rỗng. Annotation đã lưu không bị tái tạo từ prelabel. Chi tiết: [PRELABEL_COMPATIBILITY.md](PRELABEL_COMPATIBILITY.md).

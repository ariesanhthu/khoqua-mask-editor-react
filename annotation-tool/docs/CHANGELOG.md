# Nhật ký thay đổi và quyết định

Mục mới thêm **lên đầu**. Ghi ngày tuyệt đối. Mỗi mục phân biệt rõ:

- **Người dùng xác nhận:** yêu cầu/quyết định do người dùng nêu hoặc duyệt.
- **Đã kiểm chứng:** lệnh/test thật đã chạy, kèm kết quả.
- **Chưa kiểm chứng:** việc chưa làm hoặc không làm được (ví dụ UI chuột, production, Drive).

Mẫu một mục:

```markdown
## YYYY-MM-DD — Tiêu đề ngắn

- **Thay đổi:** …
- **Kiến trúc/ảnh hưởng:** module, API, schema, dữ liệu cũ bị tác động (hoặc “không”).
- **Người dùng xác nhận:** …
- **Đã kiểm chứng:** `npm run typecheck` / `npm test` (N test) / `npm run lint` / `npm run build` …
- **Chưa kiểm chứng:** …
- **Tài liệu đã cập nhật:** …
```

---

## 2026-11-16 (bổ sung 3) — Sidebar trái: minimap + công cụ hiển thị ảnh (độ sáng, làm rõ biên, đặt lại)

- **Người dùng xác nhận (hỏi–đáp 2026-11-16):**
  - Sidebar trái thêm **minimap**: góc nhìn canvas thu nhỏ, khung đỏ là vùng đang nhìn, **kéo/bấm để pan** canvas chính, thanh trượt chỉnh thu-phóng của riêng minimap.
  - Bỏ chữ "Dự án chú thích / Bộ dữ liệu hiện tại" và nút "Hàng đợi tệp"; **giữ icon folder nhỏ** để quay lại danh sách; list tệp thu gọn.
  - Nút Lớp phủ / Magnet / độ mờ chuyển từ nổi trên canvas vào **dưới minimap**.
  - Thanh chỉnh **độ sáng** + **làm rõ biên (unsharp mask)** + nút **"Đặt lại ảnh gốc"**; chỉ đổi hiển thị, chọn thuật toán không gây lag.
- **Thay đổi:**
  - `editor-canvas.tsx`: props `brightness` (CSS filter GPU trên riêng lớp stage), `edgeStrength` (unsharp mask `ảnh + k×(ảnh − blur 2 px)`, tính MỘT LẦN khi đổi, debounce 200 ms, thay nguồn stage + pyramid), `onViewChange` (gọi trong `renderView`/`fit`), handle `panTo(x, y)`. Đổi file giữ thiết lập (áp lại sau khi ảnh tải).
  - `canvas-minimap.tsx` (mới): hiển thị bằng `<img>` ảnh gốc + khung đỏ, không canvas phụ, không vẽ theo frame.
  - `editor-workspace.tsx`: sidebar mới; `globals.css`: bỏ các rule nút nổi (`.overlay-controls`), thêm khối sidebar; list tệp gọn hơn.
- **Kiến trúc/ảnh hưởng:** không đổi schema/API/lưu/export; mask và PNG xuất ra không bị ảnh hưởng bởi chỉnh hiển thị. Trên màn hình hẹp (media ẩn sidebar) các nút Lớp phủ/Magnet không còn hiện — trước chúng nổi trên canvas; chưa xử lý, báo rõ.
- **Đã kiểm chứng:** 4 cổng xanh (330 test / 34 file; build qua); `canvas-browser-check` **73/73** trên cảnh mới `?photo=1` (ảnh hai nửa xám): độ sáng 60 % làm tối lớp ảnh, đặt lại trả đúng pixel gốc, unsharp overshoot đúng hai phía ranh còn vùng phẳng giữ nguyên, polygon không bị đụng, minimap thu khung khi zoom và bấm minimap pan canvas mà zoom giữ nguyên.
- **Chưa kiểm chứng:** editor thật (đăng nhập + DB), ảnh khổ qua thật (unsharp trên ảnh 12 Mpx ước ~0.5 s mỗi lần chỉnh — một lần, có debounce), mobile.
- **Tài liệu:** EDITOR_RENDERING §3, ARCHITECTURE (bảng file), baseline ENGINEERING_POLICY + `../CLAUDE.md`.

## 2026-11-16 (bổ sung 2) — Nhấp đúp lên BẤT KỲ điểm nào hoàn tất polygon (gỡ kẹt đường cắt 2 điểm)

- **Người dùng xác nhận:** đường cắt 2 điểm "vẫn không hoạt động" vì chỉ hoàn tất được khi nhấp đúp vào điểm chấm từ trước (thực tế là điểm bắt đầu); yêu cầu nhấp đúp vào bất kỳ điểm nào cũng hoàn tất, rồi từ hình đó mới chạy tách/trừ mask.
- **Nguyên nhân:** guard "điểm vừa chấm" theo ngưỡng 600 ms (2026-11-06, để nhấp đúp ở chỗ trống không tự hoàn tất) chặn luôn nhấp đúp lên điểm vừa vẽ xong — với đường cắt 2 điểm thì điểm cuối luôn "vừa vẽ", nên chuột không áp dụng được (chỉ Enter/nút chạy).
- **Thay đổi (`editor-canvas.tsx`):** thay ngưỡng thời gian bằng đếm số lần nhấp trúng lại điểm vừa thêm (`retouches`): cú nhấp đúp ở chỗ trống tự tạo điểm rồi trúng lại đúng một lần → không hoàn tất; nhấp đúp lên điểm có sẵn (kể cả vừa chấm xong) đi qua ≥ 2 lần trúng → hoàn tất. Chấm điểm thứ 2 ở Paint (−) hiện gợi ý cách áp dụng đường cắt. Không thêm module vẽ riêng: bản nháp dùng chung P/Paint giữ nguyên, chỉ rule hoàn tất sai.
- **Đã kiểm chứng:** 4 cổng xanh (330 test / 34 file, build qua); `canvas-browser-check` **65/65** — kiểm đường cắt đổi sang áp dụng bằng nhấp đúp lên chính điểm vừa chấm; "double-click on empty space never finalizes" và "double-click on a point finishes along the free boundary" (điểm chấm từ trước) vẫn qua nguyên.
- **Chưa kiểm chứng:** thao tác tay trên editor thật.
- **Tài liệu:** EDITOR_PIPELINE (Hợp đồng vẽ polygon).

## 2026-11-16 (bổ sung) — Paint (−): đường cắt 2 điểm tách mask

- **Người dùng xác nhận:** trong Paint (−), chấm đúng 2 điểm thành một đường xuyên qua mask (hai điểm trên biên nhờ neo) rồi áp dụng thì mask được TÁCH làm hai tại đường đó, mỗi mảnh nhận thêm điểm tại hai giao với biên.
- **Thay đổi:** `applyPolygonPaint` nhánh `subtract` + 2 điểm → `cutWithLine`, dùng chung lõi công cụ cắt (`resolvePolygonCut`); qua nhiều mask thì ưu tiên mask duy nhất đang chọn, không thì báo chọn. `completePolygon` cho hoàn tất 2 điểm ở Paint (−) (Enter/nhấp đúp/nút). Gợi ý panel ghi rõ.
- **Sửa chung (quyết định của agent):** `splitPolygonWithCut` trước nay làm rơi **lỗ** im lặng (cả ở công cụ cắt): nay lỗ đi theo mảnh chứa nó, đường cắt chạm lỗ thì từ chối với lý do rõ; `resolvePolygonCut` giữ lý do từ chối cụ thể thay vì câu "chưa nhận diện được" chung.
- **Đã kiểm chứng:** 4 cổng xanh — **330 test / 34 file** (7 test đường cắt: xuyên qua, điểm trên biên, lỗ theo mảnh/chạm lỗ từ chối, nhiều mask + selection, không xuyên, mask khóa, chế độ + không cắt); build qua; `canvas-browser-check` **65/65** (thêm 2 kiểm: tách bằng 2 điểm, undo khôi phục).
- **Chưa kiểm chứng:** thao tác tay trên editor thật. Còn mở: render tăng dần cho Paint.
- **Tài liệu:** EDITOR_PIPELINE (Hợp đồng Paint, mục (−)), baseline ENGINEERING_POLICY + `../CLAUDE.md`.

## 2026-11-16 — Nút magnet tắt mọi hít tự động, Shift = chèn điểm (không hoàn tất), tự hoàn thiện chạy được trên dữ liệu thật

- **Người dùng xác nhận:**
  - **Magnet:** nút nam châm từng chỉ tắt magnet khi kéo node nên bị báo "KHÔNG TẮT ĐƯỢC" (chấm điểm bằng P/Paint vẫn hít vào biên). Chốt qua hỏi–đáp: nút tắt **mọi hít tự động** — magnet kéo node + neo khi chấm điểm + vòng chỉ báo khi rê; giữ Shift và công cụ Neo (A) vẫn hít vì là thao tác chủ động. Magnet "hơi mạnh": bán kính 10 → **6 px màn hình** (`MAGNET_RADIUS`).
  - **Shift khi đang vẽ (spec người dùng gửi 2026-11-16):** `Shift = tự hoàn thiện đường viền`, `nhấp đúp lên điểm = hoàn tất` — hai việc độc lập. Nhấn phím Shift CHÈN ngay các điểm bám biên vào bản nháp (trước đây chỉ xem trước, thả Shift là mất nên bị coi là "không hoạt động"); không hoàn tất, không khóa chỉnh sửa; thả Shift giữ điểm; nhấn lại không tạo điểm trùng; nhấp đúp vùng trống không hoàn tất; `blur` dọn xem trước.
  - **Tự hoàn thiện "đè Shift bị treo" trên dữ liệu thật:** sửa bằng cửa sổ cục bộ (xem dưới).
- **Thay đổi:**
  - `editor-canvas.tsx`: cổng chung `autoSnapTarget` (mọi hít tự động đi qua cờ magnet); `MAGNET_RADIUS = 6`; `insertAutoComplete` dùng chung cho Shift + nhấp và **nhấn phím Shift** (keydown chèn, keyup chỉ dọn xem trước, window `blur` dọn xem trước); thất bại khi nhấn phím thì im lặng (`quiet`) để không spam thông báo khi nhấn lại tại chỗ.
  - `src/lib/mask-anchor.ts`: mô hình biên theo **cửa sổ cục bộ** (lề 64 px, lưới 128 px) — chỉ hợp các mask của nhóm giao cửa sổ; cạnh chạm mask nhóm ngoài cửa sổ bị chặn; phần chồng đo trên hợp con cache theo hộp bao ứng viên; kết quả chỉ được nhận khi chắc chắn trùng kết quả cả nhóm, không thì nới một lần rồi dùng cả nhóm; thêm cờ `exhaustive` (chỉ test dùng); `topmostMaskAt` lọc trước theo hộp bao.
  - `src/lib/geometry-primitives.ts`: `maskClipGeometry` — mask tự chạm/tự cắt (≈26 % polygon prelabel vector hóa, đo trên `drive/prelabel-production`, chỉ đọc) được sửa qua một lần union luật non-zero để vẫn neo/đi biên được.
- **Quyết định của agent:** hai lớp bảo vệ cửa sổ (cạnh chặn + kiểm tra mask thiếu theo hộp bao) dự phòng lẫn nhau: tắt một lớp property test vẫn qua, tắt cả hai thì đổ — chấp nhận vì lớp chặn còn là tối ưu hiệu năng lớn (bỏ nó: rê 5.4 → 350 ms/lần do phải đo phần chồng của chiều đi vòng rất dài). Một phiên bản "đo phần chồng với cả nhóm, bỏ lớp chặn" đã thử và bị loại vì số đo này.
- **Kiến trúc/ảnh hưởng:** không đổi schema, API, định dạng lưu. Hành vi Shift-xem-trước 2026-11-06 được thay theo spec mới; các adapter/chữ ký cũ giữ nguyên.
- **Đã kiểm chứng:**
  - 4 cổng: typecheck, lint sạch; **323 test / 34 file** (thêm property test cửa sổ-vs-cả-nhóm 100 truy vấn, dãy 40 mask, mask tự chạm, DISCONNECTED trong cửa sổ); build qua.
  - `canvas-browser-check`: **63/63**, 0 lỗi console (thêm 5 kiểm magnet — dính 3 px, 9 px ngoài tầm, tắt magnet khi kéo và khi chấm P, bật lại chèn đỉnh — và 5 kiểm phím Shift: chèn không hoàn tất, nhấn lại không trùng, nhấp đúp vùng trống không hoàn tất, nhấp đúp điểm tự động hoàn tất 3+3 điểm, undo).
  - Số đo dữ liệu thật (`DC3_01`, 133 mask một nhóm, Node): dựng lần đầu ~345 ms (cũ ~780 ms), rê ~5.4 ms/lần, kéo node + Shift ~62 ms/lần (trước đó treo). Trình duyệt 600 mask 4× CPU: dựng 167 ms, rê 4.6 ms, kéo 2.2 ms.
- **Chưa kiểm chứng:** thao tác tay trên editor thật (đăng nhập + DB), thiết bị thật; số đo dữ liệu thật chạy bằng Node trên file prelabel. Còn mở từ yêu cầu 2026-11-13: render tăng dần cho Paint (`rebuildPolygonTint` vẫn vẽ lại toàn bộ, long task ~114 ms trên 600 mask) và cắt bằng line 2 điểm trong Paint (−).
- **Sự cố trong lúc làm:** dev server webpack cô lập phục vụ bundle cũ sau khi thay cả cây `src` (xóa + copy), làm 5 kiểm trình duyệt fail giả; khởi động lại server sạch thì qua. Ghi bẫy vào AGENT_GUIDE §8.
- **Tài liệu đã cập nhật:** EDITOR_PIPELINE (magnet, Shift, mục 8 cửa sổ cục bộ), AGENT_GUIDE §8, baseline trong ENGINEERING_POLICY và `../CLAUDE.md`.

## 2026-11-13 — Neo + Tự hoàn thiện dùng chung (vẽ và kéo điểm + Shift), Paint thành polygon +/−, bỏ raster trong Paint, gợi ý neo

- **Người dùng xác nhận (hỏi–đáp 2026-11-12):**
  - **Hai khái niệm.** *Neo* (anchor): con trỏ/điểm đang kéo gần biên mask thì nối vào đúng điểm đó. *Tự hoàn thiện*: polygon tự tạo các điểm dọc biên mask đích.
  - **Khi vẽ (P/Paint):** tự hoàn thiện vẫn bằng Shift như rule 2026-11-06.
  - **Select (V), kéo một điểm + Shift:** neo + tự hoàn thiện vào mask đang trỏ; nhả chuột là hoàn tất.
  - **Lõi tự hoàn thiện:** sửa cả 4 lỗi, giữ hướng gộp ảo 2026-11-07.
  - **Paint (icon brush, B):** không tô pixel nữa mà vẽ polygon (chấm điểm như P) để nối (+) vào mask nó chạm/chồng (trùng cạnh, trùng điểm) hoặc trừ (−).
    - Vẫn ở công cụ Paint, không phải chế độ polygon.
    - Chỉ mask nó chạm bị đổi; mask khác không dính.
    - Phím `=`/`-` đổi chế độ ở mọi công cụ, giống B/E.
  - **Bỏ chuyển pixel → polygon trong Paint** (nguyên nhân mask "dính" khi rời Paint). Lưu vẫn như cũ: polygon (COCO) + PNG raster.
  - **Có icon cho chế độ − / =** để biết đang ở chế độ nào.
  - **Gợi ý neo:** hiện điểm của các polygon trong khung nhìn để biết chỗ đưa chuột tới.
- **Kiểm tra lõi tự hoàn thiện (commit `4ec7a7b`):** 4 lỗi, đều được tái hiện bằng test fail trước khi sửa (`mask-anchor.test.ts`).
  1. Ngưỡng "chạm" phụ thuộc zoom (`max(7/scale, 4)`), nên khi thu nhỏ nối qua khe hở tới ~28 px.
  2. Đích không được kiểm tra có nằm trên mask dưới con trỏ.
  3. Chỉ hợp các mask trên chuỗi, nên seam với mask ngoài chuỗi có thể bị đi.
  4. Không có cache.

  Tài liệu còn mô tả `freeBoundaryRoutes` dù hàm đã bị xóa.
- **Thay đổi:**
  - `src/lib/geometry-primitives.ts` (mới): primitive chuyển nguyên văn từ `polygon-geometry.ts` để các module mới dùng chung mà không import vòng; `polygon-geometry` re-export tên cũ.
    - `ringSelfIntersects` dùng lưới cho ring > 64 đỉnh (cùng kết quả, có test so 120 ring ngẫu nhiên).
    - `restoreSourceVertices` gắn lại id và đỉnh gốc thẳng hàng cho kết quả clipping.
  - `src/lib/mask-anchor.ts` (mới):
    - Neo: `findAnchorTarget`/`applyAnchor`, xét cả biên lỗ.
    - Tự hoàn thiện: `findCompletionRoute`, gồm nhóm liên thông 2.5 px cố định, vòng hợp cả nhóm, vòng chứa điểm xuất phát, đích trên mask dưới con trỏ, chọn chiều, cache theo mảng polygon.
    - `findAutoAnchorPath`/`findMultiPolygonAutofillPath` thành adapter giữ chữ ký; thêm `explainAutoAnchorPath` để báo lý do thất bại.
  - `src/lib/node-anchor.ts` (mới): `planNodeAnchorDrag`.
  - `src/lib/polygon-paint.ts` (mới): `applyPolygonPaint`.
  - `editor-canvas.tsx`:
    - P và Paint dùng chung bản nháp (`isDraftTool`); thêm `commitPaintDraft`; nháp (−) màu đỏ.
    - Nhấp gần biên và đích của Shift đều dùng `findAnchorTarget`/`applyAnchor`.
    - Kéo node + Shift qua `updateNodeDrag`, dùng chung cho pointermove và nhấn/nhả Shift.
    - Gợi ý neo trên lớp `vectors` (`addGridDots`, dùng chung với handle).
    - Xóa toàn bộ phần tô pixel: lớp nét/vòng cọ, `commitBrushStroke`, history kiểu `brush`, vector hóa nền, mask bảo vệ pixel khóa, `INIT_POLYGONS`/`PUT_PATCH`.
  - `brush-worker.ts`: chỉ còn `INIT_MASK` + `VECTORIZE`.
  - `editor-workspace.tsx` + `paint-mode-icon.tsx` (mới):
    - Thanh ＋ Nối / − Trừ có icon và phím.
    - Nút Paint đổi icon theo chế độ.
    - Phím `=`/`+`/B, `-`/E; bỏ cỡ nét và `[`/`]`; localStorage `brush-mode` `'erase'` đọc thành `'subtract'`.
    - Gợi ý panel và bảng phím tắt mới.
    - `selectTool('brush')` gọi `beginPolygonEdit`.
  - `globals.css`: bỏ CSS lớp brush và cỡ nét.
- **Quyết định của agent (rule không nêu):**
  - Giữ tool id `brush` và tên `findAutoAnchorPath` để không hỏng localStorage, test, CSS.
  - Neo xét cả biên lỗ.
  - Thứ tự chọn chiều: không chồng mask → chồng ít hơn → không tự cắt → gần bản nháp → ngắn hơn.
  - Paint (+) chỉ chạm một điểm: mảnh mới là polygon riêng cùng nhãn.
  - Paint áp dụng xong ở lại Paint.
  - Kéo nhiều node thì Shift không có tác dụng.
  - Hai lần tối ưu O(n²) → lưới (`ringSelfIntersects`, `restoreSourceVertices`), vì Paint (−) trên mask raster lớn (`?spiky=1`) từng treo 41 s.
- **Kiến trúc/ảnh hưởng:**
  - Không đổi schema, `types/index.ts`, API, định dạng lưu/export.
  - Dữ liệu cũ có `BRUSH_*` vẫn đọc và chuyển một lần như trước.
  - Mask chỉ có raster (ảnh không prelabel, "Khôi phục mask ban đầu") vẫn chuyển một lần khi vào công cụ polygon/Paint.
  - Sơ đồ module: [ARCHITECTURE.md](ARCHITECTURE.md) (yêu cầu 16, 17, bảng file).
- **Test đổi theo hành vi đã xác nhận:**
  - Trong `canvas-browser-check`, bỏ 3 kiểm tra brush: "brush stroke through center vectorizes on Select (… r3 merged → 6)", "undo after brush restores 6 polygons", "many: strokes merge polygons after vectorize". Hai trong số đó khẳng định đúng hành vi mask "dính" mà người dùng yêu cầu bỏ.
  - Thay bằng 13 kiểm tra: Paint +/− (icon, trùng cạnh, mask khác giữ id và số node, nháp đỏ, đổi chế độ giữ nháp, lỗ, cắt đôi, undo), kéo + Shift (neo + tự hoàn thiện, undo, không Shift), gợi ý neo, 600 mask không bị gộp.
  - Mọi test cũ của tự hoàn thiện/autofill trong `polygon-geometry.test.ts` qua nguyên, không sửa test nào.
- **Đã kiểm chứng:**
  - `npm run typecheck` và `npm run lint` sạch.
  - `npm test`: **317 test / 34 file** (từ 280 / 30).
  - `npm run build` qua.
  - `node scripts/canvas-browser-check.mjs`: **55/55** trên dev server cô lập (DB/Blob giả), 0 lỗi console.
  - Số đo (4× CPU):
    - lõi tự hoàn thiện trên 600 mask: dựng lần đầu 188–284 ms, rê 2.9–6.7 ms, kéo 1.7–2.7 ms;
    - Paint → Select: 0 long task (bản brush cũ 223–308 ms);
    - Paint (−) trên mask raster lớn: long task ~1.4–1.6 s.
- **Chưa kiểm chứng:**
  - Thao tác tay trên editor thật (cần đăng nhập + DB), ảnh/mask thật, thiết bị thật, Safari/Firefox.
  - Phím `=`/`-`/B/E nằm trong workspace nên không chạy được trên trang giả.
  - Chưa commit/deploy.
- **Sự cố trong lúc làm:** một script cắt dòng khớp nhầm chú thích đầu tiên và xóa ~2.860 dòng của `editor-canvas.tsx`. File được khôi phục từ `HEAD` (lúc bắt đầu task file không có thay đổi chưa commit) rồi áp lại từng sửa đổi bằng Edit. Đã ghi bẫy này vào AGENT_GUIDE §8.
- **Tài liệu đã cập nhật:**
  - EDITOR_PIPELINE: Neo và Tự hoàn thiện, Kéo điểm + Shift, Gợi ý neo, Hợp đồng Paint, pipeline bước 3–4, lớp phủ, Select.
  - EDITOR_RENDERING: §3, §4.2, §4.5–4.9, §5b, §6–8.
  - ARCHITECTURE: yêu cầu 16–17, bảng file, mục 5.
  - AGENT_GUIDE: impact map, bẫy §8.
  - Baseline trong ENGINEERING_POLICY và `../CLAUDE.md`.

---

## 2026-11-07 — Cùng tài khoản sửa được ở mọi phiên; xung đột lưu hiện hai bản (ảnh + mask) để chọn

- **Bối cảnh (người dùng báo):** editor02 sửa ở localhost rồi mở Vercel cùng Chrome profile vẫn chỉ xem. `/api/health` cho thấy localhost (`.env.local`) và Vercel trùng `fingerprints.database` và `blobStore`, nên bản lưu ở localhost đã vào DB production. Nguyên nhân chỉ xem: token khóa nằm trong `sessionStorage` theo origin, tab localhost còn mở vẫn gửi heartbeat giữ khóa, và server từ chối phiên khác của cùng tài khoản khi thiếu token.
- **Người dùng xác nhận:** “AI CÙNG TÀI KHOẢN ĐỀU CÓ THỂ CHỈNH SỬA (NẾU LÚC LƯU CÓ VERSION TỒN TẠI KHÁC NHAU SHOW 2 VERSION ĐÓ CHO HỌ CHỌN (SHOW HÌNH VÀ MASK)”. Đây là đổi mô hình khóa cũ (“một phiên khác không được thay live lock, kể cả cùng tài khoản”).
- **Thay đổi:**
  - `lock-service.acquireLock`: phiên khác của cùng tài khoản nhận khóa mới. Session cũ đóng với `TAKEN_OVER`, kết quả có `takenOver`; tài khoản khác vẫn `FILE_LOCKED`.
  - `annotation-service.saveDraft` và route `annotation`: thêm tùy chọn `newVersion`, buộc tạo version riêng.
  - Route `editor`: trả thêm `lockedBySelf`.
  - `editor-workspace`:
    - hộp xung đột đặt hai bản cạnh nhau (component mới `version-compare.tsx`, hàm `lib/polygon-svg.ts`), với hai lựa chọn “Dùng bản máy chủ” và “Giữ bản của tôi và lưu”;
    - mất khóa mà không có thay đổi chưa gửi thì chuyển sang chỉ xem, có nút “Sửa tại đây”;
    - hiện thông báo khi vừa nhận khóa từ phiên khác.
  - Dashboard và sidebar: file do chính mình mở ở phiên khác hiện “Sửa tại đây” / “Bạn đang mở ở phiên khác” thay vì “Chỉ xem”.
- **Kiến trúc/ảnh hưởng:** không đổi schema. Type thêm 3 trường tùy chọn (`LockAcquireResponse.takenOver`, `EditorBootstrap.lockedBySelf`, `SaveDraftRequest.newVersion`). Lưu thường vẫn gộp “Bản lưu” liên tiếp của cùng người như trước. Tài khoản khác, phân công nhóm, Done, version ADMIN, import (409 khi đang có khóa) và Drive không đổi.
- **Test đổi theo hành vi đã xác nhận:** trong `lock-service.test.ts`, test “denies … another session of the same account” đổi thành “denies another account”. Thêm test nhận khóa cùng tài khoản: phiên cũ nhận `LOCK_LOST` ở heartbeat, lưu và Done; session `TAKEN_OVER`. Thêm test “giữ bản của tôi”: bản của phiên kia còn trong lịch sử version. Thêm `polygon-svg.test.ts`.
- **Đã kiểm chứng:** `npm run typecheck`, `npm run lint` sạch; `npm test` 276 test / 30 file; `npm run build` qua.
- **Chưa kiểm chứng:**
  - Chưa thao tác thật trên trình duyệt: hộp chọn hai bản, nút “Sửa tại đây”, hai tab cùng tài khoản. Canvas editor không đổi nên không chạy `canvas-browser-check`.
  - Chưa deploy, nên Vercel production vẫn chạy mô hình khóa cũ.
  - Chưa đọc DB production để xác minh vì sao ADMIN không thấy trạng thái đổi: truy vấn chỉ đọc bị chặn, chờ người dùng cho phép.
- **Tài liệu đã cập nhật:** ARCHITECTURE (yêu cầu đã chốt #8, bảng API, Khóa và conflict, Việc còn lại), EDITOR_PIPELINE, AGENT_GUIDE, ENGINEERING_POLICY (baseline), `../CLAUDE.md` (baseline).

## 2026-11-07 — Auto-fill theo Connected Components Envelope & Outermost Boundary, bảo toàn diện tích và cấu trúc Ring

- **Người dùng xác nhận (2026-11-07):**
  1. Thay đổi logic auto-fill: Dựa trên các mask có sẵn, gộp (merge) lại thành mask chung để chỉ có **1 biên bao quanh tổng quát (outermost boundary)**. Sau đó auto-fill bám tới phần biên ngoài cùng của mask chung đó.
  2. Gộp theo logic **thành phần liên thông đồ thị (Connected Components)**: Nếu kề nhau (touching / overlapping) thì merge; nếu tách rời nhau (disconnected) thì tuyệt đối **không được merge** (không bắc cầu qua khoảng trống).
  3. **Bảo toàn tính vẹn toàn của mask**: Quá trình merge chỉ là hình học ảo in-memory để trích xuất biên ngoài; không được merge auto-fill content của mask vào nhau trong state/canvas; các mask gốc giữ nguyên ID, label và đỉnh.
  4. **Bảo toàn diện tích tuyệt đối**: Diện tích trước và sau khi merge phải bằng nhau ($S_{\text{merged}} = S(A \cup B) = S_A + S_B - S_{A \cap B}$). Không thêm bất kỳ diện tích thừa nào (zero area expansion), không tạo dải nối (bridge).
  5. **Bảo tồn lỗ hổng cấu trúc Ring**: Trong trường hợp các mask tạo thành hình Ring (có khoảng trống ở giữa), sau khi merge phải đảm bảo **không auto-fill nội dung bên trong của mask** (giữ nguyên toàn bộ `holeRings`, không xóa lỗ hổng, diện tích lỗ hổng không bị gộp vào mask, và đường bám biên chỉ chạy trên `outerRing`).
- **Thay đổi kỹ thuật:**
  - `src/lib/polygon-geometry.ts`:
    - Thêm `exactUnionPolygons(polygons, gapTolerance)`: Hợp boolean chính xác qua `polygonClipping.union`. Tự động khép khoảng hở subpixel $\le 2\text{px}$ mà không làm phình diện tích, giữ nguyên mảng các `holeRings`.
    - Thêm `getCollectiveBoundaryEnvelope(polygons)`: Trích xuất `outerRing` làm đường bao tổng quát duy nhất, loại bỏ hoàn toàn các seam nội bộ (internal seams) giữa các mask kề nhau.
    - Thêm `enrichPathWithOriginalNodes(pathPoints, sourcePolygons, tolerance)`: Bổ sung các đỉnh gốc của các mask thành phần nằm trên các cạnh của outer boundary để khớp từng khúc uốn lượn ban đầu.
    - Thêm `findTouchingChain(allPolygons, startId, endId, tolerance, draftNodes)`: Tìm chuỗi mask tiếp xúc liên thông qua BFS/Dijkstra, ưu tiên gần draft, loại trừ các mask trung gian mà phần ruột của bản nháp (`draftNodes.slice(1, -1)`) đã đi qua.
    - Thêm `draftProximityToPolygon(polygon, draftNodes)` & cải tiến `findBestSnapTarget(...)`: Chọn mask đích chính xác dựa trên độ gần với phần thân bản nháp khi điểm rơi trên ngã ba/ranh giới chung.
    - Tái cấu trúc `findMultiPolygonAutofillPath` và `findAutoAnchorPath` sang sử dụng Collective Boundary Envelope.
    - Dọn dẹp toàn bộ code dư thừa từ thuật toán đồ thị cũ (0 warnings ESLint).
  - `src/lib/polygon-geometry.test.ts`:
    - Thêm 4 test cases kiểm thử tự động chuyên sâu:
      1. `strictly preserves total area with 0 area expansion when merging touching masks` ($S_{\text{merged}} = 5000 = 2500 + 2500$).
      2. `strictly preserves inner hole in a ring of masks without filling it and does not autofill interior void` (4 mask tạo khung $100\times 100$ có lỗ rỗng $40\times 40$, $S = 8400$, lỗ rỗng giữ nguyên và autofill bám biên ngoài tại $y=0$).
      3. `strictly separates disconnected masks and never merges across empty space` (2 mask cách nhau 100px không bị merge qua khoảng trống).
      4. `dissolves all internal seams between touching masks so boundary envelope has only 1 outer contour` (Seam nội bộ tại $x=50, 100$ biến mất hoàn toàn).
- **Đã kiểm chứng:**
  - `npx eslint src/lib/polygon-geometry.ts`: Clean (0 errors, 0 warnings).
  - `npx vitest run src/lib/polygon-geometry.test.ts`: 93/93 unit tests pass (100%).
- **Tài liệu đã cập nhật:** `CHANGELOG.md`, `EDITOR_PIPELINE.md`.

---

## 2026-11-06 — Auto anchor theo rule đã chốt; màu theo label là chế độ duy nhất

- **Người dùng xác nhận (hỏi–đáp 2026-11-06):** nhấp chuột trái thường chỉ chấm điểm; giữ Shift + trỏ vào *bên trong* mask kế bên để xem trước; Shift + chuột trái chèn các điểm auto bám biên, đường chạy **từ điểm vừa chấm** tới điểm biên gần con trỏ, chỉ trên phần biên tự do (ví dụ A→B→C→D→A, C→D dính mask khác thì chỉ đi D→A→B), loang qua nhiều mask; không tự hoàn tất, không chuyển V; hoàn tất bằng nhấp đúp lên một điểm, Enter hoặc nút (bỏ hoàn tất bằng nhấp đơn điểm đầu và nhấp đúp chỗ trống); ngưỡng dính giữ ≤ 2.5 px ảnh. Lớp phủ: màu theo label là mặc định và duy nhất, bỏ ô bật/tắt.
- **Quyết định của agent (rule không nêu):** khi có hai chiều đi quanh biên tới cùng đích, chọn đường ngắn nhất (khép về điểm đầu thì ưu tiên chiều không bao mask); Shift + chuột trái khi chưa có điểm nào thì chấm điểm đầu như nhấp thường; không có đường hợp lệ thì không chèn gì và báo lý do; mỗi điểm auto là một bước Ctrl+Z.
- **Thay đổi:** `polygon-geometry.ts` — tách lõi Dijkstra thành `freeBoundaryRoutes` (dùng chung), thêm `findAutoAnchorPath`/`autoAnchorTarget`/`AutoAnchorResult`, đồ thị có thêm `polygonSegmentStart`; `findMultiPolygonAutofillPath` giữ hành vi cũ (test cũ qua nguyên). `editor-canvas.tsx` — Shift + chuột trái chèn đường từ điểm vừa chấm; nhấp lên điểm đã chấm không chấm thêm; nhấp đúp chỉ hoàn tất khi trúng điểm có từ trước; bỏ `autoClosedDraftRef`, `lastCompletionRef`, `lastPolygonDownRef` và nhánh nhấp điểm đầu; bỏ prop `colorByLabel`. `editor-workspace.tsx` — bỏ ô “Màu theo label”, cập nhật gợi ý. Trang/kịch bản `canvas-browser-check` cập nhật theo hợp đồng mới.
- **Test đổi theo hành vi đã xác nhận:** “double-click completes with 4 nodes (no duplicate)” thành ba kiểm tra (nhấp đúp chỗ trống chỉ chấm một điểm; nhấp đơn điểm đầu không hoàn tất; nhấp đúp lên điểm có sẵn hoàn tất 4 đỉnh); các kiểm tra cảnh `?seams=1` viết lại theo rule mới; “single colour by default” thay bằng “label colours by default”.
- **Đã kiểm chứng:** `npm run typecheck`, `npm run lint` sạch; `npm test` 271 test / 29 file (+6 `findAutoAnchorPath`); `npm run build` qua; `canvas-browser-check` 45/45 trên dev server cô lập; ảnh chụp xem trước Shift (đường xanh tC → tB → tA từ điểm vừa chấm) và bản nháp vẫn mở sau Shift + click.
- **Chưa kiểm chứng:** editor thật (cần đăng nhập + DB), ảnh/mask thật, thiết bị thật. Thay đổi vẫn chỉ ở nhánh local `dev/debug_anchor`, chưa commit/deploy (production trên `master` vẫn là bản cũ).
- **Tài liệu đã cập nhật:** `EDITOR_PIPELINE.md` (hợp đồng P, mục Auto anchor, Lớp phủ), `ARCHITECTURE.md` (yêu cầu 13, 14), `AGENT_GUIDE.md`, baseline `ENGINEERING_POLICY.md`/`CLAUDE.md`.

## 2026-11-05 — Thông báo trong sidebar phải, magnet trong Select, Ctrl+Shift cuộn, bật lại thanh cuộn

- **Người dùng xác nhận:** chuyển toast vào sidebar phải thay cho đoạn gợi ý Ctrl+Z/Di chuột lên điểm; magnet trong chế độ V (dính vào điểm gần đó) với nút bật/tắt icon nam châm dưới nút lớp phủ; thêm Ctrl+Shift để cuộn; bật lại thanh cuộn.
- **Thay đổi:** `editor-workspace.tsx` — ô `.panel-message` (thông báo + nút ×, mặc định gợi ý theo công cụ), toast nổi chỉ khi sidebar không hiện; nút magnet (`select-magnet`, mặc định bật); icon `magnet`; mẹo sử dụng thêm phím cuộn. `editor-canvas.tsx` — prop `magnet`, hút node đang nắm vào đỉnh gần nhất của mask khác (≤ 10 px màn hình) + vòng chỉ báo trên lớp draft; Ctrl+Shift+wheel cuộn dọc; thanh cuộn tự vẽ (kéo thumb, bấm rãnh) theo `viewRef`. `polygon-geometry.ts` — `nearestMagnetVertex`. CSS tương ứng.
- **Kiến trúc/ảnh hưởng:** không đổi dữ liệu, lưu/khóa/export, `PolygonDraft`. Thanh cuộn không dùng cuộn gốc để giữ kiến trúc lớp canvas cỡ màn hình. Magnet chỉ ở Select khi kéo node (không áp dụng công cụ A, kéo cả polygon).
- **Quyết định của agent:** magnet mặc định bật; ô thông báo hiện gợi ý ngắn khi chưa có thông báo; giữ toast nổi khi sidebar phải bị ẩn/thu gọn hoặc ở bước khác; Ctrl (không Shift) vẫn zoom vì pinch touchpad.
- **Đã kiểm chứng:** typecheck/lint sạch; `npm test` 265 test / 29 file (+4 `nearestMagnetVertex`); build qua; `canvas-browser-check` 43/43 (+6: magnet dính đúng (300,320), tắt magnet không dính, thanh cuộn ẩn sau Fit/hiện khi zoom, Ctrl+Shift+wheel cuộn dọc không zoom, kéo thumb ngang dịch view). Ảnh chụp vòng chỉ báo magnet và thanh cuộn.
- **Chưa kiểm chứng:** ô thông báo và nút magnet trong editor thật (cần đăng nhập + DB); touchpad thật; Safari/Firefox.
- **Ghi chú vận hành:** tắt dev server giữa lúc ghi có thể để lại `.next/dev/types/validator.ts` hỏng làm `typecheck` lỗi; xóa `.next/dev` (file sinh tự động) rồi chạy lại. Một lần `lock-service.test.ts` lỗi khi máy tải nặng, chạy lại riêng và toàn bộ đều qua.
- **Tài liệu đã cập nhật:** `EDITOR_PIPELINE.md`, `EDITOR_RENDERING.md`, `ARCHITECTURE.md` (yêu cầu 15), baseline `ENGINEERING_POLICY.md`/`CLAUDE.md`.

## 2026-11-05 — Shift + chuột trái chỉ nối biên, nhấp đúp mới hoàn tất

- **Người dùng xác nhận (sửa lại hành vi cùng ngày):** Shift + chuột trái thì polygon đang vẽ được nối đường biên tự động vào mask đang có nhưng không kết thúc; chỉ nhấp đúp mới kết thúc.
- **Thay đổi:** `editor-canvas.tsx` — Shift + chuột trái chèn anchor + các đỉnh của đường tự nối vào `PolygonDraft` (mỗi đỉnh một bước undo, giữ hợp đồng Ctrl+Z từng điểm), không gọi hoàn tất. Bản nháp vừa khép theo biên vẽ như đã khép (không có cạnh tới con trỏ). Nhấp đúp sau đó bỏ đỉnh tại vị trí nhấp; lần nhấp thứ hai của nhấp đúp ngay sau khi hoàn tất (< 500 ms, < 8 px) bị bỏ qua. `commitDraft`/`completePolygon` bỏ nhánh tự nối lúc hoàn tất (không còn dùng). Gợi ý trong `editor-workspace.tsx` cập nhật.
- **Kiến trúc/ảnh hưởng:** chỉ `editor-canvas.tsx` (pointer down/double-click/draft preview) và chuỗi gợi ý; `PolygonDraft`, thuật toán `findMultiPolygonAutofillPath`, lưu/khóa/export không đổi.
- **Đã kiểm chứng:** typecheck/lint sạch; `npm test` 261 test / 29 file; build qua; `canvas-browser-check` 37/37 (kiểm tra Shift + click giờ tách thành “nối vào bản nháp, chưa kết thúc” và “nhấp đúp mới hoàn tất, polygon w1 đúng 8 đỉnh”). Thử thêm bằng script tạm: nhấp đúp lên điểm đầu sau Shift + click → 7 mask, w1:8, không còn bản nháp thừa; ảnh chụp bản nháp đã khép theo biên.
- **Chưa kiểm chứng:** editor thật, ảnh thật.
- **Tài liệu đã cập nhật:** `EDITOR_PIPELINE.md`, `ARCHITECTURE.md` (yêu cầu 13), baseline `ENGINEERING_POLICY.md`/`CLAUDE.md`.

## 2026-11-05 — Lớp phủ màu theo label; độ mờ áp dụng cả đường biên

- **Nhánh:** `dev/debug_anchor` (cùng đợt với sửa tự nối biên bên dưới). Chưa commit.
- **Thay đổi:** thêm `src/lib/label-colors.ts` (màu theo chuỗi label: cùng label cùng màu, golden-angle theo số, r*/w* khác hue gốc và độ sáng, bỏ dải xanh lá). `EditorCanvas` nhận prop tùy chọn `colorByLabel` (mặc định `false`): tô mask và viền theo label. Viền vẽ với `globalAlpha = maskOpacity` (node/tag giữ alpha 1); đổi độ mờ/chế độ màu chỉ vẽ lại lớp mask/vector. Workspace: thẻ tùy chọn dưới nút Lớp phủ (checkbox Màu theo label, thanh Độ mờ dùng chung state với thanh ở panel phải), lưu localStorage; khi dùng brush cả nhóm nằm dưới thanh brush; màn hình ≤ 760 px thành một hàng.
- **Kiến trúc/ảnh hưởng:** `editor-canvas.tsx` (render mask/vector, effect hiển thị), `editor-workspace.tsx` (UI lớp phủ), `globals.css`, trang `/canvas-browser-check` (cảnh `?labels=1`, nút điều khiển lớp phủ). Không đổi dữ liệu, type dùng chung, lưu/khóa/export; prop mới là tùy chọn nên chỗ dùng khác giữ hành vi cũ.
- **Người dùng xác nhận:** lớp phủ cho phép mask khác màu theo label, hai mask tách biệt cùng label (r1) cùng màu; thêm thanh kéo độ mờ áp dụng cả đường biên (biên đậm nhạt theo, giữ nguyên là sai).
- **Quyết định của agent (chưa được người dùng duyệt riêng):** màu theo label mặc định tắt; viền dùng đúng độ mờ của thanh (ở mặc định 50% viền nhạt hơn trước); node và tag label luôn rõ; giữ thanh độ mờ cũ ở panel phải; nhóm lớp phủ dời xuống dưới thanh brush khi dùng brush.
- **Đã kiểm chứng:** `npm run typecheck` sạch; `npm run lint` sạch; `npm test` 261 test / 29 file qua (+5 test `label-colors.test.ts`); `npm run build` qua; `canvas-browser-check` 36/36 trên dev server cô lập (+3: một màu mặc định; hai mask r1 tách rời cùng màu, w1 khác; viền ở 20% nhạt hơn hẳn 100%), chạy hai lần. Ảnh chụp trang tĩnh dựng từ CSS thật: thẻ không đè thanh brush ở vùng canvas 700 px và màn hình 375 px.
- **Chưa kiểm chứng:** thẻ lớp phủ trong editor thật, ảnh khổ qua thật, Safari/Firefox.
- **Tài liệu đã cập nhật:** `EDITOR_PIPELINE.md`, `EDITOR_RENDERING.md` §3, `ARCHITECTURE.md` (yêu cầu 14, việc còn lại §7), `AGENT_GUIDE.md`, baseline trong `ENGINEERING_POLICY.md` và `CLAUDE.md`.

## 2026-11-05 — Sửa tự nối biên (auto anchor): chỉ nối theo biên tự do, không gộp mask; Shift để nối

- **Nhánh:** `dev/debug_anchor`, tạo từ `master` sau khi fast-forward local `master` lên `origin/master` (`02d5c16`). Chưa commit.
- **Lỗi:** bắt đầu polygon từ anchor trên mask lân cận thì đường tự nối gộp các mask riêng biệt xung quanh thành một khối (`mergePolygonsIntoSingle` lấp cả vùng trống bị bao quanh) rồi đi vòng ngoài khối; nhấp điểm thứ hai lên mask bất kỳ thì polygon tự kết thúc; hoàn tất polygon còn tự nối biên ngầm.
- **Thay đổi:** `findMultiPolygonAutofillPath` viết lại thành tìm đường ngắn nhất trên đồ thị biên tự do (cạnh chưa có mask khác nối, chưa bị bản nháp nối), mỗi cạnh có chiều giữ mask ở ngoài polygon mới, bỏ đường vòng xa bản nháp. Canvas: nhấp thường lên mask chỉ chấm anchor; Shift + trỏ để xem trước, Shift + chuột trái để hoàn tất theo đường đó; nhấn/nhả Shift cập nhật xem trước; hoàn tất thường khép bằng đoạn thẳng; chỉ chèn đỉnh điểm đầu/cuối vào mask mà điểm thật sự nằm trên biên. Thêm gợi ý thao tác trong `editor-workspace.tsx` (chỉ chuỗi hiển thị).
- **Kiến trúc/ảnh hưởng:** `polygon-geometry.ts` (chỉ canvas gọi hàm này; chữ ký và kiểu trả về giữ nguyên), `editor-canvas.tsx` (pointer down/move polygon, `commitDraft`, `completePolygon(options)`, listener phím Shift), trang `/canvas-browser-check` thêm cảnh `?seams=1`. Không đổi schema, type dùng chung, lưu, khóa, export hay dữ liệu đã lưu; undo từng điểm khi vẽ polygon giữ nguyên.
- **Người dùng xác nhận:** chỉ nối theo biên, không gộp mask; nhấp lên mask khác khi đang vẽ là chấm anchor chứ không phải điểm kết thúc, polygon hoàn tất khi nhấp đúp; Shift + trỏ anchor để xem trước; không đi phần biên đã có mask khác nối; kết thúc bằng Shift + chuột trái.
- **Test đổi theo hành vi đã xác nhận:** test “preserves shared boundary … along seam of touching polygons” (đi dọc đường nối giữa hai mask) đổi thành “does not follow a seam that two existing masks already share”, kỳ vọng `null`.
- **Đã kiểm chứng:** `npm run typecheck` sạch; `npm run lint` sạch; `npm test` 256 test / 28 file qua (thêm 6 test mới, trước đó 250); `npm run build` qua; `node scripts/canvas-browser-check.mjs http://localhost:3217` trên dev server cô lập 33/33 (thêm 4 kiểm tra cảnh `?seams=1`), ảnh chụp xác nhận xem trước khi giữ Shift đi dọc biên dưới các mask phía trên, các mask đó vẫn riêng biệt.
- **Chưa kiểm chứng:** ảnh/mask thật, thiết bị thật, mask vector hóa có khe hở > 2.5 px, mask có lỗ; xem ARCHITECTURE “Việc còn lại” §7.
- **Tài liệu đã cập nhật:** `EDITOR_PIPELINE.md`, `ARCHITECTURE.md` (yêu cầu 13, việc còn lại §7), `AGENT_GUIDE.md` (bản đồ ảnh hưởng), `ENGINEERING_POLICY.md` và `CLAUDE.md` gốc (baseline).

## 2026-11-01 — Xác định sai root Cloudflare và khớp tên Worker Containers

- **Người dùng xác nhận:** root Cloudflare hiện là `/annotation-tool`; yêu cầu sửa deploy, giữ dữ liệu label03.
- **Nguyên nhân:** Wrangler tự migrate OpenNext tại thư mục ứng dụng, sinh self-reference `annotation-tool` trong khi Worker đích là `khoqua`; log build xác nhận lỗi 10143.
- **Sửa:** `cloudflare/wrangler.jsonc` dùng tên `khoqua`; tài liệu ghi root Containers `/cloudflare`, build `npm ci`, deploy `npx wrangler deploy`. Không thêm OpenNext, nâng Next, đổi schema, dữ liệu hoặc secrets.
- **Đã kiểm chứng:** app typecheck/lint/build qua, 248 test / 28 file qua; Cloudflare typecheck và `wrangler deploy --dry-run --containers-rollout=none` qua, nhận container `khoqua-appcontainer` và không có self-reference OpenNext.
- **Chưa kiểm chứng/điểm chặn:** dashboard hiện Workers Free, chưa có runtime secrets; chưa build Docker image hoặc publish Cloudflare. Giữ nguyên tab có secret người dùng nhập chưa lưu; cần người dùng tự nâng gói nếu muốn chạy Containers.
- **Tài liệu:** README gốc/app, `docs/vercel-cicd.md`, `ARCHITECTURE.md`, `CLOUDFLARE_DEPLOY.md`; bổ sung chú thích runtime secrets trong `.env.example` cục bộ (file này đang bị gitignore).

## 2026-11-01 — Sửa CI deploy trùng và ghi nhận kiểm tra production

- **Lỗi đã xác định:** Vercel Git đã deploy thành công, nhưng GitHub job CLI gọi `vercel pull --token=` vì repository không có Vercel secrets, khiến workflow báo đỏ.
- **Sửa:** giữ test/lint/typecheck/build trên GitHub, để Vercel Git integration hiện có quản lý preview/production; bỏ hai job CLI deploy trùng. Không đổi mã ứng dụng, biến môi trường hay dữ liệu.
- **Đã kiểm chứng:** deployment `6312539` READY; kiểm checksum trước/sau ban đầu không mất/đổi 16 annotation, 106 version, 128 ảnh, 11 nhóm, 2 phân công, 1.002 Blob. Kiểm trình duyệt production admin/label03 sau đó 12/12, không gửi request ghi.
- **Thay đổi bên ngoài trong lúc kiểm tra:** nhóm 8582 được giao lại cho editor01 lúc 20:20:35 (UTC+7); giữ phân công mới, không khôi phục bản cũ. Label03 còn nhóm 8964, dữ liệu label trước đó vẫn nằm trong DB.
- **Cloudflare:** log Worker khoqua có self-reference sai tên annotation-tool; đã ghi cách sửa đúng trong CLOUDFLARE_DEPLOY.md. Cấu hình OpenNext gây lỗi không có trong checkout này; đang chờ Root directory/build/deploy command để xác định file thực tế, API cục bộ trả 401 nên chưa sửa hoặc deploy Cloudflare.

## 2026-11-01 — Phát hành lại v2 từ master đã gộp, bảo toàn dữ liệu

- **Người dùng xác nhận:** push master và deploy lại Vercel, giữ dữ liệu label/phân công trước đó.
- **Thay đổi:** khôi phục nguyên 2.960 file dataset nguồn `drive/SAM3_BitterMelon_V7/` từ remote; thư mục này bị bỏ khỏi Git trong commit local `b6fa83d`. Giữ code admin/phân công và editor đã gộp ở `db2e63c`; không đổi mã ứng dụng trong bước phát hành.
- **Bảo toàn dữ liệu:** trước khi push, sao lưu toàn bộ database bằng snapshot chỉ đọc nhất quán, giải nén kiểm SHA-256 và ghi danh mục Blob ngoài repo. Sau deploy đối chiếu mọi annotation/version, file/nhóm/phân công và đối tượng Blob; kiểm UI admin và tài khoản label03 bằng thao tác đọc.
- **Kiểm chứng code:** dùng lại kết quả của đúng mã ứng dụng đã kiểm tra ở mục bên dưới (248 test, typecheck/lint/build, 29 canvas và 12 dashboard). Không chạy seed, import, reset, sync Drive hoặc migration dữ liệu.
- **Chi tiết/báo cáo phát hành:** [MERGE_RECOVERY_20261101.md](MERGE_RECOVERY_20261101.md); bản sao và báo cáo sau deploy nằm trong thư mục `server-backup-20261101-before-v2-redeploy/` ngoài repository.

## 2026-11-01 — Khôi phục admin/phân công v2 và gộp master mới

- **Người dùng yêu cầu:** gộp master local với remote; giữ mọi bản label đã lưu và phân công của `label03`.
- **Thay đổi:** giữ bốn commit local cùng tính năng v2 chưa commit, ghép công cụ editor và hỗ trợ prelabel từ remote. Không reset, nhập lại dữ liệu hoặc deploy production.
- **Đã kiểm chứng dữ liệu:** production có 128 ảnh cùng các phân công cũ; checksum của năm annotation hiện tại do `label03` sửa khớp API editor đang deploy. API nhóm đang deploy trả 404 (code cũ).
- **Đã kiểm chứng code:** 248 test / 28 file; typecheck, lint và build cô lập; 29 kiểm tra canvas, 12 kiểm tra dashboard bằng dữ liệu giả. Chưa hoàn tất profile hover/autofill trên cảnh polygon dày.
- **Chi tiết và bản sao:** [MERGE_RECOVERY_20261101.md](MERGE_RECOVERY_20261101.md).


## 2026-10-30 — Mở prelabel schema 1.0 và 1.1 trên Vercel

- **Người dùng xác nhận:** sửa lỗi 500 khi mở ảnh khác do prelabel khác schema; tạm bỏ qua Cloudflare; không sửa database.
- **Thay đổi:** bộ đọc hỗ trợ schema 1.0/1.1 và nhãn legacy/instance, giữ nguyên dữ liệu nguồn; API editor trả `422 INVALID_ANNOTATION` cho prelabel hỏng thay vì lỗi 500 không có thông báo.
- **Ảnh hưởng:** chỉ parser prelabel và đường tải prelabel trong API editor; không thay database, storage backend, auth, lock, lưu annotation hay renderer.
- **Đã kiểm chứng:** test mới tái hiện lỗi trên code cũ; 25 test parser/API qua sau sửa. `npm run typecheck`, `npm test` (76 test / 7 file), `npm run lint`, `npm run build` đều qua. Đọc 3 prelabel thật (`8769_02`, `8769_03`, `8582_01`) bằng kết nối Postgres `read only` và Blob GET: bộ đọc mới qua, label/toạ độ/metadata giữ nguyên.
- **Chưa kiểm chứng:** thao tác vẽ/lưu/xin khoá trên production; không thực hiện để tránh thay dữ liệu thật.
- **Chi tiết:** [PRELABEL_COMPATIBILITY.md](PRELABEL_COMPATIBILITY.md).


## 2026-10-25 — Crop nền đen 117 ảnh surface, deploy Vercel, kiểm tra đăng nhập production

- **Thay đổi:**
  - `build-surface-dataset.mjs`: `--crop pipeline` (mặc định) cắt nền đen theo `crop_bbox_xyxy` của notebook, không scale, bằng `jpegtran` không nén lại; polygon/prediction dịch đúng số pixel nguyên. `import-surface-dataset.mjs`: thêm `--replace` (đổi asset của ảnh chưa ai đụng, kiểm lại trong transaction).
  - **Dữ liệu production:** 117 ảnh surface dùng bản crop (Blob `datasets/surface-20261024T233503-6d65f3139d8f-crop/`); Blob bản chưa crop giữ lại, không còn tham chiếu. Chi tiết: [SURFACE_IMPORT_20261025.md](SURFACE_IMPORT_20261025.md) §7.
  - **Deploy production** từ working tree (chưa commit): toàn bộ thay đổi 2026-10-25 trong CHANGELOG này (nhóm/phân công/nhập thư mục, R2 code chưa bật, tối ưu render, COCO trong editor, crop). Lần chạy đầu tạo bảng/cột nhóm bằng `initializeSchema` (chỉ thêm).
  - Thêm `.vercelignore` ở gốc repo: deploy từ gốc trước đây tải cả `drive/` (414 MB) và `annotation-tool/artifacts/` (591 MB) nên CLI báo "Upload aborted"; deploy bằng `npx vercel@latest --prod --yes --archive=tgz`.
- **Kiến trúc/ảnh hưởng:** không đổi code app trong bước này. Người không phải ADMIN chỉ thấy nhóm được giao (GROUPS_AND_IMPORT §6); tại thời điểm kiểm tra, ảnh đã được chia nhóm theo giống trên Home (không do agent làm).
- **Người dùng xác nhận (2026-10-25):** giữ kích thước ảnh cùng polygon, không scale, chỉ crop phần đen; deploy Vercel, đăng nhập trên web bằng tài khoản ADMIN trong env và test.
- **Đã kiểm chứng:** build dataset crop (117 ảnh, phần trong ảnh giống từng pixel bản gốc, mọi pixel thịt nằm trong khung); E2E dev server cô lập 117/117 + Chrome headless mở editor. Backup chỉ đọc trước khi thay (`server-backup-20261025-before-surface-crop`). Sau khi thay: 128 hàng, 11 ảnh `_01` giống hệt backup, 351/351 Blob trùng SHA-256. typecheck/lint sạch (test 184/26 và build đã chạy trước bước này, chỉ script/tài liệu đổi sau đó). Deployment `● Ready`, alias https://bitter-melon-annotation.vercel.app. Trên production: `/api/health` đủ cấu hình; đăng nhập ADMIN qua API và qua form thật (Chrome headless, không bấm nút seed) vào được Home, không lỗi console; API editor (GET, không xin khóa) của cả 117 ảnh mới đúng kích thước/số polygon, khi đã warm 1,1–2,4 s cho ảnh nặng nhất (lần gọi đầu sau deploy 51 s); byte ảnh/prediction của 3 ảnh mẫu trùng manifest, thumbnail WebP tạo được.
- **Chưa kiểm chứng:** mở editor (xin khóa, vẽ, lưu) trên production — cố ý không làm để không tạo khóa/bản nháp trên ảnh thật; tài khoản người gán nhãn; thiết bị thật.
- **Tài liệu đã cập nhật:** SURFACE_IMPORT_20261025 §1/§7, trạng thái deploy trong GROUPS_AND_IMPORT, EDITOR_RENDERING, EDITOR_PIPELINE, ARCHITECTURE; `docs/vercel-cicd.md` gốc repo.

## 2026-10-25 — Nhập 117 ảnh surface (COCO 1.0) lên production với polygon ít điểm

- **Thay đổi:**
  - `mask-pixels.ts` thêm `compactPolygon` (contour nửa pixel + Douglas–Peucker, hạ bậc từng ring khi rỗng/cắt nhau/lỗ lọt ngoài, cuối cùng giữ biên chính xác). Chỉ script nhập dùng; editor không đổi.
  - Script mới: `scripts/build-surface-dataset.mjs` (run COCO 1.0 → manifest/ảnh/prediction/prelabel cục bộ, dung sai tự động = ¾ pixel ảnh notebook xử lý, tối thiểu 1 px), `scripts/import-surface-dataset.mjs` (chỉ thêm ảnh mới vào dataset production, cần backup đã kiểm, dry run mặc định).
  - **Dữ liệu production:** thêm 117 ảnh (11 giống, bỏ 11 ảnh `_01` đã gán nhãn) vào dự án "Bitter Melon V7 Prelabel": 16.606 instance `w*`, 2,33 triệu → 0,97 triệu điểm (×0,42). Blob dưới `datasets/surface-20261024T233503-6d65f3139d8f/`. Chi tiết, số liệu và hoàn nguyên: [SURFACE_IMPORT_20261025.md](SURFACE_IMPORT_20261025.md).
- **Kiến trúc/ảnh hưởng:** không đổi API, schema, type, editor, export, save policy, khóa. Production chỉ được **thêm** 117 hàng `dataset_files` + 352 Blob; 11 hàng cũ, annotation, version và manifest nguồn của dự án giữ nguyên (đã đối chiếu với backup).
- **Người dùng xác nhận (2026-10-25):** đưa run `surface-20261024T233503-6d65f3139d8f` lên server, bỏ ảnh `_01` đã gán nhãn, chuyển sang polygon chuẩn website, ít điểm.
- **Giả định của agent (chưa được người dùng xác nhận):** mỗi vùng `flesh` liên thông là một `w<n>` như 11 ảnh `_01`; giữ cả vùng 1–4 pixel; ảnh gốc 3300×1000 không crop; dung sai tự động như trên; chưa chia nhóm theo giống (production chưa có tính năng nhóm).
- **Đã kiểm chứng:** `npm run typecheck` sạch; `npm test` **184 test / 26 file** (+4 test `compactPolygon`); `npm run lint` sạch; `npm run build` thành công (env giả); `canvas-browser-check` 21/21. E2E dev server cô lập: *Đồng bộ nguồn* thêm 117/117, API editor của cả 117 ảnh khớp manifest, Chrome headless mở editor không lỗi console. Backup chỉ đọc trước khi ghi (`F:/ANHTHU/1-HCMUS/0-KLTN/server-backup-20261025-before-surface-import`). Sau khi ghi: 128 hàng, 11 hàng cũ giống hệt backup, 351/351 Blob tải lại trùng SHA-256, fingerprint DB/Blob trùng `/api/health` production.
- **Chưa kiểm chứng:** mở ảnh mới trên site production bằng tài khoản thật; hiệu năng ảnh ~35 nghìn điểm trên máy thật; thumbnail lần đầu trên Vercel. Chưa commit, không deploy code.
- **Tài liệu đã cập nhật:** SURFACE_IMPORT_20261025 (mới), README (docs), AGENT_GUIDE (bản đồ ảnh hưởng), ARCHITECTURE (bản đồ code), ENGINEERING_POLICY và `CLAUDE.md` gốc (baseline).

## 2026-10-25 — Tối ưu render editor (paint, chỉnh segment, zoom, tải ảnh, chuyển brush ↔ polygon) và nhập COCO 1.0 trong editor

- **Thay đổi:**
  - Canvas (`editor-canvas.tsx`): cờ bẩn theo từng lớp; ảnh gốc chỉ vẽ lại khi đổi view/kích thước; thêm lớp `draft-layer` cho polygon đang vẽ + khung chọn; image pyramid cho ảnh ≥ 1024 px khi thu nhỏ; `image.decode()` trước khung đầu; tỉ lệ pixel tối đa 1.5×, 1× khi `deviceMemory` < 4 GB; kéo node chỉ thay dirty rectangle của lớp vector qua back buffer; khôi phục vùng polygon khóa bỏ qua khi không có polygon khóa; raster nhị phân dựng trong hình chữ nhật pixel của polygon, ghi thẳng từng đoạn quét; dựng raster khi vào Brush chạy lúc rảnh; file `POLYGON_SET` không tải/chuẩn hóa mask đã lưu; mask dự đoán chuẩn hóa lười khi Khôi phục/Giữ mask gợi ý.
  - Worker (`brush-worker.ts`): thêm `INIT_POLYGONS` (worker tự rasterize từ polygon), kết quả vector gửi dạng typed array (`polygon-pack.ts`, mới).
  - Module mới: `polygon-draft.ts` (lịch sử điểm polygon đang vẽ, tách nguyên hành vi cũ), `vector-identity.ts` (bounds cache không cấp phát + gán id theo IoU dùng lưới, kết quả như quét O(n²)), `polygon-pack.ts`. `mask-pixels.ts` thêm `forEachPolygonSpan` (lõi quét dòng, `rasterizePolygons` dùng lại), `polygonPixelRect`, `normalizeMaskRgba`; `simplifyRing` (chỉ dùng cho LOD hiển thị) thêm bước radial-distance. `canvas-view.ts` thêm `renderPixelRatio`, `photoPyramidSizes`, `photoLevelFor`.
  - Nhập JSON trong editor (`web-import.ts`, nút đổi tên “Nhập JSON polygon / COCO 1.0”): nhận thêm COCO 1.0 cho ảnh đang mở (chọn ảnh theo tên/`external_key`, ánh xạ danh mục tự động, polygon + RLE qua `cocoImagePolygons`); thông báo nêu số annotation bị bỏ qua.
  - Trang `/canvas-browser-check` (dữ liệu giả) thêm cảnh `?many=1` (600 polygon), hiển thị trạng thái undo/selection; thêm `scripts/canvas-browser-check.mjs` (Chrome headless qua DevTools Protocol, không dependency mới).
  - Sửa lỗi: file có `POLYGON_SET` rỗng giữ raster dự đoán/đã lưu trong bộ nhớ dù không hiển thị, nên nét brush đầu tiên làm vùng dự đoán xuất hiện lại. Nay raster luôn khớp polygon.
- **Kiến trúc/ảnh hưởng:** Không đổi API, schema, type dùng chung, định dạng lưu/export, save policy, khóa, mapping chuột/phím. `rasterizePolygons` (dùng ở export, version route, dataset import, script) giữ đúng từng pixel: test so với bản sao nguyên văn của thuật toán cũ trên polygon ngẫu nhiên (lỗ, chồng lấn, tọa độ lẻ, ngoài ảnh). JSON polygon từ worker giống từng byte trước/sau (test). Raster worker khởi tạo từ polygon cho cùng kết quả vector hóa (510 thành phần trên cùng chuỗi nét, trước và sau). Undo/redo, hợp đồng vẽ polygon và Select không đổi.
- **Người dùng xác nhận (2026-10-25):** refactor, cập nhật đầy đủ comment/docs/rule; tối ưu cho thiết bị; bổ sung định dạng COCO 1.0; paint và chỉnh segment không lag; tìm hiểu thuật toán tối ưu render khi zoom, vẽ segment, tải, chuyển paint ↔ polygon; **không phá vỡ tính năng hiện có**, đặc biệt undo từng điểm khi đang vẽ polygon.
- **Giả định của agent (chưa được người dùng xác nhận):** “bổ sung COCO 1.0” được hiểu là cho nút nhập JSON trong editor nhận COCO 1.0 (nhập thư mục COCO ở Home đã có; export không đổi); ánh xạ danh mục tự động, không có hộp thoại; máy < 4 GB vẽ lớp canvas ở 1×; sửa lỗi `POLYGON_SET` rỗng ở trên.
- **Đã kiểm chứng:** `npm run typecheck` sạch; `npm test` 180 test / 26 file qua (158 → 180, chạy lại 2 lần ổn định); `npm run lint` sạch; `npm run build` thành công (env DB/Blob giả). `node scripts/canvas-browser-check.mjs` trên dev server cô lập: 21/21 (undo/redo từng điểm, nút Hoàn tác/Làm lại, double-click, chuột phải, Esc, brush → vector hóa, undo brush, export PNG, zoom, kéo node, dirty rectangle trùng pixel với vẽ toàn bộ trên ảnh chụp ghép lớp). Số đo 4× CPU (chi tiết [EDITOR_RENDERING.md](EDITOR_RENDERING.md) §5): brush → select long task ~800 → ~250 ms; 3 nét brush đầu 111–176 → 0 ms; kéo node p95 khung 50 → 17 ms; mở file polygon bỏ ~500 ms chuẩn hóa mask (CPU profile). Script Node strip-types vẫn import được `mask-pixels.ts`.
- **Chưa kiểm chứng:** thiết bị thật (điện thoại/tablet/laptop yếu), ảnh thật 12 MP ~1600 polygon, Safari/Firefox, production build, mất GPU context thật; workspace (lưu, khóa, đổi file/tab) trên trình duyệt; nhập file COCO thật từ CVAT bằng nút trong editor. Chưa commit, chưa deploy.
- **Tài liệu đã cập nhật:** EDITOR_RENDERING (mới), EDITOR_PIPELINE (pipeline, hợp đồng vẽ polygon, COCO trong editor, invariant), ARCHITECTURE (yêu cầu 12, bản đồ code, việc còn lại), AGENT_GUIDE (bản đồ ảnh hưởng, bẫy đã biết), ENGINEERING_POLICY (baseline, E2E canvas), GROUPS_AND_IMPORT, README (docs), `CLAUDE.md` gốc repo.

## 2026-10-25 — Nhóm ảnh, phân công theo nhóm, nhập thư mục (mặc định / COCO 1.0), Home theo nhóm

- **Thay đổi:** Schema thêm `file_groups`, `group_assignments`, cột `dataset_files.group_id`. Module mới `file-groups.ts`, `coco-import.ts`, `import-plan.ts` (chạy ở trình duyệt), `access-service.ts`, `group-service.ts`, `dataset-import-service.ts`; route mới `GET /api/projects/:id/groups`, `PUT …/groups/:groupId/assignees`, `POST …/groups/auto`, `POST /api/projects/:id/import`. Route sửa: `GET /api/projects` và `GET …/files` lọc theo phân công (thêm `groupId`, `annotationState` nhiều giá trị, trường `group`); `GET /api/files/:id/editor` và `POST …/lock` trả 403 cho ảnh ngoài nhóm được giao; `POST /api/projects` kiểm ADMIN từ DB và nhận `source: 'upload'`. `prelabel-service` tách `parsePrelabelOperations` (hành vi `loadPrelabelOperations` giữ nguyên); `object-store` thêm `datasetObjectReference`. Home (`dashboard.tsx`) trình bày lại: thanh dự án + tiến độ, thẻ nhóm → danh sách ảnh theo nhóm (lọc có đếm, tìm, Làm ảnh tiếp theo), ADMIN có tab Nhập dữ liệu/Quản trị, hộp thoại Phân công, thẻ Chưa phân nhóm + Tự động chia nhóm. Thêm `group-assign-dialog.tsx`, `dataset-import.tsx`, CSS mới cuối `globals.css` (chỉ thêm, dùng token sẵn có).
- **Kiến trúc/ảnh hưởng:** Schema chỉ thêm, idempotent; vân tay schema đổi nên lần khởi động đầu chạy lại các lệnh DDL. Type chỉ thêm (`FileListItem.group?`, `FileGroupSummary`, `FileGroupList`, `UserSummary`, `DatasetImportResult`, `ErrorCode` + `INVALID_DATASET`). Editor không sửa dòng nào, nhưng sidebar/Done & Next nhận danh sách đã lọc và ảnh ngoài nhóm hiện "Không thể mở tệp". Heartbeat/lưu/Hoàn tất/mask, export ZIP/Drive, version, asset route không đổi. **Dữ liệu production có sẵn chưa có nhóm**: sau khi deploy, người gán nhãn không thấy ảnh cho tới khi ADMIN bấm Tự động chia nhóm và Phân công (không có migration tự động).
- **Người dùng xác nhận (2026-10-25):** trình bày lại UX trang chính, giữ design, không sửa trang editor; admin giao việc cho người dùng, người dùng chỉ thấy việc được giao; giao theo nhóm, tải cả thư mục thì mỗi thư mục con (mỗi giống) thành một nhóm; người gán nhãn xem theo nhóm, bấm nhóm thấy danh sách ảnh; tải lên hỗ trợ COCO 1.0, định dạng có sẵn giữ làm mặc định và không bị xóa.
- **Giả định của agent (chưa được người dùng xác nhận):** REVIEWER như ANNOTATOR; một nhóm giao được nhiều người; Cập nhật Drive/Tải ZIP giữ phạm vi cả dự án; từ chối JPEG có EXIF xoay; nhóm = thư mục đầu tiên không phải thư mục cấu trúc (`images`, `annotations`, `predictions`, `prelabels`, `masks`, `default`…), có tùy chọn chia theo tiền tố tên ảnh; gợi ý ánh xạ danh mục COCO theo tên (admin sửa được).
- **Test cũ bị chạm (không đổi assertion):** `editor-prediction.test.ts` thêm `can_access: true` vào dòng DB giả lập vì truy vấn bootstrap có cột mới, và thêm test 403. `api-client.test.ts` đặt timeout 20s riêng cho test gzip ~10 MB: đo được 3.3–3.7s/5s ngay cả ở baseline khi cả bộ chạy song song, thêm file test PGlite là vượt ngưỡng.
- **Đã kiểm chứng:** `npm run typecheck` sạch; `npm test` 158 test / 23 file qua (113 → 158), chạy lại 2 lần ổn định; `npm run lint` 0 vấn đề; `npm run build` thành công. E2E HTTP trên dev server cô lập (PGlite + storage trong thư mục tạm, `/api/health` báo không có DB/Blob thật): 29/29 kiểm tra qua — nhập COCO (polygon + RLE) → mask gợi ý đúng pixel, quyền theo nhóm (dự án/nhóm/ảnh, 403 khóa/editor, 409 nhập lại khi đang sửa, không phải ADMIN không nhập được), nhập định dạng mặc định với 11 ảnh V7 thật từ `drive/prelabel-production` (chỉ đọc) theo tên ảnh thành 11 nhóm, polygon và byte PNG giữ nguyên; Home render, 16 chunk client tải được. Đã dừng server, xóa 1 thumbnail cache do lần thử tạo trong `annotation-storage/thumbnails`.
- **Chưa kiểm chứng:** tương tác trên trình duyệt (không có trình duyệt trong phiên): chọn thư mục, xem trước, ánh xạ danh mục, hộp thoại phân công, bộ lọc, quay về nhóm từ editor, giao diện mobile; ghi lên Vercel Blob/R2 thật; giới hạn 4.5 MB/request trên Vercel; file COCO rất lớn; dữ liệu production. Chưa commit/deploy.
- **Tài liệu đã cập nhật:** GROUPS_AND_IMPORT (mới), ARCHITECTURE, EDITOR_PIPELINE, AGENT_GUIDE, ENGINEERING_POLICY (baseline), README (docs + app), `CLAUDE.md` gốc repo.

## 2026-10-25 — Lớp lưu trữ đối tượng, hỗ trợ Cloudflare R2 (chưa bật)

- **Thay đổi:** Thêm `src/lib/object-store.ts` (+ test) với backend `r2` / `blob` / `filesystem`; `storage.ts` và `drive-service.ts` (đọc `blob:`) gọi qua lớp này; `/api/health` nhận biết R2; thêm dependency `aws4fetch` (ký SigV4, nhỏ, không kéo AWS SDK); thêm `scripts/migrate-blob-to-r2.mjs` (mặc định dry-run); `.env.example` thêm `STORAGE_BACKEND`, `R2_*`; tài liệu [CLOUDFLARE_R2_STORAGE.md](CLOUDFLARE_R2_STORAGE.md).
- **Kiến trúc/ảnh hưởng:** Mặc định không đổi hành vi (không đặt `STORAGE_BACKEND` ⇒ như cũ), nên Vercel không đổi cho đến khi bạn đặt biến. Định dạng `maskStorageKey` và `blob:` giữ nguyên. Một khác biệt có chủ đích: tham chiếu `blob:` của dataset luôn đọc từ Blob/R2, không còn phụ thuộc cách `getBlob` được gọi trực tiếp. Script thao tác dữ liệu vẫn dùng Blob.
- **Người dùng xác nhận (2026-10-25):** tạm giữ Vercel để chạy app, chuyển nơi lưu file sang Cloudflare R2. Phương án chạy cả app trên Cloudflare Containers tạm dừng.
- **Đã kiểm chứng:** `npm run typecheck` sạch; `npm test` 113 test / 18 file qua (98 → 113, thêm 15 của `object-store.test.ts`); `npm run lint` sạch; `npm run build` thành công.
- **Chưa kiểm chứng:** mọi thao tác với R2 thật — R2 chưa bật (API báo cần bật trong dashboard; endpoint S3 lỗi bắt tay TLS). `migrate-blob-to-r2.mjs` chưa chạy. Chưa đo độ trễ; chưa kiểm thử UI.
- **Tài liệu đã cập nhật:** CLOUDFLARE_R2_STORAGE, README (annotation-tool), `.env.example`, ARCHITECTURE, AGENT_GUIDE, ENGINEERING_POLICY (baseline), README (docs).

## 2026-10-25 — Chuẩn bị chạy trên Cloudflare Containers (chưa deploy)

- **Thay đổi:** Thêm `cloudflare/` (Worker `AppContainer`, `wrangler.jsonc`, package riêng), `annotation-tool/Dockerfile`, `.dockerignore`; `next.config.ts` bật `output: 'standalone'` chỉ khi `NEXT_OUTPUT=standalone`; `.gitignore` thêm `.wrangler/`, `.dev.vars*`; tài liệu [CLOUDFLARE_DEPLOY.md](CLOUDFLARE_DEPLOY.md).
- **Kiến trúc/ảnh hưởng:** Không đổi code nghiệp vụ, API, schema. Build Vercel không đổi (biến `NEXT_OUTPUT` không được đặt). Cloudflare là bản song song, cùng database/Blob nếu dùng cùng secret.
- **Người dùng xác nhận (2026-10-25):** Chọn Cloudflare Containers (không dùng Workers/OpenNext, không chỉ dùng R2/DNS). Token Cloudflare đã được cung cấp để thiết lập.
- **Đã kiểm chứng:** token `active`; `cd cloudflare && npx tsc --noEmit` sạch; `wrangler deploy --dry-run --containers-rollout=none` hợp lệ (Worker 54.54 KiB); `npm run typecheck` và ESLint cho `next.config.ts` sạch; bản sao sạch không có `.env*` chạy `npm ci` + `NEXT_OUTPUT=standalone npm run build` thành công, `server.js` và `sharp` có trong `.next/standalone`; chạy thử `node server.js` cô lập: `/login` 200, `/api/projects` không đăng nhập 401, `/api/health` 503 `configuration_required` đúng như khi thiếu cấu hình.
- **Chưa kiểm chứng:** build/chạy image Docker thật (máy chưa có Docker); deploy (account **chưa có Workers Paid**, Containers API từ chối); Workers Builds có build được image không; hành vi trên Cloudflare (cold start, bộ nhớ export ZIP, cookie/Host, Google OAuth callback); `npm test`, `npm run lint` toàn dự án và `npm run build` chế độ Vercel không chạy lại vì không đổi code nghiệp vụ.
- **Tài liệu đã cập nhật:** CLOUDFLARE_DEPLOY, ARCHITECTURE (ghi chú hosting), AGENT_GUIDE, README (docs), `CLAUDE.md`.

## 2026-10-25 — Thiết lập quy định cho Claude và Cloudflare MCP

- **Thay đổi:** Thêm `CLAUDE.md` ở gốc repo; thêm [ENGINEERING_POLICY.md](ENGINEERING_POLICY.md), [AGENT_GUIDE.md](AGENT_GUIDE.md), [README.md](README.md) (mục lục docs) và nhật ký này; thêm `.mcp.json` đăng ký Cloudflare MCP (`cloudflare-api`, `cloudflare-docs`).
- **Kiến trúc/ảnh hưởng:** Không đổi code ứng dụng, schema hay API. Chỉ thêm tài liệu và cấu hình MCP cấp dự án.
- **Người dùng xác nhận (2026-10-25):**
  1. Mọi tính năng mới hoặc thay đổi thành phần khác phải được test và kiểm tra để không ảnh hưởng, làm thay đổi hay phá vỡ chức năng khác.
  2. Luôn viết và cập nhật docs cho điều đã thay đổi: kiến trúc, tính năng được người dùng xác nhận.
  3. Thiết lập Cloudflare MCP cho dự án.
- **Đã kiểm chứng (baseline trước khi thêm docs):** `npm run typecheck` sạch; `npm run lint` không có cảnh báo; `npm test` 98 test / 17 file qua. Không chạy `npm run build` trong lần này vì không đổi code.
- **Chưa kiểm chứng:** Kết nối OAuth tới Cloudflare MCP (cần người dùng approve server và xác thực qua `/mcp`). `claude` CLI không có trong PATH của shell phiên này nên cấu hình được ghi trực tiếp vào `.mcp.json`.
- **Tài liệu đã cập nhật:** `CLAUDE.md`, `annotation-tool/CLAUDE.md`, ENGINEERING_POLICY, AGENT_GUIDE, README (docs), CHANGELOG.

## Lịch sử trước đó (tóm tắt từ tài liệu hiện có)

Nguồn là các tài liệu chuyên đề; mở file tương ứng để xem chi tiết và ngày.

- **2026-10-04** — Xuất ground truth “consistent”: mask Canvas native + viền 2px, COCO RLE suy ra từ cùng một raster. Người dùng chọn `native-canvas-separated.png` cho `8582_01`. → [GROUND_TRUTH_EXPORT.md](GROUND_TRUTH_EXPORT.md)
- **2026-09-14** — Dữ liệu Drive gốc + polygon bảo toàn; thêm version ảnh (ADMIN xem/xóa/đặt làm bản chính); sửa ZIP đủ ảnh/mask/JSON và vectorizer giữ pixel. → [DRIVE_NATIVE_20260914.md](DRIVE_NATIVE_20260914.md), [IMAGE_VERSIONS.md](IMAGE_VERSIONS.md), [ZIP_PIXEL_AUDIT.md](ZIP_PIXEL_AUDIT.md)
- **2026-09-09** — Bàn giao kiến trúc: save policy (nháp local 30s, server khi bấm lưu/đổi tab/file/Hoàn tất), khóa file có TTL, point u vấu `segmentation.wartPoints`, export Drive gồm DRAFT + DONE. Yêu cầu đã chốt nằm ở [ARCHITECTURE.md](ARCHITECTURE.md).
- **Trước đó** — Chuyển hoàn toàn sang Next.js full-stack trên Vercel; instance label `r*`/`w*`; polygon tools; CI/CD GitHub Actions → Vercel (`docs/prelabel-instance-labels.md`, `docs/vercel-cicd.md` ở gốc repo).

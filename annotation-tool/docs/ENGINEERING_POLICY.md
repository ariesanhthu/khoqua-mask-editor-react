# Quy định kỹ thuật (Engineering Policy)

Cập nhật: 2026-10-25. Áp dụng cho mọi người và mọi agent (Claude) sửa repo này. Bổ sung cho [ARCHITECTURE.md](ARCHITECTURE.md) và [EDITOR_PIPELINE.md](EDITOR_PIPELINE.md); khi mâu thuẫn, yêu cầu người dùng đã xác nhận trong hai tài liệu đó thắng.

Từ khóa: **PHẢI** = bắt buộc; **KHÔNG ĐƯỢC** = cấm; **NÊN** = mặc định, chỉ bỏ qua khi có lý do và ghi lại.

## 1. Nguyên tắc chung

1. Đọc code liên quan trước khi sửa. Sửa nhỏ, đúng chỗ; giữ logic hiện có và các chỉnh sửa chưa commit của người dùng (working tree thường “bẩn” có chủ đích).
2. Một thay đổi = một mục đích. Không gộp refactor, đổi tên, format lại hàng loạt vào commit tính năng.
3. Không tự thêm tính năng, phụ thuộc (dependency), hoặc đổi hành vi ngoài phạm vi yêu cầu. Nếu thấy vấn đề ở ngoài phạm vi, **báo lại**, đừng sửa lén.
4. Điều chưa kiểm chứng phải nói là chưa kiểm chứng. “Test qua” không đồng nghĩa “UI chạy đúng” hay “Drive/production đã đổi”.

## 2. Quy trình khi thêm hoặc đổi tính năng

Mỗi thay đổi đi qua đủ 6 bước:

1. **Hiểu yêu cầu.** Đối chiếu với “Yêu cầu người dùng đã chốt” trong ARCHITECTURE.md và invariant trong EDITOR_PIPELINE.md. Nếu yêu cầu mới xung đột với điều đã chốt → hỏi người dùng, không tự chọn.
2. **Đánh giá ảnh hưởng (impact analysis).** PHẢI liệt kê trước khi code:
   - Module/hàm/type/endpoint/bảng DB/key IndexedDB sẽ đổi.
   - Mọi nơi dùng chúng (dùng Grep; tra thêm [Bản đồ ảnh hưởng](AGENT_GUIDE.md#bản-đồ-ảnh-hưởng-impact-map)).
   - Tính năng khác có thể bị tác động (lock, lưu draft, export/ZIP/Drive, version, read-only, thao tác chuột).
   - Dữ liệu cũ (annotation đã lưu, draft IndexedDB, version lịch sử) còn mở và xuất đúng không.
3. **Cài đặt tối thiểu**, tương thích ngược (xem §4).
4. **Test** (xem §3): test mới cho hành vi mới + chạy lại toàn bộ test hiện có.
5. **Chạy 4 cổng chất lượng** (xem §3.3).
6. **Cập nhật tài liệu** (xem §5) trong cùng lần làm việc.

Thay đổi chạm vào vùng rủi ro cao (§6) cần thêm test hồi quy riêng cho vùng đó và ghi rõ trong báo cáo cuối.

## 3. Kiểm thử và cổng chất lượng

### 3.1 Bắt buộc có test

| Loại thay đổi | Test tối thiểu |
| --- | --- |
| Logic thuần (`src/lib/*`) | Unit test cạnh file (`*.test.ts`), gồm trường hợp biên và dữ liệu cũ |
| API route / service ghi DB | Test service với PGlite memory (mẫu: `lock-service.test.ts`), gồm quyền, revision, khóa |
| Export / ZIP / Drive | Test với mock DB/Drive (mẫu: `export-service.test.ts`); kiểm cả đầu ra byte/JSON, không chỉ “không lỗi” |
| Hình học polygon, mask, raster | Test pixel-exact (mẫu: `mask-pixels.test.ts`, `polygon-geometry.test.ts`) |
| Client API / lưu / khóa | `api-client.test.ts` hoặc test tương đương; giả lập lỗi 4xx/5xx/offline |
| UI (`editor-*.tsx`, `dashboard.tsx`) | Tách logic ra `src/lib` để test được; canvas: chạy thêm `scripts/canvas-browser-check.mjs`; phần còn lại kiểm tay hoặc ghi rõ “chưa kiểm thử UI” |
| Sửa lỗi | Test tái hiện lỗi **trước**, thấy fail, rồi sửa để pass |

### 3.2 Quy tắc test

- PHẢI chạy lại **toàn bộ** `npm test`, không chỉ file mới. Test cũ fail do thay đổi của bạn là lỗi của thay đổi, không sửa test cho khớp trừ khi hành vi cũ được người dùng xác nhận là sai (khi đó ghi vào CHANGELOG).
- KHÔNG ĐƯỢC xóa, bỏ qua (`skip`/`only`), hoặc nới lỏng assertion để cho test qua.
- Test KHÔNG ĐƯỢC chạm database/Blob/Drive production. Dùng PGlite memory hoặc mock. Không dùng `.env.local` trong test.
- Thay đổi thuật toán ảnh phải so pixel (sai khác 0) hoặc nêu rõ dung sai và lý do.

### 3.3 Bốn cổng chất lượng (trước khi báo “xong”, trước khi deploy)

Chạy trong `annotation-tool/`:

```powershell
npm run typecheck
npm test
npm run lint
npm run build
```

- Cả bốn PHẢI qua. CI (`.github/workflows/vercel.yml`) chạy test → typecheck → build và chặn deploy nếu fail.
- Baseline 2026-10-25: typecheck và lint sạch; 113 test / 18 file qua; sau thay đổi nhóm ảnh/phân công/nhập COCO cùng ngày: 158 test / 23 file qua; sau tối ưu render editor + nhập COCO 1.0 trong editor (cùng ngày): 180 test / 26 file qua, `canvas-browser-check` 21/21; sau `compactPolygon` + nhập surface (cùng ngày): **184 test / 26 file** qua, `canvas-browser-check` 21/21. Số test chỉ được tăng khi có hành vi mới; nếu giảm phải giải thích.
- Báo cáo cuối PHẢI nêu lệnh nào đã chạy, kết quả thật, lệnh nào chưa chạy và vì sao.

### 3.4 Kiểm tra thủ công / E2E

UI canvas (chuột, zoom, pan, polygon, brush) có **kịch bản Chrome headless** trên trang dữ liệu giả: `node scripts/canvas-browser-check.mjs http://localhost:<port>` (hướng dẫn chạy dev server cô lập ở đầu script; không gọi API). Kịch bản kiểm undo từng điểm khi vẽ polygon, double-click, chuột phải, Esc, brush + vector hóa, export PNG, zoom, dirty rectangle trùng pixel với vẽ toàn bộ, và in số đo long task dưới CPU 4×. Nó **không** phủ workspace (lưu, khóa, đổi file/tab), dữ liệu thật hay thiết bị thật. Khi sửa vùng này:

- Chạy kịch bản trên; sửa canvas mà kịch bản fail là lỗi của thay đổi.
- Chạy kịch bản thủ công liên quan trong “Việc còn lại” của ARCHITECTURE.md (save policy, lock, read-only, đổi tab/file).
- Nếu không có trình duyệt để kiểm: ghi “chưa kiểm thử tương tác trên trình duyệt” vào báo cáo và tài liệu. Không suy ra hành vi chuột từ test thuật toán.

## 4. Tiêu chuẩn mã nguồn

- **TypeScript strict**, không dùng `any` mới; không `// @ts-ignore`/`eslint-disable` khi chưa có lý do ghi bên cạnh.
- Phong cách theo file xung quanh: tên, mật độ comment, idiom. Comment giải thích *vì sao*, không lặp lại *cái gì*. Comment hiện có tiếng Việt thì giữ tiếng Việt.
- Next.js 16 + React 19 + React Compiler: đọc guide trong `node_modules/next/dist/docs/` trước khi dùng API routing/proxy/caching. `src/proxy.ts` là cổng xác thực `/api/*` (không phải `middleware.ts`).
- Type dùng chung nằm ở `src/types/index.ts`; đổi type = đổi hợp đồng, xem §6.
- Route Handler mỏng: logic nghiệp vụ nằm trong `src/lib/*-service.ts` để test được. Lỗi trả theo `ApiError { code, message }` với `ErrorCode` đã khai báo.
- **Tương thích ngược dữ liệu:** thêm trường mới là tùy chọn (optional) với giá trị mặc định an toàn; không đổi nghĩa trường cũ; không tự migrate dữ liệu thật. Annotation cũ thiếu `wartPoints` vẫn phải mở được.
- **Schema DB:** chỉ thêm (idempotent) vào danh sách trong `initializeSchema` của `db.ts` (`CREATE ... IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). Vân tay schema tự đổi khi danh sách đổi. KHÔNG xóa/đổi tên cột hoặc bảng nếu chưa có kế hoạch migrate + backup được người dùng duyệt.
- **Bảo mật:** quyền ADMIN kiểm tra trực tiếp trong bảng `users`, không tin riêng role trong JWT. Không đưa secret/OAuth token/refresh token vào client, log, test fixture hay docs. `.env*` không bao giờ được commit (trừ `.env.example`).
- **Phụ thuộc mới:** cần lý do, kiểm tra kích thước/bản quyền, ghi vào CHANGELOG. Không nâng phiên bản lớn của `next`, `react`, `postgres`, `sharp` nếu không được yêu cầu.

## 5. Tài liệu

Tài liệu là một phần của thay đổi, không phải việc làm sau.

### 5.1 Khi nào PHẢI cập nhật

| Sự kiện | Cập nhật |
| --- | --- |
| Thêm/đổi/xóa tính năng, hành vi hoặc phím tắt/chuột | `EDITOR_PIPELINE.md` (hợp đồng chức năng) + `CHANGELOG.md` |
| Đổi cấu trúc module, luồng dữ liệu, API, schema DB, type | `ARCHITECTURE.md` (bản đồ code, bảng API, hợp đồng dữ liệu) + `CHANGELOG.md` |
| Đổi cách lưu/export/ZIP/Drive/ground truth | `GROUND_TRUTH_EXPORT.md` / tài liệu chuyên đề tương ứng + `CHANGELOG.md` |
| Người dùng xác nhận hoặc đổi một yêu cầu | Ghi vào “Yêu cầu người dùng đã chốt” (ARCHITECTURE.md) và `CHANGELOG.md`, đánh dấu *người dùng xác nhận* kèm ngày |
| Đổi biến môi trường, deploy, CI | `README.md`, `.env.example`, `docs/vercel-cicd.md` ở gốc repo |
| Thêm script thao tác dữ liệu | Mô tả trong tài liệu chuyên đề: mục đích, có ghi vào DB/Drive hay không, cách chạy an toàn |
| Phát hiện hạn chế/việc chưa làm | Ghi vào “Việc còn lại” (ARCHITECTURE.md); không giấu |

### 5.2 Quy tắc viết

- Ghi **ngày tuyệt đối** (YYYY-MM-DD), không dùng “hôm nay/hôm qua”.
- Phân biệt rõ ba mức: **đã xác nhận bởi người dùng**, **đã kiểm chứng bằng test/lệnh** (kèm lệnh), **giả định/chưa kiểm chứng**.
- Không ghi secret, token, URL có chữ ký, dữ liệu cá nhân. Đường dẫn máy cục bộ chỉ ghi khi cần tái lập và nằm ngoài repo.
- Tài liệu viết tiếng Việt, nhất quán với các file hiện có. Sơ đồ dùng Mermaid.
- Sửa tài liệu lỗi thời ngay khi phát hiện; đừng chỉ thêm đoạn mới mâu thuẫn đoạn cũ. Nếu tài liệu chuyên đề trở thành snapshot lịch sử, ghi rõ ngày snapshot.
- Mỗi thay đổi có ý nghĩa thêm một mục vào đầu `CHANGELOG.md` theo mẫu trong file đó.

## 6. Vùng rủi ro cao (cần test hồi quy riêng)

| Vùng | Rủi ro | Phải kiểm tra thêm |
| --- | --- | --- |
| Khóa (`lock-service.ts`, `/lock*`, heartbeat) | Hai writer cùng lúc, mất khóa | Acquire đồng thời, token sai/hết hạn, viewer chỉ xem |
| Lưu annotation (`annotation-service.ts`, `/annotation`, `/done`, `/mask`) | Ghi đè, mất dữ liệu | `baseRevision`, `LOCK_LOST`, `REVISION_CONFLICT`, version history giữ nguyên |
| Save policy trong `editor-workspace.tsx` | Gửi server theo timer, lưu đúp/mất | Timer 30s chỉ ghi IndexedDB; save gate khi đổi tab/file |
| Draft local (`local-drafts.ts`) | Mất bản nháp | Không xóa draft khi lỗi/conflict; khôi phục draft cũ |
| `wartPoints` vs `breakpoints` | Trộn hai loại dữ liệu | Map `snapshot.breakpoints` ↔ `segmentation.wartPoints`, legacy breakpoints không mất |
| Export/ZIP/Drive (`export-service.ts`, `drive-service.ts`) | Ghi sai Drive, sai pixel | Chỉ nút Home ghi Drive; ZIP không ghi Drive; pixel round-trip |
| Hình học/mask (`polygon-geometry.ts`, `mask-pixels.ts`, canvas) | Lệch pixel, mất lỗ/vùng nhỏ | Test pixel-exact, holes, tọa độ nửa pixel, không tự vector hóa lại |
| Thao tác chuột trong Select, zoom/pan | Hồi quy UX | Đối chiếu “Hợp đồng thao tác trong Select”; đổi tool không reset zoom |
| Schema DB, `types/index.ts` | Vỡ dữ liệu cũ, vỡ nhiều nơi dùng | Grep toàn bộ consumer; dữ liệu cũ mở được |
| Auth (`proxy.ts`, `auth.ts`) | Lộ API | Route mới mặc định yêu cầu đăng nhập; chỉ thêm vào `publicApiPaths` khi thật sự công khai |
| Version lịch sử (`version-service.ts`, `/versions`) | Mất lịch sử | Chỉ ADMIN; xóa chỉ bản được chọn; số version không tái sử dụng |

## 7. An toàn dữ liệu và môi trường

- `.env` / `.env.local` có thể trỏ vào PostgreSQL, Blob và Drive **production**. Mặc định coi mọi lệnh ghi là ghi vào dữ liệu thật.
- KHÔNG ĐƯỢC tự chạy khi chưa có yêu cầu rõ của người dùng: `/api/seed`; các script trong `scripts/` có ghi (`import-*`, `activate-*`, `migrate-*`, `upload-*`, `setup-*`); export/sync Drive; xóa version; “đặt làm bản chính”.
- Script chỉ đọc (audit/verify/fetch) vẫn có thể gọi production: nói rõ trước khi chạy.
- Trước thao tác phá hủy hoặc import lớn: backup đầy đủ (database snapshot repeatable-read read-only + Blob + checksum) ngoài repo, có báo cáo. Không ghi đè dữ liệu production đang có người chỉnh sửa.
- Không xóa/revert thư mục `drive/`, `annotation-storage/`, hoặc nội dung `artifacts/` khi chưa xem và xác nhận.
- Thư mục `artifacts/` bị gitignore: không dựa vào nó như nguồn lưu trữ duy nhất, không commit.

## 8. Git, deploy, release

- Chỉ commit/push/deploy khi người dùng yêu cầu. Nhánh chính: `master`; push vào `master` kích hoạt deploy production qua GitHub Actions.
- Commit nhỏ, thông điệp nói rõ *thay đổi gì và vì sao*. KHÔNG ĐƯỢC `--no-verify`, `--force` lên `master`, hay bỏ qua hook.
- Trước khi commit: `git status` + `git diff`, loại file không liên quan (log, artifacts, `.env*`, backup).
- Trước deploy: 4 cổng §3.3 qua + tài liệu đã cập nhật. Sau deploy: kiểm `/api/health`, đăng nhập, mở một file; so `fingerprints.database` và `fingerprints.blobStore` khi chạy localhost song song (xem `docs/vercel-cicd.md`).
- Thay đổi chưa deploy/chưa kiểm thử UI phải được ghi đúng trạng thái trong tài liệu, không viết như đã lên production.

## 9. Định nghĩa “xong” (Definition of Done)

- [ ] Yêu cầu được đáp ứng, không xung đột yêu cầu đã chốt.
- [ ] Đã phân tích ảnh hưởng; không tính năng nào khác bị đổi hành vi ngoài chủ ý.
- [ ] Có test mới/cập nhật; toàn bộ test cũ vẫn qua.
- [ ] `typecheck`, `test`, `lint`, `build` qua (hoặc nêu rõ cái nào không chạy được và vì sao).
- [ ] Tài liệu + `CHANGELOG.md` đã cập nhật; điều người dùng xác nhận được đánh dấu.
- [ ] Không có secret, file rác, hay thay đổi ngoài phạm vi trong diff.
- [ ] Báo cáo nêu thật: đã kiểm chứng gì, chưa kiểm chứng gì, rủi ro còn lại.

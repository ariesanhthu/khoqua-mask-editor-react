# Kiến trúc hệ thống và bàn giao agent

Khôi phục merge 2026-11-01: Home v2, phân công và dữ liệu `label03` được đối chiếu chỉ đọc; chi tiết nguyên nhân, phạm vi dữ liệu và bản sao tại [MERGE_RECOVERY_20261101.md](MERGE_RECOVERY_20261101.md). Bản gộp giữ pipeline brush/vector/undo local và đưa rectangle/circle/anchor, snap/tự nối biên từ remote vào cùng canvas; không reset dữ liệu hay phân công.

Cập nhật: 2026-09-09; bổ sung 2026-10-25 (nhóm ảnh, phân công theo nhóm, nhập thư mục mặc định/COCO 1.0, Home theo nhóm — chi tiết ở [GROUPS_AND_IMPORT.md](GROUPS_AND_IMPORT.md); tối ưu render editor, nhập COCO 1.0 trong editor — [EDITOR_RENDERING.md](EDITOR_RENDERING.md)). Đọc tài liệu này cùng [EDITOR_PIPELINE.md](EDITOR_PIPELINE.md) và `../AGENTS.md` trước khi sửa.

## Trạng thái bàn giao

Bổ sung Cloudflare 2026-11-01: Worker đích `khoqua` đang build nhầm root `/annotation-tool`, gây OpenNext tự cấu hình service `annotation-tool` và lỗi 10143. Đã sửa tên trong cấu hình Containers; root dự kiến `/cloudflare`. Account hiện Free, chưa có runtime secrets, chưa build image Docker hoặc deploy Containers. Chi tiết và điều kiện còn thiếu: [CLOUDFLARE_DEPLOY.md](CLOUDFLARE_DEPLOY.md). Production chính là Vercel v2 đã khôi phục; sửa cấu hình này không thay DB/Blob/annotation.

Người dùng yêu cầu dừng triển khai tiếp và ghi lại kiến trúc, kết quả, các việc chưa làm xong. Working tree đã deploy Vercel 2026-10-25 (deployment `bitter-melon-annotation-q3f7ls3bn`, từ working tree, chưa commit). Vẫn **chưa commit**; UI chỉ được kiểm tra một phần (Chrome headless, đăng nhập production) — xem từng tài liệu chuyên đề.

Đã chạy thành công:

- `npm run typecheck`.
- `npm test`: 18 test, 4 file test.
- `npm run lint`: lần cuối không có lỗi/cảnh báo.
- `npm run build`: Next.js biên dịch và tạo build thành công.
- Đọc trực tiếp database và Google Drive để chẩn đoán; không gọi export/sync production, không chỉnh annotation thật.

Các lệnh trên không thay thế kiểm thử tương tác, race condition trên PostgreSQL thật hoặc xác nhận dữ liệu sau khi ghi lên Drive. Xem phần việc còn lại ở cuối.

## Yêu cầu người dùng đã chốt

1. Chỉ sửa khi cần, đọc code trước, giữ logic hiện có và các chỉnh sửa của người dùng. Không viết lại toàn bộ editor.
2. Tối giản chi tiết thừa, chuyển phần điểm ngắt/nứt gãy trên UI sang tab **Mật độ u vấu**.
3. **“Chấm điểm” nghĩa là point: click chuột tạo tọa độ trên từng u vấu. Không phải score, không dùng thang 1–5 hay 0–3.**
4. Sidebar trái hiển thị danh sách file, trạng thái và cho chuyển file nhanh. File người khác đang sửa vẫn mở được ở chế độ chỉ xem.
5. Lưu nháp local mỗi **30 giây**. Không tự gửi annotation hoặc mask lên server theo timer.
6. Khi đổi tab/file, bấm Lưu, xác nhận thao tác cần lưu hoặc Hoàn tất: gửi lên server. Không báo thành công nếu server từ chối.
7. Drive chỉ ghi khi người dùng bấm **Cập nhật Drive ở Home**. Lưu server và lưu Drive là hai hành động riêng.
8. Một file chỉ có một phiên giữ khóa chỉnh sửa hợp lệ. Backend phải từ chối writer khác và revision cũ; UI phải chặn cả chuột, nút và phím tắt khi chỉ xem/mất khóa.
9. *(Người dùng xác nhận 2026-10-25)* Admin giao việc **theo nhóm ảnh**; người dùng chỉ thấy nhóm/ảnh được giao. Khi admin tải cả thư mục khổ qua lên, mỗi thư mục con (mỗi giống) tự thành một nhóm. Người gán nhãn xem theo nhóm, bấm nhóm thì thấy danh sách ảnh cần làm.
10. *(Người dùng xác nhận 2026-10-25)* Tải lên hỗ trợ **COCO 1.0**; định dạng manifest đang có **giữ nguyên, là mặc định**, không được xóa.
11. *(Người dùng xác nhận 2026-10-25)* Lần này chỉ trình bày lại UX **trang chính (Home)**, giữ design; **không sửa trang editor gán nhãn**. (Áp dụng cho đợt Home đó; yêu cầu 12 sau đó mở lại phạm vi editor.)
12. *(Người dùng xác nhận 2026-10-25)* Tối ưu editor cho thiết bị: vẽ/tẩy (paint), chỉnh segment, zoom in/out, tải ảnh, chuyển brush ↔ polygon không bị lag; tìm hiểu thuật toán tối ưu render; refactor, cập nhật đầy đủ comment, docs, rule; bổ sung định dạng COCO 1.0. **Không được phá vỡ tính năng hiện có**, đặc biệt **undo từng điểm khi đang vẽ polygon** (chấm nhiều điểm, Ctrl+Z xóa điểm vừa chấm). Xem [EDITOR_RENDERING.md](EDITOR_RENDERING.md), hợp đồng vẽ polygon trong [EDITOR_PIPELINE.md](EDITOR_PIPELINE.md).
13. *(Người dùng xác nhận 2026-11-05)* Tự nối biên khi vẽ polygon **chỉ nối theo biên, không gộp mask**. Nhấp lên điểm của mask khác khi đang vẽ chỉ là chấm anchor (không hiểu là “điểm kết thúc”), polygon chỉ hoàn tất khi nhấp đúp. **Shift + trỏ vào anchor** hiện xem trước đường nối; đường chỉ đi phần biên chưa có mask khác nối vào; **Shift + chuột trái** để nối đường đó vào polygon đang vẽ mà **không kết thúc**; chỉ nhấp đúp mới hoàn tất (người dùng sửa lại cùng ngày). Chi tiết: [EDITOR_PIPELINE.md](EDITOR_PIPELINE.md) mục “Tự nối biên khi vẽ polygon (Shift)”. **Cập nhật 2026-11-06 (người dùng xác nhận qua hỏi–đáp):** giữ Shift + trỏ vào *bên trong* mask kế bên để xem trước; đường chạy **từ điểm vừa chấm** tới điểm biên tự do gần con trỏ nhất; **Shift + chuột trái** chèn các điểm đó, không hoàn tất, không chuyển V; nhấp chuột trái thường chỉ chấm điểm; hoàn tất bằng **nhấp đúp lên một điểm**, Enter hoặc nút (nhấp đơn điểm đầu và nhấp đúp chỗ trống không còn hoàn tất); ngưỡng “dính” giữ ≤ 2.5 px ảnh.
14. *(Người dùng xác nhận 2026-11-05)* Phần lớp phủ cho phép tô mask **khác màu theo label**: hai mask tách biệt nhưng cùng label (ví dụ cùng `r1`) vẫn cùng màu. Thêm thanh kéo độ mờ ở phần lớp phủ và **độ mờ áp dụng cả lên đường biên** (trước đây chỉ phần tô đậm nhạt, biên giữ nguyên là sai). Chi tiết: [EDITOR_PIPELINE.md](EDITOR_PIPELINE.md) mục “Lớp phủ: màu theo label và độ mờ”. **Cập nhật 2026-11-06:** màu theo label là chế độ mặc định và duy nhất (bỏ ô bật/tắt).
15. *(Người dùng xác nhận 2026-11-05)* Thông báo (toast) của editor chuyển vào sidebar phải thay cho phần gợi ý “Ctrl+Z hoàn tác toàn cục…/Di chuột lên điểm…”. Chế độ chỉnh sửa (V) có **magnet**: node đang kéo dính vào điểm gần đó, nút bật/tắt icon nam châm dưới nút lớp phủ góc trên trái. Thêm **Ctrl + Shift + con lăn** để cuộn và **bật lại thanh cuộn**. Chi tiết: [EDITOR_PIPELINE.md](EDITOR_PIPELINE.md) “Hợp đồng thao tác trong Select”.

## Stack và phạm vi

Project root: `SAM/khoqua-mask-editor-react/khoqua-mask-editor-react/annotation-tool`.

- Next.js 16.3.0 App Router, React 19.2.8, TypeScript, React Compiler.
- Frontend và API nằm trong cùng ứng dụng Next.js; không có backend Python cho luồng này.
- PostgreSQL qua `postgres` khi có connection string; PGlite cho development nếu không có connection string.
- Dexie/IndexedDB lưu nháp ở trình duyệt.
- Vercel Blob private lưu mask trên hosting; filesystem dùng khi chạy local không cấu hình Blob.
- OAuth Google ở server dùng để ghi Drive; service account/asset loader dùng đọc dữ liệu nguồn khi phù hợp.
- `sharp` render/chuẩn hóa mask; JSZip tạo gói xuất.

Hosting: Vercel là production hiện tại. Phương án chạy song song trên Cloudflare Containers (Worker chuyển tiếp vào container Next.js standalone) đã được chuẩn bị nhưng chưa deploy; xem [CLOUDFLARE_DEPLOY.md](CLOUDFLARE_DEPLOY.md).

`AGENTS.md` yêu cầu đọc guide của phiên bản Next.js đang cài trong `node_modules/next/dist/docs/`, không dựa hoàn toàn vào kiến thức phiên bản cũ. Đã đọc guide Route Handlers và `useRouter` trong lần sửa này.

## Sơ đồ dữ liệu

```mermaid
flowchart LR
  Home[Dashboard / Home] -->|mở file| Workspace[EditorWorkspace]
  Workspace -->|xin khóa / đọc bootstrap| API[Next.js API]
  Workspace --> Canvas[EditorCanvas]
  Canvas -->|snapshot sau thao tác| Workspace
  Workspace -->|mỗi 30s / giữ nháp trước thao tác lưu| Local[IndexedDB]
  Workspace -->|Lưu / đổi tab, file / Hoàn tất| API
  API --> DB[(PostgreSQL hoặc PGlite)]
  API -->|mask PNG| Blob[Private Blob hoặc local storage]
  Home -->|bấm Cập nhật Drive| Export[Export service]
  Export --> DB
  Export --> Blob
  Export -->|upsert| Drive[Drive đích]
```

Timer heartbeat 30 giây và polling danh sách 8 giây chỉ giữ khóa/đọc trạng thái, **không phải đồng bộ annotation**.

## Bản đồ code

| File | Trách nhiệm |
| --- | --- |
| `src/components/dashboard.tsx` | Home: chọn project, tổng quan nhóm được giao/tiến độ, danh sách ảnh theo nhóm (lọc, tìm, Làm ảnh tiếp theo), mở file/xem file bị khóa, nút Drive/ZIP; ADMIN có tab Nhập dữ liệu/Quản trị và nút Phân công |
| `src/components/group-assign-dialog.tsx` | ADMIN chọn người được giao một nhóm |
| `src/components/dataset-import.tsx` | ADMIN tải thư mục lên: chọn dự án, định dạng (mặc định/COCO 1.0), cách chia nhóm, xem trước, nhập từng ảnh |
| `src/lib/file-groups.ts` | Quy tắc nhóm dùng chung client/server: nhóm theo thư mục con, theo tiền tố tên, kiểm tên |
| `src/lib/import-plan.ts`, `src/lib/coco-import.ts` | Lập kế hoạch nhập thư mục ở trình duyệt; đổi COCO (polygon/RLE) thành prelabel `POLYGON_SET` |
| `src/lib/access-service.ts` | Biểu thức SQL quyền theo nhóm (vai trò đọc từ DB), `requireAdminAccount` |
| `src/lib/group-service.ts` | Danh sách nhóm + tiến độ, phân công, tự chia nhóm ảnh chưa phân nhóm |
| `src/lib/dataset-import-service.ts` | Nhập một ảnh: kiểm ảnh/mask/prelabel, ghi object store, upsert ảnh + nhóm trong transaction |
| `src/components/editor-workspace.tsx` | Bootstrap, recovery local, quản lý tab/file, save gate, heartbeat, conflict UI, sidebar |
| `src/components/editor-canvas.tsx` | Polygon/node, point, selection, undo/redo, zoom/pan, render/export canvas; có prop `readOnly`. Sáu lớp canvas có cờ bẩn riêng, image pyramid, dirty rectangle ([EDITOR_RENDERING.md](EDITOR_RENDERING.md)) |
| `src/lib/polygon-draft.ts` | Lịch sử điểm của polygon đang vẽ: undo/redo từng điểm, xóa điểm, bỏ đỉnh trùng double-click |
| `src/lib/brush-worker.ts`, `src/lib/polygon-pack.ts` | Worker vector hóa mask (`INIT_POLYGONS`/`INIT_MASK`/`PUT_PATCH`/`VECTORIZE`); đóng gói polygon thành typed array để chuyển giữa thread |
| `src/lib/vector-identity.ts` | Bounds polygon (cache) và gán lại id/label sau vector hóa theo IoU, chỉ mục lưới |
| `src/lib/canvas-view.ts`, `src/lib/mask-pixels.ts` | Zoom quanh con trỏ, tỉ lệ pixel theo thiết bị, image pyramid; raster tâm pixel (`rasterizePolygons`, `forEachPolygonSpan`), vector hóa, làm mịn, LOD, polygon ít điểm cho script nhập (`compactPolygon`) |
| `src/lib/web-import.ts` | Nhập JSON vào ảnh đang mở: prelabel 1.1 hoặc COCO 1.0 |
| `src/lib/api-client.ts` | Client HTTP, token khóa theo file, gộp request xin khóa đang chạy |
| `src/lib/local-drafts.ts` | Dexie database và khóa nháp theo project/file/user |
| `src/lib/lock-service.ts` | Khóa có TTL, acquire, heartbeat, release |
| `src/lib/annotation-service.ts` | Transaction lưu draft/Done, kiểm tra token và revision, lịch sử version |
| `src/lib/wart-points.ts` | Kiểm tra cấu trúc, trạng thái, tọa độ và ID của point u vấu |
| `src/lib/storage.ts` | PNG validation/normalization, lưu/đọc mask (qua `object-store.ts`) |
| `src/lib/object-store.ts` | Lưu đối tượng: Cloudflare R2 (`STORAGE_BACKEND=r2`), Vercel Blob (mặc định), đĩa cục bộ; xem [CLOUDFLARE_R2_STORAGE.md](CLOUDFLARE_R2_STORAGE.md) |
| `src/lib/export-service.ts` | Xuất cả DRAFT/DONE, render polygon cũ, JSONL/ZIP, hash và upsert Drive |
| `src/lib/drive-service.ts` | Đọc nguồn, manifest, asset đa loại và thao tác Drive |
| `src/lib/google-oauth.ts` | OAuth config, refresh token mã hóa, access token ở server |
| `src/lib/db.ts` | Adapter Postgres/PGlite, schema, bootstrap admin |
| `src/types/index.ts` | DTO và annotation/local draft types |

## Các API chính

| Endpoint | Hành vi |
| --- | --- |
| `GET /api/projects` | ADMIN: mọi project; người khác: project có nhóm được giao |
| `POST /api/projects` | ADMIN (vai trò từ DB). `source: 'upload'` cho phép tạo project không có nguồn manifest |
| `GET /api/projects/:projectId/files` | File list phân trang, annotation state, lock owner, assignment, `group`. Người không phải ADMIN chỉ nhận ảnh thuộc nhóm được giao; `groupId` (hoặc `ungrouped`), `annotationState` nhận danh sách cách dấu phẩy |
| `GET /api/projects/:projectId/groups` | Nhóm + tiến độ; ADMIN nhận thêm người được giao và số ảnh chưa phân nhóm |
| `PUT /api/projects/:projectId/groups/:groupId/assignees` | ADMIN thay danh sách người được giao (`{ userIds }`) |
| `POST /api/projects/:projectId/groups/auto` | ADMIN xếp ảnh chưa phân nhóm theo tiền tố tên ảnh |
| `POST /api/projects/:projectId/import` | ADMIN nhập một ảnh (multipart: `meta`, `image`, `prediction?`, `prelabel?`); nhập lại giữ annotation |
| `POST /api/files/:fileId/lock` | Xin khóa; token đang sở hữu có thể dùng lại; phiên khác nhận `FILE_LOCKED` (423); ảnh ngoài nhóm được giao nhận `FORBIDDEN` (403) |
| `POST /api/files/:fileId/lock/heartbeat` | Gia hạn TTL nếu user + token hợp lệ |
| `DELETE /api/files/:fileId/lock` | Nhả đúng khóa đang giữ |
| `GET /api/files/:fileId/editor` | Bootstrap cho cả editor và viewer; `readOnly`, `lockedBy`, `lock: null` nếu không sở hữu token; 403 nếu ảnh ngoài nhóm được giao |
| `POST /api/files/:fileId/mask` | Upload PNG với khóa hợp lệ |
| `PATCH /api/files/:fileId/annotation` | Lưu draft, tăng revision, kiểm tra lock/revision trong transaction |
| `POST /api/files/:fileId/done` | Validate nhiệm vụ, tạo version, tăng revision, nhả khóa |
| `POST /api/projects/:projectId/export` | Ghi dữ liệu đã lưu server lên Drive; chỉ gọi từ nút Home |
| `GET /api/projects/:projectId/export` | Tải ZIP, không ghi Drive |
| `POST /api/projects/:projectId/sync-drive` | Nhập/cập nhật chỉ mục từ nguồn, khác với export annotation |
| `GET /api/google/diagnostics` | Chẩn đoán quyền thư mục; hiện chọn project đầu tiên, chưa nhận project đang chọn |

Authentication dùng JWT/cookie httpOnly; header khóa là `X-Annotation-Lock-Token`. Không đưa OAuth credential hay refresh token vào client, log hoặc docs.

## Nhóm ảnh và phân công (2026-10-25)

Schema chỉ thêm: `file_groups`, `group_assignments`, cột `dataset_files.group_id` (NULL = chưa phân nhóm, gồm toàn bộ dữ liệu có sẵn). Quyền xem tính bằng biểu thức SQL trong `access-service.ts` nhúng vào truy vấn có sẵn (vai trò đọc từ bảng `users`): người không phải ADMIN chỉ thấy project/nhóm/ảnh được giao và bị từ chối bootstrap/xin khóa ảnh khác; heartbeat/lưu/Hoàn tất không kiểm lại phân công để không mất bản đang sửa. Ảnh mới vào hệ thống qua *Đồng bộ nguồn* (như cũ) hoặc qua tải thư mục (định dạng mặc định hoặc COCO 1.0, mỗi thư mục con thành một nhóm). Chi tiết, quy tắc chia nhóm, chuyển đổi COCO và cách xử lý dữ liệu production có sẵn: [GROUPS_AND_IMPORT.md](GROUPS_AND_IMPORT.md).

## Hợp đồng annotation u vấu

Để tránh thay schema SQL và tránh ghi đè điểm đứt gãy cũ, point u vấu được lưu trong **`segmentation.wartPoints`**, thuộc `segmentation_json`:

```json
{
  "segmentation": {
    "humanAction": "MODIFIED",
    "wartPoints": {
      "state": "ANNOTATED",
      "points": [{ "id": "point-id", "x": 120.5, "y": 80.25 }]
    },
    "maskOperations": [{ "type": "POLYGON_SET", "polygons": [] }]
  },
  "breakpoints": { "state": "NOT_ANNOTATED", "points": [] }
}
```

Ví dụ chỉ minh họa cấu trúc. Tọa độ theo pixel ảnh nguồn, không theo màn hình/zoom. `wartPoints.state` có ba giá trị:

- `NOT_ANNOTATED`: chưa làm; được lưu draft, không được Hoàn tất.
- `ANNOTATED`: có ít nhất một point.
- `CONFIRMED_NONE`: đã xác nhận không có u vấu, danh sách rỗng.

**Chi tiết tương thích cần hiểu trước khi sửa:** Canvas hiện tái sử dụng point editor vốn có tên `breakpoints`, `initialBreakpoints`, `confirmNoBreakpoint`. Trong workspace, `snapshot.breakpoints` mang point u vấu; khi gọi API được map sang `segmentation.wartPoints`. `legacyBreakpointsRef` giữ dữ liệu breakpoint cũ và gửi lại trường top-level `breakpoints`. Không đổi tên hay map hai loại dữ liệu này tùy tiện. LocalDraft có `wartPoints` riêng, còn `breakpoints` là dữ liệu legacy.

Annotation cũ không có `wartPoints` mở ra với nhiệm vụ u vấu chưa làm, **không tự diễn giải breakpoint cũ thành u vấu**. Không chạy migration trên dữ liệu thật trong phiên này.

## Lưu local, server và chuyển màn hình

- Snapshot canvas dùng ref để đọc bản mới nhất; `dirtyVersionRef` và `syncedVersionRef` theo dõi thay đổi.
- Timer 30 giây gọi `persistLocal`, không gọi `saveDraft`/`uploadMask`.
- `syncNow` chỉ được gọi bởi các action cần lưu; gửi mask khi MODIFIED và lưu annotation với `baseRevision`.
- Đổi tab workflow, toolbar/phím tắt đổi workflow đi qua `selectTool` và save gate.
- Đổi file/Home qua `navigateTo`: lưu local, chờ server; nếu lỗi thì giữ nguyên file và báo lỗi; thành công mới nhả khóa và chuyển route.
- `visibilitychange` sang hidden yêu cầu lưu server, tương ứng đổi tab trình duyệt. `pagehide` cố giữ local; `beforeunload` cảnh báo khi còn dirty.
- Không bảo đảm upload hoàn tất khi browser/process bị đóng cưỡng bức. Cần kiểm thử browser lifecycle, xem backlog.
- “Đã lưu server” không có nghĩa “Đã lên Drive”. Không gộp lại hai trạng thái này.

## Khóa và conflict

- TTL mặc định 300 giây, cấu hình bằng `LOCK_TTL_SECONDS`; workspace heartbeat mỗi 30 giây.
- Acquire khóa và lưu annotation cùng khóa row `dataset_files` trước, rồi row `file_locks` trong transaction.
- Một phiên khác không được thay live lock, kể cả cùng tài khoản nếu không có token đang sở hữu.
- Save/Done kiểm tra user, token hash, thời gian hết hạn và `baseRevision`; stale writer nhận `LOCK_LOST` hoặc `REVISION_CONFLICT`.
- Bootstrap cho phép viewer đọc annotation nhưng không cấp token.
- Workspace/Canvas đã có disabled controls, pointer/keyboard/imperative guards; cần E2E để xác minh đủ mọi đường tương tác.
- Conflict UI giữ nháp, cho tải JSON local, xem bản local hoặc bỏ local để tải bản server. Đã bỏ đường tự lấy revision mới rồi ghi đè local thành một Done version.
- Không thêm tính năng force unlock hoặc tự giải quyết conflict bằng cách ghi đè.

## Google Drive: phát hiện thực tế

Đã đọc trực tiếp trong phiên 2026-09-09:

| Nguồn | Kết quả |
| --- | --- |
| Website hiện hữu | `https://bitter-melon-annotation.vercel.app` |
| Project | `Bitter Melon V7 Prelabel` |
| Server annotations | 10 bản ghi; cả 10 là DRAFT |
| Lần lưu server mới nhất tại thời điểm kiểm tra | `2026-09-09T03:38:48.472Z` |
| Khóa còn hiệu lực tại thời điểm kiểm tra | 1; không tự nhả hoặc thay khóa này |
| Drive đích | `DATABASE-GT`, ID `147cVK2C7EZiupfMJQntP5Nc6tkkhqchN` |
| Quyền OAuth trên thư mục | `canEdit: true`, `canAddChildren: true` |
| `manifest.jsonl` | 0 bản ghi; modified `2026-09-08T05:37:38.370Z` |
| Nội dung khác ở thư mục gốc | `breakpoints.jsonl`, `masks/`, `DATASET/` |

Prelabel production dùng schema `bitter-melon-prelabel-1.1`: vết gợn mang label `r1`, `r2`, … và u vấu mang label `w1`, `w2`, … theo từng instance. Quy tắc mapping và thao tác UI được mô tả tại [`docs/prelabel-instance-labels.md`](../../docs/prelabel-instance-labels.md).

**Nguyên nhân được xác định trong code cũ:** export lọc `df.annotation_state = 'DONE'`, trong khi toàn bộ annotation server đang là DRAFT. Vì vậy bấm Drive không đưa 10 bản nháp lên manifest. Không phải lỗi thiếu quyền ghi ở lần kiểm tra này. Thông tin trên là snapshot, không phải giám sát realtime.

Các sửa đổi local:

- Export lấy annotation đã lưu server gồm DRAFT và DONE, ghi `annotation_status` vào manifest.
- Xuất `wart-points.jsonl` riêng và giữ `breakpoints.jsonl` cho dữ liệu cũ.
- `manifest.jsonl` có revision/version và hash mask, breakpoint, wart point để bỏ qua bản không đổi.
- Dùng `fetchDatasetAsset`, hỗ trợ nguồn Drive ID, Blob, HTTPS và đường dẫn tuyệt đối; không ép mọi reference thành Google Drive ID.
- Render `POLYGON_SET` từ bản nháp cũ bằng `sharp` khi chưa có raster mới/đang giữ raster cũ. RESET/ACCEPTED dùng prediction. MODIFIED thiếu cả dữ liệu render lẫn raster báo lỗi.
- Home hiển thị lỗi theo file; không chỉ báo số mask upload rồi khiến người dùng hiểu nhầm point/metadata chưa cập nhật.
- Không ghi Drive từ editor, timer, Done hoặc ZIP.

Chưa thực hiện upload thật sau sửa đổi. Agent sau phải phân biệt “mock export tests pass” với “đã xác nhận remote file sau upload”. Chỉ chạy export khi người dùng bấm nút hoặc có chỉ thị mới cho thao tác đó.

## Việc còn lại — ưu tiên trước khi deploy

### 1. Xác minh UI và save policy bằng E2E

Chưa thực hiện vì tool browser trả `No browser is available`. Cần trình duyệt kết nối hoặc test harness phù hợp:

- Tạo/kéo/xóa point u vấu; undo/redo; confirm-none; zoom/pan không đổi tọa độ.
- Sau chỉnh sửa, chờ trên 30 giây: có IndexedDB draft, **không có PATCH annotation, POST mask hoặc POST export** từ timer. Heartbeat/polling GET được phép.
- Chuyển tab workflow bằng nút, toolbar và phím tắt; chuyển tab browser; chuyển file qua sidebar; về Home; Done & Next. Đảm bảo đủ save, không đúp/mất save.
- Giả lập save trả 500/offline/revision conflict: không báo thành công, không rời file khi server save thất bại.
- Hai tài khoản: viewer xem được, mọi đường sửa/save/Done/keyboard/pointer bị chặn. Kiểm tra cả sidebar hẹp/mobile và tab u vấu dài.
- Khôi phục IndexedDB có/không có wartPoints, revision khớp/lệch; legacy breakpoints không mất.

### 2. Rà soát các cạnh tranh và lifecycle còn hở

Các điểm sau được ghi nhận để agent tiếp tục; **chưa sửa/xác minh xong**, không trình bày như đã được bảo đảm:

- Token client hiện nằm trong `Map` bộ nhớ. Hard reload có thể mất token trong khi live lock vẫn tồn tại, khiến cùng tài khoản vào chỉ xem đến khi TTL hết. Thiết kế resume phiên không được cho phiên khác chiếm khóa.
- `syncNow` gộp promise đang chạy, nhưng trả thành công của batch hiện tại. Cần test thay đổi mới phát sinh sát lúc save/chuyển file; bảo đảm flush đến snapshot cuối trước khi nhả khóa.
- Khóa UI đang dựa vào `readOnly`/`status`. `onOffline` đổi status thành OFFLINE; cần giữ chặn chỉnh sửa khi đã conflict/mất khóa, kể cả khi network events đổi status. Backend hiện vẫn kiểm tra khóa trên mỗi lần lưu.
- SPA Back/Forward hoặc unmount ngoài `navigateTo` chưa có kiểm thử flush/release. Pagehide/unload không bảo đảm async IndexedDB/upload hoàn tất.
- `finish` hiện có thể upload mask lần nữa sau `syncNow`; xem xét tái sử dụng mask đã lưu để tránh upload trùng.
- Kiểm thử lỗi IndexedDB sau khi server đã nhận save và lỗi tải bản mới nhất trong conflict dialog; trạng thái phải phản ánh đúng nơi dữ liệu còn tồn tại.
- Test acquire đồng thời hiện chạy trên PGlite, chưa kiểm tra race nhiều server instances trên Postgres thật.

### 3. Kiểm tra Drive sau triển khai được yêu cầu

- Chỉ sau nút Home/chỉ thị người dùng: đọc lại manifest/mask/`wart-points.jsonl` để so revision, số point và tọa độ với server.
- Kiểm tra các bản DRAFT cũ có polygon, raster cũ, RESET và accepted mask.
- Kiểm tra 2 lần bấm Drive đồng thời/nhiều client. Hiện chưa có khóa export liên server; hash/upsert không tự bảo đảm atomic cho nhiều JSONL.
- `GET /api/google/diagnostics` còn chọn project đầu tiên; nếu thêm UI kiểm tra theo project, cần truyền projectId.
- Quyết định chính sách schema/version cho downstream consumer của `annotation_status` và `wart-points.jsonl`; không tự gộp vào breakpoint cũ.

### 4. Kết thúc release

- Review diff với thay đổi đã có trước phiên; chạy lại typecheck/test/lint/build sau mọi sửa code tiếp theo.
- Không commit/deploy/sync chỉ vì tài liệu này đề cập; làm theo yêu cầu mới của người dùng.
- Sau deploy, kiểm tra production UI và luồng Drive thủ công rồi mới đánh dấu các mục tương ứng hoàn tất.

### 5. Tối ưu render editor và nhập COCO 1.0 trong editor (2026-10-25)

- Đã kiểm tra tự động trên Chrome headless với trang dữ liệu giả (`scripts/canvas-browser-check.mjs`: 21 kiểm tra chức năng gồm undo từng điểm polygon, brush, zoom, dirty rectangle trùng pixel với vẽ toàn bộ). **Chưa** thử trên thiết bị thật, ảnh thật ~12 MP/1600 polygon, Safari/Firefox, production build, mất GPU context thật.
- Nhập COCO 1.0 trong editor dùng ánh xạ danh mục tự động (không có hộp thoại ánh xạ như màn nhập thư mục); chưa thử với file COCO thật từ CVAT trên trình duyệt.
- Hành vi có sẵn ghi nhận lại (không đổi): lần dùng brush đầu tiên trên file polygon dò lại **mọi** polygon từ raster (đã làm mịn), kể cả polygon nét vẽ không chạm; polygon chạm/chồng nhau gộp thành một. Muốn giữ đỉnh gốc cho polygon không bị chạm cần người dùng quyết định.
- Chi tiết, số đo và việc còn lại: [EDITOR_RENDERING.md](EDITOR_RENDERING.md) §5, §8.

### 6. Nhóm ảnh, phân công và nhập thư mục (2026-10-25)

- Trước khi deploy phải báo người dùng: ảnh production có sẵn chưa có nhóm, người gán nhãn sẽ không thấy ảnh nào cho tới khi ADMIN bấm **Tự động chia nhóm** và **Phân công** (không có migration tự động).
- Chưa kiểm thử trên trình duyệt: chọn thư mục, xem trước, ánh xạ danh mục COCO, hộp thoại phân công, bộ lọc nhóm, quay về đúng nhóm từ editor, giao diện hẹp.
- Chưa thử ghi lên Vercel Blob/R2 thật và giới hạn 4.5 MB/request trên Vercel với ảnh gốc lớn.
- Chưa có: đổi tên/gộp/xóa nhóm, chuyển ảnh giữa nhóm bằng tay, kiểm phân công ở route asset, lọc Drive/ZIP theo nhóm. Xem [GROUPS_AND_IMPORT.md](GROUPS_AND_IMPORT.md) §8.

### 7. Tự nối biên bằng Shift (2026-11-05, nhánh `dev/debug_anchor`)

- Đã kiểm tra bằng unit test và Chrome headless trên cảnh giả `?seams=1`. **Chưa** thử trên ảnh/mask thật, thiết bị thật, mask vector hóa có khe hở > 2.5 px, mask có lỗ, hoặc ảnh có hàng nghìn polygon.
- Đỉnh của mask khác nằm giữa cạnh (chỗ nối chữ T) được dùng làm đỉnh của polygon mới nhưng không chèn vào mask có cạnh đó; nếu hai mask cũ hở nhau vài px, biên mới có thể lệch tối đa ~2.5 px so với một trong hai.
- Lớp phủ màu theo label/độ mờ viền (cùng nhánh): canvas đã kiểm bằng Chrome headless (cảnh `?labels=1`); thẻ tùy chọn trong `editor-workspace.tsx` chỉ được kiểm bằng ảnh chụp trang tĩnh dựng từ CSS thật, **chưa** thử trong editor thật (cần đăng nhập + DB), ảnh khổ qua thật, Safari/Firefox. Chưa có chú giải (legend) màu ↔ label trong panel.
- Các hàm của thuật toán cũ không còn được canvas dùng nhưng vẫn export và có test: `getSharedBoundaryAutofillPath`, `getCachedCollectivePolygon`, `getConnectedPolygonCluster`, `arePolygonsConnected`, `polygonDistanceToDraft`. Xóa chúng cần người dùng đồng ý (xóa kèm test).

## Môi trường kiểm thử và lưu ý cho agent sau

- Working tree đã có thay đổi từ trước ở README, globals.css, editor-canvas.tsx, editor-workspace.tsx và docs. Không reset hoặc ghi đè toàn bộ các file này.
- Snapshot `src` trước phiên sửa nằm tại `artifacts/before-update/src/` (file TS/TSX đổi đuôi `.bak` để không bị typecheck/lint như source). Artifacts bị gitignore, chỉ có ở workspace này.
- Các test mới: `src/lib/lock-service.test.ts`, `wart-points.test.ts`, `export-service.test.ts`. Lock test dùng PGlite memory; export test mock DB/Drive, không tải lên cloud.
- Dev server thử nghiệm port 3100 đã được dừng khi bàn giao. Chỉ gọi `/api/health`, chưa seed, chưa chạy API mutation E2E.
- `/api/health` chỉ kiểm tra cờ cấu hình Postgres/Blob nên có thể trả 503 khi cố ý chạy PGlite/filesystem; không đủ để kết luận local database hỏng.
- `.env` và `.env.local` có cấu hình production thật. Không gọi `/api/seed` hoặc test mutation trước khi xác minh kết nối đã cách ly. PowerShell gán env chuỗi rỗng có thể xóa biến và khiến Next tải lại `.env`; gọi `@next/env` trước rồi mới override cũng có thể bị cache env khôi phục. Script hỗ trợ local `artifacts/run-isolated-dev.cjs` đã bỏ bước load env trước override; vẫn phải kiểm tra lại isolation trước mutation. Không chép secret vào tài liệu/log.

## Tương thích prelabel — cập nhật 2026-10-30

`prelabel-service.ts` đọc schema `bitter-melon-prelabel-1.0` và `1.1`, nhãn legacy hoặc instance `rN`/`wN`, giữ nguyên hình học và metadata. API editor trả `422 INVALID_ANNOTATION` nếu prelabel không hợp lệ và vẫn bỏ qua prelabel khi đã có annotation lưu trên server. Không đổi schema DB hoặc storage backend. Xem [PRELABEL_COMPATIBILITY.md](PRELABEL_COMPATIBILITY.md).

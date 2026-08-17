# UI Style Guide – Annotation Tool (Light Mode)

## 1. Mục tiêu thiết kế

Tài liệu này mô tả **style chung cho giao diện tool annotation** theo định hướng:

- **Light mode**
- **Hiện đại, sạch, thân thiện với non-tech**
- **Giảm cảm giác “vibe code/tool kỹ thuật”**
- **Ưu tiên dễ dùng, dễ scan, ít nhiễu**
- **Không over-design, không nhồi quá nhiều thông tin**
- **Tập trung vào thao tác chính: chọn file → thao tác trên canvas → xác nhận bước**

Giao diện cần tạo cảm giác:

- sáng, nhẹ, rõ ràng
- thao tác nhanh
- người mới nhìn vào vẫn hiểu được luồng làm việc
- các công cụ luôn ở vị trí dễ đoán, không làm rối màn hình

---

## 2. Nguyên tắc UI tổng thể

### 2.1. Nguyên tắc chính

1. **Canvas là trung tâm**
   - Mắt người dùng phải tập trung vào ảnh/canvas trước tiên.
   - Mọi thành phần khác chỉ đóng vai trò hỗ trợ.

2. **Thông tin vừa đủ**
   - Chỉ hiển thị những gì cần cho bước hiện tại.
   - Tránh hiển thị đồng thời quá nhiều action, text hướng dẫn dài, trạng thái phụ.

3. **Ưu tiên quét nhanh bằng mắt**
   - Group nội dung theo block/card rõ ràng.
   - Có thứ bậc thị giác: tiêu đề > trạng thái > action > mô tả phụ.

4. **Tách rõ vùng thao tác**
   - Sidebar trái: điều hướng, file, user info
   - Canvas giữa: nội dung chính
   - Toolbar nổi cạnh canvas: công cụ thao tác
   - Sidebar phải: thiết lập và thông tin task hiện tại

5. **Thao tác quen thuộc**
   - Double click để hoàn thành polygon
   - Enter để hoàn thành polygon
   - Esc để hủy
   - Delete để xóa điểm/vùng đang chọn
   - Hints/shortcuts cần hiển thị tự nhiên, không quá áp lực

---

## 3. Design language

### 3.1. Tính cách thị giác

Style nên theo hướng:

- mềm, sáng, gọn
- bo góc nhẹ
- icon line rõ ràng
- accent tím nhạt / indigo dịu
- cảm giác “productivity tool” hơn là “dev tool”

### 3.2. Những gì cần tránh

- nền xanh đen / dark navy kiểu IDE
- quá nhiều viền mạnh
- quá nhiều badge, trạng thái cùng lúc
- quá nhiều text hướng dẫn dài trên màn hình
- nhiều khu vực cạnh tranh sự chú ý
- shadow quá đậm
- icon quá nhỏ hoặc quá “technical”

---

## 4. Màu sắc

## 4.1. Core palette

### Primary
- `Primary / 500`: **#7C5CFA**
- `Primary / 600`: **#6D4EF2**
- `Primary / 100`: **#EEE9FF**
- `Primary / 50`: **#F6F3FF**

### Neutral
- `Gray / 0`: **#FFFFFF**
- `Gray / 25`: **#FCFCFD**
- `Gray / 50`: **#F8F9FC**
- `Gray / 100`: **#F1F3F7**
- `Gray / 200`: **#E6EAF2**
- `Gray / 300`: **#D5DCE8**
- `Gray / 400`: **#98A2B3**
- `Gray / 500`: **#667085**
- `Gray / 700`: **#344054**
- `Gray / 900`: **#101828**

### Success
- `Success / 500`: **#12B76A**
- `Success / 50`: **#ECFDF3**

### Warning
- `Warning / 500`: **#F79009**
- `Warning / 50`: **#FFFAEB**

### Error
- `Error / 500`: **#F04438**
- `Error / 50`: **#FEF3F2**

### Info
- `Info / 500`: **#2E90FA**
- `Info / 50`: **#EFF8FF**

---

## 4.2. Quy tắc dùng màu

### Màu nền
- App background: `Gray / 25`
- Card background: `Gray / 0`
- Canvas panel background: `Gray / 0`
- Input background: `Gray / 0`

### Màu chữ
- Heading chính: `Gray / 900`
- Body text: `Gray / 700`
- Secondary text: `Gray / 500`
- Disabled text: `Gray / 400`

### Accent
- Chỉ dùng `Primary` cho:
  - tab active
  - button primary
  - trạng thái đang chọn
  - selected tool
  - focus ring
  - điểm nhấn điều hướng

### Border
- Border mặc định: `Gray / 200`
- Border hover/focus: `Primary / 300` hoặc `Primary / 500`
- Tránh border quá đậm

### Annotation overlay
- Polygon fill: `rgba(124, 92, 250, 0.20 ~ 0.28)`
- Polygon stroke: `#7C5CFA`
- Selected polygon: stroke đậm hơn + point handles rõ hơn
- Breakpoint marker: dùng tím hoặc xanh dương nhẹ, không dùng đỏ trừ khi là lỗi

---

## 5. Typography

### 5.1. Font
Ưu tiên font sans hiện đại, dễ đọc:

- `Inter`
- fallback: `system-ui, sans-serif`

### 5.2. Cấp chữ

#### Display / Header filename
- Size: `24px`
- Weight: `600`

#### Section title
- Size: `18px`
- Weight: `600`

#### Card title / Block title
- Size: `16px`
- Weight: `600`

#### Body text
- Size: `14px`
- Weight: `400`

#### Secondary / note / helper
- Size: `13px`
- Weight: `400`

#### Small caption
- Size: `12px`
- Weight: `500`

### 5.3. Quy tắc typography
- Hạn chế quá nhiều cỡ chữ
- Chỉ cần 4–5 cấp
- Dùng weight để tạo hierarchy, không lạm dụng màu
- Text hướng dẫn nên ngắn, chia dòng dễ scan

---

## 6. Spacing, radius, shadow

### 6.1. Spacing scale
Dùng hệ 4px:

- 4
- 8
- 12
- 16
- 20
- 24
- 32

### 6.2. Radius
- Input / Button / Tag: `12px`
- Card: `16px`
- Modal / popover: `20px`
- Floating toolbar: `18–20px`

### 6.3. Shadow
Giữ shadow nhẹ:

- Card: `0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)`
- Floating panel: `0 8px 24px rgba(16,24,40,0.08)`

Không dùng shadow quá sâu hoặc blur nặng.

---

## 7. Layout tổng thể

## 7.1. Bố cục chuẩn

Giao diện chia 3 vùng chính:

### A. Left sidebar
Chứa:
- dự án / bộ dữ liệu hiện tại
- quy trình bước làm
- file hiện tại
- danh sách file
- nút trợ giúp
- thông tin user ở cuối sidebar

### B. Main canvas area
Chứa:
- header tối giản phía trên
- canvas lớn ở giữa
- floating zoom control bên phải canvas
- floating tool bar dọc cạnh canvas
- hint bar nhỏ phía dưới canvas

### C. Right sidebar
Chứa:
- thiết lập nhiệm vụ
- tab bước hiện tại
- lớp đối tượng
- trạng thái
- action theo ngữ cảnh
- thông tin đối tượng

---

## 7.2. Header tối giản

### Mục tiêu
Header chỉ giữ những gì thật sự cần.

### Thành phần nên có
- Logo + tên sản phẩm (góc trái)
- Tên file hiện tại ở giữa hoặc gần giữa
- Trạng thái lưu + nút Lưu (góc phải)

### Không nên có
- user info trên top navbar
- quá nhiều action phụ
- breadcrumb dài dòng
- nav phụ không cần thiết

### Lưu ý
- **Thông tin tài khoản người dùng phải để ở cuối left sidebar**
- **Xóa user info khỏi navbar**

---

## 7.3. Sidebar trái

### Vai trò
Là vùng điều hướng và quản lý file.

### Thành phần đề xuất

#### 1. Project card
- tên dự án
- mô tả ngắn như “Bộ dữ liệu hiện tại”
- click để đổi bộ dữ liệu / điều hướng

#### 2. Quy trình
Hiển thị từng bước rõ ràng:
- Vùng chọn
- Điểm ngắt

Mỗi item gồm:
- số thứ tự
- tên bước
- trạng thái ngắn (đã xác định vùng / đã xác định điểm)

#### 3. Tệp hiện tại
Card nhấn nhẹ:
- tên file
- tiến trình dạng `1/28`

#### 4. Danh sách tệp
- search input
- list file dọc
- item active có background tím nhạt
- item chưa active dùng nền trắng hoặc xám rất nhạt

#### 5. Trợ giúp
Card/nút “Trợ giúp phím tắt”

#### 6. User profile ở đáy sidebar
- avatar tròn
- tên
- vai trò (ví dụ: Người chú thích)
- trạng thái online nhỏ nếu cần
- menu dropdown gọn

### Tính năng
- Có thể **toggle collapse** sidebar trái
- Khi collapse chỉ còn icon + tooltip
- Toggle button đặt ở mép sidebar

---

## 7.4. Canvas area

### Vai trò
Là khu vực trọng tâm.

### Style
- background panel trắng
- canvas frame bo góc lớn
- nền grid rất nhạt
- vùng canvas chiếm tối đa diện tích

### Quy tắc
- padding thoáng
- không đặt quá nhiều control đè lên canvas
- control nổi phải gọn, không che nội dung chính

---

## 7.5. Right sidebar

### Vai trò
Hiển thị thiết lập của task hiện tại.

### Nội dung đề xuất

#### 1. Tiêu đề
`Thiết lập nhiệm vụ`

#### 2. Step tabs
- `Vùng chọn`
- `Điểm ngắt`

Tab active:
- nền tím nhạt
- border tím
- text tím đậm

#### 3. Hướng dẫn
Text ngắn, dạng từng câu:
- Nhấp để bắt đầu vẽ polygon.
- Kéo để tạo vùng.
- Nhấp đúp hoặc nhấn Enter để hoàn tất.

#### 4. Lớp đối tượng
- dropdown chọn class
- rõ ràng, đủ lớn để non-tech hiểu

#### 5. Trạng thái
- hiển thị ngắn: Đã xác nhận / Chưa xác nhận / Đang chỉnh sửa

#### 6. Action theo ngữ cảnh
Ví dụ:
- Xóa đối tượng đang chọn
- Thêm điểm
- Xóa điểm

Chỉ hiển thị action phù hợp với trạng thái hiện tại, tránh overload.

#### 7. Thông tin đối tượng
- hiển thị khi có object selected
- nếu chưa chọn gì thì hiện empty state ngắn

### Tính năng
- Có thể **toggle collapse** sidebar phải
- Giữ logic tương tự sidebar trái

---

## 8. Toolbar và control trên canvas

## 8.1. Zoom control

### Quy định
- **Chỉ giữ 1 cụm zoom**
- Vị trí: **góc trên bên phải của canvas**
- Hiển thị:
  - `+`
  - `% zoom hiện tại`
  - `-`

### Không được
- không hiển thị zoom thêm ở giữa dưới canvas
- không duplicate control

---

## 8.2. Tool bar dọc

### Vị trí
- đặt dọc cạnh phải của canvas, bên dưới zoom control
- dạng floating pill/card

### Mục tiêu
Giúp người dùng chuyển công cụ nhanh, dễ hiểu.

### Tool gợi ý
Theo thứ tự từ trên xuống:

1. **Select / Cursor**
2. **Pan / Hand**
3. **Polygon**
4. **Breakpoint / Marker**
5. **Split / Edit points** (nếu có)
6. Divider
7. **Undo**
8. **Redo**
9. Divider
10. **Delete**

### Style
- icon line, đồng bộ nét
- active tool: nền `Primary / 100`, icon `Primary / 600`
- hover: nền xám nhạt
- có tooltip khi hover

### Yêu cầu UX
- Dễ chuyển đổi giữa các tool
- Icon phải dễ hiểu với non-tech
- Có nhãn tooltip rõ ràng

---

## 8.3. Hint bar dưới canvas

### Vai trò
Nhắc thao tác quan trọng trong ngữ cảnh hiện tại.

### Ví dụ
Khi đang vẽ polygon:
- `Nhấp đúp để hoàn thành polygon`
- `Nhấn Enter để hoàn thành`

### Style
- thanh nhỏ, nổi nhẹ
- bo tròn
- chữ ngắn, dễ scan
- có icon info nhỏ bên trái
- có nút `x` để đóng

### Lưu ý
Không dùng hint bar để nhồi nhiều text.

---

## 9. Component rules

## 9.1. Button

### Primary button
Dùng cho action chính:
- ví dụ: `Hoàn tất & Tiếp theo`, `Lưu`

Style:
- background `Primary / 500`
- text trắng
- hover `Primary / 600`
- radius `12px`
- height `40–44px`

### Secondary button
Dùng cho action phụ:
- nền trắng
- border `Gray / 200`
- text `Gray / 700`

### Destructive button
- nền trắng hoặc hồng rất nhạt
- border đỏ nhạt
- text đỏ

---

## 9.2. Card

Card dùng cho:
- project
- current file
- help
- user profile
- panel sections

Style:
- nền trắng
- viền xám nhạt
- bo 16px
- padding 16px

---

## 9.3. Input / Search

Style:
- height 40px
- nền trắng
- border `Gray / 200`
- icon search bên trái
- focus ring tím nhạt

Placeholder:
- ngắn, rõ ràng
- ví dụ `Tìm tệp...`

---

## 9.4. Dropdown

Style:
- như input
- icon mũi tên bên phải
- option item đủ cao, dễ click

---

## 9.5. Tabs

Dùng cho:
- `Vùng chọn`
- `Điểm ngắt`

Style:
- dạng segmented control hoặc pill tabs
- active rõ ràng nhưng nhẹ

---

## 9.6. Status badge

Dùng hạn chế.
Ví dụ:
- Đã xác nhận
- Chưa xác nhận
- Đang chỉnh sửa

Style:
- small pill
- nền màu rất nhạt
- text màu tương ứng

Không nên dùng badge quá nhiều trong cùng một màn hình.

---

## 10. Shortcut & help UI

## 10.1. Nút trợ giúp

### Vị trí
- góc trái dưới trong sidebar trái
- icon `?`

### Mục tiêu
Người dùng bấm vào sẽ mở panel/modal hướng dẫn đẹp và dễ hiểu.

---

## 10.2. Modal / popover phím tắt

### Nội dung
Chia 2 tab hoặc 2 section:
1. **Phím tắt**
2. **Mẹo sử dụng**

### Các shortcut nên có
- `H`: Di chuyển (Pan)
- `P`: Vẽ Polygon
- `M`: Điểm ngắt
- `Enter`: Hoàn thành polygon
- `Esc`: Hủy thao tác
- `Delete`: Xóa điểm / đối tượng đang chọn
- `Ctrl + Z`: Hoàn tác
- `Ctrl + Y`: Làm lại

### Mẹo sử dụng
- Nhấp để thêm điểm
- Kéo điểm để chỉnh polygon
- Nhấp đúp để hoàn thành polygon
- Nhấn Enter để hoàn thành polygon
- Chọn đối tượng để xem chi tiết ở panel phải

### Style
- không quá kỹ thuật
- có icon minh họa nhẹ
- dùng card nhỏ / list rõ ràng
- dễ scan

---

## 11. Interaction rules

## 11.1. Polygon interaction

### Yêu cầu bắt buộc
- Bắt đầu vẽ bằng click
- Thêm đỉnh bằng click
- Kéo để chỉnh đỉnh
- **Double click để hoàn thành polygon**
- **Nhấn Enter để hoàn thành polygon**
- Esc để hủy polygon đang vẽ

### Hiển thị khi đang vẽ
- preview line tới điểm tiếp theo
- điểm đầu nên được highlight nhẹ
- hint bar phía dưới hiện hướng dẫn hoàn thành

---

## 11.2. Selection interaction
- object selected phải có stroke rõ hơn
- handles hiện đủ rõ
- panel phải cập nhật thông tin object

---

## 11.3. Undo / redo
- luôn dễ truy cập từ toolbar
- nên có shortcut
- trạng thái disabled khi không khả dụng

---

## 11.4. Delete interaction
- Delete trên toolbar
- phím Delete
- nếu action nguy hiểm, có thể confirm nhẹ trong vài trường hợp lớn
- với xóa điểm nhỏ có thể không cần modal confirm

---

## 12. Responsive & collapse behavior

## 12.1. Sidebar toggle
Cả left và right sidebar cần có khả năng:
- mở rộng
- thu gọn

### Khi thu gọn
- left sidebar: còn icon + tooltip
- right sidebar: ẩn hoàn toàn hoặc thu nhỏ thành rail mỏng với nút mở lại

### Mục tiêu
Tăng diện tích canvas khi người dùng cần tập trung.

---

## 12.2. Màn hình vừa
Nếu chiều ngang hẹp:
- ưu tiên giữ canvas lớn
- right sidebar có thể chuyển thành drawer
- left sidebar có thể collapse trước

---

## 13. Nội dung text trong UI

## 13.1. Tone of voice
- ngắn
- rõ
- dễ hiểu
- không technical quá mức

### Ví dụ tốt
- `Nhấp để bắt đầu vẽ polygon`
- `Nhấp đúp hoặc nhấn Enter để hoàn tất`
- `Chọn một đối tượng để xem chi tiết`

### Tránh
- câu quá dài
- jargon kỹ thuật
- mô tả lặp lại

---

## 14. Danh sách component FE cần triển khai

FE nên tách component rõ ràng để tái sử dụng:

### Shell
- `AppHeader`
- `LeftSidebar`
- `RightSidebar`
- `CanvasWorkspace`

### Sidebar
- `ProjectCard`
- `ProcessStepList`
- `CurrentFileCard`
- `FileList`
- `HelpCard`
- `UserProfileCard`

### Canvas tools
- `ZoomControl`
- `VerticalToolBar`
- `CanvasHintBar`

### Panels
- `TaskPanel`
- `StepTabs`
- `ObjectClassSelect`
- `StatusBlock`
- `ObjectInfoPanel`

### Shared UI
- `Button`
- `IconButton`
- `Input`
- `Dropdown`
- `Badge`
- `Card`
- `Tooltip`
- `Modal`
- `ShortcutModal`

---

## 15. Trạng thái component

Mỗi component cần có đầy đủ state:

- default
- hover
- active
- focus
- selected
- disabled
- empty
- loading (nếu cần)

Đặc biệt với:
- tool buttons
- file list item
- tabs
- dropdown
- object selected state

---

## 16. Accessibility cơ bản

Cần đảm bảo:
- contrast đủ đọc
- vùng click không quá nhỏ
- keyboard usable
- focus state rõ
- tooltip/hint dễ hiểu

Kích thước click tối thiểu:
- `40x40px` cho icon buttons quan trọng

---

## 17. Do / Don’t cho FE

## Do
- ưu tiên khoảng trắng
- giữ layout sạch
- canvas luôn là điểm nhấn
- dùng accent tím có kiểm soát
- group action theo ngữ cảnh
- thêm tooltip cho icon tool
- hỗ trợ toggle sidebar
- chỉ giữ 1 cụm zoom ở góc phải trên canvas
- đặt user info ở đáy left sidebar
- có shortcut modal từ nút `?`

## Don’t
- không dùng dark header/nav kiểu code editor
- không hiển thị user info ở top navbar
- không lặp zoom control ở nhiều nơi
- không nhồi text hướng dẫn dài
- không tạo quá nhiều button chính cạnh nhau
- không làm toolbar quá dày đặc
- không dùng màu mạnh ở mọi nơi

---

## 18. Tóm tắt yêu cầu quan trọng cần bám đúng

1. **Style light mode, sạch, hiện đại, thân thiện non-tech**
2. **Canvas là trung tâm**
3. **Header tối giản**
4. **User info chuyển hết xuống cuối left sidebar**
5. **Zoom chỉ hiển thị 1 chỗ ở góc trên bên phải canvas**
6. **Có toolbar dọc cạnh canvas để chuyển tool thuận tiện**
7. **Polygon phải hoàn thành được bằng double click hoặc Enter**
8. **Có toggle left/right sidebar**
9. **Có nút `?` mở UI phím tắt/hướng dẫn đẹp**
10. **Không để giao diện bị rối hoặc quá nhiều block không cần thiết**

---

## 19. Hướng triển khai UI mong muốn

Nếu FE implement theo đúng tài liệu này, giao diện cuối cùng nên cho cảm giác:

- giống một productivity tool hiện đại
- nhẹ, sạch, sáng
- không intimidate người dùng mới
- trực quan cho tác vụ annotation
- dễ mở rộng thêm class, tool, workflow sau này
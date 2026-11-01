## 1. Mục tiêu chính

Đang xây pipeline xử lý ảnh **khổ qua** để phát hiện **rãnh nứt / groove** và từ đó tạo:

```python
primitive_flesh = fruit_mask & ~groove_barrier
```

Trong đó:

```text
line_final      = đường tâm rãnh
groove_barrier  = vùng rãnh có độ rộng
primitive_flesh = phần thịt quả còn lại
```

Mục tiêu hiện tại **chưa phải semantic**, chưa cần phân loại `wart/ridge/flesh type`, chưa cần instance hoàn chỉnh.

Hiện tại **tạm bỏ SAM qua một bên** để làm thật tốt phần CV/local groove extraction trước.

---

## 2. Runtime và môi trường

Chạy trên:

```text
Google Colab
Python 3.13
GPU
Google Drive
```

Dataset:

```python
ROOT = Path("/content/drive/MyDrive/TGMT-KLTN/dataset-crop")
```

Mỗi folder là một loại quả, ví dụ:

```text
8582
8769
8884
8964
8993
DC3
Draco
TVI8573
TVI8711
TVI8909
VIN005
```

Trong giai đoạn test:

```text
mỗi folder chỉ lấy 1 ảnh đầu tiên
```

Không cần ghi hàng loạt mask/debug file xuống Drive. Chủ yếu **show trực tiếp trong notebook**.

### Lỗi môi trường đã gặp, không được lặp lại

Python 3.13 **không dùng**:

```text
numpy==1.26.4
pandas==2.2.2
scikit-image==0.24.0
```

Đã từng gây lỗi NumPy/SciPy binary mismatch.

Nếu sau này dùng SAM3, từng gặp lỗi:

```text
RuntimeError:
mat1 and mat2 must have the same dtype,
but got BFloat16 and Float
```

Phải chạy SAM3 forward trong:

```python
with torch.autocast(
    device_type="cuda",
    dtype=torch.bfloat16
):
    ...
```

Nhưng **hiện tại chưa làm SAM**.

---

# 3. Nguyên tắc kiến trúc quan trọng nhất

## Không được xử lý cả quả bằng một pattern duy nhất

Các giống khổ qua có morphology rất khác nhau:

```text
rãnh dài rõ
rãnh yếu
nhiều u/vấu
khổ qua rừng
thân quả toàn gai
rãnh sáng/tối không đồng đều
```

Do đó:

```text
GLOBAL threshold = không đủ
GLOBAL pattern = sai
GLOBAL Frangi = dễ sai
```

Phải ưu tiên:

```text
local patch
local threshold
local scale
local minima
local valley
local structure
```

Mỗi vùng của cùng một quả cũng có thể cần scale/ngưỡng khác nhau.

---

# 4. Flow tổng thể đang hướng tới

```text
RGB
↓
fruit mask
↓
crop toàn quả
↓
normalize kích thước quả
↓
LOẠI GLARE / NHIỄU SÁNG TRƯỚC
↓
illumination normalization
↓
local patch processing
↓
multi-scale DoG
↓
dark residual
↓
local directional minima
↓
structure tensor chỉ lấy hướng
↓
directional NMS
↓
local watershed / connectivity
↓
local Frangi guide nếu phù hợp
↓
base groove candidate
↓
local seed growth / rescue
↓
line_final
↓
groove_barrier
↓
primitive_flesh
```

---

# 5. Glare / nhiễu sáng

Đây là bước **bắt buộc phải làm trước mọi feature groove**.

Không được:

```text
tính DoG / gradient / Frangi trên ảnh glare gốc
rồi mới mask glare sau
```

Phải:

```text
detect glare
→ glare halo
→ repair / inpaint
→ sau đó mới extract groove features
```

Glare detect hiện dựa trên:

```text
brightness
local bright residual
low saturation
```

Tín hiệu glare chỉ dùng để sửa ảnh.

### Heuristic sáng đặc biệt

Không phải mọi đường sáng đều là noise.

```text
bright line trên phần thịt
→ noise
→ loại

bright line nằm trong/ngay trên rãnh tối
→ có thể là reflection trên groove
→ dùng làm tín hiệu hỗ trợ nối rãnh
```

Nhưng bright signal **không được tự tạo groove**.

---

# 6. Gradient

Nguyên tắc rất rõ:

```text
gradient KHÔNG phải mask
```

Gradient chỉ dùng:

```text
ước lượng orientation
structure tensor
directional NMS
guide hướng
```

Không dùng gradient trực tiếp để quyết định:

```text
pixel này là groove
```

---

# 7. Local minima

Đây là tín hiệu rất quan trọng.

Rãnh không phải lúc nào cũng đen rõ. Có đoạn chỉ:

```text
hơi tối hơn local neighborhood
có depression yếu
có local contrast thấp
```

Do đó cần kiểm tra:

```text
pixel có phải local minimum theo một hướng nào đó không?
```

Không chỉ minima 2D tuyệt đối.

Nên dùng dạng:

```text
center thấp hơn hai pixel hai phía
theo nhiều hướng
ở nhiều scale
```

Ví dụ các hướng:

```text
0°
±15°
±30°
±45°
90°
```

Tạo:

```python
directional_valley_score
```

rồi dùng nó làm evidence.

---

# 8. Multi-scale DoG

DoG rất quan trọng để bắt:

```text
rãnh mảnh
rãnh dày
rãnh yếu
cấu trúc ở các scale khác nhau
```

Không dùng một sigma cố định.

Scale phải phụ thuộc:

```text
fruit size
local patch size
local morphology
```

Kết quả có:

```python
dog_score
sigma_map
```

---

# 9. Local winning scale

`Local winning scale` là map rất hữu ích và người dùng đánh giá nó đang thể hiện cấu trúc khá đúng.

Ý nghĩa:

```text
ở mỗi pixel:
scale nào cho response mạnh nhất
```

Nó **không phải groove mask**.

Không được:

```python
groove = sigma_vote > threshold
```

Vai trò đúng của `sigma_vote`:

```text
chỉ chỗ đáng kiểm tra local
chọn sigma local
chọn kích thước ROI
chọn bề rộng corridor
chọn scale cho DoG / blackhat / Frangi
kiểm tra scale consistency
```

Điểm rất quan trọng:

Nếu:

```text
line hiện tại bị đứt
nhưng local winning scale vẫn có response rõ
```

thì đó là tín hiệu:

```text
hãy mở ROI local tại đó và re-detect groove
```

Chứ **không thêm trực tiếp vùng sigma map vào mask**.

---

# 10. Frangi

Quan điểm đã thay đổi qua nhiều version.

## Với khổ qua thường

Frangi có thể dùng nhưng:

```text
Frangi = guide / bridge support
không phải output mask
```

Không được:

```python
groove = frangi > threshold
```

Vì Frangi dễ bắt:

```text
texture
vết sần
u/vấu
reflection edge
```

## Với 8964 và 8993

Hai giống này toàn thân có rất nhiều gai/u/vấu.

Ở đây Frangi thường:

```text
bắt sai texture
làm mất khe rãnh
```

Do đó pipeline riêng cho 2 giống này phải:

```text
giảm mạnh Frangi
hoặc bỏ Frangi
```

Ưu tiên:

```text
local directional minima
dark residual
DoG
blackhat
local connectivity
seed growth
```

---

# 11. Hai nhóm xử lý

Đã chốt nên tách thành 2 notebook.

## Notebook khổ qua thường

Các folder trừ:

```text
8964
8993
```

Có thể dùng:

```text
DoG
dark residual
directional minima
Frangi nhẹ
NMS
local connectivity
```

Notebook mới nhất:

[23_colab313_common_bittermelon_local_directional_growth.ipynb](sandbox:/mnt/data/23_colab313_common_bittermelon_local_directional_growth.ipynb)

---

## Notebook riêng cho 8964 + 8993

Đây là loại nhiều gai/u/vấu.

Ưu tiên:

```text
local minima
directional valley
dark residual
DoG
blackhat
local threshold
candidate growth
```

Giảm hoặc bỏ Frangi.

Notebook mới nhất:

[24_colab313_8993_8964_tuberculate_local_minima_growth.ipynb](sandbox:/mnt/data/24_colab313_8993_8964_tuberculate_local_minima_growth.ipynb)

---

# 12. Cách “lan” groove đúng

Ý tưởng người dùng muốn:

```text
đã có một số pixel/rãnh khá chắc chắn
↓
coi chúng là candidate seed
↓
nhìn pixel xung quanh
↓
pixel xung quanh có phải cực tiểu local không?
↓
có dark support không?
↓
có multi-scale support không?
↓
có cùng trajectory không?
↓
nếu có thì thêm
↓
tiếp tục lan
```

Tức là giống:

```text
region growing có điều kiện
```

chứ không phải:

```text
vẽ line nối hai điểm
```

---

# 13. Tuyệt đối không tạo đường giả

Đã có 2 lỗi lớn.

## Lỗi V20

Pair endpoint → shortest path.

Kết quả:

```text
nhiều đường dọc thẳng giả
```

Sai hoàn toàn.

## Lỗi V21

Mọi skeleton endpoint đều được phép kéo dài.

Kết quả:

```text
yellow line giả trên flesh
```

Sai.

---

# 14. Định nghĩa đầu/đuôi line

Nếu cần dùng endpoint:

```text
LEFT endpoint
RIGHT endpoint
```

theo:

```text
chiều ngang x
```

Không phải:

```text
top / bottom
```

Người dùng xác nhận rõ:

```text
trái → phải
```

Nếu một line cong thì y được thay đổi nhẹ, nhưng progression chính phải theo x.

Không được sinh:

```text
vertical extension
```

---

# 15. Horizontal guide chỉ dùng để LOCALIZE

Đây là rule rất quan trọng.

Nếu từ endpoint vẽ một đường/hướng sang trái/phải:

```text
đó chỉ là guide để xác định ROI cần nhìn kỹ
```

Không được:

```python
line_final |= search_guide
```

Phải:

```text
search guide
→ mở ROI
→ chạy lại detector
→ có tín hiệu thật thì lấy đúng pixel đó
→ không có tín hiệu thì STOP
```

Nếu vùng phía trước hoàn toàn sạch:

```text
không thêm pixel nào
```

---

# 16. Seed growth / local propagation

Cách đang hướng tới:

```text
base_line
↓
dilate rất nhỏ
↓
candidate neighborhood
↓
local evidence
↓
local threshold
↓
candidate phải touch current line
↓
binary propagation / region growing
↓
thêm pixel
↓
lặp 2–3 pass
```

Không dùng:

```text
shortest path xuyên qua vùng trắng
```

---

# 17. Local evidence nên gồm

Cho từng ROI/patch:

```text
DoG dark
dark residual
directional local minima
blackhat
Frangi guide nếu phù hợp
local NMS
local winning scale consistency
previous local valley vote
```

Các score có thể fuse adaptively.

Không nên dùng fixed weights cứng nếu tránh được.

---

# 18. Threshold

User yêu cầu:

```text
không fixed cứng threshold
```

Ưu tiên:

```text
Otsu
Multi-Otsu
local threshold
percentile theo local ROI
noise-dependent threshold
h-minima theo local noise
```

Threshold nên tính:

```text
theo patch
theo ROI
theo từng vùng
```

Không áp:

```text
1 threshold cho toàn quả
```

---

# 19. Fruit mask / lỗi mất thịt viền

Một lỗi quan trọng:

```text
phần thịt ở rìa quả bị mất trong primitive flesh
```

Đặc biệt vùng tối ở cạnh quả dễ bị fruit mask cắt.

Phải cải thiện `fruit_mask` bằng:

```text
strong + weak threshold
hysteresis / propagation
green dominance / ExG support
largest component
fill holes
rim rescue
```

Không được chỉ:

```python
fruit = value > otsu
```

vì dễ cắt mất rìa tối.

Sau khi tạo primitive flesh cũng nên có:

```text
rim flesh protection
```

nhưng chỉ bảo vệ phần rìa không có evidence groove thật.

---

# 20. Primitive flesh

Output cuối để convert thành **mask flesh tổng** là:

```python
R["primitive"]
```

Trong đó:

```text
255 = flesh
0   = groove + background
```

Nhưng nhớ:

```text
Primitive flesh chưa phải instance mask.
```

Nếu sau này muốn:

```text
mỗi dải/gờ thịt liên tục = 1 instance
```

thì cần stage sau.

---

# 21. Output phải show

Không xuất quá nhiều file.

Mỗi sample chỉ cần show:

## Overall

```text
Fruit crop
Glare repaired + normalized
Guide / base + grown pixels
Final crack line
Primitive flesh
Primitive mask overlay
```

## Explain

Nên có:

```text
Merged valley evidence
Local winning scale
Directional local minima
Base + grown pixels
text debug
```

---

# 22. Mask overlay

Người dùng yêu cầu phải có:

```text
Primitive mask overlay trên RGB
```

để kiểm tra phần:

```text
flesh bị mất
flesh bị thừa
rãnh ăn nhầm
rìa bị xóa
```

---

# 23. Color guide đã dùng

Trong overlay debug:

```text
cyan   = base groove candidate
yellow = pixel mới được local detector thực sự thêm
red    = bright-on-flesh / reject
```

Nhưng yellow chỉ hợp lệ nếu là:

```text
pixel feature thật
```

Không phải:

```text
predicted line
search direction
route
```

---

# 24. Bright red overlap rule

Nếu một bright pixel đang nằm trong/ngay gần dark groove/cyan:

```text
không được gọi nó là bright-on-flesh red
```

Rule:

```python
bright_on_flesh &= ~cyan_zone
```

Tức:

```text
cyan context ưu tiên hơn red
```

---

# 25. V19 là baseline tốt cần giữ

Một nguyên tắc quan trọng từ feedback:

> Không được thay đổi hoàn toàn kiến trúc mỗi lần sửa.

V19 được user đánh giá có:

```text
Local winning scale tốt
Primitive flesh tương đối đúng
local processing đúng hướng
```

Các phiên bản sau nếu cải thiện phải:

```text
giữ V19 base
+ thêm module nhỏ
```

Không nên:

```text
rewrite toàn bộ
```

nếu chưa chứng minh tốt hơn.

---

# 26. Các version và bài học

```text
V13/V14
glare cleanup + primitive flesh

V15
Python 3.13 environment fix

V16
Primitive flesh → SAM3

V17
bright-on-dark bridge heuristic

V18
SAM3 BF16 autocast fix

V19
local patch + valley + watershed + Frangi
→ baseline local tốt

V20
endpoint pair + shortest path
→ SAI, tạo vertical lines

V21
endpoint extension
→ vẫn SAI, tạo nhiều yellow fake lines

V22
horizontal localization rescue
→ đúng ý hơn nhưng local winning scale chưa được tận dụng chủ động đầy đủ

V23
khổ qua thường:
local directional minima + seed growth

V24
8964/8993:
tuberculate local minima growth, giảm Frangi
```

---

# 27. Hướng tiếp theo nên làm

Ưu tiên làm thật tốt 2 notebook V23/V24 trước.

### Với khổ qua thường

Dùng:

```text
base groove candidate
+
local winning scale
+
directional minima
+
DoG
+
dark residual
+
Frangi nhẹ
→ local growth
```

### Với 8964/8993

Dùng:

```text
base candidate
+
directional minima
+
dark residual
+
DoG
+
blackhat
+
local winning scale
→ local growth
```

Frangi:

```text
rất nhẹ hoặc bỏ
```

### Logic rescue mới nên là

```text
line bị thiếu
+
sigma_vote vẫn có cấu trúc
+
valley/minima support yếu nhưng tồn tại
→ mở ROI local
→ re-run detector
→ chỉ thêm connected real feature pixels
```

Không:

```text
sigma_vote → mask
```

Không:

```text
endpoint → vẽ đường
```

Không:

```text
endpoint pair → shortest path
```

---

# 28. Câu lệnh ngắn cho LLM tiếp theo

Có thể copy nguyên đoạn này:

> Hãy tiếp tục từ V23 và V24. Không làm lại toàn bộ pipeline. Giữ V19/V23/V24 làm baseline. Mục tiêu là cải thiện groove bị bỏ sót bằng local processing. Local winning scale chỉ dùng để xác định vùng đáng re-detect, chọn sigma, ROI và scale support, không được biến trực tiếp thành mask. Dùng các groove candidate hiện có làm seed rồi lan cục bộ; mỗi pixel mới chỉ được thêm nếu có directional local-minimum support, dark support, multi-scale support, vượt local threshold và nối với line hiện tại. Nếu vùng sạch thì không thêm gì. Tuyệt đối không dùng endpoint-pair, shortest path hay predicted guide line làm output. Hướng line chủ yếu trái→phải, không tạo vertical line giả. Glare phải được remove trước feature extraction. Với 8964 và 8993 phải xử lý riêng, giảm hoặc bỏ Frangi vì toàn thân nhiều gai. Phải sửa fruit mask để không làm mất thịt ở rìa. Output cần Final crack line, Primitive flesh và Primitive mask overlay. Không SAM, không semantic ở giai đoạn này.

Đây là context quan trọng nhất để LLM khác tiếp tục đúng hướng.

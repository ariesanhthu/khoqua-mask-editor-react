# Hướng dẫn đưa dữ liệu prelabel vào Khổ qua Mask Editor

## 1. Kết luận nhanh

Editor hiện nhận prelabel dưới dạng **mask PNG nhị phân**, không nhận trực tiếp COCO JSON, polygon JSON, ảnh heatmap hay file `.npy`.

- Ảnh gốc và mask prediction phải có cùng kích thước pixel.
- Mask nên là PNG một kênh: `0` là nền, `255` là vùng cần gán nhãn.
- `manifest.json` ở thư mục gốc ghép mỗi ảnh với đúng một prediction mask.
- Có thể dùng một thư mục local khi phát triển hoặc một thư mục Google Drive khi chạy production.
- Khi mở ảnh lần đầu, prediction là lớp mask ban đầu. Mask người dùng đã lưu (nếu có) được ưu tiên ở những lần mở sau.

## 2. Cấu trúc thư mục nguồn

```text
prelabel-dataset/
├── manifest.json
├── images/
│   ├── BM_000001.jpg
│   ├── BM_000002.jpg
│   └── ...
└── predictions/
    ├── BM_000001.png
    ├── BM_000002.png
    └── ...
```

Nên để stem của ảnh và mask giống nhau để dễ kiểm tra, dù chương trình thực sự ghép cặp theo đường dẫn trong manifest.

## 3. Schema `manifest.json`

```json
{
  "dataset_version": "2026-08-19",
  "algorithm_version": "sam-prelabel-v1",
  "items": [
    {
      "id": "BM_000001",
      "image": "images/BM_000001.jpg",
      "prediction": "predictions/BM_000001.png",
      "width": 1024,
      "height": 768
    },
    {
      "id": "BM_000002",
      "image": "images/BM_000002.jpg",
      "prediction": "predictions/BM_000002.png",
      "width": 1024,
      "height": 768
    }
  ]
}
```

### Ý nghĩa các field

| Field | Bắt buộc | Ý nghĩa |
|---|---:|---|
| `dataset_version` | Không | Phiên bản/lần phát hành dataset. |
| `algorithm_version` | Không | Phiên bản pipeline tạo prelabel. |
| `items` | Có | Danh sách mẫu. |
| `items[].id` | Có | Khóa duy nhất, ổn định của mẫu trong dataset. Sync lại dùng khóa này để update, không tạo bản trùng. |
| `items[].image` | Có | Đường dẫn tương đối từ thư mục chứa manifest đến ảnh gốc. |
| `items[].prediction` | Có | Đường dẫn tương đối đến mask PNG prelabel. |
| `items[].width` | Không, nên có | Chiều rộng ảnh/mask theo pixel. |
| `items[].height` | Không, nên có | Chiều cao ảnh/mask theo pixel. |

Quy tắc quan trọng:

- Dùng `/` trong đường dẫn manifest, kể cả khi tạo manifest trên Windows.
- Không dùng đường dẫn tuyệt đối, `..`, URL public hoặc Google Drive file ID trong từng item.
- `id` không nên đổi giữa các lần sync. Đổi `id` được hiểu là thêm một mẫu mới.
- Không trùng `id` trong cùng manifest.
- Sync lại chỉ cập nhật index nguồn; không xóa annotation đã làm.

## 4. Chuẩn của prediction mask

Mỗi file `predictions/*.png` cần đáp ứng:

1. Kích thước đúng bằng ảnh gốc: `mask.width === image.width` và `mask.height === image.height`.
2. Giá trị nhị phân: `0` cho background, `255` cho foreground/ridge.
3. Không resize, crop hoặc rotate mask tách khỏi ảnh.
4. Nên xuất PNG grayscale 8-bit, không palette màu, không JPEG.
5. Nếu output của model là xác suất, threshold trước khi upload; ví dụ `probability >= 0.5 -> 255`, còn lại `0`.

Nếu pipeline tạo mask RGB thì vẫn nên chuyển về grayscale nhị phân để tránh việc trình duyệt diễn giải màu/alpha ngoài ý muốn. Mask nhiều class hiện chưa được hỗ trợ; cần quy về một foreground hoặc sửa schema và editor trước.

## 5. Upload lên Google Drive

### Bước 1 — Chuẩn bị service account

1. Tạo service account trong Google Cloud và bật Google Drive API.
2. Lấy JSON key của service account.
3. Cấu hình JSON ở biến backend `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON`.
4. Không commit JSON key vào Git và không đưa key xuống frontend.

`GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` có thể là chuỗi JSON đầy đủ hoặc đường dẫn file JSON khi chạy local.

### Bước 2 — Upload đúng cấu trúc

Upload nguyên thư mục `prelabel-dataset/` lên Drive. `manifest.json`, `images/`, và `predictions/` phải nằm cùng cấp như cây thư mục ở trên. Không upload một file ZIP nếu chưa giải nén.

### Bước 3 — Chia sẻ thư mục

Chia sẻ thư mục nguồn cho `client_email` trong service-account JSON với quyền **Viewer**. Thư mục Drive đích dùng để export ground truth cần quyền **Editor**.

### Bước 4 — Tạo project và sync

1. Đăng nhập bằng tài khoản Admin.
2. Trong **Kết nối bộ dữ liệu**, nhập tên project.
3. Dán URL hoặc ID thư mục Drive nguồn vào **Drive nguồn**.
4. Dán URL hoặc ID thư mục xuất vào **Drive đích**.
5. Tạo project, sau đó bấm **Đồng bộ**.

Backend sẽ đọc `manifest.json`, tìm từng file theo đường dẫn tương đối, lưu Drive file ID vào database và trả về số mẫu `added`, `updated`, `missing`.

## 6. Dùng thư mục local khi phát triển

Code hiện cũng chấp nhận đường dẫn tuyệt đối tới thư mục nguồn thay cho Drive folder ID/URL:

```text
F:\datasets\prelabel-dataset
```

Thư mục đó phải chứa `manifest.json`. Cách này chỉ phù hợp local vì filesystem của deployment serverless không phải kho dữ liệu bền vững.

## 7. App load prelabel như thế nào

```text
Admin bấm Sync
  → backend đọc manifest
  → resolve ảnh và prediction thành local path hoặc Drive file ID
  → upsert dataset file theo (dataset, id)
  → người dùng mở một mẫu
  → browser gọi asset proxy của backend
  → canvas nạp ảnh + prediction mask
  → nếu đã có mask người dùng lưu, canvas nạp mask đó thay prediction
```

Ảnh và prediction không được tải hàng loạt khi sync. Chúng chỉ được proxy về khi người dùng mở mẫu, nên số lượng file lớn không làm trình duyệt tải toàn bộ dataset ngay lập tức.

## 8. Checklist trước khi sync

- [ ] `manifest.json` là JSON hợp lệ và lưu UTF-8.
- [ ] Mỗi item có `id`, `image`, `prediction`.
- [ ] Không có `id` trùng.
- [ ] Mọi đường dẫn trong manifest tồn tại và đúng chữ hoa/thường.
- [ ] Mọi prediction là PNG nhị phân `0/255`.
- [ ] Kích thước prediction trùng ảnh gốc.
- [ ] Service account có quyền đọc toàn bộ cây thư mục nguồn.
- [ ] Backend đã có `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON`.
- [ ] Sync trả về `missing: 0`.
- [ ] Mở thử vài mẫu đầu, giữa và cuối dataset để kiểm tra alignment.

## 9. Lỗi thường gặp

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Không tìm thấy `manifest.json` | Manifest không nằm ở root hoặc service account chưa có quyền | Chuyển manifest lên root và share lại folder. |
| `missing > 0` | Sai đường dẫn/tên file, sai chữ hoa-thường hoặc thiếu quyền ở folder con | So sánh chính xác path trong manifest với Drive. |
| Mask lệch ảnh | Mask bị resize/crop/rotate hoặc EXIF orientation của ảnh chưa được materialize | Chuẩn hóa orientation ảnh trước inference rồi sinh mask theo đúng ảnh đã upload. |
| Mask gần như phủ cả ảnh/rỗng | Mask xác suất chưa threshold hoặc foreground dùng giá trị không đúng | Chuyển mask về `0/255` và xem histogram trước upload. |
| Mở file lỗi nhưng thấy placeholder | Asset proxy hiện có fallback placeholder khi không đọc được Drive | Kiểm tra log/quyền Drive; không xem placeholder là dữ liệu thật. Nên bỏ fallback này ở production. |
| Sync lại tạo mẫu mới | `id` đã thay đổi | Giữ `id` ổn định qua các phiên bản prelabel. |

## 10. Có nên chuyển ảnh sang Cloudinary?

### Khuyến nghị cho repo hiện tại

**Chưa nên chuyển riêng sang Cloudinary chỉ để “ổn định hơn”.** Kiến trúc hiện tại đã tách đúng vai trò:

- Google Drive: ảnh nguồn và prediction do pipeline cung cấp.
- PostgreSQL: metadata, trạng thái và revision.
- Vercel Blob private: mask người dùng đã chỉnh sửa.
- Google Drive đích: bản export ground truth.

Cloudinary mạnh về CDN và biến đổi ảnh hiển thị, nhưng annotation cần byte/kích thước/orientation ổn định. Transform tự động, format optimization hoặc resize nhầm có thể làm ảnh không còn khớp mask. Chuyển sang Cloudinary cũng đòi hỏi sửa manifest resolver, asset proxy, quyền truy cập, migration và cơ chế xóa/versioning.

### Khi nào nên rời Google Drive cho ảnh nguồn

Cân nhắc object storage nếu Drive bắt đầu gây latency lớn, rate limit, lỗi quyền chia sẻ hoặc có nhiều annotator đồng thời. Với workload khoa học/annotation, ưu tiên **Vercel Blob, S3, Cloudflare R2 hoặc GCS** hơn Cloudinary vì đây là lưu trữ object nguyên bản, đơn giản hơn và tránh image transformation ngoài ý muốn.

Nếu vẫn chọn Cloudinary:

- dùng asset private/authenticated và signed delivery;
- lưu `public_id`/version trong database, không lưu URL transform tùy ý;
- luôn dùng delivery nguyên bản, không resize/auto-rotate/`f_auto` cho canvas annotation;
- giữ prediction mask là lossless PNG;
- kiểm tra kích thước sau upload;
- migration theo từng batch và giữ Drive làm nguồn fallback đến khi đối soát checksum hoàn tất.

### Cải thiện nên làm trước migration

1. Bỏ placeholder im lặng ở asset API trong production; trả lỗi rõ ràng khi Drive không đọc được.
2. Kiểm tra MIME, kích thước ảnh và mask ngay trong bước sync.
3. Thêm cache/object storage cho asset đã đọc từ Drive nếu latency cao.
4. Theo dõi tỷ lệ lỗi và thời gian tải thực tế trước khi quyết định đổi kho.

Như vậy, lựa chọn ít rủi ro nhất hiện tại là giữ Drive làm nguồn, giữ Vercel Blob cho annotation, rồi chỉ chuyển source assets sang object storage khi số liệu vận hành cho thấy Drive là nút thắt.

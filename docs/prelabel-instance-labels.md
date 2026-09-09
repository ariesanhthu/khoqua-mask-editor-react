# Label instance cho prelabel

Prelabel dùng hai nhóm label độc lập trên cùng một `POLYGON_SET`:

| Nhóm | Semantic trong metadata | Dạng label | Ví dụ |
| --- | --- | --- | --- |
| Vết gợn | `main_flesh_band` | `r<id>` | `r1`, `r2`, `r3` |
| U vấu | `wart_flesh` | `w<id>` | `w1`, `w2`, `w3` |

ID bắt đầu từ `1` và tăng độc lập trong từng nhóm của mỗi ảnh. Nhiều polygon có thể dùng chung một label khi chúng là các mảnh của cùng một instance. Ví dụ, mọi fragment thuộc `main_group_id = 2` đều có label `r2`; mọi polygon thuộc `wart_id = 4` đều có label `w4`.

## Schema prelabel 1.1

```json
{
  "schemaVersion": "bitter-melon-prelabel-1.1",
  "imageId": "8582_01",
  "coordinateSpace": "image_pixels",
  "width": 1456,
  "height": 614,
  "maskOperations": [
    {
      "type": "POLYGON_SET",
      "polygons": [
        {
          "id": "main_1_frag_1_poly_1",
          "label": "r1",
          "nodes": [],
          "meta": {
            "semantic": "main_flesh_band",
            "mainGroupId": 1,
            "source": "model"
          }
        },
        {
          "id": "wart_1_poly_1",
          "label": "w1",
          "nodes": [],
          "meta": {
            "semantic": "wart_flesh",
            "wartId": 1,
            "source": "model"
          }
        }
      ]
    }
  ]
}
```

Mỗi polygon thực tế phải có ít nhất ba node; phần `nodes` được rút gọn trong ví dụ.

## Quy tắc trong editor

- Sau khi chọn polygon, chọn một trong hai loại **Vết gợn** hoặc **U vấu**. Editor chỉ hiển thị phần ID của loại đang chọn.
- Dropdown **Vết gợn** chỉ hiển thị label `r*`; dropdown **U vấu** chỉ hiển thị label `w*`.
- Chọn một label trong dropdown sẽ gán label đó cho toàn bộ polygon đang chọn.
- **Tạo mới** sinh ID bằng số lớn nhất hiện có trong nhóm cộng `1`, rồi gán ngay cho polygon đang chọn.
- Khi đổi nhóm, editor cập nhật đồng thời `label`, `meta.semantic` và đặt `meta.source` thành `human`.
- Nút **Khóa** xuất hiện khi chọn đúng một polygon. Polygon đã khóa không cho kéo, thêm, xóa node, cắt hoặc gộp cho đến khi được mở khóa.
- Trong chế độ chọn, giữ chuột trái trên node để kéo và cập nhật tọa độ; bấm chuột phải trên node để xóa.
- Polygon vẽ mới mặc định nhận label vết gợn tiếp theo. Có thể đổi sang u vấu bằng dropdown hoặc nút **Tạo mới** của nhóm U vấu.

## Chuyển đổi dữ liệu V7

Chạy từ repository root:

```bash
npm run dataset:convert -- --force
```

Converter ánh xạ `main_group_id → r<id>` và `wart_id → w<id>`, đồng thời tạo lại `drive/prelabel-production` theo schema 1.1.

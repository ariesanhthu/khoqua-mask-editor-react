/**
 * Quy tắc nhóm ảnh dùng chung cho trình duyệt (lập kế hoạch nhập thư mục) và máy chủ
 * (nhập, tự chia nhóm). Không import gì của server để chạy được ở cả hai phía.
 */

/** Nhóm ảo gom các ảnh chưa thuộc nhóm nào; chỉ ADMIN thấy. ID nhóm thật là UUID nên không trùng. */
export const UNGROUPED_GROUP_ID = 'ungrouped';

export const MAX_GROUP_NAME_LENGTH = 120;
export const MAX_EXTERNAL_KEY_LENGTH = 200;

/** Thư mục mô tả cấu trúc bộ dữ liệu (định dạng mặc định và COCO/CVAT), không phải tên giống. */
const STRUCTURAL_FOLDERS = new Set(['images', 'image', 'imgs', 'annotations', 'predictions', 'prelabels', 'masks', 'default']);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function normalizeGroupName(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function isValidGroupName(value: string): boolean {
  const name = normalizeGroupName(value);
  return name.length > 0 && name.length <= MAX_GROUP_NAME_LENGTH && !CONTROL_CHARACTERS.test(name);
}

/** Khóa ảnh xuất hiện trong tên tệp ZIP/Drive nên không được chứa dấu phân cách đường dẫn. */
export function isValidExternalKey(value: string): boolean {
  return value.length > 0 && value.length <= MAX_EXTERNAL_KEY_LENGTH && value === value.trim()
    && !/[\\/]/.test(value) && !CONTROL_CHARACTERS.test(value) && value !== '.' && value !== '..';
}

/**
 * Tên nhóm suy từ tên ảnh theo quy ước `<giống>_<số thứ tự>`: `8582_01` → `8582`,
 * `TVI_8573_01` → `TVI_8573`, `8582_01_crop` → `8582`. Trả null khi không đoán được.
 */
export function inferGroupName(externalKey: string): string | null {
  const key = externalKey.trim();
  const numbered = key.match(/^(.+?)[_-]\d+$/);
  if (numbered) return numbered[1];
  const separated = key.match(/^([^_-]+)[_-]/);
  return separated ? separated[1] : null;
}

/**
 * Nhóm theo vị trí ảnh trong thư mục admin chọn: thư mục con đầu tiên không phải thư mục cấu trúc.
 * `khoqua/8582/8582_01.jpg` và `khoqua/images/8582/8582_01.jpg` đều thuộc `8582`; ảnh không nằm
 * trong thư mục giống nào (`khoqua/images/x.jpg`) thuộc nhóm mang tên thư mục gốc.
 * `relativePath` tính từ thư mục gốc và không gồm tên thư mục gốc.
 */
export function groupFromRelativePath(relativePath: string, rootName: string): string {
  const folders = relativePath.split('/').filter(Boolean).slice(0, -1);
  return folders.find((folder) => !STRUCTURAL_FOLDERS.has(folder.toLowerCase())) ?? rootName;
}

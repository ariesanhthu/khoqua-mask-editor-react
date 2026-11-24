'use client';

import { useEffect, useState } from 'react';
import type { FileListItem, UserSummary } from '@/types';
import { getUsers } from '@/lib/api-client';

const roleLabels: Record<UserSummary['role'], string> = { ADMIN: 'Quản trị viên', ANNOTATOR: 'Người gán nhãn', REVIEWER: 'Người duyệt' };

export default function FileAssignBar({ files, selected, disabled, saving, onSelect, onSave }: {
  files: FileListItem[];
  selected: FileListItem[];
  disabled: boolean;
  saving: 'assign' | 'unassign' | null;
  onSelect(ids: string[]): void;
  onSave(ids: string[], userId: string | null): Promise<void>;
}) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void getUsers()
      .then((result) => { if (active) setUsers(result); })
      .catch((error: { message?: string }) => { if (active) setError(error.message || 'Không tải được danh sách người dùng.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  // ADMIN đã thấy mọi ảnh nên không cần giao (như hộp thoại phân công nhóm).
  const candidates = users
    .filter((user) => user.role !== 'ADMIN')
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'vi'));
  const assigned = selected.filter((file) => file.assignment);

  return (
    <section className="file-assign-bar panel" aria-label="Phân công ảnh">
      <div className="file-assign-row">
        <div className="file-assign-summary">
          <h3>Phân công ảnh</h3>
          <span>Đã chọn {selected.length} / {files.length} ảnh</span>
        </div>
        <div className="file-assign-controls">
          <button className="button ghost" type="button" disabled={disabled || selected.length === files.length}
            onClick={() => onSelect(files.map((file) => file.id))}>Chọn cả trang</button>
          <button className="button ghost" type="button" disabled={disabled || !selected.length}
            onClick={() => onSelect([])}>Bỏ chọn</button>
        </div>
      </div>
      <div className="file-assign-row">
        <label className="file-assign-user">
          <span>Người phụ trách</span>
          <select name="file-assignee" value={userId} disabled={disabled || loading} onChange={(event) => setUserId(event.target.value)}>
            <option value="">{loading ? 'Đang tải…' : candidates.length ? 'Chọn người phụ trách' : 'Chưa có người phụ trách'}</option>
            {candidates.map((user) => <option key={user.id} value={user.id}>{user.displayName} · {roleLabels[user.role]}</option>)}
          </select>
        </label>
        <div className="file-assign-controls">
          <button className="button primary" type="button" disabled={disabled || !selected.length || !userId}
            onClick={() => void onSave(selected.map((file) => file.id), userId)}>{saving === 'assign' ? 'Đang giao…' : 'Giao ảnh'}</button>
          <button className="button ghost" type="button" disabled={disabled || !assigned.length}
            onClick={() => void onSave(assigned.map((file) => file.id), null)}>{saving === 'unassign' ? 'Đang bỏ giao…' : 'Bỏ giao riêng'}</button>
        </div>
      </div>
      {error ? <p role="alert" className="notice warning">{error}</p> : null}
    </section>
  );
}

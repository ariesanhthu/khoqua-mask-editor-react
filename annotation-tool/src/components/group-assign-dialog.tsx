'use client';

import { useEffect, useRef, useState } from 'react';
import type { FileGroupSummary, UserSummary } from '@/types';
import { getUsers, setGroupAssignees } from '@/lib/api-client';

const roleLabels: Record<UserSummary['role'], string> = { ADMIN: 'Quản trị viên', ANNOTATOR: 'Người gán nhãn', REVIEWER: 'Người duyệt' };

/** ADMIN chọn những người được giao một nhóm ảnh. Người được giao chỉ thấy ảnh của các nhóm này. */
export default function GroupAssignDialog({ projectId, group, onClose, onSaved }: {
  projectId: string;
  group: FileGroupSummary;
  onClose(): void;
  onSaved(assignees: FileGroupSummary['assignees']): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [selected, setSelected] = useState(() => new Set(group.assignees.map((user) => user.userId)));
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void getUsers()
      .then((result) => { if (active) setUsers(result); })
      .catch((e: { message?: string }) => { if (active) setError(e.message || 'Không tải được danh sách người dùng.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  // ADMIN đã thấy mọi nhóm nên không cần giao.
  const candidates = users
    .filter((user) => user.role !== 'ADMIN')
    .filter((user) => !filter.trim() || user.displayName.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'vi'));

  const toggle = (userId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(userId)) next.delete(userId); else next.add(userId);
    return next;
  });

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await setGroupAssignees(projectId, group.id, [...selected]);
      onSaved(result.assignees);
    } catch (e) {
      setError((e as { message?: string }).message || 'Không lưu được phân công.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialog} className="assign-dialog" onCancel={onClose} aria-labelledby="assign-title">
      <header>
        <p className="eyebrow">Phân công nhóm</p>
        <h2 id="assign-title">{group.name}</h2>
        <p>{group.total} ảnh · Người được chọn chỉ thấy và làm các ảnh của nhóm này.</p>
      </header>
      {error ? <p role="alert" className="notice warning">{error}</p> : null}
      <label className="assign-search">
        <span>Tìm người dùng</span>
        <input name="assignee-search" autoComplete="off" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Nhập tên…" />
      </label>
      <div className="assign-list" aria-busy={loading}>
        {loading ? <p role="status">Đang tải…</p> : null}
        {!loading && !candidates.length ? <p className="assign-empty">Chưa có tài khoản người gán nhãn. Tạo tài khoản ở tab Quản trị.</p> : null}
        {candidates.map((user) => (
          <label key={user.id} className={selected.has(user.id) ? 'selected' : ''}>
            <input type="checkbox" checked={selected.has(user.id)} onChange={() => toggle(user.id)} />
            <span className="avatar small" aria-hidden="true">{user.displayName.slice(0, 1).toUpperCase()}</span>
            <span><strong>{user.displayName}</strong><small>{roleLabels[user.role] ?? user.role}</small></span>
          </label>
        ))}
      </div>
      <footer>
        <span>Đã chọn {selected.size} người</span>
        <button className="button ghost" type="button" onClick={onClose} disabled={saving}>Hủy</button>
        <button className="button primary" type="button" onClick={() => void save()} disabled={saving || loading}>{saving ? 'Đang lưu…' : 'Lưu phân công'}</button>
      </footer>
    </dialog>
  );
}

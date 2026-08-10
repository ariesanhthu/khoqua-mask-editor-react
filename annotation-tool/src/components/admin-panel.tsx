'use client';

import { useState } from 'react';
import type { ProjectSummary } from '@/types';
import { createProject, createUser, exportProject, syncProject } from '@/lib/api-client';

export default function AdminPanel({ projects, onChanged }: { projects: ProjectSummary[]; onChanged: () => Promise<void> }) {
  const [projectName, setProjectName] = useState('');
  const [folder, setFolder] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('ANNOTATOR');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setMessage('');
    try { await action(); } catch (error) {
      setMessage((error as { message?: string }).message || 'Thao tác không thành công.');
    } finally { setBusy(''); }
  };

  return (
    <section className="admin-section">
      <div className="section-heading"><p className="eyebrow">Quản trị</p><h2>Dữ liệu và người dùng</h2></div>
      {message ? <p className="notice">{message}</p> : null}
      <div className="admin-grid">
        <form className="panel admin-card" onSubmit={(event) => {
          event.preventDefault();
          void run('project', async () => {
            await createProject(projectName, folder); setProjectName(''); setFolder(''); await onChanged(); setMessage('Đã tạo dự án.');
          });
        }}>
          <h3>Kết nối bộ dữ liệu</h3>
          <p>Dùng URL/ID Google Drive hoặc đường dẫn thư mục cục bộ có `manifest.json`.</p>
          <input required value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Tên dự án" />
          <input required value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="Drive URL, folder ID hoặc đường dẫn" />
          <button className="button primary" disabled={busy !== ''}>{busy === 'project' ? 'Đang tạo…' : 'Tạo dự án'}</button>
        </form>

        <div className="panel admin-card">
          <h3>Đồng bộ manifest</h3><p>Chỉ cập nhật chỉ mục nguồn; không thay đổi nhãn đã lưu.</p>
          <div className="sync-list">{projects.map((project) => (
            <div key={project.id} className="admin-project-actions">
              <button className="button secondary" disabled={busy !== ''} onClick={() => void run(project.id, async () => {
                const result = await syncProject(project.id); setMessage(`Đồng bộ ${project.name}: thêm ${result.added}, cập nhật ${result.updated}, lỗi ${result.missing}.`); await onChanged();
              })}>{busy === project.id ? 'Đang đồng bộ…' : `Đồng bộ ${project.name}`}</button>
              <button className="button ghost" disabled={busy !== ''} onClick={() => void run(`export-${project.id}`, async () => {
                const result = await exportProject(project.id); setMessage(`Đã xuất ${result.exported} nhãn vào ${result.outputPath}.`);
              })}>{busy === `export-${project.id}` ? 'Đang xuất…' : 'Xuất nhãn'}</button>
            </div>
          ))}</div>
        </div>

        <form className="panel admin-card" onSubmit={(event) => {
          event.preventDefault();
          void run('user', async () => {
            await createUser({ displayName, password, role }); setDisplayName(''); setPassword(''); setMessage('Đã tạo người dùng.');
          });
        }}>
          <h3>Thêm người dùng</h3><p>Tạo tài khoản cho người gán nhãn hoặc người duyệt.</p>
          <input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Tên hiển thị" />
          <input required minLength={6} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Mật khẩu (ít nhất 6 ký tự)" />
          <select value={role} onChange={(event) => setRole(event.target.value)}><option value="ANNOTATOR">Người gán nhãn</option><option value="REVIEWER">Người duyệt</option><option value="ADMIN">Quản trị viên</option></select>
          <button className="button primary" disabled={busy !== ''}>{busy === 'user' ? 'Đang tạo…' : 'Tạo tài khoản'}</button>
        </form>
      </div>
    </section>
  );
}

'use client';

import { useCallback, useDeferredValue, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CurrentUser, FileListItem, ProjectSummary } from '@/types';
import { exportProject, getFiles, getProjects, logout, projectExportDownloadUrl, syncProject } from '@/lib/api-client';
import AdminPanel from './admin-panel';

type Filter = 'ALL' | 'AVAILABLE' | 'DOING' | 'DONE' | 'DRAFT' | 'MINE';

const filters: Array<{ value: Filter; label: string }> = [
  { value: 'ALL', label: 'Tất cả' },
  { value: 'AVAILABLE', label: 'Có thể làm' },
  { value: 'DOING', label: 'Đang làm' },
  { value: 'DONE', label: 'Hoàn tất' },
  { value: 'DRAFT', label: 'Bản nháp' },
  { value: 'MINE', label: 'Của tôi' },
];

export default function Dashboard({ user }: { user: CurrentUser }) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [files, setFiles] = useState<FileListItem[]>([]);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [openingId, setOpeningId] = useState('');
  const [projectAction, setProjectAction] = useState('');
  const [projectMessage, setProjectMessage] = useState('');
  const [driveUrl, setDriveUrl] = useState('');

  const loadProjects = useCallback(async () => {
    const result = await getProjects();
    setProjects(result);
    if (result.length === 0) {
      setProjectId('');
      setFiles([]);
      setLoading(false);
      return;
    }
    setProjectId((current) => {
      const remembered = localStorage.getItem('last-project-id');
      return current || (remembered && result.some((project) => project.id === remembered) ? remembered : result[0]?.id || '');
    });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadProjects().catch(() => router.replace('/login'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadProjects, router]);

  const loadFiles = useCallback(async (silent = false) => {
    if (!projectId) {
      setFiles([]);
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    const params: Record<string, string> = { pageSize: '50' };
    if (deferredSearch.trim()) params.search = deferredSearch.trim();
    if (filter === 'AVAILABLE') params.lockState = 'AVAILABLE';
    if (filter === 'DOING') params.lockState = 'LOCKED';
    if (filter === 'DONE' || filter === 'DRAFT') params.annotationState = filter;
    if (filter === 'MINE') params.assignedTo = 'me';
    try {
      const result = await getFiles(projectId, params);
      setFiles(result.items);
      setMessage('');
    } catch {
      setMessage('Không tải được danh sách. Hệ thống sẽ tự thử lại.');
    } finally {
      setLoading(false);
    }
  }, [deferredSearch, filter, projectId]);

  useEffect(() => {
    if (!projectId) return;
    localStorage.setItem('last-project-id', projectId);
    const initialTimer = window.setTimeout(() => void loadFiles(), 0);
    const timer = window.setInterval(() => void loadFiles(true), 8000);
    return () => { window.clearTimeout(initialTimer); window.clearInterval(timer); };
  }, [loadFiles, projectId]);

  const openFile = (file: FileListItem) => {
    if (!navigator.onLine) {
      setMessage('Bạn đang ngoại tuyến. Hãy kết nối lại trước khi mở tệp khác.');
      return;
    }
    if (file.lock.state === 'LOCKED' || file.assetState === 'ERROR') return;
    setOpeningId(file.id);
    router.push(`/editor/${file.id}`);
  };

  const runProjectAction = async (key: string, action: () => Promise<void>) => {
    setProjectAction(key);
    setProjectMessage('');
    setDriveUrl('');
    try {
      await action();
    } catch (error) {
      setProjectMessage((error as { message?: string }).message || 'Thao tác không thành công.');
    } finally {
      setProjectAction('');
    }
  };

  const selectedProject = projects.find((project) => project.id === projectId);

  return (
    <main className="dashboard-shell">
      <header className="app-header">
        <div className="dashboard-brand">
          <span className="app-logo" aria-hidden="true">A</span>
          <div>
            <p className="eyebrow">Bitter Melon Lab</p>
            <h1>Gán nhãn vân khổ qua</h1>
          </div>
        </div>
        <div className="header-user">
          <span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
          <div><strong>{user.displayName}</strong><small>{user.role}</small></div>
          <button className="button ghost" onClick={async () => { await logout(); router.replace('/login'); router.refresh(); }}>Đăng xuất</button>
        </div>
      </header>

      <section className="dashboard-toolbar panel">
        <label>
          <span>Dự án</span>
          <select name="project" autoComplete="off" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="search-field">
          <span>Tìm ảnh</span>
          <input name="file-search" autoComplete="off" spellCheck={false} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Ví dụ: BM_000123…" />
        </label>
        <div className="progress-pill"><strong>{files.length}</strong><span>tệp hiển thị</span></div>
      </section>

      {selectedProject && (user.role === 'ADMIN' || user.role === 'REVIEWER') ? (
        <section className="project-data-actions panel" aria-label="Đồng bộ và xuất dữ liệu">
          <div>
            <p className="eyebrow">Dữ liệu dự án</p>
            <strong>{selectedProject.name}</strong>
            <small>Drive chỉ nhận những mask có revision hoặc version mới hơn manifest hiện tại.</small>
          </div>
          <div className="project-action-buttons">
            {user.role === 'ADMIN' ? (
              <button className="button secondary" disabled={projectAction !== ''} onClick={() => void runProjectAction('source', async () => {
                const result = await syncProject(projectId);
                setProjectMessage(`Đã đọc manifest nguồn: thêm ${result.added}, cập nhật ${result.updated}, lỗi ${result.missing}.`);
                await Promise.all([loadProjects(), loadFiles(true)]);
              })}>{projectAction === 'source' ? 'Đang đồng bộ…' : 'Đồng bộ nguồn'}</button>
            ) : null}
            <button className="button primary" disabled={projectAction !== ''} onClick={() => void runProjectAction('drive', async () => {
              const result = await exportProject(projectId);
              setProjectMessage(`Drive: cập nhật ${result.updated}, bỏ qua ${result.skipped} file không đổi, lỗi ${result.errors.length}.`);
              setDriveUrl(result.driveFolderUrl);
            })}>{projectAction === 'drive' ? 'Đang cập nhật…' : 'Cập nhật Drive'}</button>
            <a className="button ghost download-button" href={projectExportDownloadUrl(projectId)} download>Tải ZIP về máy</a>
          </div>
        </section>
      ) : null}

      {projectMessage ? <p role="status" aria-live="polite" className="notice project-action-notice">
        {projectMessage}{driveUrl ? <> <a href={driveUrl} target="_blank" rel="noreferrer">Mở thư mục Drive</a></> : null}
      </p> : null}

      <nav className="filter-tabs" aria-label="Lọc danh sách tệp">
        {filters.map((item) => (
          <button key={item.value} className={filter === item.value ? 'active' : ''} onClick={() => setFilter(item.value)}>
            {item.label}
          </button>
        ))}
      </nav>

      {message ? <p role="status" aria-live="polite" className="notice warning">{message}</p> : null}

      <section className="file-grid" aria-busy={loading}>
        {loading ? Array.from({ length: 8 }, (_, index) => <div className="file-card skeleton" key={index} />) : null}
        {!loading && files.map((file) => {
          const locked = file.lock.state === 'LOCKED';
          const assetError = file.assetState === 'ERROR';
          return (
            <article className={`file-card ${locked ? 'locked' : ''}`} key={file.id}>
              <div className="thumbnail" aria-hidden="true"><span>{file.externalKey.slice(-4)}</span></div>
              <div className="file-card-body">
                <div className="file-title-row"><h2>{file.externalKey}</h2><StateBadge state={file.annotationState} /></div>
                <p>{assetError ? 'Thiếu ảnh nguồn hoặc mặt nạ gợi ý' : file.lock.state === 'LOCKED' ? `Đang được ${file.lock.displayName} chỉnh sửa` : 'Sẵn sàng chỉnh sửa'}</p>
                {file.assignment ? <small>Phụ trách: {file.assignment.displayName}</small> : <small>Chưa phân công</small>}
                <button className="button primary" disabled={locked || assetError || openingId === file.id} onClick={() => openFile(file)}>
                  {openingId === file.id ? 'Đang mở…' : file.annotationState === 'DONE' ? 'Chỉnh sửa lại' : 'Bắt đầu'}
                </button>
              </div>
            </article>
          );
        })}
      </section>

      {!loading && projects.length === 0 ? <div className="empty-state panel"><h2>Chưa có dự án</h2><p>Quản trị viên có thể tạo dự án và đồng bộ manifest bên dưới.</p></div> : null}
      {user.role === 'ADMIN' ? <AdminPanel onChanged={loadProjects} /> : null}
    </main>
  );
}

function StateBadge({ state }: { state: FileListItem['annotationState'] }) {
  const labels = { UNSTARTED: 'Chưa làm', DRAFT: 'Bản nháp', DONE: 'Hoàn tất' };
  return <span className={`state-badge ${state.toLowerCase()}`}>{labels[state]}</span>;
}

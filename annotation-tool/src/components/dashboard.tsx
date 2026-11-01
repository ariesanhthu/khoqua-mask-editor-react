'use client';

import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import type { CurrentUser, FileGroupSummary, FileListItem, ProjectSummary } from '@/types';
import {
  autoGroupProject,
  disconnectGoogleDrive,
  exportProject,
  getFiles,
  getGoogleDriveConnectionStatus,
  getGroups,
  getProjects,
  logout,
  projectExportDownloadUrl,
  syncProject,
  type GoogleDriveConnectionStatus,
} from '@/lib/api-client';
import { UNGROUPED_GROUP_ID } from '@/lib/file-groups';
import AdminPanel from './admin-panel';
import dynamic from 'next/dynamic';

const FileVersions = dynamic(() => import('./file-versions'));
const GroupAssignDialog = dynamic(() => import('./group-assign-dialog'));
const DatasetImport = dynamic(() => import('./dataset-import'));

type View = 'groups' | 'import' | 'admin';
type Filter = 'ALL' | 'TODO' | 'DRAFT' | 'DONE' | 'LOCKED';

const views: Array<{ value: View; label: string }> = [
  { value: 'groups', label: 'Nhóm & ảnh' },
  { value: 'import', label: 'Nhập dữ liệu' },
  { value: 'admin', label: 'Quản trị' },
];

const filters: Array<{ value: Filter; label: string }> = [
  { value: 'ALL', label: 'Tất cả' },
  { value: 'TODO', label: 'Cần làm' },
  { value: 'DRAFT', label: 'Bản nháp' },
  { value: 'DONE', label: 'Hoàn tất' },
  { value: 'LOCKED', label: 'Đang được mở' },
];

const roleLabels: Record<CurrentUser['role'], string> = { ADMIN: 'Quản trị viên', ANNOTATOR: 'Người gán nhãn', REVIEWER: 'Người duyệt' };

const PAGE_SIZE = 20;
const groupStorageKey = (projectId: string) => `last-group-id:${projectId}`;

function filterCount(group: FileGroupSummary | undefined, filter: Filter): number | undefined {
  if (!group) return undefined;
  if (filter === 'TODO') return group.total - group.done;
  if (filter === 'DRAFT') return group.draft;
  if (filter === 'DONE') return group.done;
  if (filter === 'LOCKED') return group.locked;
  return group.total;
}

function readStoredGroup(projectId: string): string | null {
  try { return localStorage.getItem(groupStorageKey(projectId)); } catch { return null; }
}

function storeGroup(projectId: string, groupId: string | null) {
  try {
    if (groupId) localStorage.setItem(groupStorageKey(projectId), groupId);
    else localStorage.removeItem(groupStorageKey(projectId));
  } catch { /* chế độ riêng tư */ }
}

export default function Dashboard({ user }: { user: CurrentUser }) {
  const router = useRouter();
  const isAdmin = user.role === 'ADMIN';
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [view, setView] = useState<View>('groups');
  const [groups, setGroups] = useState<FileGroupSummary[]>([]);
  const [ungrouped, setUngrouped] = useState(0);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState('');
  const [groupMessage, setGroupMessage] = useState('');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [files, setFiles] = useState<FileListItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalFiles, setTotalFiles] = useState(0);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [filesLoading, setFilesLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [openingId, setOpeningId] = useState('');
  const [findingNext, setFindingNext] = useState(false);
  const [versionFile, setVersionFile] = useState<FileListItem | null>(null);
  const [assignGroup, setAssignGroup] = useState<FileGroupSummary | null>(null);
  const [projectAction, setProjectAction] = useState('');
  const [projectMessage, setProjectMessage] = useState('');
  const [driveUrl, setDriveUrl] = useState('');
  const [googleDriveStatus, setGoogleDriveStatus] = useState<GoogleDriveConnectionStatus>({
    configured: false,
    connected: false,
  });
  const fileRequestRef = useRef(0);
  const groupRequestRef = useRef(0);

  const loadProjects = useCallback(async () => {
    const result = await getProjects();
    setProjects(result);
    setProjectsLoaded(true);
    if (result.length === 0) {
      setProjectId('');
      setGroups([]);
      setUngrouped(0);
      setGroupsLoading(false);
      return;
    }
    setProjectId((current) => {
      if (current && result.some((project) => project.id === current)) return current;
      const remembered = localStorage.getItem('last-project-id');
      return remembered && result.some((project) => project.id === remembered) ? remembered : result[0]?.id || '';
    });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void Promise.all([loadProjects(), getGoogleDriveConnectionStatus().then(setGoogleDriveStatus)])
        .catch(() => router.replace('/login'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadProjects, router]);

  const loadGroups = useCallback(async (silent = false) => {
    const requestId = ++groupRequestRef.current;
    if (!projectId) return;
    if (!silent) setGroupsLoading(true);
    try {
      const result = await getGroups(projectId);
      if (requestId !== groupRequestRef.current) return;
      setGroups(result.groups);
      setUngrouped(result.ungrouped);
      setGroupsError('');
      // Nhóm nhớ từ lần trước có thể đã bị bỏ giao hoặc không còn ảnh chưa phân nhóm.
      setGroupId((current) => {
        if (!current) return current;
        const exists = current === UNGROUPED_GROUP_ID ? result.ungrouped > 0 : result.groups.some((group) => group.id === current);
        return exists ? current : null;
      });
    } catch {
      if (requestId === groupRequestRef.current) setGroupsError('Không tải được danh sách nhóm. Hãy bấm Làm mới để thử lại.');
    } finally {
      if (requestId === groupRequestRef.current) setGroupsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    localStorage.setItem('last-project-id', projectId);
    // Về từ editor thì mở lại đúng nhóm đang làm.
    const timer = window.setTimeout(() => {
      setGroupId(readStoredGroup(projectId));
      void loadGroups();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadGroups, projectId]);

  const loadFiles = useCallback(async (silent = false) => {
    const requestId = ++fileRequestRef.current;
    const query = deferredSearch.trim();
    // Trang tổng quan chỉ cần danh sách ảnh khi đang tìm kiếm.
    if (!projectId || (!groupId && !query)) {
      setFiles([]);
      setTotalFiles(0);
      setFilesLoading(false);
      return;
    }
    if (!silent) setFilesLoading(true);
    const params: Record<string, string> = { page: String(page), pageSize: String(PAGE_SIZE) };
    if (query) params.search = query;
    if (groupId) {
      params.groupId = groupId;
      if (filter === 'TODO') params.annotationState = 'UNSTARTED,DRAFT';
      if (filter === 'DRAFT' || filter === 'DONE') params.annotationState = filter;
      if (filter === 'LOCKED') params.lockState = 'LOCKED';
    }
    try {
      const result = await getFiles(projectId, params);
      if (requestId !== fileRequestRef.current) return;
      setFiles(result.items);
      setTotalFiles(result.total);
      setMessage('');
    } catch {
      if (requestId !== fileRequestRef.current) return;
      setMessage('Không tải được danh sách ảnh. Hãy bấm Làm mới để thử lại.');
    } finally {
      if (requestId === fileRequestRef.current) setFilesLoading(false);
    }
  }, [deferredSearch, filter, groupId, page, projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadFiles(), 0);
    return () => window.clearTimeout(timer);
  }, [loadFiles]);

  const pageCount = Math.max(1, Math.ceil(totalFiles / PAGE_SIZE));

  const changeProject = (id: string) => {
    setProjectId(id);
    setGroupId(null);
    setGroups([]);
    setUngrouped(0);
    setGroupsLoading(true);
    setPage(1);
    setFilter('ALL');
    setSearch('');
    setGroupMessage('');
    setProjectMessage('');
  };

  const openGroup = (id: string) => {
    setGroupId(id);
    setPage(1);
    setFilter('ALL');
    setSearch('');
    setMessage('');
    setGroupMessage('');
    storeGroup(projectId, id);
    window.scrollTo({ top: 0 });
  };

  const closeGroup = () => {
    setGroupId(null);
    setPage(1);
    setFilter('ALL');
    setSearch('');
    setMessage('');
    storeGroup(projectId, null);
  };

  const openFile = (file: FileListItem) => {
    if (!navigator.onLine) {
      setMessage('Bạn đang ngoại tuyến. Hãy kết nối lại trước khi mở tệp khác.');
      return;
    }
    if (file.assetState === 'ERROR') return;
    setOpeningId(file.id);
    router.push(`/editor/${file.id}`);
  };

  /** Ảnh chưa xong đầu tiên của nhóm mà không ai đang mở. */
  const openNextInGroup = async () => {
    if (!groupId) return;
    setFindingNext(true);
    setMessage('');
    try {
      const result = await getFiles(projectId, {
        groupId, annotationState: 'UNSTARTED,DRAFT', lockState: 'AVAILABLE', page: '1', pageSize: String(PAGE_SIZE),
      });
      const next = result.items.find((file) => file.assetState === 'READY');
      if (next) openFile(next);
      else setMessage('Nhóm không còn ảnh cần làm đang trống: các ảnh còn lại đã hoàn tất hoặc đang được người khác mở.');
    } catch {
      setMessage('Không tìm được ảnh tiếp theo. Hãy thử lại.');
    } finally {
      setFindingNext(false);
    }
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

  const autoGroup = async () => {
    setProjectAction('auto-group');
    setGroupMessage('');
    try {
      const result = await autoGroupProject(projectId);
      setGroupMessage(`Đã xếp ${result.filesGrouped} ảnh vào nhóm${result.groupsCreated ? `, tạo mới ${result.groupsCreated} nhóm` : ''}.${
        result.skipped ? ` ${result.skipped} ảnh không đoán được nhóm từ tên nên vẫn ở mục Chưa phân nhóm.` : ''}`);
      await loadGroups(true);
      if (groupId === UNGROUPED_GROUP_ID) await loadFiles(true);
    } catch (error) {
      setGroupMessage((error as { message?: string }).message || 'Không chia nhóm được.');
    } finally {
      setProjectAction('');
    }
  };

  const refresh = () => void Promise.all([loadGroups(true), loadFiles()]);

  const selectedProject = projects.find((project) => project.id === projectId);
  const activeGroup = groupId && groupId !== UNGROUPED_GROUP_ID ? groups.find((group) => group.id === groupId) : undefined;
  const groupTitle = groupId === UNGROUPED_GROUP_ID ? 'Chưa phân nhóm' : activeGroup?.name ?? 'Đang tải nhóm…';
  const groupComplete = Boolean(activeGroup && activeGroup.total > 0 && activeGroup.done === activeGroup.total);
  const totals = groups.reduce((sum, group) => ({ total: sum.total + group.total, done: sum.done + group.done }), { total: 0, done: 0 });
  const searching = Boolean(search.trim());

  const fileList = (
    <>
      {message ? <p role="status" aria-live="polite" className="notice warning">{message}</p> : null}
      <section className="file-grid" aria-busy={filesLoading} aria-label="Danh sách ảnh">
        {filesLoading ? Array.from({ length: 8 }, (_, index) => <div className="file-card skeleton" key={index} />) : null}
        {!filesLoading && files.map((file) => (
          <FileCard key={file.id} file={file} isAdmin={isAdmin} showGroup={!groupId} opening={openingId === file.id}
            onOpen={() => openFile(file)} onVersions={() => setVersionFile(file)} />
        ))}
      </section>
      {!filesLoading && !files.length && !message ? (
        <p className="empty-inline">{searching ? 'Không có ảnh nào khớp tên đã nhập.' : 'Không có ảnh nào ở mục này.'}</p>
      ) : null}
      {!filesLoading && totalFiles > PAGE_SIZE ? (
        <nav className="dashboard-pagination" aria-label="Phân trang danh sách ảnh">
          <button className="button ghost" type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Trang trước</button>
          <span>Trang <strong>{page}</strong> / {pageCount} · {totalFiles} ảnh</span>
          <button className="button ghost" type="button" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>Trang sau</button>
        </nav>
      ) : null}
    </>
  );

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
          <div><strong>{user.displayName}</strong><small>{roleLabels[user.role] ?? user.role}</small></div>
          <button className="button ghost" onClick={async () => { await logout(); router.replace('/login'); router.refresh(); }}>Đăng xuất</button>
        </div>
      </header>

      {projects.length ? (
        <section className="project-bar panel" aria-label="Dự án đang làm">
          <label className="project-select">
            <span>Dự án</span>
            {projects.length > 1 ? (
              <select name="project" autoComplete="off" value={projectId} onChange={(event) => changeProject(event.target.value)}>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            ) : <strong className="project-name">{selectedProject?.name}</strong>}
          </label>
          <div className="project-progress">
            <div className="progress-label">
              <span>{isAdmin ? 'Tiến độ dự án' : 'Tiến độ nhóm được giao'}</span>
              <strong>{totals.done}/{totals.total} ảnh hoàn tất</strong>
            </div>
            <ProgressBar done={totals.done} total={totals.total} label="Tiến độ hoàn tất" />
            {isAdmin && ungrouped ? <small>{ungrouped} ảnh chưa phân nhóm</small> : null}
          </div>
          <button className="button ghost refresh-button" type="button" disabled={groupsLoading || filesLoading || !projectId} onClick={refresh}>
            <span aria-hidden="true">↻</span> {groupsLoading || filesLoading ? 'Đang tải…' : 'Làm mới'}
          </button>
        </section>
      ) : null}

      {isAdmin ? (
        <nav className="view-tabs" aria-label="Chế độ xem">
          {views.map((item) => (
            <button key={item.value} type="button" className={view === item.value ? 'active' : ''} aria-current={view === item.value ? 'page' : undefined}
              onClick={() => {
                setView(item.value);
                // Vừa nhập dữ liệu hoặc tạo dự án ở tab khác: số liệu nhóm cần đọc lại.
                if (item.value === 'groups' && item.value !== view) void loadGroups(true);
              }}>{item.label}</button>
          ))}
        </nav>
      ) : null}

      {view === 'groups' && projectsLoaded && !projects.length ? (
        <div className="empty-state panel">
          {isAdmin ? <>
            <h2>Chưa có dự án</h2>
            <p>Tải thư mục ảnh lên ở tab Nhập dữ liệu, hoặc kết nối manifest có sẵn ở tab Quản trị.</p>
            <button className="button primary" type="button" onClick={() => setView('import')}>Nhập dữ liệu</button>
          </> : <>
            <h2>Bạn chưa được giao nhóm ảnh nào</h2>
            <p>Quản trị viên sẽ giao nhóm ảnh cho bạn. Sau khi được giao, bấm Làm mới hoặc tải lại trang.</p>
          </>}
        </div>
      ) : null}

      {view === 'groups' && projects.length && !groupId ? (
        <section className="groups-section" aria-labelledby="groups-title">
          <div className="section-row">
            <div>
              <p className="eyebrow">{isAdmin ? 'Nhóm ảnh' : 'Việc của tôi'}</p>
              <h2 id="groups-title">{isAdmin ? 'Nhóm ảnh trong dự án' : 'Nhóm được giao cho bạn'}</h2>
              <p className="section-hint">Chọn một nhóm để xem danh sách ảnh cần làm.</p>
            </div>
            <label className="search-field">
              <span>Tìm ảnh trong mọi nhóm</span>
              <input name="file-search" type="search" autoComplete="off" spellCheck={false} value={search}
                onChange={(event) => { setPage(1); setSearch(event.target.value); }} placeholder="Ví dụ: 8582_01…" />
            </label>
          </div>
          {groupMessage ? <p role="status" aria-live="polite" className="notice">{groupMessage}</p> : null}
          {groupsError ? <p role="status" aria-live="polite" className="notice warning">{groupsError}</p> : null}
          {searching ? fileList : (
            <>
              <div className="group-grid" aria-busy={groupsLoading}>
                {groupsLoading && !groups.length ? Array.from({ length: 4 }, (_, index) => <div className="group-card skeleton" key={index} />) : null}
                {groups.map((group) => (
                  <GroupCard key={group.id} group={group} isAdmin={isAdmin} onOpen={() => openGroup(group.id)} onAssign={() => setAssignGroup(group)} />
                ))}
                {isAdmin && ungrouped ? (
                  <article className="group-card ungrouped">
                    <div className="group-card-head"><h3>Chưa phân nhóm</h3><span className="group-count">{ungrouped} ảnh</span></div>
                    <p>Ảnh chưa thuộc nhóm nào nên người gán nhãn chưa thấy. Có thể chia theo tên ảnh (8582_01 → nhóm 8582).</p>
                    <div className="group-actions">
                      <button className="button primary" type="button" disabled={projectAction !== ''} onClick={() => void autoGroup()}>
                        {projectAction === 'auto-group' ? 'Đang chia nhóm…' : 'Tự động chia nhóm'}
                      </button>
                      <button className="button ghost" type="button" onClick={() => openGroup(UNGROUPED_GROUP_ID)}>Xem ảnh</button>
                    </div>
                  </article>
                ) : null}
              </div>
              {!groupsLoading && !groupsError && !groups.length && !ungrouped ? (
                <div className="empty-state panel">
                  {isAdmin ? <>
                    <h2>Dự án chưa có ảnh</h2>
                    <p>Tải thư mục ảnh lên ở tab Nhập dữ liệu; mỗi thư mục con sẽ thành một nhóm.</p>
                    <button className="button primary" type="button" onClick={() => setView('import')}>Nhập dữ liệu</button>
                  </> : <>
                    <h2>Chưa có nhóm nào trong dự án này</h2>
                    <p>Quản trị viên chưa giao nhóm ảnh của dự án này cho bạn.</p>
                  </>}
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {view === 'groups' && groupId ? (
        <section className="group-detail" aria-labelledby="group-title">
          <nav className="breadcrumb" aria-label="Đường dẫn">
            <button type="button" className="link-button" onClick={closeGroup}><span aria-hidden="true">←</span> Tất cả nhóm</button>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{groupTitle}</span>
          </nav>
          <div className="group-hero panel">
            <div className="group-hero-main">
              <p className="eyebrow">Nhóm ảnh</p>
              <h2 id="group-title">{groupTitle}</h2>
              {activeGroup ? <>
                <p>{activeGroup.done}/{activeGroup.total} ảnh hoàn tất{activeGroup.locked ? ` · ${activeGroup.locked} ảnh đang được mở` : ''}</p>
                <ProgressBar done={activeGroup.done} total={activeGroup.total} label={`Tiến độ nhóm ${activeGroup.name}`} />
                {isAdmin ? <AssigneeList assignees={activeGroup.assignees} /> : null}
              </> : groupId === UNGROUPED_GROUP_ID
                ? <p>{ungrouped} ảnh chưa thuộc nhóm nào. Chỉ quản trị viên thấy các ảnh này.</p>
                : <p>Đang tải thông tin nhóm…</p>}
            </div>
            <div className="group-hero-actions">
              {activeGroup ? (
                <button className="button primary" type="button" disabled={findingNext || groupComplete || !activeGroup.total} onClick={() => void openNextInGroup()}>
                  {findingNext ? 'Đang tìm…' : groupComplete ? 'Nhóm đã hoàn tất' : !activeGroup.total ? 'Nhóm chưa có ảnh' : 'Làm ảnh tiếp theo →'}
                </button>
              ) : null}
              {isAdmin && activeGroup ? <button className="button ghost" type="button" onClick={() => setAssignGroup(activeGroup)}>Phân công</button> : null}
              {isAdmin && groupId === UNGROUPED_GROUP_ID ? (
                <button className="button primary" type="button" disabled={projectAction !== ''} onClick={() => void autoGroup()}>
                  {projectAction === 'auto-group' ? 'Đang chia nhóm…' : 'Tự động chia nhóm theo tên ảnh'}
                </button>
              ) : null}
            </div>
          </div>
          {groupMessage ? <p role="status" aria-live="polite" className="notice">{groupMessage}</p> : null}
          <div className="list-controls">
            <label className="search-field">
              <span>Tìm trong nhóm</span>
              <input name="group-file-search" type="search" autoComplete="off" spellCheck={false} value={search}
                onChange={(event) => { setPage(1); setSearch(event.target.value); }} placeholder="Ví dụ: 8582_01…" />
            </label>
            <nav className="filter-tabs" aria-label="Lọc ảnh trong nhóm">
              {filters.map((item) => {
                const count = filterCount(activeGroup, item.value);
                return (
                  <button key={item.value} type="button" className={filter === item.value ? 'active' : ''} aria-pressed={filter === item.value}
                    onClick={() => { setPage(1); setFilter(item.value); }}>
                    {item.label}{count === undefined ? null : <span className="filter-count">{count}</span>}
                  </button>
                );
              })}
            </nav>
          </div>
          {fileList}
        </section>
      ) : null}

      {view === 'groups' && selectedProject && !groupId ? (
        <section className="project-data-actions panel" aria-label="Đồng bộ và xuất dữ liệu">
          <div>
            <p className="eyebrow">Dữ liệu dự án</p>
            <strong>{selectedProject.name}</strong>
            <small>Bấm Cập nhật Drive để gửi bản nháp và bản hoàn tất đã lưu server, gồm mask và point u vấu.</small>
            <small>
              Google Drive: {googleDriveStatus.connected ? 'Đã kết nối' : 'Chưa kết nối'}
              {googleDriveStatus.connected && googleDriveStatus.accountEmail ? ` · ${googleDriveStatus.accountEmail}` : ''}
            </small>
            {!googleDriveStatus.connected && !isAdmin ? (
              <small>Google Drive chưa được quản trị viên kết nối.</small>
            ) : null}
          </div>
          <div className="project-action-buttons">
            {isAdmin && !googleDriveStatus.connected ? (
              googleDriveStatus.configured
                ? <a className="button ghost download-button" href="/api/google/connect">Kết nối Google Drive</a>
                : <button className="button ghost" disabled>Kết nối Google Drive</button>
            ) : null}
            {isAdmin && googleDriveStatus.connected ? (
              <button className="button ghost" disabled={projectAction !== ''} onClick={() => void runProjectAction('disconnect-drive', async () => {
                await disconnectGoogleDrive();
                setGoogleDriveStatus((current) => ({ ...current, connected: false, accountEmail: null }));
                setProjectMessage('Đã ngắt kết nối Google Drive.');
              })}>{projectAction === 'disconnect-drive' ? 'Đang ngắt…' : 'Ngắt kết nối'}</button>
            ) : null}
            {isAdmin && selectedProject.driveFolderId ? (
              <button className="button secondary" disabled={projectAction !== ''} onClick={() => void runProjectAction('source', async () => {
                const result = await syncProject(projectId);
                setProjectMessage(`Đã đọc manifest nguồn: thêm ${result.added}, cập nhật ${result.updated}, lỗi ${result.missing}.`);
                await Promise.all([loadProjects(), loadGroups(true)]);
              })}>{projectAction === 'source' ? 'Đang đồng bộ…' : 'Đồng bộ nguồn'}</button>
            ) : null}
            <button className="button primary" disabled={projectAction !== '' || !googleDriveStatus.connected} onClick={() => void runProjectAction('drive', async () => {
              const result = await exportProject(projectId);
              setProjectMessage(result.errors.length
                ? `Drive chưa đồng bộ đầy đủ: ${result.errors.map((error) => `${error.id}: ${error.message}`).join('; ')}`
                : `Drive: cập nhật ${result.updated} tệp, ${result.skipped} tệp không đổi. Tổng ${result.exported} tệp đã lưu server. Kiểm tra point trong wart-points.jsonl.`);
              setDriveUrl(result.driveFolderUrl);
            })}>{projectAction === 'drive' ? 'Đang cập nhật…' : 'Cập nhật Drive'}</button>
            <a className="button ghost download-button" href={projectExportDownloadUrl(projectId)} download>Tải ZIP về máy</a>
          </div>
        </section>
      ) : null}

      {projectMessage && view === 'groups' && !groupId ? <p role="status" aria-live="polite" className="notice project-action-notice">
        {projectMessage}{driveUrl ? <> <a href={driveUrl} target="_blank" rel="noreferrer">Mở thư mục Drive</a></> : null}
      </p> : null}

      {isAdmin && view === 'import' ? (
        <DatasetImport projects={projects} currentProjectId={projectId} onProjectsChanged={loadProjects}
          onOpenProject={(id) => {
            setView('groups');
            if (id !== projectId) changeProject(id);
            else { closeGroup(); void loadGroups(); }
          }} />
      ) : null}
      {isAdmin && view === 'admin' ? <AdminPanel onChanged={loadProjects} /> : null}

      {isAdmin && versionFile ? <FileVersions key={versionFile.id} fileId={versionFile.id} name={versionFile.externalKey} onClose={() => setVersionFile(null)} onActivated={() => void loadFiles(true)} /> : null}
      {isAdmin && assignGroup ? (
        <GroupAssignDialog key={assignGroup.id} projectId={projectId} group={assignGroup} onClose={() => setAssignGroup(null)}
          onSaved={(assignees) => {
            setGroups((current) => current.map((group) => (group.id === assignGroup.id ? { ...group, assignees } : group)));
            setGroupMessage(assignees.length
              ? `Đã giao nhóm ${assignGroup.name} cho ${assignees.map((assignee) => assignee.displayName).join(', ')}.`
              : `Nhóm ${assignGroup.name} hiện không giao cho ai.`);
            setAssignGroup(null);
          }} />
      ) : null}
    </main>
  );
}

function ProgressBar({ done, total, label }: { done: number; total: number; label: string }) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className={`progress-track ${total && done === total ? 'complete' : ''}`} role="progressbar"
      aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

function AssigneeList({ assignees }: { assignees: FileGroupSummary['assignees'] }) {
  if (!assignees.length) return <p className="group-assignees empty">Chưa giao cho ai</p>;
  return (
    <ul className="group-assignees" aria-label="Người được giao">
      {assignees.slice(0, 4).map((assignee) => (
        <li key={assignee.userId} title={assignee.displayName}>
          <span className="avatar small" aria-hidden="true">{assignee.displayName.slice(0, 1).toUpperCase()}</span>
          {assignee.displayName}
        </li>
      ))}
      {assignees.length > 4 ? <li className="more">+{assignees.length - 4}</li> : null}
    </ul>
  );
}

function GroupCard({ group, isAdmin, onOpen, onAssign }: { group: FileGroupSummary; isAdmin: boolean; onOpen(): void; onAssign(): void }) {
  const complete = group.total > 0 && group.done === group.total;
  return (
    <article className={`group-card ${complete ? 'complete' : ''}`}>
      <div className="group-card-head">
        <h3>{group.name}</h3>
        <span className="group-count">{group.total} ảnh</span>
      </div>
      <ProgressBar done={group.done} total={group.total} label={`Tiến độ nhóm ${group.name}`} />
      <dl className="group-stats">
        <div><dt>Chưa làm</dt><dd>{group.unstarted}</dd></div>
        <div><dt>Bản nháp</dt><dd>{group.draft}</dd></div>
        <div><dt>Hoàn tất</dt><dd>{group.done}</dd></div>
      </dl>
      {group.locked ? <p className="group-live"><span aria-hidden="true" />{group.locked} ảnh đang được mở</p> : null}
      {isAdmin ? <AssigneeList assignees={group.assignees} /> : null}
      <div className="group-actions">
        <button className="button primary" type="button" onClick={onOpen}>{complete ? 'Xem nhóm' : 'Mở nhóm'}</button>
        {isAdmin ? <button className="button ghost" type="button" onClick={onAssign}>Phân công</button> : null}
      </div>
    </article>
  );
}

function FileCard({ file, isAdmin, showGroup, opening, onOpen, onVersions }: {
  file: FileListItem; isAdmin: boolean; showGroup: boolean; opening: boolean; onOpen(): void; onVersions(): void;
}) {
  const locked = file.lock.state === 'LOCKED';
  const assetError = file.assetState === 'ERROR';
  const status = assetError
    ? 'Thiếu ảnh nguồn hoặc mặt nạ gợi ý'
    : file.lock.state === 'LOCKED'
      ? `Đang được ${file.lock.displayName} chỉnh sửa`
      : file.annotationState === 'DONE' ? 'Đã hoàn tất' : file.annotationState === 'DRAFT' ? 'Có bản nháp đã lưu' : 'Sẵn sàng chỉnh sửa';
  const action = opening ? 'Đang mở…' : locked ? 'Chỉ xem' : file.annotationState === 'DONE' ? 'Chỉnh sửa lại'
    : file.annotationState === 'DRAFT' ? 'Tiếp tục' : 'Bắt đầu';
  return (
    <article className={`file-card ${locked ? 'locked' : ''}`}>
      <FileThumbnail key={file.thumbnailUrl} file={file} />
      <div className="file-card-body">
        <div className="file-title-row"><h3>{file.externalKey}</h3><StateBadge state={file.annotationState} /></div>
        <p>{status}</p>
        {showGroup ? <small>{file.group ? `Nhóm ${file.group.name}` : 'Chưa phân nhóm'}</small> : null}
        <div className="file-card-actions">
          <button className="button primary" disabled={assetError || opening} onClick={onOpen}>{action}</button>
          {isAdmin ? <button className="button ghost" onClick={onVersions}>Xem / xóa version</button> : null}
        </div>
      </div>
    </article>
  );
}

function FileThumbnail({ file }: { file: FileListItem }) {
  const [failed, setFailed] = useState(false);
  return <div className="file-preview">
    {file.thumbnailUrl && !failed
      ? <Image src={file.thumbnailUrl} alt={`Ảnh gốc ${file.externalKey}`} width={640} height={400}
          unoptimized loading="lazy" decoding="async" onError={() => setFailed(true)} />
      : <div className="file-preview-fallback"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 6-6 4 4 3-3 5 5" /></svg><span>Chưa có ảnh xem trước</span></div>}
  </div>;
}

function StateBadge({ state }: { state: FileListItem['annotationState'] }) {
  const labels = { UNSTARTED: 'Chưa làm', DRAFT: 'Bản nháp', DONE: 'Hoàn tất' };
  return <span className={`state-badge ${state.toLowerCase()}`}>{labels[state]}</span>;
}

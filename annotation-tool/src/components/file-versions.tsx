'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import type { SegmentationAnnotation } from '@/types';

interface Version { id: string; versionNumber: number; label: string | null; createdAt: string; createdBy: string; active: boolean }
interface Current { revision: number; lockedBy: string | null }
interface VersionList { versions: Version[]; current: Current }
interface Detail { width: number; height: number; currentRevision: number; imageUrl: string; maskUrl: string; segmentation: SegmentationAnnotation }

async function request<T>(url: string, method = 'GET', payload?: unknown): Promise<T> {
  const response = await fetch(url, {
    method, cache: 'no-store',
    ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  const body = await response.json();
  if (!response.ok) throw Error(body.message || 'Không thực hiện được thao tác.');
  return body;
}

export default function FileVersions({ fileId, name, onClose, onActivated }: { fileId: string; name: string; onClose(): void; onActivated?(): void }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const requestId = useRef(0);
  const [versions, setVersions] = useState<Version[]>([]);
  const [current, setCurrent] = useState<Current | null>(null);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'activate' | 'delete' | null>(null);
  const [opacity, setOpacity] = useState(0.55);
  const [zoom, setZoom] = useState(1);
  const [layer, setLayer] = useState<'polygon' | 'pixel' | 'none'>('polygon');
  const base = `/api/files/${fileId}/versions`;

  const applyList = (data: VersionList) => { setVersions(data.versions); setCurrent(data.current); };

  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void request<VersionList>(base).then((data) => { if (active) { setVersions(data.versions); setCurrent(data.current); } })
      .catch((e: Error) => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; requestId.current += 1; };
  }, [base]);

  async function view(id: string) {
    const sequence = ++requestId.current;
    setSelected(id); setDetail(null); setLoading(true); setError(''); setNotice(''); setConfirm(null); setZoom(1);
    try { const data = await request<Detail>(`${base}/${id}`); if (sequence === requestId.current) setDetail(data); }
    catch (e) { if (sequence === requestId.current) setError((e as Error).message); }
    finally { if (sequence === requestId.current) setLoading(false); }
  }

  async function remove() {
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`${base}/${selected}`, 'DELETE');
      setVersions((rows) => rows.filter((v) => v.id !== selected));
      setSelected(''); setDetail(null); setConfirm(null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function activate() {
    const version = versions.find((v) => v.id === selected);
    if (!version || !current) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<{ revision: number; previousVersionNumber: number | null }>(
        `${base}/${selected}`, 'POST', { baseRevision: current.revision },
      );
      applyList(await request<VersionList>(base));
      setConfirm(null);
      setNotice(`Đã đặt v${version.versionNumber} làm bản chính. Mọi người mở ảnh này sẽ thấy và chỉnh tiếp từ version này.${
        result.previousVersionNumber ? ` Bản chính trước đó được lưu thành v${result.previousVersionNumber}.` : ''}`);
      onActivated?.();
    } catch (e) {
      setError((e as Error).message);
      // Revision/khoa co the vua doi: tai lai de lan thu sau dung du lieu moi nhat.
      await request<VersionList>(base).then(applyList).catch(() => undefined);
    } finally { setBusy(false); }
  }

  const chosen = versions.find((v) => v.id === selected);
  const messages = <>
    {error ? <p role="alert" className="notice warning">{error}</p> : null}
    {notice ? <p role="status" className="notice success">{notice}</p> : null}
  </>;
  return <dialog ref={dialog} className="versions-dialog" onCancel={onClose} aria-labelledby="versions-title">
    <header className="versions-header"><div><h2 id="versions-title">Version của {name}</h2><p>Chỉ ADMIN · Chọn một version rồi đặt làm bản chính: mọi người mở ảnh sẽ thấy version đó.</p></div><button className="button ghost" onClick={onClose}>Đóng</button></header>
    {!selected ? messages : null}
    {current?.lockedBy ? <p className="notice warning">Ảnh đang được {current.lockedBy} mở trong editor. Nếu là người khác, hãy chờ họ đóng editor; nếu là bạn ở tab khác, tab đó sẽ chuyển sang xung đột và giữ bản nháp.</p> : null}
    <div className="versions-layout">
      <nav aria-label="Danh sách version">{versions.map((version) => <button key={version.id} className={`button ${selected === version.id ? 'primary' : 'ghost'}`} disabled={busy} onClick={() => void view(version.id)}>
        <strong>v{version.versionNumber} · {version.label || 'Bản lưu'}{version.active ? <span className="version-badge">Bản chính</span> : null}</strong><small>{new Date(version.createdAt).toLocaleString('vi-VN')} · {version.createdBy || 'Hệ thống'}</small>
      </button>)}{!loading && !versions.length ? <p>Ảnh chưa có version đã lưu.</p> : null}
      {!loading && versions.length && !versions.some((v) => v.active) ? <p className="versions-hint">Bản chính hiện là bản đang chỉnh sửa (đã sửa sau lần lưu version gần nhất).</p> : null}</nav>
      <section aria-label="Xem version" aria-busy={loading || busy}>
        {selected ? messages : null}
        {loading ? <p role="status">Đang tải…</p> : !detail || !chosen ? <p>Chọn một version để xem ảnh và mask.</p> : <>
          <div className="versions-actions">
            {chosen.active ? <>
              <span className="version-badge">v{chosen.versionNumber} đang là bản chính</span>
              <button className="button ghost" onClick={() => router.push(`/editor/${fileId}`)}>Mở editor</button>
            </> : confirm === 'activate' ? <div role="alert" className="versions-confirm">
              <p>Đặt v{chosen.versionNumber} làm bản chính cho mọi người? Bản chính hiện tại được lưu thành một version mới, không bị mất.</p>
              <button className="button primary" disabled={busy} onClick={() => void activate()}>{busy ? 'Đang đặt…' : 'Xác nhận đặt làm bản chính'}</button>{' '}
              <button className="button ghost" disabled={busy} onClick={() => setConfirm(null)}>Hủy</button>
            </div> : <button className="button primary" disabled={busy} onClick={() => { setError(''); setNotice(''); setConfirm('activate'); }}>Đặt làm bản chính cho mọi người</button>}
            <a className="button ghost" href={`${base}/${selected}/export`} download>Tải JSON và mask</a>
            {confirm === 'delete' ? <div role="alert" className="versions-confirm"><p>Xóa v{chosen.versionNumber} khỏi lịch sử? Bản chính và các version khác vẫn được giữ.</p><button className="button danger" disabled={busy} onClick={() => void remove()}>Xác nhận xóa version</button>{' '}<button className="button ghost" onClick={() => setConfirm(null)}>Hủy</button></div>
              : confirm === null ? <button className="button danger" disabled={busy} onClick={() => setConfirm('delete')}>Xóa version này</button> : null}
          </div>
          <div className="versions-controls"><label>Mask <input aria-label="Độ rõ mask" type="range" min="0" max="1" step="0.05" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></label><label>Zoom <input aria-label="Zoom version" type="range" min="1" max="4" step="0.25" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label><span>{detail.width} × {detail.height}</span></div>
          <label>Lớp hiển thị <select value={layer} onChange={e => setLayer(e.target.value as typeof layer)}><option value="polygon">Polygon và boundary gốc</option><option value="pixel">Mask pixel gốc</option><option value="none">Chỉ ảnh</option></select></label>
          <div className="versions-preview"><div style={{ position: 'relative', width: `${zoom * 100}%`, aspectRatio: `${detail.width}/${detail.height}` }}>
            <Image unoptimized src={detail.imageUrl} alt={`${name}, version ${chosen.versionNumber}`} width={detail.width} height={detail.height} style={{ width: '100%', height: '100%', display: 'block' }} onError={() => setError('Không tải được ảnh của version.')} />
            {layer !== 'none' ? <Image unoptimized src={layer === 'polygon' ? `${base}/${selected}/assets/boundary` : detail.maskUrl} alt={layer === 'polygon' ? 'Các polygon và boundary nguyên vẹn' : 'Mask pixel của version'} width={detail.width} height={detail.height} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity, ...(layer === 'pixel' ? { mixBlendMode: 'screen', imageRendering: 'pixelated' } : {}) }} onError={() => setError('Không tải được lớp hiển thị của version.')} /> : null}
          </div></div>
          <p>{detail.segmentation.maskOperations?.filter((op) => op.type === 'POLYGON_SET').reduce((sum, op) => sum + op.polygons.length, 0) || 0} polygon · {detail.segmentation.wartPoints?.points.length || 0} điểm u vấu</p>
        </>}
      </section>
    </div>
  </dialog>;
}

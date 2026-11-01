'use client';

import { useMemo, useRef, useState } from 'react';
import type { ApiError, ProjectSummary } from '@/types';
import { createUploadProject, importDatasetItem } from '@/lib/api-client';
import {
  annotationsByImage, buildPrelabelDocument, cocoImagePolygons, guessCategoryTarget, type CategoryTarget,
} from '@/lib/coco-import';
import {
  isPlanJsonCandidate, planCocoImport, planDefaultImport, summarizePlan,
  type GroupingMode, type ImportEntry, type ImportFormat, type ParsedJsonFile, type PlannedItem,
} from '@/lib/import-plan';

/** Ba request song song: đủ nhanh mà không dồn quá nhiều ảnh vào một lúc trên mạng yếu. */
const CONCURRENCY = 3;
const NEW_PROJECT = '__new__';

interface Failure { item: PlannedItem<File>; message: string }
interface Progress {
  projectId: string;
  total: number;
  done: number;
  created: number;
  updated: number;
  invalidAnnotations: number;
  failures: Failure[];
  running: boolean;
  stopped: boolean;
}

const targetLabels: Record<CategoryTarget, string> = { r: 'Vết gợn (r*)', w: 'U vấu (w*)', skip: 'Bỏ qua' };

/** Prelabel JSON nén ~10 lần, giúp ảnh + polygon nằm dưới giới hạn request của máy chủ. */
async function gzipJson(text: string): Promise<Blob> {
  if (typeof CompressionStream === 'undefined') return new Blob([text], { type: 'application/json' });
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

export default function DatasetImport({ projects, currentProjectId, onProjectsChanged, onOpenProject }: {
  projects: ProjectSummary[];
  currentProjectId: string;
  onProjectsChanged(): Promise<void>;
  onOpenProject(projectId: string): void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stopRef = useRef(false);
  const [format, setFormat] = useState<ImportFormat>('default');
  const [grouping, setGrouping] = useState<GroupingMode>('folder');
  const [target, setTarget] = useState(currentProjectId || NEW_PROJECT);
  const [newName, setNewName] = useState('');
  const [entries, setEntries] = useState<ImportEntry<File>[]>([]);
  const [jsonFiles, setJsonFiles] = useState<ParsedJsonFile[]>([]);
  const [jsonErrors, setJsonErrors] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [categoryTargets, setCategoryTargets] = useState<Record<string, CategoryTarget>>({});
  const [progress, setProgress] = useState<Progress | null>(null);

  const plan = useMemo(() => (format === 'coco'
    ? planCocoImport(entries, jsonFiles, grouping)
    : planDefaultImport(entries, jsonFiles, grouping)), [entries, format, grouping, jsonFiles]);
  const groups = useMemo(() => summarizePlan(plan), [plan]);
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const dataset of plan.cocoSets) {
      const names = new Map(dataset.categories.map((category) => [String(category.id), String(category.name)]));
      for (const annotation of dataset.annotations) {
        const name = names.get(String(annotation.category_id));
        if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      for (const name of names.values()) if (!counts.has(name)) counts.set(name, 0);
    }
    return [...counts].map(([name, count]) => ({ name, count }));
  }, [plan]);

  const scan = async (files: File[], nextFormat: ImportFormat) => {
    setScanning(true);
    setError('');
    setProgress(null);
    try {
      const list = files.map((file) => ({ path: file.webkitRelativePath || file.name, file }));
      const parsed: ParsedJsonFile[] = [];
      const errors: string[] = [];
      for (const entry of list) {
        if (!isPlanJsonCandidate(entry.path, nextFormat)) continue;
        try {
          parsed.push({ path: entry.path, value: JSON.parse(await entry.file.text()) });
        } catch {
          errors.push(`${entry.path}: không đọc được JSON.`);
        }
      }
      setEntries(list);
      setJsonFiles(parsed);
      setJsonErrors(errors);
      if (nextFormat === 'coco') {
        const guessed: Record<string, CategoryTarget> = {};
        for (const json of parsed) {
          const declared = (json.value as { categories?: Array<{ name?: unknown }> } | null)?.categories;
          if (Array.isArray(declared)) for (const category of declared) {
            const name = String(category?.name ?? '');
            guessed[name] = categoryTargets[name] ?? guessCategoryTarget(name);
          }
        }
        setCategoryTargets(guessed);
      }
    } finally {
      setScanning(false);
    }
  };

  const changeFormat = (next: ImportFormat) => {
    setFormat(next);
    if (entries.length) void scan(entries.map((entry) => entry.file), next);
  };

  const run = async (items: PlannedItem<File>[]) => {
    setError('');
    stopRef.current = false;
    let projectId = target;
    if (target === NEW_PROJECT) {
      try {
        projectId = (await createUploadProject(newName.trim())).id;
      } catch (e) {
        setError((e as ApiError).message || 'Không tạo được dự án.');
        return;
      }
      setTarget(projectId);
      await onProjectsChanged().catch(() => undefined);
    }
    const annotationIndex = plan.cocoSets.map(annotationsByImage);
    const targetsBySet = plan.cocoSets.map((dataset) => new Map(dataset.categories.map((category) => (
      [String(category.id), categoryTargets[String(category.name)] ?? 'skip'] as const
    ))));
    const state: Progress = {
      projectId, total: items.length, done: 0, created: 0, updated: 0, invalidAnnotations: 0, failures: [], running: true, stopped: false,
    };
    const publish = () => setProgress({ ...state, failures: [...state.failures] });
    publish();
    let cursor = 0;
    const worker = async () => {
      while (!stopRef.current && cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        try {
          const form = new FormData();
          form.set('meta', JSON.stringify({ externalKey: item.externalKey, group: item.group }));
          form.set('image', item.image, item.image.name);
          if (item.prediction) form.set('prediction', item.prediction, item.prediction.name);
          if (item.prelabel) form.set('prelabel', await gzipJson(await item.prelabel.text()), 'prelabel.json.gz');
          if (item.coco) {
            const { setIndex, imageId, width, height } = item.coco;
            const conversion = cocoImagePolygons(annotationIndex[setIndex].get(imageId) ?? [], targetsBySet[setIndex], width, height);
            state.invalidAnnotations += conversion.invalid;
            const document = buildPrelabelDocument(item.externalKey, width, height, conversion.polygons);
            form.set('prelabel', await gzipJson(JSON.stringify(document)), 'prelabel.json.gz');
          }
          const result = await importDatasetItem(projectId, form);
          if (result.created) state.created += 1; else state.updated += 1;
        } catch (e) {
          state.failures.push({ item, message: (e as ApiError).message || 'Không nhập được ảnh.' });
        }
        state.done += 1;
        publish();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    state.running = false;
    state.stopped = stopRef.current;
    publish();
    await onProjectsChanged().catch(() => undefined);
  };

  const running = Boolean(progress?.running);
  const rootLabel = entries.length ? plan.rootName : '';
  const needsName = target === NEW_PROJECT && !newName.trim();
  const warnings = [...jsonErrors, ...plan.warnings];
  const percent = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <section className="import-section" aria-labelledby="import-title">
      <div className="section-heading">
        <p className="eyebrow">Nhập dữ liệu</p>
        <h2 id="import-title">Tải thư mục ảnh lên</h2>
        <p className="section-hint">Mỗi thư mục con (mỗi giống khổ qua) trở thành một nhóm để phân công.</p>
      </div>
      <div className="import-layout">
        <div className="panel import-card">
          <div className="import-step">
            <h3><span>1</span> Dự án nhận dữ liệu</h3>
            <select name="import-project" value={target} disabled={running} onChange={(event) => setTarget(event.target.value)}>
              <option value={NEW_PROJECT}>+ Tạo dự án mới</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            {target === NEW_PROJECT ? (
              <input name="import-project-name" autoComplete="off" value={newName} disabled={running}
                onChange={(event) => setNewName(event.target.value)} placeholder="Tên dự án mới, ví dụ: Khổ qua đợt 2…" />
            ) : null}
          </div>

          <div className="import-step">
            <h3><span>2</span> Định dạng dữ liệu</h3>
            <div className="choice-cards" role="radiogroup" aria-label="Định dạng dữ liệu">
              <label className={format === 'default' ? 'selected' : ''}>
                <input type="radio" name="import-format" checked={format === 'default'} disabled={running} onChange={() => changeFormat('default')} />
                <strong>Mặc định (manifest.json)</strong>
                <small>Định dạng hệ thống đang dùng: manifest.json + images/ + predictions/ (+ prelabels/).</small>
              </label>
              <label className={format === 'coco' ? 'selected' : ''}>
                <input type="radio" name="import-format" checked={format === 'coco'} disabled={running} onChange={() => changeFormat('coco')} />
                <strong>COCO 1.0</strong>
                <small>annotations/instances_*.json + images/ (vd. xuất từ CVAT). Mask dạng polygon hoặc RLE.</small>
              </label>
            </div>
          </div>

          <div className="import-step">
            <h3><span>3</span> Cách chia nhóm</h3>
            <div className="choice-cards compact" role="radiogroup" aria-label="Cách chia nhóm">
              <label className={grouping === 'folder' ? 'selected' : ''}>
                <input type="radio" name="import-grouping" checked={grouping === 'folder'} disabled={running} onChange={() => setGrouping('folder')} />
                <strong>Theo thư mục con</strong>
                <small>khoqua/8582/… → nhóm 8582</small>
              </label>
              <label className={grouping === 'prefix' ? 'selected' : ''}>
                <input type="radio" name="import-grouping" checked={grouping === 'prefix'} disabled={running} onChange={() => setGrouping('prefix')} />
                <strong>Theo tên ảnh</strong>
                <small>8582_01.jpg → nhóm 8582</small>
              </label>
            </div>
          </div>

          <div className="import-step">
            <h3><span>4</span> Chọn thư mục</h3>
            <input
              ref={(element) => {
                inputRef.current = element;
                // Thuộc tính chọn cả thư mục chưa có trong kiểu React; đặt trực tiếp lên DOM.
                element?.setAttribute('webkitdirectory', '');
                element?.setAttribute('directory', '');
              }}
              className="visually-hidden" type="file" multiple tabIndex={-1} aria-hidden="true"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                if (files.length) void scan(files, format);
              }}
            />
            <div className="folder-picker">
              <button className="button secondary" type="button" disabled={running || scanning} onClick={() => inputRef.current?.click()}>
                {scanning ? 'Đang đọc thư mục…' : entries.length ? 'Chọn thư mục khác…' : 'Chọn thư mục…'}
              </button>
              <small>{rootLabel ? `${rootLabel} · ${entries.length} tệp` : 'Chưa chọn thư mục'}</small>
            </div>
          </div>
        </div>

        <div className="panel import-card import-preview" aria-live="polite">
          <h3>Xem trước</h3>
          {error ? <p role="alert" className="notice warning">{error}</p> : null}
          {!entries.length ? (
            <p className="muted">Chọn thư mục để xem các nhóm sẽ được tạo trước khi nhập.</p>
          ) : (
            <>
              <p className="import-summary"><strong>{plan.items.length}</strong> ảnh · <strong>{groups.length}</strong> nhóm{warnings.length ? <> · <span className="warning-text">{warnings.length} cảnh báo</span></> : null}</p>
              {groups.length ? (
                <ul className="import-groups">
                  {groups.map((group) => <li key={group.name}><span>{group.name}</span><strong>{group.count} ảnh</strong></li>)}
                </ul>
              ) : null}
              {format === 'coco' && categories.length ? (
                <div className="category-map">
                  <h4>Ánh xạ danh mục COCO</h4>
                  {categories.map((category) => (
                    <label key={category.name}>
                      <span>{category.name || '(không tên)'} <small>{category.count} vùng</small></span>
                      <select value={categoryTargets[category.name] ?? 'skip'} disabled={running}
                        onChange={(event) => setCategoryTargets((current) => ({ ...current, [category.name]: event.target.value as CategoryTarget }))}>
                        {(['r', 'w', 'skip'] as const).map((value) => <option key={value} value={value}>{targetLabels[value]}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              ) : null}
              {warnings.length ? (
                <details className="import-warnings">
                  <summary>Xem {warnings.length} cảnh báo</summary>
                  <ul>{warnings.slice(0, 200).map((warning, index) => <li key={index}>{warning}</li>)}</ul>
                  {warnings.length > 200 ? <p>… và {warnings.length - 200} cảnh báo khác.</p> : null}
                </details>
              ) : null}
            </>
          )}

          {progress ? (
            <div className="import-progress">
              <div className="progress-track" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
              <p>
                {progress.running ? 'Đang nhập' : progress.stopped ? 'Đã dừng' : 'Hoàn tất'}: {progress.done}/{progress.total} ảnh
                · mới {progress.created} · cập nhật {progress.updated}
                {progress.failures.length ? <> · <span className="warning-text">lỗi {progress.failures.length}</span></> : null}
              </p>
              {progress.invalidAnnotations ? <p className="muted">{progress.invalidAnnotations} vùng COCO không đọc được hình học đã bị bỏ qua.</p> : null}
              {progress.failures.length ? (
                <details className="import-warnings" open={!progress.running}>
                  <summary>Ảnh lỗi ({progress.failures.length})</summary>
                  <ul>{progress.failures.slice(0, 200).map((failure) => <li key={failure.item.externalKey}><strong>{failure.item.externalKey}</strong>: {failure.message}</li>)}</ul>
                </details>
              ) : null}
            </div>
          ) : null}

          <div className="import-actions">
            {running ? (
              <button className="button ghost" type="button" onClick={() => { stopRef.current = true; }}>Dừng sau ảnh đang gửi</button>
            ) : (
              <>
                <button className="button primary" type="button" disabled={!plan.items.length || needsName || scanning}
                  onClick={() => void run(plan.items)}>
                  {plan.items.length ? `Nhập ${plan.items.length} ảnh vào ${groups.length} nhóm` : 'Nhập dữ liệu'}
                </button>
                {progress?.failures.length ? (
                  <button className="button secondary" type="button" onClick={() => void run(progress.failures.map((failure) => failure.item))}>
                    Thử lại {progress.failures.length} ảnh lỗi
                  </button>
                ) : null}
                {progress && !progress.running && progress.done > progress.failures.length ? (
                  <button className="button ghost" type="button" onClick={() => onOpenProject(progress.projectId)}>Xem nhóm đã nhập</button>
                ) : null}
              </>
            )}
          </div>
          {needsName && plan.items.length ? <p className="muted">Nhập tên cho dự án mới để bắt đầu.</p> : null}
          <p className="import-note">Nhập lại cùng tên ảnh sẽ cập nhật ảnh nguồn nhưng giữ nguyên nhãn đã lưu. Ảnh đang có người sửa sẽ được báo lỗi để nhập lại sau.</p>
        </div>
      </div>
    </section>
  );
}

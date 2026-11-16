// Kiểm tra tương tác canvas trên trình duyệt thật (Chrome headless qua DevTools Protocol), CHỈ trên trang
// dữ liệu giả /canvas-browser-check: không gọi API, không đọc/ghi database, Blob hay Drive.
// Không cần dependency: dùng Chrome đã cài và WebSocket/fetch có sẵn của Node 22.
//
// Chạy (trong annotation-tool/):
//   1. Dev server cô lập (biến giả để không thể chạm production; trang này không gọi API):
//      DATABASE_URL=postgres://isolated@127.0.0.1:1/x DATABASE_URL_UNPOOLED=postgres://isolated@127.0.0.1:1/x \
//      BLOB_READ_WRITE_TOKEN=isolated npx next dev -p 3217
//   2. node scripts/canvas-browser-check.mjs http://localhost:3217 [out.json]
//      (dùng localhost: Next 16 chặn tài nguyên dev từ origin 127.0.0.1)
// Tùy chọn: CHROME_PATH=..., SKIP_PERF=1 (chỉ kiểm chức năng), PROFILE=<tên bước> (CPU profile của bước đó).
// Thoát với mã 1 nếu có kiểm tra thất bại hoặc lỗi console. Số đo hiệu năng chỉ để so sánh tương đối
// (CPU giới hạn 4×, render phần mềm của headless), không phải ngưỡng pass/fail.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const base = process.argv[2] ?? 'http://localhost:3217';
const outFile = process.argv[3];
const port = 9333 + Math.floor(Math.random() * 500);
const profileDir = mkdtempSync(path.join(tmpdir(), 'canvas-check-'));
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
  '--window-size=1280,1000', '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function json(url, method = 'GET') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { const response = await fetch(url, { method }); if (response.ok) return await response.json(); } catch { /* Chrome still starting */ }
    await sleep(100);
  }
  throw new Error(`No response from ${url}`);
}

const target = await json(`http://127.0.0.1:${port}/json/new?about:blank`, 'PUT');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
  } else if (message.method === 'Runtime.consoleAPICalled' && (message.params.type === 'error' || message.params.type === 'warning')) {
    const text = message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
    if (!/Download the React DevTools|\[Fast Refresh\]|\[HMR\]/.test(text)) consoleErrors.push(`${message.params.type}: ${text.slice(0, 300)}`);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
};
async function waitFor(expression, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await evaluate(`!!(${expression})`)) return true; } catch { /* page not ready */ }
    await sleep(100);
  }
  return false;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
// Frame timestamps and long tasks (> 50 ms on the main thread) for the perf summary.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__perf = { longtasks: [], frames: [] };
  try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__perf.longtasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: true }); } catch {}
  (function loop(time) { window.__perf.frames.push(time); requestAnimationFrame(loop); })(performance.now());
` });

const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra });
async function click(x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  await mouse('mouseMoved', x, y, { modifiers });
  await mouse('mousePressed', x, y, { button, buttons: button === 'left' ? 1 : 2, clickCount, modifiers });
  await mouse('mouseReleased', x, y, { button, buttons: 0, clickCount, modifiers });
}
const SHIFT = 8; // CDP Input modifiers bit
async function drag(map, from, to, steps = 30) {
  const a = map(...from); const b = map(...to);
  await mouse('mouseMoved', a.x, a.y);
  await mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i += 1) { await mouse('mouseMoved', a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps, { button: 'left', buttons: 1 }); await sleep(16); }
  await mouse('mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1 });
}
async function key(keyName, code, vk, modifiers = 0, text) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
}
const ctrl = (letter) => key(letter, `Key${letter.toUpperCase()}`, letter.toUpperCase().charCodeAt(0), 2);
const enter = () => key('Enter', 'Enter', 13, 0, '\r');
const escape = () => key('Escape', 'Escape', 27);
const clickSelector = async (selector) => {
  const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await click(point.x, point.y);
};
const clickButtonText = async (text) => {
  const point = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(text)}); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await click(point.x, point.y);
};
const state = () => evaluate(`(() => {
  const status = [...document.querySelectorAll('p')].find((p) => p.textContent.startsWith('Mode='))?.textContent ?? '';
  const history = document.querySelector('[data-testid=history]')?.textContent ?? '';
  const message = [...document.querySelectorAll('p')][2]?.textContent ?? '';
  return { status, history, message };
})()`);
const field = (text, name) => (new RegExp(`${name}=([^;\\s]+)`).exec(text) ?? [])[1];
const masksOf = `(() => Number(/masks=([0-9]+)/.exec([...document.querySelectorAll('p')].find((p) => p.textContent.startsWith('Mode='))?.textContent ?? '')?.[1]))()`;
const pageReady = `document.querySelector('.canvas-viewport canvas') && document.querySelector('[data-testid=history]')`;
/**
 * Image pixel → screen point, valid right after fit (no manual zoom/pan). Recompute before each block:
 * a status/toast line appearing above the canvas moves it down.
 */
async function imageToScreen(width, height) {
  const geometry = await evaluate(`(() => { const r = document.querySelector('.canvas-viewport').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
  const scale = Math.max(0.05, Math.min((geometry.width - 36) / width, (geometry.height - 36) / height));
  const offsetX = geometry.left + (geometry.width - width * scale) / 2;
  const offsetY = geometry.top + (geometry.height - height * scale) / 2;
  return (x, y) => ({ x: offsetX + x * scale, y: offsetY + y * scale });
}

const profiles = {};
function summarizeProfile(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  profile.samples.forEach((id, index) => {
    const frame = byId.get(id).callFrame;
    const name = `${frame.functionName || '(anon)'} ${frame.url.split('/').pop()}:${frame.lineNumber + 1}`;
    self.set(name, (self.get(name) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000);
  });
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([name, ms]) => `${ms.toFixed(1).padStart(7)}ms ${name}`);
}
async function measure(name, action) {
  const profiling = process.env.PROFILE && name.includes(process.env.PROFILE);
  if (profiling) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 200 }); await send('Profiler.start'); }
  // A navigation resets performance.now(): page loads are measured from the new document's start.
  const start = name.includes('load') ? 0 : await evaluate('performance.now()');
  const wall = Date.now();
  await action();
  await sleep(250);
  if (profiling) { const { profile } = await send('Profiler.stop'); profiles[name] = summarizeProfile(profile); }
  const end = await evaluate('performance.now()');
  const perf = await evaluate(`(() => {
    const frames = window.__perf.frames.filter((t) => t >= ${start} && t <= ${end});
    const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
    const tasks = window.__perf.longtasks.filter((task) => task.start >= ${start} && task.start <= ${end});
    return {
      maxFrameGap: Math.round(gaps.at(-1) ?? 0),
      p95FrameGap: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0),
      longTasks: tasks.length,
      longTaskTotal: Math.round(tasks.reduce((sum, task) => sum + task.duration, 0)),
      longTaskMax: Math.round(Math.max(0, ...tasks.map((task) => task.duration))),
    };
  })()`);
  return { name, wallMs: Date.now() - wall, ...perf };
}

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); };
const metrics = [];

// Mỗi thông báo hiện phía trên canvas và đẩy canvas xuống: tính lại tọa độ trước mỗi lần nhấp (cảnh 800×500).
const clickImage = async (x, y, options) => { const p = (await imageToScreen(800, 500))(x, y); await click(p.x, p.y, options); await sleep(120); };
const shiftClickImage = async (x, y) => {
  const p = (await imageToScreen(800, 500))(x, y);
  await mouse('mouseMoved', p.x, p.y, { modifiers: SHIFT }); await sleep(150);
  await click(p.x, p.y, { modifiers: SHIFT }); await sleep(250);
};
/** Kéo chuột trái với Shift giữ suốt lần kéo (kéo điểm + Shift trong Select). */
async function shiftDrag(map, from, to, steps = 20) {
  const a = map(...from); const b = map(...to);
  await mouse('mouseMoved', a.x, a.y, { modifiers: SHIFT });
  await mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1, modifiers: SHIFT });
  for (let i = 1; i <= steps; i += 1) { await mouse('mouseMoved', a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps, { button: 'left', buttons: 1, modifiers: SHIFT }); await sleep(16); }
  await mouse('mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1, modifiers: SHIFT });
}
// Pixel đọc từ ảnh chụp trang giải mã trên canvas tạm, không getImageData lớp hiển thị.
const pixelsAt = async (points) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  return evaluate(`(async () => {
    const image = new Image(); image.src = 'data:image/png;base64,${data}'; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    return ${JSON.stringify(points)}.map(([x, y]) => Array.from(context.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)));
  })()`);
};
const sameColor = (a, b) => a.every((value, index) => Math.abs(value - b[index]) <= 2);
const polygonsNow = () => evaluate(`window.__polygons.map((p) => ({ id: p.id, label: p.label, nodes: p.nodes.length, holes: (p.holes ?? []).length }))`);
const insideMask = (id, x, y) => evaluate(`(() => {
  const p = window.__polygons.find((item) => item.id === ${JSON.stringify(id)});
  if (!p) return false;
  const inRing = (ring) => { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) { const a = ring[i]; const b = ring[j]; if ((a.y > ${y}) !== (b.y > ${y}) && ${x} < ((b.x - a.x) * (${y} - a.y)) / (b.y - a.y) + a.x) inside = !inside; } return inside; };
  return inRing(p.nodes) && !(p.holes ?? []).some(inRing);
})()`);

try {
  // ── Functional: default scene (800×500, saved rectangles r1/r2), harness starts in Select ──
  await send('Page.navigate', { url: `${base}/canvas-browser-check` });
  check('page loads', await waitFor(pageReady, 120000));
  await sleep(1500);
  await clickButtonText('Fit');
  await sleep(300);
  let to = await imageToScreen(800, 500);
  await clickSelector('button[data-tool=polygon]');
  await sleep(300);
  // Polygon draft: every click is one undoable point (user-confirmed contract, polygon-draft.ts).
  for (const [x, y] of [[300, 150], [450, 150], [480, 300], [400, 380], [320, 320]]) { const p = to(x, y); await click(p.x, p.y); await sleep(60); }
  await sleep(200);
  let s = await state();
  check('5 draft points → local undo active', field(s.history, 'local') === 'true' && field(s.history, 'canUndo') === 'true', s.history);
  await ctrl('z'); await sleep(80); await ctrl('z'); await sleep(200);
  s = await state();
  check('Ctrl+Z ×2 keeps local mode with redo', field(s.history, 'local') === 'true' && field(s.history, 'canRedo') === 'true', s.history);
  await ctrl('y'); await sleep(80); await ctrl('z'); await sleep(200);
  await enter(); await sleep(400);
  s = await state();
  check('Enter completes polygon with exactly 3 nodes (2 points undone)', field(s.status, 'masks') === '3' && /last=w1:3/.test(s.history), `${s.status} | ${s.history}`);
  check('after completion history is global', field(s.history, 'local') === 'false', s.history);
  await ctrl('z'); await sleep(300);
  s = await state();
  check('global Ctrl+Z removes the completed polygon', field(s.status, 'masks') === '2', s.status);
  await ctrl('y'); await sleep(300);
  s = await state();
  check('global Ctrl+Y restores it', field(s.status, 'masks') === '3' && /last=w1:3/.test(s.history), `${s.status} | ${s.history}`);

  // Toolbar undo/redo (imperative handle) on draft points
  to = await imageToScreen(800, 500);
  for (const [x, y] of [[620, 40], [760, 40], [760, 90]]) { const p = to(x, y); await click(p.x, p.y); await sleep(60); }
  await clickButtonText('Undo'); await sleep(200);
  s = await state();
  check('handle undo() removes one draft point (still local)', field(s.history, 'local') === 'true', s.history);
  await clickButtonText('Redo'); await sleep(100);
  { const p = to(640, 95); await click(p.x, p.y); }
  await sleep(100);
  await enter(); await sleep(400);
  s = await state();
  check('handle redo() restores the point → 4 nodes', /last=w2:4/.test(s.history), s.history);

  // Hoàn tất chỉ bằng nhấp đúp lên một điểm đã chấm (người dùng xác nhận 2026-11-06): nhấp đúp ở chỗ trống chỉ chấm
  // một điểm, nhấp đơn lên điểm đầu không hoàn tất, nhấp lên điểm đã có không chấm thêm.
  to = await imageToScreen(800, 500);
  for (const [x, y] of [[40, 430], [150, 430], [150, 480]]) { const p = to(x, y); await click(p.x, p.y); await sleep(60); }
  { const p = to(40, 480); await click(p.x, p.y, { clickCount: 1 }); await click(p.x, p.y, { clickCount: 2 }); }
  await sleep(400);
  s = await state();
  check('double-click on empty space only places one point (polygon not finished)', field(s.history, 'local') === 'true' && /last=w2:4/.test(s.history), s.history);
  { const p = to(40, 430); await click(p.x, p.y); }
  await sleep(300);
  s = await state();
  check('single click on the first point does not finish the polygon', field(s.history, 'local') === 'true' && /last=w2:4/.test(s.history), s.history);
  await sleep(700);
  { const p = to(150, 480); await click(p.x, p.y, { clickCount: 1 }); await click(p.x, p.y, { clickCount: 2 }); }
  await sleep(400);
  s = await state();
  check('double-click on an existing point finishes with 4 nodes (no duplicate)', /last=w3:4/.test(s.history) && field(s.history, 'local') === 'false', s.history);

  // Right-click removes a draft point; Ctrl+Z restores it
  to = await imageToScreen(800, 500);
  for (const [x, y] of [[640, 430], [780, 430], [780, 490], [660, 495]]) { const p = to(x, y); await click(p.x, p.y); await sleep(60); }
  { const p = to(780, 490); await click(p.x, p.y, { button: 'right' }); }
  await sleep(150);
  await ctrl('z'); await sleep(150);
  await enter(); await sleep(400);
  s = await state();
  check('right-click node removal is undoable → 4 nodes', /last=w4:4/.test(s.history), s.history);

  // Escape cancels the draft; Enter then adds nothing (< 3 nodes)
  to = await imageToScreen(800, 500);
  for (const [x, y] of [[300, 20], [350, 20]]) { const p = to(x, y); await click(p.x, p.y); await sleep(60); }
  await escape(); await sleep(150);
  s = await state();
  check('Escape clears the draft (history global)', field(s.history, 'local') === 'false', s.history);
  const masksBefore = field(s.status, 'masks');
  await enter(); await sleep(200);
  s = await state();
  check('Enter after Escape adds nothing', field(s.status, 'masks') === masksBefore, s.status);

  // Paint (người dùng xác nhận 2026-11-12): vẽ polygon như P rồi Enter để NỐI (+) vào mask nó chạm, hoặc TRỪ (−).
  // Không tô pixel, không vector hóa lại khi rời Paint: các mask khác giữ nguyên id và số node (trước đây bị "dính").
  await clickSelector('button[data-tool=brush]'); await sleep(300);
  await clickSelector('button[data-paint=add]'); await sleep(150);
  check('Paint mode buttons show the shared icons and the active mode', await evaluate(`document.querySelector('button[data-paint=add]').getAttribute('aria-pressed') === 'true'
    && document.querySelector('button[data-paint=subtract]').getAttribute('aria-pressed') === 'false'
    && !!document.querySelector('button[data-paint=add] [data-paint-icon=add]') && !!document.querySelector('button[data-paint=subtract] [data-paint-icon=subtract]')`));
  const neighboursBefore = (await polygonsNow()).filter((p) => p.id !== '0');
  // (250,200) và (250,300) neo vào cạnh phải của r1 (x = 250): polygon trùng cạnh với r1.
  for (const [x, y] of [[250, 200], [320, 200], [320, 300], [250, 300]]) await clickImage(x, y);
  await enter(); await sleep(400);
  s = await state();
  check('Paint (+) sharing an edge extends that mask (no new mask, stays in Paint)', field(s.status, 'masks') === '6' && await insideMask('0', 290, 250) && field(s.status, 'tool') === 'brush', `${s.status} | ${s.message}`);
  await clickSelector('button[data-tool=select]'); await sleep(500);
  const neighboursAfter = (await polygonsNow()).filter((p) => p.id !== '0');
  check('leaving Paint never re-vectorizes: every other mask keeps its id and node count', JSON.stringify(neighboursAfter) === JSON.stringify(neighboursBefore), JSON.stringify({ neighboursBefore, neighboursAfter }));
  await clickSelector('button[data-tool=brush]'); await sleep(300);
  await clickSelector('button[data-paint=subtract]'); await sleep(150);
  for (const [x, y] of [[270, 220], [300, 220], [300, 280]]) await clickImage(x, y);
  {
    // Bản nháp (−) đỏ (ERASE_COLOR #f04438) để biết polygon sẽ trừ.
    const p = (await imageToScreen(800, 500))(300, 220);
    const [pixel] = await pixelsAt([[p.x, p.y]]);
    check('Paint (−) draft is drawn red', pixel[0] > 200 && pixel[1] < 130 && pixel[2] < 130, JSON.stringify(pixel));
  }
  await clickSelector('button[data-paint=add]'); await sleep(150);
  await clickSelector('button[data-paint=subtract]'); await sleep(150);
  s = await state();
  check('switching + / − keeps the draft', field(s.history, 'local') === 'true', s.history);
  await clickImage(270, 280);
  await enter(); await sleep(400);
  s = await state();
  check('Paint (−) inside a mask cuts a hole and keeps its id', field(s.status, 'masks') === '6' && field(s.status, 'holes') === '1'
    && !(await insideMask('0', 285, 250)) && await insideMask('0', 260, 250), `${s.status} | ${s.message}`);
  // Các điểm neo vào hai cạnh của r2 (x 550..600): polygon cắt ngang trọn bề rộng r2.
  for (const [x, y] of [[540, 240], [610, 240], [610, 260], [540, 260]]) await clickImage(x, y);
  await enter(); await sleep(400);
  s = await state();
  const r2Pieces = (await polygonsNow()).filter((p) => p.label === 'r2').length;
  check('Paint (−) across a mask splits it into two masks with the same label', field(s.status, 'masks') === '7' && r2Pieces === 2, `${s.status} | pieces=${r2Pieces} | ${s.message}`);
  await ctrl('z'); await sleep(300);
  check('one undo restores the split mask', (await evaluate(masksOf)) === 6);
  // Đường cắt 2 ĐIỂM trong chế độ trừ (người dùng xác nhận 2026-11-16): hai điểm neo lên hai biên của r1 (y=130,
  // tránh lỗ đã trừ ở trên); NHẤP ĐÚP LÊN CHÍNH ĐIỂM VỪA CHẤM hoàn tất (rule 2026-11-16: nhấp đúp lên bất kỳ
  // điểm nào, không chỉ điểm chấm từ trước) và tách r1 làm hai mảnh cùng label tại đúng đường đó.
  for (const [x, y] of [[190, 130], [260, 130]]) await clickImage(x, y);
  { const p = (await imageToScreen(800, 500))(260, 130); await click(p.x, p.y, { clickCount: 1 }); await click(p.x, p.y, { clickCount: 2 }); }
  await sleep(400);
  s = await state();
  const r1Pieces = (await polygonsNow()).filter((p) => p.label === 'r1').length;
  check('Paint (−) with a 2-point line splits the mask at the cut', field(s.status, 'masks') === '7' && r1Pieces === 2, `${s.status} | pieces=${r1Pieces} | ${s.message}`);
  await ctrl('z'); await sleep(300);
  check('one undo restores the line-split mask', (await evaluate(masksOf)) === 6);
  // Rule 3 (spec 2026-11-16): đường cắt từ biên vào GIỮA mask r2 chưa chia được mask → không mask/ID mới, đường
  // được giữ chờ; đường thứ hai nối từ đầu đường chờ ra biên bên kia mới tách r2 làm hai.
  const doubleClickImage = async (x, y) => { const p = (await imageToScreen(800, 500))(x, y); await click(p.x, p.y, { clickCount: 1 }); await click(p.x, p.y, { clickCount: 2 }); await sleep(400); };
  for (const [x, y] of [[545, 150], [575, 150]]) await clickImage(x, y);
  await doubleClickImage(575, 150);
  s = await state();
  check('a cut that ends inside the mask stays pending: no new mask, no new ID',
    field(s.status, 'masks') === '6' && (await polygonsNow()).filter((p) => p.label === 'r2').length === 1 && /đường chờ/.test(s.message), `${s.status} | ${s.message}`);
  for (const [x, y] of [[575, 150], [605, 150]]) await clickImage(x, y);
  await doubleClickImage(605, 150);
  s = await state();
  const r2Split = (await polygonsNow()).filter((p) => p.label === 'r2');
  check('a second cut joining the pending one separates the mask: two masks, distinct IDs, original ID kept by one',
    field(s.status, 'masks') === '7' && r2Split.length === 2 && r2Split[0].id !== r2Split[1].id && r2Split.some((p) => p.id === '1'), `${s.status} | ${JSON.stringify(r2Split)} | ${s.message}`);
  await ctrl('z'); await sleep(300);
  check('undo restores the mask split by combined cuts', (await evaluate(masksOf)) === 6);
  await clickSelector('button[data-tool=select]'); await sleep(300);
  await clickButtonText('Check PNG'); await sleep(500);
  s = await state();
  check('exported PNG: empty center, filled r1', /center alpha=0; mask alpha=255/.test(s.message), s.message);

  // Wheel zoom
  to = await imageToScreen(800, 500);
  const center = to(400, 250);
  for (let i = 0; i < 6; i += 1) { await mouse('mouseWheel', center.x, center.y, { deltaX: 0, deltaY: -120 }); await sleep(20); }
  await sleep(300);
  s = await state();
  check('wheel zoom increases scale', Number(field(s.status, 'zoom')) > 1.2, s.status);
  await clickButtonText('Fit'); await sleep(300);

  // The merged tools share the same undo history as the local brush editor.
  await send('Page.navigate', { url: `${base}/canvas-browser-check` });
  await waitFor(pageReady, 120000); await sleep(700);
  await clickButtonText('Fit'); await sleep(200);
  to = await imageToScreen(800, 500);
  await clickSelector('button[data-tool=rectangle]'); await sleep(150);
  await drag(to, [300, 100], [400, 180], 10); await sleep(300);
  s = await state();
  check('rectangle creates one four-node instance', field(s.status, 'masks') === '3' && /last=w1:4/.test(s.history), `${s.status} | ${s.history}`);
  await ctrl('z'); await sleep(200);
  check('rectangle undo restores the previous mask', (await evaluate(masksOf)) === 2);
  await ctrl('y'); await sleep(200);
  await clickSelector('button[data-tool=circle]'); await sleep(150);
  to = await imageToScreen(800, 500);
  await drag(to, [340, 280], [430, 360], 10); await sleep(300);
  s = await state();
  check('circle creates a 32-node instance after rectangle redo', field(s.status, 'masks') === '4' && /last=w2:32/.test(s.history), `${s.status} | ${s.history}`);
  await clickSelector('button[data-tool=anchor]'); await sleep(150);
  to = await imageToScreen(800, 500);
  await drag(to, [350, 100], [350, 85], 10); await sleep(300);
  s = await state();
  check('anchor adds one boundary node while preserving all masks', field(s.status, 'masks') === '4' && field(s.history, 'totalNodes') === '45', `${s.status} | ${s.history}`);
  await ctrl('z'); await sleep(200);
  s = await state();
  check('anchor undo restores the original boundary', field(s.history, 'totalNodes') === '44', s.history);
  await clickSelector('button[data-tool=select]'); await sleep(150);
  await ctrl('a'); await sleep(200);
  check('Ctrl+A selects every polygon', field((await state()).history, 'selected') === '4');
  await key('Delete', 'Delete', 46); await sleep(200);
  check('Delete removes selected polygons', (await evaluate(masksOf)) === 0);
  await ctrl('z'); await sleep(200);
  check('undo restores all selected polygons', (await evaluate(masksOf)) === 4);

  // Auto anchor (người dùng xác nhận 2026-11-06): nhấp thường chỉ chấm điểm; giữ Shift + trỏ vào trong mask kế bên để
  // xem trước, Shift + chuột trái chèn các điểm bám biên tự do TỪ ĐIỂM VỪA CHẤM tới điểm biên gần con trỏ; không hoàn tất;
  // nhấp đúp lên một điểm mới hoàn tất. Cảnh ?seams=1: 6 mask r1..r6 bao vùng trống x 160..540, y 160..400.
  await send('Page.navigate', { url: `${base}/canvas-browser-check?seams=1` });
  await waitFor(pageReady, 120000); await sleep(700);
  await clickButtonText('Fit'); await sleep(200);
  await clickSelector('button[data-tool=polygon]'); await sleep(200);
  // A trên biên trên của Bm, một điểm tự do, P trên biên dưới của tC: nhấp lên mask khác chỉ chấm điểm (chèn đỉnh vào mask).
  for (const [x, y] of [[450, 400], [510, 300], [470, 160]]) await clickImage(x, y);
  s = await state();
  check('clicking another mask while drawing only adds a point (polygon not finished)', field(s.status, 'masks') === '6' && field(s.history, 'local') === 'true' && field(s.history, 'totalNodes') === '26', `${s.status} | ${s.history}`);
  // Shift + chuột trái trong tA: chèn (400,160), (300,160) và đích (230,160) trên biên dưới tA; vẫn đang vẽ.
  await shiftClickImage(230, 150);
  s = await state();
  check('Shift + left click inside a neighbour mask inserts boundary points without finishing', field(s.status, 'masks') === '6' && field(s.history, 'local') === 'true' && field(s.history, 'totalNodes') === '27', `${s.status} | ${s.history} | ${s.message}`);
  // Tiếp từ (230,160) sang L: chèn (160,160) và đích (160,380) trên biên phải của L.
  await shiftClickImage(150, 380);
  s = await state();
  check('a second Shift + left click continues from the point just placed', field(s.status, 'masks') === '6' && field(s.history, 'local') === 'true' && field(s.history, 'totalNodes') === '28', `${s.status} | ${s.history} | ${s.message}`);
  await sleep(700);
  // Nhấp đúp lên điểm đầu A mới hoàn tất: 3 điểm vẽ + 5 điểm auto, 6 mask cũ còn nguyên (+4 đỉnh chèn vào biên).
  { const p = (await imageToScreen(800, 500))(450, 400); await click(p.x, p.y, { clickCount: 1 }); await click(p.x, p.y, { clickCount: 2 }); }
  await sleep(400);
  s = await state();
  check('double-click on a point finishes along the free boundary without merging masks', field(s.status, 'masks') === '7' && /last=w1:8/.test(s.history) && field(s.history, 'totalNodes') === '36' && field(s.history, 'local') === 'false', `${s.status} | ${s.history} | ${s.message}`);
  await ctrl('z'); await sleep(250);
  check('undo removes the auto-anchored polygon', (await evaluate(masksOf)) === 6);
  // Điểm vừa chấm không nằm trên biên (bắt đầu ngoài các mask): Shift + chuột trái trong R không chèn gì, vẫn vẽ tiếp.
  for (const [x, y] of [[700, 300], [680, 200]]) await clickImage(x, y);
  await shiftClickImage(570, 250);
  s = await state();
  check('Shift + left click without a free boundary path inserts nothing and keeps drawing', (await evaluate(masksOf)) === 6 && field(s.history, 'local') === 'true' && field(s.history, 'totalNodes') === '28', `${s.status} | ${s.history}`);
  await escape(); await sleep(150);

  // NHẤN PHÍM Shift khi đang vẽ (người dùng xác nhận 2026-11-16): chèn ngay các điểm bám biên vào BẢN NHÁP,
  // không hoàn tất mask; thả Shift giữ nguyên; nhấn lại không tạo điểm trùng; chỉ nhấp đúp lên một điểm mới hoàn
  // tất, nhấp đúp vùng trống thì không.
  const shiftKey = (type) => send('Input.dispatchKeyEvent', { type, key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
  for (const [x, y] of [[450, 400], [510, 300], [470, 160]]) await clickImage(x, y);
  { const p = (await imageToScreen(800, 500))(230, 150); await mouse('mouseMoved', p.x, p.y); await sleep(250); }
  await shiftKey('keyDown'); await sleep(400); await shiftKey('keyUp'); await sleep(250);
  s = await state();
  check('pressing the Shift key inserts boundary points into the draft without finalizing the mask',
    (await evaluate(masksOf)) === 6 && field(s.history, 'local') === 'true' && /Đã chèn 3 điểm/.test(s.message), `${s.status} | ${s.history} | ${s.message}`);
  await shiftKey('keyDown'); await sleep(300); await shiftKey('keyUp'); await sleep(200);
  check('pressing Shift again at the same spot inserts no duplicate points', (await evaluate(masksOf)) === 6 && field((await state()).history, 'local') === 'true', (await state()).message);
  { const p = (await imageToScreen(800, 500))(350, 300); await click(p.x, p.y, { clickCount: 1 }); await click(p.x, p.y, { clickCount: 2 }); }
  await sleep(300);
  check('double-click on empty space never finalizes the mask', (await evaluate(masksOf)) === 6 && field((await state()).history, 'local') === 'true', `${(await state()).status} | ${(await state()).history}`);
  await ctrl('z'); await sleep(200);
  // Nhấp đúp lên một điểm TỰ ĐỘNG (đỉnh (300,160) của dải trên nằm trên đường vừa chèn) hoàn tất mask.
  { const p = (await imageToScreen(800, 500))(300, 160); await click(p.x, p.y, { clickCount: 1 }); await click(p.x, p.y, { clickCount: 2 }); }
  await sleep(400);
  s = await state();
  check('double-click on an auto-inserted point finalizes: 3 drawn + 3 boundary points, old masks intact',
    field(s.status, 'masks') === '7' && /last=w\d+:6/.test(s.history) && field(s.history, 'local') === 'false', `${s.status} | ${s.history}`);
  await ctrl('z'); await sleep(250);
  check('undo after the Shift-completed polygon restores 6 masks', (await evaluate(masksOf)) === 6);
  // Dọn bản nháp dù các kiểm trên có trượt, để khối sau không thừa điểm.
  await escape(); await sleep(150);

  // Kéo điểm + Shift trong Select (người dùng xác nhận 2026-11-12): điểm NEO vào biên mask đang trỏ, cạnh tới điểm kề đã
  // nằm trên biên đó TỰ HOÀN THIỆN bằng đỉnh thật. Polygon mới: (200,160) neo trên biên dưới tA, (250,250), (200,300).
  for (const [x, y] of [[200, 160], [250, 250], [200, 300]]) await clickImage(x, y);
  await enter(); await sleep(400);
  await clickSelector('button[data-tool=select]'); await sleep(250);
  const lastNodes = () => evaluate(`window.__polygons.at(-1).nodes.map((n) => [Math.round(n.x * 10) / 10, Math.round(n.y * 10) / 10])`);
  const hasNode = (nodes, x, y) => nodes.some(([nx, ny]) => Math.abs(nx - x) < 0.6 && Math.abs(ny - y) < 0.6);
  { const map = await imageToScreen(800, 500); await shiftDrag(map, [250, 250], [350, 150], 20); await sleep(400); }
  const anchoredNodes = await lastNodes();
  const tBNodes = await evaluate(`window.__polygons.find((p) => p.id === 's2').nodes.map((n) => [n.x, n.y])`);
  // Biên dưới tA đã có đỉnh neo (230,160) từ Shift + nhấp ở trên: đường đi (200,160) → (230,160) → (300,160) → (350,160).
  check('Shift + drag: the node anchors on the mask under the cursor and the edge follows its free boundary',
    anchoredNodes.length === 5 && hasNode(anchoredNodes, 350, 160) && hasNode(anchoredNodes, 300, 160) && hasNode(anchoredNodes, 230, 160) && hasNode(anchoredNodes, 200, 160)
      && !hasNode(anchoredNodes, 250, 250) && hasNode(tBNodes, 350, 160) && (await evaluate(masksOf)) === 7,
    JSON.stringify({ anchoredNodes, tBNodes, message: (await state()).message }));
  await ctrl('z'); await sleep(250);
  const restoredNodes = await lastNodes();
  check('one undo restores the node and the target mask', restoredNodes.length === 3 && hasNode(restoredNodes, 250, 250), JSON.stringify(restoredNodes));
  { const map = await imageToScreen(800, 500); await drag(map, [250, 250], [330, 150], 12); await sleep(300); }
  const freeNodes = await lastNodes();
  check('without Shift the drag stays a normal drag (no boundary points inserted)', freeNodes.length === 3 && !hasNode(freeNodes, 300, 160), JSON.stringify(freeNodes));
  await ctrl('z'); await sleep(250);

  // Màu theo label và độ mờ áp dụng cả lên viền (người dùng xác nhận 2026-11-05). Cảnh ?labels=1: hai mask tách
  // rời cùng là r1 và một mask w1.
  await send('Page.navigate', { url: `${base}/canvas-browser-check?labels=1` });
  await waitFor(pageReady, 120000); await sleep(700);
  await clickButtonText('Fit'); await sleep(300);
  const maskCenters = async () => { const map = await imageToScreen(800, 500); return [map(175, 200), map(575, 200), map(375, 385)].map((p) => [p.x, p.y]); };
  // Màu theo label là chế độ duy nhất (người dùng xác nhận 2026-11-06).
  const [labelA, labelB, labelW] = await pixelsAt(await maskCenters());
  check('label colours by default: two separate r1 masks share a colour, w1 differs', sameColor(labelA, labelB) && !sameColor(labelA, labelW), JSON.stringify([labelA, labelB, labelW]));
  // Gợi ý neo (người dùng yêu cầu 2026-11-12): ở P/Paint, và khi đang kéo node trong Select, đỉnh của mask khác hiện chấm
  // tâm trắng; Select đứng yên thì không. So pixel đúng tại góc (500,100) của mask r1 bên phải.
  const cornerWhiteness = async () => { const p = (await imageToScreen(800, 500))(500, 100); const [pixel] = await pixelsAt([[p.x, p.y]]); return Math.min(...pixel); };
  await clickSelector('button[data-tool=select]'); await sleep(300);
  const idleCorner = await cornerWhiteness();
  await clickSelector('button[data-tool=polygon]'); await sleep(300);
  const drawCorner = await cornerWhiteness();
  await clickSelector('button[data-tool=brush]'); await sleep(300);
  const paintCorner = await cornerWhiteness();
  await clickSelector('button[data-tool=select]'); await sleep(300);
  let draggingCorner = 0;
  {
    const map = await imageToScreen(800, 500);
    const fill = map(175, 200); await click(fill.x, fill.y); await sleep(200);
    const a = map(250, 300); const b = map(240, 290);
    await mouse('mouseMoved', a.x, a.y);
    await mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 4; i += 1) { await mouse('mouseMoved', a.x + (b.x - a.x) * i / 4, a.y + (b.y - a.y) * i / 4, { button: 'left', buttons: 1 }); await sleep(30); }
    await sleep(300);
    draggingCorner = await cornerWhiteness();
    await mouse('mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
    await ctrl('z'); await sleep(250);
  }
  const afterDragCorner = await cornerWhiteness();
  check('anchor hints: other masks show their vertices in P, Paint and while dragging a node, not in idle Select',
    drawCorner - idleCorner >= 40 && paintCorner - idleCorner >= 40 && draggingCorner - idleCorner >= 40 && Math.abs(afterDragCorner - idleCorner) <= 12,
    JSON.stringify({ idleCorner, drawCorner, paintCorner, draggingCorner, afterDragCorner }));
  // Ẩn lớp tô để chỉ còn viền; so pixel đậm nhất quanh cạnh trái của mask r1 ở độ mờ 100% và 20%.
  await clickButtonText('Mask layer'); await sleep(200);
  const edgeDarkness = async () => {
    const edge = (await imageToScreen(800, 500))(100, 200);
    const pixels = await pixelsAt([-2, -1, 0, 1, 2].map((dx) => [edge.x + dx, edge.y]));
    return Math.max(...pixels.map(([r, g, b]) => 765 - r - g - b));
  };
  await clickButtonText('Opacity 100'); await sleep(300);
  const strongEdge = await edgeDarkness();
  await clickButtonText('Opacity 20'); await sleep(300);
  const faintEdge = await edgeDarkness();
  check('outline follows the opacity slider (20% much lighter than 100%)', strongEdge > 150 && faintEdge < strongEdge * 0.45, `100%: ${strongEdge}, 20%: ${faintEdge}`);

  // Magnet trong Select (người dùng xác nhận 2026-11-05): kéo góc (250,300) của r1 tới gần góc (300,320) của w1.
  // Khoảng cách tính theo px MÀN HÌNH (bán kính magnet là 6 px màn hình / zoom), nên quy đổi qua scale thật.
  await clickButtonText('Mask layer'); await sleep(150);
  await clickSelector('button[data-tool=select]'); await sleep(200);
  const imageScale = async () => { const map = await imageToScreen(800, 500); return (map(100, 0).x - map(0, 0).x) / 100; };
  const scale = await imageScale();
  /** Điểm cách đỉnh (300,320) đúng `screenPx` px màn hình theo đường chéo. */
  const nearCorner = (screenPx) => { const d = screenPx / (scale * Math.SQRT2); return [300 - d, 320 - d]; };
  const cornerOf = () => evaluate(`(() => { const n = window.__polygons.find((p) => p.id === 'l0').nodes[2]; return [n.x, n.y]; })()`);
  const dragCorner = async (screenPx) => {
    const map = await imageToScreen(800, 500);
    const fill = map(175, 200); await click(fill.x, fill.y); await sleep(200);
    await drag(map, [250, 300], nearCorner(screenPx), 12); await sleep(300);
  };
  const atCorner = (point) => Math.hypot(point[0] - 300, point[1] - 320) < 0.01;
  await dragCorner(3);
  const snapped = await cornerOf();
  check('magnet: dragged node sticks to a vertex 3 screen px away', atCorner(snapped), JSON.stringify(snapped));
  await ctrl('z'); await sleep(250);
  // Bán kính giảm còn 6 px màn hình (người dùng báo 10 px "hơi mạnh", 2026-11-16): 9 px không được hút nữa.
  await dragCorner(9);
  const weak = await cornerOf();
  check('magnet: a vertex 9 screen px away is out of reach (radius 6)', !atCorner(weak) && Math.hypot(weak[0] - nearCorner(9)[0], weak[1] - nearCorner(9)[1]) < 2.5, JSON.stringify(weak));
  await ctrl('z'); await sleep(250);
  await clickButtonText('Magnet'); await sleep(150);
  await dragCorner(3);
  const free = await cornerOf();
  check('magnet off: the node stays where it is dropped', !atCorner(free) && Math.hypot(free[0] - nearCorner(3)[0], free[1] - nearCorner(3)[1]) < 2.5, JSON.stringify(free));
  await ctrl('z'); await sleep(250);

  // Nút magnet tắt MỌI việc hít tự động (người dùng xác nhận 2026-11-16): chấm điểm bằng P cạnh biên mask l0 khi
  // magnet tắt thì không neo, nên l0 không bị chèn đỉnh. Bật lại thì có. Giữ Shift vẫn neo (kiểm tra riêng ở trên).
  const nodesOfL0 = async () => (await polygonsNow()).find((item) => item.id === 'l0').nodes;
  const clickNearEdge = async () => { await clickImage(250 - 4 / scale, 200); await sleep(250); };
  await clickSelector('button[data-tool=polygon]'); await sleep(250);
  const beforeOff = await nodesOfL0();
  await clickNearEdge();
  check('magnet off: clicking next to an edge in P does not anchor into that mask', (await nodesOfL0()) === beforeOff, `${beforeOff} → ${await nodesOfL0()}`);
  await escape(); await sleep(200);
  await clickButtonText('Magnet'); await sleep(200);
  const beforeOn = await nodesOfL0();
  await clickNearEdge();
  check('magnet on: clicking next to an edge in P anchors a vertex into that mask', (await nodesOfL0()) === beforeOn + 1, `${beforeOn} → ${await nodesOfL0()}`);
  await escape(); await sleep(200);
  await ctrl('z'); await sleep(250);
  await clickSelector('button[data-tool=select]'); await sleep(200);

  // Thanh cuộn tự vẽ + Ctrl/Shift + con lăn (người dùng yêu cầu 2026-11-05).
  const scrollbars = () => evaluate(`(() => ['horizontal', 'vertical'].map((name) => { const bar = document.querySelector('.canvas-scrollbar.' + name); return { hidden: bar.hidden, transform: bar.firstElementChild.style.transform }; }))()`);
  await clickButtonText('Fit'); await sleep(300);
  check('scrollbars hidden after Fit', (await scrollbars()).every((bar) => bar.hidden), JSON.stringify(await scrollbars()));
  { const c = (await imageToScreen(800, 500))(400, 250); for (let i = 0; i < 8; i += 1) { await mouse('mouseWheel', c.x, c.y, { deltaX: 0, deltaY: -120 }); await sleep(20); } }
  await sleep(300);
  const zoomed = await scrollbars();
  check('scrollbars appear when zoomed beyond the viewport', zoomed.every((bar) => !bar.hidden), JSON.stringify(zoomed));
  const zoomBefore = field((await state()).status, 'zoom');
  { const c = (await imageToScreen(800, 500))(400, 250); await mouse('mouseWheel', c.x, c.y, { deltaX: 0, deltaY: 240, modifiers: 10 }); }
  await sleep(250);
  const afterCtrlShift = await scrollbars();
  check('Ctrl + Shift + wheel scrolls vertically without zooming', afterCtrlShift[1].transform !== zoomed[1].transform && afterCtrlShift[0].transform === zoomed[0].transform && field((await state()).status, 'zoom') === zoomBefore, JSON.stringify(afterCtrlShift));
  {
    const thumb = await evaluate(`(() => { const r = document.querySelector('.canvas-scrollbar.horizontal .canvas-scrollbar-thumb').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await mouse('mouseMoved', thumb.x, thumb.y);
    await mouse('mousePressed', thumb.x, thumb.y, { button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i += 1) { await mouse('mouseMoved', thumb.x - i * 10, thumb.y, { button: 'left', buttons: 1 }); await sleep(20); }
    await mouse('mouseReleased', thumb.x - 60, thumb.y, { button: 'left', buttons: 0, clickCount: 1 });
  }
  await sleep(250);
  const afterDrag = await scrollbars();
  check('dragging the horizontal scrollbar thumb pans the view', afterDrag[0].transform !== afterCtrlShift[0].transform && field((await state()).status, 'zoom') === zoomBefore, JSON.stringify(afterDrag));
  await clickButtonText('Fit'); await sleep(300);

  // ── Hiển thị ảnh + minimap (người dùng xác nhận 2026-11-16), cảnh ?photo=1: trái #666, phải #999, ranh x=400 ──
  await send('Page.navigate', { url: `${base}/canvas-browser-check?photo=1` });
  await waitFor(pageReady, 120000); await sleep(700);
  await clickButtonText('Fit'); await sleep(400);
  const luminanceAt = async (x, y) => { const p = (await imageToScreen(800, 500))(x, y); const [pixel] = await pixelsAt([[p.x, p.y]]); return (pixel[0] + pixel[1] + pixel[2]) / 3; };
  const baseFar = await luminanceAt(300, 250);
  const baseDark = await luminanceAt(398, 250);
  const baseLight = await luminanceAt(403, 250);
  await clickSelector('button[data-adjust=bright]'); await sleep(300);
  const dimmed = await luminanceAt(300, 250);
  check('brightness 60% dims the photo layer', dimmed < baseFar * 0.75, `far ${baseFar} → ${dimmed}`);
  await clickSelector('button[data-adjust=reset]'); await sleep(400);
  check('adjust reset restores the original pixels', Math.abs((await luminanceAt(300, 250)) - baseFar) <= 4, `far ${baseFar} → ${await luminanceAt(300, 250)}`);
  // Unsharp: overshoot hai phía ranh trong tầm bán kính mờ 2 px (tối thêm ở phía tối, sáng thêm ở phía sáng);
  // vùng phẳng xa ranh giữ nguyên — bằng chứng chỉ BIÊN được làm rõ.
  await clickSelector('button[data-adjust=edge]'); await sleep(900);
  const edgedDark = await luminanceAt(398, 250);
  const edgedLight = await luminanceAt(403, 250);
  const edgedFar = await luminanceAt(300, 250);
  check('edge enhance (unsharp) overshoots both sides of the boundary, flat areas untouched',
    edgedDark < baseDark - 3 && edgedLight > baseLight + 3 && Math.abs(edgedFar - baseFar) <= 2,
    `dark ${baseDark} → ${edgedDark}; light ${baseLight} → ${edgedLight}; far ${baseFar} → ${edgedFar}`);
  check('edge enhance never touches the polygons', JSON.stringify(await polygonsNow()) === JSON.stringify([{ id: 'p0', label: 'r1', nodes: 4, holes: 0 }]));
  await clickSelector('button[data-adjust=reset]'); await sleep(900);
  check('reset after edge enhance restores the boundary pixels', Math.abs((await luminanceAt(398, 250)) - baseDark) <= 4, `dark ${baseDark} → ${await luminanceAt(398, 250)}`);
  // Minimap: khung đỏ phản ánh vùng nhìn; bấm trên minimap pan canvas chính, zoom giữ nguyên.
  const viewportBox = () => evaluate(`(() => { const v = document.querySelector('[data-minimap-viewport]'); return v ? { left: Math.round(parseFloat(v.style.left)), width: Math.round(parseFloat(v.style.width)) } : null; })()`);
  const fitBox = await viewportBox();
  check('minimap shows the viewport frame', Boolean(fitBox && fitBox.width > 10), JSON.stringify(fitBox));
  { const c = (await imageToScreen(800, 500))(400, 250); for (let i = 0; i < 6; i += 1) { await mouse('mouseWheel', c.x, c.y, { deltaX: 0, deltaY: -120 }); await sleep(20); } }
  await sleep(300);
  const zoomedBox = await viewportBox();
  check('zooming the canvas shrinks the minimap frame', Boolean(zoomedBox && fitBox && zoomedBox.width < fitBox.width * 0.8), JSON.stringify({ fitBox, zoomedBox }));
  const zoomKept = field((await state()).status, 'zoom');
  { const m = await evaluate(`(() => { const f = document.querySelector('[data-minimap] .minimap-frame'); const r = f.getBoundingClientRect(); return { x: r.left + r.width * 0.15, y: r.top + r.height * 0.5 }; })()`);
    await mouse('mouseMoved', m.x, m.y);
    await mouse('mousePressed', m.x, m.y, { button: 'left', buttons: 1, clickCount: 1 });
    await mouse('mouseReleased', m.x, m.y, { button: 'left', buttons: 0, clickCount: 1 }); }
  await sleep(300);
  const pannedBox = await viewportBox();
  check('clicking the minimap pans the main canvas without changing zoom',
    Boolean(pannedBox && zoomedBox && pannedBox.left !== zoomedBox.left) && field((await state()).status, 'zoom') === zoomKept,
    JSON.stringify({ zoomedBox, pannedBox, zoomKept, zoomNow: field((await state()).status, 'zoom') }));

  // ── Large polygon-mode file (600 saved polygons, 2400×1600) under 4× CPU throttle ──
  await send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const wheel = async (map, x, y, count, delta) => { const c = map(x, y); for (let i = 0; i < count; i += 1) { await mouse('mouseWheel', c.x, c.y, { deltaX: 0, deltaY: delta }); await sleep(16); } };
  metrics.push(await measure('many: load (600 polygons)', async () => {
    await send('Page.navigate', { url: `${base}/canvas-browser-check?many=1` });
    await waitFor(pageReady, 120000);
    await sleep(2000);
  }));
  let many = await imageToScreen(2400, 1600);
  metrics.push(await measure('many: wheel zoom in/out ×24', async () => { await wheel(many, 1200, 800, 12, -100); await wheel(many, 1200, 800, 12, 100); }));
  await clickButtonText('Fit'); await sleep(400);
  many = await imageToScreen(2400, 1600);
  metrics.push(await measure('many: select polygon + drag node', async () => {
    const fill = many(60, 60); await click(fill.x, fill.y); await sleep(200);
    await drag(many, [86, 60], [110, 70], 30);
  }));
  check('many: node drag keeps 600 polygons', (await evaluate(masksOf)) === 600, String(await evaluate(masksOf)));
  // Paint (+) bằng polygon (2026-11-12): không tô pixel, không vector hóa khi rời Paint, nên không mask nào bị gộp
  // (bản brush cũ đo ở đây gộp 600 → 510 thành phần).
  metrics.push(await measure('many: polygon → paint (tool switch)', async () => { await clickSelector('button[data-tool=brush]'); await sleep(600); }));
  many = await imageToScreen(2400, 1600);
  metrics.push(await measure('many: paint (+) polygon across 3 masks', async () => {
    for (const [x, y] of [[300, 290], [470, 290], [470, 330], [300, 330]]) { const p = many(x, y); await click(p.x, p.y); await sleep(60); }
    await enter(); await sleep(400);
  }));
  metrics.push(await measure('many: paint → select', async () => { await clickSelector('button[data-tool=select]'); await sleep(400); }));
  check('many: Paint (+) and leaving Paint never merge masks (≥ 600 masks)', (await evaluate(masksOf)) >= 600, String(await evaluate(masksOf)));
  // Lõi tự hoàn thiện đo ngay trong Chrome (CPU giới hạn 4×) trên 600 mask: dựng mô hình biên một lần, rồi mỗi lần rê/kéo.
  metrics.push({ name: 'many: auto-complete core (ms, 600 masks, 4× CPU)', ...(await evaluate('window.__benchAutoComplete([86, 60], [110, 60], 50)')) });
  if (!process.env.SKIP_PERF) {
    metrics.push(await measure('many: polygon draft hover + 6 clicks', async () => {
      await clickSelector('button[data-tool=polygon]'); await sleep(300);
      many = await imageToScreen(2400, 1600);
      for (const [x, y] of [[400, 200], [900, 220], [1100, 600], [800, 900], [450, 800], [350, 500]]) {
        const p = many(x, y);
        for (let i = 0; i < 6; i += 1) { await mouse('mouseMoved', p.x - 12 + i * 2, p.y); await sleep(16); }
        await click(p.x, p.y); await sleep(30);
      }
      await escape();
    }));
  }

  // Dirty-rectangle outline redraw during a node drag vs a full redraw (same view, same geometry).
  // Compared on composited screenshots: getImageData on the layer would demote it to CPU raster.
  {
    await clickSelector('button[data-tool=select]'); await sleep(300);
    await clickButtonText('Fit'); await sleep(400);
    many = await imageToScreen(2400, 1600);
    // Inset 3 px: pressing Escape turns on the stage canvas's :focus-visible outline at the edge.
    const viewport = await evaluate(`(() => { const r = document.querySelector('.canvas-viewport').getBoundingClientRect(); return { x: r.left + 3, y: r.top + 3, width: r.width - 6, height: r.height - 6, scale: 1 }; })()`);
    const screenshot = async () => (await send('Page.captureScreenshot', { format: 'png', clip: viewport })).data;
    // Row 2 is above the painted polygon: an unchanged 24-gon with a node near (1260, 212).
    const select = many(1230, 212); await click(select.x, select.y); await sleep(400);
    const before = await screenshot();
    const a = many(1260, 212); const b = many(1300, 250);
    await mouse('mouseMoved', a.x, a.y);
    await mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 12; i += 1) { await mouse('mouseMoved', a.x + (b.x - a.x) * i / 12, a.y + (b.y - a.y) * i / 12, { button: 'left', buttons: 1 }); await sleep(30); }
    await sleep(400);
    const partial = await screenshot();
    check('node drag repaints the outline layer through dirty rectangles', partial !== before);
    await escape(); // cancelCurrentPath() → render(): full redraw mid-drag, nothing else changes
    await sleep(500);
    const full = await screenshot();
    check('dirty-rectangle redraw equals a full redraw (composited pixels)', partial === full);
    await mouse('mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
  }

  if (!process.env.SKIP_PERF) {
    // Raster-only file (no saved polygons, 1600×1000)
    metrics.push(await measure('spiky: load', async () => {
      await send('Page.navigate', { url: `${base}/canvas-browser-check?spiky=1` });
      await waitFor(pageReady, 120000);
      await sleep(1500);
    }));
    const spiky = await imageToScreen(1600, 1000);
    metrics.push(await measure('spiky: raster → polygon (Select)', async () => {
      await clickSelector('button[data-tool=select]');
      await waitFor(`${masksOf} > 0`, 30000);
    }));
    metrics.push(await measure('spiky: polygon → paint', async () => { await clickSelector('button[data-tool=brush]'); await sleep(500); }));
    metrics.push(await measure('spiky: paint (−) polygon', async () => {
      await clickSelector('button[data-paint=subtract]'); await sleep(100);
      for (const [x, y] of [[700, 450], [900, 450], [900, 550], [700, 550]]) { const p = spiky(x, y); await click(p.x, p.y); await sleep(60); }
      await enter(); await sleep(500);
    }));
    metrics.push(await measure('spiky: paint → polygon', async () => { await clickSelector('button[data-tool=polygon]'); await sleep(500); }));
    metrics.push(await measure('spiky: wheel zoom in/out ×24', async () => { await wheel(spiky, 800, 500, 12, -100); await wheel(spiky, 800, 500, 12, 100); }));
  }
  await send('Emulation.setCPUThrottlingRate', { rate: 1 });
} catch (error) {
  check('script error', false, String(error?.stack ?? error));
} finally {
  const result = { checks, metrics, consoleErrors, profiles };
  if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 2));
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.ok ? '' : ` — ${item.detail}`}`);
  for (const item of metrics) {
    if ('coldMs' in item) {
      console.log(`${item.name.padEnd(38)} cold ${item.coldMs} ms  warm ${item.warmMsPerMove} ms/move  drag ${item.dragMsPerMove} ms/move`);
      continue;
    }
    console.log(`${item.name.padEnd(38)} longTasks ${String(item.longTasks).padStart(2)} total ${String(item.longTaskTotal).padStart(5)} ms  max ${String(item.longTaskMax).padStart(4)} ms  p95 frame ${item.p95FrameGap} ms`);
  }
  for (const [name, lines] of Object.entries(profiles)) console.log(`\n# CPU profile: ${name}\n${lines.join('\n')}`);
  if (consoleErrors.length) console.log('console:', consoleErrors);
  ws.close();
  chrome.kill();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* Chrome may still hold files */ }
  process.exitCode = checks.every((item) => item.ok) && !consoleErrors.length ? 0 : 1;
}

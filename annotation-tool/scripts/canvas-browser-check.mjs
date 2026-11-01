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
async function click(x, y, { button = 'left', clickCount = 1 } = {}) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, { button, buttons: button === 'left' ? 1 : 2, clickCount });
  await mouse('mouseReleased', x, y, { button, buttons: 0, clickCount });
}
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

try {
  // ── Functional: default scene (800×500, saved rectangles r1/r2), harness starts in the brush tool ──
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
  check('Enter completes polygon with exactly 3 nodes (2 points undone)', field(s.status, 'masks') === '3' && /last=r3:3/.test(s.history), `${s.status} | ${s.history}`);
  check('after completion history is global', field(s.history, 'local') === 'false', s.history);
  await ctrl('z'); await sleep(300);
  s = await state();
  check('global Ctrl+Z removes the completed polygon', field(s.status, 'masks') === '2', s.status);
  await ctrl('y'); await sleep(300);
  s = await state();
  check('global Ctrl+Y restores it', field(s.status, 'masks') === '3' && /last=r3:3/.test(s.history), `${s.status} | ${s.history}`);

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
  check('handle redo() restores the point → 4 nodes', /last=r4:4/.test(s.history), s.history);

  // Double-click completion drops the vertex duplicated by the second pointerdown
  to = await imageToScreen(800, 500);
  for (const [x, y] of [[40, 430], [150, 430], [150, 480]]) { const p = to(x, y); await click(p.x, p.y); await sleep(60); }
  { const p = to(40, 480); await click(p.x, p.y, { clickCount: 1 }); await click(p.x, p.y, { clickCount: 2 }); }
  await sleep(400);
  s = await state();
  check('double-click completes with 4 nodes (no duplicate)', /last=r5:4/.test(s.history), s.history);

  // Right-click removes a draft point; Ctrl+Z restores it
  to = await imageToScreen(800, 500);
  for (const [x, y] of [[640, 430], [780, 430], [780, 490], [660, 495]]) { const p = to(x, y); await click(p.x, p.y); await sleep(60); }
  { const p = to(780, 490); await click(p.x, p.y, { button: 'right' }); }
  await sleep(150);
  await ctrl('z'); await sleep(150);
  await enter(); await sleep(400);
  s = await state();
  check('right-click node removal is undoable → 4 nodes', /last=r6:4/.test(s.history), s.history);

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

  // Brush through the center, vectorize on Select, undo, exported binary mask
  await clickSelector('button[data-tool=brush]'); await sleep(300);
  await clickButtonText('Add 12 px'); await sleep(100);
  to = await imageToScreen(800, 500);
  await drag(to, [260, 250], [540, 250], 25);
  await sleep(300);
  await clickSelector('button[data-tool=select]');
  const vectorized = await waitFor(`(() => { const t = [...document.querySelectorAll('p')].find((p) => p.textContent.startsWith('Mode='))?.textContent ?? ''; return t.includes('center filled=true'); })()`, 15000);
  s = await state();
  check('brush stroke through center vectorizes on Select (center filled, r3 merged → 6)', vectorized && field(s.status, 'masks') === '6', `${s.status} | ${s.message}`);
  await clickButtonText('Undo'); await sleep(500);
  s = await state();
  check('undo after brush restores 6 polygons', field(s.status, 'masks') === '6', s.status);
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
  metrics.push(await measure('many: polygon → brush (tool switch)', async () => { await clickSelector('button[data-tool=brush]'); await sleep(600); }));
  many = await imageToScreen(2400, 1600);
  metrics.push(await measure('many: brush strokes ×3', async () => {
    for (let k = 0; k < 3; k += 1) { await drag(many, [300, 300 + k * 300], [2000, 380 + k * 300], 30); await sleep(150); }
  }));
  metrics.push(await measure('many: brush → select (vectorize)', async () => {
    await clickSelector('button[data-tool=select]');
    await waitFor(`${masksOf} !== 600`, 30000);
    await sleep(300);
  }));
  // Same strokes on the same file gave 510 components before and after the 2026-10-25 render changes.
  check('many: strokes merge polygons after vectorize', (await evaluate(masksOf)) < 600, String(await evaluate(masksOf)));
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
    // Row 2 is above every brush stroke: a re-traced polygon with a node near (1260, 212).
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
    metrics.push(await measure('spiky: polygon → brush', async () => { await clickSelector('button[data-tool=brush]'); await sleep(500); }));
    metrics.push(await measure('spiky: brush strokes ×3', async () => {
      for (let k = 0; k < 3; k += 1) { await drag(spiky, [500, 300 + k * 150], [1100, 350 + k * 150], 30); await sleep(120); }
    }));
    metrics.push(await measure('spiky: brush → polygon', async () => { await clickSelector('button[data-tool=polygon]'); await sleep(2500); }));
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
    console.log(`${item.name.padEnd(38)} longTasks ${String(item.longTasks).padStart(2)} total ${String(item.longTaskTotal).padStart(5)} ms  max ${String(item.longTaskMax).padStart(4)} ms  p95 frame ${item.p95FrameGap} ms`);
  }
  for (const [name, lines] of Object.entries(profiles)) console.log(`\n# CPU profile: ${name}\n${lines.join('\n')}`);
  if (consoleErrors.length) console.log('console:', consoleErrors);
  ws.close();
  chrome.kill();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* Chrome may still hold files */ }
  process.exitCode = checks.every((item) => item.ok) && !consoleErrors.length ? 0 : 1;
}

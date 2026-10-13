/**
 * 渲染层入口：`initApp()` 与调试/自检钩子 `window.__gkpv`。
 *
 * 关于 `window.__gkpv`：它不是测试专用的后门，而是一个稳定的自检通道。
 *  1. 只吃传入的数据与自己的数据源，不额外扩权（读写仍然只能通过 src: 句柄）；
 *  2. 桌面版的「打开文件夹」是原生窗口，Playwright 点不到 —— 自动截图、
 *     自动验证真实解码结果必须靠它；
 *  3. 生产构建里同样存在：用户遇到坏图时，这个通道就是现场取证工具。
 *
 * 真正带门禁的只有 `gkpv.test.*`：GKPV_TEST_MODE=1 时 preload 才挂出来。
 */

import { state, resetState } from './lib/state.js';
import { setFileProvider, getFileFor, fileFromBytes, guessMime, ensureHeadBytes, previewFileOf } from './lib/source.js';
import { initCache, loadAspectRatios, saveAspectRatios, cacheStats, storageEstimate, clearCache } from './lib/cache.js';
import { readImageSize } from './lib/image-format.js';
import { isRawName, isNoDecodeName } from './lib/format.js';
import {
  parseExif, formatShutter, formatAperture, formatFocalLength, formatOrientation,
  formatCamera, formatShootingSettings,
} from './lib/exif.js';
import { computeLayout, sortEntries, constrainPan, zoomAround, counterLabel } from './lib/layout.js';
import { generateThumb, generateFolderThumb, loadSvgImage, rawPreviewOf } from './lib/thumbs.js';
import { drawBitmapOriented } from './lib/orientation.js';
import { dataUrlToBlob } from './lib/raw.js';
import * as Fmt from './lib/fmt.js';
import * as Format from './lib/format.js';
import { makeEntries, entryFromBlob } from './lib/entries.js';
import {
  initGallery, renderGallery, bindGalleryHost, getOrBuildThumb, updateCounterLabel, recalculateLayout,
} from './lib/gallery.js';
import {
  initLightbox, openLightbox, closeLightbox, lbPrev, lbNext, isLightboxOpen,
  showLightboxImage, toggleExifPanel, isExifPanelOpen, updateExifPanel, lightboxReleaseAll,
} from './lib/lightbox.js';

/** 菜单/快捷键命令 -> 动作。initApp 时填好，供命令总线与测试共用。 */
const commands = {};

/**
 * 全局错误钩子。
 *
 * 没有这两个监听时，渲染层里没被 await 的 Promise 报错只会出现在控制台，
 * 自动化测试看到的现象就是「什么都没发生」——排查成本极高。这里把它们统一
 * 收进 `state.stats.errors`，诊断信息导出时可查。
 */
function installGlobalErrorHooks() {
  window.addEventListener('error', (ev) => {
    recordRenderError('error', ev.message || String(ev.error || '未知错误'));
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    recordRenderError('unhandledrejection', (reason && reason.message) || String(reason));
  });
}

function recordRenderError(where, message) {
  const text = `${where}: ${message}`;
  // 直接挂 window 上的诊断缓冲区：即使 __gkpv 还没装好也不会丢
  const diag = window.__gkpvDiag || (window.__gkpvDiag = { errors: [] });
  diag.errors.push(text);
  state.stats.errors.push({ where, message });
  console.error('[gkpv]', text);
}

export async function initApp() {
  installGlobalErrorHooks();
  applySavedPrefs();

  const dom = {
    landing: document.getElementById('landing'),
    toolbar: document.getElementById('toolbar'),
    gallery: document.getElementById('gallery'),
    loading: document.getElementById('loading'),
    counter: document.getElementById('counter'),
    breadcrumbs: document.getElementById('breadcrumbs'),
    sort: document.getElementById('sortSelect'),
    recursive: document.getElementById('recursiveBtn'),
    clearCache: document.getElementById('clearCacheBtn'),
    openBtn: document.getElementById('openBtn'),
    openBtnToolbar: document.getElementById('openBtnToolbar'),
    tooltip: document.getElementById('cardTooltip'),
    lightbox: document.getElementById('lightbox'),
    lbImg: document.getElementById('lbImg'),
    lbImgPrev: document.getElementById('lbImgPrev'),
    lbZoom: document.getElementById('lbZoom'),
    lbMsg: document.getElementById('lbMsg'),
    lbInfo: document.getElementById('lbInfo'),
    exifPanel: document.getElementById('exifPanel'),
    infoBtn: document.querySelector('.info-btn'),
    closeBtn: document.querySelector('.close-btn'),
    prevBtn: document.querySelector('.nav-prev'),
    nextBtn: document.querySelector('.nav-next'),
    layoutBtns: [...document.querySelectorAll('.layout-group button')],
    sizeBtns: [...document.querySelectorAll('.size-group button')],
  };
  state.$tooltip = dom.tooltip;

  initGallery(dom);
  initLightbox(dom);

  // 目录 ⇄ 灯箱的互相调用用注入打破循环依赖；测尺寸也走注入，
  // 免得 gallery 直接依赖 source/raw 的取字节细节。
  bindGalleryHost({
    navigate: navigateTo,
    openLightbox,
    measure: measureEntry,
    releaseLightbox: lightboxReleaseAll,
  });

  // 文件字节：优先主进程扫描阶段抠出的内嵌预览，其次按需读盘
  setFileProvider({ readFile: (id, rel) => window.gkpv.readFile(id, rel) });

  const cacheInfo = await initCache();
  console.info('[gkpv] 缩略图缓存后端：', cacheInfo.backend, cacheInfo.error || '');

  bindFolderButtons(dom);
  buildCommands(dom);
  bindToolbar(dom);
  window.gkpv.onCommand((id) => runCommand(id));
  installDiagnostics();

  window.__gkpv.ready = true;

  // 测试模式：主进程已钉住目录，直接进画廊
  try {
    const root = window.gkpv.test ? await window.gkpv.test.getFolder() : null;
    if (root) await openFolderPath(root);
  } catch (e) {
    showError(e);
  }
}

/* ================================================================== *
 * 1. 打开文件夹 / 导航
 * ================================================================== */

function bindFolderButtons(dom) {
  const onOpen = () => { pickFolder().catch(showError); };
  dom.openBtn.addEventListener('click', onOpen);
  dom.openBtnToolbar.addEventListener('click', onOpen);
}

/** 走原生对话框选一个目录；`folderPath` 只在测试/命令行场景传入。 */
export async function pickFolder(folderPath) {
  let source = null;

  if (folderPath) {
    const res = await window.gkpv.mountFolder(folderPath, false);
    if (!res || !res.source) throw new Error((res && res.error) || '挂载目录失败');
    source = res.source;
  } else {
    const res = await window.gkpv.openFolder({ recursive: false });
    if (!res || res.canceled) return null;   // 用户取消：保持原界面，不算错误
    if (res.error) throw new Error(res.error);
    source = res.source;
  }

  await enterRoot(source);
  return source;
}

/** 打开（或重新扫描）一个已授权的目录。 */
export async function openFolderPath(folderPath) {
  return pickFolder(folderPath);
}

async function enterRoot(source) {
  state.sourceId = source.id;
  state.sourceRoot = source.root;
  state.sourceName = source.name;
  state.currentPath = [];

  document.getElementById('landing').style.display = 'none';
  document.getElementById('toolbar').style.display = 'flex';
  document.getElementById('gallery').style.display = 'block';

  await renderDirectory();
}

/** 切到某个子目录（`pathSegments` 是相对根目录的层级数组）。 */
export async function navigateTo(pathSegments) {
  state.currentPath = [...pathSegments];
  await renderDirectory();
}

/* ================================================================== *
 * 2. 渲染主流程
 * ================================================================== */

export async function renderDirectory() {
  // 注意：代际计数器由 renderGallery 递增（它也负责失效所有进行中的缩略图任务）。
  // 这里只**快照**当前代际：扫描回来时对不上就说明用户已经切到别处，本次结果作废。
  // 早先这里也 ++ 了一次，导致 renderGallery 之后 `gen` 永远对不上，
  // 「正在扫描目录…」的遮罩就不再被撤掉（表现为界面一直转圈）。
  const gen = state.thumbGeneration;
  trace(`renderDirectory@${gen} enter`, {
    src: state.sourceId, path: state.currentPath.join('/'), recursive: state.recursiveMode,
  });
  const phase = markPhase('renderDirectory:start');
  document.getElementById('loading').classList.add('show');
  try {
    // 递归开关由主进程持有（影响整棵树的扫描范围），扫描前先同步过去
    await window.gkpv.setRecursive(state.sourceId, state.recursiveMode);
    // 传当前所在路径：主进程扫的必须是**这个**目录（等价于网页版的 getDirHandle(currentPath)）。
    // 不传的话主进程永远扫根目录，点进子目录后面包屑会变、网格却还是根目录的内容。
    const res = await window.gkpv.scan(state.sourceId, true, state.currentPath);
    if (!res || res.error) throw new Error((res && res.error) || '读取目录出错');
    if (gen !== state.thumbGeneration) return;   // 用户已经切到别的目录
    phase('scanned');

    const entries = res.entries || [];
    // 主进程给的条目已经限定在「当前目录」（递归时含其下所有层级）
    const folders = entries.filter((e) => e.kind === 'folder');
    const files = entries.filter((e) => e.kind === 'file');
    state.currentDirPath = state.currentPath.join('/');
    state.stats.scans += 1;
    trace(`renderDirectory@${gen} scanned`, { files: files.length, folders: folders.length });

    await renderGallery({
      folders,
      images: makeEntries(files, state.sourceId),
      // 计数器里「N 个文件夹」：递归时是**遍历到的目录总数**（网页版 dirCount，gkpv.html:1369/1870），
      // 非递归时 renderGallery 会改用磁贴数（sortedFolders.length），与此处传值无关。
      dirCount: res.stats && res.stats.dirCount != null ? res.stats.dirCount : folders.length,
      truncated: false,
    });
    phase('gallery-rendered');
    trace(`renderDirectory@${gen} gallery ok`, { imgs: state.currentImages.length });
    renderBreadcrumbs();
    phase('breadcrumbs');
  } catch (e) {
    trace(`renderDirectory@${gen} ERROR`, { message: (e && e.message) || String(e), stack: (e && e.stack) || '' });
    // 过期任务不弹错：新的那次渲染会给出它自己的结论
    if (gen === state.thumbGeneration) showError(e);
  } finally {
    trace(`renderDirectory@${gen} finally`, { gen, current: state.thumbGeneration });
    document.getElementById('loading').classList.remove('show');
  }
  phase('done');
}

/**
 * 预测量一条图片的显示尺寸（等价于原版 `premeasureAspects` 里那两种测法）。
 *
 * 顺序刻意这样排：
 *  1. 主进程扫描时已经能给出宽高的（PNG/GIF/BMP/WebP/JPEG 都走这条）直接用，零读盘；
 *  2. RAW：内嵌预览能带出相机全分辨率，取不到再退回读文件头；
 *  3. 其它格式：读一份文件头给 readImageSize 解析；
 *  4. 最后兜底才是整份字节（主进程抠不出预览时，只能把原文件搬过来解）。
 *
 * 返回值形状是 `{w,h}`；量不出来返回 null，交给缩略图阶段兜底，不是错误。
 */
async function measureEntry(entry) {
  if (entry.width > 0 && entry.height > 0) {
    return { w: entry.width, h: entry.height };
  }

  if (isRawName(entry.name)) {
    try {
      const pv = await rawPreviewOf(entry);
      if (pv && pv.w > 0 && pv.h > 0) return { w: pv.w, h: pv.h };
    } catch { /* RAW 预览取不到就走下面的通用路径 */ }
  }

  const parseFromFile = async (file) => {
    if (!file) return null;
    const s = await readImageSize(file);
    return s && s.w > 0 && s.h > 0 ? { w: s.w, h: s.h } : null;
  };

  try {
    const head = await ensureHeadBytes(entry);
    if (head && head.length) {
      const s = await readImageSize(fileFromBytes(head, entry.name, entry.lastModified));
      if (s && s.w > 0 && s.h > 0) return { w: s.w, h: s.h };
    }
    const hit = await parseFromFile(await getFileFor(entry));
    if (hit) return hit;
  } catch { /* 落到下面的兜底 */ }

  for (const usePreview of [false, true]) {
    const file = await fallbackFileFor(entry, usePreview);
    const hit = await parseFromFile(file);
    if (hit) return hit;
  }
  return null;
}
/**
 * 兜底取字节：优先扫描阶段抠出来的内嵌预览，其次整份读盘。
 * 两条路都可能失败（预览其实不是图片、文件被删），所以不抛错，让上层继续降级。
 */
async function fallbackFileFor(entry, usePreview) {
  try {
    const file = usePreview ? previewFileOf(entry) : await getFileFor(entry);
    return file || null;
  } catch {
    return null;
  }
}

/**
 * 记录关键事件到 `window.__gkpv.trace`（尾部保留最近 60 条）。
 *
 * 自动化里「界面白着不动」最难查：没有异常、没有日志。事件留痕后，测试可以直接
 * 说清楚「谁把渲染任务作废了」，而不是只看到最终状态。
 */
function trace(event, data) {
  const api = window.__gkpv;
  if (!api) return;
  if (!api.trace) api.trace = [];
  api.trace.push({ t: Date.now(), event, ...(data || {}) });
  if (api.trace.length > 60) api.trace.splice(0, api.trace.length - 60);
}

/**
 * 记录当前渲染阶段到 `window.__gkpv.phase`。
 *
 * 自动化里「界面白着不动」最难查：没有异常、没有日志。把阶段名挂在全局对象上，
 * 测试轮询它就能直接指出卡在哪一步（scan / aspect / layout / 虚滚动）。
 */
function markPhase(name) {
  const api = window.__gkpv;
  if (api) api.phase = { name, at: Date.now() };
  return (next) => { if (api) api.phase = { name: `${name} -> ${next}`, at: Date.now() }; };
}

function renderBreadcrumbs() {
  const $crumbs = document.getElementById('breadcrumbs');
  $crumbs.innerHTML = '';

  const makeBtn = (text, path) => {
    const b = document.createElement('button');
    b.className = 'crumb';
    b.textContent = text;
    b.addEventListener('click', () => { navigateTo(path).catch(showError); });
    return b;
  };

  $crumbs.appendChild(makeBtn(state.sourceName || '根目录', []));
  state.currentPath.forEach((seg, i) => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = ' / ';
    $crumbs.appendChild(sep);
    $crumbs.appendChild(makeBtn(seg, state.currentPath.slice(0, i + 1)));
  });
}

function showError(e) {
  const msg = (e && e.message) || String(e);
  const $gallery = document.getElementById('gallery');
  $gallery.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'error-hint';
  p.textContent = `读取目录出错：${msg}`;
  $gallery.appendChild(p);
  document.getElementById('loading').classList.remove('show');
  $gallery.style.display = 'block';
  state.stats.errors.push({ where: 'render', message: msg });
}

/* ================================================================== *
 * 3. 偏好设置（localStorage）与工具栏
 * ================================================================== */

const SIZE_VAR = { sm: 'var(--thumb-sm)', md: 'var(--thumb-md)', lg: 'var(--thumb-lg)' };
const SORT_MODES = ['name-asc', 'name-desc', 'date-new', 'date-old'];

function readPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 忽略：隐私模式下可能不可用 */ }
}

function applySavedPrefs() {
  state.recursiveMode = readPref('gkpv-recursive') === '1';
  state.layoutMode = readPref('gkpv-layout') === 'grid' ? 'grid' : 'justified';
  const size = readPref('gkpv-size');
  state.currentSizeKey = ['sm', 'md', 'lg'].includes(size) ? size : 'md';
  const sort = readPref('gkpv-sort');
  state.sortMode = SORT_MODES.includes(sort) ? sort : 'name-asc';
}

function bindToolbar(dom) {
  dom.sort.value = state.sortMode;
  dom.sort.addEventListener('change', () => {
    state.sortMode = dom.sort.value;
    savePref('gkpv-sort', state.sortMode);
    renderDirectory().catch(showError);
  });

  for (const btn of dom.layoutBtns) {
    btn.addEventListener('click', () => commands.setLayout(btn.dataset.layout));
  }
  for (const btn of dom.sizeBtns) {
    btn.addEventListener('click', () => commands.setSize(btn.dataset.size));
  }
  dom.recursive.addEventListener('click', () => commands.toggleRecursive());
  dom.clearCache.addEventListener('click', () => commands.clearCache());

  syncToolbarState(dom);
}

function syncToolbarState(dom) {
  dom.recursive.textContent = `子文件夹：${state.recursiveMode ? '开' : '关'}`;
  dom.recursive.classList.toggle('active', state.recursiveMode);
  for (const b of dom.layoutBtns) b.classList.toggle('active', b.dataset.layout === state.layoutMode);
  for (const b of dom.sizeBtns) b.classList.toggle('active', b.dataset.size === state.currentSizeKey);
  document.documentElement.style.setProperty('--thumb-size', SIZE_VAR[state.currentSizeKey] || SIZE_VAR.md);
}

function buildCommands(dom) {
  const relayoutIfPossible = () => {
    if (state.$scrollContainer) recalculateLayout();
  };

  commands.openFolder = () => pickFolder().catch(showError);
  commands.rescan = () => renderDirectory().catch(showError);
  commands.clearCache = async () => {
    const info = await clearCache();
    dom.clearCache.textContent = `已清空 (${info.removed})`;
    setTimeout(() => { dom.clearCache.textContent = '清空缓存'; }, 1500);
    if (state.sourceId) await renderDirectory();
  };
  commands.exportDiagnostics = async () => {
    const data = await collectDiagnostics();
    const res = await window.gkpv.exportDiagnostics(JSON.stringify(data, null, 2));
    return res;
  };

  commands.setLayout = (mode) => {
    state.layoutMode = mode === 'grid' ? 'grid' : 'justified';
    savePref('gkpv-layout', state.layoutMode);
    syncToolbarState(dom);
    relayoutIfPossible();
  };
  commands.setSize = (key) => {
    state.currentSizeKey = ['sm', 'md', 'lg'].includes(key) ? key : 'md';
    savePref('gkpv-size', state.currentSizeKey);
    syncToolbarState(dom);
    relayoutIfPossible();
  };
  commands.toggleRecursive = () => {
    state.recursiveMode = !state.recursiveMode;
    savePref('gkpv-recursive', state.recursiveMode ? '1' : '0');
    syncToolbarState(dom);
    renderDirectory().catch(showError);
  };
  commands.cycleSort = () => {
    const i = SORT_MODES.indexOf(state.sortMode);
    state.sortMode = SORT_MODES[(i + 1) % SORT_MODES.length];
    dom.sort.value = state.sortMode;
    savePref('gkpv-sort', state.sortMode);
    renderDirectory().catch(showError);
  };

  commands.closeLightbox = () => closeLightbox();
  commands.nextImage = () => lbNext();
  commands.prevImage = () => lbPrev();
  commands.toggleExif = () => { if (isLightboxOpen()) toggleExifPanel(); };
  commands.setExif = (open) => {
    if (!isLightboxOpen()) return;
    if (isExifPanelOpen() !== !!open) toggleExifPanel();
  };
  // 菜单里没有灯箱条目，但快捷键走浏览器的 keydown 默认路径即可
  commands.zoomIn = () => dispatchKey('+');
  commands.zoomOut = () => dispatchKey('-');
  commands.zoomReset = () => dispatchKey('0');

  commands.about = async () => {
    const info = await window.gkpv.info();
    return info;
  };
}

function dispatchKey(key) {
  if (!isLightboxOpen()) return;
  document.dispatchEvent(new KeyboardEvent('keydown', { key }));
}

/**
 * 主进程菜单下发的命令 ID → 本文件 `commands` 里的键。
 *
 * 为什么需要这张表：菜单用的是 kebab-case（`open-folder`），而这里的键是 camelCase
 * （`openFolder`）。没有这层映射时 `runCommand` 直接查表失败、**静默返回 false**，
 * 表现就是「菜单点不动、也没有任何报错」——排查成本很高，所以映射写死在这里，
 * 不靠临时转换去猜（`layout-grid` 这类还带参数，本来就无法机械转换）。
 */
const COMMAND_ALIAS = new Map([
  ['open-folder', () => commands.openFolder()],
  ['rescan', () => commands.rescan()],
  ['clear-cache', () => commands.clearCache()],
  ['export-diagnostics', () => commands.exportDiagnostics()],
  ['layout-grid', () => commands.setLayout('grid')],
  ['layout-justified', () => commands.setLayout('justified')],
  ['size-sm', () => commands.setSize('sm')],
  ['size-md', () => commands.setSize('md')],
  ['size-lg', () => commands.setSize('lg')],
  ['toggle-recursive', () => commands.toggleRecursive()],
  ['cycle-sort', () => commands.cycleSort()],
]);

/**
 * 执行主进程下发的命令。
 * @returns {boolean} 是否真的执行了（未知 ID 返回 false，调用方可用于断言）
 */
export function runCommand(id) {
  const alias = COMMAND_ALIAS.get(id);
  if (alias) {
    Promise.resolve(alias()).catch(showError);
    return true;
  }

  const fn = commands[id];
  if (typeof fn === 'function') {
    Promise.resolve(fn()).catch(showError);
    return true;
  }

  // 兜底：kebab-case → camelCase 机械转换（`next-image` → `nextImage`）
  const camel = String(id).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (camel !== id && typeof commands[camel] === 'function') {
    Promise.resolve(commands[camel]()).catch(showError);
    return true;
  }

  trace('runCommand:unknown', { id });
  return false;
}

/* ================================================================== *
 * 4. 诊断
 * ================================================================== */

async function collectDiagnostics() {
  const cache = await cacheStats();
  const storage = await storageEstimate();
  let app = {};
  try { app = await window.gkpv.info(); } catch { /* 忽略 */ }
  return {
    generatedAt: new Date().toISOString(),
    app: {
      version: app.version || '',
      electron: app.electron || (window.gkpv.versions && window.gkpv.versions.electron),
      chrome: app.chrome || (window.gkpv.versions && window.gkpv.versions.chrome),
      node: app.node || (window.gkpv.versions && window.gkpv.versions.node),
      userAgent: navigator.userAgent,
      userData: app.userData || '',
    },
    source: state.sourceRoot,
    dir: state.currentDirPath,
    counts: {
      images: state.currentImages.length,
      folders: state.currentFolderCount,
      recursive: state.recursiveMode,
      truncated: state.scanTruncated,
    },
    cache: { ...cache, storage },
    stats: state.stats,
  };
}

/* ================================================================== *
 * 5. window.__gkpv：自检与自动化钩子
 * ================================================================== */

function installDiagnostics() {
  const api = {
    ready: false,
    version: '',
    exts: () => [...Format.IMAGE_EXTS],
    noDecodeExts: () => [...Format.NO_DECODE_EXTS],
    rawExts: () => [...Format.RAW_EXTS],
    fmt: Fmt,
    layout: { computeLayout, sortEntries, counterLabel, constrainPan, zoomAround },
    state: () => state,
    entries: () => state.currentImages.map((e) => ({
      name: e.name, rel: e.rel, width: e.width, height: e.height, aspect: e.aspect,
      unsupported: !!e.unsupported, hasThumb: !!e.thumbUrl, failed: !!e._thumbFailed,
    })),
    entry: (idx) => state.currentImages[idx] || null,

    command: (id) => runCommand(id),

    /** 只测尺寸（读文件头，不解码整图）。 */
    measure: async (rel) => readRemote(rel, (f) => readImageSize(f)),
    /** 完整缩略图生成（走与界面同一条代码路径）。 */
    thumb: async (rel) => readRemote(rel, async (f, entry) => {
      const out = await generateThumb(entry);
      return { width: out.width, height: out.height, path: out.path, bytes: out.blob.size };
    }),
    /** RAW 内嵌预览探测（含容器方向）。 */
    rawPreview: async (rel) => readRemote(rel, async (f, entry) => {
      const pv = await rawPreviewOf(entry);
      if (!pv) return null;
      return { w: pv.w, h: pv.h, orient: pv.orient, bytes: pv.blob.size, type: pv.blob.type, fromScan: !!pv.fromScan };
    }, { skipPreview: true }),
    /** EXIF 解析。 */
    exif: async (rel) => readRemote(rel, async (f, entry) => parseExif(entry)),
    exifText: (exif) => ({
      camera: formatCamera(exif),
      settings: formatShootingSettings(exif),
      shutter: formatShutter(exif && exif.ExposureTime),
      aperture: formatAperture(exif && exif.FNumber),
      focal: formatFocalLength(exif && exif.FocalLength),
      orientation: formatOrientation(exif && exif.Orientation),
    }),

    fixtures: { fromBlob: (name, blob, extra) => entryFromBlob(name, blob, extra || {}) },

    /** 直接渲染一批条目（不读盘），用于纯渲染/布局测试。 */
    renderEntries: async ({ folders = [], images = [] }) => {
      state.currentPath = state.currentPath || [];
      state.dirCount = folders.length;
      await renderGallery({ folders, images, dirCount: folders.length, truncated: false });
      renderBreadcrumbs();
      return true;
    },
    lightbox: {
      open: openLightbox,
      close: closeLightbox,
      next: lbNext,
      prev: lbPrev,
      isOpen: isLightboxOpen,
      refresh: showLightboxImage,
      toggleExif: toggleExifPanel,
      isExifOpen: isExifPanelOpen,
      updateExif: updateExifPanel,
      release: lightboxReleaseAll,
    },
    cache: { stats: cacheStats, clear: clearCache, storage: storageEstimate, thumbs: getOrBuildThumb },
    relayout: () => ({ rows: state.layoutRows.length, totalHeight: state.totalHeight, rendered: { ...state.renderedRange } }),
    counters: () => ({
      done: state.thumbDoneCount,
      failed: state.thumbFailedCount,
      total: state.currentImages.length,
      text: document.getElementById('counter').textContent,
    }),
    diagnostics: collectDiagnostics,
    reset: () => resetState(),
  };
  window.__gkpv = api;
  window.gkpv.info().then((info) => { api.version = (info && info.version) || ''; }).catch(() => {});
}

/**
 * 从主进程读一个相对路径，做成条目再跑 `fn`。
 * `skipPreview` 用于「就是要测 RAW 解析」的场景：否则扫描下发的内嵌预览会短路掉解析过程。
 */
async function readRemote(rel, fn, { skipPreview = false } = {}) {
  if (!state.sourceId) throw new Error('尚未打开文件夹');
  const res = await window.gkpv.readFile(state.sourceId, rel);
  if (!res || res.error || !res.buffer) throw new Error((res && res.error) || `读不到文件：${rel}`);
  const bytes = new Uint8Array(res.buffer);
  const name = String(rel).split('/').pop();
  const entry = {
    name,
    rel,
    size: res.size || bytes.length,
    lastModified: res.lastModified || 0,
    sourceId: state.sourceId,
    preview: null,
    // MIME 必须带上：不带类型的 Blob 走 URL.createObjectURL 之后，SVG 在 `<img>` 里
    // 一定解不出来（Chromium 要求 image/svg+xml），报「SVG 解码失败」。
    // 界面路径一直是对的原因在 source.js 的 getFileFor()：那里传了 guessMime(entry.name)。
    _fileCache: fileFromBytes(bytes, name, res.lastModified || 0, guessMime(name)),
  };
  if (skipPreview) delete entry.preview;
  return fn(entry._fileCache, entry);
}

/* ------------------------------------------------------------------ *
 * 目录条目构造器（由 lib/entries.js 提供；这里做一次适配）
 * ------------------------------------------------------------------ */

export { loadAspectRatios, saveAspectRatios, loadSvgImage, generateFolderThumb, drawBitmapOriented, updateCounterLabel, getFileFor, dataUrlToBlob };

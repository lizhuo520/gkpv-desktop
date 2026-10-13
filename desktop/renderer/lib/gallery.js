/**
 * 画廊：文件夹卡片 + 虚拟滚动的缩略图网格。
 *
 * 与浏览器版逐条对齐：
 *  - 文件夹卡片**不**虚拟化（数量少、需要常驻）；
 *  - 图片走 `.vs-spacer` 撑高 + 只渲染视口内外各 5 行的 `.vs-row`；
 *  - 缩略图按「进入视口的行」入队，8 路并发生成，带代际计数打断过期任务。
 */

import { state } from './state.js';
import { esc, formatSize } from './fmt.js';
import { isNoDecodeName, extOf, isImageName } from './format.js';
import { computeLayout, sortEntries, counterLabel } from './layout.js';
import {
  getCachedThumb, setCachedThumb, readSidecar, writeSidecar, THUMB_CONCURRENCY,
  loadAspectRatios, saveAspectRatios, cacheKey,
} from './cache.js';
import { generateThumb } from './thumbs.js';

/** 图片总数上限：误选整个盘时不至于把内存吃光。 */
export const SCAN_LIMIT = 20000;
/** 文件夹拼图最多取几张。 */
const FOLDER_PREVIEW_MAX = 4;
/** 视口外上下各多渲染的行数（与 layout.computeVisibleRange 默认值一致）。 */
const VIEW_BUFFER_ROWS = 5;

let $gallery = null;
let $counter = null;
let $loading = null;
let $sort = null;

export function initGallery(dom) {
  $gallery = dom.gallery;
  $counter = dom.counter;
  $loading = dom.loading;
  $sort = dom.sort;
}

/** 画廊内部的错误提示（不依赖 app.js，模块可独立测）。 */
function showLocalError(e) {
  const msg = (e && e.message) || String(e);
  state.stats.errors.push({ where: 'gallery', message: msg });
  $loading.classList.remove('show');
  if (!$gallery) return;
  $gallery.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'error-hint';
  p.textContent = `读取目录出错：${msg}`;
  $gallery.appendChild(p);
  $gallery.style.display = 'block';
}

/* ================================================================== *
 * 1. 渲染入口
 * ================================================================== */

/**
 * 渲染当前目录。
 * @param {object} view { folders, images, entries, dirCount, truncated }
 */
export async function renderGallery(view) {
  const { folders = [], images = [], dirCount = 0, truncated = false } = view || {};
  const gen = ++state.thumbGeneration;

  revokeThumbUrls();
  fnReleaseLightbox();
  teardownVirtualScroll();

  $gallery.innerHTML = '';
  $loading.classList.add('show');
  $gallery.style.display = 'none';

  const sortedFolders = sortEntries(folders, state.sortMode, state.recursiveMode);
  const sortedImages = sortEntries(images, state.sortMode, state.recursiveMode);

  syncImageEntryFlags();
  state.currentImages = sortedImages;
  state.allEntries = [...sortedFolders, ...sortedImages];
  // 递归模式下列表里的图来自所有子目录，所以计数器报真正遍历到的目录数
  state.currentFolderCount = state.recursiveMode ? dirCount : sortedFolders.length;
  state.scanTruncated = !!truncated;

  state.thumbQueue = [];
  state.thumbQueueIdx = 0;
  state.thumbWorkersRunning = 0;
  // 「解不了」的格式不进队列，先计入已完成，否则 done 永远追不上 total
  state.thumbDoneCount = sortedImages.filter((e) => e.unsupported).length;
  state.thumbFailedCount = 0;
  state.thumbFailedNames = [];
  $counter.title = '';
  $counter.style.color = '';

  renderFolderSection(sortedFolders);

  if (sortedImages.length) {
    const sec = document.createElement('div');
    sec.className = 'dir-section';
    const h = document.createElement('h3');
    h.textContent = state.scanTruncated
      ? `图片 (${sortedImages.length}，已达 ${SCAN_LIMIT} 张上限)`
      : `图片 (${sortedImages.length})`;
    sec.appendChild(h);

    state.$scrollContainer = document.createElement('div');
    state.$scrollContainer.className = 'vs-container';
    state.$spacer = document.createElement('div');
    state.$spacer.className = 'vs-spacer';
    state.$scrollContainer.appendChild(state.$spacer);
    sec.appendChild(state.$scrollContainer);
    $gallery.appendChild(sec);
  } else if (!sortedFolders.length) {
    const p = document.createElement('p');
    p.className = 'empty-hint';
    p.textContent = '此目录下没有图片或子文件夹。';
    $gallery.appendChild(p);
  }

  updateCounterLabel(sortedImages.length, state.currentFolderCount);

  $loading.classList.remove('show');
  $gallery.style.display = 'block';

  if (sortedImages.length && state.$scrollContainer) {
    await loadAspectRatios(state.currentDirPath, sortedImages);
    if (gen !== state.thumbGeneration) return;

    await premeasureAspects(sortedImages, gen);
    if (gen !== state.thumbGeneration) return;

    recalculateLayout();
    setupVirtualScroll();
    renderVisibleRows();
  }

  if (sortedFolders.length) {
    const cards = [...$gallery.querySelectorAll('.folder-card')];
    loadFolderPreviews(cards, gen);
  }
}

/** 目录切换后，条目上的「本次视图」字段必须重建，否则会带着上一个目录的 URL。 */
function syncImageEntryFlags() {
  for (const e of state.currentImages) {
    e._currentImgEl = null;
    e._currentCardEl = null;
  }
}

/* ================================================================== *
 * 2. 文件夹区块
 * ================================================================== */

function renderFolderSection(sortedFolders) {
  if (!sortedFolders.length) return;
  const sec = document.createElement('div');
  sec.className = 'dir-section';
  const h = document.createElement('h3');
  h.textContent = `文件夹 (${sortedFolders.length})`;
  sec.appendChild(h);

  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const f of sortedFolders) {
    const card = document.createElement('div');
    card.className = 'card folder-card';
    const icon = document.createElement('span');
    icon.className = 'folder-icon';
    icon.textContent = '📁';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = f.name;
    card.append(icon, label);
    card.addEventListener('click', () => {
      const target = [...state.currentPath, f.name];
      // 导航失败就地提示：目录被删/无权限时用户要看到原因，不能只是「点了没反应」
      fnNavigate(target).catch((err) => showLocalError(err));
    });
    card._folderName = f.name;
    if (f.rel !== undefined) card._folderRel = f.rel;
    // 主进程扫描时已抠出最多 4 张内嵌预览，直接用，不用再开图
    if (Array.isArray(f.preview) && f.preview.length) card._folderPreviews = f.preview;
    grid.appendChild(card);
  }
  sec.appendChild(grid);
  $gallery.appendChild(sec);
}

/* ================================================================== *
 * 3. 宽高比：缓存读取 + 预测量 + 回写
 * ================================================================== */

/** 只读文件头拿宽高比，让首屏布局一次到位；测不到的留给缩略图流程兜底。 */
const PREMEASURE_CONCURRENCY = 24;

async function premeasureAspects(entries, gen) {
  const todo = entries.filter((e) => !(e.width > 0) && !e.unsupported);
  if (!todo.length) return;

  let cursor = 0;
  let done = 0;
  const total = todo.length;

  const worker = async () => {
    while (cursor < todo.length) {
      const entry = todo[cursor];
      cursor += 1;
      if (gen !== state.thumbGeneration) return;
      try {
        const s = await fnMeasure(entry);
        if (s && s.w > 0 && s.h > 0) {
          entry.width = s.w;
          entry.height = s.h;
          entry.aspect = s.w / s.h;
        }
      } catch {
        /* 测不到就留给缩略图阶段 */
      }
      done += 1;
      if (gen === state.thumbGeneration) {
        $counter.textContent = `正在测量尺寸 (${done}/${total})…`;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(PREMEASURE_CONCURRENCY, total) }, worker));
  if (gen !== state.thumbGeneration) return;

  await saveAspectRatios(state.currentDirPath, entries);
  updateCounterLabel(entries.length, state.currentFolderCount);
}

/* ================================================================== *
 * 4. 虚拟滚动
 * ================================================================== */

export function recalculateLayout() {
  if (!state.$scrollContainer || !state.currentImages.length) return;
  const containerWidth = state.$scrollContainer.clientWidth;
  if (containerWidth <= 0) return;

  const result = computeLayout(state.layoutMode, state.currentImages, containerWidth, state.currentSizeKey);
  state.layoutRows = result.rows;
  state.totalHeight = result.totalHeight;
  state.$spacer.style.height = `${state.totalHeight}px`;

  for (const [, el] of state.rowElements) el.remove();   // 清掉已渲染行，下一帧按新布局重建
  state.rowElements.clear();
  state.renderedRange = { start: -1, end: -1 };
  renderVisibleRows();
}

export function renderVisibleRows() {
  if (!state.$scrollContainer || !state.layoutRows.length) return;
  const gen = state.thumbGeneration;
  const rows = state.layoutRows;
  // 页面级滚动：容器顶边在视口里的负偏移就是它的滚动距离
  const scrollTop = Math.max(0, -state.$scrollContainer.getBoundingClientRect().top);
  const viewport = window.innerHeight || 900;

  const first = findFirstVisibleRow(rows, scrollTop);
  let startRow = Math.max(0, first - VIEW_BUFFER_ROWS);
  let endRow = startRow;
  const viewBottom = scrollTop + viewport;
  while (endRow < rows.length && rows[endRow].top < viewBottom) endRow += 1;
  endRow = Math.min(rows.length - 1, endRow + VIEW_BUFFER_ROWS);

  for (const [ri, el] of state.rowElements) {
    if (ri < startRow || ri > endRow) {
      el.remove();
      state.rowElements.delete(ri);
    }
  }

  for (let ri = startRow; ri <= endRow; ri += 1) {
    if (state.rowElements.has(ri)) continue;
    const el = createRowElement(rows[ri], gen);
    state.$scrollContainer.appendChild(el);
    state.rowElements.set(ri, el);
    enqueueRowThumbnails(rows[ri]);
  }

  state.renderedRange = { start: startRow, end: endRow };
}

function findFirstVisibleRow(rows, scrollTop) {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top + rows[mid].height < scrollTop) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function createRowElement(row, gen) {
  void gen;
  const div = document.createElement('div');
  div.className = 'vs-row';
  div.style.top = `${row.top}px`;
  div.style.height = `${row.height}px`;

  for (const item of row.items) {
    const entry = state.currentImages[item.imageIndex];
    if (!entry) continue;

    const card = document.createElement('div');
    card.className = 'card';
    card.style.width = `${item.width}px`;
    card.style.height = `${item.height}px`;
    card.style.position = 'absolute';
    card.style.left = `${item.left}px`;

    const img = document.createElement('img');
    img.alt = entry.name;

    if (entry.unsupported) {
      // 解不了的格式不要留一张永远转圈的占位，直接把格式名标出来
      card.classList.add('thumb-ready', 'unsupported');
      const ph = document.createElement('span');
      ph.className = 'unsupported-icon';
      ph.textContent = extOf(entry.name).toUpperCase();
      card.appendChild(ph);
    } else if (entry._thumbFailed) {
      // 缩略图生成失败（坏图 / RAW 里没有内嵌预览）后，卡片被虚滚动回收再重建时，
      // 既没有 thumbUrl 也没人会回来标 ready —— 结果是一张永远转圈的占位。
      // 网页版（gkpv.html:1545-1553）只有 unsupported / thumbUrl 两个分支，同样有这个洞；
      // 这里按「失败即就绪」处理：不留转圈，信息面板与实际解码结果才一致。
      card.classList.add('thumb-ready', 'thumb-failed');
    } else if (entry.thumbUrl) {
      img.src = entry.thumbUrl;
      img.classList.add('loaded');
      card.classList.add('thumb-ready');
    }

    entry._currentImgEl = img;
    entry._currentCardEl = card;
    card.appendChild(img);

    const lbl = document.createElement('span');
    lbl.className = 'label';
    lbl.textContent = entry.name;
    card.appendChild(lbl);

    // 递归模式下标出来源子文件夹（顶层文件的 rel 里没有 /，就不标）
    if (state.recursiveMode && entry.rel && entry.rel.indexOf('/') >= 0) {
      const sub = document.createElement('span');
      sub.className = 'subfolder-badge';
      sub.textContent = entry.rel.slice(0, entry.rel.lastIndexOf('/'));
      card.appendChild(sub);
    }

    const idx = item.imageIndex;
    card.addEventListener('click', () => fnOpenLightbox(idx));
    attachTooltip(card, entry);
    div.appendChild(card);
  }
  return div;
}

export function setupVirtualScroll() {
  state.vsGen += 1;
  teardownVirtualScrollHandlers();

  let scrollRaf = false;
  state.vsScrollHandler = () => {
    if (scrollRaf) return;
    scrollRaf = true;
    requestAnimationFrame(() => {
      scrollRaf = false;
      renderVisibleRows();
    });
  };
  let resizeRaf = false;
  state.vsResizeHandler = () => {
    if (resizeRaf) return;
    resizeRaf = true;
    requestAnimationFrame(() => {
      resizeRaf = false;
      recalculateLayout();
    });
  };
  window.addEventListener('scroll', state.vsScrollHandler, { passive: true });
  window.addEventListener('resize', state.vsResizeHandler);
}

function teardownVirtualScrollHandlers() {
  if (state.vsScrollHandler) {
    window.removeEventListener('scroll', state.vsScrollHandler);
    state.vsScrollHandler = null;
  }
  if (state.vsResizeHandler) {
    window.removeEventListener('resize', state.vsResizeHandler);
    state.vsResizeHandler = null;
  }
}

export function teardownVirtualScroll() {
  teardownVirtualScrollHandlers();
  for (const [, el] of state.rowElements) el.remove();
  state.rowElements.clear();
  state.layoutRows = [];
  state.renderedRange = { start: -1, end: -1 };
  state.$scrollContainer = null;
  state.$spacer = null;
  state.thumbQueue = [];
  state.thumbQueueIdx = 0;
}

/* ================================================================== *
 * 5. 缩略图队列
 * ================================================================== */

function enqueueRowThumbnails(row) {
  for (const item of row.items) {
    const entry = state.currentImages[item.imageIndex];
    if (!entry || entry.unsupported) continue;   // 解不了的不排队，也不该计入「生成失败」
    if (!entry.thumbUrl && !entry._thumbQueued) {
      entry._thumbQueued = true;
      state.thumbQueue.push(item.imageIndex);
    }
  }
  startThumbWorkers();
}

function startThumbWorkers() {
  const gen = state.thumbGeneration;
  while (state.thumbWorkersRunning < THUMB_CONCURRENCY && state.thumbQueueIdx < state.thumbQueue.length) {
    state.thumbWorkersRunning += 1;
    (async () => {
      try {
        while (state.thumbQueueIdx < state.thumbQueue.length) {
          const idx = state.thumbQueue[state.thumbQueueIdx];
          state.thumbQueueIdx += 1;
          if (gen !== state.thumbGeneration) break;
          const entry = state.currentImages[idx];
          if (!entry || entry.thumbUrl) continue;

          try {
            const res = await getOrBuildThumb(entry);
            if (gen !== state.thumbGeneration) {
              URL.revokeObjectURL(res.url);
              break;
            }
            entry.thumbUrl = res.url;
            state.thumbDoneCount += 1;
            state.currentThumbUrls.push(res.url);

            const hadAspect = entry.width > 0;
            if (res.width) {
              entry.width = res.width;
              entry.height = res.height;
              entry.aspect = res.width / res.height;
            }
            if (entry._currentImgEl) {
              entry._currentImgEl.src = entry.thumbUrl;
              entry._currentImgEl.onload = () => {
                entry._currentImgEl.classList.add('loaded');
                if (entry._currentCardEl) entry._currentCardEl.classList.add('thumb-ready');
              };
            }
            if (!hadAspect && entry.width > 0) scheduleRelayout();
            state.stats.thumbMisses += 1;
          } catch (e) {
            const entryName = entry ? entry.name : String(idx);
            console.warn('Thumb failed for', entryName, e);
            // 失败也必须计数，否则 done 永远到不了 total，计数器会一直停在「正在生成」
            state.thumbDoneCount += 1;
            state.thumbFailedCount += 1;
            if (state.thumbFailedNames.length < 50) state.thumbFailedNames.push(entryName);
            if (entry) {
              entry._thumbFailed = true;
              if (entry._currentCardEl) entry._currentCardEl.classList.add('thumb-ready');
            }
            state.stats.errors.push({ where: 'thumb', name: entryName, message: String((e && e.message) || e) });
          }

          const done = state.thumbDoneCount;
          const total = state.currentImages.length;
          if (gen === state.thumbGeneration) {
            if (done < total) {
              $counter.textContent = `正在生成缩略图 (${done}/${total})…`;
            } else {
              updateCounterLabel(total, state.currentFolderCount);
              if (state.thumbFailedCount) {
                $counter.textContent += `（${state.thumbFailedCount} 张缩略图生成失败）`;
                $counter.title = state.thumbFailedNames.join('\n');
                $counter.style.color = 'var(--text-warning, #c8761a)';
              }
            }
          }
        }
      } finally {
        state.thumbWorkersRunning -= 1;
      }
    })();
  }
}

/** 先查 OPFS 缓存，未命中再生成并回写（含尺寸 sidecar）。 */
export async function getOrBuildThumb(entry) {
  const dirKey = entry.dirPath || state.currentDirPath;
  const key = cacheKey(dirKey, entry);
  const cached = await getCachedThumb(key);
  if (cached) {
    state.stats.thumbHits += 1;
    const meta = await readSidecar(`${key}_m`);
    const width = meta && typeof meta.w === 'number' ? meta.w : 0;
    const height = meta && typeof meta.h === 'number' ? meta.h : 0;
    return { url: URL.createObjectURL(cached), width, height };
  }

  const { blob, width, height } = await generateThumb(entry);
  await setCachedThumb(key, blob);
  await writeSidecar(`${key}_m`, { w: width, h: height });
  return { url: URL.createObjectURL(blob), width, height };
}

export function scheduleRelayout() {
  clearTimeout(state.relayoutTimer);
  state.relayoutTimer = setTimeout(() => {
    if (state.$scrollContainer) recalculateLayout();
    saveAspectRatios(state.currentDirPath, state.currentImages);
  }, 200);
}

function revokeThumbUrls() {
  for (const url of state.currentThumbUrls) URL.revokeObjectURL(url);
  state.currentThumbUrls = [];
}

export function updateCounterLabel(total, folderCount) {
  $counter.textContent = counterLabel(total, folderCount, {
    recursive: state.recursiveMode,
    truncated: state.scanTruncated,
    limit: SCAN_LIMIT,
  });
}

/* ================================================================== *
 * 6. 文件夹拼图预览
 * ================================================================== */

/**
 * 拼图数据来自主进程扫描时抠出的内嵌预览（`folder.preview` 是最多 4 张 data URL），
 * 所以这里通常不需要额外读盘。只有主进程没给出预览时才回退到「再扫一层」。
 * 注意回退路径刻意**不**用递归模式 —— 递归时根目录会永远显示自己的子目录，没有意义。
 */
async function loadFolderPreviews(folderCards, gen) {
  for (const card of folderCards) {
    if (gen !== state.thumbGeneration) return;
    try {
      const previews = await previewUrlsFor(card, gen);
      if (!previews.length) continue;
      if (gen !== state.thumbGeneration) return;
      renderPreviews(card, previews);
    } catch {
      /* 单个文件夹失败不影响其它卡片 */
    }
  }
}

async function previewUrlsFor(card, gen) {
  if (Array.isArray(card._folderPreviews) && card._folderPreviews.length) {
    return card._folderPreviews.slice(0, FOLDER_PREVIEW_MAX);
  }

  // 回退路径：主进程这次没给预览（多数是**非递归**模式下，卡片对应的图不在本次扫描范围里），
  // 就按这个文件夹自己的路径再扫一遍带预览的（对齐网页版的 getFolderThumb(dirPath, file)）。
  // 注意 subPath 必须是**那个文件夹**，不能是根：扫描结果已限定在该文件夹内，无需再做前缀过滤。
  const sub = card._folderRel !== undefined
    ? card._folderRel
    : [...state.currentPath, card._folderName].filter(Boolean).join('/');
  const res = await window.gkpv.scan(state.sourceId, true, sub);
  if (!res || res.error) return [];
  const hits = (res.entries || [])
    .filter((e) => e.kind === 'file' && e.preview && isImageName(e.name) && !isNoDecodeName(e.name));

  const out = [];
  for (const e of hits.slice(0, FOLDER_PREVIEW_MAX)) {
    if (gen !== state.thumbGeneration) return out;
    out.push(e.preview);
  }
  return out;
}

function renderPreviews(card, urls) {
  const icon = card.querySelector('.folder-icon');
  if (!icon) return;
  const mosaic = document.createElement('div');
  mosaic.className = `folder-mosaic${urls.length === 1 ? ' single' : ''}`;
  for (const url of urls) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    mosaic.appendChild(img);
  }
  icon.replaceWith(mosaic);
}

/* ================================================================== *
 * 7. 卡片悬停信息
 * ================================================================== */

function attachTooltip(card, entry) {
  card.addEventListener('mouseenter', () => {
    if (!state.$tooltip) return;
    const dims = entry.width ? `${entry.width} × ${entry.height}` : '尺寸未知';
    const date = entry.lastModified ? new Date(entry.lastModified).toLocaleDateString() : '';
    state.$tooltip.innerHTML = `<span class="tt-name">${esc(entry.name)}</span>`
      + `<span class="tt-detail">${esc(dims)} &middot; ${esc(formatSize(entry.size || 0))} &middot; ${esc(date)}</span>`;
    state.$tooltip.style.display = 'block';
  });
  card.addEventListener('mousemove', (e) => {
    if (!state.$tooltip) return;
    state.$tooltip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 260)}px`;
    state.$tooltip.style.top = `${e.clientY + 16}px`;
  });
  card.addEventListener('mouseleave', () => {
    if (state.$tooltip) state.$tooltip.style.display = 'none';
  });
}

/* ================================================================== *
 * 8. 宿主注入（打破 gallery ⇄ app ⇄ lightbox 的循环依赖）
 * ================================================================== */

let fnNavigate = async () => {};
let fnOpenLightbox = () => {};
// 测尺寸由宿主注入（app.js 的 measureEntry）。返回 `{w,h}` 或 null；
// 默认实现什么都不测，绝不能顺手返回一个 file 对象 —— 调用方按 `{w,h}` 取值。
let fnMeasure = async () => null;
let fnReleaseLightbox = () => {};

export function bindGalleryHost({ navigate, openLightbox, measure, releaseLightbox }) {
  if (navigate) fnNavigate = navigate;
  if (openLightbox) fnOpenLightbox = openLightbox;
  if (measure) fnMeasure = measure;
  if (releaseLightbox) fnReleaseLightbox = releaseLightbox;
}

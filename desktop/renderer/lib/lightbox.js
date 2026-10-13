/**
 * 灯箱：全尺寸查看 + 缩放平移 + 键盘导航 + EXIF 信息面板。
 *
 * 与原版一致的关键点：
 *  - `lbPreloadCache` 是「全尺寸 URL」的唯一持有者，谁建谁 revoke；
 *  - 每次切换自增 token，异步结果回来时若 token 变了就丢弃（不会闪回上一张）；
 *  - RAW 的转正只在**这里**做（缩略图走的是 thumbs.js 的同名逻辑），
 *    且必须在拿到 URL 时按需读取内嵌预览，否则会出现「缩略图正常、点开空白」。
 */

import { state } from './state.js';
import { esc, formatSize } from './fmt.js';
import { extOf, isNoDecodeName, isRawName } from './format.js';
import { drawBitmapOriented } from './orientation.js';
import { getFileFor } from './source.js';
import { rawPreviewOf, canvasToBlob } from './thumbs.js';
import {
  parseExif, formatShutter, formatAperture, formatFocalLength, formatOrientation,
} from './exif.js';
import { constrainPan, zoomAround } from './layout.js';

export const LB_MIN_SCALE = 0.5;
export const LB_MAX_SCALE = 20;
export const LB_ZOOM_STEP = 1.15;

let $lightbox = null;
let $lbImg = null;
let $lbImgPrev = null;
let $lbZoom = null;
let $lbMsg = null;
let $lbInfo = null;
let $exifPanel = null;
let $infoBtn = null;

/** index -> blobURL。全尺寸 URL 只从这里出、也只由这里回收。 */
const lbPreloadCache = new Map();

let lbScale = 1;
let lbTx = 0;
let lbTy = 0;
let lbLayoutW = 0;
let lbLayoutH = 0;
let lbDragging = false;
let lbMouseMoved = false;
let lbDragStartX = 0;
let lbDragStartY = 0;
let lbDragStartTx = 0;
let lbDragStartTy = 0;
let lbTouchDist0 = null;
let lbTouchScale0 = null;
let lbLastTap = 0;
let lbZoomTimer = null;
let lbShowToken = 0;
let exifPanelOpen = false;

export function initLightbox(dom) {
  $lightbox = dom.lightbox;
  $lbImg = dom.lbImg;
  $lbImgPrev = dom.lbImgPrev;
  $lbZoom = dom.lbZoom;
  $lbMsg = dom.lbMsg;
  $lbInfo = dom.lbInfo;
  $exifPanel = dom.exifPanel;
  $infoBtn = dom.infoBtn;
  bindEvents(dom);
}

/* ================================================================== *
 * 打开 / 关闭 / 翻页
 * ================================================================== */

export function openLightbox(index) {
  state.lbIndex = index;
  showLightboxImage();
  $lightbox.classList.add('open');
}

export function closeLightbox() {
  $lightbox.classList.remove('open');
  resetZoom();
  hideMessage();
  $lbImgPrev.src = '';
  $lbImgPrev.style.opacity = '0';
  // 当前 URL 马上会被 revoke，src 留着会让下次打开用到已失效的地址
  $lbImg.removeAttribute('src');
  lbReleaseExcept(new Set());   // 空集合 = 全部释放
  state.lbCurrentUrl = null;
  exifPanelOpen = false;
  $exifPanel.classList.remove('open');
  $infoBtn.classList.remove('active');
}

export function lbPrev() {
  const n = state.currentImages.length;
  if (!n) return;
  state.lbIndex = (state.lbIndex - 1 + n) % n;
  showLightboxImage();
}

export function lbNext() {
  const n = state.currentImages.length;
  if (!n) return;
  state.lbIndex = (state.lbIndex + 1) % n;
  showLightboxImage();
}

export function isLightboxOpen() {
  return !!$lightbox && $lightbox.classList.contains('open');
}

/** 该条目在灯箱里能否显示（HEIC 一律不行；RAW 取决于有没有内嵌预览）。 */
export function lightboxSupportOf(entry) {
  if (!entry) return 'none';
  if (isNoDecodeName(entry.name)) return 'nodecode';
  if (isRawName(entry.name)) return 'raw';
  return 'ok';
}

/** 目录重渲染时必须释放所有预载 URL（由 gallery 调用）。 */
export function lightboxReleaseAll() {
  lbReleaseExcept(new Set());
}

/* ================================================================== *
 * URL 生命周期
 * ================================================================== */

function lbReleaseExcept(keep) {
  for (const [idx, url] of lbPreloadCache) {
    if (!keep.has(idx)) {
      URL.revokeObjectURL(url);
      lbPreloadCache.delete(idx);
    }
  }
}

async function lbEnsureUrl(idx) {
  if (lbPreloadCache.has(idx)) return lbPreloadCache.get(idx);
  const entry = state.currentImages[idx];
  if (!entry) return null;
  const blob = await fullBlobFor(entry);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  lbPreloadCache.set(idx, url);
  return url;
}

/** 预热前后各一张，并释放其它。 */
async function lbPreloadAdjacent() {
  const n = state.currentImages.length;
  if (n <= 1) return;
  const keep = new Set([state.lbIndex, (state.lbIndex - 1 + n) % n, (state.lbIndex + 1) % n]);
  lbReleaseExcept(keep);
  for (const idx of keep) {
    if (idx === state.lbIndex || lbPreloadCache.has(idx)) continue;
    const url = await lbEnsureUrl(idx);
    if (!url) continue;
    // 等待期间用户可能已经翻页：这张图不再需要就立刻回收
    if (idx !== (state.lbIndex - 1 + n) % n && idx !== (state.lbIndex + 1) % n) {
      URL.revokeObjectURL(url);
      lbPreloadCache.delete(idx);
      return;
    }
    const img = new Image();   // 只是让浏览器提前解码
    img.src = url;
  }
}

/**
 * 给灯箱一份「浏览器能解码的 Blob」。
 * 这里必须按需读取：缩略图命中 OPFS 缓存时 readRawPreview 一次都不会被调用，
 * 只查缓存就会复现「缩略图正常、点开一片空白」。
 */
export async function fullBlobFor(entry) {
  if (!entry) return null;
  if (isNoDecodeName(entry.name)) return null;   // HEIC 等：交给调用方提示
  if (isRawName(entry.name)) {
    const pv = await rawPreviewOf(entry);
    if (!pv) return null;
    if (pv.orient <= 1) return pv.blob;
    // 内嵌预览不带 EXIF 方向，<img> 不会替我们转，必须先转正再交给它
    try {
      const bmp = await createImageBitmap(pv.blob, { imageOrientation: 'from-image' });
      const canvas = drawBitmapOriented(bmp, pv.orient);
      bmp.close();
      return await canvasToBlob(canvas, 'image/jpeg', 0.92);
    } catch {
      return pv.blob;   // 转不动就退回未转正的预览，至少有图
    }
  }
  const file = await getFileFor(entry);
  if (!file) return null;
  return file;
}

/* ================================================================== *
 * 显示当前图
 * ================================================================== */

export async function showLightboxImage() {
  const entry = state.currentImages[state.lbIndex];
  if (!entry) return;
  const token = ++lbShowToken;

  // 交叉淡入：把当前图快照进上一层
  const isOpen = $lightbox.classList.contains('open');
  if (isOpen && $lbImg.src && $lbImg.naturalWidth > 0) {
    $lbImgPrev.src = $lbImg.src;
    $lbImgPrev.style.transition = 'none';
    $lbImgPrev.style.opacity = '1';
    void $lbImgPrev.offsetHeight;   // 强制 reflow，让快照先落地
    $lbImgPrev.style.transition = '';
  }

  resetZoom();
  hideMessage();
  $lbInfo.textContent = `${entry.name}  (${state.lbIndex + 1} / ${state.currentImages.length})`;

  const url = await lbEnsureUrl(state.lbIndex);
  if (token !== lbShowToken) return;   // 用户已翻到别的图，丢弃这次结果

  if (!url) {
    state.lbCurrentUrl = null;
    $lbImg.removeAttribute('src');
    $lbImgPrev.style.opacity = '0';    // 淡出上一张快照，露出提示文字
    showMessage(isNoDecodeName(entry.name)
      ? `${extOf(entry.name).toUpperCase()} 格式浏览器无法解码，请用系统看图工具打开`
      : '无法显示这张图片：RAW 中没有找到内嵌预览');
    lbPreloadAdjacent();
    if (exifPanelOpen) updateExifPanel();
    return;
  }

  state.lbCurrentUrl = url;
  $lbImg.onload = () => {
    if (token !== lbShowToken) return;
    lbLayoutW = $lbImg.offsetWidth;
    lbLayoutH = $lbImg.offsetHeight;
    $lbImg.className = 'zoom-in-cursor';
    $lbImgPrev.style.opacity = '0';
  };
  $lbImg.onerror = () => {
    if (token === lbShowToken) showMessage('图片解码失败');
  };
  $lbImg.src = state.lbCurrentUrl;
  lbPreloadAdjacent();
  if (exifPanelOpen) updateExifPanel();
}

/* ================================================================== *
 * 消息
 * ================================================================== */

export function showMessage(text) {
  $lbMsg.textContent = text;
  $lbMsg.classList.add('show');
}

export function hideMessage() {
  $lbMsg.classList.remove('show');
}

/* ================================================================== *
 * 缩放 / 平移
 * ================================================================== */

export function applyTransform() {
  $lbImg.style.transform = `translate(${lbTx}px, ${lbTy}px) scale(${lbScale})`;
  $lbImg.className = '';
  if (lbScale <= 1.01) $lbImg.classList.add('zoom-in-cursor');
  else if (lbDragging) $lbImg.classList.add('grabbing-cursor');
  else $lbImg.classList.add('grab-cursor');
}

/** 把布局尺寸放大到「原图 100%」所需的倍率。 */
export function scaleFor100() {
  if (!lbLayoutW) return 1;
  return $lbImg.naturalWidth / lbLayoutW;
}

export function constrainCurrentPan() {
  const next = constrainPan(lbTx, lbTy, lbLayoutW, lbLayoutH, lbScale, window.innerWidth, window.innerHeight);
  lbTx = next.tx;
  lbTy = next.ty;
}

export function resetZoom() {
  lbScale = 1;
  lbTx = 0;
  lbTy = 0;
  lbDragging = false;
  lbMouseMoved = false;
  lbTouchDist0 = null;
  $lbImg.style.transform = '';
  $lbImg.className = 'zoom-in-cursor';
}

function showZoomBadge() {
  $lbZoom.textContent = `${Math.round(lbScale * 100)}%`;
  $lbZoom.classList.add('visible');
  clearTimeout(lbZoomTimer);
  lbZoomTimer = setTimeout(() => $lbZoom.classList.remove('visible'), 1200);
}

export function zoomTo(newScale, cx, cy) {
  const clamped = Math.max(LB_MIN_SCALE, Math.min(LB_MAX_SCALE, newScale));
  const next = zoomAround(lbTx, lbTy, lbScale, clamped, cx, cy);
  lbTx = next.tx;
  lbTy = next.ty;
  lbScale = clamped;
  constrainCurrentPan();
  applyTransform();
  showZoomBadge();
}

/** 点击/双击时把视图在「适应窗口 ↔ 100%」之间切换。 */
function toggleFit100(clientX, clientY) {
  const s100 = scaleFor100();
  if (Math.abs(lbScale - 1) < 0.01 && s100 > 1.05) {
    const rect = $lbImg.getBoundingClientRect();
    zoomTo(s100, clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2));
  } else {
    lbScale = 1;
    lbTx = 0;
    lbTy = 0;
    constrainCurrentPan();
    applyTransform();
    showZoomBadge();
  }
}

/* ================================================================== *
 * 事件绑定
 * ================================================================== */

function bindEvents(dom) {
  dom.closeBtn.addEventListener('click', closeLightbox);
  dom.prevBtn.addEventListener('click', lbPrev);
  dom.nextBtn.addEventListener('click', lbNext);
  $lightbox.addEventListener('click', (e) => {
    if (e.target === $lightbox && !lbMouseMoved) closeLightbox();
  });

  $infoBtn.addEventListener('click', toggleExifPanel);

  // ---- 滚轮缩放：以指针位置为锚点 ----
  $lbImg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = $lbImg.getBoundingClientRect();
    const cx = e.clientX - (rect.left + rect.width / 2);
    const cy = e.clientY - (rect.top + rect.height / 2);
    const factor = e.deltaY < 0 ? LB_ZOOM_STEP : 1 / LB_ZOOM_STEP;
    zoomTo(lbScale * factor, cx, cy);
  }, { passive: false });

  // ---- 单击：适应窗口 ↔ 100% ----
  $lbImg.addEventListener('click', (e) => {
    if (lbMouseMoved) return;
    e.stopPropagation();
    toggleFit100(e.clientX, e.clientY);
  });

  // ---- 鼠标拖拽平移（仅放大后） ----
  $lbImg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (lbScale <= 1.01) return;
    lbDragging = true;
    lbMouseMoved = false;
    lbDragStartX = e.clientX;
    lbDragStartY = e.clientY;
    lbDragStartTx = lbTx;
    lbDragStartTy = lbTy;
    $lbImg.classList.remove('grab-cursor');
    $lbImg.classList.add('grabbing-cursor');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!lbDragging) return;
    const dx = e.clientX - lbDragStartX;
    const dy = e.clientY - lbDragStartY;
    // 超过 3px 才算拖拽：否则 click 会被当成「点了空白」而误关灯箱
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) lbMouseMoved = true;
    lbTx = lbDragStartTx + dx;
    lbTy = lbDragStartTy + dy;
    constrainCurrentPan();
    applyTransform();
  });

  document.addEventListener('mouseup', () => {
    if (!lbDragging) return;
    lbDragging = false;
    if (lbScale > 1.01) {
      $lbImg.classList.remove('grabbing-cursor');
      $lbImg.classList.add('grab-cursor');
    }
  });

  // ---- 触摸：单指平移 + 双指捏合 + 双击 ----
  $lbImg.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lbTouchDist0 = Math.hypot(dx, dy);
      lbTouchScale0 = lbScale;
    } else if (e.touches.length === 1 && lbScale > 1.01) {
      lbDragging = true;
      lbMouseMoved = false;
      lbDragStartX = e.touches[0].clientX;
      lbDragStartY = e.touches[0].clientY;
      lbDragStartTx = lbTx;
      lbDragStartTy = lbTy;
    }
    if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lbLastTap < 300) {
        e.preventDefault();
        toggleFit100(e.touches[0].clientX, e.touches[0].clientY);
        lbLastTap = 0;
      } else {
        lbLastTap = now;
      }
    }
  }, { passive: false });

  $lbImg.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 2 && lbTouchDist0) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const rect = $lbImg.getBoundingClientRect();
      zoomTo(lbTouchScale0 * (dist / lbTouchDist0), midX - (rect.left + rect.width / 2), midY - (rect.top + rect.height / 2));
    } else if (e.touches.length === 1 && lbDragging) {
      const dx = e.touches[0].clientX - lbDragStartX;
      const dy = e.touches[0].clientY - lbDragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) lbMouseMoved = true;
      lbTx = lbDragStartTx + dx;
      lbTy = lbDragStartTy + dy;
      constrainCurrentPan();
      applyTransform();
    }
  }, { passive: false });

  $lbImg.addEventListener('touchend', () => {
    lbDragging = false;
    lbTouchDist0 = null;
  });

  window.addEventListener('resize', () => {
    if (!$lightbox.classList.contains('open')) return;
    if (lbScale > 1) {
      constrainCurrentPan();
      applyTransform();
    }
  });

  // ---- 键盘 ----
  document.addEventListener('keydown', (e) => {
    if (!$lightbox.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') lbPrev();
    else if (e.key === 'ArrowRight') lbNext();
    else if (e.key === '+' || e.key === '=') zoomTo(lbScale * LB_ZOOM_STEP, 0, 0);
    else if (e.key === '-') zoomTo(lbScale / LB_ZOOM_STEP, 0, 0);
    else if (e.key === '0') {
      lbScale = 1;
      lbTx = 0;
      lbTy = 0;
      constrainCurrentPan();
      applyTransform();
      showZoomBadge();
    } else if (e.key === 'i' || e.key === 'I') toggleExifPanel();
  });
}

/* ================================================================== *
 * EXIF 信息面板
 * ================================================================== */

export function toggleExifPanel() {
  exifPanelOpen = !exifPanelOpen;
  $exifPanel.classList.toggle('open', exifPanelOpen);
  $infoBtn.classList.toggle('active', exifPanelOpen);
  if (exifPanelOpen) updateExifPanel();
}

export function isExifPanelOpen() {
  return exifPanelOpen;
}

export async function updateExifPanel() {
  if (!exifPanelOpen) return;
  const entry = state.currentImages[state.lbIndex];
  if (!entry) return;

  const row = (label, value) => `<div class="exif-row"><span class="exif-label">${esc(label)}</span>`
    + `<span class="exif-value">${esc(value)}</span></div>`;

  let html = '<div class="exif-heading">文件</div>';
  html += row('名称', entry.name);
  html += row('大小', formatSize(entry.size || 0));
  if (entry.width) html += row('尺寸', `${entry.width} × ${entry.height}`);
  const mtime = entry.lastModified ? new Date(entry.lastModified).toLocaleString() : '—';
  html += row('修改时间', mtime);

  const exif = await parseExif(entry);
  if (exif) {
    html += '<div class="exif-heading">相机</div>';
    const cam = [exif.Make, exif.Model].filter(Boolean).join(' ').trim();
    if (cam) html += row('相机', cam);
    if (exif.Orientation > 1) html += row('方向', `${exif.Orientation}（${formatOrientation(exif.Orientation)}）`);
    if (exif.LensModel) html += row('镜头', exif.LensModel);
    const settings = [
      formatFocalLength(exif.FocalLength),
      formatAperture(exif.FNumber),
      formatShutter(exif.ExposureTime),
      exif.ISO ? `ISO ${exif.ISO}` : null,
    ].filter(Boolean).join('  ');
    if (settings) html += row('拍摄参数', settings);
    if (exif.DateTimeOriginal) html += row('拍摄时间', exif.DateTimeOriginal);
    if (exif.PixelXDimension && exif.PixelYDimension) {
      html += row('EXIF 尺寸', `${exif.PixelXDimension} × ${exif.PixelYDimension}`);
    }
  } else {
    html += '<div class="exif-heading muted">无 EXIF 信息</div>';
  }
  $exifPanel.innerHTML = html;
}

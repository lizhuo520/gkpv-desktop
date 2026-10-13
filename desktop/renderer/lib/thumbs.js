/**
 * 缩略图生成：与浏览器版 `generateThumb()` 逐路径等价。
 *
 * 四条路径：
 *  - HEIC/HEIF：Chromium 解不了，直接抛错让 UI 标成"不支持"；
 *  - RAW：从容器里抠内嵌 JPEG → 按容器方向转正 → 缩到 THUMB_MAX；
 *  - SVG：createImageBitmap 不支持 SVG Blob，必须走 <img>；
 *  - 其余（JPEG/PNG/WebP/GIF/BMP/AVIF）：先只读文件头算尺寸，快路径按目标尺寸直接解码。
 */

import { extOf, isNoDecodeName, isSvgName, isRawName, BITMAP_OPTS } from './format.js';
import { readImageSize } from './image-format.js';
import { drawBitmapOriented, swapsDimensions, applyOrientationMatrix } from './orientation.js';
import { isSaneSize } from './fmt.js';
import { readRawPreview, previewFromDataUrl } from './raw.js';
import { ensureHeadBytes, readSliceFor, getFileFor } from './source.js';
import { THUMB_MAX, THUMB_QUALITY } from './cache.js';

/** 文件夹拼图缩略图的最大边。 */
export const FOLDER_THUMB_MAX = 160;

/** 当前环境能否用 OffscreenCanvas（Electron 渲染进程里恒为真）。 */
export function hasOffscreenCanvas() {
  return typeof OffscreenCanvas === 'function';
}

/**
 * 合成目标画布并导出 Blob。
 * 抽出来是为了让「有 OffscreenCanvas / 用普通 canvas」两条路共用同一段导出逻辑。
 */
async function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob 返回空'))), type, quality);
  });
}

function createCanvas(w, h) {
  if (hasOffscreenCanvas()) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * 按 EXIF 方向把位图转正；没有 OffscreenCanvas 时退回普通 canvas。
 */
function orientedCanvas(bmp, orientation, maxSize) {
  if (hasOffscreenCanvas()) return drawBitmapOriented(bmp, orientation, maxSize);
  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  const swap = swapsDimensions(orientation);
  let cw = swap ? h : w;
  let ch = swap ? w : h;
  const scale = maxSize > 0 ? Math.min(1, maxSize / Math.max(cw, ch)) : 1;
  cw = Math.max(1, Math.round(cw * scale));
  ch = Math.max(1, Math.round(ch * scale));
  const canvas = createCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(scale, scale);
  applyOrientationMatrix(ctx, orientation, w, h);
  ctx.drawImage(bmp, 0, 0);
  return canvas;
}

/* ------------------------------------------------------------------ *
 * SVG
 * ------------------------------------------------------------------ */

/**
 * createImageBitmap 不支持 SVG Blob（Chromium issue 40269670：SVG 渲染依赖 DOM），
 * 只能走 <img> 解码。
 */
export async function loadSvgImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('SVG 解码失败'));
      img.src = url;
    });
  } catch (e) {
    URL.revokeObjectURL(url);   // 失败路径也要回收 URL
    throw e;
  }
  return { img, url };
}

/** 矢量图没有固有像素尺寸：naturalWidth 取不到就按 512 兜底。 */
export async function generateSvgThumb(file) {
  const { img, url } = await loadSvgImage(file);
  try {
    const ow = img.naturalWidth || 512;
    const oh = img.naturalHeight || 512;
    const scale = Math.min(1, THUMB_MAX / Math.max(ow, oh));
    const w = Math.max(1, Math.round(ow * scale));
    const h = Math.max(1, Math.round(oh * scale));
    const canvas = createCanvas(w, h);
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    // SVG 常带透明背景：用 PNG 保留透明度（JPEG 会把透明区域画成黑色）
    const blob = await canvasToBlob(canvas, 'image/png', undefined);
    return { blob, width: ow, height: oh, path: 'svg' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ------------------------------------------------------------------ *
 * RAW
 * ------------------------------------------------------------------ */

/** RAW 的内嵌预览（命中扫描缓存 / 读盘 / 命中内存缓存三选一）。 */
export async function rawPreviewOf(entry) {
  if (entry._rawPreview) return entry._rawPreview;
  // 扫描阶段主进程已把内嵌 JPEG 抠成 data URL（entry.preview），容器方向也随条目下发
  // （entry.orientation）。这里必须用**预览字节本身**：
  //
  // 曾经这里写的是 await getFileFor(entry)，而 source.js 的 getFileFor 故意返回整个
  // RAW 容器（TIFF，为了给 readRawPreview 解析用）。把容器当图丢给 createImageBitmap
  // 一定失败——`The source image could not be decoded.`，tools/gen-fixtures.mjs 里
  // decodeVia='raw' 的注释记着实测 5/5 失败（当时以为浏览器啃不动 RAW，其实是传错了东西）。
  // E2E 的 gallery:recursive-* 就挂着 raw/canon-a.CR2 与 raw/dng-sample.dng 两张缩略图。
  const fromScan = previewFromDataUrl(entry);
  if (fromScan) {
    entry._rawPreview = fromScan;
    return fromScan;
  }
  const head = await ensureHeadBytes(entry);
  if (!head) return null;
  const res = await readRawPreview(entry, head, (off, len) => readSliceFor(entry, off, len));
  if (res) entry._rawPreview = res;
  return res;
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * @param {object} entry 目录条目（name/size/rel/lastModified + 可选的 preview）
 * @returns {Promise<{blob:Blob,width:number,height:number,path:string}>}
 */
export async function generateThumb(entry) {
  const name = entry && entry.name;

  // 浏览器解不了的格式（HEIC/HEIF）直接抛错，让调用方标成「不支持」，
  // 没必要白走一遍必然失败的解码
  if (isNoDecodeName(name)) throw new Error(`浏览器无法解码 ${extOf(name).toUpperCase()} 格式`);

  // RAW：走内嵌 JPEG 预览，别让浏览器去啃解不了的传感器数据
  if (isRawName(name)) {
    const pv = await rawPreviewOf(entry);
    if (!pv) throw new Error('无法从 RAW 中取出内嵌预览图');
    // 内嵌预览不带 EXIF 方向，像素是传感器朝向，必须自己按 pv.orient 转正；
    // 转完宽高会互换，所以不能按转之前的长宽去缩放
    const bmp = await createImageBitmap(pv.blob, BITMAP_OPTS);
    const canvas = orientedCanvas(bmp, pv.orient, THUMB_MAX);
    bmp.close();
    const blob = await canvasToBlob(canvas, 'image/jpeg', THUMB_QUALITY);
    // 尺寸优先报「相机全分辨率显示尺寸」；对不上实际像素比例（>2%）时以实际像素为准，
    // 否则 justified 布局会按错误的比例排版
    const cw = canvas.width;
    const ch = canvas.height;
    const sameAR = pv.w > 0 && pv.h > 0 && Math.abs(pv.w / pv.h - cw / ch) / (cw / ch) < 0.02;
    return sameAR
      ? { blob, width: pv.w, height: pv.h, path: 'raw' }
      : { blob, width: cw, height: ch, path: 'raw' };
  }

  const file = await getFileFor(entry);
  if (!file) throw new Error('取不到文件内容');

  // SVG：createImageBitmap 不支持 SVG Blob，必须走 <img>
  if (isSvgName(name)) return { ...(await generateSvgThumb(file)), path: 'svg' };

  const declared = await readImageSize(file);

  if (isSaneSize(declared)) {
    const ow = declared.w;
    const oh = declared.h;
    const needResize = Math.max(ow, oh) > THUMB_MAX;
    const portrait = oh > ow;
    let bmp = null;
    try {
      // 只传一个维度，保持长宽比（两个都传会拉伸变形）；并显式按 EXIF 方向解码
      bmp = needResize
        ? await createImageBitmap(file, {
          ...BITMAP_OPTS,
          resizeQuality: 'high',
          ...(portrait ? { resizeHeight: THUMB_MAX } : { resizeWidth: THUMB_MAX }),
        })
        : await createImageBitmap(file, BITMAP_OPTS);
    } catch {
      bmp = null;
    }

    if (bmp) {
      // 校验：真实解码出来的宽高比必须和文件头解析的一致，否则说明解析不可信。
      const parsedAR = ow / oh;
      const realAR = bmp.width / bmp.height;
      if (Math.abs(realAR - parsedAR) / parsedAR < 0.02) {
        const scale = Math.min(1, THUMB_MAX / Math.max(ow, oh));
        const tw = Math.max(1, Math.round(ow * scale));
        const th = Math.max(1, Math.round(oh * scale));
        const canvas = createCanvas(tw, th);
        canvas.getContext('2d').drawImage(bmp, 0, 0, tw, th);
        bmp.close();
        const blob = await canvasToBlob(canvas, 'image/jpeg', THUMB_QUALITY);
        return { blob, width: ow, height: oh, path: 'header' };
      }
      bmp.close();
    }
  }

  // 回退路径：与优化前完全一致的实现（同样显式声明 EXIF 方向）
  const bitmap = await createImageBitmap(file, BITMAP_OPTS);
  const origW = bitmap.width;
  const origH = bitmap.height;
  let w = origW;
  let h = origH;
  if (w > THUMB_MAX || h > THUMB_MAX) {
    const scale = Math.min(THUMB_MAX / w, THUMB_MAX / h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await canvasToBlob(canvas, 'image/jpeg', THUMB_QUALITY);
  return { blob, width: origW, height: origH, path: 'fallback' };
}

/**
 * 文件夹拼图用的缩略图：RAW 要走内嵌预览（否则 createImageBitmap 直接抛异常，
 * 结果是「只要有 RAW 的文件夹，整张卡片都没有拼图」），SVG 走 <img>，其余照旧。
 */
export async function generateFolderThumb(entry) {
  const file = await getFileFor(entry);
  if (!file) throw new Error('取不到文件内容');

  let source = file;
  let svg = null;
  let bmp = null;
  let orient = 1;                     // RAW 内嵌预览需要我们自己补的旋转，见 drawBitmapOriented
  if (isRawName(entry.name)) {
    const pv = await rawPreviewOf(entry);
    if (!pv) throw new Error('无法从 RAW 中取出内嵌预览图');
    source = pv.blob;
    orient = pv.orient;
  } else if (isSvgName(entry.name)) {
    svg = await loadSvgImage(file);   // HTMLImageElement 可以直接 drawImage
    source = svg.img;
  }
  try {
    bmp = typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement
      ? source
      : await createImageBitmap(source, BITMAP_OPTS);
    if (orient > 1) {
      // 传感器的像素朝向：按 IFD0 方向转正（顺带缩到拼图上限），别把躺倒的图拼进去
      const canvas = orientedCanvas(bmp, orient, FOLDER_THUMB_MAX);
      return await canvasToBlob(canvas, 'image/jpeg', 0.6);
    }
    let w = bmp.naturalWidth || bmp.width || 160;
    let h = bmp.naturalHeight || bmp.height || 160;
    if (w > FOLDER_THUMB_MAX || h > FOLDER_THUMB_MAX) {
      const scale = Math.min(FOLDER_THUMB_MAX / w, FOLDER_THUMB_MAX / h);
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
    }
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    return await canvasToBlob(canvas, 'image/jpeg', 0.6);
  } finally {
    if (bmp && bmp !== source && typeof bmp.close === 'function') bmp.close();   // ImageBitmap 必须显式释放
    if (svg) URL.revokeObjectURL(svg.url);
  }
}

export { canvasToBlob, createCanvas, orientedCanvas };

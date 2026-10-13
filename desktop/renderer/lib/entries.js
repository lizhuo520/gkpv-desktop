/**
 * 目录条目（entry）的构造函数。
 *
 * 一个 entry 同时要满足三种消费者的形状要求：
 *  - `thumbs.js` / `exif.js` / `image-format.js` 要 `file` 样对象（Blob + name/size/lastModified/slice）；
 *  - `layout.js` 要 `aspect`（且必须与「显示朝向」一致）；
 *  - 缓存 key 要 `name/size/lastModified` 三件套。
 *
 * 尺寸规则和网页版一致：EXIF Orientation 5~8 的图显示时宽高互换，
 * 所以 `width/height/aspect` 存的永远是「转正之后」的尺寸，否则布局会挤成竖条。
 */

import { isNoDecodeName, extOf } from './format.js';
import { fileFromBytes } from './source.js';

/**
 * 把主进程扫描结果（kind:'file'）转成渲染层条目。
 * @param {Array<object>} files
 * @param {string} sourceId
 */
export function makeEntries(files, sourceId) {
  return (files || []).map((e) => entryFromFile(e, sourceId));
}

export function entryFromFile(e, sourceId) {
  const swap = typeof e.orientation === 'number' && e.orientation >= 5 && e.orientation <= 8;
  const width = e.width || 0;
  const height = e.height || 0;

  return {
    kind: 'file',
    name: e.name,
    rel: e.rel,
    dirPath: e.dirPath || '',
    sourceId: sourceId || e.sourceId || null,
    size: e.size || 0,
    lastModified: e.lastModified || 0,
    ext: extOf(e.name),
    // 扫描阶段抠出的内嵌预览（data URL）；有它就不用再读盘
    preview: e.preview || null,
    previewError: e.previewError || null,
    orientation: e.orientation || 0,

    // 显示尺寸：方向 5~8 需要互换
    width: swap ? height : width,
    height: swap ? width : height,
    aspect: width > 0 && height > 0 ? (swap ? height / width : width / height) : 1,

    unsupported: isNoDecodeName(e.name),

    // 运行时字段（渲染过程中填）
    thumbUrl: null,
    _thumbQueued: false,
    _thumbFailed: false,
    _currentImgEl: null,
    _currentCardEl: null,
    _fileCache: null,
    _headBytes: null,
    _rawPreview: null,
  };
}

/** 从 Blob/File 造一个条目（测试注入、拖放打开都走它）。 */
export function entryFromBlob(name, blob, extra = {}) {
  const sourceId = extra.sourceId || null;
  const rel = extra.rel || name;
  const fileLike = Object.assign(blob, {
    name,
    size: blob.size,
    lastModified: blob.lastModified || extra.lastModified || 0,
    slice: (a, b) => blob.slice(a, b),
  });

  const entry = entryFromFile({
    kind: 'file',
    name,
    rel,
    size: fileLike.size,
    lastModified: fileLike.lastModified,
    width: extra.width || 0,
    height: extra.height || 0,
    orientation: extra.orientation || 0,
    preview: extra.preview || null,
  }, sourceId);

  entry._fileCache = fileLike;   // 已经有字节了，不需要再读盘
  entry.file = fileLike;
  return entry;
}

/** 从 data URL 造一个「文件样」对象（RAW 内嵌预览的常见来源）。 */
export function fileFromDataUrl(name, dataUrl, lastModified = 0) {
  const bytes = dataUrlToBytes(dataUrl);
  if (!bytes) return null;
  const mime = /^data:([^;,]+)/.exec(dataUrl);
  return fileFromBytes(bytes, name, lastModified, mime ? mime[1] : 'application/octet-stream');
}

/** data URL -> Uint8Array（base64 与百分号编码都支持）。 */
export function dataUrlToBytes(dataUrl) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  if (comma < 0) return null;
  const head = s.slice(0, comma);
  const body = s.slice(comma + 1);

  if (!/;base64/i.test(head)) {
    try { return new TextEncoder().encode(decodeURIComponent(body)); } catch { return null; }
  }
  try {
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 计算 aspect（0 或负数一律当 1）。 */
export function aspectOf(width, height) {
  return width > 0 && height > 0 ? width / height : 1;
}

/**
 * 文件字节的来源抽象。
 *
 * 桌面端两种取字节的方式：
 *  1. 扫描阶段主进程已经抠出的内嵌预览（`entry.preview` 是 data URL）—— 优先，零读盘；
 *  2. 兜底：通过 `gkpv.readFile(sourceId, rel)` 向主进程要整份字节。
 *
 * 浏览器版用的是 `FileSystemFileHandle.getFile()`。为了两版共用同一套缩略图逻辑，
 * 这里把它归一成 `getBytes(entry) -> Uint8Array|null`，测试可以直接注入桩实现。
 */

/** @type {{readFile:(id:string, rel:string)=>Promise<{buffer?:ArrayBuffer}|null>}|null} */
let provider = null;

export function setFileProvider(p) {
  provider = p;
}

export function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (!/;base64/i.test(head)) {
    try {
      return new TextEncoder().encode(decodeURIComponent(body));
    } catch {
      return null;
    }
  }
  try {
    const bin = atob(body);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    return arr;
  } catch {
    return null;
  }
}

/** data URL 的 MIME。 */
export function dataUrlMime(dataUrl) {
  const m = /^data:([^;,]+)/.exec(String(dataUrl || ''));
  return m ? m[1] : 'application/octet-stream';
}

/**
 * 给 Blob 挂上原版代码要用的几样属性：`name` / `lastModified`。
 *
 * 两个坑，踩过一次：
 *  1. **不能用 Object.assign / 赋值**：`Blob.prototype.size` 只有 getter，赋值直接抛
 *     `TypeError: Cannot set property size of #<Blob> which has only a getter`；
 *     用 defineProperty 在自己的实例上建同名属性，读起来就是 Blob 的真实 size。
 *  2. **不能返回 Proxy 包装的对象**：`createImageBitmap` 对 Blob 做的是内部槽检查，
 *     Proxy 过不了；属性必须落在真正的 Blob 实例上。
 */
function decorateBlob(blob, name, lastModified) {
  Object.defineProperties(blob, {
    name: { value: name, writable: true, configurable: true, enumerable: false },
    lastModified: { value: lastModified || 0, writable: true, configurable: true, enumerable: false },
    // 原版读文件头是 `file.slice(0,N).arrayBuffer()`；Blob.slice 返回的是 Blob（本身就有
    // arrayBuffer），这里保持同形即可，不需要额外包一层。
    fileLike: { value: true, configurable: true, enumerable: false },
  });
  return blob;
}

/** 扫描阶段下发的内嵌预览（若有）转成 `file` 样对象，可直接喂给 createImageBitmap。 */
export function previewFileOf(entry) {
  if (!entry || !entry.preview) return null;
  const bytes = dataUrlToBytes(entry.preview);
  if (!bytes || !bytes.length) return null;
  const blob = new Blob([bytes], { type: dataUrlMime(entry.preview) });
  return decorateBlob(blob, entry.name, entry.lastModified);
}

/** @deprecated 保留旧名字，内部已改为直接在 Blob 上定义属性。 */
export function makeFileLike(name, size, lastModified) {
  return { name, size, lastModified: lastModified || 0 };
}

/** 用内存字节造一个 file 样对象（兼作 Blob 用）。 */
export function fileFromBytes(bytes, name, lastModified = 0, type = '') {
  const blob = new Blob([bytes], type ? { type } : undefined);
  decorateBlob(blob, name, lastModified);
  Object.defineProperty(blob, '_bytes', { value: bytes, configurable: true, enumerable: false });
  return blob;
}

/**
 * 取一份能交给解码器的 `file` 样对象。
 * @param {object} entry 目录条目（含 rel/name/size/lastModified/preview?）
 * @returns {Promise<object|null>}
 */
export async function getFileFor(entry) {
  if (!entry) return null;
  if (entry._fileCache) return entry._fileCache;

  // 顺序很重要：**先要整份字节，再退回内嵌预览**。
  // RAW 的 `entry.preview` 只是从容器里抠出来的一小段 JPEG，TIFF/EXIF 解析（readRawPreview、
  // parseExif）必须看到原容器；一旦先返回预览，RAW 的元数据解析会静默失败。
  if (provider) {
    const res = await provider.readFile(entry.sourceId || entry._sourceId, entry.rel);
    if (res && res.buffer) {
      const bytes = new Uint8Array(res.buffer);
      const f = fileFromBytes(bytes, entry.name, res.lastModified || entry.lastModified || 0, guessMime(entry.name));
      entry._fileCache = f;
      return f;
    }
  }

  // 兜底：扫描阶段已下发的内嵌预览（没有 provider 的宿主/单测走这条）
  const pv = previewFileOf(entry);
  if (pv) {
    entry._fileCache = pv;
    return pv;
  }
  return null;
}

/**
 * 扩展名 -> MIME。**必须导出**：`readRemote()`（app.js 的自检通道）也要用它，
 * 否则 Blob 没有类型，SVG 在 `<img>` 里解不出来（见 app.js readRemote 的注释）。
 */
export function guessMime(name) {
  const ext = String(name).slice(String(name).lastIndexOf('.') + 1).toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    bmp: 'image/bmp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml',
  };
  return map[ext] || '';
}

/**
 * 读文件的一段字节（RAW 内嵌预览按偏移取用）。
 * 优先用扫描阶段下发的前 256KB 头，避免再读盘。
 */
export async function readSliceFor(entry, offset, length) {
  if (entry._headBytes && offset + length <= entry._headBytes.length) {
    return entry._headBytes.slice(offset, offset + length);
  }
  const f = await getFileFor(entry);
  if (!f) return null;
  const part = await f.slice(offset, offset + length).arrayBuffer();
  return new Uint8Array(part);
}

/** 确保 entry 上有「前 256KB 头字节」可供 TIFF/EXIF 解析。 */
export async function ensureHeadBytes(entry, headSize = 262144) {
  if (entry._headBytes) return entry._headBytes;
  const f = await getFileFor(entry);
  if (!f) return null;
  try {
    const buf = await f.slice(0, Math.min(headSize, entry.size || headSize)).arrayBuffer();
    entry._headBytes = new Uint8Array(buf);
    return entry._headBytes;
  } catch {
    return null;
  }
}

export function clearFileCaches(entries) {
  for (const e of entries || []) {
    e._fileCache = null;
    e._headBytes = null;
  }
}

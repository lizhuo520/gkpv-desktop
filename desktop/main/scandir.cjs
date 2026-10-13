'use strict';

/**
 * 目录扫描 + 缩略图预览提取（Node 侧）。
 *
 * 与浏览器原版 `showDirectoryPicker()` 的语义对齐：
 *  - 递归模式：整棵子树，相对路径用 `/` 连接；非递归模式：一层。
 *  - 目录本身不作为条目返回，而是聚合成一个"文件夹预览"条目（name + childCount + preview）。
 *  - 每个图片条目带 size / lastModified（缓存键的一部分）、width / height、preview（内嵌预览 data URL）。
 *  - 隐藏项（`.` 开头）与已知系统噪声目录（`$RECYCLE.BIN`、`System Volume Information`）跳过。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'avif', 'svg', 'ico', 'tiff', 'tif', 'heic', 'heif',
  // RAW 家族
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'raw', 'dng',
  'pef', 'srw', 'x3f', 'erf', 'mrw', 'kdc', 'dcr', 'iiq', '3fr', 'fff', 'mef', 'mos', 'rwl',
]);

const HIDDEN_DIRS = new Set(['$recycle.bin', 'system volume information', 'recycler', '.git', 'node_modules']);

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024; // 只扫前 2MB 找内嵌预览，避免大 RAW 全盘读取
const PREVIEW_SCAN_LIMIT = 8 * 1024 * 1024;
const MAX_DIM_PROBE_BYTES = 512 * 1024;

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

function isImageName(name) {
  return IMAGE_EXTS.has(extOf(name));
}

function isHiddenName(name) {
  return name.startsWith('.');
}

/* ------------------------------------------------------------------ *
 * 尺寸解析（与 renderer/lib/image-format.js 保持同一判定顺序）
 * ------------------------------------------------------------------ */

function scanChunks(buf, wantOffset) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
  }
  // JPEG：扫到 SOFn（排除 C4=DHT / C8=JPG / CC=DAC），顺路取 APP1 的 Orientation。
  //
  // 这段是必须有的：RAW / HEIC 的内嵌预览就是一张 JPEG，尺寸提取出来后要拿它
  // 定宽高比；早先这里漏了 JPEG 分支，于是 readEmbeddedPreview 明明返回了字节，
  // 调用方 scanChunks 却给 null，缩略图只能退回全解码。已被单测钉住。
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const jpg = scanJpegSize(buf);
    if (jpg) return jpg;
  }
  const riff = buf.toString('latin1', 0, 4);
  if (riff === 'RIFF') {
    const kind = buf.toString('latin1', 8, 12);
    if (kind === 'WEBP') {
      const fourcc = buf.toString('latin1', 12, 16);
      if (fourcc === 'VP8X') {
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width: w, height: h };
      }
      if (fourcc === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  }
  // TIFF 家族（含 RAW / DNG / HEIC 内的 EXIF）：枚举 IFD0 与后续 IFD1，取最大面积
  const tiff = parseTiffSizes(buf);
  if (tiff) return tiff;
  // 故意不解析 SVG：SVG 没有「解码尺寸」，只有渲染层拿到的实际像素尺寸
  // （HTMLImageElement.naturalWidth/naturalHeight）才算数。网页版就是这么做的
  // （gkpv.html 第 844-845 行：`isSvgName(file.name) → return null`）。
  //
  // 曾经这里读过 width/height 属性、并在缺失时兜底 viewBox —— 那是错的：
  // 实测只有 viewBox 的 SVG，Chromium 报 300x150（默认视口），不是 viewBox 的 100x50。
  // 按 viewBox 猜宽高会让 Node 侧与渲染层给出两套不同的网格宽高比。
  return null;
}

/**
 * JPEG 像素尺寸 + 方向。
 * 与 `desktop/renderer/lib/image-format.js` 的 JPEG 分支保持同一判定顺序：
 * 逐个 marker 走，遇到 APP1 就试着读 Exif 的 Orientation(0x0112)，
 * 遇到 SOFn 就算宽高（Orientation 5~8 时互换，让返回值是「显示尺寸」）。
 */
function scanJpegSize(buf) {
  const n = buf.length;
  let i = 2;
  let orientation = 0;
  while (i < n - 9) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const m = buf[i + 1];
    if (m === 0xff) { i += 1; continue; }
    if (m >= 0xd0 && m <= 0xd9) { i += 2; continue; }
    if (m === 0xe1 && !orientation) {
      const p = i + 4;
      // 'Exif\0\0' 之后才是 TIFF 头；缩略图也可能带 APP1，所以只在还没取到时试
      if (p + 8 <= n && buf.readUInt32BE(p) === 0x45786966 && buf.readUInt16BE(p + 4) === 0) {
        orientation = readTiffOrientationOf(buf, p + 6);
      }
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      let h = buf.readUInt16BE(i + 5);
      let w = buf.readUInt16BE(i + 7);
      if (orientation >= 5 && orientation <= 8) { const t = w; w = h; h = t; }
      return { width: w, height: h, orientation: orientation || 1 };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** 读 TIFF 头的 IFD0 Orientation(0x0112)，取不到返回 0。 */
function readTiffOrientationOf(buf, t) {
  if (t + 8 > buf.length) return 0;
  const bo = buf.readUInt16BE(t);
  const le = bo === 0x4949;
  if (!le && bo !== 0x4d4d) return 0;
  const rd16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const rd32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = rd32(t + 4);
  if (t + ifd + 2 > buf.length) return 0;
  const cnt = rd16(t + ifd);
  for (let i = 0; i < cnt; i += 1) {
    const p = t + ifd + 2 + i * 12;
    if (p + 12 > buf.length) break;
    if (rd16(p) === 0x0112) {
      const v = rd16(p + 8);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}

function parseTiffSizes(buf) {
  let base = 0;
  const le = buf[0] === 0x49 && buf[1] === 0x49;
  const be = buf[0] === 0x4d && buf[1] === 0x4d;
  if (!le && !be) {
    const off = findExifTiffOffset(buf);
    if (off < 0) return null;
    base = off;
  }
  if (base + 8 > buf.length) return null;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const magic = u16(base + 2);
  if (magic !== 42 && magic !== 0x4f52 && magic !== 0x5352) return null;

  let best = null;
  let orientation = 0;
  // 找尺寸不能只看 IFD0：真实 RAW 有两种常见形状，本文件的 fixture 两种都造了 ——
  //   1) 宽高在 SubIFD(0x014A) 指向的 IFD 里，IFD0 自己只有 0x0100/0x0101 之外的元数据；
  //   2) EXIF IFD(0x8769) 里有 PixelXDimension(0xA002)/PixelYDimension(0xA003)。
  // 所以这里把 IFD0 → next 链 → SubIFD 全走一遍，取面积最大的那组（RAW 的
  // 全尺寸图 = 最大的 SubIFD，缩略图 SubIFD 自然被淘汰）。
  //
  // 教训：这里原先只走 IFD0 的 next 链，「IFD0 抽不到宽高就返回 null」，
  // 结果 5 张 RAW fixture（宽高只存在于 SubIFD）全部解析失败，
  // 而 web 版的 parseTiffSizes 有同样缺陷 —— 说明真实 RAW 的尺寸解析本来就是漏的。
  const visited = new Set();
  const queue = [u32(base + 4)];
  while (queue.length && visited.size < 16) {
    const ifdOff = queue.shift();
    if (!(ifdOff > 0) || ifdOff >= buf.length - 2) continue;
    if (visited.has(ifdOff)) continue;
    visited.add(ifdOff);
    const count = u16(base + ifdOff);
    // count 上限：正常 IFD 不会有几百项，超过就是偏移算错了，别顺着读下去
    if (count === 0 || count > 4096) continue;
    if (base + ifdOff + 2 + count * 12 > buf.length) continue;
    let w = 0;
    let h = 0;
    for (let i = 0; i < count; i += 1) {
      const e = base + ifdOff + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      const valueField = e + 8;
      let v = 0;
      if (type === 3) v = u16(valueField);
      else if (type === 4) v = u32(valueField);
      if (tag === 0x0100) w = v;
      else if (tag === 0x0101) h = v;
      // EXIF IFD 里的 PixelXDimension / PixelYDimension：部分 RAW（与手机 JPEG）
      // 只在这里写全尺寸，IFD0 与 SubIFD 都没有可比对的值
      else if (tag === 0xa002 && w === 0) w = v;
      else if (tag === 0xa003 && h === 0) h = v;
      else if (tag === 0x0112 && !orientation) orientation = v >= 1 && v <= 8 ? v : 0;
      if (tag === 0x014a && (type === 4 || type === 3)) {
        // SubIFDs：单个 LONG，或 LONG 数组（数组时 n 个偏移存在 valueField 指向的数据区）
        const cnt = Math.min(n || 1, 8);
        if (cnt === 1 && type === 4) {
          if (v > 0) queue.push(v);
        } else {
          const at = type === 4 ? valueField : v;
          if (at > 0 && at + cnt * 4 <= buf.length) {
            for (let k = 0; k < cnt; k += 1) {
              const s = u32(at + k * 4);
              if (s > 0) queue.push(s);
            }
          }
        }
      }
      if (tag === 0x8769 && type === 4 && v > 0) queue.push(v);   // EXIF IFD
    }
    if (w > 0 && h > 0) {
      const area = w * h;
      if (!best || area > best.area) best = { width: w, height: h, area };
    }
    const nextOff = base + ifdOff + 2 + count * 12;
    if (nextOff + 4 <= buf.length) {
      const next = u32(nextOff);
      // next 必须是「向后的、base 相对的偏移」；这里也顺手挡掉自指死循环
      if (next > ifdOff && base + next < buf.length) queue.push(next);
    }
  }
  if (!best) return null;
  // Orientation 5~8 = 需要转 90°，显示尺寸与容器里存的宽高是反的。
  // 这里必须跟着换算：否则竖拍 RAW 的宽高比会与解码结果互为倒数，
  // 磁贴全部走全解码慢路径（网页版当年就是这个症状）。
  let { width, height } = best;
  if (orientation >= 5 && orientation <= 8) { const t = width; width = height; height = t; }
  return { width, height, orientation: orientation || 1 };
}

function findExifTiffOffset(buf) {
  // ISO-BMFF（HEIC/HEIF）：找 'Exif' box，其后 4 字节为 TIFF 头偏移
  const idx = buf.indexOf('Exif', 0, 'latin1');
  if (idx > 0 && idx + 12 < buf.length) {
    const tiffRel = buf.readUInt32BE(idx + 8);
    const start = idx + 4 + tiffRel;
    if (start >= 0 && start + 8 <= buf.length) return start;
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * 内嵌 JPEG 预览提取
 * ------------------------------------------------------------------ */

function extractJPEGFrom(buf, start) {
  // 在 buf[start..] 里找第一个完整的 JPEG（SOI..EOI）
  let i = start;
  while (i < buf.length - 1) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8) {
      let j = i + 2;
      while (j < buf.length - 1) {
        if (buf[j] === 0xff && buf[j + 1] === 0xd9) return buf.subarray(i, j + 2);
        j += 1;
      }
      return null;
    }
    i += 1;
  }
  return null;
}

/**
 * 从文件头部提取内嵌预览（JPEG）或直接返回原图（JPEG/PNG 等）。
 * @returns {Promise<{mime:string, data:Buffer, bytes:number, embedded:boolean}|null>}
 */
async function readEmbeddedPreview(filePath, ext) {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const stat = await fh.stat();
    const direct = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'avif', 'ico', 'svg']);
    if (direct.has(ext)) {
      const take = Math.min(stat.size, MAX_PREVIEW_BYTES);
      const buf = Buffer.alloc(take);
      await fh.read(buf, 0, take, 0);
      return { mime: mimeOfExt(ext), data: buf, bytes: take, embedded: true };
    }
    // RAW / HEIC：抓内嵌 JPEG
    const take = Math.min(stat.size, PREVIEW_SCAN_LIMIT);
    const buf = Buffer.alloc(take);
    await fh.read(buf, 0, take, 0);
    const jpg = extractJPEGFrom(buf, 0);
    if (!jpg) return null;
    const data = Buffer.from(jpg);
    return { mime: 'image/jpeg', data, bytes: data.length, embedded: false };
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

function mimeOfExt(ext) {
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    bmp: 'image/bmp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml',
  };
  return map[ext] || 'image/jpeg';
}

async function readDimensions(filePath, ext, fallbackBuffer) {
  if (fallbackBuffer) {
    const got = scanChunks(fallbackBuffer);
    if (got && got.width > 0 && got.height > 0) return got;
  }
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
  } catch {
    return { width: 0, height: 0 };
  }
  try {
    const stat = await fh.stat();
    const take = Math.min(stat.size, MAX_DIM_PROBE_BYTES);
    const buf = Buffer.alloc(take);
    await fh.read(buf, 0, take, 0);
    const got = scanChunks(buf);
    if (got && got.width > 0 && got.height > 0) return got;
    return { width: 0, height: 0 };
  } catch {
    return { width: 0, height: 0 };
  } finally {
    await fh.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

async function listDir(absDir, recursive, rootDir) {
  const entries = [];
  const dirs = [];

  let items;
  try {
    items = await fs.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    return { entries, dirs, error: `${err.code || 'ERR'}: ${absDir}` };
  }

  for (const item of items) {
    const name = item.name;
    if (isHiddenName(name)) continue;
    const abs = path.join(absDir, name);
    if (item.isDirectory()) {
      if (HIDDEN_DIRS.has(name.toLowerCase())) continue;
      dirs.push({ name, abs });
      continue;
    }
    if (!item.isFile() || !isImageName(name)) continue;
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    const rel = path.relative(rootDir, abs).split(path.sep).join('/');
    entries.push({
      rel,
      name,
      size: stat.size,
      // 必须是**整数**毫秒：这个值是缓存键的一部分，而浏览器版 File System Access API
      // 给的 lastModified 就是整数。fs.stat().mtimeMs 带小数（如 1791843594493.8113），
      // 直接下发会让桌面版的缓存键与网页版永不相等，缓存永远命中不了。
      lastModified: Math.floor(stat.mtimeMs),
      _abs: abs,
      _ext: extOf(name),
    });
  }

  return { entries, dirs };
}

/**
 * 扫描目录，产出与浏览器版 `walkDirectory()` 等价的数据结构。
 * @param {string} rootDir 绝对路径（已由主进程校验）
 * @param {boolean} recursive
 * @param {(done:number,total:number,rel:string)=>void} [onProgress]
 */
async function scanDirectory(rootDir, recursive, onProgress) {
  const files = [];
  const folderMap = new Map();

  const seen = new Set();
  async function walk(dirAbs) {
    if (seen.has(dirAbs)) return { count: 0 };
    seen.add(dirAbs);
    const { entries, dirs, error } = await listDir(dirAbs, recursive, rootDir);
    let own = 0;
    if (error) return { count: own, error };

    for (const e of entries) {
      const dirRel = path.relative(rootDir, path.dirname(e._abs)).split(path.sep).join('/');
      if (dirRel) {
        const bucket = folderMap.get(dirRel) || [];
        bucket.push(e.rel);
        folderMap.set(dirRel, bucket);
      }
      files.push(e);
      own += 1;
      if (onProgress) onProgress(files.length, files.length, e.rel);
    }

    if (recursive) {
      for (const d of dirs) {
        const sub = await walk(d.abs);
        own += sub.count || 0;
        const rel = path.relative(rootDir, d.abs).split(path.sep).join('/');
        folderMap.set(rel, folderMap.get(rel) || []);
      }
    } else {
      for (const d of dirs) {
        const rel = path.relative(rootDir, d.abs).split(path.sep).join('/');
        folderMap.set(rel, folderMap.get(rel) || []);
      }
    }
    return { count: own };
  }

  await walk(rootDir);
  return { files, folderMap };
}

module.exports = {
  IMAGE_EXTS,
  extOf,
  isImageName,
  isHiddenName,
  scanChunks,
  readEmbeddedPreview,
  readDimensions,
  scanDirectory,
  mimeOfExt,
};

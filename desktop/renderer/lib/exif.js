/**
 * EXIF 解析：JPEG 的 APP1 与 RAW 容器（本身就是 TIFF）共用一份 TIFF 读取实现。
 * 与浏览器版 `parseExif()` 逐字段等价，多出来的只是把结果结构化成对象，
 * 这样缩略图信息面板、诊断导出、单测都能复用同一份数据。
 */

import { isRawName, extOf } from './format.js';
import { RAW_HEAD } from './raw.js';
import { ensureHeadBytes } from './source.js';
import { state } from './state.js';

export function exifCacheKey(entry) {
  return `${entry.name}_${entry.size}_${entry.lastModified}`;
}

/**
 * 尼康的镜头规格不在 ExifIFD（它连 LensModel 0xA434 都没有），而是藏在 MakerNote 的 0x0084：
 * 'Nikon\0' + 版本(2B) + 内嵌 TIFF 头，IFD0 的 0x0084 = 4 个 RATIONAL
 * （最短焦距、最长焦距、两端最大光圈）。结构任何一处不符就返回 null ——
 * 宁可不显示，也不能把错误的镜头名显示给用户。
 */
export function readNikonLens(view, off, len) {
  try {
    if (len < 18) return null;
    const sig = String.fromCharCode(
      view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2),
      view.getUint8(off + 3), view.getUint8(off + 4), view.getUint8(off + 5),
    );
    if (sig !== 'Nikon\0') return null;
    const t = off + 10;                                  // 内嵌 TIFF 头的绝对偏移
    const bo = view.getUint8(t);
    if (bo !== 0x49 && bo !== 0x4d) return null;
    const le = bo === 0x49;
    if (view.getUint16(t + 2, le) !== 0x2a) return null;
    const end = off + len;
    const ifd = t + view.getUint32(t + 4, le);
    if (ifd + 2 > end) return null;
    const cnt = view.getUint16(ifd, le);
    for (let i = 0; i < cnt; i += 1) {
      const p = ifd + 2 + i * 12;
      if (p + 12 > end) return null;
      if (view.getUint16(p, le) === 0x0084) {
        // 必须是 RATIONAL x4
        if (view.getUint16(p + 2, le) !== 5 || view.getUint32(p + 4, le) < 4) return null;
        const vo = t + view.getUint32(p + 8, le);
        if (vo + 32 > end) return null;
        const rat = (o) => {
          const num = view.getUint32(o, le);
          const den = view.getUint32(o + 4, le);
          return den ? num / den : 0;
        };
        const fMin = rat(vo);
        const fMax = rat(vo + 8);
        const aMin = rat(vo + 16);
        const aMax = rat(vo + 24);
        // 合理性检查：焦距 4~2000mm、光圈 f/0.7~f/64，且范围的两端不能颠倒
        if (!(fMin >= 4 && fMax >= fMin && fMax <= 2000 && aMin >= 0.7 && aMax >= aMin && aMax <= 64)) return null;
        const focal = fMin === fMax ? `${Math.round(fMin)}mm` : `${Math.round(fMin)}-${Math.round(fMax)}mm`;
        const apt = Math.abs(aMin - aMax) < 0.05
          ? `f/${+aMin.toFixed(1)}`
          : `f/${+aMin.toFixed(1)}-${+aMax.toFixed(1)}`;
        return `${focal} ${apt}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 解析一段 TIFF 结构里的 EXIF（tiffStart 指向 II/MM 标志）。
 * @param {DataView} view
 * @param {number} byteLength
 * @param {number} tiffStart
 * @returns {object|null}
 */
export function readExifTags(view, byteLength, tiffStart) {
  const bo = view.getUint16(tiffStart);
  const le = bo === 0x4949;
  if (!le && bo !== 0x4d4d) return null;
  const g16 = (o) => view.getUint16(tiffStart + o, le);
  const g32 = (o) => view.getUint32(tiffStart + o, le);
  const firstIFD = g32(4);
  let makerNoteOff = 0;
  let makerNoteLen = 0;                       // MakerNote(0x927C) 在缓冲区里的绝对位置

  function readTagValue(type, count, valueOffset) {
    if (type === 2) {                         // ASCII
      let s = '';
      const maxLen = Math.min(count - 1, byteLength - (tiffStart + valueOffset));
      for (let i = 0; i < maxLen; i += 1) s += String.fromCharCode(view.getUint8(tiffStart + valueOffset + i));
      return s.trim();
    }
    if (type === 3) return g16(valueOffset);  // SHORT
    if (type === 4) return g32(valueOffset);  // LONG
    if (type === 5) {                         // RATIONAL
      const num = g32(valueOffset);
      const den = g32(valueOffset + 4);
      return den ? num / den : 0;
    }
    return null;
  }

  function readIFD(ifdOffset) {
    const entries = {};
    const count = g16(ifdOffset);
    for (let i = 0; i < count; i += 1) {
      const eo = ifdOffset + 2 + i * 12;
      if (tiffStart + eo + 12 > byteLength) break;
      const tag = g16(eo);
      const type = g16(eo + 2);
      const cnt = g32(eo + 4);
      // 完整的类型长度表：漏掉 7(UNDEFINED)/10(SRATIONAL) 会把 MakerNote 这类
      // 「大块数据」的偏移算成内联值，导致整段解析全错
      const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 }[type] || 0;
      let vo;
      if (typeSize * cnt <= 4) vo = eo + 8;
      else vo = g32(eo + 8);
      if (tiffStart + vo + typeSize * cnt > byteLength) continue;
      if (tag === 0x927c && type === 7 && cnt > 0 && tiffStart + vo + cnt <= byteLength) {
        makerNoteOff = tiffStart + vo;
        makerNoteLen = cnt;
      }
      entries[tag] = readTagValue(type, cnt, vo);
    }
    return entries;
  }

  const ifd0 = readIFD(firstIFD);
  const tags = {};
  tags.Make = ifd0[0x010f] || '';
  tags.Model = ifd0[0x0110] || '';
  const o = ifd0[0x0112];
  if (typeof o === 'number' && o >= 1 && o <= 8) tags.Orientation = o;
  let exifIFD = null;
  if (ifd0[0x8769]) exifIFD = readIFD(ifd0[0x8769]);
  if (exifIFD) {
    tags.ExposureTime = exifIFD[0x829a];
    tags.FNumber = exifIFD[0x829d];
    tags.ISO = exifIFD[0x8827];
    tags.DateTimeOriginal = exifIFD[0x9003];
    tags.FocalLength = exifIFD[0x920a];
    tags.LensModel = exifIFD[0xa434];
    tags.PixelXDimension = exifIFD[0xa002];
    tags.PixelYDimension = exifIFD[0xa003];
  }
  // 尼康只有 MakerNote 里有镜头规格，补上（其它品牌在 0xA434，上面已经读到）
  if (!tags.LensModel && makerNoteOff) {
    const lens = readNikonLens(view, makerNoteOff, makerNoteLen);
    if (lens) tags.LensModel = lens;
  }
  tags_MakerNoteSeen(makerNoteOff);
  return tags;
}

let makerNoteSeen = false;
function tags_MakerNoteSeen(off) {
  if (off) makerNoteSeen = true;
}
export function makerNoteWasSeen() {
  return makerNoteSeen;
}

/**
 * 从原始字节解析 EXIF。
 * - RAW 容器本身就是 TIFF（CR2/NEF/ARW/DNG...）：直接从头部的 IFD0 + ExifIFD 里读。
 *   实测尼康/索尼的 ExifIFD 都落在文件头 256KB 内，够用；CR3 不是 TIFF 容器，读不到。
 * - JPEG：扫 APP1 段。
 */
export function parseExifBytes(bytes, ext, mime) {
  try {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!b.length) return null;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);

    if (isRawName(`x.${ext}`)) {
      const isTiff = (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00)
        || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a);
      if (!isTiff) return null;
      return readExifTags(view, b.length, 0);
    }

    const looksJpeg = (mime && String(mime).includes('jpeg')) || /^jpe?g$/i.test(ext);
    if (!looksJpeg) return null;
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
    let offset = 2;
    while (offset < view.byteLength - 4) {
      const marker = view.getUint16(offset);
      if (marker === 0xffe1) {                                  // APP1
        const exifStart = offset + 4;
        if (view.getUint32(exifStart) !== 0x45786966 || view.getUint16(exifStart + 4) !== 0x0000) return null;
        return readExifTags(view, b.length, exifStart + 6);
      }
      if ((marker & 0xff00) !== 0xff00) break;
      offset += 2 + view.getUint16(offset + 2);
    }
    return null;
  } catch {
    return null;
  }
}

/** 带缓存的条目级解析（缓存按 name_size_lastModified 归一，与浏览器版一致）。 */
export async function parseExif(entry) {
  const key = exifCacheKey(entry);
  if (state.exifCache.has(key)) return state.exifCache.get(key);
  const result = await readExifFor(entry);
  state.exifCache.set(key, result);
  return result;
}

async function readExifFor(entry) {
  if (!entry) return null;
  const ext = extOf(entry.name);
  const buf = isRawName(entry.name)
    ? await ensureHeadBytes(entry, RAW_HEAD)
    : await ensureHeadBytes(entry, 65536);
  if (!buf) return null;
  return parseExifBytes(buf, ext, entry._fileCache ? entry._fileCache.type : '');
}

/* ------------------------------------------------------------------ *
 * 展示格式化
 * ------------------------------------------------------------------ */

export function formatShutter(v) {
  if (!v) return null;
  if (v >= 1) return `${v}s`;
  return `1/${Math.round(1 / v)}s`;
}

export function formatAperture(v) {
  return v ? `f/${v.toFixed(1)}` : null;
}

export function formatFocalLength(v) {
  return v ? `${Math.round(v)}mm` : null;
}

/** EXIF Orientation(0x0112) -> 中文说明（1 = 不需要任何变换）。 */
export function formatOrientation(o) {
  switch (o) {
    case 2: return '水平镜像';
    case 3: return '旋转 180°';
    case 4: return '垂直镜像';
    case 5: return '沿对角线镜像';
    case 6: return '顺时针旋转 90°';
    case 7: return '镜像后旋转 90°';
    case 8: return '逆时针旋转 90°';
    default: return '';
  }
}

/** 把 EXIF 拍平成「拍摄参数」一行。 */
export function formatShootingSettings(exif) {
  if (!exif) return '';
  return [
    formatFocalLength(exif.FocalLength),
    formatAperture(exif.FNumber),
    formatShutter(exif.ExposureTime),
    exif.ISO ? `ISO ${exif.ISO}` : null,
  ].filter(Boolean).join('  ');
}

/** 相机制造商 + 型号（去重：索尼会写两遍 "SONY"）。 */
export function formatCamera(exif) {
  if (!exif) return '';
  const make = (exif.Make || '').trim();
  const model = (exif.Model || '').trim();
  if (!make) return model;
  if (!model) return make;
  return model.toUpperCase().startsWith(make.toUpperCase()) ? model : `${make} ${model}`;
}

export function clearExifCache() {
  state.exifCache.clear();
  makerNoteSeen = false;
}

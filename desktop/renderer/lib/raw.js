/**
 * 相机 RAW：从 TIFF 容器里抠出内嵌 JPEG 预览。
 *
 * 主流 RAW（CR2/NEF/ARW/DNG/RAF/ORF/RW2...）都是 TIFF 结构，IFD0 里的
 * ThumbOffset(0x0201)/ThumbLength(0x0202) 指向相机内嵌的 JPEG。
 * 直接 slice 出来给浏览器解码，不用 demosaic、不用 WASM。
 * 拿不到就返回 null，调用方照原样处理 —— 不会让现有格式变差。
 *
 * 桌面端差异：文件字节由主进程通过 `gkpv.readFile()` 提供（扫描阶段已附带
 * `previewUrl` 的条目会直接命中缓存，不会重复读盘）。
 */

import { isRawName } from './format.js';
import { readImageSize } from './image-format.js';
import { bytesAsFile } from './fmt.js';

/** 256 KB 足够覆盖 IFD0/ExifIFD/SubIFD。 */
export const RAW_HEAD = 262144;

/** @type {Map<string, {blob:Blob,w:number,h:number,orient:number}|null>} */
const rawPreviewCache = new Map();

export function rawPreviewKey(entry) {
  return `${entry.rel}\u0000${entry.size}\u0000${entry.lastModified}`;
}

function parseTiffPreview(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = buf.length;
  if (n < 16) return null;

  let le = null;
  if (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) le = true;
  else if (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a) le = false;
  else return null;

  // 按 TIFF 类型取值：SHORT(type=3) 只占前 2 字节，不能整 4 字节读
  const scan = (off) => {
    const out = {};
    if (off + 2 > n) return out;
    const cnt = dv.getUint16(off, le);
    for (let i = 0; i < cnt; i += 1) {
      const p = off + 2 + i * 12;
      if (p + 12 > n) break;
      const tag = dv.getUint16(p, le);
      const typ = dv.getUint16(p + 2, le);
      const c = dv.getUint32(p + 4, le);
      out[tag] = { typ, cnt: c, v: typ === 3 ? dv.getUint16(p + 8, le) : dv.getUint32(p + 8, le) };
    }
    return out;
  };

  const t0 = scan(dv.getUint32(4, le));

  // SubIFDs 可能是数组（尼康 cnt=3），也可能只有 1 个
  const subIfdOffsets = () => {
    const s = t0[0x014a];
    if (!s) return [];
    if (s.cnt > 1) {
      const base = s.v;
      const out = [];
      for (let i = 0; i < s.cnt; i += 1) {
        if (base + 4 * s.cnt > n) break;
        out.push(dv.getUint32(base + 4 * i, le));
      }
      return out;
    }
    return [s.v];
  };
  const subs = subIfdOffsets().map(scan);

  // 收集所有 JPEG 预览候选（IFD0 + 每个 SubIFD）
  const cands = [];
  for (const e of [t0, ...subs]) {
    const o = e[0x0201];
    const l = e[0x0202];
    if (o && l && o.v > 0 && l.v > 0) cands.push([o.v, l.v]);
  }

  // 相机全分辨率尺寸：ExifIFD 优先，其次 SubIFD 里最大的，再其次 IFD0。
  // 这三处记的都是「传感器朝向」的尺寸（实测尼康 7424x4924、索尼 7952x5304
  // 都跟着方向 8 一起以横版出现），要按 IFD0 的方向换算才是显示尺寸。
  let sw = 0;
  let sh = 0;
  if (t0[0x8769]) {
    const ex = scan(t0[0x8769].v);
    if (ex[0xa002] && ex[0xa003] && ex[0xa002].v > 0 && ex[0xa003].v > 0) {
      sw = ex[0xa002].v;
      sh = ex[0xa003].v;
    }
  }
  if (!(sw > 0 && sh > 0)) {
    for (const e of subs) {
      const iw = e[0x0100];
      const ih = e[0x0101];
      if (iw && ih && iw.v > sw && ih.v > 0) { sw = iw.v; sh = ih.v; }
    }
  }
  if (!(sw > 0 && sh > 0) && t0[0x0100] && t0[0x0101]) { sw = t0[0x0100].v; sh = t0[0x0101].v; }

  // IFD0 的 Orientation(0x0112)：相机的「意图方向」，5~8 表示要转 90°
  const orientation = t0[0x0112] && t0[0x0112].v >= 1 && t0[0x0112].v <= 8 ? t0[0x0112].v : 1;

  // 选长度最小的候选。尼康会同时给出全尺寸(2.4MB)和预览(1MB)，
  // 做 640px 缩略图用小的那个就够了。
  cands.sort((a, b) => a[1] - b[1]);
  let chosen = null;
  for (const c of cands) {
    if (c[1] > 8192 && c[1] <= 16 * 1024 * 1024) { chosen = c; break; }
  }
  if (!chosen) return null;

  return { offset: chosen[0], length: chosen[1], orientation, sensorW: sw, sensorH: sh };
}

/**
 * 读 RAW 内嵌预览。
 * @param {{rel:string,size:number,lastModified:number,name:string,previewOnly?:boolean}} entry
 * @param {Uint8Array} headerBytes 文件头 256KB（扫描阶段已随条目下发，或按需读取）
 * @param {(offset:number,length:number)=>Promise<Uint8Array>} readSlice 读任意片段
 */
export async function readRawPreview(entry, headerBytes, readSlice) {
  const key = rawPreviewKey(entry);
  if (rawPreviewCache.has(key)) return rawPreviewCache.get(key);
  const res = await buildRawPreview(entry, headerBytes, readSlice);
  rawPreviewCache.set(key, res);
  return res;
}

export function clearRawPreviewCache() {
  rawPreviewCache.clear();
}

async function buildRawPreview(entry, headerBytes, readSlice) {
  try {
    const meta = parseTiffPreview(headerBytes);
    if (!meta) return null;

    const bytes = await readSlice(meta.offset, meta.length);
    // 必须是 JPEG 才能交给浏览器解码
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

    // 预览图自己的尺寸与方向（直接解析刚取出来的字节，不用再读盘）。
    // o > 1 表示这段预览是「自描述」的：浏览器解码时会自己转正，我们不能再转第二次
    const psz = await readImageSize(bytesAsFile(bytes, 'preview.jpg'));
    const previewOriented = !!(psz && psz.o > 1);

    // 需要我们自己补的旋转：只有预览没写方向（实测尼康/索尼都不写）时才按 IFD0 的方向转
    const orient = !previewOriented && meta.orientation >= 5 && meta.orientation <= 8 ? meta.orientation : 1;

    // 显示尺寸：优先用相机全分辨率（信息面板更好看），但必须和预览像素的实际比例一致；
    // 对不上（>2%）说明这个尺寸的语义不可信，就以预览实际像素为准 —— 布局不会因此排错
    let w = 0;
    let h = 0;
    if (meta.sensorW > 0 && meta.sensorH > 0) {
      w = meta.orientation >= 5 ? meta.sensorH : meta.sensorW;
      h = meta.orientation >= 5 ? meta.sensorW : meta.sensorH;
    }
    if (psz && psz.w > 0 && psz.h > 0) {
      let bw = psz.w;
      let bh = psz.h;                                          // 浏览器解码预览后的像素尺寸
      if (orient >= 5) { const t = bw; bw = bh; bh = t; }      // 我们再转 90° 之后
      if (!(w > 0 && h > 0) || Math.abs(w / h - bw / bh) / (bh ? bw / bh : 1) > 0.02) { w = bw; h = bh; }
    }
    if (!(w > 0 && h > 0)) return null;

    return { blob: new Blob([bytes], { type: 'image/jpeg' }), w, h, orient, bytes: bytes.length };
  } catch {
    return null;
  }
}

/**
 * 从扫描阶段随条目下发的内嵌预览 data URL 直接构造结果（不读盘）。
 * 主进程已经把 RAW 的内嵌 JPEG 抠出来了，容器方向（IFD0 的 0x0112）也随扫描下发在
 * entry.orientation 上：内嵌预览自己不带方向标记，竖拍（5~8）只能靠它补转 90°。
 *
 * 只有 5~8 才转 —— 与下面读盘路径（readRawPreview 里的 orient 判定）和网页版
 * gkpv.html:1089 完全一致；2/3/4（镜像/180°）目前两条路径都不处理，是已知缺口。
 */
export function previewFromDataUrl(entry) {
  if (!entry || !entry.preview) return null;
  const o = Number(entry.orientation) || 0;
  return {
    blob: dataUrlToBlob(entry.preview),
    w: entry.width || 0,
    h: entry.height || 0,
    orient: o >= 5 && o <= 8 ? o : 1,
    fromScan: true,
  };
}

/** data URL -> Blob（避免再走一次 fetch(dataURL)）。 */
export function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mime = (head.match(/^data:([^;]+)/) || [, 'application/octet-stream'])[1];
  if (/;base64/i.test(head)) {
    const bin = atob(body);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

export { isRawName };

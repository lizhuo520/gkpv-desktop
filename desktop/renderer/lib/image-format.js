/**
 * 只读文件头拿像素尺寸（不解码整图，便宜得多）。
 *
 * 返回的 w/h 是「显示尺寸」：JPEG 若带 Orientation(0x0112)=5~8，宽高已经互换过，
 * 这样算出来的宽高比才与实际解码结果、以及 <img> 的朝向一致（见 readTiffOrientation）。
 * 拿不到就返回 null，调用方回退到全图解码，保证不会比原来更差。
 */

import { isNoDecodeName, isSvgName } from './format.js';

/** 头部读取长度：256 KB 足够覆盖 SOF/IHDR 等头部。 */
export const HEAD_BYTES = 262144;

/** 与 node 侧 scandir.cjs 共享同一套判定逻辑（测试做交叉校验）。 */
export function scanHeaderBytes(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = buf.length;
  if (n < 4) return null;

  // PNG：IHDR 固定在第 16 字节
  if (n > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
  }
  // GIF
  if (n > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
  }
  // BMP
  if (n > 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { w: dv.getInt32(18, true), h: Math.abs(dv.getInt32(22, true)) };
  }
  // WebP
  if (n > 30 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    const fmt = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
    if (fmt === 'VP8X') {
      return {
        w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      };
    }
    if (fmt === 'VP8 ') {
      return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
    }
    if (fmt === 'VP8L') {
      const b0 = buf[21];
      const b1 = buf[22];
      const b2 = buf[23];
      const b3 = buf[24];
      return {
        w: 1 + (((b1 & 0x3f) << 8) | b0),
        h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
  }
  // JPEG：逐个 marker 扫到 SOFn（排除 C4=DHT / C8=JPG / CC=DAC）
  // 顺路取 APP1 里的 Orientation(0x0112)：同一个 256KB 头里就能拿到，不用再读一次盘
  if (n > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    let orientation = 0;
    while (i < n - 9) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i += 1; continue; }
      if (m >= 0xd0 && m <= 0xd9) { i += 2; continue; }        // 无长度字段的 marker
      if (m === 0xe1 && !orientation) {
        // APP1：「Exif\0\0」之后就是 TIFF 头（可能是缩略图的 APP1，所以只在没取到时试）
        const p = i + 4;
        if (p + 8 <= n && dv.getUint32(p) === 0x45786966 && dv.getUint16(p + 4) === 0) {
          orientation = readTiffOrientation(dv, n, p + 6);
        }
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        let h = dv.getUint16(i + 5);
        let w = dv.getUint16(i + 7);
        // Orientation 5~8 = 需要转 90°，实际显示时宽高是反的
        if (orientation >= 5 && orientation <= 8) { const t = w; w = h; h = t; }
        return { w, h, o: orientation || 1 };
      }
      i += 2 + dv.getUint16(i + 2);                            // 跳过本段
    }
  }
  return null;
}

/**
 * @param {{name:string, slice:(a:number,b:number)=>{arrayBuffer:()=>Promise<ArrayBuffer>}}} file
 * @returns {Promise<{w:number,h:number,o?:number}|null>}
 */
export async function readImageSize(file) {
  try {
    // 矢量图没有固有像素尺寸；HEIC 浏览器根本解不了 —— 都不在这里解析
    if (isNoDecodeName(file.name) || isSvgName(file.name)) return null;
    const buf = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
    return scanHeaderBytes(buf);
  } catch {
    return null;
  }
}

/**
 * 从 TIFF 头里读 IFD0 的 Orientation(0x0112)。
 * `t` 指向 'II'/'MM' 标志；只认 SHORT(type=3)，取值 1~8，读不到返回 0（等价于「未标注方向」）。
 *
 * 专门抽出来是因为：createImageBitmap 会按这个值旋转像素，如果解析尺寸时不跟着换算，
 * 得到的宽高比就和真正解码出来的图互为倒数（竖拍照片会一直走全解码慢路径）。
 */
export function readTiffOrientation(dv, n, t) {
  if (t + 8 > n) return 0;
  const bo = dv.getUint16(t);
  if (bo !== 0x4949 && bo !== 0x4d4d) return 0;
  const le = bo === 0x4949;
  const ifd = dv.getUint32(t + 4, le);
  if (t + ifd + 2 > n) return 0;
  const cnt = dv.getUint16(t + ifd, le);
  for (let i = 0; i < cnt; i += 1) {
    const p = t + ifd + 2 + i * 12;
    if (p + 12 > n) break;
    if (dv.getUint16(p, le) === 0x0112) {
      const v = dv.getUint16(p + 8, le);                     // SHORT 只占前 2 字节
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}

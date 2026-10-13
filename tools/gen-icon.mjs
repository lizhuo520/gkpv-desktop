#!/usr/bin/env node
/**
 * tools/gen-icon.mjs —— 生成 Windows 应用图标 build/icon.ico
 *
 * 为什么自己画而不是放一张设计图：
 *   - 仓库要能「无素材依赖」地重建图标，否则别人 clone 下来打包会缺 icon.ico；
 *   - 图标是纯几何图形（相机光圈 + 照片色块），用代码画比维护二进制更可审计；
 *   - 多尺寸 ICO（16/24/32/48/64/128/256）必须齐全，Windows 会在不同位置
 *     挑不同尺寸（任务栏 32、资源管理器 48、Alt+Tab 256），只放 256 会糊。
 *
 * 实现：直接手写 PNG（zlib deflate，Node 内置）+ ICO 容器。
 * 不依赖 sharp/canvas 之类原生模块 —— 打包流程不该因为图像库装不上而卡住。
 *
 * 用法：node tools/gen-icon.mjs [--out build/icon.ico]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'build', 'icon.ico');

/** 尺寸表：Windows 各个位置会用到的规格。 */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/* ------------------------------------------------------------------ *
 * 1. PNG 编码
 * ------------------------------------------------------------------ */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素数组（长度 w*h*4）→ PNG 字节。 */
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 6;        // color type: RGBA
  ihdr[10] = 0;       // compression
  ihdr[11] = 0;       // filter
  ihdr[12] = 0;       // interlace

  // 每行前面加一个 filter 字节（0 = None）
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y += 1) {
    const rowStart = y * (1 + w * 4);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * w * 4, (y + 1) * w * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * 2. 画图标
 * ------------------------------------------------------------------ */

/** 双线性取样，避免小尺寸下边缘锯齿（每个尺寸都直接按几何算，不做缩放）。 */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const rOuter = size * 0.46;            // 圆形底色半径
  const rRing = size * 0.30;             // 光圈环半径（描边中线）
  const ringW = Math.max(1, size * 0.075);  // 环宽
  const rHole = size * 0.16;             // 中心孔
  const bladeN = 6;                      // 光圈叶片数（6 片是常见手感）

  const put = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    // 简单的 source-over 混合
    const na = a / 255;
    const oa = rgba[i + 3] / 255;
    const outA = na + oa * (1 - na);
    if (outA <= 0) return;
    rgba[i] = Math.round((r * na + rgba[i] * oa * (1 - na)) / outA);
    rgba[i + 1] = Math.round((g * na + rgba[i + 1] * oa * (1 - na)) / outA);
    rgba[i + 2] = Math.round((b * na + rgba[i + 2] * oa * (1 - na)) / outA);
    rgba[i + 3] = Math.round(outA * 255);
  };

  /** 抗锯齿：在像素内 3x3 采样，返回覆盖率 0..1。 */
  const coverage = (x, y, test) => {
    let hit = 0;
    for (let sy = 0; sy < 3; sy += 1) {
      for (let sx = 0; sx < 3; sx += 1) {
        if (test(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) hit += 1;
      }
    }
    return hit / 9;
  };

  // 底色：深色圆盘（与应用的深色主题一致）
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cov = coverage(x, y, (px, py) => Math.hypot(px - c, py - c) <= rOuter);
      if (cov > 0) put(x, y, 30, 34, 42, Math.round(255 * cov));
    }
  }

  // 照片色块：圆盘下半部一条暖色渐变，暗示「照片」
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inside = coverage(x, y, (px, py) => {
        const d = Math.hypot(px - c, py - c);
        return d <= rOuter - size * 0.06 && py > c + size * 0.10;
      });
      if (inside <= 0) continue;
      const t = (y - (c + size * 0.10)) / (size * 0.36);
      const r = Math.round(250 - 30 * t);
      const g = Math.round(190 - 60 * t);
      const b = Math.round(90 - 20 * t);
      put(x, y, r, g, b, Math.round(255 * inside));
    }
  }

  // 光圈环 + 叶片
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const ring = coverage(x, y, (px, py) => {
        const d = Math.hypot(px - c, py - c);
        return Math.abs(d - rRing) <= ringW / 2;
      });
      if (ring > 0) put(x, y, 236, 240, 248, Math.round(250 * ring));
    }
  }
  // 叶片：从中心孔向外辐射的细线（用极角判定 6 等分）
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const d = Math.hypot(dx, dy);
      if (d < rHole || d > rRing - ringW / 2) continue;
      const ang = Math.atan2(dy, dx);
      const seg = ((ang / (Math.PI * 2)) * bladeN + bladeN * 2) % 1;
      // 每条叶片的「边缘」= 靠近等分边界的一小段
      const edge = Math.min(seg, 1 - seg);
      if (edge < 0.035) put(x, y, 236, 240, 248, 150);
    }
  }
  // 中心孔：掏空（直接覆盖成近黑，视觉上是镜头）
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cov = coverage(x, y, (px, py) => Math.hypot(px - c, py - c) <= rHole);
      if (cov > 0) put(x, y, 12, 14, 18, Math.round(255 * cov));
    }
  }

  return rgba;
}

/* ------------------------------------------------------------------ *
 * 3. ICO 容器
 * ------------------------------------------------------------------ */

/**
 * ICO 文件结构：
 *   ICONDIR(6) + ICONDIRENTRY(16×n) + 各尺寸的 PNG/位图数据
 * 这里每个尺寸都直接内嵌 PNG（Vista 之后的 Windows 都支持 PNG 条目；
 * 256 那一档必须用 PNG，BMP 装不下）。
 */
function encodeICO(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);              // reserved
  dir.writeUInt16LE(1, 2);              // type: 1 = icon
  dir.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dirEntries = [];
  for (const e of entries) {
    const b = Buffer.alloc(16);
    b[0] = e.size >= 256 ? 0 : e.size;  // 256 用 0 表示
    b[1] = e.size >= 256 ? 0 : e.size;
    b[2] = 0;                           // 调色板数
    b[3] = 0;                           // reserved
    b.writeUInt16LE(1, 4);              // color planes
    b.writeUInt16LE(32, 6);             // bpp
    b.writeUInt32LE(e.png.length, 8);
    b.writeUInt32LE(offset, 12);
    offset += e.png.length;
    dirEntries.push(b);
  }
  return Buffer.concat([dir, ...dirEntries, ...entries.map((e) => e.png)]);
}

/* ------------------------------------------------------------------ *
 * 4. 主流程
 * ------------------------------------------------------------------ */

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 && process.argv[outIdx + 1]
  ? path.resolve(process.cwd(), process.argv[outIdx + 1])
  : DEFAULT_OUT;

fs.mkdirSync(path.dirname(OUT), { recursive: true });

const entries = SIZES.map((size) => ({ size, png: encodePNG(size, size, drawIcon(size)) }));
const ico = encodeICO(entries);
fs.writeFileSync(OUT, ico);

// 顺带产出一张 256 的 PNG：README / 商店页要用，也方便肉眼确认图标长什么样
const pngOut = path.join(path.dirname(OUT), 'icon.png');
fs.writeFileSync(pngOut, entries[entries.length - 1].png);

process.stdout.write(`✔ 图标已生成：${OUT}（${(ico.length / 1024).toFixed(1)} KB，含 ${SIZES.join('/')} 共 ${SIZES.length} 档）\n`);
process.stdout.write(`  预览图：${pngOut}\n`);

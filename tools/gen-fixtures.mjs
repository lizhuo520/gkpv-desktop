/**
 * 测试素材生成器（零依赖）。
 *
 * 生成两批素材：
 *  1. **合成素材** —— 手写的 PNG/GIF/BMP/WebP/JPEG/EXIF-JPEG/SVG/类 TIFF RAW 字节，
 *     宽高与 EXIF 方向都是已知值，因此可以对断言写死期望值（这是最有价值的测试素材）。
 *  2. **真实素材链接** —— 从本机真实照片目录里挑几张，**硬链接**进 fixtures
 *     （不复制、不占空间，删源文件也不影响已生成的目录树）。
 *     真实素材用来覆盖「真解码器能解开、尺寸解析与真容器一致」这类合成素材证明不了的事。
 *
 * 产出 `tests/fixtures/manifest.json`：每个文件的期望尺寸 / EXIF 方向 / sha256 / 类别。
 * 测试只读 manifest，不自己推导期望值 —— 否则测试会跟着实现一起漂移。
 *
 * 用法：
 *   node tools/gen-fixtures.mjs            # 重建 tests/fixtures（幂等，先清空）
 *   node tools/gen-fixtures.mjs --no-real  # 不要真实素材（CI/无素材机器）；real/ 完全不落地
 *   node tools/gen-fixtures.mjs --real-src "D:\图片\iCloud 照片"
 *
 * real/ 说明：里面是从本机相册**硬链接/复制**进来的真实照片（个人照片，不入库，见 .gitignore）。
 * 不指定 --no-real 且相册存在时会自动重建；相册不存在时静默跳过（real/ 为空），
 * 依赖它的测试会打印跳过原因，不会假装通过。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const FIX = path.join(REPO, 'tests', 'fixtures');
const SAMPLES_DIR = path.join(REPO, 'tests', 'samples');

const argv = process.argv.slice(2);
const NO_REAL = argv.includes('--no-real');
const realSrcArg = argv.indexOf('--real-src');
const REAL_SRC = realSrcArg >= 0 ? argv[realSrcArg + 1] : 'D:\\图片\\iCloud 照片';

/* ================================================================== *
 * 1. PNG（编码 + 解码校验）
 * ================================================================== */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 生成一张 RGBA PNG。
 * @param {(x:number,y:number)=>[number,number,number,number]} paint
 */
export function encodePNG(width, height, paint) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filter
  ihdr[12] = 0;   // no interlace

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;   // filter type 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const o = rowStart + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 解回像素（fixtures 自检用：确认手写编码器写出来的东西真的能被解码）。 */
export function decodePNG(buf) {
  if (process.env.GKPV_DEBUG) console.error(`[decodePNG] len=${buf.length} head=${buf.subarray(0, 12).toString('hex')}`);
  if (buf.readUInt32LE(0) !== 0x474e5089) throw new Error('不是 PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let bpp = 4;          // 每像素字节数（colorType 6=RGBA / 2=RGB）
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const colorType = data[9];
      if (colorType !== 6 && colorType !== 2) throw new Error(`自检解码器只支持 colorType 2/6，收到 ${colorType}`);
      bpp = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp + 1;
  const out = Buffer.alloc(width * height * bpp);
  const bppOff = (bpp * 2 - 1);        // Sub 过滤时向上查的字节偏移
  const soff = (bpp * 3 - 1);          // Average 过滤时向左上的偏移
  for (let y = 0; y < height; y += 1) {
    const ft = raw[y * stride];
    const src = y * stride + 1;
    const dst = y * width * bpp;
    const up = dst - width * bpp;
    for (let i = 0; i < width * bpp; i += 1) {
      const a = i >= bpp ? out[dst + i - bpp] : 0;        // 左
      const b = y > 0 ? out[up + i] : 0;                  // 上
      const c = y > 0 && i >= bpp ? out[up + i - bpp] : 0; // 左上
      let v = raw[src + i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (ft !== 0) {
        throw new Error(`不支持的 filter 类型 ${ft}`);
      }
      out[dst + i] = v & 0xff;
    }
  }
  void bppOff; void soff;
  return { width, height, bpp, rgba: out };
}

/* ================================================================== *
 * 2. BMP
 * ================================================================== */

/* 这里曾有一整套自写 GIF 编码器（LZW + 子块），已删除。
 * 原因：第一版手写 LZW 产出的文件被 Chromium 与 Pillow 同时拒收
 * （"The source image could not be decoded" / "image file is truncated"），
 * 改写真实模板尺寸同样被拒 —— GIF 解码器会交叉校验像素数与 LZW 数据。
 * 现在 GIF 用 tools/make-gif-sample.mjs 的第二版手写编码器产出样本再登记
 * （位序 LSB-first、字典满改「推迟清表」，且已过 Chromium 真解码与
 * 规范解码器还原两道验证）。 */
function encodeBMP(width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(54 + pixelBytes, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);    // 正数 = 自下而上
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(0, 30);
  header.writeUInt32LE(pixelBytes, 34);
  const pixels = Buffer.alloc(pixelBytes);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = y * rowSize + x * 3;
      pixels[o] = 0x60;        // B
      pixels[o + 1] = 0xc0;    // G
      pixels[o + 2] = 0x30;    // R
    }
  }
  return Buffer.concat([header, pixels]);
}

/**
 * 从 `tests/samples/` 取一张真实编码器产出的样本，登记为 fixture。
 *
 * 背景（值得记住的教训）：手搓二进制图像素材在本项目连踩三坑 ——
 *   JPEG：DHT 段长写成第一张表的长度、熵段只覆盖 1 个 MCU；
 *   WebP：改写 VP8X 画布尺寸并不能改变解码输出（位流自带尺寸）；
 *   GIF：第一版手写 LZW 被 Chromium 拒收，改写模板尺寸同样被拒。
 * 结论：凡是「必须真的能解码」的格式，一律用真实编码器产出样本、
 * 原样登记为 fixture；只有「尺寸解析」这类只读文件头的用例才用手写头。
 *
 * GIF 的特殊处理（这里踩过一个"自己跟自己比"的坑，值得记住）：
 *   `basic/gif-120x90.gif` 刻意取自 `tests/samples/reference/pillow-gif-120x90.gif`
 *   ——**冻结的 Pillow 产物**（273 字节、隔行、sha256 6a96068a…），而不是取自
 *   `tests/samples/gif-120x90.gif`（手写 LZW，279 字节、非隔行）。
 *
 *   为什么必须这样：`sampleFixture()` 是**复制**样本到 fixtures。若两边都指向
 *   手写编码器那一份，`tests/unit/gif.test.mjs` 里那条"手写产物与 Pillow 产物
 *   逐点相同"的交叉比对就变成**同一个文件跟它自己比**，无论编码器错成什么样
 *   都会通过 —— 它一度确实是这样，零证明力。
 *   两份真正独立的产物（Pillow vs 手写 LZW）字节数不同（273 vs 279）、
 *   隔行标志不同（0x40 vs 0x00），但解码后的像素必须逐点相同，这才叫交叉验证。
 *
 *   reference/ 里的文件是**冻结的参照物**：只能用 Pillow 12.3 按
 *   `tools/make-gif-template.py` 的原始参数逐字节复现（npm run gif-reference），
 *   生成器绝不覆盖它。丢失它就等于丢掉这条唯一的外部对照（曾经丢过一次）。
 */
function sampleFixture(rel, srcName, expect, note) {
  const src = path.join(SAMPLES_DIR, srcName);
  if (!fs.existsSync(src)) {
    const hint = srcName.startsWith('reference/')
      ? '这是冻结的 Pillow 参照物，请跑 npm run gif-reference 复现（需要一份可用的 Pillow）'
      : (srcName.endsWith('.gif')
        ? '请先跑 node tools/make-gif-sample.mjs'
        : '请先跑 node tools/capture-samples.mjs');
    throw new Error(`缺少真实样本 ${path.relative(REPO, src)}；${hint}`);
  }
  add(rel, fs.readFileSync(src), { expect, kind: 'image', note });
}

/**
 * 造一张**仅头部可解析**的 WebP：VP8X 声明目标尺寸 + 空 VP8L。
 * 不可解码（解码器按位流自带尺寸输出），只用于验证尺寸解析走 VP8X 分支，
 * note 与 manifest 的 decodable=false 会如实标注这个缺口。
 */
function encodeWebPStub(width, height) {
  const chunk = (id, data) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
  };
  const vp8x = Buffer.alloc(10);
  // 24bit 宽高，各减 1
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk('VP8X', vp8x), chunk('VP8L', Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00]))]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/* ================================================================== *
 * 3. JPEG（可选 EXIF 段）
 *
 * 造的是**结构完全合法的单分量 baseline JPEG**：
 *   SOI + DQT + SOF0(1 分量) + DHT(DC/AC 各一张标准表) + SOS + 熵数据 + EOI
 *
 * 历史上这里踩过两个坑，都会让 Chromium 直接报
 * `InvalidStateError: The source image could not be decoded`：
 *  1. DQT 段声明长度 `0x43`(67 字节) 但实际只写了 43 字节的量化表 —— 段长与内容对不上；
 *  2. 熵数据段是随手凑的 0 字节 —— 不是合法的 Huffman 码流，解码器读到 EOI 之前就失败。
 * 现在改为：量化表恒为 1（DC 系数 0 × 量化值 1 + 128 = 128，解码结果正好是纯中灰，
 * 与直觉一致），熵数据按标准表逐位手算（见 JPEG_SCAN）。
 * ================================================================== */

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

/** 1×64 的量化表（baseline 允许，值全 1 便于预测解码结果）。 */
const JPEG_DQT = (() => {
  const seg = Buffer.alloc(2 + 2 + 1 + 64);
  seg.writeUInt16BE(0xffdb, 0);
  seg.writeUInt16BE(2 + 1 + 64, 2);       // 段长 = 2 + (Pq/Tq 1 字节 + 64 字节表)
  seg[4] = 0x00;                          // Pq=0（8bit）Tq=0
  seg.fill(1, 5);                         // 量化值全 1
  return seg;
})();

/** SOF0：8bit 精度 + 1 个分量（灰阶），采样 1×1，量化表 0。 */
function jpegSOF0(width, height) {
  const seg = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1 + 3);
  seg.writeUInt16BE(0xffc0, 0);
  seg.writeUInt16BE(seg.length - 2, 2);
  seg[4] = 8;
  seg.writeUInt16BE(height, 5);
  seg.writeUInt16BE(width, 7);
  seg[9] = 1;                             // 1 个分量
  seg[10] = 1; seg[11] = 0x11; seg[12] = 0;   // id=1, H=1 V=1, Tq=0
  return seg;
}

/** DHT：标准亮度 DC/AC 表（ITU T.81 Annex K.3.3）。 */
const JPEG_DHT = (() => {
  const DC_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const AC_COUNTS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
  const AC_VALUES = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ];
  const table = (cls, id, counts, values) => Buffer.concat([
    Buffer.from([(cls << 4) | id]),
    Buffer.from(counts),
    Buffer.from(values),
  ]);
  const body = Buffer.concat([
    table(0, 0, DC_COUNTS, DC_VALUES),
    table(1, 0, AC_COUNTS, AC_VALUES),
  ]);
  // 段长必须在这里、对**整段内容**写一次（含两张表）。
  // 历史坑（Chromium 报 `InvalidStateError: The source image could not be decoded`）：
  // 之前给每张表单独写 ff c4 + 各自长度再 Buffer.concat，结果段头声明的是
  // **第一张表**的长度（0x00ce = 206），而带外内容却有 386 字节；
  // 解析器按 206 跳过之后正好落在 AC 表数据中间的 0xff 字节上
  // （标准 AC 表里就有 0xf0/0xf1…），当成非法 marker → 整张图直接拒解。
  // JPEG 的 DHT 是「段长 + 连续多张表」，表本身不含长度字段。
  const seg = Buffer.concat([Buffer.from([0xff, 0xc4]), Buffer.alloc(2), body]);
  seg.writeUInt16BE(seg.length - 2, 2);
  return seg;
})();

/** SOS：单分量，谱选择 0..63，近似/逐次逼近全 0。 */
const JPEG_SOS = (() => {
  const seg = Buffer.alloc(2 + 2 + 1 + 2 + 3);
  seg.writeUInt16BE(0xffda, 0);
  seg.writeUInt16BE(seg.length - 2, 2);
  seg[4] = 1;                 // 1 个分量
  seg[5] = 1; seg[6] = 0x00;  // 分量 id=1，DC 表 0 / AC 表 0
  seg[7] = 0; seg[8] = 63; seg[9] = 0;
  return seg;
})();

/**
 * 熵数据：每个 MCU（此处 1 分量 1×1 采样，即 1 个 8×8 块）的位流都是
 *   DC 差值 0 → 亮度 DC 表里码长 2、码字 `00`
 *   AC 全 0 → EOB，亮度 AC 表里码长 4、码字 `1010`
 * 即位流 `001010`（6 位），整个 MCU 都解成中灰（DC 系数 0 × 量化值 1 + 128 = 128）。
 *
 * 历史坑（会让 Chromium 报 `InvalidStateError: The source image could not be decoded`）：
 * 这里原本只写 **1 个 MCU 的 6 位**（`Buffer.from([0x2b])`），
 * 对 400×300 这种需要 50×38 个 MCU 的图，解码器读到 EOI 时还没解完应有的 MCU，
 * 直接判「源图无法解码」。JPEG 的熵段必须覆盖 `MCUs_x * MCUs_y` 个块的码流
 * （最后一块的位流按 §B.1.1.5 用 1 位补齐到字节边界，多余位解码器会忽略）。
 */
function jpegScan(width, height) {
  const mcusX = Math.ceil(width / 8);
  const mcusY = Math.ceil(height / 8);
  const bitCount = mcusX * mcusY * 6;
  const out = Buffer.alloc(Math.ceil(bitCount / 8));
  let bit = 0;
  for (let i = 0; i < mcusX * mcusY; i += 1) {
    // 0,0,1,0,1,0 —— MSB 优先
    for (const b of [0, 0, 1, 0, 1, 0]) {
      if (b) out[bit >> 3] |= 0x80 >> (bit & 7);
      bit += 1;
    }
  }
  return out;
}

/** 造一张纯中灰的合法 JPEG（每个 MCU 都有合法码流）。 */
function encodeJPEG(width, height) {
  return Buffer.concat([
    JPEG_SOI, JPEG_DQT, jpegSOF0(width, height), JPEG_DHT, JPEG_SOS, jpegScan(width, height), JPEG_EOI,
  ]);
}

/**
 * 造一张带 EXIF 的 JPEG：`stored` 是像素存储尺寸，`orientation` 是 EXIF 方向。
 * 尺寸解析必须返回「转正后」的宽高，这是本项目最容易出错的一处。
 */
function encodeJPEGWithExif(stored, orientation, extra = {}) {
  const tiff = buildExifTIFF({ orientation, ...extra });
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(6 + tiff.length + 2, 0); return b; })(),
    Buffer.from('Exif\0\0', 'latin1'),
    tiff,
    Buffer.alloc(0),
  ]);
  const body = encodeJPEG(stored.width, stored.height);
  // SOI 之后插入 APP1
  return Buffer.concat([body.subarray(0, 2), app1, body.subarray(2)]);
}

/* ================================================================== *
 * 4. EXIF / TIFF（可被 main/scandir.cjs 与 renderer/lib/exif.js 同时解析）
 * ================================================================== */

const T = {
  SHORT: 3, LONG: 4, RATIONAL: 5, ASCII: 2, UNDEFINED: 7, SLONG: 9, SRATIONAL: 10,
};

function ifdTable(entries, nextIfd = 0) {
  const head = Buffer.alloc(2);
  head.writeUInt16LE(entries.length, 0);
  const body = Buffer.alloc(entries.length * 12);
  entries.forEach((e, i) => {
    const o = i * 12;
    body.writeUInt16LE(e.tag, o);
    body.writeUInt16LE(e.type, o + 2);
    body.writeUInt32LE(e.count, o + 4);
    body.writeUInt32LE(e.value, o + 8);
  });
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(nextIfd, 0);
  return Buffer.concat([head, body, tail]);
}

/**
 * 组装一个完整（小端）TIFF：IFD0 + EXIF IFD + SubIFD + 一条内嵌 JPEG 预览。
 * 布局是「表全部在前、数据全部在后」，偏移在生成过程中算出，因此不会自相矛盾。
 */
export function buildExifTIFF({ orientation = 1, make = 'NIKON CORPORATION', model = 'NIKON D800', lens = '24.0-70.0 mm f/2.8', preview = null, fullWidth = 0, fullHeight = 0 } = {}) {
  const offIFD0 = 8;
  const ifd0Count = 6;    // 0x010F,0x0110,0x0112,0x8769,0x014A,0x0100
  const offExif = offIFD0 + 2 + ifd0Count * 12 + 4;
  const exifCount = 9;
  const offSub = offExif + 2 + exifCount * 12 + 4;
  const subCount = 4;     // 0x0100,0x0101,0x0201,0x0202
  const offData = offSub + 2 + subCount * 12 + 4;

  const chunks = [];
  let cursor = offData;
  const push = (buf) => { const at = cursor; chunks.push(buf); cursor += buf.length; return at; };

  const makeStr = Buffer.from(`${make}\0`, 'latin1');
  const modelStr = Buffer.from(`${model}\0`, 'latin1');
  const lensStr = Buffer.from(`${lens}\0`, 'latin1');
  const softwareStr = Buffer.from('gkpv-fixtures\0', 'latin1');

  const offMake = push(makeStr);
  const offModel = push(modelStr);
  const offLens = push(lensStr);
  const offSoftware = push(softwareStr);
  const offDateTime = push(Buffer.from('2024:05:06 07:08:09\0', 'latin1'));

  // 内嵌 JPEG 预览（RAW 缩略图/灯箱的来源）
  let offPreview = 0;
  if (preview) offPreview = push(preview);

  const ifd0Entries = [
    { tag: 0x010f, type: T.ASCII, count: makeStr.length, value: offMake },
    { tag: 0x0110, type: T.ASCII, count: modelStr.length, value: offModel },
    { tag: 0x0112, type: T.SHORT, count: 1, value: orientation },
    { tag: 0x011a, type: T.RATIONAL, count: 1, value: 0 },   // 占位，下面补
    { tag: 0x8769, type: T.LONG, count: 1, value: offExif },
    { tag: 0x014a, type: T.LONG, count: 1, value: offSub },
  ];
  // XResolution 的 RATIONAL 数据（1/1）
  const offXR = push(Buffer.concat([u32(1), u32(1)]));
  ifd0Entries[3].value = offXR;

  const exifEntries = [
    { tag: 0x829a, type: T.RATIONAL, count: 1, value: 0 },     // ExposureTime
    { tag: 0x829d, type: T.RATIONAL, count: 1, value: 0 },     // FNumber
    { tag: 0x8827, type: T.SHORT, count: 1, value: 400 },      // ISO
    { tag: 0x9003, type: T.ASCII, count: 20, value: offDateTime },
    { tag: 0x920a, type: T.RATIONAL, count: 1, value: 0 },     // FocalLength
    { tag: 0xa002, type: T.LONG, count: 1, value: fullWidth },  // PixelXDimension
    { tag: 0xa003, type: T.LONG, count: 1, value: fullHeight }, // PixelYDimension
    { tag: 0xa434, type: T.ASCII, count: lensStr.length, value: offLens },
    { tag: 0x0001, type: T.ASCII, count: softwareStr.length, value: offSoftware },
  ];
  const offExp = push(Buffer.concat([u32(1), u32(125)]));      // 1/125s
  const offFn = push(Buffer.concat([u32(28), u32(10)]));        // f/2.8
  const offFocal = push(Buffer.concat([u32(50), u32(1)]));      // 50mm
  exifEntries[0].value = offExp;
  exifEntries[1].value = offFn;
  exifEntries[4].value = offFocal;

  const subEntries = [
    { tag: 0x0100, type: T.LONG, count: 1, value: fullWidth },
    { tag: 0x0101, type: T.LONG, count: 1, value: fullHeight },
    { tag: 0x0201, type: T.LONG, count: 1, value: offPreview },
    { tag: 0x0202, type: T.LONG, count: 1, value: preview ? preview.length : 0 },
  ];

  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(0x2a, 2);
  header.writeUInt32LE(offIFD0, 4);

  const tiff = Buffer.concat([
    header,
    ifdTable(ifd0Entries),
    ifdTable(exifEntries),
    ifdTable(subEntries),
    ...chunks,
  ]);
  return tiff;
}

function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }

/** 内嵌预览的像素尺寸：1600 宽，高度按传感器比例算（真实相机就是这么缩比的）。 */
function rawPreviewSize(fullWidth, fullHeight) {
  return { width: 1600, height: Math.max(1, Math.round((1600 * fullHeight) / fullWidth)) };
}

/**
 * RAW = 纯 TIFF 容器（NEF/ARW/DNG 都是这个形状）。
 *
 * 内嵌预览必须**与传感器同比例**、而且**够大**，这两条都是被真实相机约束出来的：
 *   1) 同比例：缩略图返回的宽高（generateThumb 的 sameAR 判定）要能与传感器显示尺寸对上，
 *      否则磁贴宽高比会按 4:3 预览排，而信息面板写的是 3:2 传感器；
 *   2) 够大：readRawPreview 只认 8192 字节以上的候选（gkpv.html:1075，网页版同款限制，
 *      本意是别把小缩略图当预览用）。预览小于它 = 读盘路径永远选不中，返回 null。
 * 早先这里固定造 800x600（5933 字节）的预览，两个坑全中：
 * `raw:embedded-previews-parsed`（走 __gkpv.rawPreview 读盘路径）拿不到预览，
 * `raw:tiles-not-blank`（比磁贴自然宽高比）也必然差出 11%。
 */
function encodeRAW(kind, opts) {
  const fullWidth = opts.fullWidth || 7360;
  const fullHeight = opts.fullHeight || 4912;
  const pv = rawPreviewSize(fullWidth, fullHeight);
  const preview = encodeJPEG(pv.width, pv.height);
  const tiff = buildExifTIFF({ ...opts, preview, fullWidth, fullHeight });
  void kind;
  return tiff;
}

/* ================================================================== *
 * 5. 主流程
 * ================================================================== */

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 渐变 + 四角标记：缩略图里一眼能看出有没有被压扁/翻转。 */
function gradientPaint(w, h) {
  return (x, y) => {
    const r = Math.round((x / Math.max(1, w - 1)) * 255);
    const g = Math.round((y / Math.max(1, h - 1)) * 255);
    const corner = (x < w / 8 || x >= w - w / 8) && (y < h / 8 || y >= h - h / 8);
    return corner ? [255, 0, 0, 255] : [r, g, 128, 255];
  };
}

const files = [];
/**
 * `decodeVia` 决定「这张素材该用什么方式验证它真的是好的」——这是素材清单里
 * 最容易想当然的字段，所以规则写死在这里、不留自由发挥空间：
 *
 *   bitmap —— 直接 `createImageBitmap(blob)` 出宽高。适用于 PNG/JPEG/GIF/BMP/WebP。
 *   svg    —— 走 `<img>` + `decode()`：`createImageBitmap` 对 SVG 一律拒收
 *             （实测 2/2 失败），必须用文档里的 SVG 分支来验。
 *   raw    —— 走 readRawPreview：RAW 是 TIFF 容器 + 内嵌 JPEG 预览，
 *             直接丢给 createImageBitmap 必然失败（实测 5/5 失败），
 *             要按「容器 IFD0 定方向 + 内嵌预览取像素」两段来验。
 *   none   —— 故意坏掉的素材（broken/空文件/文本），期望就是解不出来。
 *
 * 历史教训：曾用一个 `decodable: true` 布尔值一刀切，结果 7 张素材
 * （2 个 SVG + 5 个 RAW）被误判成「应可解码却失败」，差点当成真 bug 去查。
 * 素材清单必须写清「用什么方式解码」，而不是「能不能解码」。
 */
function inferDecodeVia(kind) {
  if (kind === 'svg') return 'svg';
  if (kind === 'raw') return 'raw';
  if (kind === 'image') return 'bitmap';
  if (kind === 'webp-header') return 'bitmap-expect-fail';
  return 'none';   // broken / text / unknown / heic / no-ext / hidden / marker …
}

function add(rel, buf, meta = {}) {
  files.push({ rel, buf, meta: { decodeVia: inferDecodeVia(meta.kind), ...meta } });
}

function buildSynthetic() {
  /* ---- 基本格式：宽高与内容都可断言 ---- */
  add('basic/png-320x240.png', encodePNG(320, 240, gradientPaint(320, 240)), { expect: { w: 320, h: 240 }, kind: 'image' });
  add('basic/png-64x512.png', encodePNG(64, 512, gradientPaint(64, 512)), { expect: { w: 64, h: 512 }, kind: 'image' });
  add('basic/png-transparent.png', encodePNG(200, 200, (x, y) => {
    // 左半不透明、右半全透明：验证 PNG 缩略图保留透明通道
    const a = x < 100 ? 255 : 0;
    return [0, 128, 255, a];
  }), { expect: { w: 200, h: 200 }, kind: 'image', note: '右半透明' });
  add('basic/bmp-150x100.bmp', encodeBMP(150, 100), { expect: { w: 150, h: 100 }, kind: 'image' });
  // GIF 的 fixture 取**冻结的 Pillow 参照物**（273B、隔行），不是手写样本的副本——
  // 只有两份独立的编码器产物才能构成交叉验证（见 sampleFixture 上方的长注释）。
  sampleFixture('basic/gif-120x90.gif', path.join('reference', 'pillow-gif-120x90.gif'), { w: 120, h: 90 },
    'Pillow 12.3 冻结参照物（273B、隔行 packed=0x40）；与 tests/samples/gif-120x90.gif 手写 LZW 逐点比对');
  // WebP 的两条路径分得很清楚：
  //   - webp-64x64 / webp-128x64：Chromium 编码的真实文件，测「真的能解码并出缩略图」；
  //   - webp-header-300x200：自写头，只测「尺寸解析走 VP8X 分支」，**不可解码**。
  sampleFixture('basic/webp-64x64.webp', 'webp-64x64.webp', { w: 64, h: 64 }, 'Chromium 编码的真实 WebP');
  sampleFixture('basic/webp-128x64.webp', 'webp-128x64.webp', { w: 128, h: 64 }, 'Chromium 编码的真实 WebP（横向 2:1）');
  add('basic/webp-header-300x200.webp', encodeWebPStub(300, 200), {
    expect: { w: 300, h: 200 },
    kind: 'webp-header',
    decodeVia: 'bitmap-expect-fail',
    note: '仅验证尺寸解析（VP8X 分支）；自写空 VP8L，解码器拒收（已实测）',
  });
  add('basic/jpeg-400x300.jpg', encodeJPEG(400, 300), { expect: { w: 400, h: 300 }, kind: 'image' });
  add('basic/jpeg-1600x900.jpg', encodeJPEG(1600, 900), { expect: { w: 1600, h: 900 }, kind: 'image', note: '超过 THUMB_MAX=640，必须走缩放路径' });

  // SVG 的宽高只由渲染层（HTMLImageElement.naturalWidth/naturalHeight）决定，
  // 这里登记的就是 Chromium 实际报出来的值 —— 已用 Electron 实测（见下方 note）：
  //   - 只有 viewBox、没有 width/height：Chromium 给默认 300x150 视口，**不是** viewBox 的 100x50；
  //   - 有 width/height 属性：就是属性值。
  // Node 侧的解码器（scandir.js 的 SVG 分支）**故意不解析 SVG**：网页版
  // （gkpv.html 第 844-845 行）就是 `isSvgName(file.name) → return null`，
  // 让渲染层用 naturalWidth 兜底，两侧必须保持一致，否则网格宽高比会两套答案。
  add('basic/svg-no-size.svg', Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">'
    + '<rect width="100" height="50" fill="#0a84ff"/></svg>', 'utf8'), {
    expect: { w: 300, h: 150 },
    kind: 'svg',
    note: '只有 viewBox：Chromium 的 <img> 报 300x150（实测），Node 侧刻意不解析',
  });
  add('basic/svg-240x160.svg', Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160">'
    + '<circle cx="120" cy="80" r="70" fill="#ffd60a"/></svg>', 'utf8'), {
    expect: { w: 240, h: 160 },
    kind: 'svg',
    note: '显式 width/height：Chromium 与 Node 都报 240x160',
  });

  /* ---- EXIF 方向：存储尺寸 vs 显示尺寸 ---- */
  const orientations = [
    { o: 1, stored: { width: 320, height: 240 } },
    { o: 2, stored: { width: 320, height: 240 } },
    { o: 3, stored: { width: 320, height: 240 } },
    { o: 4, stored: { width: 320, height: 240 } },
    { o: 5, stored: { width: 320, height: 240 } },
    { o: 6, stored: { width: 320, height: 240 } },
    { o: 7, stored: { width: 320, height: 240 } },
    { o: 8, stored: { width: 320, height: 240 } },
  ];
  for (const { o, stored } of orientations) {
    const swap = o >= 5;
    add(`exif/orient-${o}.jpg`, encodeJPEGWithExif(stored, o), {
      expect: { w: swap ? stored.height : stored.width, h: swap ? stored.width : stored.height, orientation: o },
      kind: 'exif-jpeg',
      note: `存储 ${stored.width}x${stored.height}，方向 ${o}`,
    });
  }
  // 无 EXIF 的对照样本
  add('exif/orient-none.jpg', encodeJPEG(320, 240), { expect: { w: 320, h: 240, orientation: 0 }, kind: 'image' });

  /* ---- RAW：TREND 容器 + 内嵌预览 ---- */
  const rawSamples = [
    { rel: 'raw/sony-arw-a.ARW', orientation: 1, fullWidth: 7360, fullHeight: 4912 },
    { rel: 'raw/sony-arw-b.ARW', orientation: 6, fullWidth: 7360, fullHeight: 4912 },
    { rel: 'raw/nikon-d800.NEF', orientation: 8, fullWidth: 7360, fullHeight: 4912 },
    { rel: 'raw/canon-a.CR2', orientation: 3, fullWidth: 5472, fullHeight: 3648 },
    { rel: 'raw/dng-sample.dng', orientation: 1, fullWidth: 6000, fullHeight: 4000 },
  ];
  for (const s of rawSamples) {
    const pv = rawPreviewSize(s.fullWidth, s.fullHeight);
    add(s.rel, encodeRAW('tiff', s), {
      expect: {
        w: s.orientation >= 5 ? s.fullHeight : s.fullWidth,
        h: s.orientation >= 5 ? s.fullWidth : s.fullHeight,
        orientation: s.orientation,
        previewEmbedded: true,
      },
      kind: 'raw',
      note: `内嵌 ${pv.width}x${pv.height} JPEG 预览（与 ${s.fullWidth}x${s.fullHeight} 传感器同比例，> 8192 字节）`,
    });
  }

  /* ---- 边界情况 ---- */
  add('edge/broken.jpg', Buffer.concat([JPEG_SOI, Buffer.from('this is not a jpeg at all')]), { expect: null, kind: 'broken' });
  add('edge/broken.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]), { expect: null, kind: 'broken' });
  add('edge/empty.jpg', Buffer.alloc(0), { expect: null, kind: 'broken', note: '0 字节' });
  add('edge/fake.heic', Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(16)]), { expect: null, kind: 'heic', note: '应显示为「无预览」占位' });
  add('edge/no-extension', encodePNG(48, 48, gradientPaint(48, 48)), { expect: null, kind: 'no-ext', note: '无扩展名：不在 IMAGE_EXTS 内' });
  add('edge/not-an-image.txt', Buffer.from('plain text, not an image\n', 'utf8'), { expect: null, kind: 'text' });
  add('edge/unknown.xyz', Buffer.from('unknown format\n', 'utf8'), { expect: null, kind: 'unknown' });
  add('edge/huge-sparse.png', encodePNG(64, 64, gradientPaint(64, 64)), { expect: { w: 64, h: 64 }, kind: 'image', note: '文件名很长' });
  add('edge/ 空格 与 中文 名（含括号）ok.png', encodePNG(80, 60, gradientPaint(80, 60)), { expect: { w: 80, h: 60 }, kind: 'image', note: 'UTF-8 文件名 + 空格' });
  add(`edge/${'很长的文件名'.repeat(18)}.png`, encodePNG(32, 32, gradientPaint(32, 32)), { expect: { w: 32, h: 32 }, kind: 'image', note: '缓存 key 需截断到 200 字符' });

  // 隐藏文件与隐藏目录：扫描必须跳过（以 . 开头）
  add('edge/.hidden-image.png', encodePNG(16, 16, gradientPaint(16, 16)), { expect: null, kind: 'hidden' });

  // 空目录（README 占位，扫描时目录本身应被列出）
  add('edge/empty-dir/README.txt', Buffer.from('这个目录里没有图片，用于验证空目录的处理。\n', 'utf8'), { expect: null, kind: 'marker' });

  // 子目录：递归模式测试
  add('nested/level1/one.png', encodePNG(100, 100, gradientPaint(100, 100)), { expect: { w: 100, h: 100 }, kind: 'image' });
  add('nested/level1/level2/two.png', encodePNG(120, 80, gradientPaint(120, 80)), { expect: { w: 120, h: 80 }, kind: 'image' });
  add('nested/level1/level2/level3/three.jpg', encodeJPEG(200, 150), { expect: { w: 200, h: 150 }, kind: 'image' });
  add('nested/other/four.png', encodePNG(90, 90, gradientPaint(90, 90)), { expect: { w: 90, h: 90 }, kind: 'image' });

  // 大量小图：虚滚动/并发队列的压测入口
  for (let i = 0; i < 24; i += 1) {
    const w = 80 + (i % 4) * 40;
    const h = 60 + (i % 3) * 40;
    add(`many/img-${String(i).padStart(3, '0')}.png`, encodePNG(w, h, gradientPaint(w, h)), { expect: { w, h }, kind: 'image' });
  }
}

/**
 * 真实素材：**硬链接**进 fixtures（同盘秒级完成、不占额外空间）。
 * 跨盘/不支持硬链接时退回复制。注意 `.HEIC` 这类大写扩展名也必须匹配到。
 */
async function linkReal() {
  const picks = [];
  // --no-real 必须**完全不落地**：只在末尾跳过 manifest 登记是不够的
  // （那样会在磁盘上留下没登记的 real/ 文件，直接撞上
  //  tests/unit/fixtures.test.mjs「磁盘上的素材与 manifest 一一对应」那条断言）。
  // CI 上 REAL_SRC 不存在、走下面这行本来就返回空，所以这个 bug 只在
  // 「本机有相册 + 显式 --no-real」时才现形 —— 正是最容易被忽略的组合。
  if (NO_REAL) return picks;
  if (!fs.existsSync(REAL_SRC)) return picks;
  const wanted = [/\.jpe?g$/i, /\.png$/i, /\.gif$/i, /\.heic$/i, /\.tiff?$/i];
  const buckets = new Map();
  for (const re of wanted) buckets.set(String(re), []);

  let entries = [];
  try {
    entries = await fsp.readdir(REAL_SRC, { withFileTypes: true });
  } catch {
    return picks;
  }
  // iCloud 导出有时会把素材再套一层子目录，浅挖两层
  const dirs = [REAL_SRC];
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(path.join(REAL_SRC, e.name));
  }
  for (const dir of dirs) {
    let sub = [];
    try {
      sub = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of sub) {
      if (!e.isFile()) continue;
      const hit = wanted.find((re) => re.test(e.name));
      if (!hit) continue;
      const list = buckets.get(String(hit));
      if (list.length < 2) list.push({ dir, name: e.name });
    }
  }
  for (const [, list] of buckets) picks.push(...list);

  const out = [];
  for (const { dir, name } of picks) {
    const src = path.join(dir, name);
    const rel = `real/${name}`;
    const dst = path.join(FIX, ...rel.split('/'));
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    try {
      await fsp.link(src, dst);          // 硬链接：同一份数据、两个名字
    } catch {
      try { await fsp.copyFile(src, dst); } catch { continue; }   // 跨盘时复制
    }
    const st = await fsp.stat(dst);
    const bytes = await fsp.readFile(dst);
    const ext = path.extname(name).slice(1).toLowerCase();
    const isHeic = ext === 'heic' || ext === 'heif';
    // 真实素材的期望尺寸由解码器给出（expect: null），但机读测试要能自动判定
    // 「该怎么验」。能进 createImageBitmap 的按 bitmap 验；HEIC 在本机没有任何
    // 解码器（Chromium 与 Pillow 都拒），所以标成 heic-none，测的是「有占位、不崩」。
    const isBitmap = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'avif'].includes(ext);
    out.push({
      rel,
      meta: {
        kind: isHeic ? 'heic' : 'real-image',
        decodeVia: isHeic ? 'heic-none' : (isBitmap ? 'bitmap-nosize' : 'none'),
        expect: null,     // 真实素材的期望尺寸由解码器给出，不用写死
        real: true,
        source: src,
        size: st.size,
        sha256: sha256(bytes),
      },
      buf: null,
    });
  }
  return out;
}

async function main() {
  // FIX 下的每个条目都由生成器完全拥有，所以整体清空重建；只保留 manifest 之外
  // 的一切清掉是刻意的（避免上一轮遗留的素材让测试假绿）。
  // tests/samples/ 在 FIX **之外**，由 tools/capture-samples.mjs 与
  // tools/make-gif-template.py 维护（生成它们要启动 Electron / Python），
  // 生成器只读、绝不删。曾经它放在 FIX 里、靠「读进内存再写回」保命，
  // 一旦写回逻辑出问题就会把真实样本连同 fixtures 一起删掉，已经改成外置。
  await fsp.rm(FIX, { recursive: true, force: true });
  await fsp.mkdir(FIX, { recursive: true });
  await fsp.mkdir(SAMPLES_DIR, { recursive: true });

  buildSynthetic();
  const real = await linkReal();

  const manifest = { generatedAt: new Date().toISOString(), realSrc: NO_REAL ? null : REAL_SRC, files: [] };

  for (const f of files) {
    const dst = path.join(FIX, ...f.rel.split('/'));
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.writeFile(dst, f.buf);

    // 自检：手写的 PNG 编码器必须能被自己解回来，否则合成素材本身就是坏的。
    // 只对正常样本做（`edge/broken.png` 故意是坏字节，解不开才是对的）。
    if (/\.png$/i.test(f.rel) && f.meta.kind !== 'broken' && f.meta.expect) {
      const back = decodePNG(f.buf);
      if (back.width !== f.meta.expect.w || back.height !== f.meta.expect.h) {
        throw new Error(`fixtures 自检失败：${f.rel} 解出 ${back.width}x${back.height}，期望 ${f.meta.expect.w}x${f.meta.expect.h}`);
      }
    }

    manifest.files.push({
      rel: f.rel,
      size: f.buf.length,
      sha256: sha256(f.buf),
      ...f.meta,
    });
  }

  for (const r of real) {
    if (NO_REAL) break;
    manifest.files.push({ rel: r.rel, size: r.meta.size, sha256: r.meta.sha256, ...r.meta });
  }

  // 目录树清单（供「空目录也要被列出」这类断言使用）
  const dirs = new Set();
  for (const f of manifest.files) {
    const parts = f.rel.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  manifest.dirs = [...dirs].sort();

  await fsp.writeFile(path.join(FIX, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const byKind = {};
  for (const f of manifest.files) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  console.log(`fixtures 生成完成：${manifest.files.length} 个文件 -> ${FIX}`);
  console.log('  分类：', Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('  真实素材：', manifest.files.filter((f) => f.real).length, NO_REAL ? '(已跳过)' : `来自 ${REAL_SRC}`);
}

// Windows 下 import.meta.url 形如 file:///F:/... ，而 process.argv[1] 是 F:\... ，
// 直接拼字符串比不出来（曾因此让整个生成器静默不执行），必须走 pathToFileURL。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('生成失败：', err);
    process.exit(1);
  });
}

export { buildSynthetic, REAL_SRC, FIX };

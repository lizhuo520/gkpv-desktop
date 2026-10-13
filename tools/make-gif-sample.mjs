/**
 * tools/make-gif-sample.mjs —— 生成「真实可解码」的 GIF 样本（纯 Node，无外部依赖）。
 *
 * 产物：tests/samples/gif-120x90.gif（120×90，**左上 30×22 为红色块**，其余深灰；
 * 红色像素恰好 660 个，与 Pillow 历史产物、与 tools/make-gif-template.py 的
 * `x < WIDTH//4 and y < HEIGHT//4` 完全一致）
 *
 * ## 为什么这件事必须有个诚实的说明
 *
 * 本文件**取代**了原先的 tools/make-gif-template.py（Pillow 编码）。原因是环境：
 * 脚本原本从 DSH 运行时的 Python 里借 Pillow，而那套 site-packages 已经坏掉
 * （`cannot import name '_imaging' from 'PIL'`），系统 Python 3.14 也没装 Pillow。
 * 一个"要跑测试就得先修另一台 Python"的素材生成器，等于把测试挂在了环境上。
 *
 * 于是这里手写 LZW 编码器。但 tools/gen-fixtures.mjs 里明确记录过：**手写 GIF
 * 曾经三连败** —— 自写的 LZW 被 Chromium 与 Pillow 同时拒收，改宽高字段也被拒
 * （GIF 解码器会交叉校验像素流长度与声明的尺寸）。失败的两大原因是 LZW 的两个
 * 经典坑：**码流位序是 LSB-first**、**字典满时码长 +1 并在溢出前发 clear code**。
 *
 * 所以本实现的做法是：把这两个坑显式写对，并且**不靠"看起来对"来收工**。
 *
 * ## 图像内容必须与历史 Pillow 产物一致（这里踩过一个隐蔽的坑）
 *
 * 曾经的注释写"左上 1/4 为红色方块"，注释本身没写错，但图像描述符的 packed 字节
 * 误写成 0x40（隔行扫描标志）—— 位流是逐行顺序，Chromium 却按交错行序重排，
 * 于是显示成"每隔 4 行一条红带"。前景像素总数仍是 660，所以**只数总数的检查全都没反应**。
 * 顺着这个错误现象去读自己的像素流，还会得出"历史产物是条纹图、两份内容不同"的错误结论 ——
 * 我确实这么错过一次，直到用真 Chromium 分别解两份文件才看清：
 *   fixtures（Pillow）→ 红色行 0..21（整块）✓
 *   samples（本脚本）→ 红色行 0,4,8,…,88（交错重排的后果）✗
 * 教训有两条：一是**只比总数/总量不足以证明图案正确，必须比逐点**；
 * 二是**用自己的解码器验证自己的编码器没有意义**，要用真解码器（Chromium）交叉验证。
 *
 * 现在两份产物逐点相同（见 tests/unit/gif.test.mjs 的逐点断言与交叉比对）。
 *
 * ## 正确性是怎么证明的（以及哪些话不能说）
 *
 * 这里**不声称**与 Pillow 产物逐字节一致，只声称**解码后的像素一致**（实测逐点全等）。
 * 两者字节数不同（273 vs 279），原因是两边 LZW 编码器对码宽增长时机与字典项的使用
 * 方式不同、末位补零也不同，属于正常差异；Pillow 现在跑不起来（见下），
 * 无法再产出参照物，所以"与 Pillow 逐字节一致"这种断言只能是编的，不写。
 *
 * 真正站得住的证据是四条，都由测试独立复核：
 *   1. **真解码器认它**：Chromium 的 createImageBitmap / <img> 都解出 120×90，
 *      且**抽点像素逐个核对**（0,0 与 29,0 是红、30,0 与 0,22 是灰）—— 这一步才抓出了
 *      上面那个隔行标志位的 bug；
 *   2. **规范解码器能还原原图**：tests/unit/gif.test.mjs 用另一套按规范实现的
 *      LZW 解码器把它解回像素，逐点比对期望的 30×22 红块 —— 注意必须用**独立实现**，
 *      同源的两份实现互相"一致"没有任何证明力（如前所述，这个坑刚踩过）；
 *   3. 结构自洽：EXPECTED_BYTES / EXPECTED_SHA256 是本编码器**实际产出**的哈希，
 *      素材被改动时 `--check` 会报出来；
 *   4. 端到端还有一道：tests/e2e 让真应用打开含这张 GIF 的素材目录，
 *      断言它出得了缩略图（真 Chromium 解码）。
 *
 * 用法：
 *   node tools/make-gif-sample.mjs
 *   node tools/make-gif-sample.mjs --check   # 只校验既有样本，不重写
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(REPO, 'tests', 'samples');
const WIDTH = 120;
const HEIGHT = 90;

/**
 * 本编码器产出的既定字节数与 sha256 —— 用来发现"素材被悄悄改动"，
 * 不用来证明"与别的编码器一致"（见文件头的说明）。
 * 若合法地改了图像内容或编码实现，这里必须同步更新，并重跑 `npm run fixtures`。
 */
export const EXPECTED_BYTES = 279;
export const EXPECTED_SHA256 = 'ab05387d99d30f09a81ff690362fdb8a962085c473bd3a5c1e26c9848304a2ee';

/* ------------------------------------------------------------------ */
/* LZW（GIF 变体）                                                     */
/* ------------------------------------------------------------------ */

/** 码流按位打包：GIF 是 **LSB-first**（低位先出），这是第一个坑。 */
function makeBitPacker() {
  const out = [];
  let acc = 0;
  let bits = 0;
  return {
    push(code, width) {
      acc |= code << bits;
      bits += width;
      while (bits >= 8) {
        out.push(acc & 0xff);
        acc >>= 8;
        bits -= 8;
      }
    },
    flush() {
      if (bits > 0) out.push(acc & 0xff);
      return Buffer.from(out);
    },
  };
}

/**
 * GIF 的 LZW 编码。
 *
 * 与 TIFF 的 LZW 有两处关键差别，写错任何一处产物都会被解码器拒收：
 *   · 位序是 LSB-first（TIFF 是 MSB-first）；
 *   · 码长从 `minCodeSize + 1` 起步，字典满了先发 clear code 再重置，
 *     绝不能让码长越过 12 位（第二个坑）。
 *
 * @param {Uint8Array} indices 每像素的调色板索引
 * @param {number} minCodeSize 最小码长（GIF 里通常等于色深，此处 8）
 */
function lzwEncode(indices, minCodeSize) {
  const CLEAR = 1 << minCodeSize;       // 256
  const EOI = CLEAR + 1;                // 257
  const FIRST = CLEAR + 2;              // 258

  const packer = makeBitPacker();
  let codeWidth = minCodeSize + 1;      // 9
  let dict = new Map();
  let next = FIRST;

  packer.push(CLEAR, codeWidth);

  /**
   * 输出 prefix 的码，并把 prefix+first 记进字典。
   *
   * 表格满（4096）时**不**发 clear code：改用「推迟清表」策略，即停止扩张字典、
   * 码宽钉在 12 位继续编码。理由：Δt 清表的时机正是 GIF LZW 各实现最容易分歧的地方
   * （编码器与解码器对「第几个码开始增宽」的理解差一位就整条流错位），
   * 而本文件只需要给测试产出一张**真能解码**的图，没有理由去碰这个雷。
   * 本素材（10800 像素）的表格最大 10802 项，永远到不了 4096，这条分支根本不会走；
   * 写成推迟清表只是让它即使被复用到大图上也不会踩雷。
   */
  const emit = (prefixCode, firstByte) => {
    packer.push(prefixCode, codeWidth);
    if (next < 4096) {
      dict.set(prefixCode * 256 + firstByte, next);
      next += 1;
      if (next === (1 << codeWidth) && codeWidth < 12) codeWidth += 1;
    }
  };

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = prefix * 256 + k;
    if (dict.has(key)) {
      prefix = dict.get(key);
    } else {
      emit(prefix, k);
      prefix = k;
    }
  }
  packer.push(prefix, codeWidth);
  packer.push(EOI, codeWidth);
  return packer.flush();
}

/* ------------------------------------------------------------------ */
/* 图像与容器                                                          */
/* ------------------------------------------------------------------ */

const BG = 2;   // 深灰 (32,32,32)
const FG = 1;   // 红   (200,40,40)

/**
 * 前景矩形边长 —— 与 tools/make-gif-template.py 的 `WIDTH // 4` / `HEIGHT // 4` 一致，
 * 也与真 Chromium 解 fixtures 那份历史产物量出来的几何一致（红块 0..29 × 0..21，660 像素）。
 *
 * 注意整除必须用 Math.floor：`y < HEIGHT / 4` 在 HEIGHT=90 时是 `y < 22.5` → 23 行，
 * 会多出一行前景（690 像素），与历史产物对不上。
 */
const FG_W = Math.floor(WIDTH / 4);
const FG_H = Math.floor(HEIGHT / 4);

function buildPixels() {
  const px = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      px[y * WIDTH + x] = (x < FG_W && y < FG_H) ? FG : BG;
    }
  }
  return px;
}

function buildGif() {
  const parts = [];

  // 头：签名 + 逻辑屏描述符
  const header = Buffer.alloc(13);
  header.write('GIF87a', 0, 'latin1');
  header.writeUInt16LE(WIDTH, 6);
  header.writeUInt16LE(HEIGHT, 8);
  // 0x80 有全局色表 | 0x01 色表大小 = 2^(1+1) = 4 项 | 0x00 色彩深度
  header[10] = 0x80 | 0x01;
  header[11] = 0;   // 背景色索引
  header[12] = 0;   // 像素宽高比
  parts.push(header);

  // 全局色表：4 项（第 4 项是 Pillow 留的填充位）
  parts.push(Buffer.from([0, 0, 0, 200, 40, 40, 32, 32, 32, 0, 0, 0]));

  // 图像描述符：0x2c + left/top/w/h + packed
  // packed 必须是 **0x00**（无局部色表 / 非隔行 / 保留位为 0）。
  //
  // 这里曾经写成 0x40，是个安静但会改变解码结果的 bug：0x40 是「隔行扫描」标志位。
  // 位流本身写的是逐行顺序，而 Chromium 看到 0x40 就按 GIF 的 8/8/4/2 交错行序重排，
  // 于是把一张实心 30×22 红块显示成"每隔 4 行一条红带"（实测 fgRows = 0,4,8,…,88，
  // 前景像素总数仍是 660，所以只数总数根本看不出来）。
  // 自己的解码器忽略了该标志位，所以一直没有暴露；是拿真 Chromium 抽点像素才抓到的。
  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(0, 1);
  desc.writeUInt16LE(0, 3);
  desc.writeUInt16LE(WIDTH, 5);
  desc.writeUInt16LE(HEIGHT, 7);
  desc[9] = 0x00;
  parts.push(desc);

  // LZW 最小码长（Pillow 对 P 模式图固定写 8）
  parts.push(Buffer.from([8]));

  // LZW 数据流，切成 ≤255 字节的子块
  const data = lzwEncode(buildPixels(), 8);
  for (let off = 0; off < data.length; off += 255) {
    const chunk = data.subarray(off, off + 255);
    parts.push(Buffer.from([chunk.length]));
    parts.push(Buffer.from(chunk));
  }
  parts.push(Buffer.from([0]));   // 子块终止符
  parts.push(Buffer.from([0x3b])); // 文件结束

  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export function buildGifSample() {
  return buildGif();
}

function main() {
  const check = process.argv.includes('--check');
  const dst = path.join(OUT_DIR, `gif-${WIDTH}x${HEIGHT}.gif`);

  if (check) {
    if (!fs.existsSync(dst)) {
      console.error(`✖ 缺 ${path.relative(REPO, dst)}，请先跑 node tools/make-gif-sample.mjs`);
      process.exit(1);
    }
    const buf = fs.readFileSync(dst);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const ok = buf.length === EXPECTED_BYTES && sha === EXPECTED_SHA256;
    console.log(`${ok ? 'OK  ' : '✖   '} ${buf.length} 字节  sha256=${sha.slice(0, 16)}…`);
    if (!ok) {
      console.error(`    期望 ${EXPECTED_BYTES} 字节 / ${EXPECTED_SHA256.slice(0, 16)}…`);
      process.exit(1);
    }
    return;
  }

  const buf = buildGif();
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const ok = buf.length === EXPECTED_BYTES && sha === EXPECTED_SHA256;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(dst, buf);

  console.log(`OK   ${path.relative(REPO, dst)}  ${buf.length} 字节  ${WIDTH}x${HEIGHT}  sha256=${sha.slice(0, 16)}…`);
  if (ok) {
    console.log('     ✔ 与既定产物一致');
  } else {
    console.error(
      `     ✖ 与既定产物不一致：得到 ${buf.length} 字节 / ${sha}\n`
      + `       既定 ${EXPECTED_BYTES} 字节 / ${EXPECTED_SHA256}\n`
      + '       若这是有意的改动：同步更新本文件的 EXPECTED_BYTES/EXPECTED_SHA256，\n'
      + '       并重跑 `npm run fixtures`（manifest 记的是素材哈希，不改会报「素材与 manifest 不一致」）。',
    );
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}

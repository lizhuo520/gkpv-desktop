/**
 * tests/unit/gif.test.mjs —— GIF 素材的独立验证。
 *
 * ## 为什么这个文件必须存在
 *
 * `tests/samples/gif-120x90.gif` 是**手写 LZW 编码器**（tools/make-gif-sample.mjs）产出的。
 * 手写 LZW 在本项目翻过车，而且踩的坑很有代表性：
 *
 *   1. 第一版被 Chromium 与 Pillow 同时拒收；
 *   2. 第二版能解码、像素总数也对（660 个前景像素），但**图案是错的** ——
 *      图像描述符的 packed 字节误写成 0x40（隔行扫描标志），Chromium 于是把逐行顺序的
 *      位流按 8/8/4/2 交错行序重排，实心红块被显示成"每隔 4 行一条红带"。
 *      因为前景像素**总数不变**，所有只看总数的检查都毫无反应；
 *      而我拿自己的解码器去比对（它忽略了该标志位）又强化了"没问题"的错觉。
 *      最后是真 Chromium 抽点像素才看出来：红行 0,4,8,…,88 vs 期望 0..21。
 *
 * 所以这里刻意做三件**独立**的事：
 *   1. 用**按 GIF 规范另写一遍**的解码器把像素解回来，逐点对期望图案；
 *   2. 断言打包字节里的隔行标志位必须是 0 —— 这一条专门盯上面那个 bug，
 *      它不会体现在任何"像素总数/哈希"断言之外的地方；
 *   3. 与 Pillow 的历史产物（tests/fixtures）交叉比对，要求**逐点完全相同** ——
 *      这是唯一能证明"两份不同来源的编码器画的是同一张图"的办法。
 *
 * 真 Chromium 侧的解码验证在端到端用例里（应用打开含该素材的目录要出缩略图）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE = path.join(ROOT, 'tests', 'samples', 'gif-120x90.gif');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'basic', 'gif-120x90.gif');
/** 冻结的 Pillow 参照物（唯一的外部对照，只能用 npm run gif-reference 复现）。 */
const REFERENCE = path.join(ROOT, 'tests', 'samples', 'reference', 'pillow-gif-120x90.gif');
const REFERENCE_BYTES = 273;
const REFERENCE_SHA256 = '6a96068a0520170d8d56354d888e0c27a34b6fa5e58469ad133277d26902d6af';

const W = 120;
const H = 90;
const FG_W = Math.floor(W / 4);   // 30
const FG_H = Math.floor(H / 4);   // 22 —— 注意是 22 不是 23（`y < H/4` 会给出 22.5 → 23 行）
const FG_EXPECTED = FG_W * FG_H;  // 660

/* ------------------------------------------------------------------ */
/* 容器解析                                                            */
/* ------------------------------------------------------------------ */

function parseGif(buf) {
  const sig = buf.toString('latin1', 0, 6);
  assert.ok(sig === 'GIF87a' || sig === 'GIF89a', `签名应是 GIF87a/GIF89a，实际 ${JSON.stringify(sig)}`);

  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  const hasGct = (packed & 0x80) !== 0;
  const gctCount = hasGct ? 2 ** ((packed & 7) + 1) : 0;

  let off = 13;
  const palette = [];
  for (let i = 0; i < gctCount; i += 1) {
    palette.push([buf[off], buf[off + 1], buf[off + 2]]);
    off += 3;
  }

  let interlace = null;
  let minCodeSize = null;
  const blocks = [];

  while (off < buf.length) {
    const marker = buf[off];
    if (marker === 0x3b) { off += 1; break; }              // trailer
    if (marker === 0x21) {                                  // 扩展块：跳过
      let p = off + 2;
      while (buf[p] !== 0) p += 1 + buf[p];
      off = p + 1;
      continue;
    }
    if (marker === 0x2c) {                                  // 图像描述符
      const ip = buf[off + 9];
      interlace = (ip & 0x40) !== 0;
      let p = off + 10;
      if (ip & 0x80) p += 3 * 2 ** ((ip & 7) + 1);          // 局部色表：跳过
      minCodeSize = buf[p];
      p += 1;
      while (buf[p] !== 0) { blocks.push(buf.subarray(p + 1, p + 1 + buf[p])); p += 1 + buf[p]; }
      off = p + 1;
      continue;
    }
    assert.fail(`遇到未知块标记 0x${marker.toString(16)} @${off}`);
  }

  return { sig, width, height, palette, interlace, minCodeSize, data: Buffer.concat(blocks), tail: buf.length - off };
}

/* ------------------------------------------------------------------ */
/* 规范 LZW 解码（与编码器不同源的独立实现）                            */
/* ------------------------------------------------------------------ */

/**
 * GIF LZW 解码。
 *
 * 两个参数是刻意留的「坑位开关」，因为 GIF LZW 各实现对这两处的理解差一位就会整条流错位：
 *   · growSprite：遇到 `code === next` 的 KwKwK 情形（表里还没有这个码）时，是否也占一个表位；
 *   · incAtFirst：增宽阈值用 `next === (1 << width)` 还是 `(1 << width) + 1`。
 *
 * 实测（.acp-gifdbg.mjs，两份素材 × 三种参数组合）：
 *   growSprite=false → 两份素材都在只输出 3 个像素后 ended=invalid（code=259, next=258）；
 *   growSprite=true  → 两份素材都 ended=eoi、各 10800 像素、各 660 个前景像素。
 * 所以**默认必须是 true**：遇到 `code === next` 的 KwKwK 情形，必须把这个码补进表里
 * （entry = prev + prev[0]），否则下一步读到的下一个码就比表大，解不出 EOI。
 * incAtFirst 取哪个都不影响结果。
 *
 * 注意这里曾经写反过：注释声称"必须 growSprite=false"，于是两份素材全部解失败。
 * 教训 —— 注释里那句"实测"必须能对应到可复现的探针输出，不能凭印象写。
 */
function lzwDecode({ minCodeSize, data }, opt = {}) {
  const { growSprite = true, incAtFirst = true } = opt;
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;

  const bits = [];
  {
    let acc = 0;
    let n = 0;
    for (const b of data) {
      acc |= b << n;
      n += 8;
      while (n > 0) { bits.push(acc & 1); acc >>= 1; n -= 1; }
    }
  }

  let width = minCodeSize + 1;
  let pos = 0;
  let next = clear + 2;
  let prev = null;
  let table = new Map();
  const reset = () => {
    table = new Map();
    for (let i = 0; i < clear; i += 1) table.set(i, [i]);
    next = clear + 2;
    width = minCodeSize + 1;
    prev = null;
  };
  reset();

  const threshold = () => (incAtFirst ? (1 << width) : (1 << width) + 1);
  const out = [];
  while (pos + width <= bits.length) {
    let code = 0;
    for (let i = 0; i < width; i += 1) code |= bits[pos + i] << i;
    pos += width;

    if (code === clear) { reset(); continue; }
    if (code === eoi) return { indices: out, ended: 'eoi' };

    let entry;
    let isSprite = false;
    if (table.has(code)) entry = table.get(code);
    else if (code === next && prev) { entry = [...prev, prev[0]]; isSprite = true; }
    else return { indices: out, ended: 'invalid', code, next, width };

    out.push(...entry);
    // 规范要求：KwKwK（新码）那条表项由 encoder 与 decoder 在同一步各自隐含建立，
    // **不额外占一个表位**。多占一位就会一路错位到 EOI（实测：两份素材都必须跳过）。
    if (prev && next < 4096 && (growSprite || !isSprite)) {
      table.set(next, [...prev, entry[0]]);
      next += 1;
      // 增宽判定必须与建表绑定：没建表就不该增宽。
      // （第一版把这两句拆开、无条件判定，结果第一个码就报 invalid —— 码长提前扩了一位。）
      if (next >= threshold() && width < 12) width += 1;
    }
    prev = entry;
  }
  return { indices: out, ended: 'bits' };
}

/** 交错（interlace）行序：GIF 把行按 8/8/4/2 分组交错存放。 */
function deinterlace(indices, width, height) {
  const out = new Array(indices.length);
  const passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
  // src 单独计数：源数据是"按 pass 顺序连续存放的行"，必须顺序往后读；
  // 曾经写成 out[y*width+x] = indices[src] 且 src 与 y 共用同一个下标，
  // 结果每个 pass 的行都读到了错误的源行（前景像素从 660 变 2640），
  // 而且非交错路径因为 width==row 恰好看不出问题。
  let src = 0;
  for (const [start, step] of passes) {
    for (let y = start; y < height; y += step) {
      for (let x = 0; x < width; x += 1) out[y * width + x] = indices[src + x];
      src += width;
    }
  }
  return out;
}

/** 期望图案：左上 30×22 红（索引 1），其余深灰（索引 2）。 */
function wantAt(x, y) { return (x < FG_W && y < FG_H) ? 1 : 2; }

/** 把解出来的像素与期望图案逐点比，返回首个不一致处的描述（全对则 null）。 */
function firstMismatch(px) {
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      if (px[i] !== wantAt(x, y)) {
        return { i, x, y, want: wantAt(x, y), got: px[i] };
      }
    }
  }
  return null;
}

/** 前景行的 y 列表，用来发现"红行隔 4 行一条"这类重排错误。 */
function fgRows(px) {
  const rows = [];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) if (px[y * W + x] === 1) { rows.push(y); break; }
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

test('gif 素材：冻结的 Pillow 参照物仍在，且未被覆盖', () => {
  // 这条断言是为了防一次**真实发生过且不可逆**的事故：跨编码器比对的参照物
  // （tests/fixtures/basic/gif-120x90.gif，源自 Pillow）被 `npm run fixtures`
  // 覆盖成了手写编码器的副本，比对随即退化成"自己跟自己比"、零证明力；
  // 而那份 273 字节的文件当时从未入库，覆盖即彻底消失。
  //
  // 现在参照物有两道防线：
  //   1. 这里——它必须存在、且哈希是登记值（被覆盖会立刻报错）；
  //   2. tools/gen-fixtures.mjs 的 sampleFixture 只从 reference/ 复制它，
  //      生成器自身不会重写 reference/。
  // 复现方式（丢失时）：npm run gif-reference —— 需要一份可用的 Pillow，
  // 用 tools/make-gif-template.py 的原始参数可逐字节重建（已实测）。
  assert.ok(fs.existsSync(REFERENCE),
    `冻结参照物丢失：${path.relative(ROOT, REFERENCE)}\n`
    + '  这是唯一的外部对照（Pillow 产物），丢失后跨编码器验证就没有意义了。\n'
    + '  复现：python -m pip install --target .pylibs Pillow; npm run gif-reference');

  const buf = fs.readFileSync(REFERENCE);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  assert.equal(buf.length, REFERENCE_BYTES,
    `参照物字节数应是 ${REFERENCE_BYTES}，实际 ${buf.length} —— 说明它被别的编码器覆盖了`);
  assert.equal(sha, REFERENCE_SHA256, '参照物哈希与登记值不符（被改写或版本漂移）');

  // fixture 必须正是这份参照物的副本；若变成别的字节，跨编码器比对就失去了对照
  const fx = fs.readFileSync(FIXTURE);
  assert.equal(crypto.createHash('sha256').update(fx).digest('hex'), REFERENCE_SHA256,
    'fixtures/basic/gif-120x90.gif 不再是 Pillow 参照物的副本 —— '
    + '重跑 npm run fixtures；若仍不对，检查 gen-fixtures.mjs 里 sampleFixture 的来源');

  // 反过来也必须成立：手写样本与参照物**确实不同源**，否则比对无意义
  assert.notEqual(crypto.createHash('sha256').update(fs.readFileSync(SAMPLE)).digest('hex'),
    REFERENCE_SHA256,
    'samples 与参照物字节完全相同 —— 两份"独立"产物其实是同一份，跨编码器验证失效');
});

test('gif 素材：容器结构合法（尺寸 / 全局色表 / 无多余尾部）', () => {
  const buf = fs.readFileSync(FIXTURE);
  const g = parseGif(buf);
  assert.equal(g.width, W, `逻辑屏宽应是 ${W}`);
  assert.equal(g.height, H, `逻辑屏高应是 ${H}`);
  assert.equal(g.palette.length, 4, '全局色表应是 4 项（Pillow 与手写编码器都是这个结构）');
  assert.equal(g.minCodeSize, 8, 'LZW 最小码长应是 8');
  assert.equal(g.tail, 0, `文件尾部不应有多余字节，实际剩 ${g.tail}`);
  // Pillow 这份历史产物**确实**声明了隔行（packed bit6 = 1，即磁盘上的 0x40），
  // 所以这里不能断言 false（曾经就是这么写错的，导致一条永远失败的断言）。
  // 它必须为 true 这件事本身是可验证的：位流按 8/8/4/2 存放，deinterlace 之后才是画面。
  assert.equal(g.interlace, true,
    'Pillow 历史产物声明隔行（描述符 packed bit6=1）；若变成 0，说明这份素材被换掉了，'
    + '请同步更新本条断言与"手动编码产物与 Pillow 产物逐点相同"里的 deinterlace 假设');
  // 调色板：索引 1 是前景红、索引 2 是背景深灰、索引 0 是黑（未使用）
  assert.deepEqual(g.palette[0], [0, 0, 0]);
  assert.deepEqual(g.palette[1], [200, 40, 40], '索引 1 应是前景红 (200,40,40)');
  assert.deepEqual(g.palette[2], [32, 32, 32], '索引 2 应是背景深灰 (32,32,32)');

  // 声明隔行就必须真的按隔行解开：Pillow 这份 deinterlace 后应是连续 0..21 行红块。
  // （Chromium 侧已实测同样结果：fgRowList = 0..21 连续。）
  const r = lzwDecode(g);
  assert.equal(r.ended, 'eoi', `Pillow 产物应解到 EOI，实际 ${r.ended}`);
  const px = deinterlace(r.indices, W, H);
  assert.equal(firstMismatch(px), null, 'Pillow 产物 deinterlace 后应是 30×22 红块');
  assert.deepEqual(fgRows(px), Array.from({ length: FG_H }, (_, i) => i),
    'Pillow 产物 deinterlace 后前景行应是连续的 0..21');
});

test('gif 素材：samples 那道光写编码器产物也不是隔行的', () => {
  const g = parseGif(fs.readFileSync(SAMPLE));
  assert.equal(g.width, W);
  assert.equal(g.height, H);
  assert.equal(g.minCodeSize, 8);
  assert.equal(g.interlace, false,
    '手写编码器必须把描述符 packed 里的 0x40 去掉 —— 这个 bug 曾经让 Chromium 解出交错图案');
});

test('gif 素材：规范解码器解到 EOI，像素逐点等于 30×22 红块', () => {
  const g = parseGif(fs.readFileSync(SAMPLE));
  const r = lzwDecode(g);
  assert.equal(r.ended, 'eoi', `应解到 EOI，实际 ${r.ended}`
    + (r.ended === 'invalid' ? `（码 ${r.code} @宽${r.width}，表长度 ${r.next}）` : ''));

  const px = g.interlace ? deinterlace(r.indices, W, H) : r.indices;
  assert.equal(px.length, W * H, `像素数应是 ${W * H}，实际 ${px.length}`);

  const bad = firstMismatch(px);
  assert.equal(bad, null, bad === null ? '' : `首个不一致的像素 @(${bad.x}, ${bad.y})：`
    + `期望索引 ${bad.want}，实际 ${bad.got}；前景块应是 ${FG_W}×${FG_H}(左上角)`);

  const fg = px.filter((v) => v === 1).length;
  assert.equal(fg, FG_EXPECTED, `前景像素数应是 ${FG_W}×${FG_H}=${FG_EXPECTED}，实际 ${fg}`);

  // 总数对但图案错是真实发生过的 bug（隔行标志位），所以额外断言行分布是连续的
  const rows = fgRows(px);
  assert.equal(rows.length, FG_H, `前景行应是 ${FG_H} 行，实际 ${rows.length}`);
  assert.deepEqual(rows, Array.from({ length: FG_H }, (_, i) => i),
    `前景行应是连续的 0..${FG_H - 1}；实测 ${rows.join(',')} `
    + '（若看到 0,4,8,… 那就是隔行重排，不是图案问题）');

  // 旧版解码器忽略隔行位，也能用【原始顺序】读出正确的红块，
  // 所以这里额外固定一个前提：本素材确实不该被重排
  assert.equal(g.interlace, false, '前置条件：本素材必须是逐行存放，上述"原始顺序=正确顺序"才成立');
});

test('gif 素材：手写编码器可复现磁盘上的字节（素材没有漂）', async () => {
  const mod = await import('../../tools/make-gif-sample.mjs');
  const built = mod.buildGifSample();
  const onDisk = fs.readFileSync(SAMPLE);
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  assert.equal(built.length, onDisk.length,
    `编码器产出 ${built.length} 字节，磁盘上 ${onDisk.length} 字节`);
  assert.equal(sha(built), sha(onDisk),
    '编码器产出与 tests/samples 里的文件不一致：要么改了编码器（同步 EXPECTED_*），'
    + '要么这个文件被手工改过（重跑 node tools/make-gif-sample.mjs）');
  // 导出的 EXPECTED_* 也必须与真实产物一致，否则 --check 会给出误导性的失败
  assert.equal(mod.EXPECTED_BYTES, built.length, 'EXPECTED_BYTES 与真实产物不符');
  assert.equal(mod.EXPECTED_SHA256, sha(built), 'EXPECTED_SHA256 与真实产物不符');
});

test('gif 素材：手动编码产物与 Pillow 参照物逐点相同（只允许字节数不同）', () => {
  const a = parseGif(fs.readFileSync(SAMPLE));
  const b = parseGif(fs.readFileSync(FIXTURE));

  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  assert.deepEqual(a.palette, b.palette, '两张图调色板应一致');
  assert.equal(a.interlace, false, '手写编码器产物是逐行存放（packed bit6=0）');
  assert.equal(b.interlace, true, 'Pillow 历史产物声明隔行（packed bit6=1）');

  const ra = lzwDecode(a);
  const rb = lzwDecode(b);
  assert.equal(ra.ended, 'eoi', `samples 应解到 EOI，实际 ${ra.ended}`);
  assert.equal(rb.ended, 'eoi', `fixtures 应解到 EOI，实际 ${rb.ended}`);
  assert.equal(ra.indices.length, rb.indices.length);

  // 逐点比较必须在**显示坐标**下做：Pillow 那份的位流是 8/8/4/2 交错存放的，
  // 不 deinterlace 直接比会看到"0,1,2,12,13,14…"这种行序，误判成图案不同。
  const pa = a.interlace ? deinterlace(ra.indices, W, H) : ra.indices;
  const pb = b.interlace ? deinterlace(rb.indices, W, H) : rb.indices;

  const bad = firstMismatch(pb);
  assert.equal(bad, null, bad === null ? '' : 'Pillow 历史产物本身应解出 30×22 红块，'
    + `实测首个不一致 @(${bad.x}, ${bad.y})：期望 ${bad.want}，实际 ${bad.got}`);

  // 两份文件字节数不同（编码器不同），但解码结果必须逐点相同
  assert.notEqual(fs.statSync(SAMPLE).size, fs.statSync(FIXTURE).size,
    '若两者字节数变得相同，说明 fixtures 里的历史产物被覆盖了：请更新本断言与注释');
  const diff = pa.findIndex((v, i) => v !== pb[i]);
  assert.equal(diff, -1, diff < 0 ? '' : `两份产物第 ${diff} 个像素不同`
    + `（@(${diff % W}, ${Math.floor(diff / W)})：samples=${ra.indices[diff]} fixtures=${rb.indices[diff]}）`
    + ' —— 说明其中一个编码器画错了图');
});

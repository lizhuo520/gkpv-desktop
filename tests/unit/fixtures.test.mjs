/**
 * tests/unit/fixtures.test.mjs —— 测试素材自身的完整性与「不许无声漂移」检查。
 *
 * 为什么素材也要测：这些素材是**手写编码器**产出的（PNG/BMP/JPEG 自己拼字节、
 * GIF 借 Pillow、WebP 借 Chromium）。手写编码器一旦改错，后续所有「缩略图能出来」
 * 的断言都会假绿或者假红，而且很难看出是素材的问题还是代码的问题 ——
 * 本项目就在 JPEG 的 DHT 段长上栽过一次，症状是「全部 JPEG 都解不出来」。
 * 所以这里把「素材清单必须自洽」立成硬门槛：
 *   1. manifest 列出的文件必须都在，磁盘上也不许多出没登记的文件；
 *   2. 每个文件的 sha256 / 字节数必须与 manifest 一致（改了素材没重跑生成器就红）；
 *   3. 每张素材都必须声明 decodeVia（怎么验），这是最容易被糊弄过去的字段；
 *   4. 所有「尺寸可解析」的素材，Node 侧解析结果必须等于期望值；
 *   5. Node 侧与渲染层两套尺寸解析器对同一批素材必须给出完全一致的答案。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import { scanHeaderBytes } from '../../desktop/renderer/lib/image-format.js';

const require_ = createRequire(import.meta.url);
const scandir = require_('../../desktop/main/scandir.cjs');

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const SAMPLES = path.join(ROOT, 'tests', 'samples');

const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));

/** 允许出现在 fixtures 里的非素材文件名（不属于 manifest）。 */
const NON_ASSET = new Set(['manifest.json']);

/**
 * real/ 里是从本机相册链接进来的**真实个人照片，不入库**（见 .gitignore），
 * 所以克隆下来的仓库里这些文件不存在，CI 上也不存在（`npm run fixtures -- --no-real`）。
 *
 * 因此凡是涉及 real/ 的判断都必须**先看磁盘**：
 *   - 文件不在 → 如实跳过并打印原因，不能把「文件不在」误报成「素材与 manifest 不一致」，
 *     也不能静默当成通过；
 *   - 文件在 → 该校验的字节数与哈希一个都不能省。
 */
const realRels = new Set(manifest.files.filter((f) => f.real).map((f) => f.rel));
const absOf = (rel) => path.join(FIX, ...rel.split('/'));
const missingReal = [...realRels].filter((r) => !fs.existsSync(absOf(r)));
const presentReal = [...realRels].filter((r) => fs.existsSync(absOf(r)));
const REAL_SKIP =
  missingReal.length > 0
    ? `real/ 里 ${missingReal.length} 个真实照片不在磁盘上 → 涉及它们的校验全部跳过（个人照片不入库；本机跑 npm run fixtures 可重建）`
    : '';

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

test('manifest 结构完整：每条都带 rel/size/sha256/decodeVia', () => {
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'manifest.files 不能为空');
  for (const f of manifest.files) {
    assert.equal(typeof f.rel, 'string', `${f.rel}: rel 必须是字符串`);
    assert.ok(!f.rel.startsWith('/') && !f.rel.includes('\\'), `${f.rel}: rel 必须是相对 POSIX 路径`);
    assert.equal(typeof f.size, 'number', `${f.rel}: 缺 size`);
    assert.equal(typeof f.sha256, 'string', `${f.rel}: 缺 sha256`);
    assert.equal(typeof f.decodeVia, 'string', `${f.rel}: 缺 decodeVia（必须写清用什么方式验证这张素材）`);
    assert.ok(
      ['bitmap', 'bitmap-nosize', 'bitmap-expect-fail', 'svg', 'raw', 'heic-none', 'none'].includes(f.decodeVia),
      `${f.rel}: decodeVia=${f.decodeVia} 不是受支持的值`,
    );
    assert.ok(!f.rel.includes('\uFFFD'), `${f.rel}: 文件名里出现 U+FFFD，说明编码转换坏了`);
  }
});

test('磁盘上的素材与 manifest 一一对应（既不少也不多）', () => {
  const onDisk = walk(FIX).filter((rel) => !NON_ASSET.has(rel)).sort();
  const listed = manifest.files.map((f) => f.rel).sort();
  const missing = listed.filter((r) => !onDisk.includes(r));
  const extra = onDisk.filter((r) => !listed.includes(r));
  // real/ 是唯一允许「登记了但不在磁盘上」的例外（个人照片不入库）；
  // 其它任何缺失都仍是硬失败。
  const missingUnexpected = missing.filter((r) => !realRels.has(r));
  assert.deepEqual(missingUnexpected, [], `manifest 列出了但磁盘上没有：${missingUnexpected.join(', ')}`);
  assert.deepEqual(extra, [], `磁盘上有但 manifest 没登记（改了生成器却忘了重跑？）：${extra.join(', ')}`);
  if (REAL_SKIP) console.log(`  （跳过）${REAL_SKIP}`);
});

test('每个素材的 sha256 与字节数与 manifest 一致', () => {
  const bad = [];
  let checked = 0;
  for (const f of manifest.files) {
    // real/ 不在磁盘上时（个人照片不入库）不能去读，否则 ENOENT 会被当成素材损坏。
    if (!fs.existsSync(absOf(f.rel))) continue;
    const buf = fs.readFileSync(absOf(f.rel));
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== f.sha256) bad.push(`${f.rel}: sha256 ${sha.slice(0, 12)}… ≠ 登记值 ${f.sha256.slice(0, 12)}…`);
    if (buf.length !== f.size) bad.push(`${f.rel}: ${buf.length} 字节 ≠ 登记 ${f.size}`);
    checked += 1;
  }
  assert.ok(checked >= 60, `参与哈希核查的素材太少（只有 ${checked} 个），说明清单缩水了`);
  assert.deepEqual(bad, [], `素材与 manifest 不一致（请重跑 npm run fixtures）：\n${bad.join('\n')}`);
  if (REAL_SKIP) console.log(`  （跳过）${REAL_SKIP}`);
});

test('真实样本目录就位且容器头合法', () => {
  assert.ok(fs.existsSync(SAMPLES), 'tests/samples 必须存在（tools/capture-samples.mjs 的产物）');
  const gif = path.join(SAMPLES, 'gif-120x90.gif');
  assert.ok(fs.existsSync(gif), '缺 tests/samples/gif-120x90.gif（请跑 python tools/make-gif-template.py）');
  assert.equal(fs.readFileSync(gif).subarray(0, 3).toString('latin1'), 'GIF');

  for (const f of manifest.files) {
    if (f.real) continue;
    // 故意坏掉的素材（broken/空文件/文本）本来就没有合法容器头，跳过；
    // 它们要验的是「程序不崩」，不是「文件合法」。
    if (f.decodeVia === 'none') continue;
    if (!/\.(jpe?g|png|gif|webp|bmp)$/i.test(f.rel)) continue;
    if (!fs.existsSync(absOf(f.rel))) continue;   // real/ 里的个人照片可能不在磁盘上
    const buf = fs.readFileSync(absOf(f.rel));
    const rel = f.rel;
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const isGif = buf.subarray(0, 3).toString('latin1') === 'GIF';
    const isWebp = buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    const isBmp = buf.subarray(0, 2).toString('latin1') === 'BM';
    assert.ok(isJpeg || isPng || isGif || isWebp || isBmp, `${rel}: 容器魔数不认识`);
  }
});

test('Node 侧尺寸解析与期望值一致，且与渲染层解析器答案完全相同', () => {
  const mismatches = [];
  const nodeWins = [];
  let checked = 0;
  for (const f of manifest.files) {
    if (!f.expect) continue;
    const buf = fs.readFileSync(path.join(FIX, ...f.rel.split('/')));
    const node = scandir.scanChunks(buf);
    const render = scanHeaderBytes(new Uint8Array(buf));

    // SVG 刻意不在 Node 侧解析（矢量图没有固有像素尺寸，网页版同样是 return null），
    // 所以它只校验渲染层 / <img> 报出的尺寸，Node 侧为 null 是预期行为。
    if (node && f.kind !== 'svg' && (node.width !== f.expect.w || node.height !== f.expect.h)) {
      mismatches.push(`${f.rel}: Node 解出 ${node.width}x${node.height}，期望 ${f.expect.w}x${f.expect.h}`);
    }
    if (f.kind === 'svg' && node !== null) {
      mismatches.push(`${f.rel}: SVG 不应由 Node 侧解析，却得到 ${node.width}x${node.height}`);
    }
    // JPEG 的渲染层解析会按 Orientation 5~8 互换宽高、并回报 o；Node 侧只报原始宽高。
    // 期望值里 w/h 已经是「显示尺寸」，所以两者只有在无方向标记或方向 1~4 时才该相等。
    const needsSwap = f.expect.orientation >= 5;
    if (render && !needsSwap) {
      if (render.w !== f.expect.w || render.h !== f.expect.h) {
        mismatches.push(`${f.rel}: 渲染层解出 ${render.w}x${render.h}，期望 ${f.expect.w}x${f.expect.h}`);
      }
    } else if (render && needsSwap) {
      // 渲染层应已互换
      if (render.w !== f.expect.w || render.h !== f.expect.h) {
        mismatches.push(`${f.rel}: 渲染层未按方向 ${f.expect.orientation} 互换宽高（得到 ${render.w}x${render.h}，期望 ${f.expect.w}x${f.expect.h}）`);
      }
    }
    if (node && render && f.kind === 'image') {
      if (node.width !== render.w || node.height !== render.h) {
        nodeWins.push(`${f.rel}: Node ${node.width}x${node.height} vs 渲染层 ${render.w}x${render.h}`);
      }
    }
    if (node) checked += 1;
  }
  assert.ok(checked >= 30, `参与尺寸核查的素材太少（只有 ${checked} 张），说明清单缩水了`);
  assert.deepEqual(mismatches, [], `尺寸解析与期望不符：\n${mismatches.join('\n')}`);
  assert.deepEqual(nodeWins, [], `Node 与渲染层对同一文件的尺寸判断不同（两套实现必须一致）：\n${nodeWins.join('\n')}`);
});

test('RAW 素材：容器方向与内嵌预览标记齐全', () => {
  const raws = manifest.files.filter((f) => f.kind === 'raw');
  assert.ok(raws.length >= 5, `RAW 素材至少 5 个（覆盖 5 个厂商容器），实际 ${raws.length}`);
  const orientations = new Set(raws.map((f) => f.expect.orientation));
  for (const o of [1, 3, 6, 8]) {
    assert.ok(orientations.has(o), `RAW 素材缺少 orientation=${o} 的用例`);
  }
  for (const f of raws) {
    assert.equal(f.decodeVia, 'raw', `${f.rel}: RAW 必须用 raw 方式验证`);
    assert.equal(f.expect.previewEmbedded, true, `${f.rel}: 应声明有内嵌预览`);
  }
});

test('边界素材齐全：坏图 / 空文件 / HEIC / 无扩展名 / 文本 / 隐藏项', () => {
  const kinds = new Set(manifest.files.map((f) => f.kind));
  for (const k of ['broken', 'heic', 'no-ext', 'text', 'unknown', 'hidden', 'marker']) {
    assert.ok(kinds.has(k), `素材清单缺少 kind=${k} 的边界用例`);
  }
  const empties = manifest.files.filter((f) => f.size === 0);
  assert.ok(empties.length >= 1, '至少要有一个 0 字节文件用例');
  const hidden = manifest.files.filter((f) => f.kind === 'hidden');
  assert.ok(hidden.every((f) => path.basename(f.rel).startsWith('.')), 'hidden 用例的文件名必须以点开头');
});

test('目录清单与文件清单自洽（供「空目录也要列出来」的断言使用）', () => {
  const dirs = new Set();
  for (const f of manifest.files) {
    const parts = f.rel.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  const expected = [...dirs].sort();
  assert.deepEqual(manifest.dirs, expected, 'manifest.dirs 与实际目录结构不一致');
  const emptyDir = manifest.files.find((f) => f.kind === 'marker' || f.rel.includes('empty-dir'));
  assert.ok(emptyDir, '缺少「空目录」用例');
});

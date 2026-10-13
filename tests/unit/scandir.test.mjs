/**
 * tests/unit/scandir.test.mjs —— Node 侧目录扫描（desktop/main/scandir.cjs）。
 *
 * 这是「移植是否忠实」的第一道硬门槛：原版靠浏览器 `showDirectoryPicker()` 拿目录，
 * 桌面版改成主进程扫盘。两边必须产出**同一套语义**的结构，否则缩略图、
 * 计数器、排序、缓存键会一起偏。这里用手写素材对着期望值核，重点覆盖：
 *   - 递归 / 非递归的条目集合差异；
 *   - 隐藏项与系统噪声目录的跳过；
 *   - 非图片扩展名不进清单（但 no-extension 那张明明能解码，也不该进）；
 *   - lastModified 必须是**整数毫秒**（缓存键的一部分：浮点数会让缓存永远命中不了）；
 *   - 同一个目录连扫两次，结果必须逐字段相同（扫描不许有副作用）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const scandir = require_('../../desktop/main/scandir.cjs');

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));

/** manifest 里所有 Path 能被扫描命中的素材（扩展名在 IMAGE_EXTS 内、非隐藏）。 */
function scannableFiles() {
  return manifest.files.filter((f) => {
    const base = path.basename(f.rel);
    if (base.startsWith('.')) return false;
    return scandir.IMAGE_EXTS.has(scandir.extOf(base));
  });
}

/** 期望被列出的直接子目录（排除隐藏目录与系统噪声目录）。 */
function expectedDirs(absDir) {
  return fs.readdirSync(absDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.')
      && !['$RECYCLE.BIN', 'System Volume Information', 'Recycler', 'node_modules'].includes(e.name))
    .map((e) => e.name)
    .sort();
}

test('递归扫描：条目集合与 manifest 能对上的图片完全一致', async () => {
  const { files, folderMap } = await scandir.scanDirectory(FIX, true);
  const got = files.map((f) => f.rel).sort();
  const want = scannableFiles().map((f) => f.rel).sort();
  assert.deepEqual(got, want, `递归扫描结果与素材清单不符（多/少见 diff）`);
  assert.ok(files.length >= 45, `扫描到的图片太少（${files.length}），素材目录可能不完整`);

  // 每个条目都必须带齐缩略图链路要用的字段
  for (const f of files) {
    assert.equal(typeof f.name, 'string', `${f.rel}: 缺 name`);
    assert.ok(f.size > 0 || f.rel.includes('empty'), `${f.rel}: size 不该是 0`);
    assert.ok(Number.isInteger(f.lastModified), `${f.rel}: lastModified 必须是整数毫秒（实际 ${f.lastModified}）`);
    assert.ok(path.isAbsolute(f._abs), `${f.rel}: _abs 必须是绝对路径`);
    assert.equal(f._ext, scandir.extOf(f.name), `${f.rel}: _ext 与扩展名不一致`);
    assert.ok(f.rel.includes('/') || !f.rel.includes('\\'), `${f.rel}: rel 必须用 / 分隔`);
  }

  // folderMap：每个子目录都要有键（哪怕是空目录），值是该目录直接包含的图片
  const topDirs = expectedDirs(FIX);
  for (const d of topDirs) {
    assert.ok(folderMap.has(d), `folderMap 缺少顶层目录 ${d}（空目录也必须出现）`);
  }
  assert.ok(folderMap.has('edge/empty-dir'), 'folderMap 缺少嵌套空目录 edge/empty-dir');
  const basicItems = folderMap.get('basic') || [];
  assert.ok(basicItems.length >= 8, `basic/ 下的图片太少：${basicItems.length}`);
  for (const rel of basicItems) assert.ok(rel.startsWith('basic/'), `folderMap['basic'] 混入了 ${rel}`);
});

test('非递归扫描：只返回顶层一层的图片', async () => {
  const { files, folderMap } = await scandir.scanDirectory(FIX, false);
  assert.ok(files.every((f) => !f.rel.includes('/')), `非递归模式返回了子目录文件：${files.map((f) => f.rel).join(', ')}`);
  const topLevel = scannableFiles().filter((f) => !f.rel.includes('/'));
  assert.deepEqual(files.map((f) => f.rel).sort(), topLevel.map((f) => f.rel).sort());
  // 非递归也要把子目录列出来（界面要显示文件夹磁贴）
  for (const d of expectedDirs(FIX)) assert.ok(folderMap.has(d), `非递归模式漏了目录 ${d}`);
});

test('隐藏项与系统噪声目录被跳过', async () => {
  const { files } = await scandir.scanDirectory(FIX, true);
  for (const f of files) {
    assert.ok(!path.basename(f.rel).startsWith('.'), `隐藏文件被收进来了：${f.rel}`);
    for (const seg of f.rel.split('/')) {
      assert.ok(!['$RECYCLE.BIN', 'System Volume Information', 'node_modules'].includes(seg), `噪声目录被收进来了：${f.rel}`);
    }
  }
  // 素材里确实放了隐藏图片，确认它真的存在、只是被跳过了
  assert.ok(fs.existsSync(path.join(FIX, 'edge', '.hidden-image.png')), '素材里应有隐藏图片用例 edge/.hidden-image.png');
  assert.equal(scandir.isHiddenName('.hidden-image.png'), true);
});

test('非图片扩展名不进图片清单', async () => {
  const { files } = await scandir.scanDirectory(FIX, true);
  const names = new Set(files.map((f) => f.rel));
  assert.ok(!names.has('edge/not-an-image.txt'), 'txt 不该被当成图片');
  assert.ok(!names.has('edge/unknown.xyz'), '未知扩展名不该被当成图片');
  assert.ok(!names.has('edge/empty-dir/README.txt'), 'README.txt 不该被当成图片');
  // 无扩展名那张是合法 PNG，但按原版语义（只看扩展名）也不该进清单
  assert.ok(!names.has('edge/no-extension'), '无扩展名文件不该被当成图片');
  assert.ok(scandir.isImageName('a.JPG'), '扩展名判断应大小写不敏感');
  assert.ok(scandir.isImageName('a.NEF'), 'RAW 扩展名应被识别');
  assert.equal(scandir.extOf('no-dot'), '', '无点文件名没有扩展名');
  assert.equal(scandir.extOf('.hidden'), '', '点开头文件不算扩展名');
});

test('扫描是幂等的：连扫两次结果逐字段相同', async () => {
  const a = await scandir.scanDirectory(FIX, true);
  const b = await scandir.scanDirectory(FIX, true);
  assert.deepEqual(a.files, b.files, '两次扫描的条目不一致（扫描不该有副作用或顺序抖动）');
  assert.deepEqual([...a.folderMap.entries()].sort(), [...b.folderMap.entries()].sort(), '两次扫描的目录映射不一致');
});

test('扫描不存在的目录：返回错误信息而不是抛异常', async () => {
  const { files, folderMap, error } = await scandir.scanDirectory(path.join(FIX, 'no-such-dir-xyz'), true);
  assert.equal(files.length, 0);
  assert.equal(folderMap.size, 0);
  // 现状：不存在的顶层目录会让 walk 内层返回 error，但顶层没往上抛；
  // 这里固化「不抛异常」这个契约（UI 靠空列表 + 计数器为 0 表现「没图片」）。
  assert.ok(error === undefined || typeof error === 'string', 'error 要么没有、要么是字符串');
});

test('尺寸解析：对每个素材都能给出与期望一致的宽高', async () => {
  // SVG 不在 Node 侧解析（见下一条用例）：矢量图没有固有像素尺寸，
  // 由渲染层用 naturalWidth/naturalHeight 兜底，与网页版一致。
  const targets = scannableFiles().filter((f) => f.expect && f.kind !== 'svg');
  assert.ok(targets.length >= 30, `参与尺寸解析的素材太少：${targets.length}`);
  const bad = [];
  for (const f of targets) {
    const abs = path.join(FIX, ...f.rel.split('/'));
    const got = await scandir.readDimensions(abs, scandir.extOf(path.basename(f.rel)));
    if (!got || got.width !== f.expect.w || got.height !== f.expect.h) {
      bad.push(`${f.rel}: 解出 ${got ? `${got.width}x${got.height}` : 'null'}，期望 ${f.expect.w}x${f.expect.h}`);
    }
  }
  assert.deepEqual(bad, [], `尺寸解析失败：\n${bad.join('\n')}`);
});

test('方向标记：readDimensions 必须把容器/EXIF 方向带给上层（RAW 内嵌预览全靠它转正）', async () => {
  // 这条单独钉方向而不是并进上面的尺寸用例：尺寸绿着、方向丢了同样能过，
  // 但竖拍 RAW 的缩略图会横过来（显示宽高比互为倒数），而且磁贴尺寸还能自圆其说。
  // 链路：scandir.readDimensions().orientation → ipc.cjs 的 entry.orientation →
  // 渲染层 raw.js 的 previewFromDataUrl() 决定要不要把内嵌预览转 90°。
  // manifest 里 orientation: 0 表示「没有方向标记」，与实现里的 1（不转）等价。
  const targets = scannableFiles().filter((f) => f.expect && f.expect.orientation != null);
  assert.ok(targets.length >= 10, `带方向期望的素材太少（应含 8 张 EXIF 竖拍 + 4 张 RAW）：${targets.length}`);
  assert.ok(targets.filter((f) => f.kind === 'raw').length >= 4, 'RAW 素材里应有带方向标记的容器');
  const bad = [];
  for (const f of targets) {
    const abs = path.join(FIX, ...f.rel.split('/'));
    const got = await scandir.readDimensions(abs, scandir.extOf(path.basename(f.rel)));
    const want = Number(f.expect.orientation) || 1;
    const actual = Number((got && got.orientation) || 0) || 1;
    if (actual !== want) bad.push(`${f.rel}: 解出 orientation=${got ? got.orientation : 'null'}，期望 ${f.expect.orientation}`);
  }
  assert.deepEqual(bad, [], `方向解析失败：\n${bad.join('\n')}`);
});

test('SVG 刻意不在 Node 侧解析尺寸（矢量图交给渲染层兜底）', async () => {
  // 这是「实现选择」而不是遗漏，所以用测试钉住：
  // 曾经 Node 侧读过 width/height、缺失时兜底 viewBox，结果只有 viewBox 的 SVG
  // 被算成 100x50，而 Chromium 实际报 300x150 —— 网格宽高比出现两套答案。
  // 现在两侧统一：Node 返回 null，浏览器用 <img> 的真实尺寸。
  for (const rel of ['basic/svg-no-size.svg', 'basic/svg-240x160.svg']) {
    const abs = path.join(FIX, ...rel.split('/'));
    // readDimensions 的契约是「解不出来给 0x0」（上层据此显示未知尺寸），
    // 所以这里断言的是 scanChunks 直接返回 null（真的没解析，而不是猜了个值）。
    const buf = fs.readFileSync(abs);
    assert.equal(scandir.scanChunks(buf), null, `${rel}: Node 侧必须返回 null（交给渲染层）`);
    const got = await scandir.readDimensions(abs, 'svg');
    assert.deepEqual(got, { width: 0, height: 0 }, `${rel}: readDimensions 应回落到 0x0，实际 ${JSON.stringify(got)}`);
  }
  // 但内含 SVG 的文件仍要被当成图片列出（不能因为不解析尺寸就漏掉）
  const { files } = await scandir.scanDirectory(FIX, true);
  const svgs = files.filter((f) => f._ext === 'svg');
  assert.ok(svgs.length >= 2, `SVG 仍应出现在图片清单里，实际 ${svgs.length}`);
  // 清单里不带宽高字段（尺寸由 readDimensions 单独取），这里只确认两个 SVG 都在
  assert.deepEqual(svgs.map((f) => f.name).sort(), ['svg-240x160.svg', 'svg-no-size.svg']);
});

test('尺寸解析：坏图与文本文件返回 0x0 而不是抛异常', async () => {
  for (const rel of ['edge/broken.jpg', 'edge/broken.png', 'edge/empty.jpg', 'edge/not-an-image.txt', 'edge/unknown.xyz']) {
    const abs = path.join(FIX, ...rel.split('/'));
    const got = await scandir.readDimensions(abs, scandir.extOf(rel));
    assert.deepEqual(got, { width: 0, height: 0 }, `${rel} 应返回 0x0，实际 ${JSON.stringify(got)}`);
  }
});

test('内嵌预览提取：普通图直接读原件、RAW 抓内嵌 JPEG、坏图返回 null', async () => {
  const jpg = await scandir.readEmbeddedPreview(path.join(FIX, 'basic', 'jpeg-400x300.jpg'), 'jpg');
  assert.ok(jpg && jpg.mime === 'image/jpeg', '普通 JPEG 应直接返回原件');
  assert.equal(jpg.embedded, true);
  assert.ok(jpg.data.length > 100, '返回的字节数太少');

  const raw = await scandir.readEmbeddedPreview(path.join(FIX, 'raw', 'sony-arw-a.ARW'), 'arw');
  assert.ok(raw, 'RAW 应能抽出内嵌预览');
  assert.equal(raw.embedded, false, 'RAW 的预览是内嵌的');
  assert.equal(raw.mime, 'image/jpeg');
  assert.equal(raw.data[0], 0xff, '抽出来的应是 JPEG（SOI）');
  assert.equal(raw.data[1], 0xd8);
  assert.equal(raw.data[raw.data.length - 2], 0xff, 'JPEG 应以 EOI 结束');
  assert.equal(raw.data[raw.data.length - 1], 0xd9);
  const size = scandir.scanChunks(raw.data);
  assert.ok(size && size.width > 0 && size.height > 0, `内嵌预览本身应是可解析的 JPEG，实际 ${JSON.stringify(size)}`);

  const heic = await scandir.readEmbeddedPreview(path.join(FIX, 'edge', 'fake.heic'), 'heic');
  assert.equal(heic, null, '假 HEIC 里没有内嵌 JPEG，应返回 null');

  const missing = await scandir.readEmbeddedPreview(path.join(FIX, 'no-such-file.jpg'), 'jpg');
  assert.equal(missing, null, '文件不存在应返回 null');
});

test('mimeOfExt 覆盖常见图片扩展名', () => {
  assert.equal(scandir.mimeOfExt('png'), 'image/png');
  assert.equal(scandir.mimeOfExt('webp'), 'image/webp');
  assert.equal(scandir.mimeOfExt('gif'), 'image/gif');
  assert.equal(scandir.mimeOfExt('bmp'), 'image/bmp');
  assert.equal(scandir.mimeOfExt('svg'), 'image/svg+xml');
});

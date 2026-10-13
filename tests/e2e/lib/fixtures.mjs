/**
 * 测试素材的「期望值推导」。
 *
 * 两条硬规则（任务书要求）：
 *  1. 期望值必须从 `tests/fixtures/manifest.json` + 真实目录**推导**，不许硬编码张数；
 *  2. 扩展名判定复用产品代码 `desktop/renderer/lib/format.js` 的 IMAGE_EXTS，
 *     不另抄一份（抄一份就会和生产悄悄分叉）。
 *
 * 扫描规则与 `desktop/main/scandir.cjs` 对齐：跳过以 `.` 开头的隐藏项，
 * 只保留 IMAGE_EXTS 里的文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES_DIR, MANIFEST_PATH } from './paths.mjs';
import { IMAGE_EXTS, NO_DECODE_EXTS, RAW_EXTS, extOf, isImageName } from '../../../desktop/renderer/lib/format.js';

export { IMAGE_EXTS, NO_DECODE_EXTS, RAW_EXTS, extOf, isImageName };

export const isHiddenName = (name) => String(name).startsWith('.');

export function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw);
}

/** 单层扫描（与主进程 scandir 的判定一致）。返回按名字排序的裸名字数组。 */
export function scanDir(absDir) {
  const folders = [];
  const images = [];
  for (const d of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (isHiddenName(d.name)) continue;
    if (d.isDirectory()) folders.push(d.name);
    else if (d.isFile() && isImageName(d.name)) images.push(d.name);
  }
  folders.sort();
  images.sort();
  return { folders, images };
}

/** 递归扫描：images/folders 都是相对 root 的 POSIX 路径（与主进程下发的一致）。 */
export function scanTree(absDir) {
  const images = [];
  const folders = [];
  const walk = (dir, prefix) => {
    const r = scanDir(dir);
    for (const f of r.folders) {
      const rel = prefix ? `${prefix}/${f}` : f;
      folders.push(rel);
      walk(path.join(dir, f), rel);
    }
    for (const i of r.images) images.push(prefix ? `${prefix}/${i}` : i);
  };
  walk(absDir, '');
  folders.sort();
  images.sort();
  return { images, folders };
}

/** rel -> manifest 条目 */
export function byRel(manifest) {
  return new Map(manifest.files.map((f) => [f.rel, f]));
}

/** 某个目录（rel，'' 表示根）下、manifest 里登记的条目。 */
export function manifestEntriesIn(manifest, relDir) {
  const prefix = relDir ? `${relDir}/` : '';
  return manifest.files.filter((f) => f.rel.startsWith(prefix) && !f.rel.slice(prefix.length).includes('/'));
}

/**
 * 「缩略图必须失败」的文件（manifest 里点了名的坏素材）：
 *  - kind === 'broken'（截断/0 字节）
 *  - decodeVia === 'bitmap-expect-fail'（头部能读出尺寸、像素解不了，如 webp-header）
 */
export function brokenRels(manifest, relDir = '') {
  return manifestEntriesIn(manifest, relDir)
    .filter((f) => f.kind === 'broken' || f.decodeVia === 'bitmap-expect-fail')
    .map((f) => f.rel);
}

/** 「浏览器根本解不了」的文件（HEIC/HEIF）：必须走占位、且绝不能计入生成失败。 */
export function unsupportedRels(manifest, relDir = '') {
  return manifestEntriesIn(manifest, relDir)
    .filter((f) => NO_DECODE_EXTS.has(extOf(f.rel.split('/').pop())))
    .map((f) => f.rel);
}

/** 「必须出图」的文件：目录下所有图片，减掉上面两类。 */
export function goodRels(manifest, relDir = '') {
  const bad = new Set([...brokenRels(manifest, relDir), ...unsupportedRels(manifest, relDir)]);
  return manifestEntriesIn(manifest, relDir)
    .map((f) => f.rel)
    .filter((rel) => !bad.has(rel));
}

/** 「不该出现在图库里的文件」：manifest 里登记但扩展名不属于 IMAGE_EXTS 或本身是隐藏项。 */
export function notImageRels(manifest) {
  return manifest.files
    .filter((f) => {
      const name = f.rel.split('/').pop();
      return isHiddenName(name) || !isImageName(name);
    })
    .map((f) => f.rel);
}

/** 期望的显示尺寸（manifest 里 orient-5..8 记的已经是「转正后」的宽高）。 */
export function expectDims(manifest, rel) {
  const f = byRel(manifest).get(rel);
  if (!f || !f.expect || !f.expect.w) return null;
  return { w: f.expect.w, h: f.expect.h, orientation: f.expect.orientation || 0, previewEmbedded: !!f.expect.previewEmbedded };
}

/**
 * 单个目录视图的期望值。
 *
 * 注意键名差异：进入 `basic/` 时磁贴上的名字是**裸文件名**（没有子目录徽标），
 * 而从根目录递归扫描时磁贴带 `sub/name` 徽标 = manifest 的 rel。
 * 所以这里返回的 good/broken/unsupported 都以「磁贴键」为准（本目录内 = 裸名）。
 */
export function dirExpectation(manifest, relDir) {
  const prefix = relDir ? `${relDir}/` : '';
  const files = manifest.files
    .filter((f) => f.rel.startsWith(prefix) && !f.rel.slice(prefix.length).includes('/'))
    .map((f) => ({ ...f, name: f.rel.split('/').pop() }))
    .filter((f) => !isHiddenName(f.name) && isImageName(f.name));
  const usable = (f) => f.kind === 'broken' || f.decodeVia === 'bitmap-expect-fail';
  const noDecode = (f) => NO_DECODE_EXTS.has(extOf(f.name));
  const byTile = new Map(files.map((f) => [f.name, f]));
  const broken = new Set(files.filter(usable).map((f) => f.name));
  const unsupported = new Set(files.filter(noDecode).map((f) => f.name));
  const good = new Set(files.map((f) => f.name).filter((n) => !broken.has(n) && !unsupported.has(n)));
  return {
    dir: relDir,
    total: files.length,
    files,
    byTile,
    tileKeys: new Set(files.map((f) => f.name)),
    good,
    broken,
    unsupported,
    dims: new Map(files.map((f) => [f.name, f.expect || null])),
    spec: { good, broken, unsupported, allowUnknown: false },
  };
}

/** 递归整棵树的期望值：键 = manifest rel（= 递归磁贴的 `sub/name`）。 */
export function recursiveExpectation(manifest) {
  const visible = manifest.files
    .filter((f) => !isHiddenName(f.rel.split('/').pop()) && isImageName(f.rel))
    .map((f) => f.rel);
  // 注意：不能用 brokenRels/unsupportedRels/…(manifest, '') —— 它们内部走
  // `manifestEntriesIn(manifest, '')`，语义是「根目录的直接子项」，对 '' 而言就是
  // 「rel 里不含 /」的顶层文件。素材全在子目录里，于是这两类会算成空集，
  // 递归模式下所有解不出来的文件都被当成「必须出图」→ 一堆假违规。
  // 递归视图覆盖整棵树，这里必须按**整棵树**筛。
  const broken = new Set(
    manifest.files
      .filter((f) => f.kind === 'broken' || f.decodeVia === 'bitmap-expect-fail')
      .map((f) => f.rel),
  );
  const unsupported = new Set(
    manifest.files
      .filter((f) => NO_DECODE_EXTS.has(extOf(f.rel.split('/').pop())))
      .map((f) => f.rel),
  );
  const good = new Set(visible.filter((r) => !broken.has(r) && !unsupported.has(r)));
  return {
    total: visible.length,
    good,
    broken,
    unsupported,
    spec: { good, broken, unsupported, allowUnknown: false },
  };
}

/** 供 README/报告用的素材概览。 */
export function summarize(manifest) {
  const top = scanDir(FIXTURES_DIR);
  const tree = scanTree(FIXTURES_DIR);
  return {
    generatedAt: manifest.generatedAt,
    realSrc: manifest.realSrc,
    manifestFiles: manifest.files.length,
    manifestDirs: manifest.dirs.length,
    topFolders: top.folders,
    topImages: top.images,
    treeImages: tree.images,
    treeFolders: tree.folders,
  };
}

/**
 * `real/` 里的真实样片是否可用。
 *
 * 那些文件是**个人照片**，不入库（见 .gitignore），CI 上用 `--no-real` 生成素材后
 * `real/` 目录是空的。依赖它们的用例必须走 `A.skip()` 明确报告，而不是靠放宽断言
 * 假装通过 —— 本地有素材时仍要严格断言，否则等于悄悄失去这部分覆盖。
 *
 * 判据同时看磁盘与 manifest：只要有一边缺了，就认为覆盖不成立
 * （manifest 有登记但磁盘没文件 = 素材被外部删掉，这时跳过反而是对的，
 *  因为「文件不存在」本身不是产品行为的问题）。
 */
export function realAvailable(manifest) {
  const rels = manifestEntriesIn(manifest, 'real').map((f) => f.rel);
  if (!rels.length) return { ok: false, reason: 'manifest 里没有 real/ 条目（生成素材时用了 --no-real？）', count: 0 };
  const missing = rels.filter((rel) => !fs.existsSync(path.join(FIXTURES_DIR, rel)));
  if (missing.length) {
    return { ok: false, reason: `manifest 登记了 ${rels.length} 个 real/ 文件，磁盘上缺 ${missing.length} 个（${missing.slice(0, 3).join(', ')}…）`, count: rels.length };
  }
  return { ok: true, reason: '', count: rels.length };
}

export const FIXTURES = FIXTURES_DIR;

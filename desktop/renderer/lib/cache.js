/**
 * OPFS 缩略图缓存：与浏览器版同一套 key 语义，只是桌面端额外提供
 * 「清缓存 / 统计容量 / 导出诊断」所需的枚举能力。
 *
 * key 里带缓存版本号：只要"缓存内容的语义"变了就递增，旧条目会被自动忽略
 * （自愈，不用手动清缓存）。v2 的原因：EXIF 方向修复前，竖拍的图是按"方向算反的尺寸"
 * 生成缩略图的（把已经转正的位图画进了宽高反过来的 canvas 里 → 图被压扁），
 * 尺寸 sidecar 也是反的。
 */

import { state } from './state.js';

/** 缩略图最大边。 */
export const THUMB_MAX = 640;
/** 缩略图 JPEG 质量。 */
export const THUMB_QUALITY = 0.8;
/** 缩略图并发生成数。 */
export const THUMB_CONCURRENCY = 8;

/**
 * 缩略图/尺寸缓存的内容版本号（改动缓存语义时递增，见 cacheKey）。
 * v3：RAW 缩略图从「按容器方向躺倒」改成「真正旋转到显示朝向」，旧的 v2 缓存必须失效
 */
export const CACHE_VERSION = 'v3';

const CACHE_DIR_NAME = 'gkpv-thumbs';

/** 打开（或创建）OPFS 里的缓存目录；失败则退回内存缓存。 */
export async function initCache() {
  try {
    const opfsRoot = await navigator.storage.getDirectory();
    state.cacheDir = await opfsRoot.getDirectoryHandle(CACHE_DIR_NAME, { create: true });
    return { ok: true, backend: 'opfs' };
  } catch (e) {
    console.warn('OPFS 不可用，退回内存缓存：', e);
    state.cacheDir = null;
    return { ok: false, backend: 'memory', error: String((e && e.message) || e) };
  }
}

export function cacheKey(dirPath, entry) {
  const raw = `${CACHE_VERSION}/${dirPath}/${entry.name}_${entry.size}_${entry.lastModified}`;
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/** 宽高比缓存的 key（读写都要用它，避免两处写法漂移）。 */
export function arCacheKey(dirPath) {
  return `ar_${CACHE_VERSION}_${String(dirPath).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180)}`;
}

export async function getCachedThumb(key) {
  if (state.cacheDir) {
    try {
      const fileHandle = await state.cacheDir.getFileHandle(key);
      return await fileHandle.getFile();
    } catch {
      return null;
    }
  }
  return state.memCache.get(key) || null;
}

export async function setCachedThumb(key, blobOrBuffer) {
  if (state.cacheDir) {
    try {
      const fileHandle = await state.cacheDir.getFileHandle(key, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blobOrBuffer);
      await writable.close();
    } catch (e) {
      console.warn('缓存写入失败：', e);
    }
  } else {
    state.memCache.set(key, blobOrBuffer);
  }
}

/** 读 JSON sidecar（尺寸、宽高比表都走它）。 */
export async function readSidecar(key) {
  if (!state.cacheDir) return state.memCache.get(key) || null;
  try {
    const mh = await state.cacheDir.getFileHandle(key);
    const mf = await mh.getFile();
    return JSON.parse(await mf.text());
  } catch {
    return null;
  }
}

export async function writeSidecar(key, obj) {
  if (!state.cacheDir) {
    state.memCache.set(key, obj);
    return;
  }
  try {
    const mh = await state.cacheDir.getFileHandle(key, { create: true });
    const mw = await mh.createWritable();
    await mw.write(JSON.stringify(obj));
    await mw.close();
  } catch {
    /* 忽略：sidecar 丢了只会让下次多一次测量 */
  }
}

/** 清空缩略图缓存（含 sidecar 与内存兜底）。 */
export async function clearCache() {
  let removed = 0;
  if (state.cacheDir) {
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      try {
        for await (const name of state.cacheDir.keys()) { removed += 1; void name; }
      } catch { /* 枚举失败不影响删除 */ }
      await opfsRoot.removeEntry(CACHE_DIR_NAME, { recursive: true });
      state.cacheDir = await opfsRoot.getDirectoryHandle(CACHE_DIR_NAME, { create: true });
    } catch (e) {
      console.warn('清缓存失败：', e);
    }
  }
  state.memCache.clear();
  return { ok: true, removed };
}

/** 缓存统计（诊断/诊断页用）。 */
export async function cacheStats() {
  const stats = { backend: state.cacheDir ? 'opfs' : 'memory', entries: 0, bytes: 0, memoryEntries: state.memCache.size };
  if (!state.cacheDir) return stats;
  try {
    for await (const [, handle] of state.cacheDir.entries()) {
      stats.entries += 1;
      try {
        const f = await handle.getFile();
        stats.bytes += f.size;
      } catch { /* 忽略单个条目失败 */ }
    }
  } catch { /* 枚举失败 */ }
  return stats;
}

/** 估算配额（诊断页展示用；Electron 里通常给的是很大一个值）。 */
export async function storageEstimate() {
  try {
    const est = await navigator.storage.estimate();
    return { usage: est.usage || 0, quota: est.quota || 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

export async function loadAspectRatios(dirPath, entries) {
  if (!state.cacheDir) return;
  const ratios = (await readSidecar(arCacheKey(dirPath))) || {};
  for (const entry of entries) {
    const key = `${entry.name}_${entry.size}_${entry.lastModified}`;
    const r = ratios[key];
    if (r && typeof r.w === 'number' && typeof r.h === 'number' && r.h > 0) {
      entry.width = r.w;
      entry.height = r.h;
      entry.aspect = r.w / r.h;
    }
  }
}

export async function saveAspectRatios(dirPath, entries) {
  if (!state.cacheDir) return;
  const ratios = {};
  for (const entry of entries) {
    if (entry.width > 0) {
      ratios[`${entry.name}_${entry.size}_${entry.lastModified}`] = { w: entry.width, h: entry.height };
    }
  }
  await writeSidecar(arCacheKey(dirPath), ratios);
}

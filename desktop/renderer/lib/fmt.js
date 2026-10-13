/** 纯工具函数：与 DOM / 平台无关，可被 node --test 直接单测。 */

/** 人类可读的文件尺寸。 */
export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}

/** HTML 转义。 */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 尺寸是否合理（防住解析出来的脏值导致布局爆炸）。 */
export function isSaneSize(s) {
  return !!(s && s.w > 0 && s.h > 0 && s.w < 200000 && s.h < 200000);
}

/** 数字千分位（计数器文案用）。 */
export function formatCount(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 求一组宽高比里最接近中位数的那个（灯箱预取顺序、封面选择会用到）。
 * 无输入返回 1。
 */
export function medianAspect(ratios) {
  const arr = (ratios || []).filter((r) => Number.isFinite(r) && r > 0).sort((a, b) => a - b);
  if (!arr.length) return 1;
  return arr[Math.floor(arr.length / 2)];
}

/** 限制在 [min,max]。 */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * 把字节包成 readImageSize() 认识的「file 样对象」。
 * readImageSize 只用到 `name` 与 `slice(a,b).arrayBuffer()`。
 */
export function bytesAsFile(bytes, name) {
  return {
    name,
    size: bytes.length,
    slice: (a, b) => ({
      arrayBuffer: async () => bytes.slice(a || 0, b === undefined ? bytes.length : b).buffer,
    }),
  };
}

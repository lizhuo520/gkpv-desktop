/**
 * 从位图里抽「主色调 / 明暗」，用于卡片占位背景与灯箱背板着色。
 * 抽到的是粗粒度的平均色，不求精确，只求卡片不再闪白。
 */

/** @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} src */
export function averageColor(src, sampleSize = 16) {
  const w = src.width || src.naturalWidth || 0;
  const h = src.height || src.naturalHeight || 0;
  if (!w || !h) return null;

  const sw = Math.max(1, Math.min(sampleSize, w));
  const sh = Math.max(1, Math.min(sampleSize, h));
  let canvas;
  try {
    canvas = new OffscreenCanvas(sw, sh);
  } catch {
    return null;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(src, 0, 0, sw, sh);
    const data = ctx.getImageData(0, 0, sw, sh).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
    if (!n) return null;
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  } catch {
    return null;
  }
}

export function toCss({ r, g, b }, alpha = 0.18) {
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 相对亮度（用于决定占位底色上的文字用黑还是白）。 */
export function luminance({ r, g, b }) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

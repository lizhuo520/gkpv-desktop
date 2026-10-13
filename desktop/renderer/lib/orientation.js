/**
 * 按 EXIF 方向把位图转正。
 *
 * 为什么需要它：RAW 的内嵌预览 JPEG 几乎都不带 EXIF 段（实测尼康/索尼 275 个文件里 0 个带），
 * 而浏览器只会按「图片自己带的 EXIF」转正 —— 所以预览解码出来是传感器朝向（横躺着）的。
 * 方向信息存在 RAW 容器的 IFD0 里，只有我们自己按它旋转像素，缩略图和光箱才是正的。
 *
 * orientation 取值 1~8（CIPA DC-008 定义），返回的新画布尺寸 = 转正后的显示尺寸。
 * maxSize > 0 时顺便等比缩到该上限（避免先解码成大图再重采样两次）。
 */

/** 是否需要交换宽高（5~8 含 90° 变换）。 */
export function swapsDimensions(orientation) {
  return orientation >= 5 && orientation <= 8;
}

/**
 * 把方向矩阵写进 2D 上下文。
 * canvas 的 transform() 是右乘，所以「scale 在前、transform 在后」= 最终矩阵 S·T，
 * 平移量会自动一起缩放。
 */
export function applyOrientationMatrix(ctx, orientation, w, h) {
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;     // 水平镜像
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;    // 旋转 180°
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;     // 垂直镜像
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;      // 转置（沿主对角线镜像）
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;     // 顺时针 90°
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;    // 沿副对角线镜像
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;     // 逆时针 90°（= 顺时针 270°）
    default: break;                                      // 1 或未知值：原样输出
  }
}

/**
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bmp
 * @param {number} orientation 1~8
 * @param {number} [maxSize] 0 = 不缩放
 * @returns {OffscreenCanvas}
 */
export function drawBitmapOriented(bmp, orientation, maxSize = 0) {
  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  const swap = swapsDimensions(orientation);
  let cw = swap ? h : w;
  let ch = swap ? w : h;
  const scale = maxSize > 0 ? Math.min(1, maxSize / Math.max(cw, ch)) : 1;
  cw = Math.max(1, Math.round(cw * scale));
  ch = Math.max(1, Math.round(ch * scale));
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(scale, scale);
  applyOrientationMatrix(ctx, orientation, w, h);
  ctx.drawImage(bmp, 0, 0);
  return canvas;
}

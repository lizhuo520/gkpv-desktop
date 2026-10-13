/**
 * 格式分类常量。
 *
 * 与 main/scandir.cjs 的 `IMAGE_EXTS` 必须保持一致（测试 tests/unit/format.spec.mjs 会做交叉校验）。
 */

/** 允许出现在图库里的扩展名。RAW 家族靠内嵌 JPEG 预览出图。 */
export const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'avif', 'svg', 'ico', 'tiff', 'tif', 'heic',
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef',
  'srw', 'erf', 'kdc', 'dcr', 'mos', 'mrw', 'mef', '3fr', 'iiq', 'rwl', 'r3d', 'x3f', 'raw',
]);

/**
 * Chromium 完全解不了的格式：<img> / createImageBitmap / ImageDecoder 三条路都不支持。
 * 与其让缩略图静默失败、卡片永远空白，不如显式标出来。
 */
export const NO_DECODE_EXTS = new Set(['heic', 'heif']);

/** 原生 RAW 扩容器格式（需要靠内嵌 JPEG 预览 + 容器方向旋转） */
export const RAW_EXTS = new Set([
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef',
  'srw', 'erf', 'kdc', 'dcr', 'mos', 'mrw', 'mef', '3fr', 'iiq', 'rwl', 'r3d', 'x3f', 'raw',
]);

/**
 * createImageBitmap 的 imageOrientation 默认值在历史上变过（'none' → 'from-image'），
 * 不同内核、不同版本行为不一致。统一显式声明「按 EXIF 方向解码」，
 * 保证缩略图与光箱（<img> 默认就是 from-image）的朝向永远一致。
 */
export const BITMAP_OPTS = { imageOrientation: 'from-image' };

/** 取小写扩展名（无扩展名返回空串）。 */
export function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
}

export function isImageName(name) {
  return IMAGE_EXTS.has(extOf(name));
}

/** 是否是不可解码格式（HEIC/HEIF）。 */
export function isNoDecodeName(name) {
  return NO_DECODE_EXTS.has(extOf(name));
}

export function isSvgName(name) {
  return extOf(name) === 'svg';
}

export function isRawName(name) {
  return RAW_EXTS.has(extOf(name));
}

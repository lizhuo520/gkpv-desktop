/**
 * 布局计算与虚拟滚动几何 —— 纯函数，无 DOM 依赖，可在 node 里直接单测。
 */

/** 尺寸档位 -> 目标行高（自适应布局）。 */
export const TARGET_ROW_HEIGHT = { sm: 150, md: 220, lg: 320 };
/** 尺寸档位 -> 网格单元边长（网格布局）。 */
export const THUMB_SIZE_PX = { sm: 120, md: 200, lg: 320 };
/** 单元之间的间隙。 */
export const GAP = 8;
/** 视口外上下各多渲染几行。 */
export const VIEW_BUFFER_ROWS = 5;

export function getTargetRowHeight(sizeKey) {
  return TARGET_ROW_HEIGHT[sizeKey] || 220;
}

export function getThumbSizePx(sizeKey) {
  return THUMB_SIZE_PX[sizeKey] || 200;
}

/**
 * 自适应（justified）布局：每行按容器宽度均分，行高逼近目标行高。
 * @param {Array<{aspect:number}>} entries
 * @param {number} containerWidth
 * @param {string} sizeKey
 */
export function computeJustifiedLayout(entries, containerWidth, sizeKey) {
  const rows = [];
  const gap = GAP;
  const targetH = getTargetRowHeight(sizeKey);
  let row = [];
  let rowAspectSum = 0;
  let y = 0;

  const flush = (indices, h) => {
    let x = 0;
    const items = indices.map((idx) => {
      const w = Math.round((entries[idx].aspect || 1) * h);
      const item = { imageIndex: idx, width: w, height: h, left: x };
      x += w + gap;
      return item;
    });
    rows.push({ top: y, height: h, items });
    y += h + gap;
  };

  for (let i = 0; i < entries.length; i += 1) {
    const aspect = entries[i].aspect || 1;
    row.push(i);
    rowAspectSum += aspect;
    const usableW = containerWidth - gap * (row.length - 1);
    const rowH = usableW / rowAspectSum;

    if (rowH <= targetH && row.length > 0) {
      // 行已满
      flush(row, Math.round(rowH));
      row = [];
      rowAspectSum = 0;
    }
  }

  // 最后一行 —— 按目标行高左对齐
  if (row.length > 0) {
    const h = Math.round(Math.min(targetH, (containerWidth - gap * (row.length - 1)) / rowAspectSum));
    flush(row, h);
  }

  return { rows, totalHeight: y };
}

/**
 * 网格布局：等大单元，列数由容器宽度决定。
 */
export function computeGridLayout(entries, containerWidth, sizeKey) {
  const gap = GAP;
  const thumbSize = getThumbSizePx(sizeKey);
  const cols = Math.max(1, Math.floor((containerWidth + gap) / (thumbSize + gap)));
  const cellW = Math.floor((containerWidth - gap * (cols - 1)) / cols);
  const rows = [];
  let y = 0;

  for (let i = 0; i < entries.length; i += cols) {
    const rowItems = [];
    for (let c = 0; c < cols && i + c < entries.length; c += 1) {
      rowItems.push({ imageIndex: i + c, width: cellW, height: cellW, left: c * (cellW + gap) });
    }
    rows.push({ top: y, height: cellW, items: rowItems });
    y += cellW + gap;
  }

  return { rows, totalHeight: y };
}

/** 按当前模式选布局算法。 */
export function computeLayout(mode, entries, containerWidth, sizeKey) {
  return mode === 'grid'
    ? computeGridLayout(entries, containerWidth, sizeKey)
    : computeJustifiedLayout(entries, containerWidth, sizeKey);
}

/** 二分查找首个「底边越过 scrollTop」的行号。 */
export function findFirstVisibleRow(rows, scrollTop) {
  let lo = 0;
  let hi = rows.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top + rows[mid].height < scrollTop) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 计算需要渲染的行区间（含缓冲行）。
 * @param {Array<{top:number,height:number}>} rows
 * @param {number} scrollTop 容器顶部相对文档顶部的偏移
 * @param {number} viewportHeight
 */
export function computeVisibleRange(rows, scrollTop, viewportHeight, buffer = VIEW_BUFFER_ROWS) {
  if (!rows.length) return { start: 0, end: -1 };
  const viewTop = scrollTop;
  const viewBottom = viewTop + viewportHeight;
  let startRow = findFirstVisibleRow(rows, Math.max(0, viewTop));
  startRow = Math.max(0, startRow - buffer);
  let endRow = startRow;
  while (endRow < rows.length && rows[endRow].top < viewBottom) endRow += 1;
  endRow = Math.min(rows.length - 1, endRow + buffer);
  return { start: startRow, end: endRow };
}

/** 缩放后的平移边界（灯箱用；纯数学，可单测）。 */
export function constrainPan(tx, ty, layoutW, layoutH, scale, viewportW, viewportH) {
  const scaledW = layoutW * scale;
  const scaledH = layoutH * scale;
  const maxTx = Math.max(0, (scaledW - viewportW) / 2);
  const maxTy = Math.max(0, (scaledH - viewportH) / 2);
  return {
    tx: Math.max(-maxTx, Math.min(maxTx, tx)),
    ty: Math.max(-maxTy, Math.min(maxTy, ty)),
  };
}

/** 以 (cx,cy) 为锚点缩放到 newScale，返回新的平移量。 */
export function zoomAround(tx, ty, scale, newScale, cx, cy) {
  const ratio = newScale / scale;
  return { tx: cx * (1 - ratio) + tx * ratio, ty: cy * (1 - ratio) + ty * ratio };
}

/** 排序：与浏览器版 sortItems 等价（日期取 lastModified）。 */
export function sortEntries(items, sortMode, recursiveMode) {
  const copy = [...items];
  // 递归模式下按「子目录/文件名」排序，让同一文件夹的图聚在一起
  const key = (x) => (recursiveMode && x.rel ? x.rel : x.name);
  switch (sortMode) {
    case 'name-asc':
      copy.sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true }));
      break;
    case 'name-desc':
      copy.sort((a, b) => key(b).localeCompare(key(a), undefined, { numeric: true }));
      break;
    case 'date-new':
      copy.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
      break;
    case 'date-old':
      copy.sort((a, b) => (a.lastModified || 0) - (b.lastModified || 0));
      break;
    default:
      break;
  }
  return copy;
}

/** 计数器文案。 */
export function counterLabel(total, folders, { recursive, truncated, limit } = {}) {
  const img = `${total} 张图片`;
  const fld = `${folders} 个文件夹`;
  let text = recursive ? `${img}（含子文件夹），${fld}` : `${img}，${fld}`;
  // 被上限截断时必须说清楚，否则用户会以为图少了
  if (truncated) text += `（已达 ${limit} 张上限，未显示全部）`;
  return text;
}

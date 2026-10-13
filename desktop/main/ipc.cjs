'use strict';

const { app, dialog, ipcMain, shell } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');

const sources = require('./sources.cjs');
const scandir = require('./scandir.cjs');

const isDev = () => !app.isPackaged || process.argv.includes('--dev');

/** 扫描并发度：同时最多解 8 个文件的预览，避免机械硬盘随机读打爆。 */
const SCAN_CONCURRENCY = 8;

function withConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  return Promise.all(runners).then(() => results);
}

function toDataUrl(mime, buf) {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 规范化子路径：`''` / `'basic'` / `'nested/deep-1'`（统一用 `/` 分隔、去掉首尾斜杠）。
 * 主进程内部一律用这种形式做前缀拼接，避免 `//` 或 `\\` 混进来让 `rel` 对不上。
 */
function normalizeSub(subPath) {
  return String(subPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.')
    .join('/');
}

/**
 * 扫描一个目录，返回渲染层直接可用的一批"目录条目"。
 * - folder 条目：{ kind:'folder', name, rel, childCount, preview, recursiveOnly }
 * - file 条目：{ kind:'file', name, rel, dirPath, size, lastModified, width, height, preview, previewEmbedded, previewError }
 *
 * `subPath` 是**当前所在目录**相对源根的层级路径（`''` = 根）。
 *
 * 这里必须真的去扫那个子目录，而不是扫根目录再让渲染层过滤：等价于网页版的
 * `getDirHandle(currentPath)` + `scanDir(dirHandle, recursiveMode)`（gkpv.html:1859-1860）。
 * 早先的实现只会扫 `src.root`，于是「点进子目录」后面包屑变了、网格内容却还是根目录的
 * 那 7 个文件夹，子目录里的图永远不出现（E2E 里表现为 8 个用例等到 180s 超时）。
 *
 * 注意 `rel` 一律保持**相对源根**（不是相对 subPath）：`file:read`/`file:stat` 都用
 * `sources.safeJoin(src.root, rel)` 反查真实路径，缩略图缓存键也依赖它稳定。
 */
async function scanSource(id, { withPreview = true, subPath = '', onProgress } = {}) {
  const src = sources.resolve(id);
  if (!src) return { error: '未知目录句柄（可能已被释放），请重新打开文件夹' };

  const sub = normalizeSub(subPath);
  // 目录穿越防护：`..`、绝对路径、符号链接逃逸都在这里被挡住（safeJoin 会返回 null）
  const scanRoot = sources.safeJoin(src.root, sub);
  if (!scanRoot) return { error: `目录不合法：${subPath}` };
  try {
    const st = await fsp.stat(scanRoot);
    if (!st.isDirectory()) return { error: `不是目录：${subPath}` };
  } catch {
    return { error: `目录不存在：${subPath}` };
  }

  const { files, folderMap } = await scandir.scanDirectory(scanRoot, src.recursive);

  // scandir 给出的 rel 是相对 scanRoot 的，这里统一升回相对源根
  const toRootRel = (rel) => (sub ? (rel ? `${sub}/${rel}` : sub) : rel);
  /** 文件所在文件夹相对源根（`''` = 根目录）——与网页版的 `dirPath` 语义一致。 */
  const dirPathOf = (rootRel) => {
    const d = path.posix.dirname(rootRel);
    return d === '.' ? '' : d;
  };

  const byRel = new Map();
  for (const f of files) byRel.set(f.rel, f);

  // 先完成所有图片条目（含预览与尺寸）
  const results = await withConcurrency(files, SCAN_CONCURRENCY, async (f) => {
    const rel = toRootRel(f.rel);
    const entry = {
      kind: 'file',
      name: f.name,
      rel,
      dirPath: dirPathOf(rel),
      size: f.size,
      lastModified: f.lastModified,
      width: 0,
      height: 0,
      preview: null,
      previewEmbedded: false,
      previewError: null,
    };
    if (!withPreview) return entry;

    try {
      const prev = await scandir.readEmbeddedPreview(f._abs, f._ext);
      if (prev && prev.data && prev.data.length > 0) {
        entry.preview = toDataUrl(prev.mime, prev.data);
        entry.previewEmbedded = true;
        entry.previewBytes = prev.bytes;
      } else {
        entry.previewError = 'no-embedded-preview';
      }
    } catch (err) {
      entry.previewError = String((err && err.message) || err);
    }

    try {
      const dim = await scandir.readDimensions(f._abs, f._ext, null);
      entry.width = dim.width || 0;
      entry.height = dim.height || 0;
      // 容器/EXIF 方向（1~8）随条目一起下发。渲染层只有在拿不到方向时才会退回 1，
      // 竖拍 RAW（内嵌预览不带方向标记）全靠它转正 —— 之前这里漏了赋值，
      // entry.orientation 恒为 0，ARW/NEF 的缩略图会横过来。
      entry.orientation = dim.orientation || 1;
    } catch {
      /* 尺寸拿不到就留 0，渲染层用兜底宽高比 */
    }
    if (onProgress) onProgress(entry.rel);
    return entry;
  });

  for (const e of results) byRel.set(e.rel, e);

  // 文件夹条目：**只做当前目录的直接子目录**，与网页版 scanDir 严格一致 ——
  //   gkpv.html:1350-1355 只把这一层的 directory 推进 `folders`；
  //   递归 BFS（gkpv.html:1364-1388）只把子目录里的图片摊平到同一层，**不再**新增磁贴。
  // 递归遍历到的目录总数另用 dirCount 上报，供计数器显示「含子文件夹」的目录数
  // （网页版 dirCount：gkpv.html:1347 声明 / :1369 自增 / :1870 用于 currentFolderCount）。
  const folders = [];
  for (const [dirRel, children] of folderMap.entries()) {
    if (dirRel.includes('/')) continue;   // 更深层级只贡献被摊平的图片，不生成磁贴
    const direct = children;              // folderMap 的值本就是「直属该目录的文件」
    const childEntries = direct.map((c) => byRel.get(toRootRel(c))).filter(Boolean);
    const previews = childEntries.filter((c) => c && c.preview).slice(0, 4).map((c) => c.preview);
    const rootRel = toRootRel(dirRel);
    folders.push({
      kind: 'folder',
      name: path.posix.basename(rootRel) || rootRel,
      rel: rootRel,
      childCount: direct.length,
      preview: previews,
      recursiveOnly: false,
    });
  }

  const totalBytes = results.reduce((acc, e) => acc + (e.size || 0), 0);
  return {
    entries: [...folders, ...results],
    stats: {
      files: results.length,
      folders: folders.length,      // 磁贴数：当前目录的直接子目录
      dirCount: folderMap.size,     // 递归遍历到的子目录总数（计数器「N 个文件夹」用它）
      totalBytes,
      root: src.root,
      sub,
      recursive: src.recursive,
    },
  };
}

function registerIpc({ getWindow }) {
  // 原生"打开文件夹"对话框
  ipcMain.handle('dialog:openDirectory', async (_evt, { recursive = false, defaultPath } = {}) => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: '选择照片文件夹',
      defaultPath: defaultPath || app.getPath('pictures'),
      properties: ['openDirectory'],
      buttonLabel: '打开',
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const src = sources.remember(res.filePaths[0], recursive);
    return { canceled: false, source: src };
  });

  // 测试钩子：绕过原生对话框直接挂载目录（仅 dev / 未打包时可用）
  ipcMain.handle('sources:mount', async (_evt, { dir, recursive = false } = {}) => {
    if (!isDev() && !process.env.GKPV_TEST_ROOT) {
      return { error: 'sources:mount 仅在开发/测试模式可用' };
    }
    if (!dir || typeof dir !== 'string') return { error: '缺少 dir' };
    try {
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) return { error: `不是目录：${dir}` };
    } catch (err) {
      return { error: `目录不存在：${dir}` };
    }
    return { source: sources.remember(dir, recursive) };
  });

  ipcMain.handle('sources:setRecursive', (_evt, { id, recursive } = {}) => ({ ok: sources.setRecursive(id, recursive) }));
  ipcMain.handle('sources:release', (_evt, { id } = {}) => ({ ok: sources.release(id) }));
  ipcMain.handle('sources:list', () => ({
    sources: [...sources.sources.entries()].map(([id, s]) => ({ id, root: s.root, name: path.basename(s.root), recursive: s.recursive })),
  }));

  // `subPath`：渲染层当前所在的子目录（相对源根，`''` = 根）。见 scanSource 的注释。
  ipcMain.handle('dir:scan', async (evt, { id, withPreview = true, subPath = '' } = {}) => {
    const payload = await scanSource(id, {
      withPreview,
      subPath,
      onProgress: (rel) => {
        if (!evt.sender.isDestroyed()) evt.sender.send('dir:scanProgress', { id, rel });
      },
    });
    return payload;
  });

  ipcMain.handle('file:read', async (_evt, { id, rel } = {}) => {
    const src = sources.resolve(id);
    if (!src) return { error: '目录句柄无效' };
    const st = await sources.statOf(src.root, rel);
    if (!st) return { error: `读不到文件：${rel}` };
    const buf = await sources.readBuffer(src.root, rel);
    if (!buf) return { error: `读取失败：${rel}` };
    return { buffer: buf, size: st.size, lastModified: st.lastModified };
  });

  ipcMain.handle('file:stat', async (_evt, { id, rel } = {}) => {
    const src = sources.resolve(id);
    if (!src) return null;
    const st = await sources.statOf(src.root, rel);
    if (!st) return null;
    return { size: st.size, lastModified: st.lastModified };
  });

  ipcMain.handle('shell:openPath', async (_evt, { path: p } = {}) => {
    if (!p || typeof p !== 'string') return { ok: false };
    const err = await shell.openPath(p);
    return { ok: !err, error: err || null };
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    name: app.getName(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userData: app.getPath('userData'),
    dev: isDev(),
    testRoot: process.env.GKPV_TEST_ROOT || null,
  }));

  // 测试模式：把主进程钉住的目录路径交给渲染层（preload 同名通道）
  ipcMain.handle('test:getRoot', () => {
    if (process.env.GKPV_TEST_MODE !== '1') return null;
    return process.env.GKPV_TEST_ROOT || null;
  });


  ipcMain.handle('app:clearSessionCache', async () => {
    const win = getWindow();
    if (win && !win.isDestroyed()) await win.webContents.session.clearCache();
    return { ok: true };
  });

  ipcMain.handle('app:exportDiagnostics', async (_evt, { text, suggestedName } = {}) => {
    const win = getWindow();
    const res = await dialog.showSaveDialog(win, {
      title: '导出诊断信息',
      defaultPath: path.join(app.getPath('documents'), suggestedName || `gkpv-diagnostics-${Date.now()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }, { name: '文本', extensions: ['txt'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    await fsp.writeFile(res.filePath, String(text ?? ''), 'utf8');
    return { canceled: false, path: res.filePath };
  });

  // 渲染层请求：只允许主进程主动发起的命令通道
  ipcMain.handle('ui:ready', () => ({ ok: true }));
}

module.exports = { registerIpc, scanSource, withConcurrency };

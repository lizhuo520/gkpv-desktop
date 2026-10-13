'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染层唯一的对外通道。
 *
 * 刻意只暴露「按句柄访问目录」的能力，不暴露任意路径读写：
 * 渲染层拿到的是 `src:N` 句柄，真实路径留在主进程（见 main/sources.cjs）。
 */
const api = {
  /* ---------------- 目录授权 ---------------- */

  /** 原生目录选择框：{ canceled:true } 或 { canceled:false, source:{id,root,name} } */
  openFolder: (opts) => ipcRenderer.invoke('dialog:openDirectory', opts || {}),

  /** 直接挂载一个已知目录（仅开发/测试模式可用，打包后会拒绝） */
  mountFolder: (dir, recursive) => ipcRenderer.invoke('sources:mount', { dir, recursive: !!recursive }),

  setRecursive: (id, recursive) => ipcRenderer.invoke('sources:setRecursive', { id, recursive: !!recursive }),
  releaseFolder: (id) => ipcRenderer.invoke('sources:release', { id }),
  listFolders: () => ipcRenderer.invoke('sources:list'),

  /* ---------------- 扫描 ---------------- */

  /**
   * 扫描「某个目录」：{ entries, stats } 或 { error }。
   *
   * `subPath` 是当前所在子目录相对源根的路径（`''` = 根，可传字符串或层级数组）。
   * 必须传它，否则主进程只会扫根目录 —— 点进子目录后网格不会变。
   */
  scan: (id, withPreview, subPath) => ipcRenderer.invoke('dir:scan', {
    id,
    withPreview: withPreview !== false,
    subPath: Array.isArray(subPath) ? subPath.join('/') : (subPath || ''),
  }),
  onScanProgress: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('dir:scanProgress', listener);
    return () => ipcRenderer.removeListener('dir:scanProgress', listener);
  },

  /* ---------------- 文件字节 ---------------- */

  /** { buffer:ArrayBuffer, size, lastModified }（buffer 会被结构化克隆，可直接 new Uint8Array） */
  readFile: (id, rel) => ipcRenderer.invoke('file:read', { id, rel }),
  statFile: (id, rel) => ipcRenderer.invoke('file:stat', { id, rel }),

  /* ---------------- 应用级 ---------------- */

  info: () => ipcRenderer.invoke('app:info'),
  clearSessionCache: () => ipcRenderer.invoke('app:clearSessionCache'),
  exportDiagnostics: (text, suggestedName) => ipcRenderer.invoke('app:exportDiagnostics', { text, suggestedName }),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', { path: p }),

  /** 主进程菜单/快捷键下发的命令（返回取消订阅函数） */
  onCommand: (cb) => {
    const listener = (_evt, id) => cb(id);
    ipcRenderer.on('ui:command', listener);
    return () => ipcRenderer.removeListener('ui:command', listener);
  },

  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  isDesktop: true,
};

/* ------------------------------------------------------------------ *
 * 测试通道（GKPV_TEST_MODE=1 才存在）
 *
 * 桌面版的「打开文件夹」是原生对话框，自动化点不到。测试模式下主进程
 * 用 GKPV_TEST_ROOT 钉住一个目录，这里只把它透给渲染层，不开放任意路径。
 * ------------------------------------------------------------------ */
if (process.env.GKPV_TEST_MODE === '1') {
  api.test = {
    mode: true,
    getFolder: () => ipcRenderer.invoke('test:getRoot'),
  };
}

contextBridge.exposeInMainWorld('gkpv', api);

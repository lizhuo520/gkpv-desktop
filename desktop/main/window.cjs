'use strict';

const { BrowserWindow, shell } = require('electron');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function createWindow({ dev = false } = {}) {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d0e12',
    autoHideMenuBar: false,
    title: 'GKP 照片查看器',
    webPreferences: {
      preload: path.join(ROOT, 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      // 老 Chromium 无此键时会忽略，无副作用
      enableBlinkFeatures: '',
    },
  });

  win.once('ready-to-show', () => win.show());

  // 外链交给系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  const url = `app://gkpv/renderer/index.html${dev ? '?dev=1' : ''}`;
  win.loadURL(url).catch((err) => {
    // 加载失败时给出可见反馈，避免"白窗口没有任何信息"
    const msg = encodeURIComponent(`加载界面失败：${err && err.message ? err.message : err}`);
    win.loadURL(`data:text/html;charset=utf-8,<h1>${msg}</h1>`).catch(() => {});
  });

  return win;
}

module.exports = { createWindow };

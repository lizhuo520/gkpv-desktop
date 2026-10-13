'use strict';

const { Menu, app, shell } = require('electron');

/**
 * 应用菜单：把桌面端新增能力（原生开文件夹、清缓存、开发者工具）接进来。
 * 所有条目都通过 `webContents.send('ui:command', id)` 通知渲染层，
 * 渲染层用统一的命令总线处理，桌面端与网页端逻辑不分叉。
 */
function buildMenu(win) {
  const send = (id) => () => {
    if (win && !win.isDestroyed()) win.webContents.send('ui:command', id);
  };

  const template = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: send('open-folder') },
        { type: 'separator' },
        { label: '重新扫描当前文件夹', accelerator: 'F5', click: send('rescan') },
        { label: '清空缩略图缓存', click: send('clear-cache') },
        { type: 'separator' },
        { label: '导出诊断信息…', click: send('export-diagnostics') },
        { label: '开发者工具', accelerator: 'F12', click: () => { if (win && !win.isDestroyed()) win.webContents.toggleDevTools(); } },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '查看(&V)',
      submenu: [
        { label: '网格布局', accelerator: 'CmdOrCtrl+1', click: send('layout-grid') },
        { label: '自适应布局', accelerator: 'CmdOrCtrl+2', click: send('layout-justified') },
        { type: 'separator' },
        { label: '小图', accelerator: 'CmdOrCtrl+3', click: send('size-sm') },
        { label: '中图', accelerator: 'CmdOrCtrl+4', click: send('size-md') },
        { label: '大图', accelerator: 'CmdOrCtrl+5', click: send('size-lg') },
        { type: 'separator' },
        { label: '切换递归子文件夹', accelerator: 'CmdOrCtrl+R', click: send('toggle-recursive') },
        { label: '循环切换排序', accelerator: 'CmdOrCtrl+S', click: send('cycle-sort') },
        { type: 'separator' },
        { role: 'reload', label: '重载界面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          label: '关于 GKP 照片查看器',
          click: () => {
            const { dialog } = require('electron');
            const pkg = require('../package.json');
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于',
              message: `GKP 照片查看器 ${app.getVersion()}`,
              detail: [
                `版本：${app.getVersion()}`,
                `Electron：${process.versions.electron}`,
                `Chromium：${process.versions.chrome}`,
                `Node：${process.versions.node}`,
                '',
                pkg.description || '',
              ].join('\n'),
              buttons: ['好'],
            });
          },
        },
        { label: '项目主页', click: () => shell.openExternal('https://github.com/lizhuo520/gkpv-desktop') },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };

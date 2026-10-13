'use strict';

const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');

const appProtocol = require('./app-protocol.cjs');
const { registerIpc } = require('./ipc.cjs');
const { buildMenu } = require('./menu.cjs');
const { createWindow } = require('./window.cjs');

// 测试模式：把 userData 隔离到临时目录，避免污染真实缓存。
//
// ⚠ 顺序很重要：这段**必须**放在 requestSingleInstanceLock() 之前。
// Electron 的单实例锁是按「调用那一刻的 userData 路径」取的（Windows 上是一个
// 按该路径命名的互斥体）。如果先拿锁再 setPath，所有进程抢的都是默认 userData
// 那一把锁 —— 于是并行跑多个测试会话时，第二个进程会直接 app.quit() 并安静退出，
// 表现成 firstWindow 超时。生产环境不设 GKPV_TEST_ROOT，这里整段不执行，
// 所以这次调整对线上行为零影响。
{
  const testRootArg = process.argv.find((a) => a.startsWith('--test-root='));
  if (testRootArg) process.env.GKPV_TEST_ROOT = testRootArg.slice('--test-root='.length);
  if (process.env.GKPV_TEST_ROOT) {
    const tmpRoot = process.env.GKPV_TEST_USERDATA || path.join(app.getPath('temp'), 'gkpv-desktop-test');
    app.setPath('userData', tmpRoot);
  }
}

// 单实例：第二次启动时聚焦已有窗口（照片查看器被双击多次启动很常见）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  appProtocol.registerScheme();

  const dev = !app.isPackaged || process.argv.includes('--dev');
  let mainWindow = null;

  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    appProtocol.registerHandler(path.join(__dirname, '..'));

    // 崩溃可见化：写入日志文件，方便用户回传
    const crashLog = path.join(app.getPath('userData'), 'gkpv-crash.log');
    const logCrash = async (tag, err) => {
      const line = `[${new Date().toISOString()}] ${tag}: ${err && err.stack ? err.stack : err}\n`;
      await fsp.appendFile(crashLog, line, 'utf8').catch(() => {});
    };
    process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
    process.on('unhandledRejection', (err) => logCrash('unhandledRejection', err));

    registerIpc({ getWindow: () => mainWindow });

    mainWindow = createWindow({ dev });
    buildMenu(mainWindow);

    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      logCrash('render-process-gone', JSON.stringify(details));
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '界面进程崩溃',
        message: '渲染进程异常退出，已记录日志。',
        detail: `原因：${details.reason}（exitCode=${details.exitCode}）\n日志：${crashLog}`,
        buttons: ['重启应用', '退出'],
      }).then((r) => {
        if (r.response === 0) {
          app.relaunch();
          app.exit(0);
        } else {
          app.quit();
        }
      });
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow({ dev });
        buildMenu(mainWindow);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

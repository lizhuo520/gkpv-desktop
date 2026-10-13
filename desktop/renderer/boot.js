/**
 * 启动入口（外置脚本，不是内联 script）。
 *
 * 为什么必须是独立文件：index.html 里的 CSP 是 `script-src 'self'`，内联脚本会被
 * Chromium 直接拦掉（Electron 会在控制台打出 CSP 违规告警）。启动失败时必须在界面上
 * 直接显示原因，否则用户看到的就是一个白窗口——这行兜底比优雅退出重要。
 */
import { initApp } from './app.js';

initApp().catch((err) => {
  console.error('[gkpv] 启动失败：', err);
  const box = document.createElement('pre');
  box.style.cssText = 'padding:24px;color:#f66;white-space:pre-wrap;font:13px/1.6 monospace';
  box.textContent = `启动失败：${(err && err.message) || err}\n\n${(err && err.stack) || ''}`;
  document.body.appendChild(box);
});

/**
 * 启动类用例：窗口、协议、测试环境、无未捕获异常。
 * 意图都在每条用例的 intent 里。
 */
import { FIXTURES_DIR, MISSING_DIR, USER_DATA_DIR, userDataFor } from './lib/paths.mjs';

const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

export default [
  {
    name: 'launch:protocol-title',
    intent: '窗口真的加载了自定义 app://gkpv 协议（不是 file://），标题是「GKP 照片查看器」',
    async fn(ctx) {
      const { A, session } = ctx;
      const info = await session.page.evaluate(() => ({
        protocol: location.protocol,
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        isDesktop: window.gkpv.isDesktop,
        apiReady: !!(window.__gkpv && window.__gkpv.ready === true),
      }));
      A.eq(info.protocol, 'app:', 'location.protocol（说明页面走的是 app:// 自定义协议）');
      A.check(/^app:\/\/gkpv\//i.test(info.href), `location.href 应形如 app://gkpv/...，实际 ${info.href}`);
      A.eq(info.title, 'GKP 照片查看器', 'document.title');
      A.eq(info.readyState, 'complete', 'document.readyState');
      A.eq(info.isDesktop, true, 'window.gkpv.isDesktop（桌面端标记）');
      A.eq(info.apiReady, true, 'window.__gkpv.ready（渲染层模块已就绪）');
      A.note(`href=${info.href}`);
    },
  },

  {
    name: 'launch:window-visible',
    intent: '主进程里真的存在一个可见的原生窗口，尺寸/最小尺寸符合窗口契约',
    async fn(ctx) {
      const { A, session } = ctx;
      const w = await session.app.evaluate(({ BrowserWindow }) => {
        const all = BrowserWindow.getAllWindows();
        const first = all[0];
        return {
          count: all.length,
          title: first.getTitle(),
          visible: first.isVisible(),
          bounds: first.getBounds(),
          min: first.getMinimumSize(),
          focusable: first.isFocusable(),
        };
      });
      A.eq(w.count, 1, 'BrowserWindow 数量');
      A.eq(w.visible, true, '窗口是否可见（show:false + ready-to-show 是否真的跑到了 show）');
      A.eq(w.title, 'GKP 照片查看器', '原生窗口标题');
      A.check(w.bounds.width <= 1440 && w.bounds.height <= 920, `窗口不应超过配置的 1440x920，实际 ${w.bounds.width}x${w.bounds.height}`);
      A.check(w.bounds.width >= 900 && w.bounds.height >= 600, `窗口不应小于最小尺寸 900x600，实际 ${w.bounds.width}x${w.bounds.height}`);
      A.eq(w.min[0], 900, '最小宽度');
      A.eq(w.min[1], 600, '最小高度');
      A.note(`bounds=${w.bounds.width}x${w.bounds.height} x=${w.bounds.x} y=${w.bounds.y}`);
    },
  },

  {
    name: 'launch:test-env-hygiene',
    intent: '子进程环境干净：ELECTRON_RUN_AS_NODE 已删除、GKPV_TEST_MODE/GKPV_TEST_ROOT 生效、userData 被隔离到临时目录',
    async fn(ctx) {
      const { A, session } = ctx;
      const e = await session.app.evaluate(({ app }) => ({
        runAsNode: typeof process.env.ELECTRON_RUN_AS_NODE,
        testMode: process.env.GKPV_TEST_MODE,
        testRoot: process.env.GKPV_TEST_ROOT,
        userData: app.getPath('userData'),
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
      }));
      A.eq(e.runAsNode, 'undefined', 'ELECTRON_RUN_AS_NODE 必须从子进程环境里删掉（否则 electron.exe 退化成 Node，永远没有窗口）');
      A.eq(e.testMode, '1', 'GKPV_TEST_MODE');
      A.eq(norm(e.testRoot), norm(FIXTURES_DIR), 'GKPV_TEST_ROOT 应指向素材目录');
      A.eq(norm(e.userData), norm(userDataFor(session.label)), 'userData 应被隔离到 GKPV_TEST_USERDATA/<会话>（不污染真实用户配置，也避免单实例锁互踢）');
      A.check(norm(e.userData).startsWith(norm(USER_DATA_DIR)), `userData 必须落在测试专用根目录下，实际 ${e.userData}`);
      A.eq(e.isPackaged, false, '未打包运行（跑的是 desktop/ 工程目录）');
      A.check(/desktop$/i.test(norm(e.appPath)) && /gkpv/i.test(e.appPath), `app.getAppPath() 应是工程目录 desktop/，实际 ${e.appPath}`);
    },
  },

  {
    name: 'launch:test-folder-hook',
    intent: 'GKPV_TEST_MODE 的测试入口可用：window.gkpv.test.getFolder() 直接返回素材目录（绕开原生对话框）',
    async fn(ctx) {
      const { A, session } = ctx;
      const t = await session.page.evaluate(async () => {
        const v = await window.gkpv.test.getFolder();
        const info = await window.gkpv.info();
        return { mode: window.gkpv.test.mode, folder: v, info, versions: window.gkpv.versions, platform: window.gkpv.platform };
      });
      A.eq(t.mode, true, 'window.gkpv.test.mode');
      A.eq(t.folder, FIXTURES_DIR, 'test.getFolder() 返回值（主进程 test:getRoot）');
      A.check(t.info && typeof t.info.version === 'string', `app.info().version 应存在，实际 ${JSON.stringify(t.info && t.info.version)}`);
      A.check(t.versions && /^\d+\./.test(String(t.versions.electron)), `Electron 版本号应形如 44.x，实际 ${JSON.stringify(t.versions)}`);
      A.check(Number(String(t.versions.chrome).split('.')[0]) >= 120, `Chromium 版本应 >=120（决定哪些格式能解码），实际 ${t.versions.chrome}`);
      A.eq(t.platform, 'win32', 'window.gkpv.platform');
      A.note(`electron=${t.versions.electron} chrome=${t.versions.chrome} node=${t.versions.node} app=${t.info.version}`);
    },
  },

  {
    name: 'launch:no-pageerror',
    intent: '异常目录（edge/ 里有坏图/文本/HEIC/怪名字）整轮渲染下来没有任何 JS 未捕获异常',
    async fn(ctx) {
      const { A, session } = ctx;
      // 用同一个共享会话，但先把它导航到最有攻击性的目录
      const expected = ctx.expectedForDir('edge');
      await session.showDir('edge', { expectImages: expected.total });
      await session.page.waitForTimeout(500);
      const diag = await session.diagnostics();
      const renderDiag = await session.renderErrors();
      A.eq(session.pageErrors.length, 0, `页面未捕获异常数（${session.pageErrors.join(' | ')}）`);
      A.eq(renderDiag.length, 0, `window.__gkpvDiag.errors 应为空，实际 ${JSON.stringify(renderDiag)}`);
      A.check(diag.stats && typeof diag.stats === 'object', 'diagnostics().stats 应存在');
      A.note(`stats=${JSON.stringify(diag.stats)}`);
      if (session.consoleErrors.length) A.warn(`控制台 error 级别日志 ${session.consoleErrors.length} 条：${session.consoleErrors.slice(0, 3).join(' | ')}`);
    },
  },
];

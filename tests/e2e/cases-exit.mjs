/**
 * 退出类用例：窗口关闭 → 应用自己退出、不留僵尸进程、单实例第二次启动自动让位。
 *
 * ## 为什么这组值得单独测
 *
 * 桌面应用最常见的两个"看起来没事、实际很脏"的缺陷都在这里：
 *   1. **关掉窗口进程不退**：`window-all-closed` 没接 `app.quit()`（或接了但被别的东西挡住），
 *      于是用户关了窗口，任务管理器里还挂着一个 Electron 进程。
 *      这件事**只能靠观察真实进程是否消失**来断言 —— 界面看不出任何异常。
 *   2. **单实例锁没生效**：双击两次图标开出两个窗口、两个进程各占一套 OPFS 缓存。
 *
 * 所以本组的两条用例都是"真进程级"的：断言的是 `process.kill(pid, 0)` 的结果，
 * 而不是界面状态。
 *
 * ## 与运行器的约定
 *
 * `run.mjs` 里给 'exit' 这个根目录单开了一条会话（label='exit'，userData 独立）。
 * 本文件的第 1 条用例会**主动把这个会话关掉**，并把它自带的退出证据
 * （`Session.close()` 返回的 `{ms, forced, aliveAfter}`）取回来断言；
 * 运行器在 finally 里再调一次 `close()` 只会拿到缓存的同一份结果，不会重复关。
 *
 * 判定口径（关键）：
 *   - `forced === false` 才算"自己退的"。若进程要等 `taskkill` 才消失，
 *     那正是上面第 1 类缺陷，必须红。
 *   - 关闭耗时给足余量（默认 25s）：冷启动后紧接着关窗，Chromium 要收尾 GPU/网络进程。
 */
import { spawnSync } from 'node:child_process';
import { DESKTOP_DIR, resolveElectron, sleep, userDataFor } from './lib/paths.mjs';
import { isProcessAlive } from './lib/harness.mjs';

/** 等 pid 消失，返回等了多久（毫秒）；超时返回 -1。 */
async function waitGone(pid, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!isProcessAlive(pid)) return Date.now() - t0;
    await sleep(200);
  }
  return -1;
}

export default [
  {
    name: 'exit:close-window-quits-app',
    intent: '关掉唯一的窗口后应用自己退出（window-all-closed → app.quit），不需要 taskkill；且不留僵尸进程',
    async fn(ctx) {
      const { A } = ctx;
      const session = await ctx.sessionFor('exit');
      const pid = session.mainPid;
      A.check(pid > 0, `应拿到主进程 pid，实际 ${pid}`);
      A.eq(isProcessAlive(pid), true, `关窗前主进程应还活着（pid=${pid}）`);

      // 先确认这个会话是真的能用的（不是"启动失败所以进程没了"）
      const info = await session.page.evaluate(() => ({
        protocol: location.protocol,
        ready: !!(window.__gkpv && window.__gkpv.ready === true),
        title: document.title,
      }));
      A.eq(info.ready, true, '关窗之前界面应已就绪（否则下面测的不是"正常退出"）');
      A.eq(info.protocol, 'app:', '环境自检：走的仍是 app:// 协议');
      A.note(`会话 pid=${pid}，界面已就绪（${info.title}），准备关闭窗口`);

      // 关窗必须走主进程的 `BrowserWindow.close()`，这才等价于用户点右上角的 X，
      // 而且会真实触发 `window-all-closed` → `app.quit()` 这条产品路径。
      // 不能用 `page.close()` / `app.close()`：那是 Playwright 直接拆掉整个应用，
      // 进程当然会没，等于把要测的东西绕过去了（假绿）。
      let closeErr = null;
      try {
        await session.app.evaluate(({ BrowserWindow }) => {
          const wins = BrowserWindow.getAllWindows();
          if (!wins.length) throw new Error('没有窗口可关');
          wins[0].close();
        });
      } catch (e) {
        closeErr = e;
      }

      const goneMs = await waitGone(pid, 25000);
      A.eq(
        goneMs >= 0,
        true,
        `关掉唯一窗口后应用应自己退出，但 ${25}s 后进程 ${pid} 还活着 —— `
        + '检查 main.cjs 的 window-all-closed 分支是否还在调 app.quit()',
      );
      A.note(`窗口关闭后进程在 ${goneMs}ms 内自行退出（关闭调用本身的错误=${closeErr ? closeErr.message : '无'}）`);

      // 取回 Session.close() 的正式证据：forced 必须为 false（即没被强杀）
      const res = await session.close({ expectGone: true });
      A.eq(res.aliveAfter, false, `会话 ${pid} 关闭后进程不应残留（forced=${res.forced}）`);
      A.eq(
        res.forced,
        false,
        `进程是被 taskkill 强杀的，不是自己退的（说明上面的"自行退出"其实是超时兜底）`,
      );
      A.check(res.ms >= 0, 'close() 应记录耗时');
      A.note(`Session.close() 证据：pid=${res.pid} 用时 ${res.ms}ms，forced=${res.forced}，aliveAfter=${res.aliveAfter}`);
      A.note(`关闭时机器上 electron.exe 数量：前 ${res.before.count} → 后 ${res.after.count}`);
    },
  },

  {
    name: 'exit:single-instance-second-launch-yields',
    intent: '已有实例在跑时再启动一个进程：第二个必须立刻自行退出（单实例锁），第一个窗口不受影响、仍是活的',
    async fn(ctx) {
      const { A } = ctx;
      const session = ctx.session; // 共享的 fixtures 会话（label='main'）
      const firstPid = session.mainPid;
      const { exe, via } = resolveElectron();

      // 用**同一个 userData** 启动第二个实例：单实例锁是按 userData 判定的，
      // 换一个 userData 就会真的开出第二个窗口，那样测不出锁。
      const userData = await session.app.evaluate(({ app }) => app.getPath('userData'));
      A.check(userData, `应拿到第一个实例的 userData 路径，实际 ${JSON.stringify(userData)}`);

      const childEnv = { ...process.env };
      delete childEnv.ELECTRON_RUN_AS_NODE; // 必须删，否则 electron.exe 退化成纯 Node
      Object.assign(childEnv, {
        GKPV_TEST_MODE: '1',
        GKPV_TEST_ROOT: ctx.FIXTURES,
        GKPV_TEST_USERDATA: userData,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      });

      const t0 = Date.now();
      const r = spawnSync(exe, [DESKTOP_DIR], {
        env: childEnv,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
      });
      const ms = Date.now() - t0;

      A.check(
        !r.error || r.error.code !== 'ETIMEDOUT',
        `第二个实例应在单实例锁上立刻让位，实际等了 ${ms}ms 还在跑（被 timeout 掐掉）`,
      );
      // 让位的路径是 `if (!gotLock) app.quit();`，正常退出码 0。
      A.eq(
        r.status,
        0,
        `第二个实例应正常退出（exit code 0），实际 status=${r.status} signal=${r.signal}\n`
        + `stderr: ${String(r.stderr || '').slice(0, 800)}`,
      );

      // 第一个实例必须毫发无损：进程还在、窗口还是那一个、界面还能用
      A.eq(isProcessAlive(firstPid), true, `第二个实例让位后，第一个实例（pid=${firstPid}）必须还活着`);
      const w = await session.app.evaluate(({ BrowserWindow }) => {
        const all = BrowserWindow.getAllWindows();
        return { count: all.length, visible: all[0] ? all[0].isVisible() : false, title: all[0] ? all[0].getTitle() : null };
      });
      A.eq(w.count, 1, '第一个实例应仍然只有一个窗口（第二个进程不该把窗口开出来）');
      A.eq(w.visible, true, '第一个实例的窗口应仍然可见');
      A.eq(w.title, 'GKP 照片查看器', '第一个实例的窗口标题');

      const still = await session.page.evaluate(() => ({
        ready: !!(window.__gkpv && window.__gkpv.ready === true),
        cards: document.querySelectorAll('#gallery .card').length,
      }));
      A.eq(still.ready, true, '第一个实例的界面应仍然就绪（没被第二个进程搞崩）');
      A.check(still.cards > 0, `第一个实例的网格应仍有内容，实际 ${still.cards} 张磁贴`);

      A.note(
        `第二个实例（${via}）在 ${ms}ms 内退出，exit code=${r.status}；`
        + `第一个实例 pid=${firstPid} 未受影响（窗口数 ${w.count}，磁贴 ${still.cards} 张）`,
      );
      A.note(`两次启动共用 userData=${userData}`);
    },
  },

  {
    name: 'exit:no-orphan-electron-from-our-sessions',
    intent: '本轮所有会话的进程都真的退干净了，没有本套件留下的僵尸 electron.exe',
    async fn(ctx) {
      const { A } = ctx;

      // 先把已知会话逐个关掉（已关的会拿到缓存结果，不会重复关）。
      // 注意：不要在这里断言"机器上 electron.exe 总数为 0" —— 用户可能开着别的
      // Electron 应用，那会把环境噪声误判成产品缺陷。只针对**我们启动过的 pid**。
      const keys = ['fixtures', 'empty', 'missing', 'exit'];
      const pids = [];
      for (const key of keys) {
        let s = null;
        try {
          s = await ctx.sessionFor(key);
        } catch {
          continue; // 该会话本轮没被创建过（filter 跑单条时很常见）
        }
        const res = await s.close({ expectGone: true });
        pids.push({ key, pid: res.pid, forced: res.forced, aliveAfter: res.aliveAfter, ms: res.ms });
      }

      A.check(pids.length > 0, '本轮至少应有一个会话可以核对');

      const bad = [];
      for (const p of pids) {
        if (p.pid > 0 && isProcessAlive(p.pid)) bad.push(`${p.key}(pid=${p.pid})`);
      }
      A.eq(bad.length, 0, `以下会话的进程在关闭后仍然存活：${bad.join(', ')}`);

      const forcedOnes = pids.filter((p) => p.forced);
      if (forcedOnes.length) {
        A.warn(
          `有 ${forcedOnes.length} 个会话是被 taskkill 强杀的（不是自行退出）：`
          + forcedOnes.map((p) => `${p.key}(pid=${p.pid})`).join(', ')
          + ' —— 通常是关窗时序慢，若稳定复现请查 window-all-closed',
        );
      }

      A.note(
        '会话退出核对：'
        + pids.map((p) => `${p.key} pid=${p.pid} ${p.ms}ms forced=${p.forced} alive=${p.aliveAfter}`).join('；'),
      );
    },
  },
];

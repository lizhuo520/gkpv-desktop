/**
 * 缓存 / 幂等用例：同一目录连续打开两次结果必须一致、缩略图缓存真的被复用、
 * 缓存后端真的是 OPFS（能跨窗口 reload 存活），清空缓存后界面照常。
 *
 * 不在这里断言任何性能数字（任务书明确要求）——只用「命中计数增加 / 结果一致」做证据。
 */
import { sleep, waitTilesSettled } from './lib/harness.mjs';

const cacheStats = (session) => session.page.evaluate(() => window.__gkpv.cache.stats());
const cacheClear = (session) => session.page.evaluate(() => window.__gkpv.cache.clear());
const cacheStorage = (session) => session.page.evaluate(() => window.__gkpv.cache.storage());

/** 进 basic/ 并把「磁贴像素指纹 + 计数 + 快照」一起取回来，用于比较两次打开是否一致。 */
async function visitBasic(session, exp) {
  await session.showDir('basic', { expectImages: exp.total });
  const snap = await session.snapshot();
  const tiles = await session.tiles();
  const diag = await session.diagnostics();
  return {
    snap,
    diag,
    tiles,
    fingerprint: JSON.stringify(
      tiles
        .map((t) => [t.rel, t.naturalW, t.naturalH, t.thumbReady, t.hasSrc, t.boxW, t.boxH])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  };
}

export default [
  {
    name: 'cache:reopen-same-dir-idempotent',
    intent: '同一目录连续打开两次：报错为空、条目数与磁贴像素指纹完全一致、缩略图命中缓存',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('basic');
      await session.gotoRoot();

      const first = await visitBasic(session, exp);
      await session.gotoRoot();
      const second = await visitBasic(session, exp);

      A.eq(second.snap.errorHint, null, `第二次打开不应报错，实际「${second.snap.errorHint}」`);
      A.eq(second.snap.total, first.snap.total, '两次打开的图片条目数应一致');
      A.eq(second.snap.total, exp.total, '图片条目数应与 manifest 推导一致');
      A.eq(second.snap.folderCards, first.snap.folderCards, '两次打开的文件夹磁贴数应一致');
      A.eq(second.fingerprint, first.fingerprint, '两次打开的磁贴像素/尺寸指纹应完全一致');
      A.eq(second.diag.counts.images, first.diag.counts.images, 'diagnostics().counts.images 两次一致');

      const h1 = first.diag.stats && first.diag.stats.thumbHits;
      const h2 = second.diag.stats && second.diag.stats.thumbHits;
      A.check(
        typeof h2 === 'number' && typeof h1 === 'number',
        `diagnostics().stats 里应有 thumbHits（实际 stats 键：${Object.keys(second.diag.stats || {}).join(', ')}）`,
      );
      A.check(h2 > h1, `第二次打开同一目录应命中缩略图缓存（thumbHits 应从 ${h1} 增加），实际 ${h1} → ${h2}`);
      A.note(
        `basic/ 两次打开：${first.tiles.length} 张磁贴、指纹一致；thumbHits ${h1} → ${h2}，thumbMisses ${first.diag.stats.thumbMisses} → ${second.diag.stats.thumbMisses}；backend=${second.diag.cache && second.diag.cache.backend}`,
      );
      await session.gotoRoot();
    },
  },

  {
    name: 'cache:backend-opfs-and-clear',
    intent: '缓存后端是 OPFS（不是内存兜底）、清空缓存有反馈且清完界面照常渲染',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('basic');
      await session.showDir('basic', { expectImages: exp.total });

      const st = await cacheStats(session);
      A.check(st && typeof st === 'object', `__gkpv.cache.stats() 应返回对象，实际 ${JSON.stringify(st)}`);
      A.eq(st.backend, 'opfs', `缩略图缓存后端应是 OPFS（memory 表示 OPFS 不可用、缓存重启即失效）`);
      A.check(typeof st.entries === 'number', `cache.stats().entries 应是数字，实际 ${JSON.stringify(st)}`);
      const storage = await cacheStorage(session).catch(() => null);

      const cleared = await cacheClear(session);
      A.check(
        cleared === true || (cleared && cleared.ok === true),
        `clearCache() 应返回成功，实际 ${JSON.stringify(cleared)}`,
      );

      const after = await visitBasic(session, exp);
      A.eq(after.snap.errorHint, null, '清空缓存后重新进入目录不应报错');
      A.eq(after.snap.total, exp.total, '清空缓存后条目数不应变');
      const audit = await waitTilesSettled(session, exp.spec, { timeout: 30000 });
      A.eq(audit.violations.length, 0, `清空缓存后磁贴应重新生成成功：${audit.violations.slice(0, 6).join(' | ')}`);
      const st2 = await cacheStats(session);
      A.eq(st2.backend, 'opfs', '清空后缓存后端仍是 OPFS');
      A.note(
        `清空前 backend=${st.backend} entries=${st.entries} bytes=${st.bytes} memoryEntries=${st.memoryEntries}` +
          `；clear=${JSON.stringify(cleared)}；清空后 entries=${st2.entries}，正常磁贴 ${audit.good.length} 张` +
          `；storage=${storage ? JSON.stringify(storage) : '不可用'}`,
      );
      await session.gotoRoot();
    },
  },

  {
    name: 'cache:survives-window-reload',
    intent: '重新加载窗口后 OPFS 里的缩略图缓存仍在，再进同一目录仍然命中（证明是真持久缓存）',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('basic');
      await session.showDir('basic', { expectImages: exp.total });
      const before = await cacheStats(session);
      A.check(before.entries > 0, `进入 basic/ 后 OPFS 缓存里应有条目，实际 ${JSON.stringify(before)}`);

      await session.page.reload({ waitUntil: 'domcontentloaded' });
      await session.page.waitForFunction(() => !!(window.__gkpv && window.__gkpv.ready === true), undefined, {
        timeout: 60000,
      });
      await session.waitSettled({ timeout: 120000, what: '窗口重载后重新打开素材目录' });

      const after = await cacheStats(session);
      A.eq(after.backend, 'opfs', '重载后缓存后端仍是 OPFS');
      A.check(
        after.entries >= 1,
        `窗口重载后 OPFS 缓存条目应还在（重载前 ${before.entries} 条），实际 ${after.entries} 条`,
      );

      const visit = await visitBasic(session, exp);
      A.eq(visit.snap.total, exp.total, '重载后进 basic/ 的条目数');
      const hits = visit.diag.stats && visit.diag.stats.thumbHits;
      A.check(
        typeof hits === 'number' && hits >= 1,
        `重载后进 basic/ 应直接命中缓存（thumbHits >= 1），实际 ${JSON.stringify(visit.diag.stats)}`,
      );
      const renderErrors = await session.renderErrors();
      A.eq(renderErrors.length, 0, `窗口重载不应产生未捕获异常：${JSON.stringify(renderErrors)}`);
      A.note(
        `重载前 entries=${before.entries} bytes=${before.bytes}；重载后 entries=${after.entries} bytes=${after.bytes}；重载后进 basic/ thumbHits=${hits}`,
      );
      await sleep(100);
      await session.gotoRoot();
    },
  },
];

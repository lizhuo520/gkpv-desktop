/**
 * 边界用例：空目录、不存在的目录、隐藏文件/非图片不上屏、坏文件不卡死整个网格、
 * 带空格/中文/括号/超长文件名、嵌套的空目录。
 *
 * 期望值全部由 manifest.json + 真实目录走查推导（见 lib/fixtures.mjs）。
 */
import { sweepTiles, auditTiles } from './lib/harness.mjs';
import { isImageName, isHiddenName, scanDir } from './lib/fixtures.mjs';

const tileNames = async (session) =>
  session.page.evaluate(() =>
    [...document.querySelectorAll('#gallery .card:not(.folder-card)')].map((c) => {
      const l = c.querySelector('.label');
      return l ? l.textContent : '';
    }),
  );

export default [
  {
    name: 'edge:empty-dir',
    intent: '把空的临时目录当素材目录：不报错、给出「没有图片或子文件夹」空态、计数为 0',
    async fn(ctx) {
      const { A } = ctx;
      const session = await ctx.sessionFor('empty');
      const snap = await session.snapshot();
      A.check(snap.emptyHint, `空目录应给出空态提示，实际 snapshot=${JSON.stringify({ cards: snap.cards, folderCards: snap.folderCards, errorHint: snap.errorHint, counterText: snap.counterText })}`);
      A.eq(snap.emptyHint, '此目录下没有图片或子文件夹。', '空态文案');
      A.eq(snap.errorHint, null, '空目录不应报错');
      A.eq(snap.cards, 0, '空目录的图片磁贴数');
      A.eq(snap.folderCards, 0, '空目录的文件夹磁贴数');
      A.eq(snap.counterText.trim(), '0 张图片，0 个文件夹', '空目录计数文案');
      A.eq(snap.landingDisplay, 'none', '打开成功后应隐藏首屏');
      A.eq(snap.toolbarDisplay, 'flex', '打开成功后应显示工具栏');
      const renderErrors = await session.renderErrors();
      A.eq(renderErrors.length, 0, `不应有未捕获 JS 异常：${JSON.stringify(renderErrors)}`);
      A.note(`空目录 ${ctx.EMPTY_DIR}：空态「${snap.emptyHint}」，计数「${snap.counterText.trim()}」`);
    },
  },

  {
    name: 'edge:missing-dir',
    intent: 'GKPV_TEST_ROOT 指向不存在的目录：界面给出明确错误、不进浏览器视图、不抛未捕获异常',
    async fn(ctx) {
      const { A } = ctx;
      const session = await ctx.sessionFor('missing');
      const snap = await session.snapshot();
      A.check(snap.errorHint, `不存在的目录应给出错误提示，实际 snapshot=${JSON.stringify(snap)}`);
      A.check(
        snap.errorHint.startsWith('读取目录出错：'),
        `错误提示应形如「读取目录出错：…」，实际「${snap.errorHint}」`,
      );
      A.check(/目录不存在/.test(snap.errorHint), `错误提示应说明目录不存在，实际「${snap.errorHint}」`);
      A.check(
        snap.errorHint.includes(ctx.path.basename(ctx.MISSING_DIR)),
        `错误提示应带上出错的目录名，实际「${snap.errorHint}」`,
      );
      A.eq(snap.cards, 0, '失败时不应有图片磁贴');
      A.eq(snap.folderCards, 0, '失败时不应有文件夹磁贴');
      A.eq(snap.toolbarDisplay, 'none', '目录挂载失败时不应进入浏览器视图（工具栏不该显示）');
      A.check(snap.landingDisplay !== 'none', `失败时首屏应还在（display=${snap.landingDisplay}）`);
      const renderErrors = await session.renderErrors();
      A.eq(
        renderErrors.length,
        0,
        `目录不存在属于可预期的错误，不该进未捕获异常钩子：${JSON.stringify(renderErrors)}`,
      );
      const source = await session.page.evaluate(() => {
        const s = window.__gkpv.state();
        return { sourceId: s.sourceId, sourceRoot: s.sourceRoot };
      });
      A.eq(source.sourceId, null, '挂载失败时不应有已挂载的目录句柄');
      A.note(`不存在的目录 ${ctx.MISSING_DIR} → 提示「${snap.errorHint}」`);
    },
  },

  {
    name: 'edge:hidden-and-non-image-not-listed',
    intent: 'edge/ 里隐藏文件、非图片、无扩展名文件都不上屏；空子目录仍作为文件夹出现',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('edge');
      const onDisk = scanDir(`${ctx.FIXTURES}\\edge`);
      await session.showDir('edge', { expectImages: exp.total });

      const names = await tileNames(session);
      const counters = await session.counters();
      A.eq(counters.total, exp.total, 'edge/ 的图片条目数（manifest 推导，= 目录里可扫描的图片文件数）');
      A.check(exp.total >= 4, `edge/ 图片数下界保护（>=4），实际 ${exp.total}`);

      for (const n of names) {
        A.check(!isHiddenName(n), `隐藏文件不该上屏：${n}`);
        A.check(isImageName(n), `非图片文件不该上屏：${n}`);
      }
      for (const gone of ['.hidden-image.png', 'not-an-image.txt', 'unknown.xyz', 'no-extension']) {
        A.check(!names.includes(gone), `「${gone}」不应出现在网格里，实际网格：${JSON.stringify(names)}`);
      }

      const snap = await session.snapshot();
      A.check(snap.folderCards >= 1, `edge/ 里应显示 1 个空子目录（empty-dir），实际 ${snap.folderCards}`);
      const folders = await session.page.evaluate(() => [...document.querySelectorAll('#gallery .folder-card')].map((c) => c._folderName));
      A.check(folders.includes('empty-dir'), `文件夹磁贴里应有 empty-dir，实际 ${JSON.stringify(folders)}`);
      A.eq(snap.folderCards, onDisk.folders.length, `edge/ 文件夹磁贴数（目录走查 ${JSON.stringify(onDisk.folders)}）`);
      A.note(`edge/ 上屏 ${names.length} 张图：${names.join(' | ')}；文件夹：${folders.join(', ')}`);
      await session.gotoRoot();
    },
  },

  {
    name: 'edge:broken-files-do-not-block-grid',
    intent: '坏图（0 字节/截断）有明确的失败表现且不阻塞其它磁贴；失败数在计数器里说得出来',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('edge');
      await session.showDir('edge', { expectImages: exp.total });

      const sweep = await sweepTiles(session, exp.spec);
      A.eq(sweep.violations.length, 0, `磁贴审计不应有违规：\n  ${sweep.violations.join('\n  ')}`);
      A.eq(sweep.good.size, exp.good.size, `正常图片应全部出图（期望 ${exp.good.size} 张）`);
      A.eq(sweep.broken.size, exp.broken.size, `坏图应全部有失败表现（期望 ${[...exp.broken].join(', ')}）`);
      A.eq(sweep.unsupported.size, exp.unsupported.size, `不可解码格式应走占位（期望 ${[...exp.unsupported].join(', ')}）`);

      // 网格没卡死：坏图之外还能正常交互（切布局仍然正常渲染）
      const snap = await session.snapshot();
      A.check(snap.cards > 0, '坏图不应让整个网格空掉');
      const audit = await auditTiles(session, exp.spec);
      A.eq(audit.violations.length, 0, `坏图在场时审计仍应无违规：${audit.violations.join(' | ')}`);

      // 失败要「说得出来」：计数器追加失败张数，title 里列出失败文件名
      const counterText = snap.counterText;
      const m = /(\d+)\s*张缩略图生成失败/.exec(counterText);
      A.check(
        m && Number(m[1]) >= exp.broken.size,
        `计数器应追加「（N 张缩略图生成失败）」且 N >= ${exp.broken.size}，实际「${counterText}」`,
      );
      const title = await session.page.evaluate(() => document.getElementById('counter').title);
      const namedBroken = [...exp.broken].filter((n) => title.includes(n));
      A.check(
        namedBroken.length >= 1,
        `计数器 title 应列出失败的图片名，实际 title=「${title}」`,
      );

      const diag = await session.diagnostics();
      const thumbErrors = (diag.stats.errors || []).filter((e) => e.where === 'thumb');
      A.check(
        thumbErrors.length >= exp.broken.size,
        `diagnostics().stats.errors 里应有 >= ${exp.broken.size} 条缩略图失败记录，实际 ${thumbErrors.length}：${JSON.stringify(thumbErrors.slice(0, 4))}`,
      );
      A.note(`坏图 ${sweep.broken.size} 张（${[...sweep.broken].join(', ')}）；计数器「${counterText.trim()}」；title 命中 ${namedBroken.join(', ')}`);
      A.note(`stats.errors(thumb)=${thumbErrors.length}；正常图 ${sweep.good.size}/${exp.good.size}；占位 ${sweep.unsupported.size}`);
      await session.gotoRoot();
    },
  },

  {
    name: 'edge:weird-names-and-nested-empty-dir',
    intent: '带空格/中文/括号与超长文件名的图照常出图；嵌套的空目录能进去且给出空态',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('edge');
      await session.showDir('edge', { expectImages: exp.total });

      // 名字最长的那个 + 带空格中文括号的那个，都必须出图
      const longest = [...exp.byTile.keys()].sort((a, b) => b.length - a.length)[0];
      const weird = [...exp.byTile.keys()].find((n) => /[ 　（(]/.test(n) && /[\u4e00-\u9fa5]/.test(n));
      A.check(!!weird, `edge/ 里应有带空格/中文的素材，实际 ${JSON.stringify([...exp.byTile.keys()])}`);
      const sweep = await sweepTiles(session, exp.spec);
      for (const name of [longest, weird]) {
        const t = sweep.good.get(name);
        A.check(!!t, `「${name}」应渲染出磁贴并被审计为正常图（实际审计覆盖 ${sweep.good.size} 张）`);
        A.check(t.naturalW > 0 && t.naturalH > 0, `「${name}」应出图，实际 ${t.naturalW}x${t.naturalH}`);
        A.check(t.boxW > 0 && t.boxH > 0, `「${name}」磁贴尺寸应 > 0，实际 ${t.boxW}x${t.boxH}`);
      }

      // 嵌套的空目录：点进去 → 空态 + 面包屑
      const snap = await session.enterFolder('empty-dir', { expectImages: 0 });
      A.check(snap.emptyHint, `嵌套空目录应给出空态，实际 ${JSON.stringify(snap)}`);
      A.eq(snap.counterText.trim(), '0 张图片，0 个文件夹', '嵌套空目录的计数文案');
      A.check(
        snap.breadcrumbs.length >= 3 && snap.breadcrumbs.includes('empty-dir') && snap.breadcrumbs.includes('edge'),
        `面包屑应包含 edge / empty-dir，实际 ${JSON.stringify(snap.breadcrumbs)}`,
      );
      const errs = await session.renderErrors();
      A.eq(errs.length, 0, `不应有未捕获异常：${JSON.stringify(errs)}`);
      A.note(`长名「${longest}」与「${weird}」均出图；嵌套空目录 breadcrumbs=${JSON.stringify(snap.breadcrumbs)}`);
      await session.gotoRoot();
    },
  },
];

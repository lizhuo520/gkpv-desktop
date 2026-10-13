/**
 * 图库类用例：打开目录、递归扫描、磁贴数量、多格式像素、UI 控件。
 * 期望值全部从 manifest.json + 真实目录走查推导，不硬编码张数。
 */
import { folderCards, sectionTitles, sweepTiles, auditTiles, sleep, waitThumbGenDone } from './lib/harness.mjs';
import { scanDir } from './lib/fixtures.mjs';

const uiState = (session) =>
  session.page.evaluate(() => {
    const s = window.__gkpv.state();
    return {
      layoutMode: s.layoutMode,
      sortMode: s.sortMode,
      sizeKey: s.currentSizeKey,
      recursive: s.recursiveMode,
      images: s.currentImages.length,
      folders: s.currentFolderCount,
    };
  });

const num = (text, label) => {
  const m = new RegExp(`${label}\\s*\\((\\d+)\\)`).exec(String(text || ''));
  return m ? Number(m[1]) : null;
};

export default [
  {
    name: 'gallery:root-folder-view',
    intent: '打开素材目录后停在根目录视图：7 个文件夹磁贴、0 张图片磁贴、面包屑与计数器正确',
    async fn(ctx) {
      const { A, session } = ctx;
      await session.gotoRoot();
      const top = scanDir(ctx.FIXTURES);
      const cards = await folderCards(session);
      const titles = await sectionTitles(session);
      const snap = await session.snapshot();
      const counters = await session.counters();

      A.check(top.folders.length >= 3, `素材根目录至少应有 3 个子文件夹，实际 ${top.folders.length}`);
      A.eq(cards.length, top.folders.length, '文件夹磁贴数量应与目录里真实子文件夹数一致');
      A.eq(new Set(cards.map((c) => c.name)).size, top.folders.length, '文件夹磁贴名字不应重复');
      for (const c of cards) {
        A.check(top.folders.includes(c.name), `磁贴 ${c.name} 应在真实子目录列表里`);
        A.check(c.icon.length > 0 || c.mosaicImgs > 0, `文件夹磁贴 ${c.name} 应有图标（📁 或预览拼图，二者必居其一）`);
        A.check(c.boxW > 0 && c.boxH > 0, `文件夹磁贴 ${c.name} 尺寸应 > 0，实际 ${c.boxW}x${c.boxH}`);
      }
      A.eq(num(titles.join(' '), '文件夹'), top.folders.length, '「文件夹 (N)」标题数字');
      A.eq(snap.cards, 0, `根目录不应有图片磁贴（真实图片数 ${top.images.length}）`);
      A.eq(counters.total, 0, '根目录图片条目数');
      A.check(/^0 张图片/.test(snap.counterText), `计数器文案应以「0 张图片」开头，实际「${snap.counterText}」`);
      A.check(new RegExp(`，${top.folders.length} 个文件夹`).test(snap.counterText), `计数器应含「，${top.folders.length} 个文件夹」，实际「${snap.counterText}」`);
      A.eq(snap.breadcrumbs.length, 1, `面包屑应只有根节点，实际 ${JSON.stringify(snap.breadcrumbs)}`);
      A.note(`根目录：folders=${top.folders.join(',')}；counter=「${snap.counterText}」；crumb=「${snap.breadcrumbs[0]}」`);
    },
  },

  {
    name: 'gallery:enter-subdir-exact-count',
    intent: '点进 basic/：图片条目数与 manifest 推导值完全一致，分区标题正确',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('basic');
      A.check(exp.total >= 8, `basic/ 的期望图片数应 >= 8，实际 ${exp.total}`);
      const snap = await session.showDir('basic', { expectImages: exp.total });
      const counters = await session.counters();
      const titles = await sectionTitles(session);
      const diag = await session.diagnostics();
      const dir = diag.dir;

      A.eq(counters.total, exp.total, 'basic/ 的图片条目数');
      A.eq(snap.folderCards, 0, 'basic/ 下不应有文件夹磁贴');
      A.eq(num(titles.join(' '), '图片'), exp.total, '「图片 (N)」标题数字');
      A.check(String(dir).replace(/\\/g, '/').endsWith('basic'), `diagnostics().dir 应指向 basic，实际 ${JSON.stringify(dir)}`);
      A.note(`basic/：${exp.total} 张（期望的坏图 ${[...exp.broken].join(',') || '无'}）`);
    },
  },

  {
    name: 'gallery:subdir-tiles-all-pixels',
    intent: 'basic/ 每张图都渲染出可见缩略图（img 有 src 且像素尺寸 > 0），坏文件不影响其它磁贴',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('basic');
      await session.showDir('basic', { expectImages: exp.total });
      const sweep = await sweepTiles(session, exp.spec);
      A.eq(sweep.violations.length, 0, `磁贴审计不应有违规：\n  ${sweep.violations.join('\n  ')}`);
      A.eq(sweep.good.size, exp.good.size, `所有正常图片都应渲染出像素（滚动扫描覆盖数 vs 期望数）`);
      A.eq(sweep.broken.size, exp.broken.size, `坏图应全部有「明确的失败表现」（thumb-ready 且无图源）`);
      for (const [rel, t] of sweep.good) {
        A.check(t.naturalW > 0 && t.naturalH > 0, `${rel} 的 img 像素尺寸应 > 0，实际 ${t.naturalW}x${t.naturalH}`);
        A.check(t.boxW > 0 && t.boxH > 0, `${rel} 的磁贴盒子尺寸应 > 0，实际 ${t.boxW}x${t.boxH}`);
      }
      A.note(`覆盖 ${sweep.good.size}/${exp.good.size} 张正常图 + ${sweep.broken.size} 张坏图；滚动 ${sweep.steps} 步，maxScroll=${sweep.maxScroll}`);
    },
  },

  {
    name: 'gallery:recursive-matches-manifest',
    intent: '递归扫描：条目数 = 目录树里所有图片数（67 级别），未截断，计数文案标出「含子文件夹」，关掉后回到根视图',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expected; // 递归期望
      await session.gotoRoot();
      const turnedOn = await session.setRecursive(true);
      A.eq(turnedOn, true, '「子文件夹：开」按钮应可点击');
      const snap = await session.waitSettled({ expectImages: exp.total, timeout: 180000, what: '递归渲染' });
      // 缩略图是**按已渲染的行**惰性入队的（renderGallery 建行时才 enqueueRowThumbnails），
      // 虚滚动没滚到的行根本不会去请求缩略图 —— 不把列表滚穿，done 永远追不上 total，
      // 计数器就一直停在「正在生成缩略图 (59/67)…」。所以要断言最终文案，必须先整列表扫一遍。
      // （实测：不扫是 59/67 卡住；扫完 67/67 并写出「含子文件夹」文案。）
      const sweep = await sweepTiles(session, exp.spec, { stepPx: 500, settleMs: 200 });
      const gen = await waitThumbGenDone(session, { timeout: 120000 });
      const finalText = String(gen.snapshot.counterText);
      const counters = await session.counters();
      const diag = await session.diagnostics();

      A.eq(counters.total, exp.total, '递归模式下图片条目数（应等于目录树里所有可扫描图片数）');
      A.check(exp.total >= 20, `递归素材数应 >= 20（下界保护），实际 ${exp.total}`);
      A.eq(diag.counts.truncated, false, '递归扫描不应被上限截断');
      A.eq(diag.counts.recursive, true, 'diagnostics().counts.recursive');
      A.check(/含子文件夹/.test(finalText), `计数文案应标出「含子文件夹」，实际「${finalText}」`);
      A.check(!/正在生成缩略图/.test(finalText), `缩略图应已全部生成完，实际「${finalText}」`);
      A.note(`最终计数文案=「${finalText}」（等待生成结束 ${gen.ms}ms；滚动 ${sweep.steps} 步铺满入队）`);
      // 递归模式仍然只把**当前目录的直接子目录**做成文件夹磁贴（网页版 gkpv.html:1350-1355 正是如此：
      // 子目录里的图被摊平到同一层，但不为深层目录额外生成磁贴），所以期望值 = 根目录的直接子目录数。
      const topFolders = scanDir(ctx.FIXTURES).folders.length;
      A.eq(snap.folderCards, topFolders, `递归模式下文件夹磁贴数应仍是根目录的直接子目录数（${topFolders}）`);

      const turnedOff = await session.setRecursive(false);
      A.eq(turnedOff, true, '「子文件夹：关」应可点击');
      const back = await session.waitSettled({ timeout: 60000, what: '退回根视图' });
      A.eq(back.cards, 0, '关掉递归后应回到根视图（0 张图片磁贴）');
      A.eq(back.counterText.includes('含子文件夹'), false, '关掉递归后计数文案不应再标「含子文件夹」');
      A.note(`递归条目数=${counters.total}（manifest 推导 ${exp.total}）；counter=「${snap.counterText}」`);
    },
  },

  {
    name: 'gallery:recursive-renders-every-tile',
    intent: '递归视图滚动到底：每张图（含各子目录里的）都被渲染出可见缩略图，无空白磁贴',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expected;
      await session.gotoRoot();
      await session.setRecursive(true);
      await session.waitSettled({ expectImages: exp.total, timeout: 180000, what: '递归渲染' });
      const sweep = await sweepTiles(session, exp.spec, { stepPx: 500, settleMs: 260 });
      A.eq(sweep.violations.length, 0, `递归滚动审计不应有违规：\n  ${sweep.violations.slice(0, 12).join('\n  ')}`);
      A.check(
        sweep.good.size >= exp.good.size,
        `滚动到底应覆盖全部 ${exp.good.size} 张正常图，实际只看到 ${sweep.good.size}（虚拟滚动/懒加载可能没跟上）`,
      );
      A.eq(sweep.broken.size, exp.broken.size, '递归模式下坏图数量');
      A.eq(sweep.unsupported.size, exp.unsupported.size, '递归模式下 HEIC 占位数量');
      A.note(`递归扫描覆盖正常图 ${sweep.good.size}、坏图 ${sweep.broken.size}、HEIC 占位 ${sweep.unsupported.size}；滚动 ${sweep.steps} 步 maxScroll=${sweep.maxScroll}`);
      await session.setRecursive(false);
      await session.waitSettled({ timeout: 60000, what: '退回根视图' });
    },
  },

  {
    name: 'gallery:subdir-counts-multi',
    intent: '多个子目录的磁贴数各自吻合（exif/ 9 图、raw/ 5 图、nested/ 0 图 + 2 子目录）',
    async fn(ctx) {
      const { A, session } = ctx;
      // 每个目录各自的下界保护（不能用统一的 exp.total >= 4）：
      // nested/ 里一张直属图片都没有 —— 4 张图全在 nested/level1/… 与 nested/other/… 里，
      // 非递归视图本该是「0 张图片 + 2 个文件夹磁贴」。
      const dirs = [
        { dir: 'exif', minImages: 4, minFolders: 0 },
        { dir: 'raw', minImages: 4, minFolders: 0 },
        { dir: 'nested', minImages: 0, minFolders: 2 },
      ];
      for (const { dir, minImages, minFolders } of dirs) {
        const exp = ctx.expectedForDir(dir);
        const real = scanDir(`${ctx.FIXTURES}\\${dir}`);
        await session.showDir(dir, { expectImages: exp.total });
        const snap = await session.snapshot();
        A.eq(snap.total, exp.total, `${dir}/ 图片条目数（manifest 推导）`);
        A.eq(snap.folderCards, real.folders.length, `${dir}/ 文件夹磁贴数（目录走查）`);
        A.check(exp.total >= minImages, `${dir}/ 直属图片数应 >= ${minImages}（下界保护），实际 ${exp.total}`);
        A.check(real.folders.length >= minFolders, `${dir}/ 子目录数应 >= ${minFolders}（下界保护），实际 ${real.folders.length}`);
        A.note(`${dir}/：${exp.total} 图 + ${real.folders.length} 子目录`);
      }
      await session.gotoRoot();
    },
  },

  {
    name: 'gallery:ui-controls',
    intent: '布局/尺寸/排序控件真的生效：state 变化、磁贴仍正常、排序顺序严格反转',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('basic');
      await session.showDir('basic', { expectImages: exp.total });

      const s0 = await uiState(session);
      A.eq(s0.layoutMode, 'justified', '默认布局');
      A.eq(s0.sortMode, 'name-asc', '默认排序');

      // 布局：justified -> grid
      await session.page.evaluate(() => document.querySelector('.layout-group button[data-layout="grid"]').click());
      await sleep(400);
      const s1 = await uiState(session);
      A.eq(s1.layoutMode, 'grid', '点「网格」后 state.layoutMode');
      const g1 = await auditTiles(session, exp.spec);
      A.eq(g1.violations.length, 0, `切到网格布局后磁贴仍应正常：${g1.violations.join(' | ')}`);

      // 尺寸：md -> lg（用菜单命令走一遍，顺便验证命令总线）
      const okSize = await session.page.evaluate(() => window.__gkpv.command('size-lg'));
      A.eq(okSize, true, "命令 'size-lg' 应被接受");
      await sleep(300);
      const s2 = await uiState(session);
      A.eq(s2.sizeKey, 'lg', '点「大图」后 state.currentSizeKey');

      // 排序：name-asc -> name-desc 必须是严格反转
      const asc = (await session.entries()).map((e) => e.name);
      await session.page.evaluate(() => {
        const sel = document.getElementById('sortSelect');
        sel.value = 'name-desc';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await session.waitSettled({ expectImages: exp.total, timeout: 60000, what: '按名字倒序重排' });
      const s3 = await uiState(session);
      const desc = (await session.entries()).map((e) => e.name);
      A.eq(s3.sortMode, 'name-desc', '选「名称 Z→A」后 state.sortMode');
      A.check(asc.length === exp.total, `排序前条目数应=${exp.total}，实际 ${asc.length}`);
      A.eq(JSON.stringify(desc), JSON.stringify([...asc].reverse()), '名称倒序应严格等于名称正序的反转');

      // 复原，避免污染后续用例
      await session.page.evaluate(() => {
        const sel = document.getElementById('sortSelect');
        sel.value = 'name-asc';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await session.page.evaluate(() => document.querySelector('.layout-group button[data-layout="justified"]').click());
      await session.page.evaluate(() => window.__gkpv.command('size-md'));
      await session.waitSettled({ expectImages: exp.total, timeout: 60000, what: '复原 UI 状态' });
      const s4 = await uiState(session);
      A.eq(s4.sortMode, 'name-asc', '复原后的排序');
      A.eq(s4.layoutMode, 'justified', '复原后的布局');
      A.eq(s4.sizeKey, 'md', '复原后的尺寸');
      A.note(`控件往返：layout ${s0.layoutMode}→${s1.layoutMode}→${s4.layoutMode}；size ${s0.sizeKey}→${s2.sizeKey}→${s4.sizeKey}；sort ${s0.sortMode}→${s3.sortMode}→${s4.sortMode}`);
    },
  },
];

/**
 * RAW 类用例：5 个容器（ARW/NEF/CR2/DNG）的内嵌预览必须能出图，灯箱里也不能空白。
 * 期望值全部来自 manifest（expect.w/h + orientation + previewEmbedded）。
 */
import { sweepTiles, openLightboxAt, waitLightboxImage } from './lib/harness.mjs';
import { extOf, RAW_EXTS } from './lib/fixtures.mjs';

/**
 * 期望的显示宽高比。
 * 注意：manifest 的 expect.w/h **已经是转正后的显示尺寸**（tools/gen-fixtures.mjs 里
 * `w: orientation >= 5 ? fullHeight : fullWidth` 那次互换就是它），所以这里直接相除。
 * 曾经这里按 orientation 又交换了一次，等于把期望值算成「传感器存储朝向」的比值，
 * 结果竖拍 RAW 明明转正了却被判违规（AR 互为倒数）。
 */
const displayedAR = (f) => f.expect.w / f.expect.h;

export default [
  {
    name: 'raw:embedded-previews-parsed',
    intent: '每个 RAW 容器都能从内嵌 JPEG 预览里解析出尺寸/方向（走 __gkpv.rawPreview，绕开扫描缓存）',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('raw');
      A.check(exp.total >= 4, `RAW 素材应 >= 4 个（下界保护），实际 ${exp.total}`);
      const exts = new Set(exp.files.map((f) => extOf(f.name)));
      A.check([...exts].every((e) => RAW_EXTS.has(e)), `raw/ 里应都是 RAW 容器扩展名，实际 ${[...exts].join(',')}`);
      await session.showDir('raw', { expectImages: exp.total });
      for (const f of exp.files) {
        const pv = await session.page.evaluate((rel) => window.__gkpv.rawPreview(rel), f.rel);
        A.check(pv, `${f.rel} 应能解析出内嵌预览，实际 ${JSON.stringify(pv)}`);
        A.check(pv.bytes > 0, `${f.rel} 内嵌预览字节数应 > 0，实际 ${pv.bytes}`);
        A.check(/^image\//.test(String(pv.type || '')), `${f.rel} 内嵌预览应是 image/* 类型，实际 ${pv.type}`);
        if (f.expect) {
          A.eq(pv.w, f.expect.w, `${f.rel} 内嵌预览宽（manifest 期望 = 容器里存的尺寸）`);
          A.eq(pv.h, f.expect.h, `${f.rel} 内嵌预览高`);
        }
        if (f.expect && f.expect.orientation != null) {
          // 容器方向 -> 实际会补转的角度：只有 5~8 才转 90°。
          // 2/3/4（镜像 / 180°）两条路径都不处理，这是**与网页版一致的已知缺口**
          // （gkpv.html:1089 写死 `orientation >= 5 && orientation <= 8`，
          //  桌面版 raw.js 的读盘路径与扫描下发路径都照抄同一条判定），
          // 所以这里按同一规则断言，而不是无条件要求 pv.orient === 容器方向
          // （那会把「已知缺口」判成回归）。
          const o = Number(f.expect.orientation);
          const want = o >= 5 && o <= 8 ? o : 1;
          A.eq(
            Number(pv.orient || 0),
            want,
            `${f.rel} 应补转的角度（容器方向 ${o}${want === 1 && o > 1 ? '：2/3/4 属已知缺口，不补转' : ''}）`,
          );
        }
        if (!f.expect || !f.expect.previewEmbedded) A.warn(`${f.rel} 的 manifest 没标 previewEmbedded，但确实解析出了预览`);
        A.note(`${f.rel}: ${pv.w}x${pv.h} orient=${pv.orient} ${pv.bytes}B ${pv.type}`);
      }
      A.note(`RAW 容器：${exp.files.map((f) => f.name).join(', ')}`);
    },
  },

  {
    name: 'raw:tiles-not-blank',
    intent: 'raw/ 的 5 张磁贴全部出图不空白，且显示宽高比按容器方向校正过（6/8 的必须长宽互换）',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('raw');
      await session.showDir('raw', { expectImages: exp.total });
      const sweep = await sweepTiles(session, exp.spec);
      A.eq(sweep.violations.length, 0, `raw/ 磁贴审计不应有违规（空白磁贴会出现在这里）：\n  ${sweep.violations.join('\n  ')}`);
      A.eq(sweep.good.size, exp.good.size, 'raw/ 每张 RAW 都应渲染出内嵌预览缩略图');
      let swappedChecked = 0;
      for (const f of exp.files) {
        const t = sweep.good.get(f.name);
        A.check(t, `${f.rel} 应有缩略图磁贴`);
        A.check(t.naturalW > 0 && t.naturalH > 0, `${f.rel} 的 img 像素尺寸应 > 0，实际 ${t.naturalW}x${t.naturalH}`);
        A.check(t.boxW > 0 && t.boxH > 0, `${f.rel} 的磁贴盒子应 > 0，实际 ${t.boxW}x${t.boxH}`);
        const wantAR = f.expect ? displayedAR(f) : null;
        const gotAR = t.naturalW / t.naturalH;
        if (wantAR) {
          A.near(gotAR, wantAR, 0.05, `${f.rel} 显示宽高比（容器方向 ${f.expect.orientation} 应校正）`);
          if ([5, 6, 7, 8].includes(Number(f.expect.orientation))) swappedChecked += 1;
        }
        A.note(`${f.rel}: 磁贴 ${t.naturalW}x${t.naturalH}（AR ${gotAR.toFixed(3)}，期望 ${wantAR ? wantAR.toFixed(3) : 'n/a'}）`);
      }
      A.check(swappedChecked >= 1, '至少要有一张 RAW 的方向需要交换长宽轴，否则这条用例没意义');
    },
  },

  {
    name: 'raw:lightbox-not-blank',
    intent: '灯箱里逐张切过 5 张 RAW：都有图、不空白，标题/索引跟着变',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('raw');
      await session.showDir('raw', { expectImages: exp.total });
      const entries = await session.entries();
      A.eq(entries.length, exp.total, 'raw/ 条目数');
      const firstIdx = 0;
      let snap = await openLightboxAt(session, firstIdx);
      A.eq(snap.open, true, '点开 RAW 后灯箱应是打开状态');
      for (let i = 0; i < exp.total; i += 1) {
        const cur = entries[i];
        A.check(snap.hasSrc || snap.msgShown, `第 ${i + 1} 张（${cur.name}）灯箱不应空白：既没图也没提示`);
        if (snap.hasSrc) A.check(snap.naturalW > 0 && snap.naturalH > 0, `${cur.name} 灯箱图片像素应 > 0，实际 ${snap.naturalW}x${snap.naturalH}`);
        A.check(String(snap.info || '').includes(cur.name), `灯箱标题应包含文件名 ${cur.name}，实际「${snap.info}」`);
        A.check(new RegExp(`\\(\\s*${i + 1}\\s*/\\s*${exp.total}\\s*\\)`).test(String(snap.info || '')), `灯箱索引应是 (${i + 1} / ${exp.total})，实际「${snap.info}」`);
        A.note(`${cur.name}: ${snap.hasSrc ? `${snap.naturalW}x${snap.naturalH}` : `提示「${snap.msg}」`}；info=「${snap.info}」`);
        if (i < exp.total - 1) {
          await session.page.evaluate(() => window.__gkpv.lightbox.next());
          snap = await waitLightboxImage(session);
        }
      }
      await session.page.evaluate(() => window.__gkpv.lightbox.close());
      await session.gotoRoot();
    },
  },
];

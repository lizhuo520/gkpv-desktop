/**
 * 方向用例（回归价值最高）：EXIF orientation 6/8 的显示宽高比必须与正立图互为倒数。
 * 网页版当年就是在这里出过真 bug。
 */
import { sweepTiles, openLightboxAt } from './lib/harness.mjs';

const SWAP = [5, 6, 7, 8];
const orientOf = (f) => Number((f.expect && f.expect.orientation) || 0);

export default [
  {
    name: 'orient:swapped-axes-are-reciprocal',
    intent: 'orient-6 / orient-8 的显示宽高比与正立图（orientation 1）互为倒数（容差 5%）',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('exif');
      await session.showDir('exif', { expectImages: exp.total });
      const sweep = await sweepTiles(session, exp.spec);
      A.eq(sweep.violations.length, 0, `exif/ 磁贴审计不应有违规：\n  ${sweep.violations.join('\n  ')}`);

      const uprights = exp.files.filter((f) => !SWAP.includes(orientOf(f)) && f.expect && f.expect.w > f.expect.h);
      A.check(uprights.length > 0, '素材里必须有「正立」的参考图（orientation 1-4 且横构图），否则这条回归用例没意义');
      const reference = uprights[0];
      const refTile = sweep.good.get(reference.name);
      A.check(refTile, `参考图 ${reference.name} 应渲染出磁贴`);
      const refAR = refTile.naturalW / refTile.naturalH;
      A.check(refAR > 1.1, `参考图 ${reference.name} 必须是横构图（AR>1.1），实际 ${refAR.toFixed(3)}`);
      A.near(refAR, 320 / 240, 0.05, `参考图 ${reference.name} 的显示宽高比`);

      const swapped = exp.files.filter((f) => SWAP.includes(orientOf(f)));
      A.check(swapped.length >= 2, `素材里应有 >= 2 张需要交换长宽轴的图（orientation 5-8），实际 ${swapped.length}`);
      const reciprocal = 1 / refAR;
      for (const f of swapped) {
        const t = sweep.good.get(f.name);
        A.check(t, `${f.rel} 应渲染出磁贴`);
        const ar = t.naturalW / t.naturalH;
        A.check(ar < 1, `${f.rel}（orientation ${orientOf(f)}）显示出来必须是竖构图，实际 ${t.naturalW}x${t.naturalH}（AR ${ar.toFixed(3)}）`);
        A.near(ar, reciprocal, 0.05 * reciprocal, `${f.rel} 的显示宽高比必须与正立图 ${reference.name} 互为倒数`);
        A.note(`${f.name}: 磁贴 ${t.naturalW}x${t.naturalH} AR=${ar.toFixed(4)}；参考 ${reference.name} AR=${refAR.toFixed(4)}；1/AR=${reciprocal.toFixed(4)}；磁贴盒子 ${t.boxW}x${t.boxH}`);
      }
      const uprightSwapped = swapped.find((f) => orientOf(f) === 6) || swapped[0];
      A.check(!!uprightSwapped, '应有 orientation 6 的样本');
      A.note(`参与比对的交换轴样本：${swapped.map((f) => `${f.name}(o${orientOf(f)})`).join(', ')}`);
    },
  },

  {
    name: 'orient:display-dims-match-manifest',
    intent: 'exif/ 里 9 张图（orientation 1-8 + 无 EXIF）的显示宽高与 manifest 期望逐一相符',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('exif');
      await session.showDir('exif', { expectImages: exp.total });
      const sweep = await sweepTiles(session, exp.spec);
      A.eq(sweep.violations.length, 0, `exif/ 磁贴审计不应有违规：\n  ${sweep.violations.join('\n  ')}`);
      A.eq(sweep.good.size, exp.good.size, 'exif/ 每张图都应渲染出缩略图');
      for (const f of exp.files) {
        const t = sweep.good.get(f.name);
        A.check(t, `${f.rel} 应有磁贴`);
        A.check(f.expect && f.expect.w, `${f.rel} 的 manifest 应有期望宽高`);
        A.eq(t.naturalW, f.expect.w, `${f.rel} 显示宽（orientation ${orientOf(f)}）`);
        A.eq(t.naturalH, f.expect.h, `${f.rel} 显示高（orientation ${orientOf(f)}）`);
      }
      A.note(`exif/ 全部 ${exp.files.length} 张显示尺寸与 manifest 一致`);
    },
  },

  {
    name: 'orient:lightbox-consistent',
    intent: '灯箱里看大图时方向同样正确：交换轴的图仍是竖的，且与磁贴比例一致',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('exif');
      await session.showDir('exif', { expectImages: exp.total });
      const entries = await session.entries();
      const sweep = await sweepTiles(session, exp.spec);

      const target = exp.files.find((f) => orientOf(f) === 6) || exp.files.find((f) => SWAP.includes(orientOf(f)));
      A.check(target, '素材里应有 orientation 6 的样本');
      const idx = entries.findIndex((e) => e.name === target.name);
      A.check(idx >= 0, `灯箱索引里应能找到 ${target.name}`);
      const lb = await openLightboxAt(session, idx);
      A.eq(lb.open, true, '灯箱应打开');
      A.check(lb.hasSrc, `${target.rel} 灯箱里应加载出图片`);
      A.eq(lb.naturalW, target.expect.w, `${target.rel} 灯箱显示宽（应已按 EXIF 方向校正）`);
      A.eq(lb.naturalH, target.expect.h, `${target.rel} 灯箱显示高`);
      A.check(lb.naturalW < lb.naturalH, `${target.rel} 灯箱里应是竖构图，实际 ${lb.naturalW}x${lb.naturalH}`);

      const tile = sweep.good.get(target.name);
      if (tile) {
        const tileAR = tile.naturalW / tile.naturalH;
        const lbAR = lb.naturalW / lb.naturalH;
        A.near(lbAR, tileAR, 0.05 * tileAR, '灯箱与磁贴的显示宽高比应一致（同一套方向处理）');
      }
      A.note(`${target.name}: 灯箱 ${lb.naturalW}x${lb.naturalH}，磁贴 ${tile ? `${tile.naturalW}x${tile.naturalH}` : '未渲染'}`);
      await session.page.evaluate(() => window.__gkpv.lightbox.close());
      await session.gotoRoot();
    },
  },
];

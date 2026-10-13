/**
 * 缩略图类用例：各格式都出图、分支正确、坏文件有明确表现且不拖垮网格、HEIC 走占位。
 */
import { sweepTiles, sleep } from './lib/harness.mjs';
import { extOf, byRel } from './lib/fixtures.mjs';

const THUMB_MAX = 640; // 与 lib/cache.js 的 THUMB_MAX 一致：超过会被缩放，别断言 1:1

/** 每个格式挑一个「应当正常出图」的样本（从 manifest 推导，不写死文件名）。 */
function pickFormats(exp) {
  const groups = [
    { label: 'PNG', exts: ['png'] },
    { label: 'JPEG', exts: ['jpg', 'jpeg'] },
    { label: 'BMP', exts: ['bmp'] },
    { label: 'GIF', exts: ['gif'] },
    { label: 'WebP', exts: ['webp'] },
    { label: 'SVG', exts: ['svg'] },
  ];
  return groups.map((g) => ({ ...g, file: exp.files.find((f) => g.exts.includes(extOf(f.name)) && exp.good.has(f.name) && f.expect && f.expect.w) }));
}

const checkDims = (A, label, actual, expect, actualW, actualH) => {
  if (!expect || !expect.w) return;
  if (Math.max(expect.w, expect.h) <= THUMB_MAX) {
    A.eq(actualW, expect.w, `${label} 宽（源图 <= ${THUMB_MAX}px，缩略图应 1:1）`);
    A.eq(actualH, expect.h, `${label} 高`);
  } else {
    A.near(actualW / actualH, expect.w / expect.h, 0.02, `${label} 宽高比（源图 > ${THUMB_MAX}px，只比比例）`);
  }
};

export default [
  {
    name: 'thumbs:formats-all-render',
    intent: 'PNG/JPEG/BMP/GIF/WebP/SVG 各抽一张，磁贴里都真的渲染出像素且尺寸符合 manifest',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('basic');
      await session.showDir('basic', { expectImages: exp.total });
      const sweep = await sweepTiles(session, exp.spec);
      A.eq(sweep.violations.length, 0, `basic/ 磁贴审计不应有违规：\n  ${sweep.violations.join('\n  ')}`);
      const picked = pickFormats(exp);
      for (const g of picked) {
        A.check(g.file, `basic/ 里应有一个正常的 ${g.label} 样本（从 manifest 推导）`);
        const t = sweep.good.get(g.file.name);
        A.check(t, `${g.file.name}（${g.label}）应渲染出缩略图磁贴`);
        A.check(t.hasSrc, `${g.file.name} 的 img 应有 src`);
        checkDims(A, `${g.file.name}`, g.file.expect, g.file.expect, t.naturalW, t.naturalH);
        A.note(`${g.label}: ${g.file.name} → ${t.naturalW}x${t.naturalH}（期望 ${g.file.expect.w}x${g.file.expect.h}），磁贴 ${t.boxW}x${t.boxH}`);
      }
    },
  },

  {
    name: 'thumbs:branch-paths',
    intent: '走 __gkpv.thumb 同一条生成代码路径：SVG 走 <img> 分支（path=svg），位图走 header/fallback',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('basic');
      await session.showDir('basic', { expectImages: exp.total });
      const picked = pickFormats(exp);
      for (const g of picked) {
        A.check(g.file, `需要 ${g.label} 样本`);
        const r = await session.page.evaluate((rel) => window.__gkpv.thumb(rel), g.file.rel);
        A.check(r && typeof r === 'object', `${g.file.rel} 的 thumb() 应返回对象，实际 ${JSON.stringify(r)}`);
        A.check(r.bytes > 0, `${g.file.rel} 缩略图字节数应 > 0，实际 ${r.bytes}`);
        if (g.label === 'SVG') {
          A.eq(r.path, 'svg', `${g.file.rel} 必须走 SVG 的 <img> 分支`);
        } else {
          A.check(['header', 'fallback'].includes(r.path), `${g.file.rel} 应走位图分支（header/fallback），实际 ${r.path}`);
        }
        checkDims(A, `${g.file.rel}`, g.file.expect, g.file.expect, r.width, r.height);
        A.note(`${g.file.rel}: path=${r.path} ${r.width}x${r.height} ${r.bytes}B`);
      }
    },
  },

  {
    name: 'thumbs:svg-uses-img-branch',
    intent: 'SVG 在真实磁贴里通过 <img> 渲染（naturalWidth 等于声明尺寸），没有声明尺寸的用默认 300x150',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('basic');
      await session.showDir('basic', { expectImages: exp.total });
      const svgs = exp.files.filter((f) => extOf(f.name) === 'svg' && exp.good.has(f.name));
      A.check(svgs.length > 0, 'basic/ 里应有 SVG 样本');
      const sweep = await sweepTiles(session, exp.spec);
      for (const f of svgs) {
        const t = sweep.good.get(f.name);
        A.check(t, `${f.name} 应渲染出缩略图`);
        A.eq(t.naturalW, f.expect.w, `${f.name} 的 <img> 天然宽度应等于 SVG 声明宽度`);
        A.eq(t.naturalH, f.expect.h, `${f.name} 的 <img> 天然高度应等于 SVG 声明高度`);
        A.note(`${f.name}: img ${t.naturalW}x${t.naturalH}`);
      }
    },
  },

  {
    name: 'thumbs:broken-files-explicit-and-nonblocking',
    intent: '坏图（截断/0 字节/解不出的 webp）不拖垮网格：其余磁贴全部正常，坏项有明确失败表现并记录在 stats.errors',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('edge');
      await session.showDir('edge', { expectImages: exp.total });
      const sweep = await sweepTiles(session, exp.spec);
      A.eq(sweep.violations.length, 0, `edge/ 磁贴审计不应有违规：\n  ${sweep.violations.join('\n  ')}`);
      A.check(exp.broken.size >= 3, `edge/ 至少应有 3 个坏文件（下界保护），实际 ${exp.broken.size}`);
      A.eq(sweep.broken.size, exp.broken.size, '坏文件应全部有明确的失败表现（磁贴 thumb-ready 且没有图源）');
      A.eq(sweep.good.size, exp.good.size, '同目录里正常图片仍应全部渲染出像素（坏图不阻塞其它磁贴）');
      A.eq(sweep.unsupported.size, exp.unsupported.size, 'HEIC 应走占位分支');

      const diag = await session.diagnostics();
      const counters = await session.counters();
      const thumbErrors = (diag.stats.errors || []).filter((e) => e.where === 'thumb').map((e) => e.name);
      const failedSet = new Set(thumbErrors);
      for (const name of exp.broken) A.check(failedSet.has(name), `坏文件 ${name} 应在 stats.errors 里留下 thumb 失败记录，实际 ${JSON.stringify(thumbErrors)}`);
      // 反向断言必须限定在本目录（edge/）的磁贴名上：state.stats.errors 是**会话级累加器**
      // （state.js 起手 errors: []，只在 resetState() 清；gallery.js 的 catch 里 push 后从不按目录清空），
      // 同一 Electron 会话里先前跑过 basic/ 等目录，basic/webp-header-300x200.webp 这类
      // 「注定解不出」的样本会一直留在表里。按目录外的名字做反向断言 = 假红。
      const inThisDir = thumbErrors.filter((n) => exp.tileKeys.has(n));
      for (const name of inThisDir) A.check(exp.broken.has(name), `${name} 属于 edge/ 却报了缩略图失败，但它不在「应失败」清单里（${[...exp.broken].join(',')}）`);
      A.check(counters.failed >= exp.broken.size, `缩略图失败计数应 >= ${exp.broken.size}，实际 ${counters.failed}`);
      A.note(`坏图 ${[...exp.broken].join(', ')}；失败计数=${counters.failed}；counter=「${counters.text}」`);
    },
  },

  {
    name: 'thumbs:heic-placeholder-not-a-failure',
    intent: 'HEIC 走「无预览」占位（不占失败计数）：edge/fake.heic 与 real/ 里的真实 HEIC 都是占位，real/ 其它图正常解码',
    async fn(ctx) {
      const { A, session } = ctx;
      const edge = ctx.expectedForDir('edge');
      await session.showDir('edge', { expectImages: edge.total });
      let tiles = await session.tiles();
      for (const name of edge.unsupported) {
        const t = tiles.find((x) => x.rel === name);
        A.check(t, `${name} 应有磁贴（不能因为解码不了就不显示）`);
        A.eq(t.unsupported, true, `${name} 应带「不支持」标记`);
        A.eq(t.hasSrc, false, `${name} 不应有图片来源`);
        A.eq(t.thumbReady, true, `${name} 应已处理完成（没卡在加载态）`);
        A.check(/HEIC|HEIF/i.test(String(t.unsupportedText || '')), `${name} 应显示格式角标，实际 ${JSON.stringify(t.unsupportedText)}`);
      }
      const afterEdge = await session.counters();
      A.check(afterEdge.failed >= edge.broken.size, `edge/ 的失败计数应 >= ${edge.broken.size}，实际 ${afterEdge.failed}`);
      A.note(`HEIC 占位：${[...edge.unsupported].join(', ')}（角标/无图源/已就绪）`);

      const real = ctx.expectedForDir('real');
      A.check(real.total >= 2, `real/ 应有真实样片，实际 ${real.total}`);
      A.check(real.unsupported.size >= 1, 'real/ 应有真实 HEIC 样片');
      await session.showDir('real', { expectImages: real.total });
      const rs = await sweepTiles(session, real.spec);
      A.eq(rs.violations.length, 0, `real/ 磁贴审计不应有违规：\n  ${rs.violations.join('\n  ')}`);
      const rc = await session.counters();
      const rdiag = await session.diagnostics();
      const rerrors = (rdiag.stats.errors || []).filter((e) => e.where === 'thumb').map((e) => e.name);
      A.eq(rc.failed, 0, `real/ 里 HEIC 不应被算成缩略图失败、其余真实样片应能解码；实际 failed=${rc.failed}，errors=${JSON.stringify(rerrors)}`);
      A.eq(rs.good.size, real.good.size, 'real/ 里可解码的样片应全部渲染出像素');
      A.note(`real/：${real.total} 张（含 ${real.unsupported.size} 张 HEIC 占位），失败 ${rc.failed}`);
      await session.gotoRoot();
    },
  },
];

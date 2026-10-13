/**
 * 灯箱用例：点图打开、三种关闭方式、左右切换（索引/标题变化）、RAW 不空白、HEIC 明确提示。
 *
 * 断言锚点是 `#lbInfo` 的文案 `${name}  (${index+1} / ${total})`（名字与括号之间两个空格，
 * 这里用正则容错空白），以及 `#lbImg` 的 naturalWidth/Height（>0 才算真的出图）。
 */
import { sleep, waitLightboxImage } from './lib/harness.mjs';

/** 解析 `#lbInfo`：名字 + 序号 + 总数。 */
function parseInfo(text) {
  const raw = String(text == null ? '' : text);
  const m = /\s*\((\d+)\s*\/\s*(\d+)\)\s*$/.exec(raw);
  if (!m) return { name: raw.trim(), index: null, total: null };
  return { name: raw.slice(0, m.index).trim(), index: Number(m[1]), total: Number(m[2]) };
}

/** 真·点磁贴打开灯箱；磁贴没渲染出来（虚拟滚动）时退回 API 打开，返回值表示是否真的点了。 */
async function openByTile(session, name, index) {
  const clicked = await session.page.evaluate((n) => {
    const c = [...document.querySelectorAll('#gallery .card:not(.folder-card)')].find(
      (x) => ((x.querySelector('.label') || {}).textContent || '') === n,
    );
    if (!c) return false;
    c.click();
    return true;
  }, name);
  if (!clicked) await session.page.evaluate((i) => window.__gkpv.lightbox.open(i), index);
  return clicked;
}

const closeByButton = (session) => session.page.evaluate(() => {
  document.querySelector('#lightbox .close-btn').click();
});

const isOpen = (session) => session.page.evaluate(() => window.__gkpv.lightbox.isOpen());

export default [
  {
    name: 'lightbox:open-and-close-ways',
    intent: '点磁贴能开灯箱（出图、标题带序号），关闭按钮 / Esc / 点背景三种方式都能关干净',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('basic');
      await session.showDir('basic', { expectImages: exp.total });
      const entries = await session.entries();
      A.eq(entries.length, exp.total, 'basic/ 条目数');

      // 1) 点第一张磁贴打开
      const clicked = await openByTile(session, entries[0].name, 0);
      const lb = await waitLightboxImage(session);
      const info = parseInfo(lb.info);
      A.check(lb.open, '点了磁贴后灯箱应处于打开状态');
      A.check(lb.naturalW > 0 && lb.naturalH > 0, `灯箱图片应有像素，实际 ${lb.naturalW}x${lb.naturalH}`);
      A.eq(info.name, entries[0].name, '灯箱标题里的文件名');
      A.eq(info.index, 1, '灯箱标题里的序号');
      A.eq(info.total, exp.total, '灯箱标题里的总数');
      A.check(lb.displayW > 0 && lb.displayH > 0, `灯箱图片应可见，实际 ${lb.displayW}x${lb.displayH}`);

      // 2) 关闭按钮
      await closeByButton(session);
      await sleep(200);
      let closed = await session.lightbox();
      A.eq(await isOpen(session), false, '点关闭按钮后灯箱应关闭');
      A.eq(closed.hasSrc, false, '关闭后应把 #lbImg 的 src 摘掉（否则会把上一张留在内存里）');
      A.eq(closed.msgShown, false, '关闭后不应还显示提示');

      // 3) Esc
      await openByTile(session, entries[0].name, 0);
      await waitLightboxImage(session);
      A.eq(await isOpen(session), true, '重新打开灯箱');
      await session.page.keyboard.press('Escape');
      await sleep(250);
      A.eq(await isOpen(session), false, '按 Esc 应关闭灯箱');

      // 4) 点背景
      await openByTile(session, entries[1].name, 1);
      await waitLightboxImage(session);
      A.eq(await isOpen(session), true, '第三次打开灯箱');
      await session.page.evaluate(() => document.getElementById('lightbox').click());
      await sleep(250);
      A.eq(await isOpen(session), false, '点灯箱背景应关闭灯箱');

      A.note(`打开方式：${clicked ? '真点磁贴' : '（磁贴未渲染，退回 API）'}；标题「${lb.info}」→ 解析 ${JSON.stringify(info)}`);
      await session.gotoRoot();
    },
  },

  {
    name: 'lightbox:navigation-index-and-title',
    intent: '左右切换真的换图：标题序号/文件名跟着变，往回/到头会环绕，图始终有像素',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('basic');
      await session.showDir('basic', { expectImages: exp.total });
      const entries = await session.entries();
      const N = entries.length;

      await openByTile(session, entries[0].name, 0);
      let lb = await waitLightboxImage(session);
      A.eq(parseInfo(lb.info).index, 1, '首张的序号应为 1');

      // 点右箭头 → 2/N
      await session.page.evaluate(() => document.querySelector('#lightbox .nav-btn.nav-next').click());
      await waitLightboxImage(session);
      lb = await session.lightbox();
      let info = parseInfo(lb.info);
      A.eq(info.index, 2, '点右箭头后序号');
      A.eq(info.name, entries[1].name, '点右箭头后的文件名');
      A.check(lb.naturalW > 0, `切换后图片应有像素，实际 ${lb.naturalW}x${lb.naturalH}`);

      // 键盘左箭头 → 回到 1/N
      await session.page.keyboard.press('ArrowLeft');
      await sleep(300);
      lb = await session.lightbox();
      A.eq(parseInfo(lb.info).index, 1, '按左箭头后序号');

      // 在首张继续往左 → 环绕到最后一张
      await session.page.keyboard.press('ArrowLeft');
      await waitLightboxImage(session);
      lb = await session.lightbox();
      info = parseInfo(lb.info);
      A.eq(info.index, N, `首张继续往左应环绕到最后一张（${N}）`);
      A.eq(info.name, entries[N - 1].name, '环绕后的文件名');

      // 再往右 → 回到第一张
      await session.page.evaluate(() => document.querySelector('#lightbox .nav-btn.nav-next').click());
      await waitLightboxImage(session);
      lb = await session.lightbox();
      A.eq(parseInfo(lb.info).index, 1, '从末张往右应回到第一张');

      await closeByButton(session);
      await sleep(200);
      A.eq(await isOpen(session), false, '用例结束时灯箱应已关闭');
      A.note(`共 ${N} 张；切换链：1 → 2 → 1 → ${N}（环绕）→ 1`);
      await session.gotoRoot();
    },
  },

  {
    name: 'lightbox:raw-not-blank',
    intent: 'RAW（ARW/NEF/CR2/DNG）在灯箱里能出内嵌预览，不出现空白画面',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('raw');
      await session.showDir('raw', { expectImages: exp.total });
      const entries = await session.entries();
      A.check(entries.length >= 3, `RAW 素材应有下界保护（>=3），实际 ${entries.length}`);
      A.eq(entries.length, exp.total, 'raw/ 条目数');

      const seen = [];
      for (let i = 0; i < entries.length; i += 1) {
        const e = entries[i];
        const clicked = await openByTile(session, e.name, i);
        const lb = await waitLightboxImage(session);
        A.check(lb.open, `${e.name}：灯箱应已打开`);
        A.check(
          lb.naturalW > 0 && lb.naturalH > 0,
          `${e.name}：RAW 灯箱应显示内嵌预览（不能空白），实际 ${lb.naturalW}x${lb.naturalH}` +
            `${lb.msgShown ? `；提示=「${lb.msg}」` : ''}`,
        );
        A.eq(lb.msgShown, false, `${e.name}：有图时不应显示失败提示（「${lb.msg}」）`);
        const info = parseInfo(lb.info);
        A.eq(info.name, e.name, `${e.name}：灯箱标题`);
        A.eq(info.index, i + 1, `${e.name}：灯箱序号`);
        seen.push(`${e.name}(${lb.naturalW}x${lb.naturalH}${clicked ? '' : ',API'})`);
        await closeByButton(session);
        await sleep(150);
      }
      A.note(`RAW 灯箱预览：${seen.join(' ')}`);
      await session.gotoRoot();
    },
  },

  {
    name: 'lightbox:heic-message-others-still-work',
    intent: 'HEIC 打开灯箱时给出明确提示而不是空白，同目录里能解码的图照常出图',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('real');
      // `real/` 里是个人真实照片（不入库，CI 走 --no-real 时为空）。本用例要验的产品行为
      // 是「HEIC 打开灯箱给明确提示、同目录能解码的图照常出图」，这条路径在 edge/ 上有
      // 等价素材（fake.heic + 若干能解码的图），所以**降级到 edge/ 继续跑**，而不是跳过：
      // 只有「真实 HEIC 与真实照片混放」这一个变体没被覆盖，用 note 明确标出来。
      const downgraded = !ctx.real.ok || exp.total < 2;
      const dir = downgraded ? 'edge' : 'real';
      const expected = ctx.expectedForDir(dir);
      if (downgraded) {
        A.note(`real/ 真实样片不可用（${ctx.real.reason || `manifest 只登记 ${exp.total} 个 real/ 条目`}），改用 edge/ 的等价素材验证同一路径；未覆盖：真实相机 HEIC`);
      }
      await session.showDir(dir, { expectImages: expected.total });
      const entries = await session.entries();
      const badIdx = entries.findIndex((e) => e.unsupported);
      const goodIdx = entries.findIndex((e) => !e.unsupported);
      A.check(badIdx >= 0, `${dir}/ 里应有 1 张不可解码（HEIC）素材，实际 entries=${JSON.stringify(entries.map((e) => `${e.name}:${e.unsupported}`))}`);
      A.check(goodIdx >= 0, `${dir}/ 里应有能解码的图片`);

      // HEIC：应给提示、不应有像素
      await openByTile(session, entries[badIdx].name, badIdx);
      await waitLightboxImage(session);
      await sleep(300);
      const lb = await session.lightbox();
      A.eq(lb.open, true, 'HEIC 也应能把灯箱打开（否则用户点上去完全没反应）');
      A.eq(lb.msgShown, true, `HEIC 应给出明确提示，实际 msgShown=${lb.msgShown} msg=「${lb.msg}」`);
      A.check(/HEIC|无法解码/.test(lb.msg), `HEIC 提示文案应说明无法解码，实际「${lb.msg}」`);
      A.eq(lb.hasSrc, false, 'HEIC 不应给 #lbImg 设置图片源');
      await closeByButton(session);
      await sleep(200);

      // 同目录的可解码图片照常出图
      await openByTile(session, entries[goodIdx].name, goodIdx);
      const lb2 = await waitLightboxImage(session);
      A.check(lb2.naturalW > 0, `${entries[goodIdx].name} 应正常出图，实际 ${lb2.naturalW}x${lb2.naturalH}`);
      A.eq(parseInfo(lb2.info).index, goodIdx + 1, '能解码图片的灯箱序号');
      await closeByButton(session);
      await sleep(200);
      A.eq(await isOpen(session), false, '用例结束时灯箱应已关闭');
      A.note(`HEIC 提示=「${lb.msg}」；对照图 ${entries[goodIdx].name} = ${lb2.naturalW}x${lb2.naturalH}`);
      await session.gotoRoot();
    },
  },
];

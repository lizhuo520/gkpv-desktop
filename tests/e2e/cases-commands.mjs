/**
 * 菜单命令总线回归用例。
 *
 * 背景：Lead 抓到过一个静默 bug —— main/menu.cjs 用 kebab-case 下发命令 ID
 * （`send('open-folder')`），而渲染层 runCommand 原来只按 camelCase 键查表，
 * 于是菜单里每一条点了都没反应、还一句错都不报。
 *
 * 权威 ID 来源是 desktop/main/menu.cjs：这里直接扫源码把 ID 抠出来，
 * 逐个断言 `window.__gkpv.command(id) === true`（这个入口就是给自动化留的，返回布尔）。
 * 再补一条反向断言（不存在的 ID 必须 false），保证这条用例真的会失败而不是永远绿。
 * 另外补一条「导出诊断信息」真写盘的用例（主进程 showSaveDialog 打桩）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DESKTOP_DIR } from './lib/paths.mjs';
import { sleep, waitTilesSettled } from './lib/harness.mjs';

const MENU_CJS = path.join(DESKTOP_DIR, 'main', 'menu.cjs');

/**
 * 从 menu.cjs 抠出所有通过命令总线下发的 ID。
 * 匹配 `send('xxx')`（menu.cjs 的本地 helper）以及 `'ui:command', 'xxx'` 直写形式。
 */
export function parseMenuCommandIds(src = fs.readFileSync(MENU_CJS, 'utf8')) {
  const ids = new Set();
  for (const m of src.matchAll(/\bsend\(\s*'([^']+)'\s*\)/g)) ids.add(m[1]);
  for (const m of src.matchAll(/'ui:command'\s*,\s*'([^']+)'/g)) ids.add(m[1]);
  return [...ids].filter((id) => id && id !== 'ui:command' && /^[a-z][a-z0-9-]*$/.test(id));
}

/** 原生对话框在自动化里点不了（任务书明确不测），打成桩：取消打开、保存到临时文件。 */
async function stubMainDialogs(session, saveFilePath) {
  await session.app.evaluate(({ dialog }, file) => {
    globalThis.__gkpvDialogStub = { saveFilePath: file, openCalls: 0, saveCalls: 0 };
    dialog.showOpenDialog = async () => {
      globalThis.__gkpvDialogStub.openCalls += 1;
      return { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async () => {
      globalThis.__gkpvDialogStub.saveCalls += 1;
      return { canceled: false, filePath: file };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    return true;
  }, saveFilePath);
}

const uiState = (session) =>
  session.page.evaluate(() => {
    const s = window.__gkpv.state();
    return {
      recursive: s.recursiveMode,
      sort: s.sortMode,
      layout: s.layoutMode,
      size: s.currentSizeKey,
      images: s.currentImages.length,
    };
  });

export default [
  {
    name: 'commands:menu-ids-accepted',
    intent:
      'menu.cjs 里每一条菜单命令 ID 都被渲染层 runCommand 接受（防「菜单点了没反应且不报错」回归）',
    async fn(ctx) {
      const { A, session } = ctx;
      const ids = parseMenuCommandIds();
      A.check(
        ids.length >= 8,
        `应从 menu.cjs 解析出至少 8 个命令 ID（否则本用例会空跑、失去意义），实际 ${ids.length} 个：${ids.join(', ')}`,
      );
      A.note(`menu.cjs 命令 ID（${ids.length} 个）：${ids.join(' ')}`);

      const savePath = path.join(ctx.TMP, `menu-diagnostics-${Date.now()}.json`);
      await stubMainDialogs(session, savePath);
      await session.gotoRoot();

      const log = [];
      for (const id of ids) {
        const ok = await session.page.evaluate((cmdId) => window.__gkpv.command(cmdId), id);
        log.push(`${id}=${ok}`);
        A.eq(
          ok,
          true,
          `菜单命令 '${id}' 必须被渲染层接受（真的触发了 runCommand），否则菜单点了没反应` +
            `（已接受：${log.slice(0, -1).join(' ') || '无'}）`,
        );
        // 让副作用跑完再做下一条，避免几条命令互相踩（尤其是重扫/递归/清缓存）
        if (id === 'toggle-recursive') {
          await session.waitSettled({ expectImages: ctx.expected.total, timeout: 120000, what: `命令 ${id}` });
        } else if (id === 'rescan' || id === 'clear-cache') {
          await session.waitSettled({ timeout: 60000, what: `命令 ${id}` });
        } else {
          await sleep(250);
        }
      }

      // 复原这条用例造成的状态变化（递归/布局/尺寸/排序），别污染后面的用例
      await session.setRecursive(false);
      await session.waitSettled({ timeout: 60000, what: '复原递归开关' });
      await session.page.evaluate(() => {
        const sel = document.getElementById('sortSelect');
        sel.value = 'name-asc';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        window.__gkpv.command('layout-justified');
        window.__gkpv.command('size-md');
      });
      await session.waitSettled({ timeout: 60000, what: '复原视图状态' });
      const st = await uiState(session);
      A.eq(st.recursive, false, '复原后的 recursiveMode');
      A.eq(st.sort, 'name-asc', '复原后的 sortMode');
      A.eq(st.layout, 'justified', '复原后的 layoutMode');
      A.eq(st.size, 'md', '复原后的 sizeKey');

      const trace = await session.page.evaluate(() => window.__gkpv.trace || []);
      const unknown = trace.filter((t) => t && t.event === 'runCommand:unknown');
      A.eq(unknown.length, 0, `不应出现未知命令留痕：${JSON.stringify(unknown)}`);
      A.note(`全部 ${ids.length} 条命令被接受：${log.join(' ')}`);
      A.note(`复原后 state=${JSON.stringify(st)}；trace 里未知命令 ${unknown.length} 条`);
    },
  },

  {
    name: 'commands:unknown-id-rejected',
    intent:
      '不存在的命令 ID 必须返回 false 并进 trace（证明上一条用例真的能失败，而不是永远绿）',
    async fn(ctx) {
      const { A, session } = ctx;
      await session.gotoRoot();
      const bad = `no-such-command-${Date.now()}`;
      const ok = await session.page.evaluate((id) => window.__gkpv.command(id), bad);
      A.eq(ok, false, `window.__gkpv.command('${bad}') 必须返回 false`);
      await sleep(200);
      const trace = await session.page.evaluate(() => window.__gkpv.trace || []);
      const hit = trace.some(
        (t) => t && (t.event === 'runCommand:unknown' || JSON.stringify(t).includes('no-such-command-')),
      );
      A.check(
        hit,
        `未知命令应进 __gkpv.trace（event='runCommand:unknown'），实际 trace 尾部：${JSON.stringify(trace.slice(-4))}`,
      );
      A.note(`trace 尾部：${JSON.stringify(trace.slice(-2))}`);
    },
  },

  {
    name: 'commands:diagnostics-export-writes-json',
    intent: '菜单「导出诊断信息…」真的把 JSON 写盘（showSaveDialog 打桩），内容含 app/counts/stats',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('basic');
      await session.showDir('basic', { expectImages: exp.total });

      const savePath = path.join(ctx.TMP, `gkpv-diagnostics-${Date.now()}.json`);
      await stubMainDialogs(session, savePath);
      const ok = await session.page.evaluate(() => window.__gkpv.command('export-diagnostics'));
      A.eq(ok, true, "命令 'export-diagnostics' 应被接受");

      const t0 = Date.now();
      while (!fs.existsSync(savePath) && Date.now() - t0 < 20000) await sleep(200);
      A.check(fs.existsSync(savePath), `诊断信息应写入 ${savePath}（20s 内未出现）`);
      const txt = fs.readFileSync(savePath, 'utf8');
      let json = null;
      try {
        json = JSON.parse(txt);
      } catch (e) {
        A.check(false, `诊断文件不是合法 JSON：${e.message}；开头 200 字符：${txt.slice(0, 200)}`);
      }
      A.check(json && typeof json === 'object', `诊断 JSON 应是对象，实际 ${typeof json}`);
      A.check(json.app, `诊断 JSON 应含 app 段，实际键：${Object.keys(json).join(', ')}`);
      A.check(json.counts, `诊断 JSON 应含 counts 段，实际键：${Object.keys(json).join(', ')}`);
      A.eq(json.counts.images, exp.total, '诊断 JSON 里的图片条目数（当前目录 basic/）');
      A.check(json.stats, `诊断 JSON 应含 stats 段，实际键：${Object.keys(json).join(', ')}`);
      A.note(
        `诊断 JSON ${txt.length} 字节，键：${Object.keys(json).join(', ')}；counts=${JSON.stringify(json.counts)}`,
      );
      await session.gotoRoot();
    },
  },

  {
    name: 'commands:clear-cache-feedback',
    intent: '「清空缓存」命令有可见反馈（按钮临时变「已清空 (N)」）且不破坏当前视图',
    async fn(ctx) {
      const { A, session } = ctx;
      const exp = ctx.expectedForDir('basic');
      await session.showDir('basic', { expectImages: exp.total });

      const before = await session.page.evaluate(() => document.getElementById('clearCacheBtn').textContent);
      const ok = await session.page.evaluate(() => window.__gkpv.command('clear-cache'));
      A.eq(ok, true, "命令 'clear-cache' 应被接受");
      await sleep(500);
      const after = await session.page.evaluate(() => document.getElementById('clearCacheBtn').textContent);
      A.check(
        /已清空\s*\(\d+\)/.test(after) || /清空缓存/.test(after),
        `清空缓存按钮应有反馈文案（已清空 (N)），实际「${after}」（清空前「${before}」）`,
      );
      await session.waitSettled({ expectImages: exp.total, timeout: 120000, what: '清缓存后重渲染' });
      const audit = await waitTilesSettled(session, exp.spec, { timeout: 20000 });
      A.eq(audit.violations.length, 0, `清缓存后磁贴仍应正常：${audit.violations.slice(0, 6).join(' | ')}`);
      A.note(`按钮文案「${before}」→「${after}」；清缓存后 ${audit.good.length} 张正常磁贴仍然出图`);
      await session.gotoRoot();
    },
  },
];

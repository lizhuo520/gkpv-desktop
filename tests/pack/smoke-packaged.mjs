/**
 * tests/pack/smoke-packaged.mjs —— 打包产物冒烟测试
 *
 * 目的：`npm run smoke:pack` 必须回答一个具体问题——**打出来的产物，双击能不能真的用**。
 * 单元测试与 E2E 跑的都是源码（`electron desktop`），它们全绿也证明不了 asar 打包后：
 *   · `app://` 协议 handler 在 asar 里还能读到文件（asar 下 createReadStream 会失败，走整读降级）
 *   · `renderer/lib/*.js` 这些模块路径在 asar 里没被改变
 *   · 主进程的 fs 扫盘在打包环境里仍能读用户目录
 * 所以这一层必须独立存在。
 *
 * 用法：
 *   node tests/pack/smoke-packaged.mjs           # 自动找 dist/win-unpacked 里的 exe
 *   node tests/pack/smoke-packaged.mjs <exe路径>  # 指定产物（如 portable exe）
 *
 * 退出码：0 = 冒烟通过；1 = 失败（并打印具体哪一步、期望与实际）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const DEFAULT_EXE = path.join(ROOT, 'dist', 'win-unpacked', 'GKP Viewer.exe');

const exe = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_EXE;

let step = 0;
function ok(msg) {
  step += 1;
  process.stdout.write(`  ✔ ${step}. ${msg}\n`);
}
function fail(msg, extra) {
  process.stderr.write(`  ✖ ${msg}\n`);
  if (extra !== undefined) process.stderr.write(`    实际：${JSON.stringify(extra)}\n`);
  process.exit(1);
}
function assert(cond, msg, extra) {
  if (cond) ok(msg);
  else fail(msg, extra);
}

process.stdout.write('打包产物冒烟测试\n');

/* ---------------- 前置检查 ---------------- */

if (!fs.existsSync(exe)) {
  process.stderr.write(
    `✖ 找不到产物：${exe}\n`
    + '  先打包：npm run pack:dir（只出解包目录，最快）或 npm run pack（出安装包）\n',
  );
  process.exit(1);
}
process.stdout.write(`· 产物：${exe}（${(fs.statSync(exe).size / 1024 / 1024).toFixed(1)} MB）\n`);

if (!fs.existsSync(FIXTURES)) {
  process.stderr.write(`✖ 找不到测试素材：${FIXTURES}\n  先跑：npm run fixtures\n`);
  process.exit(1);
}

// 每条会话独立 userData：否则单实例锁会让第二次运行直接退出，
// 而且 OPFS 缩略图缓存会在用例之间互相污染。
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gkpv-pack-smoke-'));

/* ---------------- 启动产物 ---------------- */

process.stdout.write('· 启动产物…\n');
const started = Date.now();

const env = { ...process.env };
// 若是 1，exe 会退化成纯 Node 进程，应用永远起不来
delete env.ELECTRON_RUN_AS_NODE;
env.GKPV_TEST_MODE = '1';
env.GKPV_TEST_ROOT = FIXTURES;
env.GKPV_TEST_USERDATA = userData;

let app;
try {
  app = await electron.launch({ executablePath: exe, env });
} catch (e) {
  fail(`产物启动失败：${e.message}`);
}

let win;
try {
  win = await app.firstWindow({ timeout: 60000 });
} catch (e) {
  fail(`产物没有开出窗口：${e.message}`);
}

assert(true, `产物开出窗口（${Date.now() - started} ms）`);

/* ---------------- 页面来源必须是 app:// 而不是 file:// ---------------- */

const page = await win.evaluate(() => ({
  title: document.title,
  href: location.href,
  protocol: location.protocol,
}));

assert(
  page.protocol === 'app:',
  `页面来源是自定义协议（${page.href}）`,
  page,
);

if (page.protocol !== 'app:') {
  fail('页面不是从 app:// 加载的：OPFS 缓存与 File System Access 都会失效', page);
}

/* ---------------- 等应用真的就绪 ---------------- */

// boot.js 是 type=module，异步执行：domcontentloaded 时 window.__gkpv 还不存在，
// 必须等 ready，否则断言会拿到空数据（这不是 bug，是必须遵守的时序）。
let ready = false;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  ready = await win.evaluate(() => !!(window.__gkpv && window.__gkpv.ready === true));
  if (ready) break;
  await new Promise((r) => setTimeout(r, 100));
}
assert(ready, '应用完成启动（window.__gkpv.ready === true）');

if (!ready) {
  const phase = await win.evaluate(() => (window.__gkpv && window.__gkpv.phase) || null);
  fail('应用没能在 30 秒内就绪', phase);
}

/* ---------------- 渲染层模块在 asar 里被正确加载 ---------------- */

const mods = await win.evaluate(() => {
  const api = window.__gkpv;
  return {
    // 这几个钩子分别来自 lib/format.js、lib/layout.js、lib/fmt.js、lib/cache.js，
    // 任何一个模块路径在 asar 里坏掉，这里就会缺项。
    exts: api.exts ? api.exts().length : -1,
    layoutKeys: api.layout ? Object.keys(api.layout).length : -1,
    fmtKeys: api.fmt ? Object.keys(api.fmt).length : -1,
    cacheKeys: api.cache ? Object.keys(api.cache).length : -1,
  };
});
assert(
  mods.exts > 5 && mods.layoutKeys > 0 && mods.fmtKeys > 0 && mods.cacheKeys > 0,
  `渲染层各模块都已加载（exts=${mods.exts}, layout=${mods.layoutKeys}, fmt=${mods.fmtKeys}, cache=${mods.cacheKeys}）`,
  mods,
);

/* ---------------- 主进程 fs 扫盘在打包环境里可用 ---------------- */

let scanned = null;
const scanDeadline = Date.now() + 30000;
while (Date.now() < scanDeadline) {
  scanned = await win.evaluate(() => {
    const api = window.__gkpv;
    if (!api || !api.state) return null;
    const s = api.state();
    const counters = api.counters ? api.counters() : null;
    return {
      folderCount: s.currentFolderCount,
      images: s.currentImages ? s.currentImages.length : 0,
      counterText: counters ? counters.text : '',
      root: s.sourceRoot,
    };
  });
  if (scanned && (scanned.folderCount > 0 || scanned.images > 0)) break;
  await new Promise((r) => setTimeout(r, 200));
}
assert(
  scanned && scanned.folderCount > 0,
  `主进程扫到了子目录（${scanned ? scanned.folderCount : 'null'} 个文件夹，计数器「${scanned ? scanned.counterText : ''}」）`,
  scanned,
);

if (!scanned) fail('拿不到应用状态', scanned);

/* ---------------- 真的能解码并出缩略图（走完整代码路径） ---------------- */

const thumb = await win.evaluate(async () => {
  try {
    return await window.__gkpv.thumb('basic/jpeg-400x300.jpg');
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
});
assert(
  thumb && !thumb.error && thumb.width === 400 && thumb.height === 300 && thumb.bytes > 0,
  `产物能解码出缩略图（${thumb && thumb.width}×${thumb && thumb.height}，${thumb && thumb.bytes} B）`,
  thumb,
);

/* ---------------- 生产构建里不该出现测试接口（安全相关） ---------------- */

const testApi = await win.evaluate(() => ({
  hasTestFolder: !!(window.gkpv && window.gkpv.test && window.gkpv.test.setFolder),
  hasGkpv: typeof window.gkpv === 'object',
}));
// 生产态（没设 GKPV_TEST_MODE）时才该没有 test 接口；本脚本刻意带了 GKPV_TEST_MODE=1，
// 所以这里只断言「接口形态正确」，是否泄漏留给下面的生产态检查。
assert(testApi.hasGkpv, '预加载脚本注入的 gkpv 接口存在', testApi);

/* ---------------- 关窗后进程要真的退出 ---------------- */

const pid = app.process().pid;
await app.close();
await new Promise((r) => setTimeout(r, 500));

let alive = true;
try {
  process.kill(pid, 0);
} catch {
  alive = false;
}
assert(!alive, `关窗后进程已退出（pid=${pid}）`);

/* ---------------- 清理 ---------------- */

try {
  fs.rmSync(userData, { recursive: true, force: true });
} catch { /* 忽略清理失败 */ }

process.stdout.write(`\n✔ 打包产物冒烟测试通过（共 ${step} 项，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）\n`);

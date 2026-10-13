/**
 * E2E 脚手架：启动真实 Electron、等待界面稳定、审计磁贴。
 *
 * 关键约束（踩过的坑，别改）：
 *  - 用 playwright-core 的 `_electron` 直接驱动，不用 @playwright/test 运行器；
 *  - 子进程 env 必须删掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 退化成 Node，
 *    永远没有窗口（Lead 实测踩过）；
 *  - `window.__gkpv` 是外置 ES module 建的，domcontentloaded 时还不存在，
 *    必须轮询 `window.__gkpv.ready`。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DESKTOP_DIR, userDataFor, resolveElectron, sleep } from './paths.mjs';

// 转发给用例文件用：用例关心的是「等一会儿」这件事，不该为了拿 sleep 再去 import
// 一个只管路径的工具模块。paths.mjs 仍是 sleep 的唯一实现处（别在这里重定义）。
export { sleep };
export { DESKTOP_DIR, userDataFor, resolveElectron };

const requireFromHere = createRequire(import.meta.url);
const { _electron } = requireFromHere('playwright-core');

/* ================================================================== *
 * 页面内取数函数（必须是自包含的，Playwright 只序列化函数体）
 * ================================================================== */

function snapshotInPage() {
  const g = document.getElementById('gallery');
  const counter = document.getElementById('counter');
  const loading = document.getElementById('loading');
  const landing = document.getElementById('landing');
  const toolbar = document.getElementById('toolbar');
  const c = window.__gkpv.counters();
  const txt = counter ? counter.textContent : '';
  const hint = (sel) => (g && g.querySelector(sel) ? g.querySelector(sel).textContent : null);
  return {
    ready: !!(window.__gkpv && window.__gkpv.ready === true),
    galleryDisplay: g ? g.style.display : 'missing',
    errorHint: hint('.error-hint'),
    emptyHint: hint('.empty-hint'),
    folderCards: g ? g.querySelectorAll('.folder-card').length : -1,
    cards: g ? g.querySelectorAll('.card:not(.folder-card)').length : -1,
    thumbReady: g ? g.querySelectorAll('#gallery .thumb-ready').length : -1,
    imageCardsReady: g ? g.querySelectorAll('#gallery .card:not(.folder-card).thumb-ready').length : -1,
    counterText: txt,
    done: c.done,
    total: c.total,
    failed: c.failed,
    busy: /正在(生成缩略图|测量尺寸)/.test(txt),
    loadingShown: !!(loading && loading.classList.contains('show')),
    landingDisplay: landing ? landing.style.display : 'missing',
    toolbarDisplay: toolbar ? toolbar.style.display : 'missing',
    breadcrumbs: [...document.querySelectorAll('#breadcrumbs .crumb')].map((b) => b.textContent),
    phase: (window.__gkpv.phase && window.__gkpv.phase.name) || '',
    scrollHeight: document.documentElement.scrollHeight,
    lightboxOpen: !!(document.getElementById('lightbox') || {}).classList && document.getElementById('lightbox').classList.contains('open'),
  };
}

function tilesInPage() {
  const out = [];
  for (const card of document.querySelectorAll('#gallery .card:not(.folder-card)')) {
    const img = card.querySelector('img');
    const label = card.querySelector('.label');
    const sub = card.querySelector('.subfolder-badge');
    const icon = card.querySelector('.unsupported-icon');
    const r = card.getBoundingClientRect();
    const name = label ? label.textContent : '';
    const subText = sub ? sub.textContent : '';
    out.push({
      rel: subText ? `${subText}/${name}` : name,
      name,
      sub: subText,
      hasSrc: !!(img && img.getAttribute('src')),
      naturalW: img ? img.naturalWidth : 0,
      naturalH: img ? img.naturalHeight : 0,
      imgComplete: img ? !!img.complete : false,
      cls: String(card.className || ''),
      unsupported: card.classList.contains('unsupported'),
      unsupportedText: icon ? icon.textContent : null,
      thumbReady: card.classList.contains('thumb-ready'),
      boxW: Math.round(r.width),
      boxH: Math.round(r.height),
      ratio: r.height > 0 ? r.width / r.height : 0,
    });
  }
  return out;
}

function lightboxInPage() {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lbImg');
  const msg = document.getElementById('lbMsg');
  const info = document.getElementById('lbInfo');
  return {
    open: !!(lb && lb.classList.contains('open')),
    info: info ? info.textContent : null,
    hasSrc: !!(img && img.getAttribute('src')),
    naturalW: img ? img.naturalWidth : 0,
    naturalH: img ? img.naturalHeight : 0,
    displayW: img ? Math.round(img.getBoundingClientRect().width) : 0,
    displayH: img ? Math.round(img.getBoundingClientRect().height) : 0,
    msgShown: !!(msg && msg.classList.contains('show')),
    msg: msg ? msg.textContent : '',
    exifOpen: !!(document.getElementById('exifPanel') || {}).classList && document.getElementById('exifPanel').classList.contains('open'),
  };
}

/* ================================================================== *
 * Session
 * ================================================================== */

export class Session {
  constructor({ app, page, mainPid, rootPath, label, exe, via, pageErrors, consoleErrors }) {
    this.app = app;
    this.page = page;
    this.mainPid = mainPid;
    this.rootPath = rootPath;
    this.label = label;
    this.exe = exe;
    this.via = via;
    this.pageErrors = pageErrors;
    this.consoleErrors = consoleErrors;
    this.closed = false;
    this.closeResult = null;
  }

  async snapshot() {
    return this.page.evaluate(snapshotInPage);
  }

  async tiles() {
    return this.page.evaluate(tilesInPage);
  }

  async lightbox() {
    return this.page.evaluate(lightboxInPage);
  }

  async entries() {
    return this.page.evaluate(() => window.__gkpv.entries());
  }

  async counters() {
    return this.page.evaluate(() => window.__gkpv.counters());
  }

  async diagnostics() {
    return this.page.evaluate(() => window.__gkpv.diagnostics());
  }

  async renderErrors() {
    return this.page.evaluate(() => (window.__gkpvDiag && window.__gkpvDiag.errors) || []);
  }

  /** 等界面稳定：缩略图跑完、不在测量、网格已有内容（或已给出空/错误提示）。 */
  async waitSettled({ expectImages = null, expectFolders = null, timeout = 180000, what = '渲染' } = {}) {
    const t0 = Date.now();
    let snap = null;
    for (;;) {
      snap = await this.page.evaluate(snapshotInPage);
      if (settledNow(snap, { expectImages, expectFolders })) return snap;
      if (Date.now() - t0 > timeout) {
        const err = new Error(`等待「${what}」稳定超时（${timeout}ms）。最后快照：${JSON.stringify(snap)}`);
        err.snapshot = snap;
        throw err;
      }
      await sleep(120);
    }
  }

  /** 切换「子文件夹」开关；返回是否真的点了。 */
  async setRecursive(want) {
    const cur = await this.page.evaluate(() => {
      const b = document.getElementById('recursiveBtn');
      return b ? (b.textContent || '').includes('开') : null;
    });
    if (cur === null || cur === !!want) return false;
    await this.page.evaluate(() => document.getElementById('recursiveBtn').click());
    return true;
  }

  /** 关灯箱 → 递归关掉 → 点面包屑回根目录 → 等到稳定。 */
  async gotoRoot({ timeout = 180000 } = {}) {
    await this.page.evaluate(() => {
      try {
        if (window.__gkpv.lightbox.isOpen()) window.__gkpv.lightbox.close();
      } catch { /* 忽略 */ }
    });
    await this.setRecursive(false);
    const clicked = await this.page.evaluate(() => {
      const b = document.querySelector('#breadcrumbs .crumb');
      if (!b) return false;
      b.click();
      return true;
    });
    if (!clicked) throw new Error('面包屑里没有根目录按钮，无法回到根目录');
    return this.waitSettled({ timeout, what: '回到根目录' });
  }

  /** 进入一层子目录（每次点击后等渲染稳定）。 */
  async enterFolder(name, { expectImages = null, timeout = 180000 } = {}) {
    const ok = await this.page.evaluate((n) => {
      const c = [...document.querySelectorAll('.folder-card')].find((x) => x._folderName === n);
      if (!c) return false;
      c.click();
      return true;
    }, name);
    if (!ok) {
      const snap = await this.snapshot();
      throw new Error(`找不到文件夹卡片「${name}」；当前面包屑：${snap.breadcrumbs.join(' / ')}`);
    }
    return this.waitSettled({ expectImages, timeout, what: `进入 ${name}` });
  }

  /** 回根目录 + 进子目录。只有单层目录用得上（本套件够用）。 */
  async showDir(name, { expectImages = null, timeout = 180000 } = {}) {
    await this.gotoRoot({ timeout });
    return this.enterFolder(name, { expectImages, timeout });
  }

  async close({ timeout = 25000, expectGone = true } = {}) {
    if (this.closed) return this.closeResult;
    this.closed = true;
    const pid = this.mainPid;
    const before = electronProcesses();
    let error = null;
    const t0 = Date.now();
    try {
      await Promise.race([
        this.app.close(),
        sleep(timeout).then(() => {
          throw new Error(`app.close() 超过 ${timeout}ms 没有返回`);
        }),
      ]);
    } catch (e) {
      error = e;
    }
    let alive = isProcessAlive(pid);
    let forced = false;
    if (alive && expectGone) {
      await sleep(1500);
      alive = isProcessAlive(pid);
    }
    if (alive) {
      forced = true;
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } catch { /* 忽略 */ }
      await sleep(600);
      alive = isProcessAlive(pid);
    }
    this.closeResult = {
      pid,
      error,
      ms: Date.now() - t0,
      aliveAfter: alive,
      forced,
      before,
      after: electronProcesses(),
    };
    return this.closeResult;
  }
}

function settledNow(s, e) {
  if (s.errorHint || s.emptyHint) return true;
  if (s.galleryDisplay === 'none' || s.galleryDisplay === 'missing') return false;
  if (s.toolbarDisplay !== 'flex') return false;
  if (s.loadingShown) return false;
  if (/:start$/.test(String(s.phase || ''))) return false;
  if (s.folderCards <= 0 && s.cards <= 0) return false;
  // 注意：**不能**用 done>=total 或 counterText 里的「正在生成缩略图」判断稳定。
  // 虚拟滚动下只有渲染出来的行才会请求缩略图，未滚到的行永远等不到 →
  // 递归视图(67 张)里那样会假死到超时。改为只看「已渲染出来的磁贴」是否全部就绪。
  if (s.cards > 0 && s.imageCardsReady < s.cards) return false;
  if (e.expectImages != null && s.total !== e.expectImages) return false;
  if (e.expectFolders != null && s.folderCards !== e.expectFolders) return false;
  return true;
}

/* ================================================================== *
 * 启动 / 进程工具
 * ================================================================== */

export async function launchSession({ rootPath, label, extraEnv = {}, timeout = 150000 }) {
  const { exe, via } = resolveElectron();
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE; // 必须删：否则 electron.exe 退化成 Node
  Object.assign(childEnv, {
    GKPV_TEST_MODE: '1',
    GKPV_TEST_ROOT: rootPath,
    GKPV_TEST_USERDATA: userDataFor(label),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  }, extraEnv);

  const app = await _electron.launch({ executablePath: exe, args: [DESKTOP_DIR], env: childEnv, timeout });
  const proc = typeof app.process === 'function' ? app.process() : null;
  const page = await app.firstWindow({ timeout });

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String((e && e.stack) || (e && e.message) || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  const session = new Session({ app, page, mainPid: proc ? proc.pid : 0, rootPath, label, exe, via, pageErrors, consoleErrors });
  await page.waitForFunction(() => !!(window.__gkpv && window.__gkpv.ready === true), undefined, { timeout: 90000 });
  await session.waitSettled({ timeout: 180000, what: `${label} 首次渲染` });
  return session;
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/** 机器上所有 electron.exe（含别人的）：只做证据，不做断言。 */
export function electronProcesses() {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const out = String(r.stdout || '');
    const pids = [...out.matchAll(/"electron\.exe","(\d+)"/gi)].map((m) => Number(m[1]));
    return { count: pids.length, pids };
  } catch (e) {
    return { count: -1, pids: [], error: String((e && e.message) || e) };
  }
}

/* ================================================================== *
 * 磁贴审计
 * ================================================================== */

export function classifyTile(t, spec) {
  if (spec.unsupported && spec.unsupported.has(t.rel)) return 'unsupported';
  if (spec.broken && spec.broken.has(t.rel)) return 'broken';
  if (spec.good && spec.good.has(t.rel)) return 'good';
  return 'unknown';
}

/**
 * 审计当前渲染出来的磁贴（虚拟滚动下只覆盖已渲染的行）。
 * spec: { good:Set<rel>, broken:Set<rel>, unsupported:Set<rel>, allowUnknown:boolean }
 */
export async function auditTiles(session, spec) {
  const tiles = await session.page.evaluate(tilesInPage);
  const out = { seen: tiles.length, good: [], broken: [], unsupported: [], unknown: [], violations: [] };
  for (const t of tiles) {
    const kind = classifyTile(t, spec);
    if (kind === 'unsupported') {
      if (t.unsupported && !t.hasSrc && t.unsupportedText) out.unsupported.push(t);
      else out.violations.push(`${t.rel}: 期望 HEIC 占位（.unsupported + 无 img 源），实际 cls="${t.cls}" hasSrc=${t.hasSrc} icon=${JSON.stringify(t.unsupportedText)}`);
    } else if (kind === 'broken') {
      if (t.thumbReady && !t.hasSrc) out.broken.push(t);
      else if (t.hasSrc && t.naturalW > 0) out.violations.push(`${t.rel}: 期望解不出（占位/跳过），实际出图了 ${t.naturalW}x${t.naturalH}`);
      else out.violations.push(`${t.rel}: 期望明确的失败表现（thumb-ready 且无图），实际 cls="${t.cls}" hasSrc=${t.hasSrc} thumbReady=${t.thumbReady}`);
    } else if (kind === 'good') {
      if (t.hasSrc && t.naturalW > 0 && t.naturalH > 0) out.good.push(t);
      else out.violations.push(`${t.rel}: 期望出图，实际 natural=${t.naturalW}x${t.naturalH} hasSrc=${t.hasSrc} cls="${t.cls}"`);
    } else {
      if (spec.allowUnknown) out.good.push(t);
      else out.unknown.push(t.rel);
    }
  }
  return out;
}

/** 反复审计直到没有违规（或超时）。超时不抛错，交给调用方断言 violations。 */
export async function waitTilesSettled(session, spec, { timeout = 30000, poll = 150 } = {}) {
  const t0 = Date.now();
  let audit = await auditTiles(session, spec);
  while (audit.violations.length && Date.now() - t0 < timeout) {
    await sleep(poll);
    audit = await auditTiles(session, spec);
  }
  return audit;
}

/**
 * 等「缩略图生成」真正结束（计数器不再是「正在生成缩略图 (n/m)…」）。
 *
 * 与 waitSettled 的区别：waitSettled 只等**已渲染出来的磁贴**就绪（settledNow 里有注释：
 * 虚拟滚动下没滚到的行不会请求缩略图，用 done>=total 判稳会假死到超时）。
 * 但最终计数文案（「N 张图片（含子文件夹 M 个）」）是生成**全部**结束后才写的，
 * 所以要断言那条文案，就得单独等生成结束 —— 这里用文案本身当信号，不再看 done/total。
 */
export async function waitThumbGenDone(session, { timeout = 120000, poll = 200 } = {}) {
  const t0 = Date.now();
  let snap = await session.snapshot();
  while (/正在生成缩略图/.test(String(snap.counterText)) && Date.now() - t0 < timeout) {
    await sleep(poll);
    snap = await session.snapshot();
  }
  return { snapshot: snap, ms: Date.now() - t0 };
}

/**
 * 找出页面上所有「能滚的东西」（虚拟滚动可能挂在 window 也可能挂在某个 div 上）。
 * 注意：这几个函数是被 page.evaluate 序列化后单独执行的，**不能**互相调用，
 * 所以每段都是自包含的。
 */
function scrollMaxInPage() {
  const els = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll('*')]
    .filter((el) => el && el.scrollHeight > el.clientHeight + 20);
  let h = document.documentElement.scrollHeight;
  for (const el of els) h = Math.max(h, el.scrollHeight);
  return { maxScroll: h, scrollables: els.length, clientHeight: window.innerHeight };
}
function scrollToInPage(y) {
  const els = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll('*')]
    .filter((el) => el && el.scrollHeight > el.clientHeight + 20);
  let top = 0;
  for (const el of els) {
    el.scrollTop = y;
    top = Math.max(top, el.scrollTop);
  }
  window.scrollTo(0, y);
  return Math.max(top, document.documentElement.scrollTop || 0, window.scrollY || 0);
}

/** 文件夹磁贴（名字/图标/尺寸），用于根目录视图断言。 */
export async function folderCards(session) {
  return session.page.evaluate(() =>
    [...document.querySelectorAll('#gallery .folder-card')].map((c) => {
      const r = c.getBoundingClientRect();
      const label = c.querySelector('.label');
      // 注意：拿到预览后 .folder-icon 会被 renderPreviews() 换成 .folder-mosaic
      // （与网页版 gkpv.html:1830-1839 同逻辑），此时 .folder-icon 查不到，
      // 但卡片仍是「有图标」的有效卡片。所以两种形态都要报。
      const icon = c.querySelector('.folder-icon');
      return {
        name: c._folderName,
        label: label ? label.textContent : '',
        icon: icon ? icon.textContent : '',
        mosaicImgs: c.querySelectorAll('.folder-mosaic img').length,
        boxW: Math.round(r.width),
        boxH: Math.round(r.height),
      };
    }),
  );
}

/** 各 section 的标题文案（文件夹 (N) / 图片 (N)）。 */
export async function sectionTitles(session) {
  return session.page.evaluate(() => [...document.querySelectorAll('#gallery .dir-section h3')].map((h) => h.textContent));
}

/**
 * 滚完整页，把每一行的磁贴都审一遍（虚拟滚动下 DOM 里不会同时存在全部磁贴）。
 * 返回 { good:Map<rel,tile>, broken:Set, unsupported:Set, violations:[], unknown:Set, steps, maxScroll }
 */
export async function sweepTiles(session, spec, { stepPx = 380, settleMs = 200, maxSteps = 200 } = {}) {
  const page = session.page;
  const good = new Map();
  const broken = new Set();
  const unsupported = new Set();
  const unknown = new Set();
  const violations = [];

  const absorb = async (where) => {
    const a = await waitTilesSettled(session, spec, { timeout: 3000, poll: 120 });
    for (const t of a.good) if (!good.has(t.rel)) good.set(t.rel, t);
    for (const t of a.broken) broken.add(t.rel);
    for (const t of a.unsupported) unsupported.add(t.rel);
    for (const rel of a.unknown) unknown.add(rel);
    for (const v of a.violations) if (!violations.includes(`${where}| ${v}`)) violations.push(`${where}| ${v}`);
    return a;
  };

  await page.evaluate(scrollToInPage, 0);
  await sleep(settleMs);
  await absorb('y=0');

  const { maxScroll } = await page.evaluate(scrollMaxInPage);
  let steps = 0;
  let lastTop = 0;
  for (let y = stepPx; y <= maxScroll; y += stepPx) {
    steps += 1;
    if (steps > maxSteps) break;
    lastTop = await page.evaluate(scrollToInPage, y);
    await sleep(settleMs);
    await absorb(`y=${y}`);
  }
  await page.evaluate(scrollToInPage, 0);
  await sleep(settleMs);
  return { good, broken, unsupported, unknown, violations, steps, maxScroll: Math.round(maxScroll), lastTop: Math.round(lastTop) };
}

/** 等灯箱里的图真的出来（或明确给出提示），返回灯箱快照。 */
export async function waitLightboxImage(session, { timeout = 20000 } = {}) {
  await session.page.waitForFunction(
    () => {
      const img = document.getElementById('lbImg');
      const msg = document.getElementById('lbMsg');
      return !!((img && img.naturalWidth > 0) || (msg && msg.classList.contains('show')));
    },
    undefined,
    { timeout },
  );
  return session.lightbox();
}

/** 取某个 rel 的磁贴；当前没渲染（虚拟滚动）就滚一遍找。 */
export async function findTile(session, rel, spec) {
  let t = (await session.tiles()).find((x) => x.rel === rel);
  if (t) return t;
  const sweep = await sweepTiles(session, spec || { good: new Set([rel]), broken: new Set(), unsupported: new Set(), allowUnknown: true });
  t = sweep.good.get(rel);
  return t || null;
}

/** 取某个 rel 的 img 像素尺寸（找不到则返回 null）。 */
export async function tileDims(session, rel, spec) {
  const t = await findTile(session, rel, spec);
  return t ? { w: t.naturalW, h: t.naturalH, boxW: t.boxW, boxH: t.boxH, ratio: t.naturalH > 0 ? t.naturalW / t.naturalH : 0 } : null;
}

/** 用 index 打开灯箱并等图（index 为 state.currentImages 下标）。 */
export async function openLightboxAt(session, index) {
  await session.page.evaluate((i) => window.__gkpv.lightbox.open(i), index);
  return waitLightboxImage(session);
}

/* ================================================================== *
 * 断言
 * ================================================================== */

/**
 * 「这个用例在本环境下没有覆盖条件」——不是失败，也绝不能算通过。
 *
 * 典型场景：`real/` 里的真实样片是个人照片、不入库，CI 用 `--no-real`
 * 生成素材后该目录为空，依赖它的用例没有可断言的对象。
 * 唯一诚实的处理是**报告跳过并说明原因**：既不能判红（环境没素材不是回归），
 * 也不能判绿（那等于谎报覆盖）。运行器会把它单列成「跳过」计数。
 */
export class SkipCase extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkipCase';
    this.skipped = true;
  }
}

export function makeAssertions() {
  const notes = [];
  const warnings = [];
  return {
    notes,
    warnings,
    check(cond, msg) {
      if (!cond) throw new Error(msg);
    },
    eq(actual, expected, msg) {
      if (actual !== expected) throw new Error(`${msg}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
    },
    near(actual, expected, tol, msg) {
      if (!(Math.abs(actual - expected) <= tol)) {
        throw new Error(`${msg}：期望 ${expected} ±${tol}，实际 ${actual}（差 ${Math.abs(actual - expected).toFixed(4)}）`);
      }
    },
    note(msg) {
      notes.push(String(msg));
    },
    warn(msg) {
      warnings.push(String(msg));
    },
    /** 本环境缺少覆盖条件：抛出让运行器记为「跳过」，并带着原因上报。 */
    skip(reason) {
      throw new SkipCase(String(reason));
    },
  };
}

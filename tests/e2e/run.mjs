#!/usr/bin/env node
/**
 * gkpv 桌面版 E2E 唯一入口。
 *
 *   node tests/e2e/run.mjs                  # 跑全部用例
 *   node tests/e2e/run.mjs --filter=灯箱     # 只跑名字/文件名含「灯箱」的用例（子串匹配，大小写不敏感）
 *   node tests/e2e/run.mjs --list           # 只列出用例
 *
 * 退出码：0 = 全绿；1 = 有用例失败；2 = 环境/配置问题（找不到 electron.exe、manifest 缺失、filter 无匹配…）
 *
 * 设计约束（别改，改之前先读 README.md）：
 *  - 用 playwright-core 的 `_electron` 直接驱动，不用 @playwright/test 运行器；
 *  - 子进程 env 必须删掉 ELECTRON_RUN_AS_NODE；
 *  - 期望值全部从 tests/fixtures/manifest.json + 真实目录走查推导，不硬编码张数；
 *  - 每个「素材根目录」一个 Electron 会话（fixtures / empty / missing / exit），相互隔离 userData；
 *  - 失败时把现场（截图 + 快照 + tiles + 控制台错误）落到 tests/artifacts/<时间戳>/<用例名>/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  E2E_DIR,
  FIXTURES_DIR,
  MANIFEST_PATH,
  MISSING_DIR,
  USER_DATA_DIR,
  makeEmptyDir,
  packageVersion,
  resetDir,
  resolveElectron,
} from './lib/paths.mjs';
import { launchSession, electronProcesses, makeAssertions, SkipCase } from './lib/harness.mjs';
import { loadManifest, dirExpectation, recursiveExpectation, summarize, scanDir, realAvailable } from './lib/fixtures.mjs';

const TMP_DIR = path.join(E2E_DIR, '.tmp');
const ARTIFACTS_DIR = path.resolve(E2E_DIR, '..', 'artifacts');

const CASE_FILES = [
  'cases-launch.mjs',
  'cases-gallery.mjs',
  'cases-thumbs.mjs',
  'cases-raw.mjs',
  'cases-orient.mjs',
  'cases-lightbox.mjs',
  'cases-edge.mjs',
  'cases-cache.mjs',
  'cases-commands.mjs',
  'cases-exit.mjs',
];

const ASCII = process.env.GKPV_E2E_ASCII === '1';
const PASS = ASCII ? 'OK  ' : '✔';
const FAIL = ASCII ? 'FAIL' : '✖';
const SKIP = ASCII ? 'SKIP' : '○';
const CASE_TIMEOUT_MS = Number(process.env.GKPV_E2E_CASE_TIMEOUT_MS || 300000);

const out = (s = '') => process.stdout.write(`${s}\n`);

function usage() {
  out('用法: node tests/e2e/run.mjs [--filter=<子串>] [--list] [--timeout=<毫秒>]');
  out('  --filter=<子串>   只跑用例名或文件名包含该子串的用例');
  out('  --list            只列出用例，不执行');
  out('  --timeout=<毫秒>  单个用例超时（默认 300000）');
  out('环境变量: GKPV_E2E_ASCII=1 用 ASCII 记号输出（控制台不支持 ✔/✖ 时）');
}

function parseArgs(argv) {
  const opt = { filter: '', list: false, timeout: CASE_TIMEOUT_MS };
  for (const a of argv) {
    if (a === '--list') opt.list = true;
    else if (a === '--help' || a === '-h') {
      usage();
      process.exit(0);
    } else if (a.startsWith('--filter=')) opt.filter = a.slice('--filter='.length);
    else if (a.startsWith('--timeout=')) opt.timeout = Number(a.slice('--timeout='.length)) || CASE_TIMEOUT_MS;
    else {
      out(`未知参数：${a}`);
      usage();
      process.exit(2);
    }
  }
  return opt;
}

function slug(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

async function dumpArtifacts(stamp, caseName, err, A, session) {
  const dir = path.join(ARTIFACTS_DIR, stamp, slug(caseName));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'error.txt'),
      `${caseName}\n\n${err && (err.stack || err.message || err)}\n\nnotes:\n${(A.notes || []).join('\n')}\n\nwarnings:\n${(A.warnings || []).join('\n')}\n`,
      'utf8',
    );
    if (session && !session.closed) {
      try {
        const snap = await session.snapshot();
        fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(snap, null, 2), 'utf8');
      } catch (e) {
        fs.writeFileSync(path.join(dir, 'snapshot.error.txt'), String((e && e.stack) || e), 'utf8');
      }
      try {
        const tiles = await session.tiles();
        fs.writeFileSync(path.join(dir, 'tiles.json'), JSON.stringify(tiles, null, 2), 'utf8');
      } catch { /* 忽略 */ }
      try {
        const diag = await session.diagnostics();
        fs.writeFileSync(path.join(dir, 'diagnostics.json'), JSON.stringify(diag, null, 2), 'utf8');
      } catch { /* 忽略 */ }
      try {
        fs.writeFileSync(
          path.join(dir, 'browser-log.json'),
          JSON.stringify({ pageErrors: session.pageErrors, consoleErrors: session.consoleErrors, trace: await session.page.evaluate(() => window.__gkpv.trace || []) }, null, 2),
          'utf8',
        );
      } catch { /* 忽略 */ }
      try {
        await session.page.screenshot({ path: path.join(dir, 'screen.png') });
      } catch { /* 忽略 */ }
    }
    return dir;
  } catch (e) {
    out(`  （写失败现场时出错：${(e && e.message) || e}）`);
    return null;
  }
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));

  if (process.platform === 'win32') {
    // 让控制台按 UTF-8 解码，否则 ✔/✖ 会花掉（PowerShell/cmd 老控制台）
    try {
      spawnSync('chcp', ['65001'], { stdio: 'ignore', shell: true, windowsHide: true });
    } catch { /* 忽略 */ }
  }

  // ---------- 加载用例 ----------
  const files = [];
  for (const f of CASE_FILES) {
    const abs = path.join(E2E_DIR, f);
    if (!fs.existsSync(abs)) {
      out(`缺少用例文件：${abs}`);
      process.exit(2);
    }
    files.push({ file: f, abs });
  }

  const cases = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(f.abs).href);
    const list = Array.isArray(mod.default) ? mod.default : [];
    if (!list.length) out(`（提醒）${f.file} 没有导出任何用例`);
    for (const c of list) {
      if (!c || typeof c.fn !== 'function' || !c.name) {
        out(`（提醒）${f.file} 里有格式不对的用例条目：${JSON.stringify(c && c.name)}`);
        continue;
      }
      cases.push({ ...c, file: f.file });
    }
  }
  if (!cases.length) {
    out('没有解析到任何用例');
    process.exit(2);
  }

  const selected = opt.filter
    ? cases.filter((c) => `${c.file} ${c.name}`.toLowerCase().includes(opt.filter.toLowerCase()))
    : cases;

  out('='.repeat(78));
  out('gkpv 桌面版 E2E（playwright-core + Electron，真窗口）');
  out('='.repeat(78));

  // 全新克隆 + 受限网络下，electron 二进制会在下面这行「首次 require」时才去下载（GitHub 源）。
  // 提前说一句，免得把「下载源不通」误读成「项目坏了」。
  out('（若出现 “Downloading Electron binary...”，那是 electron 44 首次 require 时才拉二进制；');
  out('  下载源不通时设 $env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/" 重跑）');

  // ---------- 环境自检 ----------
  let exe = null;
  let exeVia = '';
  try {
    const r = resolveElectron();
    exe = r.exe;
    exeVia = r.via;
  } catch (e) {
    out(`找不到 electron.exe：${e.message}`);
    process.exit(2);
  }
  if (!fs.existsSync(MANIFEST_PATH)) {
    out(`缺少素材清单 ${MANIFEST_PATH}（先跑 npm.cmd run fixtures）`);
    process.exit(2);
  }
  const manifest = loadManifest();
  const summary = summarize(manifest);
  const recursiveExp = recursiveExpectation(manifest);
  const top = scanDir(FIXTURES_DIR);
  const realStatus = realAvailable(manifest);

  out(`执行命令   : node tests/e2e/run.mjs${process.argv.slice(2).length ? ` ${process.argv.slice(2).join(' ')}` : ''}`);
  out(`node       : ${process.version}   平台: ${process.platform}/${process.arch}`);
  out(`electron   : ${exe}  (${exeVia}, v${packageVersion('electron')})`);
  out(`playwright : playwright-core ${packageVersion('playwright-core')}`);
  out(`素材       : ${FIXTURES_DIR}`);
  out(`             顶层 ${summary.topFolders.length} 个文件夹 / ${summary.topImages.length} 张图；递归可见图片 ${recursiveExp.total} 张`);
  out(`             目录树：${summary.treeFolders} 个文件夹 / ${summary.treeImages} 个图片文件；清单生成于 ${summary.generatedAt}`);
  out(
    `             真实样片：${realStatus.ok ? `${realStatus.count} 个（覆盖成立）` : `不可用 —— ${realStatus.reason}（依赖它的用例会记为「跳过」）`}`,
  );
  out(`userData   : ${USER_DATA_DIR}<会话名>（每轮重置，隔离 localStorage/OPFS/单实例锁）`);
  out(`用例       : ${selected.length}/${cases.length}${opt.filter ? `（filter=「${opt.filter}」）` : ''}，单条超时 ${Math.round(opt.timeout / 1000)}s`);
  if (opt.list) {
    out('');
    for (const c of selected) out(`  ${c.file}  ${c.name}`);
    process.exit(0);
  }
  if (!selected.length) {
    out(`\n没有用例匹配 filter=「${opt.filter}」`);
    process.exit(2);
  }
  out('');

  // ---------- 准备隔离环境 ----------
  resetDir(USER_DATA_DIR);
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const emptyDir = makeEmptyDir();

  const sessions = new Map();
  const roots = {
    fixtures: { rootPath: FIXTURES_DIR, label: 'main' },
    empty: { rootPath: emptyDir, label: 'empty' },
    missing: { rootPath: MISSING_DIR, label: 'missing' },
    exit: { rootPath: FIXTURES_DIR, label: 'exit' },
  };

  const ctx = {
    A: null,
    session: null,
    __lastSession: null,
    FIXTURES: FIXTURES_DIR,
    EMPTY_DIR: emptyDir,
    MISSING_DIR,
    TMP: TMP_DIR,
    path,
    manifest,
    expected: recursiveExp,
    expectedForDir: (rel) => dirExpectation(manifest, rel),
    real: realStatus,
    summarize: () => summary,
    async sessionFor(key) {
      if (sessions.has(key)) {
        ctx.__lastSession = sessions.get(key);
        return ctx.__lastSession;
      }
      const r = roots[key];
      if (!r) throw new Error(`未知的素材根目录 key：${key}`);
      out(`    · 启动 Electron 会话「${r.label}」（root=${r.rootPath}）…`);
      const s = await launchSession({ rootPath: r.rootPath, label: r.label });
      sessions.set(key, s);
      ctx.__lastSession = s;
      return s;
    },
  };

  // ---------- 串行执行 ----------
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const results = [];
  const skipped = [];
  const t0 = Date.now();
  let interrupted = false;
  const onSignal = async () => {
    interrupted = true;
    out('\n收到中断信号，正在关闭 Electron 会话…');
    for (const s of sessions.values()) {
      try {
        await s.close({ expectGone: true });
      } catch { /* 忽略 */ }
    }
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('unhandledRejection', (e) => out(`（未处理的 Promise 拒绝）${(e && e.stack) || e}`));

  try {
    ctx.session = await ctx.sessionFor('fixtures');
    for (const c of selected) {
      const A = makeAssertions();
      ctx.A = A;
      ctx.session = sessions.get('fixtures') || ctx.session;
      const started = Date.now();
      const label = `${c.file.replace(/^cases-|\.mjs$/g, '')}`;
      process.stdout.write(`  … [${label}] ${c.name}\n`);
      let err = null;
      let timer = null;
      try {
        await Promise.race([
          Promise.resolve(c.fn(ctx)),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error(`用例超时（${Math.round(opt.timeout / 1000)}s）`)), opt.timeout);
          }),
        ]);
      } catch (e) {
        err = e;
      } finally {
        if (timer) clearTimeout(timer);
      }
      const ms = Date.now() - started;
      if (err && (err instanceof SkipCase || err.skipped)) {
        // 跳过不等于通过：单独一行、单独计数，且必须带上原因（否则就是无声丢覆盖）
        out(`  ${SKIP} ${c.name}  (${Math.round(ms / 1000)}s)`);
        out(`      跳过：${(err && err.message) || err}`);
        for (const n of A.notes) out(`      · ${n}`);
        skipped.push({ name: c.name, reason: String((err && err.message) || err) });
        results.push({ ...c, ok: true, skipped: true, ms, reason: String((err && err.message) || err), notes: A.notes, warnings: A.warnings });
      } else if (err) {
        // 上面那行「… [file] name」是进行中的滚动行，失败时补一条正式结果行
        out(`  ${FAIL} ${c.name}  (${Math.round(ms / 1000)}s)`);
        out(`      原因：${(err && err.message) || err}`);
        if (A.notes.length) for (const n of A.notes) out(`      · ${n}`);
        if (A.warnings.length) for (const w of A.warnings) out(`      ! ${w}`);
        const dir = await dumpArtifacts(stamp, c.name, err, A, ctx.__lastSession);
        if (dir) out(`      现场：${dir}`);
        results.push({ ...c, ok: false, ms, error: String((err && err.message) || err), stack: String((err && err.stack) || ''), notes: A.notes, warnings: A.warnings });
      } else {
        out(`  ${PASS} ${c.name}  (${Math.round(ms / 1000)}s)`);
        for (const n of A.notes) out(`      · ${n}`);
        for (const w of A.warnings) out(`      ! ${w}`);
        results.push({ ...c, ok: true, ms, notes: A.notes, warnings: A.warnings });
      }
    }
  } finally {
    for (const [key, s] of sessions) {
      try {
        const r = await s.close({ expectGone: true });
        if (key === 'fixtures' || key === 'exit') {
          out(
            `  （会话「${s.label}」关闭：pid=${r.pid} ${r.ms}ms，close 返回错误=${r.error ? r.error.message : '无'}，` +
              `进程仍在=${r.aliveAfter}${r.forced ? '（被 taskkill 强杀）' : ''}）`,
          );
        }
      } catch (e) {
        out(`  （关闭会话 ${key} 出错：${(e && e.message) || e}）`);
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const secs = Math.round((Date.now() - t0) / 1000);
  const procs = electronProcesses();

  out('');
  out('='.repeat(78));
  out(
    `汇总：${results.length} 个用例，通过 ${passed}，失败 ${failed.length}` +
      (skipped.length ? `，跳过 ${skipped.length}` : '') +
      `，用时 ${Math.floor(secs / 60)}m${secs % 60}s`,
  );
  if (skipped.length) {
    out('');
    out('跳过的用例（本环境缺少覆盖条件，不计入失败，也不计入通过）：');
    for (const s of skipped) out(`  ${SKIP} ${s.name}  →  ${s.reason}`);
  }
  if (failed.length) {
    out('');
    out('失败用例：');
    for (const f of failed) out(`  ${FAIL} ${f.name}  →  ${f.error}`);
    out('');
    out(`现场目录：${path.join(ARTIFACTS_DIR, stamp)}`);
  } else {
    out(skipped.length ? `全部通过 ✅（${passed}/${results.length} 通过，${skipped.length} 条跳过 —— 跳过的覆盖缺口见上）` : '全部通过 ✅');
  }
  out(`残留 electron.exe 进程：${procs.count === -1 ? '统计失败' : procs.count} 个（机器上可能还有其它 Electron 程序）`);
  out('='.repeat(78));

  // ---------- 写一份机器可读的结果，便于 Lead/CI 引用 ----------
  try {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, 'last-run.json'),
      JSON.stringify(
        {
          stamp,
          ranAt: new Date().toISOString(),
          command: `node tests/e2e/run.mjs ${process.argv.slice(2).join(' ')}`.trim(),
          filter: opt.filter || null,
          node: process.version,
          electron: packageVersion('electron'),
          playwrightCore: packageVersion('playwright-core'),
          fixtures: summary,
          realSamples: realStatus,
          recursiveImages: recursiveExp.total,
          total: results.length,
          passed,
          failed: failed.length,
          skipped: skipped.length,
          skippedCases: skipped,
          seconds: secs,
          cases: results.map((r) => ({
            file: r.file,
            name: r.name,
            ok: r.ok,
            skipped: !!r.skipped,
            skipReason: r.reason || null,
            ms: r.ms,
            error: r.error || null,
            notes: r.notes,
            warnings: r.warnings,
          })),
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (e) {
    out(`（写 last-run.json 失败：${(e && e.message) || e}）`);
  }

  // ---------- 清理临时目录 ----------
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  try {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  } catch { /* 忽略 */ }

  if (!failed.length && !interrupted) {
    // 全绿时不留现场目录（失败时的现场保留给 Lead 看）
    try {
      const stampDir = path.join(ARTIFACTS_DIR, stamp);
      if (fs.existsSync(stampDir)) fs.rmSync(stampDir, { recursive: true, force: true });
    } catch { /* 忽略 */ }
  }

  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  out(`运行器自身出错：${(e && e.stack) || e}`);
  process.exit(2);
});

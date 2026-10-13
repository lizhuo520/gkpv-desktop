/**
 * 统一解析路径与外部依赖。
 *
 * 依赖已经统一到仓库根（单一 lockfile）：electron / playwright-core 都从
 * `F:\gkpv\node_modules` 解析，所以这里用 createRequire 走裸包名，绝不写死
 * 具体的 node_modules 子路径（Lead 2025 把 desktop/node_modules 删掉过一次）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const requireFromHere = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = path.resolve(HERE, '..');
export const TESTS_DIR = path.resolve(E2E_DIR, '..');
export const REPO_ROOT = path.resolve(TESTS_DIR, '..');
export const DESKTOP_DIR = path.join(REPO_ROOT, 'desktop');
export const FIXTURES_DIR = path.join(TESTS_DIR, 'fixtures');
export const MANIFEST_PATH = path.join(FIXTURES_DIR, 'manifest.json');

/** 测试专用 userData 根目录：与真实用户配置隔离（主进程只在 GKPV_TEST_ROOT 存在时才认它）。 */
export const USER_DATA_DIR = path.join(os.tmpdir(), 'gkpv-e2e-userdata');
/**
 * 每个会话用**各自**的 userData 子目录。
 * 原因：主进程用 `app.requestSingleInstanceLock()`，锁是按 userData 判定的——
 * 共享同一个 userData 时，第二个 electron.exe 会立刻退出，`firstWindow()` 永远等不到窗口。
 */
export function userDataFor(label) {
  const safe = String(label || 'session').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(USER_DATA_DIR, safe);
}
/** 「不存在的目录」用例用的路径：故意指向一个从不存在的名字。 */
export const MISSING_DIR = path.join(os.tmpdir(), 'gkpv-e2e-没有这个目录');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 找 electron.exe：优先 `require('electron')`（返回 exe 路径字符串），
 * 再按候选路径探测。找不到就把尝试过的每一步写进错误里。
 */
export function resolveElectron() {
  const tried = [];
  try {
    const p = requireFromHere('electron');
    if (typeof p === 'string' && p) {
      tried.push(`require('electron') -> ${p}`);
      if (fs.existsSync(p)) return { exe: p, via: "require('electron')", tried };
    } else {
      tried.push(`require('electron') -> ${typeof p}（不是路径字符串）`);
    }
  } catch (e) {
    tried.push(`require('electron') 抛错：${e && e.message}`);
  }
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe'),
  ];
  for (const c of candidates) {
    tried.push(c);
    if (fs.existsSync(c)) return { exe: c, via: '候选路径', tried };
  }
  throw new Error(`找不到 electron.exe。尝试过：\n  ${tried.join('\n  ')}`);
}

export function packageVersion(name, fallback = '?') {
  try {
    const v = requireFromHere(`${name}/package.json`);
    return (v && v.version) || fallback;
  } catch {
    return fallback;
  }
}

/** 清空并重建一个目录（每轮跑之前重置 userData，保证冷启动一致、可重复）。 */
export function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function makeEmptyDir(prefix = 'gkpv-e2e-empty-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

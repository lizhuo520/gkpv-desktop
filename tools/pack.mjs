#!/usr/bin/env node
/**
 * tools/pack.mjs —— 打包入口（electron-builder 的统一包装）
 *
 * 为什么要有这层包装，而不是直接 `electron-builder --win`：
 *
 *   1. **参数一致**：CI（.github/workflows）与本地必须用同一组参数，
 *      否则「我这儿能打出包」会变成长期扯皮。所有开关都从这里走。
 *   2. **前置检查**：打包最常见的失败是「图标没生成」和「dist 里有上次的残留」，
 *      这两件事在这里提前查/清，报错信息比 electron-builder 的原始输出好懂。
 *   3. **网络兜底**：首次打包要下载 electron 二进制与 winCodeSign/nsis 资源，
 *      国内直连 github 常常超时。这里在未显式设置镜像时给出提示，
 *      并支持 GKPV_MIRROR=1 切到 npmmirror 镜像（不写死，尊重用户环境变量）。
 *
 * 用法：
 *   node tools/pack.mjs            # NSIS 安装包 + portable 免安装版
 *   node tools/pack.mjs --dir      # 只产出解包目录（dist/win-unpacked），最快，冒烟测试用
 *   node tools/pack.mjs --publish  # 交给 CI 用：打出产物但不发布（发布走 GitHub Release）
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'desktop');
const DIST = path.join(ROOT, 'dist');
const ICON = path.join(ROOT, 'build', 'icon.ico');
const CONFIG = path.join(ROOT, 'electron-builder.yml');

function fail(msg) {
  process.stderr.write(`✖ ${msg}\n`);
  process.exit(1);
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

const args = process.argv.slice(2);

/* ---------------- 前置检查 ---------------- */

if (!fs.existsSync(path.join(DESKTOP, 'main', 'main.cjs'))) {
  fail(`找不到应用入口 ${path.join(DESKTOP, 'main', 'main.cjs')}，目录结构不对`);
}

// 图标不是「可选美化」：electron-builder 在 --win 下若 icon 缺失会直接报错，
// 报错文本还很长，所以这里先给一句人话。
if (!fs.existsSync(ICON)) {
  fail(`缺少图标 ${ICON}。先跑：npm run icon`);
}

// 打包配置走独立的 electron-builder.yml：`--config package.json` 会被当成裸配置对象，
// 因为 name/scripts/devDependencies 这些正常字段直接报 unknown property 而失败。
if (!fs.existsSync(CONFIG)) {
  fail(`缺少打包配置 ${CONFIG}`);
}

// 依赖必须在仓库根（单一 lockfile）。桌面目录里出现 node_modules 说明有人
// 在子目录里装过依赖，那会打出「开发机能跑、别人机器缺模块」的包。
if (fs.existsSync(path.join(DESKTOP, 'node_modules'))) {
  log('⚠ desktop/node_modules 存在：依赖应统一装在仓库根。');
  log('  若打包报「模块找不到」，删掉它并重新在根目录 npm install。');
}

const builderBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
if (!fs.existsSync(builderBin)) {
  fail(`找不到 electron-builder（${builderBin}）。先在仓库根跑：npm install`);
}

/* ---------------- 清理上次产物 ---------------- */

// 不清 dist 的话，冒烟测试可能拿上一次的旧包当「新产物」，这是会骗过自己的坑。
// 但 Windows 上删不掉时会 EPERM：刚被打过包的 exe 常常还被防病毒/索引服务持有句柄
// （进程早退了，句柄还没放），实测退避 10 秒仍可能失败。
//
// 关键：**重命名目录不需要删除里面任何文件**，被占用的文件照样能改名。
// 所以删除失败时退化为「把旧 dist 改名挪开 + 新建空 dist」，既不阻塞打包，
// 也保证 electron-builder 面对的是一个空目录（不会把旧产物当新结果）。
if (fs.existsSync(DIST) && !args.includes('--keep-dist')) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const tryRm = async (target, attempts) => {
    let err = null;
    for (let i = 1; i <= attempts; i += 1) {
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        return { ok: true, err: null };
      } catch (e) {
        err = e;
        if (i < attempts) await wait(i * 400);
      }
    }
    return { ok: false, err };
  };

  // 先把能删的子目录挨个删（哪个删不掉就只挪那个），比整体删更容易成功
  for (const sub of ['win-unpacked', 'win-ia32-unpacked', 'win-arm64-unpacked', 'builder-effective-config.yaml']) {
    const p = path.join(DIST, sub);
    if (!fs.existsSync(p)) continue;
    const r = await tryRm(p, 4);
    if (!r.ok && fs.existsSync(p)) {
      const aside = `${p}.old-${Date.now()}`;
      try {
        fs.renameSync(p, aside);
        log(`⚠ ${sub} 被占用，已改名挪开：${path.basename(aside)}（确认新包没问题后可手工删）`);
      } catch (e2) {
        fail(
          `既删不掉也挪不动 ${p}：${e2.code}\n`
          + '  多半是打包产物还在运行。请关掉 GKP Viewer 后重试。\n'
          + `  删除失败原因：${r.err && r.err.code}`,
        );
      }
    }
  }

  // 再把 dist 本身抹干净：还在（说明里面还有我们没列到的条目）就整体删，删不掉就整体挪
  if (fs.existsSync(DIST)) {
    const r = await tryRm(DIST, 4);
    if (!r.ok || fs.existsSync(DIST)) {
      const aside = `${DIST}.old-${Date.now()}`;
      try {
        fs.renameSync(DIST, aside);
        log(`⚠ dist/ 整体被占用，已改名挪开：${path.basename(aside)}（确认新包没问题后可手工删）`);
      } catch (e2) {
        fail(
          `dist/ 既删不掉也挪不动：${e2.code}\n`
          + '  请确认没有 GKP Viewer.exe 在运行，然后重试；\n'
          + '  或临时跳过清理：npm run pack:dir -- --keep-dist（此时须自行确认拿的不是旧产物）。\n'
          + `  删除失败原因：${r.err && r.err.code}`,
        );
      }
    }
  }

  fs.mkdirSync(DIST, { recursive: true });
  log('· 已清理上次的 dist/');
}

/* ---------------- 组装 electron-builder 参数 ---------------- */

const ebArgs = ['--win', '--config', CONFIG];
if (args.includes('--dir')) {
  ebArgs.push('--dir');
  log('· 模式：--dir（只产出解包目录，不生成安装器）');
} else {
  log('· 模式：NSIS 安装包 + portable 免安装版');
}
if (args.includes('--publish')) ebArgs.push('--publish', 'never');

const env = { ...process.env };
if (process.env.GKPV_MIRROR === '1') {
  env.ELECTRON_MIRROR = env.ELECTRON_MIRROR || 'https://registry.npmmirror.com/-/binary/electron/';
  env.ELECTRON_BUILDER_BINARIES_MIRROR = env.ELECTRON_BUILDER_BINARIES_MIRROR
    || 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/';
  log('· 已启用 npmmirror 镜像（GKPV_MIRROR=1）');
} else if (!process.env.ELECTRON_BUILDER_BINARIES_MIRROR) {
  log('· 提示：首次打包需下载 winCodeSign/nsis 资源；若卡在下载，用 GKPV_MIRROR=1 走镜像');
}

/* ---------------- 跑 ---------------- */

log(`· 执行：electron-builder ${ebArgs.join(' ')}`);
const started = Date.now();
const res = spawnSync(builderBin, ebArgs, {
  cwd: ROOT,
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

if (res.error) fail(`启动 electron-builder 失败：${res.error.message}`);
if (res.status !== 0) fail(`electron-builder 退出码 ${res.status}（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);

/* ---------------- 列产物 ---------------- */

const bundles = fs.existsSync(DIST)
  ? fs.readdirSync(DIST, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];
const artifacts = fs.existsSync(DIST)
  ? fs.readdirSync(DIST, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.endsWith('.blockmap'))
    .map((e) => ({ name: e.name, size: fs.statSync(path.join(DIST, e.name)).size }))
    .sort((a, b) => a.name.localeCompare(b.name))
  : [];

log('');
log(`✔ 打包完成（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);
for (const a of artifacts) log(`  ${a.name}  ${(a.size / 1024 / 1024).toFixed(1)} MB`);
for (const b of bundles) log(`  [目录] dist/${b}/`);
if (!artifacts.length && !bundles.length) log('  （没有产物？检查上面的输出）');

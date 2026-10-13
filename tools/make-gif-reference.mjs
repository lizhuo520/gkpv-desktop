#!/usr/bin/env node
/**
 * tools/make-gif-reference.mjs —— 复现**冻结的 Pillow GIF 参照物**。
 *
 * 产出：tests/samples/reference/pillow-gif-120x90.gif
 *       120×90、273 字节、隔行（图像描述符 packed bit6 = 1）、
 *       sha256 = 6a96068a0520170d8d56354d888e0c27a34b6fa5e58469ad133277d26902d6af
 *
 * ## 为什么需要它（一次真实的教训）
 *
 * `tests/fixtures/basic/gif-120x90.gif` 原先就是这份 Pillow 产物，用来跟项目里
 * 手写 LZW 编码器（tools/make-gif-sample.mjs）的产物做**跨编码器交叉验证** ——
 * 两份产物字节数不同（273 vs 279）、隔行标志不同（0x40 vs 0x00），
 * 但解码后的像素必须逐点相同。这是唯一能证明"两种独立实现画的是同一张图"的办法。
 *
 * 后来它被 `npm run fixtures` 覆盖掉了（生成器当时从手写样本复制，两边变成同一份
 * 字节），跨编码器比对就退化成**自己跟自己比**：无论编码器错成什么样都会通过。
 * 而且这份 273 字节的文件从未提交过 git，覆盖即彻底消失。
 *
 * 万幸可以逐字节复现：Pillow 12.3 在 `optimize=False` 下产出的字节流与原脚本一致
 * （已实测，见下方 EXPECTED_SHA256 的校验）。本脚本把这个复现步骤固化下来，
 * 参照物因此**永远可以重建**，不再依赖任何人的记忆或磁盘上的侥幸副本。
 *
 * ## 用法
 *
 *   npm run gif-reference
 *
 * 需要一份可用的 Pillow。本机系统 Python 没装的话，可以只装到仓库内（不入库）：
 *
 *   python -m pip install --target .pylibs Pillow
 *
 * 脚本会依次探测：仓库内 `.pylibs` → 系统 Python 的 site-packages。
 * 找不到 Pillow 时**明确报错并以非零码退出**，不会静默跳过（静默跳过会让
 * 跨编码器验证悄悄消失，正是本项目已经踩过的坑）。
 *
 * ## 与原脚本的等价性
 *
 * 参数逐项照抄 tools/make-gif-template.py，任何一项不同都会改变字节流：
 *   · Image.new('P', (120, 90))
 *   · putpalette([0,0,0, 200,40,40, 32,32,32])   ← 只给 3 色，Pillow 自己补到 256 项
 *   · px[x,y] = 1 if (x < W//4 and y < H//4) else 2   ← 注意是整除，22 行不是 23 行
 *   · save(format='GIF', optimize=False)          ← optimize 默认是 True 之外的路径，必须显式关掉
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const REPO = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(REPO, 'tests', 'samples', 'reference');
const OUT = path.join(OUT_DIR, 'pillow-gif-120x90.gif');

/** 冻结值：与原 tools/make-gif-template.py 的产物逐字节一致（已实测复现）。 */
export const EXPECTED_BYTES = 273;
export const EXPECTED_SHA256 = '6a96068a0520170d8d56354d888e0c27a34b6fa5e58469ad133277d26902d6af';

/**
 * 生成参照物的 Python 源码（内联，避免又多一个需要同步的文件）。
 * 它是 tools/make-gif-template.py 的等价最小版本。
 */
const PY = String.raw`
import hashlib, io, pathlib, sys

target = pathlib.Path(sys.argv[1])

# 仓库内装的 Pillow 优先（本机系统 Python 没装时用 pip --target .pylibs 装到这里）
local = pathlib.Path(sys.argv[2])
for extra in (local, local / "Lib" / "site-packages"):
    if extra.is_dir() and str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

try:
    from PIL import Image, __version__ as pillow_version
except ImportError as exc:
    sys.stderr.write("缺少 Pillow：%s\n" % exc)
    sys.stderr.write("请先装一份（可以只装进仓库、不入库）：\n")
    sys.stderr.write("  python -m pip install --target .pylibs Pillow\n")
    sys.exit(3)

WIDTH, HEIGHT = 120, 90
img = Image.new("P", (WIDTH, HEIGHT))
img.putpalette([0, 0, 0, 200, 40, 40, 32, 32, 32])
px = img.load()
for y in range(HEIGHT):
    for x in range(WIDTH):
        # 整除：HEIGHT // 4 == 22，绝不能写成 y < HEIGHT / 4（那是 22.5 → 23 行）
        px[x, y] = 1 if (x < WIDTH // 4 and y < HEIGHT // 4) else 2

buf = io.BytesIO()
img.save(buf, format="GIF", optimize=False)
data = buf.getvalue()

target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(data)
print("Pillow %s" % pillow_version)
print("bytes  %d" % len(data))
print("sha256 %s" % hashlib.sha256(data).hexdigest())
`;

function findPython() {
  for (const cmd of ['python', 'py', 'python3']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!r.error && r.status === 0) return cmd;
  }
  return null;
}

function main() {
  const python = findPython();
  if (!python) {
    console.error('✖ 找不到 python（试过 python / py / python3）。');
    console.error('  本脚本需要一个能跑 Pillow 的 Python；不装也没关系，');
    console.error('  但 tests/unit/gif.test.mjs 的跨编码器比对会因缺参照物而失败。');
    process.exit(3);
  }

  if (process.argv.includes('--check')) {
    if (!fs.existsSync(OUT)) {
      console.error(`✖ 参照物不存在：${path.relative(REPO, OUT)}`);
      console.error('  跑 npm run gif-reference 复现（需要一份可用的 Pillow）。');
      process.exit(1);
    }
    const sha = sha256(fs.readFileSync(OUT));
    if (sha !== EXPECTED_SHA256) {
      console.error(`✖ 参照物哈希不符：${sha}\n  期望 ${EXPECTED_SHA256}`);
      process.exit(1);
    }
    console.log(`OK  参照物就位：${path.relative(REPO, OUT)}  ${EXPECTED_BYTES}B  ${sha.slice(0, 16)}…`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = path.join(OUT_DIR, '.pillow-gif.tmp.gif');
  const r = spawnSync(python, ['-c', PY, tmp, path.join(REPO, '.pylibs')], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || '');
    process.stdout.write(r.stdout || '');
    process.exit(r.status || 1);
  }
  process.stdout.write(r.stdout);

  const buf = fs.readFileSync(tmp);
  const sha = sha256(buf);

  if (buf.length !== EXPECTED_BYTES || sha !== EXPECTED_SHA256) {
    fs.rmSync(tmp, { force: true });
    console.error('✖ 复现失败：产出的字节与本项目登记的冻结值不一致。');
    console.error(`  实际 ${buf.length} 字节 / ${sha}`);
    console.error(`  期望 ${EXPECTED_BYTES} 字节 / ${EXPECTED_SHA256}`);
    console.error('  说明 Pillow 版本或参数与原 tools/make-gif-template.py 不同。');
    console.error('  不要直接把 EXPECTED_* 改成新值 —— 先确认参数是否被改动；');
    console.error('  若确实换了 Pillow 版本，请同时更新 tests/unit/gif.test.mjs 里的隔行假设。');
    process.exit(1);
  }

  // 只有内容校验通过才落盘，避免把错的参照物留在原地
  fs.rmSync(OUT, { force: true });
  fs.renameSync(tmp, OUT);
  console.log(`OK  ${path.relative(REPO, OUT)}  ${buf.length} 字节  ${sha.slice(0, 16)}…（与冻结值一致）`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

/**
 * capture-samples.mjs —— 用本机 Electron 的 Chromium 编码器产出「真实可解码」的
 * WebP / JPEG 参考样本，登记进 fixtures 作为真实素材。
 *
 * 为什么需要它（这是本项目踩出来的硬结论，不是可选项）：
 *   渲染层的缩略图链路要真的走 `createImageBitmap` 解码，所以素材必须被真实
 *   解码器接受。手写 VP8L 位流成本极高、极易写出「结构合法但解码器拒收」的文件；
 *   连「克隆真实 WebP 再改写 VP8X 画布尺寸」都被证伪 —— 解码输出尺寸由位流自带，
 *   改容器声明改不动（实测：Chromium 仍按 64×64 输出）。
 *   于是策略定为：真实编码器产出的文件原样进仓库当素材，一个字节都不改。
 *
 * 用法：
 *   node tools/capture-samples.mjs            # 写入 tests/samples/
 *   node tools/capture-samples.mjs --check    # 只校验已存在的样本仍可解码
 *
 * 产物（目录在 tests/fixtures **之外**，生成器只读不删）：
 *   tests/samples/webp-64x64.webp    —— 64×64 渐变，有损 WebP
 *   tests/samples/webp-128x64.webp   —— 128×64 渐变（2:1 横向，测宽高比路径）
 *   tests/samples/jpeg-64x64.jpg     —— 64×64 渐变，基线 JPEG
 *   tests/samples/manifest.json      —— 尺寸 / mime / sha256 记录
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const OUT_DIR = path.join(ROOT, 'tests', 'samples');

const SAMPLES = [
  { file: 'webp-64x64.webp', type: 'image/webp', quality: 0.9, width: 64, height: 64 },
  { file: 'webp-128x64.webp', type: 'image/webp', quality: 0.9, width: 128, height: 64 },
  { file: 'jpeg-64x64.jpg', type: 'image/jpeg', quality: 0.8, width: 64, height: 64 },
];

/** 在渲染进程里画一张渐变图并编码成指定类型。 */
async function renderSample(spec) {
  const c = new OffscreenCanvas(spec.width, spec.height);
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, spec.width, spec.height);
  grd.addColorStop(0, '#883322');
  grd.addColorStop(0.5, '#e0d0a0');
  grd.addColorStop(1, '#2255aa');
  g.fillStyle = grd;
  g.fillRect(0, 0, spec.width, spec.height);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, Math.max(1, spec.width >> 2), Math.max(1, spec.height >> 2));
  const blob = await c.convertToBlob({ type: spec.type, quality: spec.quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let decoded = null;
  try {
    const b = await createImageBitmap(blob);
    decoded = { width: b.width, height: b.height };
    b.close();
  } catch (e) {
    decoded = { width: 0, height: 0, error: String((e && e.message) || e) };
  }
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { mime: blob.type, base64: btoa(binary), decoded };
}

export async function capture({ check = false } = {}) {
  // 依赖统一装在仓库根（Electron 与 playwright-core 都是）：单一 lockfile，
  // 免得出现「根目录装过了、但这个脚本只看 desktop/ 就报缺依赖」的假故障。
  const pwEntry = path.join(ROOT, 'node_modules', 'playwright-core');
  if (!fs.existsSync(pwEntry)) {
    throw new Error(
      `找不到 playwright-core（${pwEntry}）；请在仓库根执行 npm install`,
    );
  }
  // 用 CJS require 拿（playwright-core 的 ESM 入口导出的是空命名空间）
  const require_ = createRequire(path.join(ROOT, 'noop.cjs'));
  const { _electron: electron } = require_(pwEntry);
  const env = { ...process.env, GKPV_TEST_MODE: '1', GKPV_TEST_ROOT: path.join(ROOT, 'tests', 'fixtures') };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    args: ['.', `--test-root=${path.join(ROOT, 'tests', 'fixtures')}`],
    cwd: DESKTOP,
    env,
    timeout: 90_000,
  });
  const results = [];
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => window.__gkpv && window.__gkpv.ready === true, null, { timeout: 60_000 });
    for (const spec of SAMPLES) {
      // 不用 new Function（会被页面 CSP 拦），直接把函数体交给 Playwright 求值
      const out = await win.evaluate(renderSample, {
        type: spec.type,
        quality: spec.quality,
        width: spec.width,
        height: spec.height,
      });
      const buf = Buffer.from(out.base64, 'base64');
      const record = {
        file: spec.file,
        width: spec.width,
        height: spec.height,
        requestedMime: spec.type,
        mime: out.mime,
        bytes: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        decoded: out.decoded,
      };
      if (!check) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(OUT_DIR, spec.file), buf);
      }
      results.push(record);
    }
  } finally {
    await app.close();
  }
  return results;
}

async function main() {
  const check = process.argv.includes('--check');
  if (check) {
    // --check 校验「磁盘上已有的样本」，而不是重新渲染一遍：
    // 它要回答的问题是「仓库里的素材现在还能不能被解码」，答案必须来自那批字节。
    let failed = 0;
    for (const spec of SAMPLES) {
      const p = path.join(OUT_DIR, spec.file);
      if (!fs.existsSync(p)) {
        console.log(`MISS ${spec.file}  （文件不存在，请先跑 node tools/capture-samples.mjs）`);
        failed += 1;
        continue;
      }
      const buf = fs.readFileSync(p);
      const head = buf.subarray(0, 16).toString('latin1');
      const looksWebP = head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP';
      const looksJPEG = buf[0] === 0xff && buf[1] === 0xd8;
      const okMagic = spec.type === 'image/webp' ? looksWebP : looksJPEG;
      console.log(
        `${okMagic ? 'OK  ' : 'FAIL'} ${spec.file}  ${buf.length} 字节  ` +
        `sha256=${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}…`,
      );
      if (!okMagic) failed += 1;
    }
    if (failed) {
      console.error(`\n有 ${failed} 个样本缺失或容器头不合法`);
      process.exitCode = 1;
    } else {
      console.log(`\n${SAMPLES.length} 个样本就位（容器头校验通过）`);
    }
    return;
  }

  const results = await capture({ check: false });
  const problems = [];
  for (const r of results) {
    const okDecode = r.decoded && r.decoded.width === r.width && r.decoded.height === r.height;
    const okMime = r.mime === r.requestedMime;
    console.log(
      `${okDecode && okMime ? 'OK  ' : 'FAIL'} ${r.file}  ${r.bytes} 字节  ${r.width}x${r.height}  mime=${r.mime}  ` +
      `解码=${r.decoded ? `${r.decoded.width}x${r.decoded.height}` : r.decoded.error}  ` +
      `sha256=${r.sha256.slice(0, 16)}…`,
    );
    if (!okMime) problems.push(`${r.file}: 请求 ${r.requestedMime} 但得到 ${r.mime}`);
    if (!okDecode) problems.push(`${r.file}: 解码结果与目标尺寸不符`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'manifest.json'),
    `${JSON.stringify({ generatedBy: 'tools/capture-samples.mjs', samples: results }, null, 2)}\n`,
    'utf8',
  );
  if (problems.length) {
    console.error(`\n有 ${problems.length} 个问题：`);
    for (const p of problems) console.error('  - ' + p);
    process.exitCode = 1;
  } else {
    console.log(`\n全部样本可解码，已写入 ${OUT_DIR}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 1;
  });
}

export { SAMPLES, OUT_DIR, renderSample };

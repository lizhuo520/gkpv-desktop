# gkpv 桌面版 · 阶段性目标与测试计划

> 本文回答两件事：**阶段怎么切、每阶段怎么算完成**，以及**测试覆盖到什么程度、哪些地方没覆盖**。
> 配套文档：可行性分析 `docs/feasibility.md`、验收清单 `docs/acceptance.md`、变更记录 `docs/CHANGELOG.md`。

- 项目：`gkpv-desktop` 2.0.0（Electron 44.7.0 / Chromium 152 / Node 24.21）
- 基线（未改动的网页版对照物）：`gkpv.html`，SHA256 `7B06F2541C30357F…`
- 测试环境：Windows x64，Node `v24.21.0`，`npm.cmd`（PowerShell 执行策略禁用 `npm.ps1`）

---

## 一、阶段性目标

每个阶段都以「**可验证的产物 + 明确的完成判据**」定义，完成判据写在最后一列。

| 阶段 | 目标 | 主要产物 | 完成判据 | 状态 |
| --- | --- | --- | --- | --- |
| **0. 可行性核实** | 把「能不能移植」从猜测变成实测 | `docs/feasibility.md` | 关键 API（`app://` 源、OPFS、`showDirectoryPicker`）在真实 Electron 44 窗口里逐一实测通过 | ✅ 完成 |
| **1. 仓库与骨架** | 让桌面版能起来一个独立窗口 | `desktop/main/*`、`desktop/preload/*`、`desktop/renderer/index.html`、根 `package.json`、`build/icon.ico` | 双击/命令行能开出窗口；`app://` 协议可服务资源；无控制台报错 | ✅ 完成 |
| **2. 代码移植** | 2707 行单文件 → 模块化桌面版，**功能等价** | `desktop/renderer/lib/` 17 个模块 + `app.js` + `boot.js`；`desktop/main/scandir.cjs` 只读扫盘 | 原版每一项功能都能在新版里跑通；算法与常量未改（只搬家与拆文件） | ✅ 完成 |
| **3. 完整测试** | 用素材、单测、真窗口 E2E 把行为钉住 | `tools/gen-fixtures.mjs`、`tests/fixtures/`（72 素材 + manifest）、`tests/unit/`（26 条）、`tests/e2e/`（42 条） | 单元测试 26/26 通过；E2E 42/42 在**真 Electron 会话**里全绿；发现的真 bug 全部修掉并有回归用例 | ✅ 完成 |
| **4. 打包** | 产出可分发的 Windows 产物 | `electron-builder` NSIS 安装包 + portable 免安装版；`tools/pack.mjs`；`tests/pack/` | 安装/免安装产物能启动、能开图、能扫目录；产物冒烟脚本通过 | ✅ 完成 |
| **5. 版本管理与交付** | 用 GitHub 管版本，给出验收材料 | 仓库 `lizhuo520/gkpv-desktop`、阶段 tag、Release、`README`/`docs/acceptance.md` | 远程仓库可访问、标签与 Release 就位、验收清单逐条有证据 | 🔄 进行中 |
| **6. 可选增强** | 文件关联、记住上次目录等 | — | — | ⛔ 本轮明确不做（用户已确认） |

**阶段标签计划**：`v2.0.0-alpha.1`（骨架）→ `v2.0.0-alpha.2`（移植完）→ `v2.0.0-beta.1`（测试完）→ `v2.0.0`（打包交付）。

---

## 二、测试分层

```
tests/
├─ fixtures/         素材与期望值（72 个文件 + manifest.json，sha256 全量校验）
├─ unit/             Node 侧单元测试（26 条，node --test）
├─ e2e/              真 Electron 窗口的端到端测试（playwright-core）
└─ pack/             打包产物冒烟（跑 dist/ 里的真实产物）
```

| 层 | 跑什么 | 命令 | 通过标准 |
| --- | --- | --- | --- |
| 素材自检 | 素材与 manifest 是否一一对应、字节是否被意外改动 | `npm run test:unit` | 结构性断言全过 |
| 单元 | 主进程扫盘、尺寸解析、mime、内嵌预览提取、边界 | `npm run test:unit` | 25/25 |
| 端到端 | 真窗口里的扫描/缩略图/灯箱/递归/边界目录 | `npm run test:e2e` | 全绿 |
| 打包冒烟 | `dist/` 产物启动后能扫目录、能解码 | `npm run smoke:pack` | 全绿 |
| 全量 | 上面全部 | `npm test` | 全绿 |

---

## 三、测试素材（`tests/fixtures/`）

72 个素材，分布在 7 组；`manifest.json` 记录每个文件的 `size` / `sha256` / `expect{w,h}` / `decodeVia` / `kind`。

| 组 | 数量 | 覆盖什么 |
| --- | --- | --- |
| `basic/` | 12 | 全格式基线：PNG（含 64×512 极端长宽比、半透明）、JPEG（400×300 / 1600×900）、GIF、BMP、WebP（两种）、**只有头部尺寸的 WebP**、SVG（带尺寸 / 不带尺寸） |
| `exif/` | 9 | EXIF 方向 1–8 各一张 + 无方向标记一张（竖拍转正的正确性全靠它） |
| `raw/` | 5 | NEF / ARW×2 / CR2 / DNG：TIFF 容器 + 内嵌 JPEG 预览 + 容器方向标记 |
| `edge/` | 12 | 坏 JPEG、坏 PNG、空文件、伪 HEIC、无扩展名、纯文本、未知扩展名、隐藏文件、超长中文文件名、含空格与括号的中文名、**稀疏大尺寸 PNG**、空目录 |
| `nested/` | 4 | 4 层嵌套 + 旁支目录（递归/非递归的差异） |
| `many/` | 24 | 数量压力（虚滚动、缩略图排队、计数器） |
| `real/` | 6 | **真实样本**（从本机 `D:\图片\iCloud 照片` 复制）：真实 JPEG×2、真实 PNG×2、真实 GIF（4.9 MB）、**真实 HEIC**（855 KB） |

> **`real/` 不入库**（公开仓库不包含个人照片，见 `.gitignore`）。克隆后该目录为**空**，
> 与之相关的断言会**跳过并打印原因**（`tests/unit/fixtures.test.mjs` 里的 `REAL_SKIP`），
> 不会假装通过；CI 显式跑 `npm run fixtures -- --no-real`。
> 本机有相册时可 `npm run fixtures` 自动重建这 6 个文件，恢复这块覆盖。

**素材原则**（踩过坑后定的）：凡**必须真解码**的格式，一律用真实编码器产出，不手工拼字节——早期用合成容器时解码器直接拒绝，测试反而掩盖问题。只有「结构本身就是被测对象」的容器（RAW 的 TIFF 内嵌预览、只有头部尺寸的 WebP）才允许合成。

---

## 四、单元测试（`tests/unit/`，26 条，已全绿）

**`fixtures.test.mjs`（8 条）—— 素材可信度**

1. manifest 结构完整（每条都带 `rel`/`size`/`sha256`/`decodeVia`）
2. 磁盘素材与 manifest 一一对应（既不少也不多）
3. 每个素材的 sha256 与字节数一致
4. 真实样本目录就位且容器头合法
5. **Node 侧尺寸解析与渲染层解析器答案完全相同**（两套独立实现对同一批素材必须给同一答案）
6. RAW 素材容器方向与内嵌预览标记齐全
7. 边界素材齐全（坏图 / 空文件 / HEIC / 无扩展名 / 文本 / 隐藏项）
8. 目录清单与文件清单自洽（供「空目录也要列出来」的断言使用）

**`scandir.test.mjs`（12 条）—— 主进程只读扫盘**
递归集合、非递归只取一层、隐藏项与系统噪声目录跳过、非图片扩展名不进清单、**扫描幂等**（连扫两次逐字段相同）、不存在目录返回错误而不抛异常、逐素材尺寸解析、SVG 刻意不在 Node 侧解析尺寸（矢量图交渲染层兜底）、坏图返回 0×0 而不抛异常、内嵌预览提取（普通图读原件 / RAW 抓内嵌 JPEG / 坏图返回 null）、`mimeOfExt` 扩展名覆盖。

**`gif.test.mjs`（6 条）—— GIF 素材的独立验证**

这个文件的存在理由值得单独说：GIF 是项目里**唯一一份手写编码器产出**的素材（`tools/make-gif-sample.mjs`，因为本机 Pillow 环境损坏而不想依赖 Python）。手写 LZW 在本项目翻过车，且踩的坑极具代表性：

- 第一版被 Chromium 与 Pillow 同时拒收；
- 第二版能解码、前景像素总数也对（660），但**图案是错的**——图像描述符的 packed 字节误写成 `0x40`（隔行标志），Chromium 于是把逐行顺序的位流按 8/8/4/2 交错行序重排，实心红块显示成「每隔 4 行一条红带」。**因为前景像素总数不变，所有只看总数的断言都毫无反应**；而我拿自己写的解码器去比对（它忽略了该标志位）又强化了「没问题」的错觉。最后是真 Chromium 抽点取像素才看出来。

6 条断言分别是：
1. **冻结的 Pillow 参照物仍在且未被覆盖**（见下方「一次真实事故」）；
2. 容器结构合法（尺寸 / 4 项全局色表 / 无多余尾部）——并断言 Pillow 那份**确实**声明隔行（`0x40`）；
3. 手写样本不是隔行的（专盯上面那个 bug）；
4. 规范解码器解到 EOI，像素**逐点**等于 30×22 红块，且前景行是连续的 `0..21`（隔行重排会变成 `0,4,8,…`）；
5. 手写编码器可复现磁盘上的字节（素材没漂，`EXPECTED_*` 自洽）；
6. **手写产物与 Pillow 参照物逐点相同**（只允许字节数不同）。

> **一次真实事故（值得记住）**：第 6 条一度退化成「同一个文件跟它自己比」。原因是 `gen-fixtures.mjs` 的 `sampleFixture()` 是**复制**样本，而当时 fixture 与 sample 都指向手写编码器那一份（279 B），于是无论编码器错成什么样这条断言都会通过——零证明力。更糟的是那份 273 B 的 Pillow 产物**从未提交过 git**，被 `npm run fixtures` 覆盖即彻底消失。
> 现在已经三重加固：① fixture 只从 `tests/samples/reference/` 取冻结参照物；② `tests/unit/gif.test.mjs` 第 1 条断言参照物的存在与 sha256，并反查「samples 与参照物确实不同源」；③ `npm run gif-reference` 用 Pillow 12.3 + 原 `tools/make-gif-template.py` 的原始参数**逐字节复现**它（已实测：`optimize=False` + 3 色调色板 → 273 B / `6a96068a…`），丢失可重建。

> **这些测试抓出的真 bug**（详见 `docs/CHANGELOG.md`）：① TIFF 尺寸解析在 SubIFD 结构上取错字段；② SVG 未带尺寸时被当成 0×0 导致布局错乱；③ GIF 图像描述符误置隔行标志位导致图案被重排（只看像素总数抓不到）；④ 应用菜单命令全部静默失效（kebab-case 与 camelCase 对不上）。四条都已修，并各有断言钉住。

---

## 五、端到端测试（`tests/e2e/`，42 条，真 Electron 会话）

**为什么用真窗口**：这个应用的正确性大半在 Chromium 的解码、OPFS 缓存、虚滚动与事件时序里，
用 jsdom 之类的模拟环境测不出真问题。

**技术手段**：`playwright-core` 的 `_electron.launch()` 直接拉 `node_modules/electron/dist/electron.exe`，
参数 `desktop`（应用目录），环境变量：

| 变量 | 作用 |
| --- | --- |
| `GKPV_TEST_MODE=1` | 打开测试态预加载接口（生产构建里被静态消除） |
| `GKPV_TEST_ROOT=<目录>` | 指定首屏要打开的目录（替代原生选择对话框） |
| `GKPV_TEST_USERDATA=<目录>` | 每条会话独立 `userData`，避免 OPFS 缓存 / localStorage / 单实例锁互相污染 |
| *（必须删除）* `ELECTRON_RUN_AS_NODE` | 若为 `1`，`electron.exe` 会退化成纯 Node，应用起不来 |

启动前置条件（实测踩坑得到）：
- `window.__gkpv` 在 `domcontentloaded` 时仍是 `undefined`（`boot.js` 是 `type=module`，异步执行），
  必须先轮询 `window.__gkpv.ready === true`；
- 默认 **非递归**，所以「看到全部图片」必须先真实点击 `#recursiveBtn` 工具栏按钮，
  而不是注入状态。

**用例设计**（期望值全部从 `manifest.json` + 真实目录遍历推导，只对「至少多少」这类下界做硬编码）：

| 用例 | 断言要点 |
| --- | --- |
| 首屏与根目录卡片 | 7 个文件夹卡片；0 张图片（非递归）；计数器文案正确 |
| 进入 `basic/`（12 张） | 全格式都能出磁贴；`webp-header` 坏图计入失败而**不卡住计数器** |
| 递归模式 | 打开递归后图片总数与 manifest 推导值一致 |
| `exif/`（9 张） | 方向 1/6/8 的**显示宽高比**按预期翻转（不是读 EXIF 字段，是看真实渲染盒） |
| `raw/`（5 张） | 5 张都有缩略图（内嵌 JPEG 提取成功）；方向标记生效 |
| `edge/` | 3 张坏图 + 空文件 + HEIC 走占位；文件扫描完成后计数器归零无残影 |
| 灯箱 | 打开/关闭、`→`/`←` 翻页、缩放、**换页后旧图 blob 被回收**（不泄漏） |
| 幂等 rescan | 二次扫描结果与首次一致，缓存命中不重复解码 |
| 边界目录 | 空目录 → 明确空态文案而不是报错；不存在的目录 → 错误提示不崩 |

**E2E 已知限制（如实标注）**：
- **原生「选择文件夹」对话框路径未被自动化覆盖**。Playwright 无法驱动 Windows 原生对话框，
  因此 E2E 走 `GKPV_TEST_ROOT` 注入。真实对话框需人工按验收清单第 1 项点一次。
- E2E 的图片计数断言基于 `tests/fixtures/`，**不覆盖**真实相机 RAW（NEF/ARW 用的是合成容器）
  和 HEIC（Chromium 不解码 HEIC，本项目行为是「占位 + 计数」，两边一致）。

---

## 六、打包测试（`tests/pack/`）

| 检查项 | 判据 |
| --- | --- |
| 产物存在 | `dist/` 下有 `GKP Viewer-2.0.0-setup.exe` 与 `-portable.exe` |
| 免安装版可启动 | portable 产物起得来窗口，标题与版本号正确 |
| asar 内资源可读 | `app://gkpv/renderer/index.html` 能加载（验证协议 handler 在 asar 下的降级路径） |
| 打包后能扫目录 | 用 `GKPV_TEST_ROOT` 指向 fixtures，能出磁贴（验证 `fs` 读盘 + 尺寸解析在打包环境下正常） |
| 安装包能装 | 静默安装到临时目录 → 启动 → 卸载后无残留目录 |

---

## 七、性能基线

在 `tests/fixtures/many/`（24 张，混合尺寸）与 `real/`（含 4.9 MB GIF、3.9 MB PNG）上记录：

| 指标 | 采集方式 | 基线用途 |
| --- | --- | --- |
| 首屏可见磁贴时间 | 从 `renderDirectory:start` 到首批卡片入 DOM | 防「移植后变慢」 |
| 全量缩略图完成时间 | 计数器到 `n/n` | 同上 |
| 缓存二次打开 | 清空 OPFS 前 vs 后的对比 | 验证缩略图缓存真的在起作用 |
| 大图解码 | 4.9 MB GIF / 3.9 MB PNG 的首帧时间 | 与 `diagnose.html` 同口径，可直接对照 |

**原则**：性能数字**只做基线记录与前后对比**，不设绝对阈值（不同机器不可比）。回归判断标准是
「同一台机器上，桌面版与网页版同口径指标不显著劣化（< 20%）」。

---

## 八、未覆盖项（如实说明，不谎报）

| 项 | 原因 | 缓解 |
| --- | --- | --- |
| 真实相机 RAW（未压缩/多预览变体） | 手头没有真实机型样片，用合成 TIFF 容器覆盖结构逻辑 | 合成容器已覆盖「IFD0 方向 + SubIFD 内嵌预览」两条核心路径；真实样片待用户提供后补测 |
| HEIC 真实解码 | Chromium 本身不支持 HEIC，本项目行为固定为「占位 + 计数」 | 与网页版行为逐字一致，不是退化 |
| 原生文件夹对话框 | 无法被 Playwright 驱动 | 验收清单手动项 |
| 代码签名 / SmartScreen | 用户明确本轮不做签名 | README 与验收清单中说明「未知发布者」提示的成因 |
| macOS / Linux 产物 | 用户只要 Windows 桌面应用 | 未涉及平台相关代码路径也一并未测 |
| 超大图库（> 20000 张） | 实测素材规模到 24 张压力组 | 代码里已有 `SCAN_LIMIT` 截断提示，逻辑有单测覆盖；真实万张级图库待用户环境验证 |

---

## 九、复现步骤（换一台机器怎么验）

```powershell
# 0) 依赖（国内网络加镜像，见 README）
npm.cmd install

# 1) 素材（可重复生成，产出与 manifest 一致）
npm.cmd run fixtures

# 2) 单元测试
npm.cmd run test:unit

# 3) 端到端（会真的开窗口）
npm.cmd run test:e2e

# 4) 打包 + 产物冒烟
npm.cmd run pack
npm.cmd run smoke:pack

# 5) 全量
npm.cmd test
```

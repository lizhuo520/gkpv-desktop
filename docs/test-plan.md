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
| **3. 完整测试** | 用素材、单测、真窗口 E2E 把行为钉住 | `tools/gen-fixtures.mjs`、`tests/fixtures/`（72 素材 + manifest）、`tests/unit/`（26 条）、`tests/e2e/`（43 条） | 单元测试 26/26 通过；E2E 43 条在**真 Electron 会话**里全绿（缺 `real/` 素材的环境记 42 通过 + 1 跳过）；发现的真 bug 全部修掉并有回归用例 | ✅ 完成 |
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
| 单元 | 主进程扫盘、尺寸解析、mime、内嵌预览提取、边界 | `npm run test:unit` | 26/26 |
| 端到端 | 真窗口里的扫描/缩略图/灯箱/递归/边界目录 | `npm run test:e2e` | 有 `real/` 素材时 43/43；无素材时 42 通过 + 1 跳过，**0 失败** |
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

## 五、端到端测试（`tests/e2e/`，43 条，真 Electron 会话）

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

### 条件覆盖：跳过与降级（不能判红，也不能静默放过）

`tests/fixtures/real/` 放的是**个人真实照片**（`.gitignore` 已忽略，不进仓库），CI 用
`npm run fixtures -- --no-real` 生成素材后该目录为空。素材缺失既不是产品回归（**判红是错的**），
也不能当作验过了（**静默放过等于谎报覆盖**）。因此测试框架有两条明确机制：

| 机制 | 什么时候用 | 表现 |
| --- | --- | --- |
| **跳过**（`A.skip(reason)`，抛 `SkipCase`） | 本环境**没有可断言对象**，且没有等价素材 | 单独一行 `○ 用例名` + 原因；计入「跳过」列，**不计入失败、也不计入通过**；`run.mjs` 的退出码只看失败数 —— 跳过不会让 CI 变红 |
| **降级**（runtime 选目录） | 同一产品路径在别的目录有**等价素材** | 用例照常执行并通过，用 `A.note` 打印「未覆盖的变体是什么」 |

启动横幅会先打印一行 `真实样片：N 个（覆盖成立）` 或 `不可用 —— <原因>`，判据见
`tests/e2e/lib/fixtures.mjs` 的 `realAvailable()`：**manifest 登记**与**磁盘文件**任缺其一即认为覆盖不成立
（manifest 有登记而磁盘没文件时，跳过反而是对的）。

具体到用例：
- `thumbs:real-photos-decode`（真实相机素材）→ **跳过**：没有真实照片时无法断言「真实 JPEG/PNG/GIF 都能解码」。
- `thumbs:heic-placeholder-not-a-failure` 与它**故意分成两条**：前者只跑 `edge/fake.heic`，
  它在任何环境下都能跑；合在一起会让「edge/ 那一半明明跑过了」被整条记成跳过，低估覆盖。
- `lightbox:heic-message-others-still-work` → **降级到 `edge/`**：该用例验的是「HEIC 给提示 + 同目录能解码的图照常出图」，
  `edge/` 有 `fake.heic` + 4 张可解码图，是等价素材；唯一没覆盖的变体是「真实相机 HEIC」，由 note 明确标出。

**实测两条路径**（都在本机跑过）：

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| 本机（`D:\图片\iCloud 照片` 存在） | `npm run fixtures` + `npm run test:e2e` | **43/43 通过**，0 失败 0 跳过 |
| 模拟 CI（无相册） | `npm run fixtures -- --no-real` + `npm run test:e2e` | **42 通过 + 1 跳过**，0 失败；退出码 0 |

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
- 缺少 `real/` 素材（CI、或本机没有相册）时，`thumbs:real-photos-decode` 记为**跳过**而不是通过 ——
  「真实照片能解码」这条覆盖在那种环境下**确实没有验证过**，报告里必须能看出来（见第五节的跳过/降级机制）。

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

# 0.2) 首次跑 E2E/start 前，如果不通 GitHub，先给 electron 二进制指个镜像。
#      electron 44 的二进制**不是 npm install 时下载的**，而是第一次 require('electron')
#      时才惰性下载。受限网络下会看到「Downloading Electron binary...」之后失败，
#      报「Electron failed to install correctly」—— 那不是项目坏了，只是源不通。
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"

# 0.5) 关键前置：删掉这个环境变量，否则 electron.exe 退化成纯 Node、应用永远起不来
#      （现象：exe 秒退、无任何输出。打包产物同样受影响 —— 实测踩到过）
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# 1) 素材（可重复生成，产出与 manifest 一致）
npm.cmd run fixtures

# 2) 单元测试
npm.cmd run test:unit

# 3) 端到端（会真的开窗口）
npm.cmd run test:e2e

# 4) 打包 + 产物冒烟
npm.cmd run pack
npm.cmd run smoke:pack
npm.cmd run smoke:pack "dist\GKP Viewer-2.0.0-portable.exe"   # 可选：指定产物

# 5) 全量
npm.cmd test
```

### 安装包与便携版怎么验（自动化覆盖不到「双击」）

`setup.exe` 与 `portable.exe` 都可以脚本化跑一遍，用来替代「双击」这一类人工项：

```powershell
# 安装到临时目录（/S 静默，/D 指定目录且必须是最后一个参数、不带引号）
$target = Join-Path $env:TEMP "gkpv-install-test"
Start-Process "dist\GKP Viewer-2.0.0-setup.exe" -ArgumentList "/S", "/D=$target" -Wait

# 启动装好的应用 → 再启动一次验单实例锁 → 关窗验无残留
Start-Process (Join-Path $target "GKP Viewer.exe")

# 静默卸载：安装目录与两个快捷方式都应被清干净
Start-Process (Get-ChildItem $target -Filter "Uninstall*.exe").FullName -ArgumentList "/S" -Wait
```

实测结论（2026-10-14，Windows 10 19045）：安装 7s / 75 文件 368 MB，桌面与开始菜单快捷方式都创建成功；
安装版 2s 开窗、便携版 4s 开窗；窗口已开着时二次启动**不新开窗口**（单实例锁生效）；
关窗后残留进程 0 个；卸载后安装目录与两个快捷方式**全部清除**，`%APPDATA%\GKP Viewer`
按设计保留（`deleteAppDataOnUninstall: false`，缩略图缓存与偏好重装后还在）。

> 便携版是自解压壳，会用**新进程**跑内层 exe，Playwright 无法接管（需要一开始就掌握进程），
> 所以 `smoke-packaged.mjs` 默认只测 `win-unpacked` 里的 exe。便携版改用
> 「记录启动前的进程 id → 枚举新出现的进程 → 看 `MainWindowHandle` 是否为 0」验证。

> 崩溃日志的预期行为：正常关窗**不会**产生 `gkpv-crash.log`。只有进程被强杀
> （任务管理器结束进程 / `Stop-Process -Force`）时，主进程会先观察到子进程消失并写入一条记录，
> 于是留下一个 0 字节文件 —— 这是**正常**的，不是崩溃证据；有内容才代表出过问题。

---

## 十、全新克隆复现验证（端到端可复现性的硬证据）

不只在本机工作树上跑通，还从 GitHub **全新克隆**到临时目录跑了一遍完整链路
（2026-10-14，`C:\Users\Lizhuo\AppData\Local\Temp\gkpv-clone-check`，不含任何本地状态）：

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 克隆 | `git clone https://github.com/lizhuo520/gkpv-desktop.git <临时目录>` | ✔ 退出码 0，147 个文件（不含 `.git`） |
| 装依赖 | `npm.cmd ci` | ✔ 285 个包，3s |
| 生成素材 | `npm.cmd run fixtures -- --no-real` | ✔ 66 个文件（CI 同款路径） |
| 单元测试 | `npm.cmd run test:unit` | ✔ **26/26**，168ms |
| 端到端 | `node tests\e2e\run.mjs` | ✔ **42 通过 + 1 跳过、0 失败**，33s（`real/` 未入库，跳过原因已打印） |
| 打包 | `$env:GKPV_MIRROR="1"; npm.cmd run pack` | ✔ 29.4s，产出 portable 106.1 MB / setup 106.3 MB |
| 产物冒烟 | `npm.cmd run smoke:pack` | ✔ **8/8**，3.4s（`app://` 源、缩略图 400×300、关窗无残留） |

**这一步抓出的真问题**：首次在克隆里跑 E2E **失败**了，报

```
Downloading Electron binary...
找不到 electron.exe：… Electron failed to install correctly.
```

根因不是项目缺陷，而是 **electron 44 的二进制是惰性下载的**：`node_modules/electron/index.js`
在第一次 `require('electron')` 时才 `spawnSync` 跑 `install.js` 去 GitHub 拉二进制，
`npm ci` 阶段什么都不下载。受限网络下这一步必失败，而报错信息**完全不提镜像**。
已落地的改进：① `tests/e2e/lib/paths.mjs` 的 `resolveElectron()` 在错误信息里直接给出
`ELECTRON_MIRROR` 的修法；② `tests/e2e/run.mjs` 启动横幅预先说明这行输出是什么；
③ 本节与第九节把镜像步骤写进复现流程。

> 这也解释了为什么本机工作树一直没踩到：`node_modules/electron/dist/` 早就下好了。
> **有 CI 的机器不会踩（首次步骤就下）、全新克隆的机器必踩** —— 属于典型的
> 「只有真正从零复现才会暴露」的问题，所以这条验证步骤留在流程里。



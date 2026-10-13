# gkpv 桌面化可行性分析

> 结论先行：**可行**。原项目是一个 96 KB/2707 行的零依赖单文件网页（`gkpv.html`），
> 其功能全部建立在 Chromium 提供的标准 Web API 上；Electron 就是「带独立窗口和
> 本地文件能力的 Chromium」，因此**不需要重写任何图像解码、EXIF 解析、RAW 处理逻辑**，
> 移植成本主要落在「取文件夹」和「打包分发」两处。
>
> 本文的每条结论都标了**验证方式**（实测 / 文档 / 推断），推断项已在实施阶段逐条核实，
> 核实结果见 `docs/test-plan.md` 与 `docs/acceptance.md`。

- 分析日期：2026-10（迁移决策时为最新）
- 被移植对象：`gkpv.html`，SHA256 `7B06F2541C30357F…`（完整值见 `docs/acceptance.md`）
- 目标：Windows 桌面独立应用（Electron 44 / Chromium 152 / Node 24）

---

## 1. 原项目技术底子

| 维度 | 事实 | 为什么重要 |
| --- | --- | --- |
| 形态 | 单文件 HTML（`<head>` 3–577 行含全部 CSS，`<script>` 635–2705 行含全部 JS） | 无构建、无依赖，移植只需搬运 |
| 依赖 | **零外部依赖**，不引 CDN、不引框架 | 可整体离线运行，桌面版天然满足 |
| 取文件 | File System Access API（`showDirectoryPicker()`） | 桌面版必须提供等价能力（第 3 节） |
| 缓存 | **OPFS**（Origin Private File System）存缩略图 | `file://` 下不可用，决定了协议方案（第 2 节） |
| 解码 | `createImageBitmap` + `OffscreenCanvas` + `convertToBlob` | 全是 Chromium 能力，Electron 直接继承 |
| 方向 | `createImageBitmap(blob, {imageOrientation:'from-image'})` + 自写 EXIF 解析 | 同上 |
| 格式 | JPEG/PNG/GIF/BMP/WebP/AVIF/SVG/ICO/TIFF/HEIC + 相机 RAW（NEF/ARW/CR2/DNG） | RAW 走「TIFF 容器读 IFD + 取内嵌 JPEG 预览」自实现 |
| UI | 自绘虚滚动网格、灯箱、排序筛选、文件夹预览卡片 | 纯 DOM/Canvas，无浏览器特性依赖 |

**关键观察**：这个项目**没有一处**用到「浏览器专有而不能在桌面出现」的能力（没有跨域请求、
没有第三方 Cookie、没有需要用户手势的权限弹窗）。相反，它缺的恰恰是桌面能给的：
稳定的本地目录访问、独立窗口、双击即用。

---

## 2. 决定性技术问题：源（origin）与 OPFS

这是整个移植中**唯一一个会让方案彻底跑不通**的问题，所以先单独说清楚。

**问题**：`file://` 是不透明源（opaque origin）。Chromium 在 `file://` 页面里对
File System Access API 与 OPFS 一律报错；而 gkpv 用 OPFS 缓存缩略图——
几千张照片的图库，有无缓存是「秒开」和「每次重新解码」的差别。
这正是原项目要配 `serve.py` 起本地 HTTP 服务的原因（`使用说明.txt` 里记录了这一点）。

**候选方案与判定**：

| 方案 | 源 | OPFS | 目录选择 | 判定 |
| --- | --- | --- | --- | --- |
| A. 直接 `loadFile(file://…)` | opaque | ❌ 不可用 | — | **否决**：等于把原项目要解决的问题带进桌面版 |
| B. 内置 HTTP 服务（127.0.0.1 随机端口） | `http://127.0.0.1:port` | ✅ | ✅ | 可用，但**多一个常驻端口**、多一层网络栈、多一处失败面（端口占用、防火墙弹窗） |
| C. **自定义标准协议 `app://gkpv`** | `app://gkpv` | ✅ | ✅ | **采用** |

**C 之所以成立**：Electron 的 `protocol.registerSchemesAsPrivileged` 可以把自定义
scheme 声明为 `standard + secure + supportFetchAPI`。这样 `app://gkpv/…` 得到的
是一个**有名字的 secure context**，与 https 页面等价，OPFS 与 File System Access
都可用；同时不占端口、不经过网络栈。

实现要点（已落地在 `desktop/main/app-protocol.cjs`）：
- `registerSchemesAsPrivileged` **必须**在 `app.whenReady()` 之前调用，否则不生效；
- handler 里做目录穿越防护（解析后的绝对路径必须仍在站点根内）；
- 站点根 = `desktop/`（`__dirname/..`），入口 `app://gkpv/renderer/index.html`。

**验证方式**：已实测——真实窗口里 `location.protocol === 'app:'`，OPFS 写入/读取成功，
`showDirectoryPicker()` 在 `app://` 源下可用（详见第 5 节与 `docs/test-plan.md`）。

---

## 3. 「取文件夹」怎么办：三条路

桌面版接管了「用户点了哪个文件夹」，所以原项目 `showDirectoryPicker()` 的角色要重新定位。

| 方案 | 做法 | 优点 | 缺点 | 判定 |
| --- | --- | --- | --- | --- |
| 1. 保留 File System Access API | 继续用 `showDirectoryPicker()` | **零改动**：渲染层拿到的还是 `FileSystemDirectoryHandle`，与网页版完全同构；权限模型由 Chromium 管 | 用户看到的是原生对话框（这正是想要的）；自动化测试点不到这个对话框 | **采用** |
| 2. 主进程扫盘 + IPC 传清单 | 主进程 `fs.readdir`，把文件列表发给渲染层 | 可测性好 | 渲染层每处 `file.arrayBuffer()` / `getFile()` 都要改成 IPC，**改动面极大**、必然引入行为差异 | 仅作为**兜底**用于测试注入与诊断页 |
| 3. 引入 Node 文件后端（全部改走 IPC） | 彻底重写数据源 | — | 违背「功能等价、只搬运」的原则，风险最高 | 否决 |

**采用 1 + 2 的组合**：
- 正常路径走方案 1（零改动，行为与网页版一致）；
- 主进程另有一套**只读**的扫盘实现（`desktop/main/scandir.cjs`），
  用途是：① 测试模式注入目录；② 启动时预取清单做快速首屏；
  ③ 与渲染层解析器做**交叉校验**（两套实现必须给同一答案，`tests/unit/fixtures.test.mjs` 在钉这件事）。

---

## 4. 逐项 API 可用性核对

| 原项目依赖的能力 | Electron 44 / Chromium 152 | 结论 |
| --- | --- | --- |
| `showDirectoryPicker()` | 支持（`app://` secure context 下实测可用） | ✅ |
| OPFS（`navigator.storage.getDirectory()`） | 支持（需非 opaque 源 → 第 2 节） | ✅ |
| `createImageBitmap` + `{imageOrientation:'from-image'}` | 支持 | ✅ |
| `OffscreenCanvas` + `convertToBlob` | 支持 | ✅ |
| `createImageBitmap(SVG Blob)` | **不支持**（抛 `InvalidStateError`） | ⚠️ 原项目已知：SVG 走 `<img>` 分支（`gkpv.html` 1140 行注释），移植时必须保留该分支 |
| 大图 `ImageDecoder` / 分块解码 | 未使用 | — |
| Web Worker | 原项目未使用（单线程） | — |
| HEIC 解码 | Chromium **不支持** HEIC | ⚠️ 原项目已按「占位 + 计数」处理，桌面版保持同一行为 |
| TIFF 解码 | `createImageBitmap` 对 TIFF 实测 5/5 失败 | ⚠️ 原项目已按「自行解析 IFD 取内嵌 JPEG」处理，桌面版复用同一代码 |

**没有一处需要 Node 能力**——这也是为什么移植可以是「搬运」而不是「重写」。

---

## 5. Electron 路径上必须处理的技术细节

1. **`ELECTRON_RUN_AS_NODE`**：若环境里该变量为 `1`，`electron.exe` 会退化成纯 Node
   进程（症状：`Cannot read properties of undefined (reading 'whenReady')`）。
   开发机与 CI 的脚本里必须显式清除。
2. **asar 打包与流式读**：打包后 `__dirname` 指向 `app.asar`，
   `fs.createReadStream` 读 asar 内文件会失败。协议 handler 采用
   「先试流、失败退整读」（`desktop/main/app-protocol.cjs`），两种情况都能工作。
3. **单实例锁**：`app.requestSingleInstanceLock()` 按 `userData` 目录判定，
   测试要并行跑就必须给每条会话独立的 `GKPV_TEST_USERDATA`，否则第二条会话直接退出。
4. **CSP**：`index.html` 用 `script-src 'self'`，因此**不能**把启动脚本内联进 HTML，
   必须是独立文件（`renderer/boot.js` 是 `type=module`，异步执行 —— 这也是为什么
   E2E 里必须等 `window.__gkpv.ready === true` 而不是 `domcontentloaded`）。
5. **图标**：electron-builder 在 `--win` 下缺 `icon.ico` 会直接失败；
   图标由 `tools/gen-icon.mjs` 用代码生成（7 档尺寸），不依赖二进制素材。
6. **代理/镜像**：首次 `npm install` 要下载 Electron 二进制（约 110 MB），
   首次打包要下载 winCodeSign/nsis 资源。国内网络下用
   `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 指向 npmmirror（`npm run pack` 支持 `GKPV_MIRROR=1`）。

---

## 6. 工作量与风险

**工作量**（实际完成情况见 `docs/test-plan.md` 阶段表）：

| 部分 | 量级 | 说明 |
| --- | --- | --- |
| Electron 骨架（主进程/预加载/协议/窗口） | 小 | 约 400 行 |
| 渲染层模块化搬运 | 中 | 2707 行单文件 → 18 个模块，**逐段搬运、不改算法** |
| 主进程只读扫盘（交叉校验/测试注入） | 中 | 约 450 行，含 TIFF/RAW 尺寸解析 |
| 测试素材生成器 | 中 | 72 个素材 + manifest（合成 + 真实编码器样本） |
| 单元测试 | 中 | 26 条，覆盖扫描/尺寸/方向/边界 |
| E2E（真实窗口） | 中 | 43 条，见 `docs/test-plan.md` 第五节的用例表（缺 `real/` 素材的环境记 42 通过 + 1 跳过、0 失败） |
| 打包与发布 | 小 | NSIS + portable + 冒烟 |

**风险清单（含应对与最终状态）**：

| 风险 | 概率 | 应对 | 最终状态 |
| --- | --- | --- | --- |
| `app://` 下 OPFS 不可用 | 低 | 降级为内置 HTTP 服务（随机端口、仅 127.0.0.1） | 未触发（实测可用） |
| 渲染层搬运引入行为差异 | 中 | 保留网页版为对照基线，两套解析器交叉校验 | 已用 26 条单测 + 43 条 E2E 钉住，并抓出 6 个真 bug |
| 合成测试素材不被解码器接受 | **高** | 改为「凡必须真解码的格式一律用真实编码器产出样本」 | 已触发并修正（详见 `docs/test-plan.md`） |
| 真实 RAW/HEIC 样片拿不到 | 中 | 用合成容器覆盖，并在测试文档里**显式标注缺口** | 部分缺口已标注 |
| Electron/打包资源下载失败 | 中 | npmmirror 镜像 | 已用镜像完成；另发现 electron 二进制是**首次 require 时才惰性下载**的（`npm ci` 不下载），已在报错与文档里给出镜像修法 |
| 无代码签名 → SmartScreen 提示 | **必然** | 在 README/验收文档里说明，不做静默处理 | 已说明（用户明确不做签名） |

---

## 7. 结论与方案选型

**可行，且推荐 Electron**：

- 零依赖、无构建、纯 Web API —— 与 Electron 的契合度是这类项目里最高的一档；
- 唯一的结构性障碍（`file://` 下无 OPFS）已有干净的解法（`app://` 标准协议）；
- 不需要 Node 文件后端，渲染层逻辑可**逐段搬运**，回归风险靠测试兜住；
- 产物是常规 Windows 安装包（NSIS）与免安装版（portable）。

**放弃的备选路线及原因**：

| 路线 | 放弃原因 |
| --- | --- |
| Tauri / WebView2 | WebView2 对 File System Access 与 OPFS 的支持弱于 Chromium，且需 Rust 工具链；项目零依赖的特性使 Electron 的体积劣势换不来复杂度优势 |
| NW.js | 生态与打包链不如 Electron 成熟，自定义协议与权限控制颗粒度更粗 |
| PWA + 本地服务（维持现状） | 这正是原方案：需要用户手动跑 `serve.py`，装不了快捷方式、没有独立窗口——用户要求的就是摆脱它 |
| 纯 `file://` 打包（无协议） | OPFS 不可用，等于废掉缩略图缓存这一核心性能设计 |

**明确的非目标（本轮不做，用户已确认）**：文件关联双击打开、右键菜单「用 gkpv 打开文件夹」、
记住上次打开的文件夹、代码签名。

---

## 8. 结论复核（交付后回看）

计划里的每一条关键假设都在交付时被实测复核过，结果如下：

| 计划中的假设 | 复核方式 | 结论 |
| --- | --- | --- |
| `app://` 标准协议下 OPFS 与 File System Access API 都可用 | 真窗口 E2E + 产物冒烟读 `cache backend` | ✔ 成立（`file://` 下不可用这一前提也已实测确认） |
| 渲染层可以「只搬运、不改算法」地模块化 | 与原 `gkpv.html` 逐段对照 + 交叉校验 | ✔ 成立；但搬运与新增的测试**抓出了 6 个真 bug**（含原版遗留的 TIFF SubIFD 尺寸解析、GIF 隔行位等） |
| 无需 Node 文件后端 | 主进程只做扫盘/协议/菜单 | ✔ 成立；渲染层仍是同一套 File System Access 代码 |
| 测试可覆盖到「功能等价」 | 26 单测 + 43 E2E + 10 项产物冒烟 | ✔ 覆盖成立；缺口已逐条列在 `docs/test-plan.md` 第八节，未谎报 |
| 打包链路可用 | NSIS 静默安装/卸载、便携版、产物冒烟 | ✔ 成立（安装 6.5s / 卸载后无残留）。**教训**：功能测试全绿不等于产物没问题——2.0.0 的 exe 里还带着 Electron 默认图标与 `ProductName=Electron`，因为 `signAndEditExecutable: false` 把签名和 rcedit 一起关掉了；加了「查图标字节 + 查版本信息」两条产物级断言才发现（2.0.1 修复） |
| 版本管理可交给 GitHub | 仓库 + 4 个阶段 tag + Release + CI | ✔ 成立（CI 在最终提交上全绿；两轮 CI 各抓出一次真问题） |
| 从零复现（换机器）可行 | 全新克隆到临时目录跑完整链路 | ✔ 成立；并抓出「electron 二进制惰性下载」这一只有从零复现才会暴露的坑 |

**总体结论**：移植可行且已完成，产物可用；主要代价不是代码改造，而是**测试与验证体系**——
正是这套体系（而不是移植本身）把 6 个原版遗留缺陷暴露了出来；而 2.0.1 那次图标/版本信息
的修正说明**产物本身也要被断言**，不能只验它在运行时能不能用。

# gkpv — gk photo viewer

轻量照片浏览器：**Windows 桌面版**（Electron）+ 零依赖单文件网页版（`gkpv.html`）。

- **桌面版**：独立应用窗口，双击即用，不需要浏览器、也不需要手动起本地服务。
- **网页版**：仓库根目录的 `gkpv.html`，一个文件搞定，用 Chromium 系浏览器打开即可。
  它同时充当桌面版的**功能对照基线**——两边的图像解码、EXIF、RAW 处理是同一套实现。

---

## 桌面版（2.x）

### 使用

1. 装 `GKP Viewer-2.0.0-setup.exe`，或直接用免安装的 `GKP Viewer-2.0.0-portable.exe`；
2. 点工具栏「打开文件夹」选一个照片目录；
3. 想连子文件夹一起看，点「递归」。

> 首次运行 Windows 会提示「未知发布者」——本项目不做代码签名，点「更多信息 → 仍要运行」即可。

### 功能

与网页版**完全一致**（见下方清单），额外多了：独立窗口、应用菜单、单实例、
以及只为自动化测试存在的目录注入接口（生产构建里被静态消除）。

### 技术要点

| 点 | 做法 | 为什么 |
| --- | --- | --- |
| 页面来源 | 自定义标准协议 `app://gkpv/…` | `file://` 是不透明源：**OPFS 缩略图缓存与 File System Access API 都用不了**。声明为 `standard + secure` 的 `app://` 等价于 https 页面，两个 API 都能用，而且不占端口。 |
| 取文件夹 | 继续用 File System Access API | 渲染层拿到的仍是 `FileSystemDirectoryHandle`，与网页版同构，改动为零 |
| 缓存 | OPFS，key 含文件大小与修改时间 | 自动失效；几千张图时有无缓存差别巨大 |
| 主进程职责 | 只做窗口/菜单/协议/只读扫盘 | 不做 Node 文件后端，避免重写数据源 |

详细论证见 [`docs/feasibility.md`](docs/feasibility.md)，阶段划分与测试覆盖见
[`docs/test-plan.md`](docs/test-plan.md)，手工验收清单见 [`docs/acceptance.md`](docs/acceptance.md)。

### 开发

```powershell
npm.cmd install          # 国内网络慢可加镜像，见 tools/pack.mjs 里的 GKPV_MIRROR
npm.cmd run fixtures     # 生成测试素材（72 个，可重复生成）
npm.cmd start            # 起开发窗口
npm.cmd run test:unit    # 单元测试（26 条）
npm.cmd run test:e2e     # 端到端（会真的开 Electron 窗口）
npm.cmd test             # 上面两项全跑
npm.cmd run pack         # 打包出 NSIS + portable
npm.cmd run smoke:pack   # 打包产物冒烟
```

> PowerShell 执行策略会拦住 `npm.ps1`，用 `npm.cmd`。

---

## 网页版（`gkpv.html`）

### 使用

用 Chromium 系浏览器（Chrome / Edge / Brave）打开 `gkpv.html`，点 **Open Folder** 选照片目录。

> `file://` 下浏览器会拒绝 OPFS 缓存（缩略图每次都要重新解码）。想拿到缓存加速，
> 用仓库里的 `serve.py` / `start-gkpv.cmd` 起一个本地服务，再从 `http://127.0.0.1:8777/gkpv.html` 打开。

> **注意**：Firefox 与 Safari 不支持 File System Access API。

---

## 功能清单（两个版本一致）

- **本地文件夹访问** — 用 File System Access API 选择任意本地目录
- **缩略图网格** — 响应式网格，三档尺寸（S / M / L）
- **对齐布局** — 网格与「对齐（按原始宽高比）」两种模式切换，后者按目标行高铺满，杂志式观感
- **虚拟滚动** — 只渲染可见行，几千张图也能低内存流畅滚动
- **智能缩略图** — 最长边 640px 缩放；缩略图随滚动按需生成
- **持久缓存** — 缩略图与宽高比缓存在 OPFS，再次打开秒出；缓存 key 含文件大小与修改时间，自动失效
- **加载占位** — 生成期间显示微光动画，完成后淡入
- **灯箱查看** — 点开看全尺寸原图，方向键翻页、`Esc` 关闭；全分辨率图按需加载
- **灯箱缩放平移** — 滚轮朝光标缩放、单击切换适应/100%、放大后拖动平移；触屏支持双指缩放与双击；`+` / `-` / `0` 快捷键
- **预加载** — 后台预载上一张/下一张，翻页即时
- **EXIF 信息面板** — 灯箱里按 **I** 查看文件详情与 JPEG EXIF（相机、镜头、曝光、ISO、焦距、拍摄时间）
- **图片信息提示** — 悬停缩略图显示文件名、尺寸、体积、日期
- **文件夹预览缩略图** — 文件夹卡片显示前四张图的 2×2 拼贴，而不是通用图标
- **目录浏览** — 面包屑导航进子目录
- **排序** — 按名称或日期，升/降序
- **缓存管理** — 工具栏「Clear Cache」强制重新生成缩略图
- **相机 RAW** — NEF / ARW / CR2 / DNG：解析 TIFF 容器取内嵌 JPEG 预览，并按容器 IFD0 的方向标记转正

## License

MIT

上游项目：[`karypis/photo-browser`](https://github.com/karypis/photo-browser)

/**
 * 所有可变状态集中在这里。
 *
 * 为什么不用散落的模块级 `let`：模块之间互相读写会让"谁改了它"变得不可追踪，
 * 也无法在测试里一次性重置。集中成对象后，测试只需 `resetState()`。
 */

/** @returns {object} 全新的初始状态对象 */
export function createState() {
  return {
    // ---- 数据源 ----
    desktop: null,          // window.gkpv（桌面壳 API）；网页版为 null
    sourceId: null,         // 主进程返回的目录句柄（`src:N`）
    sourceRoot: null,       // 仅供显示（桌面端由主进程返回；此处不用于拼路径）
    currentPath: [],        // 相对根目录的层级，如 ['2024','婚礼']
    currentImages: [],      // 灯箱导航用的条目数组
    allEntries: [],         // 当前视图的全部条目（文件夹 + 图片）

    // ---- 灯箱 ----
    lbIndex: 0,
    lbCurrentUrl: null,     // 灯箱当前显示的全尺寸 blob URL
    lbGeneration: 0,        // 与缩略图生成共享的代际计数，用于打断过期异步任务

    // ---- 缩略图 ----
    thumbGeneration: 0,
    currentThumbUrls: [],
    thumbQueue: [],
    thumbQueueIdx: 0,
    thumbWorkersRunning: 0,
    thumbDoneCount: 0,
    thumbFailedCount: 0,
    thumbFailedNames: [],

    // ---- 布局 / 虚拟滚动 ----
    layoutMode: 'justified', // 'grid' | 'justified'
    currentSizeKey: 'md',
    layoutRows: [],
    totalHeight: 0,
    renderedRange: { start: -1, end: -1 },
    rowElements: new Map(),
    $scrollContainer: null,
    $spacer: null,
    vsScrollHandler: null,
    vsResizeHandler: null,
    vsGen: 0,
    relayoutTimer: null,

    // ---- 列表元信息 ----
    currentFolderCount: 0,
    currentDirPath: '',
    recursiveMode: false,
    scanTruncated: false,
    sortMode: 'name-asc',

    // ---- 缓存 ----
    cacheDir: null,         // OPFS 里的 gkpv-thumbs 目录句柄
    memCache: new Map(),    // OPFS 不可用时的内存兜底（Map<string, Blob|ArrayBuffer>）
    exifCache: new Map(),
    folderCache: new Map(),

    // ---- 诊断 ----
    stats: { scans: 0, thumbHits: 0, thumbMisses: 0, decodeFallbacks: 0, rawPreviews: 0, errors: [] },
  };
}

/** 全局单例（渲染层使用；测试里用 createState() + resetState()）。 */
export const state = createState();

/** 原地重置，保持引用不变（模块里 `import { state }` 拿到的还是同一个对象）。 */
export function resetState() {
  Object.assign(state, createState());
}

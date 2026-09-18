/**
 * 引擎的共享常量与运行期状态 —— 唯一允许出现可变绑定的模块。
 *
 * 约定：
 *  - 只读常量（标签集合、缓存上限）直接导出；
 *  - 运行期可变状态统一挂在 {@link runtime} 上，其他模块读写都走 `runtime.xxx`；
 *    这样既绕开「ESM 不能给导入绑定赋值」的限制，也让状态变更点集中可控；
 *  - 本模块**不导入任何其他引擎模块**（叶子模块），避免模块初始化顺序问题。
 */
import type { EngineConfig, EngineRuntime, EngineState } from './types';

/** 页面主机名（保留：日志与请求体里仍会带上） */
export const hostname: string = location.hostname;
/** 仅用于保留上游数据结构（插件版没有 eid 概念） */
export const isCxa = false;

/** 路由缓存桶数量上限，超出时淘汰非当前路由 */
export const ROUTE_NODE_CACHE_LIMIT = 12;

export const SKIP_SCAN_TAGS: readonly string[] = [
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'object',
  'link',
  'img',
  'video',
  'audio',
];

/** 视为行内、可与文本混排一起翻译的标签 */
export const INLINE_TAGS: readonly string[] = [
  'span',
  'a',
  'b',
  'i',
  'em',
  'strong',
  'small',
  'label',
  'cite',
  'code',
  'mark',
  'sub',
  'sup',
  'u',
  's',
  'font',
  'time',
  'abbr',
  'del',
  'ins',
  'bdi',
  'bdo',
];

/** 块级元素：行内标签（如 a）内部若含此类元素，不得作为行内复合块整体翻译 */
export const BLOCK_TAGS: readonly string[] = [
  'div',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'form',
  'fieldset',
  'legend',
  'article',
  'section',
  'nav',
  'aside',
  'header',
  'footer',
  'main',
  'figure',
  'figcaption',
  'blockquote',
  'pre',
  'hr',
  'address',
  'details',
  'summary',
  'dialog',
];

/** 传给翻译接口前替换为占位符、回显时再还原的媒体/嵌入标签 */
export const MEDIA_FILTER_TAGS: readonly string[] = [
  'svg',
  'img',
  'picture',
  'video',
  'audio',
  'canvas',
  'iframe',
  'object',
];

/** 视口外扩缓冲（px），提前采集/翻译即将进入视口的内容 */
export const VIEWPORT_BUFFER = 300;

/** 引擎公开状态（会挂到 window.__aiTranslateEngine.state 上） */
export const state: EngineState = {
  debug: true,
  isOpen: false,
  /** 是否有翻译流式请求进行中，单用户同时仅允许 1 个 */
  isLoading: false,
  /** 当前有请求时又有新批次，结束后通过 onTranslate 串行补发 */
  translateQueuePending: false,
  retryCount: 3,
  cacheData: {},
  userInfo: {},
};

/**
 * 运行期可变状态。初始值与拆分前保持一致；
 * `lastPathname` 需要路由工具函数，改由 index.ts 在装配完成后初始化（避免模块初始化顺序问题）。
 */
export const runtime: EngineRuntime = {
  engineConfig: Object.assign(
    {
      enabled: false,
      targetLang: 'en',
      debug: true,
    } satisfies EngineConfig,
    (window as { __AI_TRANSLATE_CONFIG__?: Partial<EngineConfig> }).__AI_TRANSLATE_CONFIG__ || {},
  ),
  engineTransport:
    (window as { __AI_TRANSLATE_TRANSPORT__?: EngineRuntime['engineTransport'] }).__AI_TRANSLATE_TRANSPORT__ ?? null,

  listenDomHandler: null,
  listenTitleHandler: null,
  titleRouteTimer: null,
  abortControllerList: [],
  activeFetchGeneration: 0,
  activeFetchIndexAliases: null,
  routeScanTimer: null,
  routeNodeDataCache: {},
  nextNodeDataKey: 0,
  lastPathname: '',
  historyHooked: false,
  mutationBatch: { added: new Set(), removed: new Set(), hasChildList: false },
  applyingDomDepth: 0,
  viewportScrollHooked: false,
  deferredScanTimers: [],
  translatePipelineActive: false,
};

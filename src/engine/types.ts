/**
 * 引擎对外的类型契约。
 *
 * 与 ../lib/types 的分工：
 *  - 这里只描述「引擎 ↔ content.js」之间的接口（配置、状态、传输层、全局 API）；
 *  - ../lib/types 描述插件自身（模型配置、端口消息、Tab 消息）并从本文件转发这些类型。
 */

/** content.js 注入的运行配置（applyConfig） */
export interface EngineConfig {
  /** 是否开启翻译；目标语言为中文时引擎会走回滚流程 */
  enabled: boolean;
  /** 目标语言（'zh' 表示保持/回滚中文） */
  targetLang: string;
  /** 是否输出调试日志 */
  debug: boolean;
}

/** 引擎对外暴露的运行状态（popup 展示用） */
export interface EngineStatus {
  enabled: boolean;
  targetLang: string;
  loading: boolean;
  total: number;
  translated: number;
  route: string;
}

/** 引擎在一次批量请求里回传增量的回调 */
export interface TranslateHandlers {
  signal?: AbortSignal;
  /** 目标语言（引擎会带上，传输层可用可不用） */
  targetLang?: string;
  onChunk: (delta: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/** 传输层：由 content.js 提供，真实实现在 background 里（API Key 不进页面） */
export interface TranslateTransport {
  translate: (text: string, handlers: TranslateHandlers) => void;
}

/** 传输层返回的类 Response 对象（content 侧 engineFetchModel 组装出来的流式响应） */
export interface StreamResponse {
  status: number;
  statusText: string;
  body: {
    getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> };
  } | null;
}

/** 引擎挂到 window 上的 API（见 index.ts） */
export interface EngineApi {
  applyConfig: (config: Partial<EngineConfig>) => void;
  setTransport: (transport: TranslateTransport) => void;
  getConfig: () => EngineConfig;
  run: () => void;
  stop: () => void;
  status: () => EngineStatus;
  hasChinese: (text?: string) => boolean;
  getLanguage: () => string;
  scanPageContent: () => void;
  scanViewportContent: () => void;
  flashAllText: () => void;
  reverseChinese: () => void;
  state: EngineState;
}

/** 引擎的公开状态对象（window.__aiTranslateEngine.state） */
export interface EngineState {
  debug: boolean;
  isOpen: boolean;
  /** 是否有翻译流式请求进行中，单用户同时仅允许 1 个 */
  isLoading: boolean;
  /** 当前有请求时又有新批次，结束后通过 onTranslate 串行补发 */
  translateQueuePending: boolean;
  retryCount: number;
  cacheData: Record<string, unknown>;
  userInfo: { eid?: string };
}

/** 一轮 MutationObserver 批次收集到的节点 */
export interface MutationBatch {
  added: Set<Node>;
  removed: Set<Node>;
  hasChildList: boolean;
}

/**
 * 引擎内部的 DOM 节点。
 *
 * 引擎大量代码同时处理文本节点、普通元素、`<input>`/`<textarea>` 与自定义的 `<empty>` 占位元素，
 * 一律按 `nodeType` 在运行时自行分派（拆分前就是如此）。这里用宽松签名表达这种多态，
 * 避免在每个取值点写 `as Element` 噪音；**只用于这类混合节点参数**，
 * 明确是元素的场景仍然用 `Element`/`HTMLElement`。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DomNode = any;

/** 定时器句柄（同时兼容浏览器与 Node 类型定义） */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** 节点引用：优先 WeakRef，环境不支持时退化为直接引用 */
export interface WeakNodeRef {
  deref: () => Node | null | undefined;
}
export type NodeRef = WeakNodeRef | Node | null;

/** 请求用的占位符映射：序号 -> 原始 HTML/媒体片段 */
export type RequestMap = Record<string, string>;

/**
 * 复合块片段：一个容器按「文本 / 行内元素 / 媒体」切出来的最小单元。
 * 请求时序列化成 [index] 文本，回显时按同样的切分对回 DOM。
 */
export interface CompositeSegment {
  type: 'text' | 'inline' | 'media';
  /** type === 'text'：对应的文本节点 */
  node?: DomNode;
  /** type === 'inline'：对应的行内元素 */
  el?: DomNode;
  /** 片段内容（行内元素的 innerHTML / 文本） */
  inner?: string;
  /** 片段文本（部分路径下用 text 字段传递） */
  text?: string;
  [extra: string]: any;
}

/** 视口矩形（getBoundingClientRect 的子集） */
export interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width?: number;
  height?: number;
}

/**
 * 选择器槽位：记录节点路径与回查线索（详见 selector.ts / write.ts）。
 * 槽位上还有若干"按需挂载"的字段（source / translated / applyTarget 等），
 * 由使用处自行维护，用宽松索引签名兜住。
 */
export interface SelectorSlot {
  /** 生成的选择器（可能带 nth-of-type 之类） */
  path?: string;
  /** 结构化路径（标签/索引链），path 失效时的兜底线索 */
  structPath?: string;
  /** 在父节点中的位置 */
  childIndex?: number;
  /** 采集时的路由标识，跨路由不写回 */
  pathname?: string;
  /** 该槽位是否属于复合块 */
  composite?: boolean;
  /** 复合块内的片段序号 */
  index?: number;
  /** 节点弱引用/直接引用 */
  nodeRef?: NodeRef;
  [extra: string]: any;
}

/** 单条路由的节点数据表：文案 -> 条目 */
export type RouteNodeData = Record<string, EngineItem>;

/** 节点数据条目：一个可翻译节点/复合块在缓存里的全部信息 */
export interface EngineItem {
  key: string | number;
  chinese: string;
  nodeTranslate: string;
  pathname: string;
  fullChinese: string;
  /** 同一文案可能对应多个选择器槽位 */
  selectors: SelectorSlot[];
  /** 是否复合块（含行内元素/媒体混排） */
  composite?: boolean;
  /** 采集时的节点引用 */
  nodeRef?: unknown;
  /** 主选择器槽位 */
  selector?: SelectorSlot | null;
  nodeDataMapKey?: string;
  error?: string | null;
  loading?: boolean;
  times?: number;
  [extra: string]: any;
}

/**
 * 运行期可变状态。
 *
 * 单独抽成一个对象而不是一堆模块级 `let`：ESM 不允许给导入的绑定赋值，
 * 而引擎里大量函数跨模块读写这些状态；统一挂到 runtime 上后
 * 「谁在什么时候改了状态」在调用点一眼可见。
 */
export interface EngineRuntime {
  /** 当前生效的引擎配置 */
  engineConfig: EngineConfig;
  /** content.js 注入的传输层 */
  engineTransport: TranslateTransport | null;
  /** MutationObserver 实例，非中文时监听 DOM 变化 */
  listenDomHandler: MutationObserver | null;
  /** 监听 document.head 内 title 文案变化 */
  listenTitleHandler: MutationObserver | null;
  /** 路由切换后延迟补扫标题的定时器 */
  titleRouteTimer: TimerHandle | null;
  /** 进行中的请求控制器，切页/重跑 run 时统一 abort */
  abortControllerList: (AbortController | null)[];
  /** 翻译请求代次：切页 abort 后递增，流式回调比对代次避免写回旧页 */
  activeFetchGeneration: number;
  /** 当前批次请求：代表 index -> 同文案的全部 item.key（去重请求、批量回显） */
  activeFetchIndexAliases: Record<string, string> | null;
  /** 路由切换后延迟扫描正文的定时器（等新页 DOM 挂载后再扫） */
  routeScanTimer: TimerHandle | null;
  /** 按路由分桶的译文缓存：routeKey -> { 中文: item } */
  routeNodeDataCache: Record<string, RouteNodeData>;
  /** nodeDataMap 条目全局自增 key，跨路由唯一 */
  nextNodeDataKey: number;
  /** 上次路由标识（pathname+search+hash），用于 SPA 切页检测 */
  lastPathname: string;
  /** 是否已劫持 history.pushState/replaceState */
  historyHooked: boolean;
  /** 本轮 Mutation 批次待扫描的新增/移除节点 */
  mutationBatch: MutationBatch;
  /** 引擎自身写 DOM 时置位，避免 MutationObserver 反馈死循环 */
  applyingDomDepth: number;
  /** 是否已注册 scroll/resize 监听（按需翻译） */
  viewportScrollHooked: boolean;
  /** 首屏/刷新后延迟补扫定时器 */
  deferredScanTimers: TimerHandle[];
  /** run 已成功启动翻译流水线（监听、扫描） */
  translatePipelineActive: boolean;
}

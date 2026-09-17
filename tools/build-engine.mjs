/**
 * 从上游页面翻译引擎生成浏览器插件版引擎（src/engine/ai-translate-engine.js）。
 *
 *   node tools/build-engine.mjs <上游引擎文件路径>
 *   UPSTREAM_ENGINE=<路径> node tools/build-engine.mjs
 *
 * 说明：
 * - 生成物已提交进仓库，**普通使用者不需要跑这个脚本**（`pnpm build` 直接用它）；
 *   只有需要同步上游修复时才需要提供上游文件。
 * - 脚本只做"剥离站点耦合 + 换成插件传输层"的定点改写：DOM 扫描 / 复合块分段回写 /
 *   缓存 / 回显 / 回滚逻辑全部保留，因此上游每次修 bug 重跑即可同步。
 * - 每处改写都有锚点断言：上游结构变化会直接报错，而不是静默生成坏文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const upstreamPath = process.argv[2] || process.env.UPSTREAM_ENGINE || '';
const outPath = path.join(ROOT, 'src/engine/ai-translate-engine.js');

if (!upstreamPath) {
  console.error(
    [
      '[build-engine] 未指定上游引擎文件。',
      '',
      '生成物 src/engine/ai-translate-engine.js 已提交进仓库，日常构建无需重新生成；',
      '只有在同步上游引擎修复时才需要：',
      '',
      '  node tools/build-engine.mjs /path/to/ai-plugins-translation.static.js',
      '  UPSTREAM_ENGINE=/path/to/ai-plugins-translation.static.js node tools/build-engine.mjs',
    ].join('\n'),
  );
  process.exit(1);
}
if (!fs.existsSync(upstreamPath)) {
  console.error(`[build-engine] 上游文件不存在：${upstreamPath}`);
  process.exit(1);
}

let src = fs.readFileSync(upstreamPath, 'utf8').replace(/\r\n/g, '\n');
const applied = [];

/** 定点替换：anchor 找不到就报错，避免上游改动后静默生成错文件 */
function replaceOnce(tag, anchor, replacement) {
  const idx = src.indexOf(anchor);
  if (idx === -1) {
    throw new Error(`[build-engine] 锚点未找到：${tag}\n---\n${anchor.slice(0, 200)}\n---`);
  }
  if (src.indexOf(anchor, idx + 1) !== -1) {
    throw new Error(`[build-engine] 锚点不唯一：${tag}`);
  }
  src = src.slice(0, idx) + replacement + src.slice(idx + anchor.length);
  applied.push(tag);
}

/** 删除 [from, to) 区间（to 为结束锚点，保留 to 本身） */
function cutBetween(tag, from, to, replacement = '') {
  const a = src.indexOf(from);
  if (a === -1) throw new Error(`[build-engine] 起点未找到：${tag}`);
  const b = src.indexOf(to, a);
  if (b === -1) throw new Error(`[build-engine] 终点未找到：${tag}`);
  src = src.slice(0, a) + replacement + src.slice(b);
  applied.push(tag);
}

// ---------------------------------------------------------------------------
// 1) 头部：去掉 hostname/cookie 探测，改成插件配置 + 传输层
//    注意分两段切：中间的 SKIP_SCAN_TAGS / state 等通用常量必须保留
// ---------------------------------------------------------------------------
cutBetween(
  'header-env',
  "  const hostname = location.hostname\n  const isLocal = /^(localhost|192.168|127\\.0|0\\.0)/.test(hostname)",
  "  /** MutationObserver 实例，非中文时监听 DOM 变化 */",
  `  const hostname = location.hostname
  const isLocal = false
  const isDev = false
  /** 仅用于保留上游数据结构（插件版没有 eid 概念） */
  const isCxa = false

  let engineConfig = Object.assign({
    enabled: false,
    targetLang: 'en',
    debug: true
  }, window.__AI_TRANSLATE_CONFIG__ || {})
  let engineTransport = window.__AI_TRANSLATE_TRANSPORT__ || null

  /** 模型直连：不再有服务端接口地址 */
  const TRANSLATE_API = { path: 'model://direct' }

`
);

// 1b) 去掉站点接口探测相关的一整段（getAppCode / getWhaleHostInfo / getApiUrl / 提前 return）
//     这段代码上方在上游里带着几行「内部域名」注释，生成物里不需要，一并去掉；
//     锚点本身用通用代码，不在本仓库里内嵌任何内部域名。
const beforeDomainCommentStrip = src;
src = src.replace(/^ {2}\/\/ [^\n]*(?:\.com|\.cn|https?:\/\/)[^\n]*\n/gm, '');
if (src === beforeDomainCommentStrip) {
  throw new Error('[build-engine] 未找到带域名的注释行（上游结构可能已变化）');
}
applied.push('strip-domain-comments');

cutBetween(
  'drop-site-api',
  '  function getAppCode(host) {',
  '  function logger(...msg) {'
);

// ---------------------------------------------------------------------------
// 2) 语言 / 开关来源：配置而不是 cookie
// ---------------------------------------------------------------------------
replaceOnce(
  'getLanguage',
  `  function getLanguage() {
    return getCookie(cookie_name) || 'zh'
  }`,
  `  function getLanguage() {
    // 插件版：关闭翻译等价于"切回中文"，引擎会走回滚流程
    if (!engineConfig || !engineConfig.enabled) {
      return 'zh'
    }
    return engineConfig.targetLang || 'en'
  }`
);

cutBetween(
  'isOpenTranslate',
  '  function isOpenTranslate() {',
  '  function hasChinese(str) {',
  `  /** 当前页面是否开启翻译（插件版完全由配置决定） */
  function isOpenTranslate() {
    return !!(engineConfig && engineConfig.enabled)
  }

`
);

// ---------------------------------------------------------------------------
// 3) 流式解析：传输层给的是模型纯文本，不需要剥离 SSE 的 "data:" 前缀
// ---------------------------------------------------------------------------
replaceOnce(
  'strip-sse-data',
  "        let buf = streamBuf.replace(/\\n{0,2}(event:translation\\n)?data:/g, '') || ''",
  "        // 插件版：transport 给的就是模型纯文本，无需剥离 SSE 前缀\n        let buf = streamBuf || ''"
);

// ---------------------------------------------------------------------------
// 4) 请求：fetch(接口) -> 模型传输层（保持 Response 形状，后续逻辑零改动）
// ---------------------------------------------------------------------------
replaceOnce(
  'model-fetch-call',
  `    fetch(TRANSLATE_API.path, {
      method: 'POST',
      signal: abortController.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(isCxa || state.userInfo.eid ? {Authorization: 'Bearer ' + state.userInfo.access_token} : {sid: 'no-sid'})
      },
      body: JSON.stringify(data)
    }).then(res => {`,
  `    engineFetchModel(data, abortController.signal).then(res => {`
);

// 插入 engineFetchModel（放在 onFetch 之前）
replaceOnce(
  'engine-fetch-model',
  '  /** 批量请求翻译接口；单用户串行，进行中则标记排队而非并发 fetch */',
  `  /**
   * 把模型直连包装成 fetch(Response) 形状：onStreamData 仍然按"读 reader"的方式消费，
   * 于是流式解析、代次校验、abort 处理、错误处理逻辑全部复用上游实现。
   */
  function engineFetchModel(data, signal) {
    if (!engineTransport || typeof engineTransport.translate !== 'function') {
      return Promise.reject(new Error('翻译引擎未连接（transport 缺失）'))
    }
    const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null
    let closed = false
    const stream = new ReadableStream({
      start(controller) {
        const safeEnqueue = function (chunk) {
          if (closed || !chunk) return
          try {
            controller.enqueue(encoder ? encoder.encode(String(chunk)) : String(chunk))
          } catch (e) { /* 流已不可写 */ }
        }
        const safeClose = function () {
          if (closed) return
          closed = true
          try { controller.close() } catch (e) { /* ignore */ }
        }
        const safeError = function (message) {
          if (closed) return
          closed = true
          const err = new Error(message || 'model error')
          err.name = (message === 'aborted' || message === 'AbortError') ? 'AbortError' : 'Error'
          try { controller.error(err) } catch (e) { /* ignore */ }
        }
        engineTransport.translate(String(data.text || ''), {
          signal: signal,
          targetLang: data.targetLang,
          onChunk: safeEnqueue,
          onDone: safeClose,
          onError: safeError
        })
      },
      cancel() {
        closed = true
      }
    })
    return Promise.resolve({status: 200, statusText: 'OK', body: stream})
  }

  /** 批量请求翻译接口；单用户串行，进行中则标记排队而非并发 fetch */`
);

// ---------------------------------------------------------------------------
// 5) 加载提示：不借用宿主页面的 FloatBubble
// ---------------------------------------------------------------------------
replaceOnce(
  'showLoading-floatbubble',
  '    const fb = window.FloatBubble',
  '    const fb = null'
);

// ---------------------------------------------------------------------------
// 6b) run()：插件版"关闭开关"等价于切回中文，必须在开关判断前走回滚分支
// ---------------------------------------------------------------------------
replaceOnce(
  'run-zh-first',
  `  function run() {
    const lang = getLanguage()
    clearListener()
    if (!isOpenTranslate()) {
      translatePipelineActive = false
      return
    }
    translatePipelineActive = true
    if (lang === 'zh') {
      showLoading(false)
      reverseChinese()
      clearListener()
      // 中文模式下保留滚动监听，虚拟列表上划时恢复回收 DOM 中的残留英文
      hookViewportScroll()
    } else {
      hookHistory()
      lastPathname = getRouteKey()
      // 新一轮翻译：清掉上一轮因失败/中断留下的 error 与尝试次数，否则条目会被永久跳过
      resetRouteRetryFlags()
      listenDomChnage()
      listenTitleChange()
      hookViewportScroll()
      scanPageContent()
      scheduleDeferredContentScan()
    }
  }`,
  `  function run() {
    const lang = getLanguage()
    clearListener()
    // 插件版：目标语言是中文（包括"关闭翻译开关"）时必须走回滚流程，
    // 不能在下面的开关判断处提前 return，否则关闭开关后页面会停在英文。
    if (lang === 'zh') {
      translatePipelineActive = false
      showLoading(false)
      reverseChinese()
      clearListener()
      // 中文模式下保留滚动监听，虚拟列表上划时恢复回收 DOM 中的残留英文
      hookViewportScroll()
      return
    }
    if (!isOpenTranslate()) {
      translatePipelineActive = false
      return
    }
    translatePipelineActive = true
    hookHistory()
    lastPathname = getRouteKey()
    // 新一轮翻译：清掉上一轮因失败/中断留下的 error 与尝试次数，否则条目会被永久跳过
    resetRouteRetryFlags()
    listenDomChnage()
    listenTitleChange()
    hookViewportScroll()
    scanPageContent()
    scheduleDeferredContentScan()
  }`
);

// ---------------------------------------------------------------------------
// 6c) 去掉站点启动逻辑（pageshow/DOMContentLoaded/轮询/FloatBubble 按钮），改为暴露引擎 API
// ---------------------------------------------------------------------------
cutBetween(
  'bootstrap',
  '  let isInitButton = false\n  let timerTime = 0',
  '  /** 供业务在接口渲染完成后手动触发：aiTranslateHandler.scanPageContent() */',
  `  /** 供插件 content.js 调用：注入/更新配置 */
  function applyEngineConfig(next) {
    engineConfig = Object.assign({}, engineConfig, next || {})
  }

  /** 供插件 content.js 调用：注入模型传输层 */
  function setEngineTransport(transport) {
    engineTransport = transport
  }

  /** 停止翻译并断开监听（关闭开关时调用） */
  function stopTranslation() {
    clearListener()
    if (listenDomHandler) {
      listenDomHandler.disconnect()
      listenDomHandler = null
    }
    resetMutationBatch()
    translatePipelineActive = false
  }

  /** 当前状态（popup 展示用） */
  function getEngineStatus() {
    let total = 0
    let translated = 0
    const map = getNodeDataMap()
    for (let k in map) {
      const item = map[k]
      if (item.pathname !== getRouteKey()) {
        continue
      }
      total++
      if (item.nodeTranslate) {
        translated++
      }
    }
    return {
      enabled: !!(engineConfig && engineConfig.enabled),
      targetLang: getLanguage(),
      loading: !!state.isLoading,
      total: total,
      translated: translated,
      route: getRouteKey()
    }
  }

`
);

replaceOnce(
  'drop-initButton-key',
  '    initButton,\n',
  ''
);

// 暴露引擎 API（插到 IIFE 结尾之前）
const apiBlock = `  /** 插件版：启动/停止完全由 content.js 控制，不在页面加载时自动跑 */
  window.__aiTranslateEngine = {
    applyConfig: applyEngineConfig,
    setTransport: setEngineTransport,
    getConfig: function () { return engineConfig },
    run: run,
    stop: stopTranslation,
    status: getEngineStatus,
    hasChinese: hasChinese,
    getLanguage: getLanguage,
    scanPageContent: scanPageContent,
    scanViewportContent: scanViewportContent,
    flashAllText: flashAllText,
    reverseChinese: reverseChinese,
    state: state
  }

`;

const trimmed = src.trimEnd();
if (!trimmed.endsWith('})();')) {
  throw new Error('[build-engine] 文件结尾不是 })(); ，无法挂载引擎 API');
}
src = trimmed.slice(0, -'})();'.length) + apiBlock + '})();\n';
applied.push('expose-api');

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const banner = `/**
 * 自动生成，请勿直接编辑：改动请修改 tools/build-engine.mjs 或上游插件后重新生成。
 *   source : ${path.basename(upstreamPath)}
 *   date   : ${new Date().toISOString()}
 */
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, banner + src, 'utf8');
console.log('[build-engine] 已生成 ' + path.relative(ROOT, outPath));
console.log('[build-engine] 应用改写：\n  - ' + applied.join('\n  - '));
console.log('[build-engine] 行数：' + (banner + src).split('\n').length);

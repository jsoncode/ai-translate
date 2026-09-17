/**
 * 自动生成，请勿直接编辑：改动请修改 tools/build-engine.mjs 或上游插件后重新生成。
 *   source : ai-plugins-translation.static.js
 *   date   : 2026-09-17T09:59:22.356Z
 */
/**
 * AI 页面翻译插件：识别页面中文并调用 AI 进行翻译
 *
 * 主流程：run -> scanPageContent(findText/findInput -> flashAllText -> onTranslate -> onFetch)
 * 动态内容：MutationObserver + WeakRef/nodeRef 回写；按原文匹配 applyCachedTranslationsInRoot（弹框）；监听 class/style 显隐并同步回写译文，避免 antd 弹框关闭时 React 还原中文闪屏
 * 按需翻译：滚动、resize 或 visualViewport 变化时补扫可视区；块级容器任一露头即纳入其内全部文案
 * 动态倒计时：同 DOM 位置仅数字变化时本地替换译文、不重复请求；业务可用 data-translate-skip 跳过纯数字节点
 * 行内复合块：容器内存在直接文本且与 span/a 等行内元素混排时整段 innerHTML 一次翻译；仅含多个行内子元素、无直接文本时各自独立翻译；图标/empty 占位 + 单段文案时只译文案、请求不发占位标签；svg/img 以自闭合 <empty index="n"/> 占位，回显保留 DOM 原媒体
 * 请求去重：同批次相同请求文案只发一条 [index]，接口返回后按 index 别名批量回显到全部匹配条目
 * 数据：routeNodeDataCache[getRouteKey()] 分桶（含 hash 路由 #/path）；selectors 记录 path/structPath+childIndex+pathname+nodeRef
 * 回显边界（重要）：译文只允许写回「当前文案与条目原文完全一致」的节点（或已持有本条目标文的节点）。
 *   严禁子串/包含式模糊匹配：否则「疫苗」这类短文案条目会把「HPV疫苗」「肺炎疫苗」等兄弟节点全部改写成同一条译文，
 *   且这些节点此后不再含中文、不会被重新登记，错误文案会永久保留（隐藏渲染/重新进入弹框时最容易触发）。
 *
 * @file ai-plugins-translation.static.js
 */

// let msg = [
//   {
//     role: 'assistant',
//     content: '你是一位专业的翻译人员，精通中英文，请帮助客户完成专业的翻译任务。下面是一个c端网页应用的内容，请逐行翻译以下内容，要保持良好的亲和度，翻译结果保持原有的内容格式，如果遇到html，也请保留html标签，保留每一行的开头索引 "[number]",例如 "[0] 中文内容"，翻译结果为 "[0] translated content"，严禁输出其他任何内容。'
//   }, {
//     role: 'user',
//     content: ''
//   }]

(function () {
  'use strict';
  const hostname = location.hostname
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

  /** MutationObserver 实例，非中文时监听 DOM 变化 */
  let listenDomHandler = null
  /** 监听 document.head 内 title 文案变化 */
  let listenTitleHandler = null
  /** 路由切换后延迟补扫标题的定时器 */
  let titleRouteTimer = null
  /** 进行中的 fetch 控制器，切页/重跑 run 时统一 abort */
  let abortControllerList = []
  /** 翻译请求代次：切页 abort 后递增，流式回调比对代次避免写回旧页 */
  let activeFetchGeneration = 0
  /** 当前批次请求：代表 index -> 同文案的全部 item.key（去重请求、批量回显） */
  let activeFetchIndexAliases = null
  /** 路由切换后延迟扫描正文的定时器（等新页 DOM 挂载后再扫，避免在旧页上回滚/误采集） */
  let routeScanTimer = null
  /** 按路由分桶的译文缓存：routeKey -> { 中文: item } */
  let routeNodeDataCache = {}
  /** nodeDataMap 条目全局自增 key，跨路由唯一 */
  let nextNodeDataKey = 0
  /** 路由缓存桶数量上限，超出时淘汰非当前路由 */
  const ROUTE_NODE_CACHE_LIMIT = 12
  /** 上次路由标识（pathname+search+hash），用于 SPA 切页检测 */
  let lastPathname = getRouteKey()
  /** 是否已劫持 history.pushState/replaceState */
  let historyHooked = false
  /** 本轮 Mutation 批次待扫描的新增节点（去重后 flush） */
  let mutationBatch = {added: new Set(), removed: new Set(), hasChildList: false}
  /** 插件自身写 DOM 时置位，避免 MutationObserver 反馈死循环 */
  let applyingDomDepth = 0
  /** 是否已注册 scroll/resize 监听（按需翻译） */
  let viewportScrollHooked = false
  /** 首屏/刷新后延迟补扫定时器（移动端布局与配置就绪晚于 pageshow） */
  let deferredScanTimers = []
  /** run 已成功启动翻译流水线（监听、扫描）；配置晚就绪时需补跑 run */
  let translatePipelineActive = false

  const SKIP_SCAN_TAGS = ['script', 'style', 'noscript', 'svg', 'iframe', 'object', 'link', 'img', 'video', 'audio']
  /** 视为行内、可与文本混排一起翻译的标签 */
  const INLINE_TAGS = ['span', 'a', 'b', 'i', 'em', 'strong', 'small', 'label', 'cite', 'code', 'mark', 'sub', 'sup', 'u', 's', 'font', 'time', 'abbr', 'del', 'ins', 'bdi', 'bdo']
  /** 块级元素：行内标签（如 a）内部若含此类元素，不得作为行内复合块整体翻译 */
  const BLOCK_TAGS = ['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'form', 'fieldset', 'legend', 'article', 'section', 'nav', 'aside', 'header', 'footer', 'main', 'figure', 'figcaption', 'blockquote', 'pre', 'hr', 'address', 'details', 'summary', 'dialog']
  /** 传给翻译接口前替换为占位符、回显时再还原的媒体/嵌入标签 */
  const MEDIA_FILTER_TAGS = ['svg', 'img', 'picture', 'video', 'audio', 'canvas', 'iframe', 'object']
  /** 视口外扩缓冲（px），提前采集/翻译即将进入视口的内容 */
  const VIEWPORT_BUFFER = 300

  const state = {
    debug: true,
    isOpen: false,
    /** 是否有翻译流式请求进行中，单用户同时仅允许 1 个 */
    isLoading: false,
    /** 当前有请求时又有新批次，结束后通过 onTranslate 串行补发 */
    translateQueuePending: false,
    retryCount: 3,
    cacheData: {},
    userInfo: {}
  }

  function logger(...msg) {
    if (!state.debug) {
      return
    }
    console.log('\n---------- AI Translate logger ----------\n');
    console.log(...msg);
  }

  function getBodyMaxWidth() {
    const html = document.documentElement
    let val = html.style.getPropertyValue('--bodyMaxWidth').trim()
    if (!val) {
      val = getComputedStyle(html).getPropertyValue('--bodyMaxWidth').trim()
    }
    if (!val) return null
    const match = val.match(/^([\d.]+)px$/i)
    return match ? parseFloat(match[1]) : null
  }

  function pxToRem(px, bodyMaxWidth) {
    const rem = px / (bodyMaxWidth / 7.5)
    return String(parseFloat(rem.toFixed(4))) + 'rem'
  }

  function getLoadingTipStyle() {
    const bodyMaxWidth = getBodyMaxWidth()
    if (!bodyMaxWidth) {
      return '.ai-translation-loading-tip{display:none;position:fixed;top:0.88rem;z-index:1000000;left: 0;text-align: center;width: 100%;justify-content: center;}.ai-translation-loading-content{max-width:90%;margin:0 auto;font-size:0.25rem;padding:10px;backdrop-filter:blur(6px);background:rgba(0,0,0,0.5);color:#fff;border-radius:6px;}'
    }
    const top = pxToRem(60, bodyMaxWidth)
    const fontSize = pxToRem(20, bodyMaxWidth)
    const paddingH = pxToRem(10, bodyMaxWidth)
    const borderRadius = pxToRem(8, bodyMaxWidth)
    return '.ai-translation-loading-tip{display:none;position:fixed;top:' + top + ';z-index:1000000;left:var((100% - var(--bodyMaxWidth, 100%)) / 2);text-align: center; var(--bodyMaxWidth, 100%);justify-content: center;}.ai-translation-loading-content{max-width:90%;margin:0 auto;font-size:' + fontSize + ';padding:' + paddingH + ';backdrop-filter:blur(6px);background:rgba(0,0,0,0.5);color:#fff;border-radius:' + borderRadius + ';}'
  }

  function showLoading(show = true) {
    state.isLoading = show;
    const fb = null
    if (fb && typeof fb.loading === 'function') {
      if (show) {
        fb.loading('lang')
      } else if (typeof fb.closeLoading === 'function') {
        fb.closeLoading('lang')
      }
      return
    }
    const id = '.ai-translation-loading-tip'
    let tip = document.querySelector(id);
    if (!tip) {
      const LOADING_TIP_HTML = '<div class="ai-translation-loading-tip"><div class="ai-translation-loading-content">This content is translated by AI. For any questions, please contact customer service.</div></div>' + '<style>' + getLoadingTipStyle() + '</style>';
      document.body.insertAdjacentHTML('beforeend', LOADING_TIP_HTML);
      tip = document.querySelector(id);
    }
    tip.style.display = show ? 'block' : 'none'
  }

  /**
   * 当前 URL 是否在后台「AI 翻译」开关允许的应用范围内
   * 依据 sessionStorage.customerConfig.aiTranslate 与 PATH_CODE_MAP 拼正则匹配
   */
  /** 当前页面是否开启翻译（插件版完全由配置决定） */
  function isOpenTranslate() {
    return !!(engineConfig && engineConfig.enabled)
  }

  function hasChinese(str) {
    return /[\u4e00-\u9fa5]/.test(str || '');
  }

  /** 祖先带 data-translate-skip / data-ai-translate-skip 时跳过采集（用于倒计时数字等） */
  function hasTranslateSkipAncestor(node) {
    let el = node
    if (el && el.nodeType === Node.TEXT_NODE) {
      el = el.parentElement
    }
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      if (el.dataset && (el.dataset.translateSkip !== undefined || el.dataset.aiTranslateSkip !== undefined)) {
        return true
      }
      el = el.parentElement
    }
    return false
  }

  function isInlineTagName(tag) {
    return INLINE_TAGS.indexOf((tag || '').toLowerCase()) !== -1
  }

  function isBlockTagName(tag) {
    return BLOCK_TAGS.indexOf((tag || '').toLowerCase()) !== -1
  }

  /** 子树中是否含块级元素（a/span 等行内标签内嵌 div 时须拆段翻译） */
  function hasBlockElementInSubtree(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      return false
    }
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i]
      if (child.nodeType !== Node.ELEMENT_NODE) {
        continue
      }
      const childTag = child.tagName.toLowerCase()
      if (SKIP_SCAN_TAGS.indexOf(childTag) !== -1) {
        continue
      }
      if (isBlockTagName(childTag)) {
        return true
      }
      if (hasBlockElementInSubtree(child)) {
        return true
      }
    }
    return false
  }

  function isMediaFilterTag(tag) {
    return MEDIA_FILTER_TAGS.indexOf((tag || '').toLowerCase()) !== -1
  }

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function buildMediaPlaceholder(key) {
    return '<empty index="' + key + '"/>'
  }

  const EMPTY_PLACEHOLDER_RE = /<empty\s+index\s*=\s*["']?\d+["']?\s*(?:\/>|>[\s\S]*?<\/empty>)/gi

  function isEmptyPlaceholderHtml(str) {
    return isMediaPlaceholderText(str)
  }

  /** 去掉请求串首尾仅作占位的 empty，避免 svg+文案+svg 整段发给接口 */
  function trimEdgeEmptyPlaceholders(html) {
    if (!html) {
      return ''
    }
    let work = html
    work = work.replace(/^(\s*<empty\s+index\s*=\s*["']?\d+["']?\s*\/?>\s*)+/gi, '')
    work = work.replace(/(\s*<empty\s+index\s*=\s*["']?\d+["']?\s*\/?>\s*)+$/gi, '')
    return work
  }

  /** 将译文/HTML 中成对 empty 规范为自闭合，便于剥离 */
  function normalizeEmptyPlaceholdersInHtml(html) {
    if (!html) {
      return ''
    }
    return String(html).replace(/<empty\s+index\s*=\s*["']?(\d+)["']?\s*>\s*<\/empty>/gi, function (_m, idx) {
      return buildMediaPlaceholder(idx)
    })
  }

  function getElementOpenTag(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      return ''
    }
    const html = el.outerHTML || ''
    const m = html.match(/^<[^>]+\/>|^<[^>]+>/)
    return m ? m[0] : '<' + el.tagName.toLowerCase() + '>'
  }

  /** 按 DOM 子节点顺序序列化请求 HTML，媒体替换为自闭合 empty */
  function serializeChildNodesForRequest(parentEl, map, idxRef) {
    if (!parentEl) {
      return ''
    }
    let html = ''
    for (let i = 0; i < parentEl.childNodes.length; i++) {
      const child = parentEl.childNodes[i]
      if (child.nodeType === Node.TEXT_NODE) {
        html += child.nodeValue || ''
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) {
        continue
      }
      const tag = child.tagName.toLowerCase()
      if (isMediaFilterTag(tag)) {
        const key = String(idxRef.value++)
        map[key] = getMediaOuterHtml(child)
        html += buildMediaPlaceholder(key)
        continue
      }
      if (isInlineTagName(tag)) {
        html += serializeInlineElementForRequest(child, map, idxRef)
      }
    }
    return html
  }

  function serializeInlineElementForRequest(el, map, idxRef) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      return ''
    }
    if (!inlineElementHasMedia(el)) {
      return el.outerHTML || ''
    }
    const tag = el.tagName.toLowerCase()
    const openTag = getElementOpenTag(el)
    const inner = serializeChildNodesForRequest(el, map, idxRef)
    if (openTag.endsWith('/>')) {
      return openTag
    }
    return openTag + inner + '</' + tag + '>'
  }

  /** 媒体/empty 占位与单段中文混排时，请求只发纯文本（如图标 span + 文案 span） */
  function refineCompositeRequestText(html, el) {
    let work = trimEdgeEmptyPlaceholders(html)
    if (!el) {
      return work
    }
    const chineseTexts = collectCompositeChineseTexts(el)
    if (chineseTexts.length === 1) {
      return chineseTexts[0]
    }
    const segments = serializeCompositeStructure(el)
    const translatable = segments.filter(function (s) { return s.type === 'text' || s.type === 'inline' })
    const hasDirectText = segments.some(function (s) {
      return s.type === 'text' && (s.node.nodeValue || '').trim()
    })
    if (translatable.length !== 1 || hasDirectText) {
      return work
    }
    const sole = translatable[0]
    if (sole.type === 'inline' && sole.el && !inlineElementHasMedia(sole.el) && !sole.el.children.length) {
      const text = (sole.el.textContent || '').trim()
      if (text && hasChinese(text)) {
        return text
      }
    }
    if (sole.type === 'text' && sole.node) {
      const text = (sole.node.nodeValue || '').trim()
      if (text && hasChinese(text)) {
        return text
      }
    }
    return work
  }

  function isMediaPlaceholderElement(el) {
    return !!(el && el.nodeType === Node.ELEMENT_NODE &&
        el.tagName.toLowerCase() === 'empty' &&
        el.hasAttribute('index'))
  }

  function isMediaPlaceholderText(val) {
    const t = String(val || '').trim()
    if (/^\{\{ai-tr-media:\d+\}\}$/.test(t)) {
      return true
    }
    return /^<empty\s+index\s*=\s*["']?\d+["']?\s*(?:\/>|>[\s\S]*<\/empty>)$/i.test(t)
  }

  function containsMediaInSubtree(el) {
    if (!el || !el.querySelector) {
      return false
    }
    for (let i = 0; i < MEDIA_FILTER_TAGS.length; i++) {
      if (el.querySelector(MEDIA_FILTER_TAGS[i])) {
        return true
      }
    }
    return false
  }

  function normalizeMediaHtml(html) {
    if (!html || html.indexOf('&lt;') === -1) {
      return html || ''
    }
    const ta = document.createElement('textarea')
    ta.innerHTML = html
    return ta.value
  }

  function getMediaOuterHtml(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return ''
    }
    const tag = node.tagName.toLowerCase()
    if (tag === 'svg' && typeof XMLSerializer !== 'undefined') {
      try {
        return normalizeMediaHtml(new XMLSerializer().serializeToString(node))
      } catch (e) {
        // fall through
      }
    }
    return normalizeMediaHtml(node.outerHTML || '')
  }

  /** 从 HTML 字符串中按标签平衡匹配并替换（避免 DOMParser 把 svg 转成 &lt;svg&gt;） */
  function replaceMediaTagsInHtml(html, tagName, onMatch) {
    if (!html) {
      return html
    }
    const tag = tagName.toLowerCase()
    if (tag === 'img') {
      return html.replace(/<img\b[^>]*\/?>/gi, function (matched) {
        return onMatch(matched)
      })
    }
    let result = ''
    let pos = 0
    const openRe = new RegExp('<' + tag + '(\\s[^>]*)?>', 'gi')
    while (pos < html.length) {
      openRe.lastIndex = pos
      const m = openRe.exec(html)
      if (!m) {
        result += html.slice(pos)
        break
      }
      result += html.slice(pos, m.index)
      const openStart = m.index
      const openEnd = m.index + m[0].length
      if (/\/>\s*$/.test(m[0])) {
        result += onMatch(html.slice(openStart, openEnd))
        pos = openEnd
        continue
      }
      let depth = 1
      let scan = openEnd
      let closeEnd = -1
      while (depth > 0 && scan < html.length) {
        const slice = html.slice(scan)
        const openMatch = slice.match(new RegExp('<' + tag + '(\\s[^>]*)?>', 'i'))
        const closeMatch = slice.match(new RegExp('</' + tag + '\\s*>', 'i'))
        if (!closeMatch) {
          break
        }
        const closeIdx = scan + closeMatch.index
        const openIdx = openMatch ? scan + openMatch.index : -1
        if (openMatch && openIdx < closeIdx) {
          depth++
          scan = openIdx + openMatch[0].length
        } else {
          depth--
          closeEnd = closeIdx + closeMatch[0].length
          scan = closeEnd
        }
      }
      if (closeEnd === -1) {
        result += html.slice(openStart, openEnd)
        pos = openEnd
      } else {
        result += onMatch(html.slice(openStart, closeEnd))
        pos = closeEnd
      }
    }
    return result
  }

  /** 从 live DOM 序列化媒体 map，empty 统一为自闭合标签 */
  function stripMediaFromCompositeElement(el) {
    if (!el) {
      return {html: '', map: {}}
    }
    const map = {}
    const idxRef = {value: 0}
    const html = serializeChildNodesForRequest(el, map, idxRef)
    return {html: refineCompositeRequestText(html, el), map: map}
  }

  /** 将 html 中的 svg/img 等替换为占位符，避免整段发给翻译接口 */
  function stripMediaFromCompositeHtml(html) {
    if (!html || html.indexOf('<') === -1) {
      return {html: html || '', map: {}}
    }
    const map = {}
    let idx = 0
    let result = normalizeEmptyPlaceholdersInHtml(html)
    for (let mi = 0; mi < MEDIA_FILTER_TAGS.length; mi++) {
      const tag = MEDIA_FILTER_TAGS[mi]
      result = replaceMediaTagsInHtml(result, tag, function (matched) {
        const key = String(idx++)
        map[key] = normalizeMediaHtml(matched)
        return buildMediaPlaceholder(key)
      })
    }
    result = trimEdgeEmptyPlaceholders(result)
    const plain = extractPlainRequestFromCompositeHtml(result)
    if (plain) {
      result = plain
    }
    return {html: result, map: map}
  }

  /** 从已剥离媒体的 composite HTML 中提取唯一中文纯文本（无 live DOM 时） */
  function extractPlainRequestFromCompositeHtml(html) {
    if (!html) {
      return ''
    }
    const cleaned = stripTranslationHtmlForApply(html)
    if (!/[<>]/.test(cleaned)) {
      const t = cleaned.trim()
      return t && hasChinese(t) ? t : ''
    }
    try {
      const doc = new DOMParser().parseFromString('<div id="__ai_tr_wrap__">' + cleaned + '</div>', 'text/html')
      const wrap = doc.getElementById('__ai_tr_wrap__')
      if (wrap) {
        const texts = collectCompositeChineseTexts(wrap)
        if (texts.length === 1) {
          return texts[0]
        }
      }
    } catch (e) {
      // fall through
    }
    return ''
  }

  /** 回显用：去掉 empty 占位符及译文里可能出现的媒体 markup（live DOM 已保留原 svg/img） */
  function stripTranslationHtmlForApply(html) {
    if (!html) {
      return ''
    }
    let work = normalizeEmptyPlaceholdersInHtml(html)
    work = work.replace(EMPTY_PLACEHOLDER_RE, '')
    work = work.replace(/<empty\s+index\s*=\s*["']?\d+["']?\s*>/gi, '')
    work = work.replace(/<\/empty\s*>/gi, '')
    work = work.replace(/\{\{ai-tr-media:\d+\}\}/g, '')
    for (let mi = 0; mi < MEDIA_FILTER_TAGS.length; mi++) {
      work = replaceMediaTagsInHtml(work, MEDIA_FILTER_TAGS[mi], function () {
        return ''
      })
    }
    return work
  }

  function compositeElHasPreservedMedia(el) {
    if (!el) {
      return false
    }
    if (containsMediaInSubtree(el)) {
      return true
    }
    return serializeCompositeStructure(el).some(function (s) {
      return s.type === 'media'
    })
  }

  function getCompositeTranslateTextFingerprint(html) {
    const cleaned = stripTranslationHtmlForApply(html || '')
    const parts = extractTranslatableTextParts(cleaned)
    if (parts.length) {
      return parts.join('').replace(/\s+/g, ' ').trim()
    }
    return stripInlineHtml(cleaned).replace(/\s+/g, ' ').trim()
  }

  function assignCompositeRequestMeta(item, fullChinese, el) {
    if (!item) {
      return
    }
    const stripped = el && el.cloneNode
        ? stripMediaFromCompositeElement(el)
        : stripMediaFromCompositeHtml(fullChinese || '')
    item.mediaPlaceholderMap = stripped.map
    item.requestText = stripped.html
    // 记录 requestText 对应的原文：原文一旦变化（列表复用、tab 切换等）必须重算，
    // 否则会一直拿旧文案去请求，接口返回的也是旧译文（表现为“切换后第一项不更新”）
    item.requestTextSource = fullChinese || ''
  }

  function getCompositeRequestText(item) {
    if (!item) {
      return ''
    }
    // requestText 只是 fullChinese 的派生缓存，必须与当前原文一致才可复用
    if (item.requestText && item.requestTextSource === (item.fullChinese || '')) {
      return item.requestText
    }
    if (item.fullChinese) {
      assignCompositeRequestMeta(item, item.fullChinese)
      return item.requestText || item.fullChinese
    }
    return item.requestText || item.chinese || ''
  }

  function inlineElementHasMedia(el) {
    if (!el) {
      return false
    }
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i]
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (isMediaFilterTag(child.tagName)) {
          return true
        }
        if (isMediaPlaceholderElement(child)) {
          return true
        }
      }
    }
    return false
  }

  /** 复合块 direct child 中含中文的待译单元数（直接文本 + 含中文的行内子元素） */
  function countTranslatableUnitsInComposite(el) {
    if (!el) {
      return 0
    }
    let count = 0
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i]
      if (child.nodeType === Node.TEXT_NODE) {
        const t = (child.nodeValue || '').trim()
        if (t && hasChinese(t)) {
          count++
        }
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) {
        continue
      }
      const childTag = child.tagName.toLowerCase()
      if (isMediaFilterTag(childTag)) {
        continue
      }
      if (isInlineTagName(childTag)) {
        const t = (child.textContent || '').trim()
        if (t && hasChinese(t)) {
          count++
        }
      }
    }
    return count
  }

  /**
   * 复合块中「唯一含中文的直接子级」：直接文本节点或行内子元素。
   * 与 refineCompositeRequestText 的「只有一个含中文片段时只请求那一段」保持一致，
   * 回写时据此定位真正被翻译的那一段（多于一个含中文段或无中文段时返回 null）。
   */
  function findSoleChineseUnit(segments) {
    let unit = null
    for (let si = 0; si < segments.length; si++) {
      const s = segments[si]
      let t = ''
      if (s.type === 'text' && s.node) {
        t = (s.node.nodeValue || '').trim()
      } else if (s.type === 'inline' && s.el) {
        t = (s.el.textContent || '').trim()
      } else {
        continue
      }
      if (!t || !hasChinese(t)) {
        continue
      }
      if (unit) {
        return null
      }
      unit = s
    }
    return unit
  }

  /** 从复合块 DOM 收集各段中文（去重保序） */
  function collectCompositeChineseTexts(el) {
    const texts = []
    const seen = {}
    if (!el) {
      return texts
    }
    const segments = serializeCompositeStructure(el)
    for (let si = 0; si < segments.length; si++) {
      const s = segments[si]
      let t = ''
      if (s.type === 'text' && s.node) {
        t = (s.node.nodeValue || '').trim()
      } else if (s.type === 'inline' && s.el) {
        t = (s.el.textContent || '').trim()
      }
      if (t && hasChinese(t) && !seen[t]) {
        seen[t] = true
        texts.push(t)
      }
    }
    return texts
  }

  function extractTranslatableTextParts(html) {
    if (!html) {
      return []
    }
    let work = stripTranslationHtmlForApply(html)
    work = work.replace(/<[^>]+>/g, '')
    work = normalizeMediaHtml(work)
    return work ? [work] : []
  }

  /** 行内元素含 svg/img 时只更新文本节点，不替换媒体节点 */
  function applyInlineInnerTranslation(el, innerHtml) {
    if (!inlineElementHasMedia(el)) {
      setInlineElementContent(el, stripTranslationHtmlForApply(innerHtml || ''))
      return
    }
    const textParts = extractTranslatableTextParts(innerHtml || '')
    let partIdx = 0
    runWithoutDomObserver(function () {
      let lastNode = null
      for (let i = 0; i < el.childNodes.length; i++) {
        const child = el.childNodes[i]
        if (child.nodeType === Node.TEXT_NODE) {
          const val = partIdx < textParts.length ? textParts[partIdx++] : ''
          if (child.nodeValue !== val) {
            child.nodeValue = val
          }
          lastNode = child
        } else if (child.nodeType === Node.ELEMENT_NODE && isMediaFilterTag(child.tagName)) {
          lastNode = child
        }
      }
      while (partIdx < textParts.length) {
        const rest = textParts.slice(partIdx).join('')
        partIdx = textParts.length
        if (!rest) {
          break
        }
        if (lastNode && lastNode.nextSibling && lastNode.nextSibling.nodeType === Node.TEXT_NODE) {
          lastNode.nextSibling.nodeValue = rest
          lastNode = lastNode.nextSibling
        } else {
          const textNode = document.createTextNode(rest)
          el.insertBefore(textNode, lastNode ? lastNode.nextSibling : null)
          lastNode = textNode
        }
      }
    })
  }

  /** 块容器直接子级含直接文本并与行内元素混排时作复合块（避免 countdown 等被拆成多段请求）；仅多个行内子元素、无直接文本时不合并 */
  function isInlineCompositeRoot(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      return false
    }
    const tag = el.tagName.toLowerCase()
    if (SKIP_SCAN_TAGS.indexOf(tag) !== -1 || ['input', 'textarea', 'select', 'option', 'title'].indexOf(tag) !== -1) {
      return false
    }
    if (hasTranslateSkipAncestor(el)) {
      return false
    }
    if (!hasChinese(el.textContent || '')) {
      return false
    }
    let inlineChildCount = 0
    let hasDirectText = false
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i]
      if (child.nodeType === Node.TEXT_NODE) {
        if ((child.nodeValue || '').trim()) {
          hasDirectText = true
        }
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) {
        return false
      }
      const childTag = child.tagName.toLowerCase()
      if (isMediaFilterTag(childTag)) {
        continue
      }
      if (!isInlineTagName(childTag)) {
        return false
      }
      if (hasBlockElementInSubtree(child)) {
        return false
      }
      inlineChildCount++
    }
    if (inlineChildCount < 1 && !containsMediaInSubtree(el)) {
      return false
    }
    // 媒体仅包裹单个行内/文本时拆段翻译，不整段 composite（如 svg+span+svg）
    if (inlineChildCount === 1 && !hasDirectText && containsMediaInSubtree(el)) {
      return false
    }
    // 图标/empty 占位 span + 单段文案 span（搜索框 placeholder）不合并为复合块
    if (!hasDirectText && containsMediaInSubtree(el) && countTranslatableUnitsInComposite(el) <= 1) {
      return false
    }
    // 无直接文本时多个行内标签（如 div>a+a）各自独立翻译，不合并为一条 composite
    return hasDirectText || containsMediaInSubtree(el)
  }

  /** 文本节点若属于行内复合块，返回该块根元素 */
  function getInlineCompositeRoot(node) {
    let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node
    if (!el) {
      return null
    }
    if (el.nodeType === Node.ELEMENT_NODE && isInlineTagName(el.tagName)) {
      if (hasBlockElementInSubtree(el)) {
        return null
      }
      if (isInlineCompositeRoot(el)) {
        return el
      }
      el = el.parentElement
    }
    if (el && isInlineCompositeRoot(el)) {
      return el
    }
    return null
  }

  function normalizeCompositeHtml(html) {
    return String(html || '').replace(/\s+/g, ' ').trim()
  }

  /** 为容器元素生成唯一 CSS 路径（path 指向元素本身，非其子文本节点） */
  function getElementSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      return {path: '', structPath: ''}
    }
    if (el.id) {
      const idPath = '#' + escapeCssClass(el.id)
      return {path: idPath, structPath: idPath}
    }
    const parts = []
    let current = el
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      parts.unshift(buildSelectorPart(current, current.parentElement))
      const selector = parts.join(' > ')
      if (document.querySelectorAll(selector).length === 1) {
        return {path: selector, structPath: selector}
      }
      current = current.parentElement
    }
    const path = parts.join(' > ')
    return {path: path, structPath: path}
  }

  function getCompositeSelector(el) {
    const base = getElementSelector(el)
    return {
      path: base.path,
      structPath: base.structPath,
      index: -1,
      composite: true,
    }
  }

  /** 按子节点顺序提取文本段与行内元素段（保留 DOM 引用，回写时不替换元素） */
  function serializeCompositeStructure(el) {
    const segments = []
    if (!el) {
      return segments
    }
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i]
      if (child.nodeType === Node.TEXT_NODE) {
        segments.push({type: 'text', node: child})
      } else if (child.nodeType === Node.ELEMENT_NODE && isInlineTagName(child.tagName)) {
        segments.push({type: 'inline', el: child})
      } else if (child.nodeType === Node.ELEMENT_NODE && isMediaFilterTag(child.tagName)) {
        segments.push({type: 'media', el: child})
      }
    }
    return segments
  }

  /** 将 innerHTML 解析为与 serializeCompositeStructure 对齐的段列表 */
  function parseCompositeHtml(html) {
    const segments = []
    if (!html) {
      return segments
    }
    let doc
    try {
      doc = new DOMParser().parseFromString('<div id="__ai_tr_wrap__">' + html + '</div>', 'text/html')
    } catch (e) {
      return segments
    }
    const wrap = doc.getElementById('__ai_tr_wrap__')
    if (!wrap) {
      return segments
    }
    for (let i = 0; i < wrap.childNodes.length; i++) {
      const child = wrap.childNodes[i]
      if (child.nodeType === Node.TEXT_NODE) {
        const val = child.nodeValue || ''
        if (isEmptyPlaceholderHtml(val.trim())) {
          continue
        }
        segments.push({type: 'text', value: val})
      } else if (isMediaPlaceholderElement(child)) {
        continue
      } else if (child.nodeType === Node.ELEMENT_NODE && isInlineTagName(child.tagName)) {
        segments.push({type: 'inline', inner: child.innerHTML})
      } else if (child.nodeType === Node.ELEMENT_NODE && isMediaFilterTag(child.tagName)) {
        segments.push({type: 'media', inner: child.outerHTML})
      }
    }
    return segments
  }

  function stripInlineHtml(html) {
    return String(html || '').replace(/<[^>]+>/g, '')
  }

  function setInlineElementContent(el, inner) {
    if (!el) {
      return
    }
    if (!el.children.length) {
      el.textContent = stripInlineHtml(inner)
      return
    }
    el.innerHTML = inner
  }

  /** 按段对齐后写回：只改文本节点 nodeValue 与行内元素内容，不替换行内元素本身 */
  function applyCompositeSegmentsToDom(domSegments, htmlSegments) {
    const domParts = domSegments.filter(function (s) { return s.type === 'text' || s.type === 'inline' })
    const htmlParts = htmlSegments.filter(function (s) { return s.type === 'text' || s.type === 'inline' })
    if (!domParts.length || domParts.length !== htmlParts.length) {
      return false
    }
    for (let i = 0; i < domParts.length; i++) {
      if (domParts[i].type !== htmlParts[i].type) {
        return false
      }
    }
    let applied = false
    runWithoutDomObserver(function () {
      for (let i = 0; i < domParts.length; i++) {
        const d = domParts[i]
        const t = htmlParts[i]
        if (d.type === 'text' && d.node) {
          const nextVal = t.value != null ? t.value : ''
          if (d.node.nodeValue !== nextVal) {
            d.node.nodeValue = nextVal
            applied = true
          }
        } else if (d.type === 'inline' && d.el) {
          const nextInner = stripTranslationHtmlForApply(t.inner != null ? t.inner : '')
          if (inlineElementHasMedia(d.el)) {
            applyInlineInnerTranslation(d.el, nextInner)
            applied = true
          } else if (!d.el.children.length) {
            const plain = stripInlineHtml(nextInner)
            if (d.el.textContent !== plain) {
              d.el.textContent = plain
              applied = true
            }
          } else if (d.el.innerHTML !== nextInner) {
            setInlineElementContent(d.el, nextInner)
            applied = true
          }
        }
      }
    })
    return applied
  }

  /**
   * 译文与原 DOM 段顺序不一致时的回写（如 原文 span+文本，译文 文本+span+文本）
   * 按译文顺序复用已有 text/inline 节点并重排 direct child，避免前缀文案被后缀覆盖
   */
  function applyCompositeSegmentsFlexible(el, domSegments, htmlSegments) {
    const htmlParts = htmlSegments.filter(function (s) { return s.type === 'text' || s.type === 'inline' })
    const domParts = domSegments.filter(function (s) { return s.type === 'text' || s.type === 'inline' })
    if (!htmlParts.length || !domParts.length) {
      return false
    }

    if (htmlParts.length === 1 && htmlParts[0].type === 'text' && domParts.length > 1) {
      const val = htmlParts[0].value != null ? htmlParts[0].value : ''
      if (val && !isMediaPlaceholderText(val)) {
        const firstText = domParts.find(function (s) { return s.type === 'text' && s.node })
        if (firstText) {
          runWithoutDomObserver(function () {
            if (firstText.node.nodeValue !== val) {
              firstText.node.nodeValue = val
            }
          })
          return true
        }
      }
    }

    const inlinePool = domParts.filter(function (s) { return s.type === 'inline' && s.el }).map(function (s) { return s.el })
    const textPool = domParts.filter(function (s) { return s.type === 'text' && s.node }).map(function (s) { return s.node })
    let inlineIdx = 0
    let textIdx = 0
    const orderedNodes = []
    let applied = false

    function writeInlineContent(targetEl, nextInner) {
      const plain = stripInlineHtml(nextInner)
      if (!targetEl.children.length) {
        if (targetEl.textContent !== plain) {
          targetEl.textContent = plain
          return true
        }
        return false
      }
      if (inlineElementHasMedia(targetEl)) {
        applyInlineInnerTranslation(targetEl, nextInner)
        return true
      }
      if (targetEl.innerHTML !== nextInner) {
        setInlineElementContent(targetEl, nextInner)
        return true
      }
      return false
    }

    runWithoutDomObserver(function () {
      for (let pi = 0; pi < htmlParts.length; pi++) {
        const part = htmlParts[pi]
        if (part.type === 'inline') {
          const targetEl = inlinePool[inlineIdx++]
          if (!targetEl) {
            continue
          }
          const nextInner = stripTranslationHtmlForApply(part.inner != null ? part.inner : '')
          if (writeInlineContent(targetEl, nextInner)) {
            applied = true
          }
          orderedNodes.push(targetEl)
        } else if (part.type === 'text') {
          const val = part.value != null ? part.value : ''
          if (!val || isMediaPlaceholderText(val)) {
            continue
          }
          let textNode = textPool[textIdx++]
          if (textNode) {
            if (textNode.nodeValue !== val) {
              textNode.nodeValue = val
              applied = true
            }
          } else {
            textNode = document.createTextNode(val)
            applied = true
          }
          orderedNodes.push(textNode)
        }
      }

      if (orderedNodes.length) {
        for (let oi = 0; oi < orderedNodes.length; oi++) {
          el.appendChild(orderedNodes[oi])
        }
      }

      while (inlineIdx < inlinePool.length) {
        const unusedEl = inlinePool[inlineIdx++]
        if (unusedEl && (unusedEl.textContent || '') !== '') {
          unusedEl.textContent = ''
          applied = true
        }
      }
      while (textIdx < textPool.length) {
        const unusedNode = textPool[textIdx++]
        if (unusedNode && (unusedNode.nodeValue || '') !== '') {
          unusedNode.nodeValue = ''
          applied = true
        }
      }
    })

    return applied
  }

  function applyCompositeHtmlToElement(el, html) {
    if (!el || html == null) {
      return false
    }
    const resolvedHtml = stripTranslationHtmlForApply(html)
    if (!resolvedHtml) {
      return false
    }
    // 复合块回写前记录子树各文本节点的原始文案（回滚按记录还原，避免条目被复用改写后写错原文）
    rememberSubtreeOriginals(el)
    const plainTranslation = !/[<>]/.test(resolvedHtml)
    if (plainTranslation) {
      const segments = serializeCompositeStructure(el)
      const translatable = segments.filter(function (s) { return s.type === 'text' || s.type === 'inline' })
      const hasDirectText = segments.some(function (s) {
        return s.type === 'text' && (s.node.nodeValue || '').trim()
      })
      if (translatable.length === 1 && !hasDirectText) {
        const sole = translatable[0]
        let applied = false
        runWithoutDomObserver(function () {
          if (sole.type === 'inline' && sole.el) {
            if (inlineElementHasMedia(sole.el)) {
              applyInlineInnerTranslation(sole.el, resolvedHtml)
            } else if (!sole.el.children.length) {
              if (sole.el.textContent !== resolvedHtml) {
                sole.el.textContent = resolvedHtml
              }
            } else {
              setInlineElementContent(sole.el, resolvedHtml)
            }
            applied = true
          } else if (sole.type === 'text' && sole.node && sole.node.nodeValue !== resolvedHtml) {
            sole.node.nodeValue = resolvedHtml
            applied = true
          }
        })
        if (applied) {
          return true
        }
      }
      // 请求侧 refineCompositeRequestText 在「只有一个含中文片段」时只请求那一段，
      // 回写必须落到同一段上：它可能是直接文本，也可能是行内子元素
      // （如 <span class="openTime">营业时间</span>&nbsp;&nbsp;10:00-16:30）。
      // 旧实现固定写「第一个非空直接文本」，会把译文覆盖到后面的纯数字文本上（10:00 -> Business Hours），
      // 而真正被翻译的 span 仍是中文。
      const soleChinese = findSoleChineseUnit(segments)
      if (soleChinese && hasDirectText) {
        let applied = false
        runWithoutDomObserver(function () {
          if (soleChinese.type === 'inline' && soleChinese.el) {
            if (inlineElementHasMedia(soleChinese.el)) {
              applyInlineInnerTranslation(soleChinese.el, resolvedHtml)
            } else if (!soleChinese.el.children.length) {
              if (soleChinese.el.textContent !== resolvedHtml) {
                soleChinese.el.textContent = resolvedHtml
              }
            } else {
              setInlineElementContent(soleChinese.el, resolvedHtml)
            }
            applied = true
          } else if (soleChinese.type === 'text' && soleChinese.node) {
            if (soleChinese.node.nodeValue !== resolvedHtml) {
              soleChinese.node.nodeValue = resolvedHtml
              applied = true
            }
          }
        })
        if (applied) {
          return true
        }
      }
    }
    const domSegments = serializeCompositeStructure(el)
    const htmlSegments = parseCompositeHtml(resolvedHtml)
    if (applyCompositeSegmentsToDom(domSegments, htmlSegments)) {
      return true
    }
    return applyCompositeSegmentsFlexible(el, domSegments, htmlSegments)
  }

  function getCompositeInnerHtml(el) {
    return el && el.nodeType === Node.ELEMENT_NODE ? el.innerHTML : ''
  }

  function shouldUpdateComposite(el, item) {
    if (!el || !item) {
      return false
    }
    const current = getCompositeInnerHtml(el)
    const full = item.fullChinese || ''
    const trans = item.nodeTranslate || ''
    if (normalizeCompositeHtml(current) === normalizeCompositeHtml(full)) {
      return true
    }
    if (trans && (normalizeCompositeHtml(current) === normalizeCompositeHtml(trans) || current === trans)) {
      return false
    }
    if (!hasChinese(el.textContent || '')) {
      return false
    }
    // 旧实现此处直接 return true，会让「疫苗」这类短文案条目写到包含它的兄弟复合块上；
    // 只有元素当前文案与条目登记的原文一致时才允许写入。
    return (el.textContent || '').trim() === (item.chinese || '').trim()
  }

  function shouldReverseComposite(el, item) {
    if (!el || !item) {
      return false
    }
    const current = getCompositeInnerHtml(el)
    const full = item.fullChinese || ''
    if (normalizeCompositeHtml(current) === normalizeCompositeHtml(full)) {
      return false
    }
    // 已翻译过的复合块：仅当元素当前文案确实是本条目的译文（含倒计时数字变化）时才恢复，
    // 避免把兄弟节点改写成别的中文原文
    if (item.nodeTranslate) {
      const currentText = (el.textContent || '').replace(/\s+/g, ' ').trim()
      const expectedText = getCompositeTranslateTextFingerprint(item.nodeTranslate)
      if (currentText === expectedText ||
          stripDigitsForCompare(currentText) === stripDigitsForCompare(expectedText)) {
        return true
      }
      // 译文只覆盖中文片段（媒体/￥ 等被保留）时，元素整体文案会包含译文指纹：
      // 仅当元素已不含中文时才据此判定为「已译过」，避免命中别的中文原文
      return !!expectedText && !hasChinese(currentText) && currentText.indexOf(expectedText) !== -1
    }
    if (!hasChinese(el.textContent || '')) {
      return true
    }
    // 仍是中文却与原文不同：没有译文记录可依据，不做猜测性回滚
    return false
  }

  /** 按容器元素或 textContent 查找 composite 条目（切回中文时用） */
  function resolveCompositeItemByElement(el) {
    if (!el) {
      return null
    }
    const routeKey = getRouteKey()
    const text = (el.textContent || '').trim()
    const inner = el.innerHTML

    if (text && getNodeDataMap()[text]) {
      const direct = getNodeDataMap()[text]
      if (direct.composite && direct.pathname === routeKey) {
        return direct
      }
    }

    for (let k in getNodeDataMap()) {
      const it = getNodeDataMap()[k]
      if (!it.composite || it.pathname !== routeKey) {
        continue
      }
      if (it.chinese === text) {
        return it
      }
      for (let si = 0; si < it.selectors.length; si++) {
        const sel = it.selectors[si]
        if (!sel.composite) {
          continue
        }
        const node = resolveSelectorNode(sel)
        if (node === el) {
          return it
        }
      }
    }

    const byTranslate = resolveItemByTranslatedText(inner, text)
    if (byTranslate && byTranslate.composite) {
      return byTranslate
    }
    return null
  }

  function isCompositeDomSynced(el, item) {
    if (!el || !item || !item.nodeTranslate) {
      return false
    }
    const expected = getExpectedTranslate(item)
    if (compositeElHasPreservedMedia(el)) {
      const currentText = (el.textContent || '').replace(/\s+/g, ' ').trim()
      const expectedText = getCompositeTranslateTextFingerprint(expected)
      return currentText === expectedText ||
          stripDigitsForCompare(currentText) === stripDigitsForCompare(expectedText)
    }
    return normalizeCompositeHtml(getCompositeInnerHtml(el)) === normalizeCompositeHtml(expected)
  }

  function writeCompositeTranslate(el, item) {
    if (!el || !item || !item.nodeTranslate) {
      return false
    }
    if (!isValidTranslationText(item.nodeTranslate, item)) {
      return false
    }
    if (!shouldUpdateComposite(el, item)) {
      return false
    }
    if (isCompositeDomSynced(el, item)) {
      return false
    }
    return applyCompositeHtmlToElement(el, getExpectedTranslate(item))
  }

  function writeCompositeRevert(el, item) {
    if (!el || !item || !shouldReverseComposite(el, item)) {
      return false
    }
    return applyCompositeHtmlToElement(el, item.fullChinese)
  }

  function stripDigitsForCompare(text) {
    return (text || '').replace(/\d+/g, '#')
  }

  /** 文案变更是否仅为数字不同（如倒计时 9分34秒 -> 9分33秒） */
  function isNumericOnlyChange(oldText, newText) {
    if (!oldText || !newText || oldText === newText) {
      return false
    }
    return stripDigitsForCompare(oldText) === stripDigitsForCompare(newText)
  }

  function buildTranslateSkeleton(translate) {
    return (translate || '').replace(/\d+/g, '{{n}}')
  }

  function applyTranslateSkeleton(skeleton, fullChinese) {
    const nums = (fullChinese || '').match(/\d+/g) || []
    let result = skeleton
    for (let i = 0; i < nums.length; i++) {
      const pos = result.indexOf('{{n}}')
      if (pos === -1) {
        break
      }
      result = result.slice(0, pos) + nums[i] + result.slice(pos + 5)
    }
    return result
  }

  function syncTranslateSkeleton(item) {
    if (!item || !item.nodeTranslate) {
      return
    }
    if (/\d/.test(item.fullChinese || '')) {
      item.translateSkeleton = buildTranslateSkeleton(item.nodeTranslate)
    }
  }

  function migrateNodeDataMapKey(item, newChinese) {
    if (!item || !newChinese) {
      return
    }
    let oldKey = null
    for (let key in getNodeDataMap()) {
      if (getNodeDataMap()[key] === item) {
        oldKey = key
        break
      }
    }
    if (oldKey && oldKey !== newChinese) {
      delete getNodeDataMap()[oldKey]
      getNodeDataMap()[newChinese] = item
    }
  }

  /** 按 path/structPath + index 查找当前路由已登记条目（path 比对时会剥离 class 以兼容旧缓存） */
  function findItemBySelector(path, index, structPath) {
    const routeKey = getRouteKey()
    const normalizedPath = path ? stripClassesFromSelectorPath(path) : ''
    for (let key in getNodeDataMap()) {
      const item = getNodeDataMap()[key]
      if (item.pathname !== routeKey) {
        continue
      }
      if (item.selectors.some(function (s) {
        if (s.pathname !== routeKey) {
          return false
        }
        const sPath = s.path ? stripClassesFromSelectorPath(s.path) : ''
        const sStruct = s.structPath || sPath
        if (s.composite) {
          if (!normalizedPath && !structPath) {
            return false
          }
          return normalizedPath && (sPath === normalizedPath || sStruct === normalizedPath) ||
              structPath && (sStruct === structPath || sPath === structPath)
        }
        if (s.index !== index) {
          return false
        }
        if (normalizedPath && (sPath === normalizedPath || sStruct === normalizedPath)) {
          return true
        }
        if (structPath && (sStruct === structPath || sPath === structPath)) {
          return true
        }
        return false
      })) {
        return item
      }
    }
    return null
  }

  /** 倒计时等场景：沿用已有译文骨架，仅替换数字后写回 DOM，不发起新请求 */
  function applyDynamicTextUpdate(node, item, fullChinese, chinese) {
    if (!item.translateSkeleton && item.nodeTranslate) {
      syncTranslateSkeleton(item)
    }
    const translate = item.translateSkeleton
        ? applyTranslateSkeleton(item.translateSkeleton, fullChinese)
        : item.nodeTranslate
    item.fullChinese = fullChinese
    item.chinese = chinese
    item.nodeTranslate = translate
    if (item.composite) {
      assignCompositeRequestMeta(item, fullChinese, node.nodeType === Node.ELEMENT_NODE ? node : null)
    }
    migrateNodeDataMapKey(item, chinese)
    runWithoutDomObserver(function () {
      if (item.composite && node.nodeType === Node.ELEMENT_NODE) {
        writeCompositeTranslate(node, item)
      } else {
        writeTranslateToNode(node, item)
      }
    })
  }

  function debounce(fn, delay) {
    let timer = null;
    return function () {
      let args = arguments;
      let self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, delay);
    };
  }

  function getCookie(name) {
    let cookie = document.cookie
    let reg = new RegExp(name + '=([^=;]+)')
    let result = cookie.match(reg)
    if (result) {
      return result[1]
    }
    return ''
  }

  function getLanguage() {
    // 插件版：关闭翻译等价于"切回中文"，引擎会走回滚流程
    if (!engineConfig || !engineConfig.enabled) {
      return 'zh'
    }
    return engineConfig.targetLang || 'en'
  }

  /** SPA 路由唯一键（pathname+search+hash）；hash 模式路由会规范化 #/home/ 等写法 */
  function normalizeHashRoute(hash) {
    if (!hash) {
      return ''
    }
    let h = String(hash)
    if (h.charAt(0) !== '#') {
      h = '#' + h
    }
    if (h === '#') {
      return h
    }
    let path = h.slice(1)
    try {
      path = decodeURIComponent(path)
    } catch (e) {
      // 保持原样
    }
    let hashPath = path
    let hashQuery = ''
    const qIdx = path.indexOf('?')
    if (qIdx !== -1) {
      hashPath = path.slice(0, qIdx)
      hashQuery = path.slice(qIdx)
    }
    hashPath = hashPath.replace(/\/+/g, '/')
    if (hashPath.length > 1 && hashPath.endsWith('/')) {
      hashPath = hashPath.slice(0, -1)
    }
    return '#' + hashPath + hashQuery
  }

  function getRouteKeyFromParts(pathname, search, hash) {
    const p = pathname || '/'
    const s = search || ''
    const h = normalizeHashRoute(hash || '')
    return p + s + h
  }

  function getRouteKey() {
    return getRouteKeyFromParts(location.pathname, location.search, location.hash)
  }

  /** 当前路由（或指定路由）的 nodeDataMap 桶 */
  function getNodeDataMap(routeKey) {
    const key = routeKey || getRouteKey()
    if (!routeNodeDataCache[key]) {
      routeNodeDataCache[key] = {}
    }
    return routeNodeDataCache[key]
  }

  /** 淘汰非当前路由的旧桶，避免内存无限增长 */
  function pruneRouteNodeCache(activeKey) {
    const keys = Object.keys(routeNodeDataCache)
    if (keys.length <= ROUTE_NODE_CACHE_LIMIT) {
      return
    }
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== activeKey) {
        delete routeNodeDataCache[keys[i]]
        if (Object.keys(routeNodeDataCache).length <= ROUTE_NODE_CACHE_LIMIT) {
          break
        }
      }
    }
  }

  /**
   * 请求被中断（切语言/切页 abort）时复位条目的请求状态。
   * times 必须一起复位：中断并不代表"翻译不出来"，若照样累计，立刻就会撞上 times>=3
   * 而永久不再请求（表现为高频切换后中文再也翻不出来）。
   */
  function resetRouteLoadingFlags(routeKey) {
    const map = routeNodeDataCache[routeKey || getRouteKey()]
    if (!map) {
      return
    }
    for (let k in map) {
      map[k].loading = false
      map[k].times = 0
    }
  }

  /** 新一轮翻译（run）开始时复位重试状态：用户主动切语言，失败的条目应重新尝试 */
  function resetRouteRetryFlags(routeKey) {
    const map = routeNodeDataCache[routeKey || getRouteKey()]
    if (!map) {
      return
    }
    for (let k in map) {
      map[k].error = ''
      map[k].times = 0
    }
  }

  function clearAllRouteNodeCache() {
    routeNodeDataCache = {}
    nextNodeDataKey = 0
  }

  const hasWeakRef = typeof WeakRef === 'function'

  /**
   * 节点 -> 我们写入译文前的原始文案。
   * 列表/标签页复用同一个 DOM 与同一条选择器路径时，文案会在不同 tab 之间反复变化，
   * 条目会被"就位改写"（chinese/fullChinese 被换成新文案、旧 key 被删除/覆盖），
   * 只按条目记录回滚就可能把别的原文写进这个节点（错乱回显）。
   * 这里按"节点自己当时是什么"记录，回滚时优先用它，做到与条目如何迁移无关。
   */
  const nodeOriginalText = typeof WeakMap === 'function' ? new WeakMap() : null

  /** 记录写入译文前的原始文案（文本节点/input.placeholder）；观察到新的中文原文时会覆盖旧记录 */
  function rememberNodeOriginal(node) {
    if (!nodeOriginalText || !node) {
      return
    }
    let current = ''
    if (node.nodeType === Node.TEXT_NODE) {
      current = node.nodeValue || ''
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase()
      if (tag !== 'input' && tag !== 'textarea') {
        return
      }
      current = node.placeholder || ''
    } else {
      return
    }
    if (!current.trim()) {
      return
    }
    if (hasChinese(current) || !nodeOriginalText.has(node)) {
      nodeOriginalText.set(node, current)
    }
  }

  /** 记录子树内所有文本节点的原始文案（复合块回写前调用） */
  function rememberSubtreeOriginals(el) {
    if (!nodeOriginalText || !el || el.nodeType !== Node.ELEMENT_NODE) {
      return
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      rememberNodeOriginal(walker.currentNode)
    }
  }

  function getRememberedOriginal(node) {
    return nodeOriginalText && node ? nodeOriginalText.get(node) : undefined
  }

  /** 按记录还原一个节点的原始文案（文本节点 / input.placeholder） */
  function writeRememberedOriginal(node, original) {
    if (!node || original == null) {
      return false
    }
    let written = false
    runWithoutDomObserver(function () {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue !== original) {
          node.nodeValue = original
          written = true
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase()
        if ((tag === 'input' || tag === 'textarea') && node.placeholder !== original) {
          node.placeholder = original
          written = true
        }
      }
    })
    return written
  }

  /** 按节点当前文案在 nodeDataMap 中查找已有译文条目 */
  function resolveItemByNodeText(raw, trimmed) {
    const routeKey = getRouteKey()
    if (trimmed && getNodeDataMap()[trimmed]) {
      const direct = getNodeDataMap()[trimmed]
      if (direct.pathname === routeKey) {
        return direct
      }
    }
    for (let k in getNodeDataMap()) {
      const it = getNodeDataMap()[k]
      if (it.pathname !== routeKey) {
        continue
      }
      if (raw && it.fullChinese === raw) {
        return it
      }
      if (trimmed && it.chinese === trimmed) {
        return it
      }
      // 禁止「raw 包含 it.chinese」这类模糊匹配：像「疫苗」这种短文案条目
      // 会把「HPV疫苗」「肺炎疫苗」等兄弟节点全部改写成同一个译文。
      if (it.composite && raw && it.fullChinese && normalizeCompositeHtml(raw) === normalizeCompositeHtml(it.fullChinese)) {
        return it
      }
    }
    return null
  }

  /** 新建 nodeDataMap 条目（切页后或跨路由同名文案不复用上一页译文） */
  function createNodeDataMapEntry(chinese, fullChinese, selectorWithPath, composite) {
    const entry = {
      key: nextNodeDataKey++,
      pathname: getRouteKey(),
      chinese,
      fullChinese,
      selectors: [selectorWithPath],
      nodeTranslate: '',
      sourceTranslate: [],
      loading: false,
      error: ''
    }
    if (composite) {
      entry.composite = true
      entry.mediaPlaceholderMap = {}
      entry.requestText = ''
    }
    return entry
  }

  /** 按节点当前译文在 nodeDataMap 中查找条目（切回中文、虚拟列表回收 DOM 时用） */
  function resolveItemByTranslatedText(raw, trimmed) {
    if (!trimmed) {
      return null
    }
    const routeKey = getRouteKey()
    for (let k in getNodeDataMap()) {
      const it = getNodeDataMap()[k]
      if (it.pathname !== routeKey || !it.nodeTranslate) {
        continue
      }
      const trimmedTranslate = (it.nodeTranslate || '').trim()
      const expected = getExpectedTranslate(it)
      const trimmedExpected = String(expected).trim()
      if (trimmed === trimmedTranslate || raw === it.nodeTranslate) {
        return it
      }
      if (trimmed === trimmedExpected || raw === expected) {
        return it
      }
      if (it.sourceTranslate && it.sourceTranslate.length) {
        for (let si = 0; si < it.sourceTranslate.length; si++) {
          const st = it.sourceTranslate[si]
          if (trimmed === String(st).trim() || raw === st) {
            return it
          }
        }
      }
      if (it.composite && raw && it.nodeTranslate) {
        if (normalizeCompositeHtml(raw) === normalizeCompositeHtml(it.nodeTranslate)) {
          return it
        }
      }
    }
    return null
  }

  /** 将节点恢复为中文原文 */
  function writeRevertToNode(node, item) {
    if (!node || !item || !shouldReverseNode(node, item)) {
      return false
    }
    if (item.composite && node.nodeType === Node.ELEMENT_NODE) {
      return writeCompositeRevert(node, item)
    }
    // 复合块条目也可能挂在纯文本节点上（同一文案：图标+「疫苗」的复合块 与 <div>疫苗</div> 合并成同一条目）。
    // 这种槽位要按纯文本回滚，且只能写纯文本原文 chinese——fullChinese 里含 innerHTML 标签，写到文本节点会变成可见标签。
    // 优先用"这个节点自己的原始文案记录"：即使条目已被列表/标签页复用改写，也不会写错原文。
    const remembered = getRememberedOriginal(node)
    const revertText = remembered != null
        ? remembered
        : (item.composite
            ? ((item.chinese || '').trim() || item.fullChinese || '')
            : item.fullChinese)
    if (!revertText) {
      return false
    }
    let reverted = false
    runWithoutDomObserver(function () {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue !== revertText) {
          node.nodeValue = revertText
          reverted = true
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase()
        if (['input', 'textarea'].includes(tag)) {
          if (node.placeholder !== revertText) {
            node.placeholder = revertText
            reverted = true
          }
        }
      }
    })
    return reverted
  }

  /** 将译文写入指定节点（不依赖 CSS 选择器，适用于弹框等新挂载节点） */
  function writeTranslateToNode(node, item) {
    if (!node || !item || !item.nodeTranslate) {
      return false
    }
    // 双重保险：写译文只允许在非中文语言下（见 setTextInDom 的说明）
    if (getLanguage() === 'zh') {
      return false
    }
    if (item.composite && node.nodeType === Node.ELEMENT_NODE) {
      return writeCompositeTranslate(node, item)
    }
    if (!isValidTranslationText(item.nodeTranslate, item)) {
      return false
    }
    if (!shouldUpdateNode(node, item)) {
      return false
    }
    if (isDomSynced(node, item)) {
      return false
    }
    // 写之前先记下这个节点当前的原始文案，回滚时按记录精确还原
    rememberNodeOriginal(node)
    const translate = getExpectedTranslate(item)
    let written = false
    runWithoutDomObserver(function () {
      if (node.nodeType === Node.TEXT_NODE) {
        node.nodeValue = translate
        written = true
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase()
        if (['input', 'textarea'].includes(tag)) {
          node.placeholder = translate
          written = true
        }
      }
    })
    return written
  }

  function escapeCssAttr(val) {
    return String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

  function escapeCssClass(name) {
    if (typeof CSS !== 'undefined' && CSS.escape) {
      return CSS.escape(name)
    }
    return String(name).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1')
  }

  /** 生成单级选择器片段：id / data-* + 标签 + nth-child，不含 class */
  function buildSelectorPart(el, parent) {
    let part = el.tagName.toLowerCase()
    const testId = el.getAttribute && el.getAttribute('data-testid')
    if (testId) {
      return part + '[data-testid="' + escapeCssAttr(testId) + '"]'
    }
    const dataId = el.dataset && (el.dataset.id || el.dataset.translateId)
    if (dataId) {
      return part + '[data-id="' + escapeCssAttr(dataId) + '"]'
    }
    if (parent) {
      const children = Array.from(parent.children)
      const siblings = children.filter(function (c) { return c.tagName === el.tagName })
      if (siblings.length > 1) {
        part += ':nth-child(' + (children.indexOf(el) + 1) + ')'
      }
    }
    return part
  }

  function isNodeConnected(node) {
    if (!node) {
      return false
    }
    return typeof node.isConnected === 'boolean' ? node.isConnected : document.contains(node)
  }

  /** 兼容旧缓存：从含 class 的历史 path 中提取纯结构路径 */
  function stripClassesFromSelectorPath(path) {
    if (!path || path.indexOf('.') === -1) {
      return path
    }
    return path.split(' > ').map(function (part) {
      let segment = part
      const nthMatch = segment.match(/(:nth-child\(\d+\))$/)
      const nth = nthMatch ? nthMatch[1] : ''
      if (nth) {
        segment = segment.slice(0, -nth.length)
      }
      const attrMatch = segment.match(/(\[data-[^\]]+\])/)
      const attr = attrMatch ? attrMatch[1] : ''
      const tag = segment.split(/[.[]/)[0]
      return tag + attr + nth
    }).join(' > ')
  }

  function querySelectorAllSafe(path) {
    if (!path) {
      return []
    }
    try {
      return Array.from(document.querySelectorAll(path))
    } catch (e) {
      return []
    }
  }

  /** 按 selector 槽位反查 nodeDataMap 条目，用于歧义路径消歧 */
  function findItemBySelectorSlot(sel) {
    if (!sel) {
      return null
    }
    const routeKey = getRouteKey()
    for (let k in getNodeDataMap()) {
      const it = getNodeDataMap()[k]
      if (it.pathname !== routeKey) {
        continue
      }
      for (let si = 0; si < it.selectors.length; si++) {
        if (isSameSelectorSlot(it.selectors[si], sel, routeKey)) {
          return it
        }
      }
    }
    return null
  }

  /**
   * structPath 命中多个元素时消歧：WeakRef > 中文 textContent > 复合块 innerHTML 指纹
   */
  function disambiguateElementMatches(matches, sel, item) {
    if (!matches || !matches.length) {
      return null
    }
    if (matches.length === 1) {
      return matches[0]
    }
    if (sel && sel.nodeRef && hasWeakRef) {
      const ref = sel.nodeRef.deref()
      if (ref && isNodeConnected(ref)) {
        for (let mi = 0; mi < matches.length; mi++) {
          if (matches[mi] === ref) {
            return matches[mi]
          }
        }
      }
    }
    if (!item) {
      return null
    }
    const hint = (item.chinese || '').trim()
    if (hint) {
      for (let mi = 0; mi < matches.length; mi++) {
        const text = (matches[mi].textContent || '').trim()
        if (text === hint) {
          return matches[mi]
        }
      }
    }
    if (item.composite && item.fullChinese) {
      const fullNorm = normalizeCompositeHtml(item.fullChinese)
      for (let mi = 0; mi < matches.length; mi++) {
        const innerNorm = normalizeCompositeHtml(matches[mi].innerHTML || '')
        if (innerNorm === fullNorm) {
          return matches[mi]
        }
        if (item.nodeTranslate && innerNorm === normalizeCompositeHtml(item.nodeTranslate)) {
          return matches[mi]
        }
      }
    }
    return null
  }

  function querySelectorChildNode(path, index, item) {
    if (!path || index < 0) {
      return null
    }
    const parents = querySelectorAllSafe(path)
    if (!parents.length) {
      return null
    }
    const hint = item && item.chinese ? String(item.chinese).trim() : ''
    const fullHint = item && item.fullChinese ? String(item.fullChinese).trim() : ''
    const translateHint = item && item.nodeTranslate ? String(item.nodeTranslate).trim() : ''
    for (let pi = 0; pi < parents.length; pi++) {
      const el = parents[pi]
      const node = el.childNodes[index]
      if (!node || !isNodeConnected(node)) {
        continue
      }
      if (hint || fullHint || translateHint) {
        const current = getNodeText(node)
        const trimmed = current.trim()
        if (trimmed === hint || current === fullHint) {
          return node
        }
        // 倒计时等「仅数字变化」场景：框架整体替换文本节点后位置不变、文案只差数字，
        // 仍视为同一条目，避免槽位被 pruneStaleSelectors 剔除后重复请求
        if (hint && isNumericOnlyChange(trimmed, hint)) {
          return node
        }
        if (translateHint && (trimmed === translateHint || current === item.nodeTranslate)) {
          return node
        }
        continue
      }
      return node
    }
    if (!hint && !fullHint && !translateHint) {
      const node = parents[0].childNodes[index]
      return node && isNodeConnected(node) ? node : null
    }
    return null
  }

  function refreshSelectorNodeRef(sel, node) {
    if (hasWeakRef && node) {
      sel.nodeRef = new WeakRef(node)
    }
  }

  /** 解析 selector 对应节点：WeakRef -> 结构路径（不含 class），成功后规范化 path 并刷新 nodeRef */
  function resolveSelectorNode(sel) {
    if (sel.nodeRef && hasWeakRef) {
      const ref = sel.nodeRef.deref()
      if (ref && isNodeConnected(ref)) {
        return ref
      }
    }
    const structPath = sel.structPath || stripClassesFromSelectorPath(sel.path)
    if (!structPath) {
      return null
    }
    const item = findItemBySelectorSlot(sel)

    if (sel.composite) {
      const matches = querySelectorAllSafe(structPath)
      const el = disambiguateElementMatches(matches, sel, item)
      if (el && isNodeConnected(el) && el.nodeType === Node.ELEMENT_NODE) {
        sel.path = structPath
        sel.structPath = structPath
        refreshSelectorNodeRef(sel, el)
        return el
      }
      return null
    }

    const node = querySelectorChildNode(structPath, sel.index, item)
    if (node) {
      sel.path = structPath
      sel.structPath = structPath
      refreshSelectorNodeRef(sel, node)
      return node
    }
    return null
  }

  /**
   * 在子树内按「中文原文」匹配 nodeDataMap 并写回已有译文（弹框、晚渲染 DOM 回显）
   */
  function applyCachedTranslationsInRoot(root) {
    if (!root || !isOpenTranslate() || getLanguage() === 'zh') {
      return
    }
    const routeKey = getRouteKey()

    if (root.nodeType === Node.TEXT_NODE) {
      const raw = root.nodeValue || ''
      if (hasChinese(raw)) {
        const item = resolveItemByNodeText(raw, raw.trim())
        if (item && item.pathname === routeKey) {
          writeTranslateToNode(root, item)
        }
      }
      return
    }

    const scanRoot = root.nodeType === Node.ELEMENT_NODE ? root : document.body
    if (!shouldScanElement(scanRoot) && scanRoot !== document.body) {
      return
    }

    const walker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent) {
          return NodeFilter.FILTER_REJECT
        }
        const tag = parent.tagName.toLowerCase()
        if (['script', 'style', 'noscript', 'svg', 'iframe', 'object', 'link', 'img', 'video', 'audio'].includes(tag)) {
          return NodeFilter.FILTER_REJECT
        }
        const t = (node.nodeValue || '').trim()
        if (!t || !hasChinese(t)) {
          return NodeFilter.FILTER_SKIP
        }
        return NodeFilter.FILTER_ACCEPT
      }
    })
    while (walker.nextNode()) {
      const textNode = walker.currentNode
      const raw = textNode.nodeValue || ''
      const item = resolveItemByNodeText(raw, raw.trim())
      if (item && item.pathname === routeKey && item.nodeTranslate) {
        writeTranslateToNode(textNode, item)
      }
    }

    const inputWalker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (!['input', 'textarea'].includes(node.tagName.toLowerCase())) {
          return NodeFilter.FILTER_SKIP
        }
        const ph = (node.placeholder || '').trim()
        if (!ph || !hasChinese(ph)) {
          return NodeFilter.FILTER_SKIP
        }
        return NodeFilter.FILTER_ACCEPT
      }
    })
    while (inputWalker.nextNode()) {
      const el = inputWalker.currentNode
      const item = resolveItemByNodeText(el.placeholder, el.placeholder.trim())
      if (item && item.pathname === routeKey && item.nodeTranslate) {
        writeTranslateToNode(el, item)
      }
    }

    findInlineCompositeBlocks(scanRoot, false)
  }

  /**
   * 在子树内按「已有译文」匹配 nodeDataMap 并恢复中文（切回中文、滚动加载/虚拟列表回收 DOM 时用）
   * @param {boolean} [viewportOnly=false] 为 true 时仅处理可视区内节点
   */
  function applyRevertTranslationsInRoot(root, viewportOnly) {
    if (!root || getLanguage() !== 'zh') {
      return
    }
    const routeKey = getRouteKey()

    function tryRevertNode(node) {
      if (viewportOnly && !isTranslatableNodeInViewport(node)) {
        return
      }
      const raw = getNodeText(node)
      const trimmed = raw.trim()
      if (!trimmed || hasChinese(trimmed)) {
        return
      }
      // 优先用节点自己的原始文案记录：这个节点显示的就是我们写进去的译文，
      // 即使条目已被列表/标签页复用改写、旧条目被覆盖、或跨路由，也能精确还原
      const remembered = getRememberedOriginal(node)
      if (remembered != null) {
        writeRememberedOriginal(node, remembered)
        return
      }
      const item = resolveItemByTranslatedText(raw, trimmed)
      if (item && item.pathname === routeKey) {
        writeRevertToNode(node, item)
      }
    }

    if (root.nodeType === Node.TEXT_NODE || (root.nodeType === Node.ELEMENT_NODE &&
        ['input', 'textarea'].includes(root.tagName.toLowerCase()))) {
      tryRevertNode(root)
      return
    }

    const scanRoot = root.nodeType === Node.ELEMENT_NODE ? root : document.body
    if (!shouldScanElement(scanRoot) && scanRoot !== document.body) {
      return
    }

    const walker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent) {
          return NodeFilter.FILTER_REJECT
        }
        const tag = parent.tagName.toLowerCase()
        if (['script', 'style', 'noscript', 'svg', 'iframe', 'object', 'link', 'img', 'video', 'audio'].includes(tag)) {
          return NodeFilter.FILTER_REJECT
        }
        const t = (node.nodeValue || '').trim()
        if (!t || hasChinese(t)) {
          return NodeFilter.FILTER_SKIP
        }
        return NodeFilter.FILTER_ACCEPT
      }
    })
    while (walker.nextNode()) {
      tryRevertNode(walker.currentNode)
    }

    const inputWalker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (!['input', 'textarea'].includes(node.tagName.toLowerCase())) {
          return NodeFilter.FILTER_SKIP
        }
        const ph = (node.placeholder || '').trim()
        if (!ph || hasChinese(ph)) {
          return NodeFilter.FILTER_SKIP
        }
        return NodeFilter.FILTER_ACCEPT
      }
    })
    while (inputWalker.nextNode()) {
      tryRevertNode(inputWalker.currentNode)
    }

    const compositeWalker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (!isInlineCompositeRoot(node)) {
          return NodeFilter.FILTER_SKIP
        }
        if (viewportOnly && !isTranslatableNodeInViewport(node)) {
          return NodeFilter.FILTER_REJECT
        }
        return NodeFilter.FILTER_ACCEPT
      }
    })
    while (compositeWalker.nextNode()) {
      const el = compositeWalker.currentNode
      const item = resolveCompositeItemByElement(el)
      if (item && item.pathname === routeKey && shouldReverseComposite(el, item)) {
        writeCompositeRevert(el, item)
      }
    }
  }

  /** 读取节点当前可翻译文案：文本节点的 nodeValue，或 input/textarea 的 placeholder */
  function getViewportBounds() {
    const vv = window.visualViewport
    if (vv && typeof vv.height === 'number' && vv.height > 0) {
      return {
        top: vv.offsetTop - VIEWPORT_BUFFER,
        left: vv.offsetLeft - VIEWPORT_BUFFER,
        bottom: vv.offsetTop + vv.height + VIEWPORT_BUFFER,
        right: vv.offsetLeft + (vv.width || 0) + VIEWPORT_BUFFER,
      }
    }
    return {
      top: -VIEWPORT_BUFFER,
      left: -VIEWPORT_BUFFER,
      bottom: (window.innerHeight || document.documentElement.clientHeight || 0) + VIEWPORT_BUFFER,
      right: (window.innerWidth || document.documentElement.clientWidth || 0) + VIEWPORT_BUFFER,
    }
  }

  function rectsIntersect(rect, bounds) {
    return rect.bottom >= bounds.top && rect.top <= bounds.bottom &&
        rect.right >= bounds.left && rect.left <= bounds.right
  }

  /** 是否作为视口判断锚点的块级/卡片容器（避免沿 body 误判整页可视） */
  function isViewportAnchorElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      return false
    }
    const tag = el.tagName.toLowerCase()
    if (BLOCK_TAGS.indexOf(tag) !== -1) {
      return true
    }
    const style = window.getComputedStyle(el)
    const display = style.display
    return display === 'block' || display === 'flex' || display === 'grid' || display === 'list-item' ||
        display === 'table' || display === 'table-cell' || display === 'table-row'
  }

  /**
   * 取用于视口判断的锚点元素：向上找到块级/卡片容器，以其是否与视口相交代表整块是否「露头」
   */
  function getViewportAnchorElement(node) {
    let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node
    if (!el) {
      return null
    }
    if (el.tagName && el.tagName.toLowerCase() === 'title') {
      return el
    }
    let current = el
    let fallback = el
    while (current && current.nodeType === Node.ELEMENT_NODE &&
        current !== document.body && current !== document.documentElement) {
      if (isViewportAnchorElement(current)) {
        return current
      }
      fallback = current
      current = current.parentElement
    }
    return fallback
  }

  /** 元素是否在可视区（含缓冲）；display:none / 零尺寸视为不可见 */
  function isElementInViewport(el) {
    if (!el || !isNodeConnected(el)) {
      return false
    }
    if (el.tagName && el.tagName.toLowerCase() === 'title') {
      return true
    }
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false
    }
    const bounds = getViewportBounds()
    const rects = el.getClientRects()
    if (!rects.length) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        return false
      }
      return rectsIntersect(rect, bounds)
    }
    for (let ri = 0; ri < rects.length; ri++) {
      const rect = rects[ri]
      if (rect.width === 0 && rect.height === 0) {
        continue
      }
      if (rectsIntersect(rect, bounds)) {
        return true
      }
    }
    return false
  }

  /** 文本节点 / input/textarea 是否处于可视区（按块级锚点判断，容器露头则子树内文案均视为可视） */
  function isTranslatableNodeInViewport(node) {
    if (!node || !isNodeConnected(node)) {
      return false
    }
    const anchor = getViewportAnchorElement(node)
    if (!anchor) {
      return false
    }
    if (anchor.tagName && anchor.tagName.toLowerCase() === 'title') {
      return true
    }
    return isElementInViewport(anchor)
  }

  /** nodeDataMap 条目是否至少有一个 selector 落在当前路由可视区 */
  function isItemInViewport(item) {
    if (!item) {
      return false
    }
    const routeKey = getRouteKey()
    for (let si = 0; si < item.selectors.length; si++) {
      const sel = item.selectors[si]
      if (sel.pathname && sel.pathname !== routeKey) {
        continue
      }
      const node = resolveSelectorNode(sel)
      if (node && isTranslatableNodeInViewport(node)) {
        return true
      }
    }
    return false
  }

  /** 是否仍为待发起翻译的条目 */
  function isPendingTranslateItem(item) {
    return !item.nodeTranslate &&
        !item.sourceTranslate.includes(item.chinese) &&
        !item.loading &&
        !item.error &&
        (!item.times || item.times < 3)
  }

  function getNodeText(node) {
    if (!node) {
      return ''
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || ''
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase()
      if (['input', 'textarea'].includes(tag)) {
        return node.placeholder || ''
      }
    }
    return ''
  }

  /**
   * 写入译文前校验：仅当节点当前文案「仍像待翻译中文」时才覆盖
   * 避免同一 CSS 选择器命中了别的子节点（如 .count 里的数字、用户已改过的文案）
   */
  function shouldUpdateNode(node, item) {
    if (!node) {
      return false
    }
    if (item && item.composite && node.nodeType === Node.ELEMENT_NODE) {
      return shouldUpdateComposite(node, item)
    }
    // 复合块条目也可能挂在纯文本节点上（同一文案被合并成同一条目），此时按纯文本判定
    const current = getNodeText(node)
    const trimmed = current.trim()
    const trimmedChinese = (item.chinese || '').trim()
    const trimmedFull = (item.fullChinese || '').trim()
    const trimmedTranslate = (item.nodeTranslate || '').trim()

    // 节点已空且记录也为空：允许写入（占位类场景）
    if (!trimmed && !trimmedFull) {
      return true
    }
    // 仍是原始中文（trim 或含前后空白的全文）：需要翻译
    if (trimmed === trimmedChinese || trimmed === trimmedFull) {
      return true
    }
    // 旧实现允许「当前文案包含登记的中文子串」时写入，这会让短文案条目污染包含它的兄弟节点；
    // 现已收敛为：只有当前文案精确等于本条目的原文（或已是本条目的译文）时才处理。
    // 已是本条目译文：无需再写（避免写 DOM -> Observer -> 再写 的死循环）
    if (trimmedTranslate && (trimmed === trimmedTranslate || current === item.nodeTranslate)) {
      return false
    }
    // 纯英文/其它文案且并非本条目译文：不写入（防止上一页残留译文刷到本页同名选择器节点）
    if (!hasChinese(trimmed)) {
      return false
    }
    return false
  }

  /**
   * 切回中文时校验：仅回滚「确认已翻译过」的节点，避免改掉用户手动编辑的内容
   */
  function shouldReverseNode(node, item) {
    if (!node) {
      return false
    }
    if (item && item.composite) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return shouldReverseComposite(node, item)
      }
      // 文本槽位：只回滚「位于复合块元素之外」的独立文本节点（同一文案被合并进同一条目的场景，
      // 如 <div class="area">疫苗</div> 与 图标+「疫苗」）。复合块内部的片段文本节点交给元素级回滚，
      // 否则会把整段原文（含后面的数字/时间）写进一个片段里。
      if (!canRevertCompositeTextSlot(node, item)) {
        return false
      }
    }
    // 复合块条目挂在纯文本节点上时同样按纯文本判定：
    // 旧实现只要 item.composite 就 return false，导致该文本节点切回中文时永远停在译文上
    const current = getNodeText(node)
    const trimmed = current.trim()
    const trimmedFull = (item.fullChinese || '').trim()
    const trimmedChinese = (item.chinese || '').trim()
    const trimmedTranslate = (item.nodeTranslate || '').trim()

    // 当前已是中文：无需回滚
    if (hasChinese(trimmed)) {
      return false
    }
    // 有写入记录：这个节点当前显示的就是我们写进去的译文，直接按记录还原
    // （条目可能已被列表复用改写/迁移，甚至旧条目已被覆盖，都不影响这里）
    if (getRememberedOriginal(node) != null) {
      return true
    }
    // 当前是译文：可恢复为 fullChinese
    if (trimmedTranslate && (trimmed === trimmedTranslate || current === item.nodeTranslate)) {
      return true
    }
    return false
  }

  /**
   * 复合块条目上的文本槽位能否按纯文本回滚
   * 只有「位于复合块元素之外」的独立文本节点可以（同一文案被合并进同一条目的场景）；
   * 复合块内部的片段文本节点返回 false，交给元素级回滚处理
   */
  function canRevertCompositeTextSlot(node, item) {
    if (!node || !item || !item.selectors) {
      return false
    }
    let sawCompositeElement = false
    for (let si = 0; si < item.selectors.length; si++) {
      const sel = item.selectors[si]
      if (!sel.composite) {
        continue
      }
      const el = resolveSelectorNode(sel)
      if (!el || el.nodeType !== Node.ELEMENT_NODE) {
        continue
      }
      sawCompositeElement = true
      if (el === node || el.contains(node)) {
        return false
      }
    }
    return sawCompositeElement
  }

  /**
   * 弹框关闭等场景：React 将 DOM 瞬时还原为中文，但缓存条目仍有译文
   * 此时应回写译文，勿清空 nodeTranslate 或等待防抖扫描
   */
  function shouldReapplyCachedTranslation(node, item) {
    if (!node || !item || !item.nodeTranslate || item.pathname !== getRouteKey()) {
      return false
    }
    if (item.composite && node.nodeType === Node.ELEMENT_NODE) {
      const text = (node.textContent || '').trim()
      if (!hasChinese(text)) {
        return false
      }
      const chinese = (item.chinese || '').trim()
      if (text !== chinese && normalizeCompositeHtml(node.innerHTML) !== normalizeCompositeHtml(item.fullChinese)) {
        return false
      }
      return !isCompositeDomSynced(node, item)
    }
    const current = getNodeText(node)
    const trimmed = current.trim()
    const trimmedTranslate = (item.nodeTranslate || '').trim()
    if (trimmed === trimmedTranslate || current === item.nodeTranslate) {
      return false
    }
    const trimmedChinese = (item.chinese || '').trim()
    const trimmedFull = (item.fullChinese || '').trim()
    return hasChinese(trimmed) && (
        trimmed === trimmedChinese ||
        trimmed === trimmedFull
    )
  }

  function reapplyCachedTranslationIfNeeded(node, item) {
    if (!shouldReapplyCachedTranslation(node, item)) {
      return false
    }
    if (item.composite && node.nodeType === Node.ELEMENT_NODE) {
      return writeCompositeTranslate(node, item)
    }
    return writeTranslateToNode(node, item)
  }

  /**
   * 为文本/placeholder 节点生成定位信息：CSS 结构路径 + 在父元素 childNodes 中的下标
   * 仅用 id / data-* / 标签 + nth-child，不使用 class
   */
  function getShortestSelector(el) {
    if (!el) {
      return {path: '', structPath: '', index: -1}
    }
    const index = el.parentElement ? Array.from(el.parentElement.childNodes).indexOf(el) : -1
    const anchor = el.nodeType === Node.TEXT_NODE ? el.parentElement : el

    if (anchor && anchor.id) {
      const idPath = '#' + escapeCssClass(anchor.id)
      return {path: idPath, structPath: idPath, index: index}
    }

    const parts = []
    let current = el.parentElement
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      parts.unshift(buildSelectorPart(current, current.parentElement))
      const selector = parts.join(' > ')
      if (document.querySelectorAll(selector).length === 1) {
        return {path: selector, structPath: selector, index: index}
      }
      current = current.parentElement
    }
    const path = parts.join(' > ')
    return {
      path: path,
      structPath: path,
      index: index,
    }
  }

  function isSameSelectorSlot(sel, selector, routeKey) {
    if (!sel || sel.pathname !== routeKey) {
      return false
    }
    const selPath = sel.structPath || stripClassesFromSelectorPath(sel.path)
    const nextPath = selector.structPath || stripClassesFromSelectorPath(selector.path)
    if (sel.composite || selector.composite) {
      return !!sel.composite && !!selector.composite && selPath === nextPath
    }
    if (sel.index !== selector.index) {
      return false
    }
    return selPath === nextPath
  }

  function patchSelectorSlot(sel, node, selector) {
    sel.path = selector.path
    sel.structPath = selector.structPath
    refreshSelectorNodeRef(sel, node)
  }

  /**
   * 登记单个待翻译节点：写入 nodeDataMap，并在已有缓存译文时立即 setTextInDom
   * @param {Node} node 文本节点，或带 placeholder 的 input/textarea 元素
   */
  function setOneNode(node) {
    if (!node || hasTranslateSkipAncestor(node)) {
      return
    }
    let fullChinese = ''
    if (node.nodeType === Node.TEXT_NODE) {
      fullChinese = node.nodeValue
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (['input', 'textarea'].includes(node.tagName.toLowerCase())) {
        fullChinese = node.placeholder
      }
    }
    if (!fullChinese) {
      return
    }
    const chinese = fullChinese.trim()
    if (!chinese) {
      return
    }
    if (!hasChinese(chinese)) {
      return
    }
    const selector = getShortestSelector(node)

    if (!selector.path && !selector.structPath) {
      return
    }

    // 同 path+index 已登记（含倒计时等同节点文案秒级变化）
    const pathItem = findItemBySelector(selector.path, selector.index, selector.structPath)
    const routeKey = getRouteKey()
    const matchedSelector = pathItem && pathItem.selectors.find(function (s) {
      return isSameSelectorSlot(s, selector, routeKey)
    })

    if (pathItem) {
      if (matchedSelector) {
        patchSelectorSlot(matchedSelector, node, selector)
      }
      if (reapplyCachedTranslationIfNeeded(node, pathItem)) {
        return
      }
      if (pathItem.chinese === chinese && pathItem.fullChinese === fullChinese) {
        if (pathItem.nodeTranslate && pathItem.pathname === getRouteKey()) {
          writeTranslateToNode(node, pathItem)
          setTextInDom(pathItem)
        }
        return
      }

      const numericOnly = isNumericOnlyChange(pathItem.fullChinese, fullChinese) ||
          isNumericOnlyChange(pathItem.chinese, chinese)

      if (numericOnly && pathItem.nodeTranslate) {
        applyDynamicTextUpdate(node, pathItem, fullChinese, chinese)
        return
      }

      // 同一个 DOM/路径被复用成另一条文案（tab/列表切换）：把这个节点当前的原文记录下来，
      // 这样即使新译文还没回来就切回中文，也能把这个节点还原成"它现在这条"文案，而不是旧 tab 的
      if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
        rememberNodeOriginal(node)
      }
      pathItem.chinese = chinese
      pathItem.fullChinese = fullChinese
      // 复合块（如 tab 切换后 全部分类 -> 全部健康）必须同步刷新请求文案与媒体占位表，
      // 否则会继续用上一个 tab 的文案请求，回显的也是上一个 tab 的译文
      if (pathItem.composite) {
        assignCompositeRequestMeta(pathItem, fullChinese, null)
      }
      migrateNodeDataMapKey(pathItem, chinese)

      if (numericOnly) {
        return
      }

      // 同位置非数字类变更：清空旧译文，等待重新请求
      pathItem.nodeTranslate = ''
      pathItem.sourceTranslate = []
      pathItem.translateSkeleton = ''
      pathItem.loading = false
      pathItem.error = ''
      pathItem.times = 0
      return
    }

    let item = getNodeDataMap()[chinese]
    const selectorWithPath = {
      path: selector.path,
      structPath: selector.structPath,
      index: selector.index,
      pathname: getRouteKey(),
      nodeRef: hasWeakRef ? new WeakRef(node) : null,
    }

    if (!item || item.pathname !== routeKey) {
      getNodeDataMap()[chinese] = createNodeDataMapEntry(chinese, fullChinese, selectorWithPath, false)
    } else {
      // 同一中文文案出现在当前页新位置：合并 selectors
      const samePageSelectors = item.selectors.filter(i => i.pathname === getRouteKey())
      const existingSlot = samePageSelectors.find(function (i) {
        return isSameSelectorSlot(i, selector, routeKey)
      })
      if (!existingSlot) {
        getNodeDataMap()[chinese] = {
          ...item,
          pathname: getRouteKey(),
          selectors: [...samePageSelectors, selectorWithPath],
        }
      } else {
        patchSelectorSlot(existingSlot, node, selector)
      }
    }

    // 其它页面/本次之前已译完：当前页 DOM 仍为中文时直接刷入
    let latest = getNodeDataMap()[chinese];
    if (latest && latest.nodeTranslate && latest.pathname === getRouteKey()) {
      writeTranslateToNode(node, latest)
      setTextInDom(getNodeDataMap()[chinese])
    }
  }

  /**
   * 登记行内复合块：整段 innerHTML 作为一条翻译请求，回写时按段更新不替换行内元素
   * @param {Element} el 复合块根容器
   */
  function setOneCompositeNode(el) {
    if (!el || !isInlineCompositeRoot(el) || hasTranslateSkipAncestor(el)) {
      return
    }
    const fullChinese = el.innerHTML
    if (!fullChinese) {
      return
    }
    const chinese = (el.textContent || '').trim()
    if (!chinese || !hasChinese(chinese)) {
      return
    }
    const selector = getCompositeSelector(el)
    if (!selector.path && !selector.structPath) {
      return
    }

    const pathItem = findItemBySelector(selector.path, selector.index, selector.structPath)
    const routeKey = getRouteKey()
    const matchedSelector = pathItem && pathItem.selectors.find(function (s) {
      return isSameSelectorSlot(s, selector, routeKey)
    })

    if (pathItem) {
      if (matchedSelector) {
        patchSelectorSlot(matchedSelector, el, selector)
      }
      if (reapplyCachedTranslationIfNeeded(el, pathItem)) {
        return
      }
      if (pathItem.chinese === chinese && pathItem.fullChinese === fullChinese) {
        if (pathItem.nodeTranslate && pathItem.pathname === getRouteKey()) {
          writeCompositeTranslate(el, pathItem)
          setTextInDom(pathItem)
        }
        return
      }

      const numericOnly = isNumericOnlyChange(pathItem.fullChinese, fullChinese) ||
          isNumericOnlyChange(pathItem.chinese, chinese)

      if (numericOnly && pathItem.nodeTranslate) {
        applyDynamicTextUpdate(el, pathItem, fullChinese, chinese)
        return
      }

      pathItem.chinese = chinese
      pathItem.fullChinese = fullChinese
      pathItem.composite = true
      assignCompositeRequestMeta(pathItem, fullChinese, el)
      migrateNodeDataMapKey(pathItem, chinese)

      if (numericOnly) {
        return
      }

      pathItem.nodeTranslate = ''
      pathItem.sourceTranslate = []
      pathItem.translateSkeleton = ''
      pathItem.loading = false
      pathItem.error = ''
      pathItem.times = 0
      return
    }

    let item = getNodeDataMap()[chinese]
    const selectorWithPath = {
      path: selector.path,
      structPath: selector.structPath,
      index: selector.index,
      composite: true,
      pathname: getRouteKey(),
      nodeRef: hasWeakRef ? new WeakRef(el) : null,
    }

    if (!item || item.pathname !== routeKey) {
      getNodeDataMap()[chinese] = createNodeDataMapEntry(chinese, fullChinese, selectorWithPath, true)
      assignCompositeRequestMeta(getNodeDataMap()[chinese], fullChinese, el)
    } else {
      const samePageSelectors = item.selectors.filter(i => i.pathname === getRouteKey())
      const existingSlot = samePageSelectors.find(function (i) {
        return isSameSelectorSlot(i, selector, routeKey)
      })
      if (!existingSlot) {
        getNodeDataMap()[chinese] = {
          ...item,
          composite: true,
          pathname: getRouteKey(),
          fullChinese,
          selectors: [...samePageSelectors, selectorWithPath],
        }
        assignCompositeRequestMeta(getNodeDataMap()[chinese], fullChinese, el)
      } else {
        patchSelectorSlot(existingSlot, el, selector)
      }
    }

    let latest = getNodeDataMap()[chinese]
    if (latest && latest.nodeTranslate && latest.pathname === getRouteKey()) {
      writeCompositeTranslate(el, latest)
      setTextInDom(getNodeDataMap()[chinese])
    }
  }

  /** 扫描子树中的行内复合块并登记 */
  function findInlineCompositeBlocks(root, viewportOnly) {
    if (!root) {
      return
    }
    const scanRoot = root.nodeType === Node.ELEMENT_NODE ? root : document.body
    if (!shouldScanElement(scanRoot) && scanRoot !== document.body) {
      return
    }
    const walker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (!isInlineCompositeRoot(node)) {
          return NodeFilter.FILTER_SKIP
        }
        if (viewportOnly && !isTranslatableNodeInViewport(node)) {
          return NodeFilter.FILTER_REJECT
        }
        return NodeFilter.FILTER_ACCEPT
      }
    })
    while (walker.nextNode()) {
      setOneCompositeNode(walker.currentNode)
    }
  }

  /**
   * 遍历 root 子树中的文本节点，含中文则 setOneNode
   * @param {boolean} [viewportOnly=false] 为 true 时仅登记可视区内节点
   */
  function findText(root, viewportOnly) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent) {
          return NodeFilter.FILTER_REJECT;
        }
        const tag = parent.tagName.toLowerCase();
        if (['body', 'script', 'style', 'noscript', 'svg', 'iframe', 'object', 'link', 'img', 'video', 'audio'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (hasTranslateSkipAncestor(node)) {
          return NodeFilter.FILTER_REJECT
        }
        if (getInlineCompositeRoot(node)) {
          return NodeFilter.FILTER_REJECT
        }

        const chinese = (node.nodeValue || '').trim()
        if (!chinese || !hasChinese(chinese)) {
          return NodeFilter.FILTER_SKIP
        }

        if (viewportOnly && !isTranslatableNodeInViewport(node)) {
          return NodeFilter.FILTER_REJECT
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) {
      setOneNode(walker.currentNode)
    }
    findInlineCompositeBlocks(root, viewportOnly)
  }

  /**
   * 遍历 root 子树中带中文 placeholder 的 input/textarea
   * @param {boolean} [viewportOnly=false] 为 true 时仅登记可视区内节点
   */
  function findInput(root, viewportOnly) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.dataset.translateHidden) {
          node.style.display = 'none'
          return NodeFilter.FILTER_REJECT;
        }
        const tag = node.tagName.toLowerCase();
        if (!['input', 'textarea'].includes(tag)) {
          return NodeFilter.FILTER_SKIP;
        }
        if (hasTranslateSkipAncestor(node)) {
          return NodeFilter.FILTER_REJECT
        }

        const chinese = node.placeholder.trim()
        if (!chinese || !hasChinese(chinese)) {
          return NodeFilter.FILTER_SKIP
        }

        if (viewportOnly && !isTranslatableNodeInViewport(node)) {
          return NodeFilter.FILTER_REJECT
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) {
      setOneNode(walker.currentNode)
    }
  }

  /** 当前路由可视区内是否仍有待发起翻译的条目 */
  function hasPendingTranslateWork() {
    const routeKey = getRouteKey()
    for (let key in getNodeDataMap()) {
      const item = getNodeDataMap()[key]
      if (item.pathname !== routeKey) {
        continue
      }
      if (isPendingTranslateItem(item) && isItemInViewport(item)) {
        return true
      }
    }
    return false
  }

  /**
   * 收集 nodeDataMap 中待译条目并调用 onFetch（单用户串行，进行中则排队）
   * 防抖 300ms，合并 MutationObserver 高频触发
   */
  const onTranslate = debounce(() => {
    if (!isOpenTranslate()) {
      return
    }
    const lang = getLanguage()
    if (lang === 'zh') {
      return
    }

    let chineseList = []
    for (let key in getNodeDataMap()) {
      const item = getNodeDataMap()[key]
      // 仅当前路由：避免 SPA 切页后仍把上一页条目打进同一批请求
      if (item.pathname !== getRouteKey()) {
        continue
      }
      if (!isPendingTranslateItem(item)) {
        continue
      }
      // 按需翻译：仅请求可视区内待译条目
      if (!isItemInViewport(item)) {
        continue
      }
      chineseList.push({
        index: item.key,
        chinese: item.composite ? getCompositeRequestText(item) : item.chinese
      })
      // 注意：尝试次数不在这里累计。这里只是"准备请求"，批次可能因串行排队被丢弃、
      // 也可能刚发出就被切语言 abort；那些都不算"翻译不出来"，否则高频切换会很快撞上
      // times>=3 而永久不再请求。真正发出请求时才在 onFetch 里计数。
    }
    if (chineseList.length === 0) {
      return
    }

    onFetch(chineseList)
  }, 300)

  /** 请求失败时解除所有条目的 loading，并记录 error（避免永远卡在 loading） */
  function resetTextLoading(chineseList, error) {
    const batchKeys = {}
    for (let i = 0; i < chineseList.length; i++) {
      batchKeys[chineseList[i].index] = true
    }
    for (let key in getNodeDataMap()) {
      const item = getNodeDataMap()[key]
      if (!batchKeys[item.key]) {
        continue
      }
      item.error = error
      item.loading = false
    }
  }

  /**
   * 按接口约定解析流式文本：[index] 起至下一个 [index] 或流结束前的所有行同属一条译文
   * @returns {{ entries: string[], remainder: string }}
   */
  function parseIndexedTranslationStream(buffer, isFinal) {
    const entries = []
    if (!buffer) {
      return {entries: entries, remainder: ''}
    }
    let text = buffer
    let remainder = ''
    if (!isFinal) {
      const lastNewline = text.lastIndexOf('\n')
      if (lastNewline === -1) {
        return {entries: entries, remainder: text}
      }
      remainder = text.slice(lastNewline + 1)
      text = text.slice(0, lastNewline + 1)
    }
    const lines = text.split('\n')
    let currentKey = null
    let contentLines = []
    /**
     * 还没有 [index] 前缀的裸文本。单条请求时接口经常直接返回译文（如请求 [0]你好、返回 Hello），
     * 旧实现把这类行直接丢掉，normalizeTranslationLines 根本没有机会补上前缀。
     * 这里原样产出（不带 [index]），由 normalizeTranslationLines 在"本批只有一条"时补 [0]。
     */
    let preludeLines = []

    function flush() {
      if (currentKey === null) {
        return
      }
      entries.push('[' + currentKey + ']' + contentLines.join('\n'))
      currentKey = null
      contentLines = []
    }

    function flushPrelude() {
      if (!preludeLines.length) {
        return
      }
      entries.push(preludeLines.join('\n'))
      preludeLines = []
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === '' && i === lines.length - 1 && text.endsWith('\n')) {
        continue
      }
      const m = line.match(/^\[(\d+)\]\s*(.*)$/)
      if (m) {
        flushPrelude()
        flush()
        currentKey = m[1]
        contentLines = m[2] ? [m[2]] : []
      } else if (currentKey !== null) {
        contentLines.push(line)
      } else {
        // 尚未出现任何 [index]：先当裸文本收着（单条请求返回纯译文的情况）
        preludeLines.push(line)
      }
    }

    if (isFinal) {
      flushPrelude()
      flush()
      if (remainder) {
        const rm = remainder.match(/^\[(\d+)\]\s*(.*)$/)
        if (rm) {
          entries.push('[' + rm[1] + ']' + (rm[2] || ''))
          remainder = ''
        }
      }
    } else if (currentKey !== null) {
      // 非 final：末尾残片(remainder)已经切走，所以要区分两种情况
      // 1) 残片为空或已是下一个 [index] 的开头 → 当前条目已被换行结束，必须直接 flush；
      //    旧实现无条件把它当作「未完成条目」回填 remainder，导致同一份内容既被 flush 又被回填，
      //    下一个条目开头会被粘上来（如 "[12]Hot Pot[13]All Categories"），
      //    既污染上一条译文，又让后面那条永远拿不到自己的译文。
      // 2) 残片是当前条目的续行 → 才需要拼回未完成条目
      if (!remainder || /^\[\d+\]/.test(remainder)) {
        flush()
      } else {
        const partial = '[' + currentKey + ']' + contentLines.join('\n')
        remainder = partial + (partial && remainder ? '\n' : '') + remainder
      }
    } else {
      // 只有裸文本（无 [index]）：它们属于同一条译文（单条请求返回纯译文），
      // 不能在这里就产出——流式分片时后续片段会覆盖前面的内容（曾出现只写到最后一段 "lo"）。
      // 把已累积内容放回 remainder，等流结束或出现 [index] 时一次性产出。
      const prelude = preludeLines.join('\n')
      preludeLines = []
      remainder = prelude + (prelude && remainder ? '\n' : '') + remainder
    }
    return {entries: entries, remainder: remainder}
  }

  /**
   * 是否为可写入 DOM 的译文（仅辅助过滤明显异常，不改变 [index]行 的解析规则）
   * 过滤：空串、译文恰好等于序号 key；保留 2020年 -> 2020 等数字年份
   */
  function isValidTranslationText(text, item) {
    const t = (text || '').trim()
    if (!t) {
      return false
    }
    if (item && String(item.key) === t) {
      return false
    }
    if (/^\d+$/.test(t) && item) {
      const chinese = (item.chinese || '').trim()
      const full = (item.fullChinese || '').trim()
      if (/\d/.test(chinese) || /\d/.test(full)) {
        return true
      }
      if (t.length <= 2) {
        return false
      }
    }
    return true
  }

  /** 解析 SSE/流式 body：按行 "[index]译文\n" 切割后回调；流未结束前不写 DOM */
  function onStreamData(res, callback) {
    let body = res.body;
    let hasReader = body && typeof body.getReader === 'function';
    if (hasReader && typeof TextDecoder === 'function') {
      let reader = body.getReader();
      let decoder = new TextDecoder('utf-8');
      let streamBuf = '';
      /**
       * 收尾只允许一次：后端会在流末尾发一个 [DONE] 帧，随后 reader 还会再报 done，
       * 两处都会走到 processBuffer(true)。重复收尾会重复写 DOM、重复 finishActiveFetch（多触发一次补扫）。
       */
      let doneEmitted = false;

      function emit(lines, isDone) {
        if(lines.length) {
          // 加【接口返回】前缀：返回值与入参内容相同时（例如接口原样返回）也能和请求日志区分开
          logger('【接口返回】\n' + lines.join('\n'));
        }
        callback(lines, isDone)
      }

      function processBuffer(isFinal) {
        if (doneEmitted) {
          return
        }
        // 插件版：transport 给的就是模型纯文本，无需剥离 SSE 前缀
        let buf = streamBuf || ''
        const isDone = isFinal || buf.indexOf('[DONE]') !== -1
        buf = buf.replace(/\[DONE\]/g, '')
        const parsed = parseIndexedTranslationStream(buf, isFinal || isDone)
        streamBuf = parsed.remainder
        if (parsed.entries.length) {
          emit(parsed.entries, false)
        }
        if (isDone) {
          doneEmitted = true
          streamBuf = ''
          emit([], true)
        }
      }

      function readNext() {
        reader.read().then(function (result) {
          if (result.done) {
            processBuffer(true)
            return
          }
          const chunk = decoder.decode(result.value, {stream: true})
          if (chunk && chunk.indexOf('<!doctype') !== -1) {
            throw new Error('接口返回了 HTML 内容，请检查接口地址是否正确');
          }
          streamBuf += chunk
          processBuffer(false)
          readNext()
        }).catch(function (e) {
          logger(e)
        });
      }

      readNext();
    }
  }

  /** 将 item.nodeTranslate 写回所有匹配 selector / nodeRef 的 DOM 节点 */
  function setTextInDom(item) {
    if (!isValidTranslationText(item.nodeTranslate, item)) {
      return
    }
    // 中文模式下绝不写译文：业务可能在切回中文后仍调用回显接口，或迟到回调在此刻触发，
    // 一旦写入就会把已经回滚好的中文页面又变回英文（表现为"部分英文无法恢复中文"）
    if (getLanguage() === 'zh') {
      return
    }

    item.selectors.forEach(function (sel) {
      if (sel.pathname && sel.pathname !== getRouteKey()) {
        return
      }
      const node = resolveSelectorNode(sel)
      if (node) {
        writeTranslateToNode(node, item)
      }
    })
  }

  /**
   * 单条请求时接口偶发省略 [index] 前缀（如返回 "Mall" 而非 "[0]Mall"），补全后再解析
   * @param {string[]} lines
   * @param {number|null} singleIndex 本批请求仅一条时为 item.key，否则为 null
   */
  function normalizeTranslationLines(lines, singleIndex) {
    if (singleIndex == null || !lines || !lines.length) {
      return lines
    }
    return lines.map(function (line) {
      const raw = String(line)
      if (!raw.trim()) {
        return line
      }
      if (/^\[\d+\]/.test(raw)) {
        return raw
      }
      return '[' + singleIndex + ']' + raw
    })
  }

  function getItemRequestText(item) {
    if (!item) {
      return ''
    }
    return item.composite ? getCompositeRequestText(item) : (item.chinese || '')
  }

  /** 待译批次按请求文案去重：同文案只发一条，保留 index 映射供回显 */
  function dedupeFetchChineseList(chineseList) {
    const textToIndices = Object.create(null)
    for (let i = 0; i < chineseList.length; i++) {
      const entry = chineseList[i]
      const text = entry.chinese
      if (!textToIndices[text]) {
        textToIndices[text] = []
      }
      textToIndices[text].push(entry.index)
    }
    const deduped = []
    const aliases = Object.create(null)
    for (const text in textToIndices) {
      const indices = textToIndices[text].sort(function (a, b) { return a - b })
      const rep = indices[0]
      deduped.push({ index: rep, chinese: text })
      aliases[rep] = indices
    }
    deduped.sort(function (a, b) { return a.index - b.index })
    return { deduped: deduped, aliases: aliases }
  }

  function getFetchAliasKeys(key) {
    if (!activeFetchIndexAliases) {
      return [key]
    }
    if (activeFetchIndexAliases[key]) {
      return activeFetchIndexAliases[key]
    }
    return [key]
  }

  function clearActiveFetchIndexAliases() {
    activeFetchIndexAliases = null
  }

  function applySourceTranslateToItem(item, mapKey, sourceTranslateRaw, writeDom) {
    let sourceTranslate = sourceTranslateRaw
    if (item.composite) {
      sourceTranslate = stripTranslationHtmlForApply(sourceTranslate)
    }
    if (!sourceTranslate || !isValidTranslationText(sourceTranslate, item)) {
      return
    }
    if (!item.sourceTranslate.includes(sourceTranslate)) {
      item.sourceTranslate.push(sourceTranslate)
    }
    let realTranslate = item.composite
        ? sourceTranslate
        : item.fullChinese.replace(mapKey, sourceTranslate)
    if (!item.composite && realTranslate === item.fullChinese) {
      realTranslate = sourceTranslate
    }
    if (!isValidTranslationText(realTranslate, item)) {
      return
    }
    item.nodeTranslate = realTranslate
    item.loading = false
    syncTranslateSkeleton(item)
    if (item.pathname !== getRouteKey()) {
      return
    }
    if (writeDom) {
      setTextInDom(item)
    }
  }

  /**
   * 解析流式返回的文本，按 [index]content 块更新 dataMap（content 可含换行，直至下一个 [index]）
   * @param {Array<string>} translateList 完整块，如 "[1]第一行\n第二行"
   * @param {boolean} writeDom 流未结束前为 false，仅更新内存
   */
  function applyTranslationResult(translateList, writeDom) {
    for (let li = 0; li < translateList.length; li++) {
      const line = translateList[li];
      const match = String(line).match(/^\[(\d+)\]\s*([\s\S]*)$/);
      if (!match) continue;

      const key = Number(match[1]);
      const sourceTranslateRaw = match[2].replace(/^\s+/, '').replace(/\s+$/, '');
      if (!sourceTranslateRaw) {
        continue
      }

      const aliasKeys = getFetchAliasKeys(key)
      for (let ai = 0; ai < aliasKeys.length; ai++) {
        const targetKey = aliasKeys[ai]
        for (let chinese in getNodeDataMap()) {
          const item = getNodeDataMap()[chinese]
          if (item.key !== targetKey) {
            continue
          }
          applySourceTranslateToItem(item, chinese, sourceTranslateRaw, writeDom)
        }
      }
    }
    if (writeDom) {
      applyCachedTranslationsInRoot(document.body)
    }
  }

  /**
   * 不发起网络请求：把 nodeDataMap 已有译文刷到当前页 DOM（含弹框等动态节点）
   */
  function flashAllText() {
    // zh 模式下不允许回显译文（业务可能在切回中文后仍调用该接口）
    if (getLanguage() === 'zh') {
      return
    }
    for (let chinese in getNodeDataMap()) {
      const item = getNodeDataMap()[chinese]
      if (item.pathname === getRouteKey() && isValidTranslationText(item.nodeTranslate, item)) {
        setTextInDom(item)
      }
    }
    applyCachedTranslationsInRoot(document.body)
  }

  /**
   * 流式请求结束：释放锁并触发 onTranslate 捞剩余/排队文案（仍串行，不会并发 fetch）
   * @param {boolean} skipNext 切页 abort 时为 true，由 scanPageContent 另行触发
   */
  function finishActiveFetch(skipNext) {
    state.isLoading = false
    showLoading(false)
    state.translateQueuePending = false
    clearActiveFetchIndexAliases()
    if (skipNext) {
      return
    }
    onTranslate()
  }

  /** 中止进行中的翻译请求并重置 loading，不断开 DOM Observer */
  function abortActiveTranslations(reason) {
    abortControllerList.forEach(function (i, index) {
      if (i) {
        i.abort()
        abortControllerList[index] = null
      }
    })
    abortControllerList = []
    activeFetchGeneration++
    clearActiveFetchIndexAliases()
    state.isLoading = false
    state.translateQueuePending = false
    showLoading(false)
    for (let rk in routeNodeDataCache) {
      resetRouteLoadingFlags(rk)
    }
  }

  /**
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

  /** 批量请求翻译接口；单用户串行，进行中则标记排队而非并发 fetch */
  function onFetch(chineseList) {
    if (!chineseList || chineseList.length === 0) {
      return
    }

    if (state.isLoading) {
      state.translateQueuePending = true
      return
    }

    // 同步加锁，避免两次 onFetch 在置位前同时通过校验导致并发
    state.isLoading = true
    showLoading(true)

    const dedupeResult = dedupeFetchChineseList(chineseList)
    const fetchList = dedupeResult.deduped
    activeFetchIndexAliases = dedupeResult.aliases

    const lang = getLanguage()
    const singleRequestIndex = fetchList.length === 1 ? fetchList[0].index : null
    const text = fetchList
    .sort((a, b) => a.index - b.index)
    .map(i => '[' + i.index + ']' + i.chinese)
    .join('\n')

    const abortController = new AbortController()
    abortControllerList = [abortController]
    const fetchGen = activeFetchGeneration
    const data = {
      text, // 需要翻译的文案内容
      sourceLang: "zh", // 原始语言
      targetLang: lang, // 目标语言
      orderType: hostname + location.pathname, // 缓存标志：订单类型/场景类型，用于缓存区分
      ...(isCxa || state.userInfo.eid ? {eid: state.userInfo.eid} : {})
    }
    // 加【请求入参】前缀：与返回日志区分（内容相同时也能分辨哪条是请求、哪条是返回）
    logger('【请求入参】' + fetchList.length + ' 条，目标语言 ' + lang + '\n' + text)
    chineseList.forEach(function (entry) {
      for (let chinese in getNodeDataMap()) {
        const item = getNodeDataMap()[chinese]
        if (item.key === entry.index) {
          item.loading = true
          // 请求真正发出时才计一次尝试（被 abort 时 resetRouteLoadingFlags 会清零）
          item.times = (item.times || 0) + 1
          break
        }
      }
    })

    engineFetchModel(data, abortController.signal).then(res => {
      if (fetchGen !== activeFetchGeneration) {
        return
      }
      if (res.status !== 200) {
        logger('翻译请求错误：', res.status, res.statusText);
        resetTextLoading(chineseList, res.statusText)
        finishActiveFetch()
        return
      }
      onStreamData(res, function (lines, isDone) {
        if (fetchGen !== activeFetchGeneration) {
          return
        }
        if (lines && lines.length) {
          // 按行解析，流式过程中只更新 nodeDataMap，不写 DOM
          applyTranslationResult(normalizeTranslationLines(lines, singleRequestIndex), false)
        }

        // 本批流结束后再写入 DOM，并继续扫描是否有新增中文
        if (isDone) {
          if (fetchGen !== activeFetchGeneration) {
            return
          }
          // 流结束后写 DOM：selector/nodeRef + 按原文全页匹配（覆盖弹框）
          for (let chinese in getNodeDataMap()) {
            const item = getNodeDataMap()[chinese]
            if (item.pathname === getRouteKey() && isValidTranslationText(item.nodeTranslate, item)) {
              setTextInDom(item)
            }
          }
          applyCachedTranslationsInRoot(document.body)
          finishActiveFetch()
        }
      })
    }).catch(err => {
      if (fetchGen !== activeFetchGeneration) {
        return
      }
      // run/切页 abortActiveTranslations 会 abort，属正常；不再触发排队补发（由 scanPageContent 触发）
      if (err && err.name === 'AbortError') {
        logger('翻译请求已中断')
        for (let rk in routeNodeDataCache) {
          resetRouteLoadingFlags(rk)
        }
        finishActiveFetch(false)
        return
      }
      logger('翻译请求异常：', err)
      resetTextLoading(chineseList, err && err.message ? err.message : 'fetch error')
      finishActiveFetch()
    })
  }

  /**
   * 将指定路由桶内已写入 DOM 的译文恢复为中文（语言切回 zh 等场景；SPA 切页时不调用，避免闪中文）
   * @param {string} routeKey getRouteKey() 或 lastPathname
   */
  function revertTranslationsForRoute(routeKey) {
    if (!routeKey) {
      return
    }
    const map = routeNodeDataCache[routeKey]
    if (!map) {
      return
    }
    for (let key in map) {
      const item = map[key]
      item.selectors.forEach(function (sel) {
        if (sel.pathname !== routeKey) {
          return
        }
        const node = resolveSelectorNode(sel)
        if (!node || !shouldReverseNode(node, item)) {
          return
        }
        writeRevertToNode(node, item)
      })
    }
  }

  /** 语言切回 zh 时：仅回滚当前路由下、shouldReverseNode 判定为已译的节点 */
  function reverseChinese() {
    for (let key in getNodeDataMap()) {
      const item = getNodeDataMap()[key]
      if (item.pathname !== getRouteKey()) {
        continue
      }

      item.selectors.forEach(i => {
        if (i.pathname && i.pathname !== getRouteKey()) {
          return
        }
        const node = resolveSelectorNode(i)
        if (!node || !shouldReverseNode(node, item)) {
          return
        }
        writeRevertToNode(node, item)
      })
    }
    Array.from(document.querySelectorAll('[data-translate-hidden]')).forEach(i => {
      i.style.removeProperty('display')
    })
    // 其它路由桶里写过的译文也要回滚：筛选条件/查询串变化会改变 getRouteKey，
    // 框架复用 DOM 时旧路由写入的英文会留在新路由的页面上，只回滚当前桶就会"部分英文切不回中文"。
    // （selector 解析 + shouldReverseNode 都是"当前文案必须等于该条译文"的精确判定，不会误改其它文案）
    for (let rk in routeNodeDataCache) {
      if (rk === getRouteKey()) {
        continue
      }
      revertTranslationsForRoute(rk)
    }
    // 补充：按译文匹配 DOM，覆盖 selector 失效或虚拟列表回收后仍残留英文的节点
    applyRevertTranslationsInRoot(document.body, false)
  }

  function resetMutationBatch() {
    mutationBatch.added = new Set()
    mutationBatch.removed = new Set()
    mutationBatch.hasChildList = false
  }

  /** 清空全部路由译文缓存（语言关闭等场景） */
  function clearTranslationCache() {
    clearAllRouteNodeCache()
    state.cacheData = {}
    state.translateQueuePending = false
    resetMutationBatch()
  }

  /** 路由切换后延迟扫描，等新页 DOM 替换后再采集/回显 */
  function scheduleRouteScanAfterChange() {
    if (routeScanTimer) {
      clearTimeout(routeScanTimer)
    }
    routeScanTimer = setTimeout(function () {
      routeScanTimer = null
      if (!isOpenTranslate() || getLanguage() === 'zh') {
        return
      }
      if (getRouteKey() !== lastPathname) {
        return
      }
      scanPageContent()
    }, 120)
  }

  function isApplyingDom() {
    return applyingDomDepth > 0
  }

  function runWithoutDomObserver(fn) {
    applyingDomDepth++
    try {
      fn()
    } finally {
      applyingDomDepth--
    }
  }

  /** 计算应写入节点的最终译文 */
  function getExpectedTranslate(item) {
    if (item.composite) {
      return item.nodeTranslate
    }
    const {fullChinese, chinese, nodeTranslate} = item
    let translate = fullChinese.replace(chinese, nodeTranslate)
    if (translate === fullChinese) {
      translate = nodeTranslate
    }
    return translate
  }

  /** DOM 已是目标译文时不再写入，避免重复赋值触发 Observer */
  function isDomSynced(node, item) {
    if (!node || !item || !item.nodeTranslate) {
      return false
    }
    if (item.composite && node.nodeType === Node.ELEMENT_NODE) {
      return isCompositeDomSynced(node, item)
    }
    const expected = getExpectedTranslate(item)
    const current = getNodeText(node)
    return current === expected || current.trim() === String(expected).trim()
  }

  function shouldScanElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      return false
    }
    return !SKIP_SCAN_TAGS.includes(el.tagName.toLowerCase())
  }

  /**
   * 同一批次里若父、子同时新增，只扫最外层根，避免重复遍历子树
   */
  function normalizeAddedRoots(nodeSet) {
    const list = Array.from(nodeSet)
    return list.filter(function (node) {
      return !list.some(function (other) {
        return other !== node && other.contains && other.contains(node)
      })
    })
  }

  /** 节点已从文档移除时，剔除 nodeDataMap 中失效的 selector，避免脏数据 */
  function pruneStaleSelectors() {
    const routeKey = getRouteKey()
    for (let key in getNodeDataMap()) {
      const item = getNodeDataMap()[key]
      item.selectors = item.selectors.filter(function (sel) {
        if (sel.pathname && sel.pathname !== routeKey) {
          return true
        }
        return !!resolveSelectorNode(sel)
      })
    }
  }

  /** 仅扫描可视区内文案（滚动、增量补扫） */
  function scanViewportContent() {
    if (!isOpenTranslate() || getLanguage() === 'zh') {
      return
    }
    findText(document.body, true)
    findInput(document.body, true)
  }

  function clearDeferredContentScanTimers() {
    for (let i = 0; i < deferredScanTimers.length; i++) {
      clearTimeout(deferredScanTimers[i])
    }
    deferredScanTimers = []
  }

  /**
   * 刷新/首屏后延迟补扫：移动端布局、地址栏、FloatBubble 配置常晚于 pageshow
   * 不经过 run/clearListener，避免 abort 进行中的翻译请求
   */
  function scheduleDeferredContentScan() {
    clearDeferredContentScanTimers()
    function tick() {
      if (!isOpenTranslate() || getLanguage() === 'zh') {
        return
      }
      scanPageContent()
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        requestAnimationFrame(tick)
      })
    }
    deferredScanTimers.push(setTimeout(tick, 300))
    deferredScanTimers.push(setTimeout(tick, 1000))
  }

  /** 仅扫描新增/变更的子树，不触发全页 walk；仅登记可视区内节点 */
  function scanAddedRoot(node) {
    if (!node) {
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      if (hasChinese(node.nodeValue) && isTranslatableNodeInViewport(node)) {
        setOneNode(node)
      }
      return
    }
    if (shouldScanElement(node)) {
      findText(node, true)
      findInput(node, true)
      // findText 内部的 findInlineCompositeBlocks 用的是 TreeWalker（不包含 root 自身），
      // 若新增节点本身就是行内复合块（如 <span>营业时间</span>&nbsp;9:00-16:30），
      // 它的内层文本会被 FILTER_REJECT、自身又不会被遍历到，导致整块漏登记、一直保持中文。
      // 这里补一次 root 自身的复合块登记（非复合块会内部直接 return，无副作用）。
      setOneCompositeNode(node)
    }
  }

  /**
   * 合并一批 MutationRecord 后增量处理：清理移除节点登记 -> 扫新增根 -> 刷缓存 -> 请求翻译
   */
  function flushMutationBatch() {
    if (!isOpenTranslate() || getLanguage() === 'zh') {
      resetMutationBatch()
      return
    }
    const added = mutationBatch.added
    const removed = mutationBatch.removed
    const hasChildList = mutationBatch.hasChildList
    resetMutationBatch()

    if (removed.size) {
      pruneStaleSelectors()
    }

    const roots = normalizeAddedRoots(added)
    if (roots.length) {
      roots.forEach(scanAddedRoot)
      roots.forEach(function (root) {
        applyCachedTranslationsInRoot(root)
      })
      // 有新增 DOM 或仍有未译条目时才请求；不在每次回显后 flashAllText
      if (hasChildList || hasPendingTranslateWork()) {
        onTranslate()
      }
    }
  }

  const debouncedFlushMutationBatch = debounce(flushMutationBatch, 120)

  /** 滚动/resize：非中文时补扫可视区并翻译；中文时补扫可视区并恢复中文 */
  const debouncedOnViewportScroll = debounce(function () {
    if (!isOpenTranslate()) {
      return
    }
    if (getLanguage() === 'zh') {
      applyRevertTranslationsInRoot(document.body, true)
      return
    }
    scanViewportContent()
    flashAllText()
    onTranslate()
  }, 150)

  function hookViewportScroll() {
    if (viewportScrollHooked) {
      return
    }
    viewportScrollHooked = true
    document.addEventListener('scroll', debouncedOnViewportScroll, {passive: true, capture: true})
    window.addEventListener('scroll', debouncedOnViewportScroll, {passive: true})
    window.addEventListener('resize', debouncedOnViewportScroll, {passive: true})
    const vv = window.visualViewport
    if (vv) {
      vv.addEventListener('resize', debouncedOnViewportScroll, {passive: true})
      vv.addEventListener('scroll', debouncedOnViewportScroll, {passive: true})
    }
  }

  function unhookViewportScroll() {
    if (!viewportScrollHooked) {
      return
    }
    viewportScrollHooked = false
    document.removeEventListener('scroll', debouncedOnViewportScroll, {capture: true})
    window.removeEventListener('scroll', debouncedOnViewportScroll)
    window.removeEventListener('resize', debouncedOnViewportScroll)
    const vv = window.visualViewport
    if (vv) {
      vv.removeEventListener('resize', debouncedOnViewportScroll)
      vv.removeEventListener('scroll', debouncedOnViewportScroll)
    }
  }

  /** 获取或创建 title 元素内的文本节点，供 setOneNode / writeTranslateToNode 使用 */
  function ensureTitleTextNode() {
    const titleEl = document.querySelector('title')
    if (!titleEl) {
      return null
    }
    for (let i = 0; i < titleEl.childNodes.length; i++) {
      const node = titleEl.childNodes[i]
      if (node.nodeType === Node.TEXT_NODE) {
        return node
      }
    }
    const text = document.title
    if (!text) {
      return null
    }
    runWithoutDomObserver(function () {
      titleEl.appendChild(document.createTextNode(text))
    })
    return titleEl.firstChild
  }

  /** 扫描并登记页面标题（document.title 不在 body 子树内，需单独处理） */
  function scanPageTitle() {
    if (!isOpenTranslate() || getLanguage() === 'zh') {
      return
    }
    const title = (document.title || '').trim()
    if (!title || !hasChinese(title)) {
      return
    }
    const textNode = ensureTitleTextNode()
    if (textNode) {
      setOneNode(textNode)
    }
  }

  /** 监听 title 文案变化；title 元素晚挂载时改监听 head childList */
  function listenTitleChange() {
    if (!isOpenTranslate() || getLanguage() === 'zh') {
      return
    }
    if (listenTitleHandler) {
      return
    }

    function onTitleMutated() {
      if (!isOpenTranslate() || getLanguage() === 'zh' || isApplyingDom()) {
        return
      }
      scanPageTitle()
      flashAllText()
      onTranslate()
    }

    function observeTitleEl(titleEl) {
      if (!titleEl || listenTitleHandler) {
        return
      }
      listenTitleHandler = new MutationObserver(function () {
        onTitleMutated()
      })
      listenTitleHandler.observe(titleEl, {
        childList: true,
        characterData: true,
        subtree: true,
      })
      scanPageTitle()
    }

    const titleEl = document.querySelector('title')
    if (titleEl) {
      observeTitleEl(titleEl)
      return
    }

    const head = document.head
    if (!head) {
      return
    }
    listenTitleHandler = new MutationObserver(function (mutationsList) {
      if (!isOpenTranslate() || getLanguage() === 'zh' || isApplyingDom()) {
        return
      }
      for (let mi = 0; mi < mutationsList.length; mi++) {
        const mutation = mutationsList[mi]
        if (mutation.type !== 'childList') {
          continue
        }
        mutation.addedNodes.forEach(function (node) {
          if (node && node.nodeType === Node.ELEMENT_NODE && node.tagName && node.tagName.toLowerCase() === 'title') {
            listenTitleHandler.disconnect()
            listenTitleHandler = null
            observeTitleEl(node)
          }
        })
      }
    })
    listenTitleHandler.observe(head, {childList: true})
  }

  /** 路由切换后延迟补扫标题（部分 SPA 异步设置 document.title） */
  function scheduleTitleScanAfterRoute() {
    if (titleRouteTimer) {
      clearTimeout(titleRouteTimer)
      titleRouteTimer = null
    }
    titleRouteTimer = setTimeout(function () {
      titleRouteTimer = null
      if (!isOpenTranslate() || getLanguage() === 'zh') {
        return
      }
      scanViewportContent()
      scanPageTitle()
      flashAllText()
      onTranslate()
    }, 1000)
  }

  /**
   * 全页扫描：用于首屏 run、路由切换等「整页替换」场景（登记全页文案，请求仍按可视区过滤）
   * 日常动态内容由 MutationObserver 增量 scanAddedRoot 覆盖
   */
  function scanPageContent() {
    if (!isOpenTranslate() || getLanguage() === 'zh') {
      return
    }
    findText(document.body, false)
    findInput(document.body, false)
    scanPageTitle()
    flashAllText()
    onTranslate()
  }

  /** SPA 路由变化：中止旧请求 -> 切换路由桶 -> 延迟扫描新页（不回滚可见 DOM，避免切页闪中文） */
  function onRouteChange() {
    const apply = function () {
      const routeKey = getRouteKey()
      if (routeKey !== lastPathname) {
        abortActiveTranslations('route')
        resetMutationBatch()
        lastPathname = routeKey
        pruneRouteNodeCache(routeKey)
        scheduleRouteScanAfterChange()
        scheduleTitleScanAfterRoute()
        return
      }
      abortActiveTranslations('route')
      scanPageContent()
      scheduleTitleScanAfterRoute()
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(apply)
    } else {
      setTimeout(apply, 0)
    }
  }

  /** 劫持 pushState/replaceState，并监听 popstate/hashchange（pageshow 对 SPA 内跳转不一定触发） */
  function hookHistory() {
    if (historyHooked) {
      return
    }
    historyHooked = true
    const rawPush = history.pushState
    const rawReplace = history.replaceState
    history.pushState = function () {
      rawPush.apply(history, arguments)
      onRouteChange()
    }
    history.replaceState = function () {
      rawReplace.apply(history, arguments)
      onRouteChange()
    }
    window.addEventListener('popstate', onRouteChange)
    window.addEventListener('hashchange', onRouteChange)
  }

  /**
   * 将单条 Mutation 记入批次队列，由 debouncedFlushMutationBatch 统一去重后扫描
   * 不在这里直接 findText(document.body)，避免与增量逻辑重复
   */
  function enqueueMutationRecord(mutation) {
    if (isApplyingDom()) {
      return
    }
    if (mutation.type === 'childList') {
      mutationBatch.hasChildList = true
      mutation.addedNodes.forEach(function (node) {
        if (!node) {
          return
        }
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          mutationBatch.added.add(node)
        }
      })
      mutation.removedNodes.forEach(function (node) {
        if (!node) {
          return
        }
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          mutationBatch.removed.add(node)
        }
      })
    } else if (mutation.type === 'characterData') {
      const target = mutation.target
      if (target && hasTranslateSkipAncestor(target)) {
        return
      }
      const trimmed = (target.nodeValue || '').trim()
      if (target && hasChinese(trimmed)) {
        const item = resolveItemByNodeText(target.nodeValue || '', trimmed)
        if (item) {
          reapplyCachedTranslationIfNeeded(target, item)
        }
        mutationBatch.added.add(target)
      }
    } else if (mutation.type === 'attributes') {
      const target = mutation.target
      if (!target || target.nodeType !== Node.ELEMENT_NODE) {
        return
      }
      if (mutation.attributeName === 'placeholder') {
        mutationBatch.added.add(target)
      } else if (mutation.attributeName === 'style' || mutation.attributeName === 'class') {
        // 仅入队，交由防抖批次统一回显。旧实现在这里同步遍历目标子树，
        // 动画/轮播/弹框每次改 class|style 都会触发一次全子树 TreeWalker，是主要性能瓶颈之一。
        if (hasChinese(target.textContent || '')) {
          mutationBatch.added.add(target)
        }
      }
    }
  }

  /**
   * 切页或重跑 run 前清理：abort 进行中的翻译、重置 loading
   * 仅当语言为 zh 时断开 MutationObserver（非中文切页需保持监听）
   */
  function clearListener() {
    abortActiveTranslations('clearListener')
    clearDeferredContentScanTimers()
    if (routeScanTimer) {
      clearTimeout(routeScanTimer)
      routeScanTimer = null
    }
    if (titleRouteTimer) {
      clearTimeout(titleRouteTimer)
      titleRouteTimer = null
    }
    if (listenTitleHandler) {
      listenTitleHandler.disconnect()
      listenTitleHandler = null
    }
    unhookViewportScroll()
    const lang = getLanguage()
    if (lang === 'zh') {
      if (listenDomHandler) {
        listenDomHandler.disconnect()
        listenDomHandler = null
      }
      resetMutationBatch()
    }
  }

  /**
   * 注册 document.body 单例 MutationObserver（subtree: true）
   * 仅 enqueue 增删节点，防抖后增量 scanAddedRoot；避免多 Observer 重复监听同一子树
   */
  function listenDomChnage() {
    if (!isOpenTranslate() || getLanguage() === 'zh') {
      return
    }
    if (listenDomHandler) {
      return
    }
    listenDomHandler = new MutationObserver(function (mutationsList) {
      if (!isOpenTranslate() || getLanguage() === 'zh' || isApplyingDom()) {
        return
      }
      for (let mi = 0; mi < mutationsList.length; mi++) {
        enqueueMutationRecord(mutationsList[mi])
      }
      debouncedFlushMutationBatch()
    });

    listenDomHandler.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['placeholder', 'style', 'class'],
    });
  }

  /**
   * 翻译主入口：语言切换、pageshow、FloatBubble.languageAiChange 都会调用
   * zh：回滚中文并停监听；非 zh：挂 history、单例 DOM 监听、首屏全页扫一次
   */
  function run() {
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
  }

  /** 供插件 content.js 调用：注入/更新配置 */
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

  /** 供业务在接口渲染完成后手动触发：aiTranslateHandler.scanPageContent() */
  window.aiTranslateHandler = {
    run,
    reverseChinese,
    getCookie,
    getLanguage,
    isOpenTranslate,
    findInput,
    findText,
    state,
    logger,
    applyTranslationResult,
    flashAllText,
    hasChinese,
    scanPageContent,
    scanViewportContent,
    scanPageTitle,
    isTranslatableNodeInViewport,
    isItemInViewport,
    hasTranslateSkipAncestor,
    isNumericOnlyChange,
    pruneStaleSelectors,
    abortActiveTranslations,
    getRouteKey,
    revertTranslationsForRoute,
    applyCachedTranslationsInRoot,
    showLoading,
  }
  /** 插件版：启动/停止完全由 content.js 控制，不在页面加载时自动跑 */
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

})();

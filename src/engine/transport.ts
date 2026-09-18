/**
 * 传输层调用与请求编排
 *
 * 由 ai-translate-engine.js 拆分而来（原 L3337-L3485），函数体保持原样，仅补类型与导入导出。
 */
import { resetTextLoading } from './batch';
import { applyCachedTranslationsInRoot } from './bulk-apply';
import { getLanguage, getNodeDataMap, getRouteKey, resetRouteLoadingFlags } from './cache';
import { logger, showLoading } from './logger';
import { isValidTranslationText } from './parser';
import { hostname, isCxa, runtime, state } from './state';
import { applyTranslationResult, dedupeFetchChineseList, finishActiveFetch, normalizeTranslationLines, onStreamData, setTextInDom } from './stream';

/**
 * 把模型直连包装成 fetch(Response) 形状：onStreamData 仍然按"读 reader"的方式消费，
 * 于是流式解析、代次校验、abort 处理、错误处理逻辑全部复用上游实现。
 */
function engineFetchModel( data: { text: string; targetLang?: string }, signal: AbortSignal) {
  if (!runtime.engineTransport || typeof runtime.engineTransport.translate !== 'function') {
    return Promise.reject(new Error('翻译引擎未连接（transport 缺失）'))
  }
  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null
  let closed = false
  const stream = new ReadableStream({
    start(controller) {
      const safeEnqueue = function (chunk: string) {
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
      const safeError = function (message: string) {
        if (closed) return
        closed = true
        const err = new Error(message || 'model error')
        err.name = (message === 'aborted' || message === 'AbortError') ? 'AbortError' : 'Error'
        try { controller.error(err) } catch (e) { /* ignore */ }
      }
      runtime.engineTransport!.translate(String(data.text || ''), {
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
export function onFetch( chineseList: { index: string | number; chinese: string }[]) {
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
  runtime.activeFetchIndexAliases = dedupeResult.aliases

  const lang = getLanguage()
  const singleRequestIndex = fetchList.length === 1 ? fetchList[0].index : null
  const text = fetchList
  .sort((a, b) => a.index - b.index)
  .map(i => '[' + i.index + ']' + i.chinese)
  .join('\n')

  const abortController = new AbortController()
  runtime.abortControllerList = [abortController]
  const fetchGen = runtime.activeFetchGeneration
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
    if (fetchGen !== runtime.activeFetchGeneration) {
      return
    }
    if (res.status !== 200) {
      logger('翻译请求错误：', res.status, res.statusText);
      resetTextLoading(chineseList, res.statusText)
      finishActiveFetch()
      return
    }
    onStreamData(res, function (lines, isDone) {
      if (fetchGen !== runtime.activeFetchGeneration) {
        return
      }
      if (lines && lines.length) {
        // 按行解析，流式过程中只更新 nodeDataMap，不写 DOM
        applyTranslationResult(normalizeTranslationLines(lines, singleRequestIndex), false)
      }

      // 本批流结束后再写入 DOM，并继续扫描是否有新增中文
      if (isDone) {
        if (fetchGen !== runtime.activeFetchGeneration) {
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
    if (fetchGen !== runtime.activeFetchGeneration) {
      return
    }
    // run/切页 abortActiveTranslations 会 abort，属正常；不再触发排队补发（由 scanPageContent 触发）
    if (err && err.name === 'AbortError') {
      logger('翻译请求已中断')
      for (let rk in runtime.routeNodeDataCache) {
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

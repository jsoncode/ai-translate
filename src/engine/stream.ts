/**
 * 流式增量落盘与结果应用
 *
 * 由 ai-translate-engine.js 拆分而来（原 L3070-L3336），函数体保持原样，仅补类型与导入导出。
 */
import type { EngineItem, StreamResponse } from './types';
import { onTranslate } from './batch';
import { applyCachedTranslationsInRoot } from './bulk-apply';
import { getLanguage, getNodeDataMap, getRouteKey, resetRouteLoadingFlags } from './cache';
import { syncTranslateSkeleton } from './composite-write';
import { getCompositeRequestText } from './composite';
import { logger, showLoading } from './logger';
import { stripTranslationHtmlForApply } from './media';
import { isValidTranslationText, parseIndexedTranslationStream } from './parser';
import { resolveSelectorNode } from './selector';
import { runtime, state } from './state';
import { writeTranslateToNode } from './write';

/** 解析 SSE/流式 body：按行 "[index]译文\n" 切割后回调；流未结束前不写 DOM */
export function onStreamData(res: StreamResponse, callback: (lines: string[], isDone: boolean) => void): void {
  let body = res.body;
  let hasReader = body && typeof body.getReader === 'function';
  if (hasReader && typeof TextDecoder === 'function') {
    let reader = body!.getReader();
    let decoder = new TextDecoder('utf-8');
    let streamBuf = '';
    /**
     * 收尾只允许一次：后端会在流末尾发一个 [DONE] 帧，随后 reader 还会再报 done，
     * 两处都会走到 processBuffer(true)。重复收尾会重复写 DOM、重复 finishActiveFetch（多触发一次补扫）。
     */
    let doneEmitted = false;

    function emit( lines: string[], isDone: boolean) {
      if(lines.length) {
        // 加【接口返回】前缀：返回值与入参内容相同时（例如接口原样返回）也能和请求日志区分开
        logger('【接口返回】\n' + lines.join('\n'));
      }
      callback(lines, isDone)
    }

    function processBuffer( isFinal: boolean) {
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
export function setTextInDom( item: EngineItem) {
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
export function normalizeTranslationLines( lines: string[], singleIndex?: number | null) {
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

export function getItemRequestText( item: EngineItem) {
  if (!item) {
    return ''
  }
  return item.composite ? getCompositeRequestText(item) : (item.chinese || '')
}

/** 待译批次按请求文案去重：同文案只发一条，保留 index 映射供回显 */
export function dedupeFetchChineseList( chineseList: { index: string | number; chinese: string }[]) {
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
    const indices = textToIndices[text].sort(function (a: number, b: number) { return a - b })
    const rep = indices[0]
    deduped.push({ index: rep, chinese: text })
    aliases[rep] = indices
  }
  deduped.sort(function (a, b) { return a.index - b.index })
  return { deduped: deduped, aliases: aliases }
}

function getFetchAliasKeys( key: string | number) {
  if (!runtime.activeFetchIndexAliases) {
    return [key]
  }
  if (runtime.activeFetchIndexAliases[key]) {
    return runtime.activeFetchIndexAliases[key]
  }
  return [key]
}

function clearActiveFetchIndexAliases() {
  runtime.activeFetchIndexAliases = null
}

function applySourceTranslateToItem( item: EngineItem, mapKey: string, sourceTranslateRaw: string, writeDom: boolean) {
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
export function applyTranslationResult( translateList: string[], writeDom: boolean) {
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
export function flashAllText() {
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
export function finishActiveFetch( skipNext?: boolean) {
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
export function abortActiveTranslations(_reason?: string) {
  runtime.abortControllerList.forEach(function (i, index) {
    if (i) {
      i.abort()
      runtime.abortControllerList[index] = null
    }
  })
  runtime.abortControllerList = []
  runtime.activeFetchGeneration++
  clearActiveFetchIndexAliases()
  state.isLoading = false
  state.translateQueuePending = false
  showLoading(false)
  for (let rk in runtime.routeNodeDataCache) {
    resetRouteLoadingFlags(rk)
  }
}

/**
 * 回滚、路由切换与写保护
 *
 * 由 ai-translate-engine.js 拆分而来（原 L3486-L3659），函数体保持原样，仅补类型与导入导出。
 */
import type { DomNode, EngineItem } from './types';
import { applyRevertTranslationsInRoot } from './bulk-apply';
import { clearAllRouteNodeCache, getLanguage, getNodeDataMap, getRouteKey } from './cache';
import { isCompositeDomSynced } from './composite-write';
import { shouldReverseNode } from './guard';
import { scanPageContent } from './hooks';
import { isOpenTranslate } from './lang';
import { findInput, findText } from './scan';
import { resolveSelectorNode } from './selector';
import { SKIP_SCAN_TAGS, runtime, state } from './state';
import { getNodeText } from './viewport';
import { writeRevertToNode } from './write';

/**
 * 将指定路由桶内已写入 DOM 的译文恢复为中文（语言切回 zh 等场景；SPA 切页时不调用，避免闪中文）
 * @param {string} routeKey getRouteKey() 或 runtime.lastPathname
 */
export function revertTranslationsForRoute( routeKey: string) {
  if (!routeKey) {
    return
  }
  const map = runtime.routeNodeDataCache[routeKey]
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
export function reverseChinese() {
  for (let key in getNodeDataMap()) {
    const item = getNodeDataMap()[key]
    if (item.pathname !== getRouteKey()) {
      continue
    }

    item.selectors.forEach((i: DomNode) => {
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
  Array.from(document.querySelectorAll('[data-translate-hidden]')).forEach((i: DomNode) => {
    i.style.removeProperty('display')
  })
  // 其它路由桶里写过的译文也要回滚：筛选条件/查询串变化会改变 getRouteKey，
  // 框架复用 DOM 时旧路由写入的英文会留在新路由的页面上，只回滚当前桶就会"部分英文切不回中文"。
  // （selector 解析 + shouldReverseNode 都是"当前文案必须等于该条译文"的精确判定，不会误改其它文案）
  for (let rk in runtime.routeNodeDataCache) {
    if (rk === getRouteKey()) {
      continue
    }
    revertTranslationsForRoute(rk)
  }
  // 补充：按译文匹配 DOM，覆盖 selector 失效或虚拟列表回收后仍残留英文的节点
  applyRevertTranslationsInRoot(document.body, false)
}

export function resetMutationBatch() {
  runtime.mutationBatch.added = new Set()
  runtime.mutationBatch.removed = new Set()
  runtime.mutationBatch.hasChildList = false
}

/** 清空全部路由译文缓存（语言关闭等场景） */
export function clearTranslationCache() {
  clearAllRouteNodeCache()
  state.cacheData = {}
  state.translateQueuePending = false
  resetMutationBatch()
}

/** 路由切换后延迟扫描，等新页 DOM 替换后再采集/回显 */
export function scheduleRouteScanAfterChange() {
  if (runtime.routeScanTimer) {
    clearTimeout(runtime.routeScanTimer)
  }
  runtime.routeScanTimer = setTimeout(function () {
    runtime.routeScanTimer = null
    if (!isOpenTranslate() || getLanguage() === 'zh') {
      return
    }
    if (getRouteKey() !== runtime.lastPathname) {
      return
    }
    scanPageContent()
  }, 120)
}

export function isApplyingDom() {
  return runtime.applyingDomDepth > 0
}

export function runWithoutDomObserver( fn: () => void) {
  runtime.applyingDomDepth++
  try {
    fn()
  } finally {
    runtime.applyingDomDepth--
  }
}

/** 计算应写入节点的最终译文 */
export function getExpectedTranslate( item: EngineItem) {
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
export function isDomSynced( node: DomNode, item: EngineItem) {
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

export function shouldScanElement( el: DomNode) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return false
  }
  return !SKIP_SCAN_TAGS.includes(el.tagName.toLowerCase())
}

/**
 * 同一批次里若父、子同时新增，只扫最外层根，避免重复遍历子树
 */
export function normalizeAddedRoots( nodeSet: Set<Node>) {
  const list = Array.from(nodeSet)
  return list.filter(function (node) {
    return !list.some(function (other) {
      return other !== node && other.contains && other.contains(node)
    })
  })
}

/** 节点已从文档移除时，剔除 nodeDataMap 中失效的 selector，避免脏数据 */
export function pruneStaleSelectors() {
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
export function scanViewportContent() {
  if (!isOpenTranslate() || getLanguage() === 'zh') {
    return
  }
  findText(document.body, true)
  findInput(document.body, true)
}

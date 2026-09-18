/**
 * 节点扫描与条目收集
 *
 * 由 ai-translate-engine.js 拆分而来（原 L2536-L2887），函数体保持原样，仅补类型与导入导出。
 */
import type { DomNode } from './types';
import { applyDynamicTextUpdate, findItemBySelector, getNodeDataMap, getRouteKey, migrateNodeDataMapKey } from './cache';
import { getCompositeSelector, getInlineCompositeRoot, isInlineCompositeRoot } from './composite-dom';
import { isNumericOnlyChange, writeCompositeTranslate } from './composite-write';
import { assignCompositeRequestMeta } from './composite';
import { getShortestSelector, isSameSelectorSlot, patchSelectorSlot, reapplyCachedTranslationIfNeeded } from './guard';
import { hasChinese, hasTranslateSkipAncestor } from './lang';
import { shouldScanElement } from './lifecycle';
import { hasWeakRef, rememberNodeOriginal } from './original';
import { setTextInDom } from './stream';
import { isItemInViewport, isPendingTranslateItem, isTranslatableNodeInViewport } from './viewport';
import { createNodeDataMapEntry, writeTranslateToNode } from './write';

/**
 * 登记单个待翻译节点：写入 nodeDataMap，并在已有缓存译文时立即 setTextInDom
 * @param {Node} node 文本节点，或带 placeholder 的 input/textarea 元素
 */
export function setOneNode( node: DomNode) {
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
export function setOneCompositeNode( el: DomNode) {
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
export function findInlineCompositeBlocks( root: DomNode, viewportOnly: boolean) {
  if (!root) {
    return
  }
  const scanRoot = root.nodeType === Node.ELEMENT_NODE ? root : document.body
  if (!shouldScanElement(scanRoot) && scanRoot !== document.body) {
    return
  }
  const walker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node: DomNode) {
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
export function findText( root: DomNode, viewportOnly: boolean) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: DomNode) {
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
export function findInput( root: DomNode, viewportOnly: boolean) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node: DomNode) {
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
export function hasPendingTranslateWork() {
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

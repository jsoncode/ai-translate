/**
 * 按缓存整根应用译文/回滚
 *
 * 由 ai-translate-engine.js 拆分而来（原 L2001-L2174），函数体保持原样，仅补类型与导入导出。
 */
import type { DomNode } from './types';
import { getLanguage, getRouteKey } from './cache';
import { isInlineCompositeRoot } from './composite-dom';
import { resolveCompositeItemByElement, shouldReverseComposite, writeCompositeRevert } from './composite-write';
import { hasChinese, isOpenTranslate } from './lang';
import { shouldScanElement } from './lifecycle';
import { getRememberedOriginal, writeRememberedOriginal } from './original';
import { findInlineCompositeBlocks } from './scan';
import { getNodeText, isTranslatableNodeInViewport } from './viewport';
import { resolveItemByNodeText, resolveItemByTranslatedText, writeRevertToNode, writeTranslateToNode } from './write';

/**
 * 在子树内按「中文原文」匹配 nodeDataMap 并写回已有译文（弹框、晚渲染 DOM 回显）
 */
export function applyCachedTranslationsInRoot( root: DomNode) {
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
    acceptNode(node: DomNode) {
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
    acceptNode(node: DomNode) {
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
    const el: DomNode = inputWalker.currentNode
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
export function applyRevertTranslationsInRoot( root: DomNode, viewportOnly: boolean) {
  if (!root || getLanguage() !== 'zh') {
    return
  }
  const routeKey = getRouteKey()

  function tryRevertNode( node: DomNode) {
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
    acceptNode(node: DomNode) {
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
    acceptNode(node: DomNode) {
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
  while (compositeWalker.nextNode()) {
    const el = compositeWalker.currentNode
    const item = resolveCompositeItemByElement(el)
    if (item && item.pathname === routeKey && shouldReverseComposite(el, item)) {
      writeCompositeRevert(el, item)
    }
  }
}
